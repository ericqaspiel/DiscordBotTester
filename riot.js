// League of Legends search: build the form, call Riot, and format the result.
require('dotenv').config();
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path'); // Combines item icons into one image.
const {
  EmbedBuilder, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');

if (!process.env.RIOT_API_KEY) {
  console.error('RIOT_API_KEY is missing in .env');
}

const riot = axios.create({ headers: { 'X-Riot-Token': process.env.RIOT_API_KEY } });

// ---------- Settings ----------
// Account data is the same on americas, asia and europe, so one host is enough
const ACCOUNT_HOST = 'https://asia.api.riotgames.com';
const RECENT_GAMES = 20;             // Most recent games across all queues
const YEARLY_MATCH_LIMIT = 200;       // Maximum yearly games to scan per search
const MATCH_PAGE_SIZE = 100;         // Riot returns up to 100 match IDs per page
const BATCH_SIZE = 5;                // matches loaded at the same time
const CACHE_MS = 10 * 60 * 1000;     // keep champion stats for 10 minutes
const REQUEST_SPACING_MS = 150;       // Minimum spacing between Riot API calls
const SESSION_MS = 30 * 60 * 1000;   // How long match navigation stays available

// One table for every server. Codes are from Riot's docs, labels are mine.
// "region" is the match-v5 host. PH2 and TH2 are my guess, not confirmed.
const SERVERS = [
  { code: 'sg2',  label: 'Singapore (SG2)',           region: 'sea' },
  { code: 'ph2',  label: 'Philippines (PH2)',         region: 'sea' },
  { code: 'th2',  label: 'Thailand (TH2)',            region: 'sea' },
  { code: 'tw2',  label: 'Taiwan (TW2)',              region: 'sea' },
  { code: 'vn2',  label: 'Vietnam (VN2)',             region: 'sea' },
  { code: 'kr',   label: 'Korea (KR)',                region: 'asia' },
  { code: 'jp1',  label: 'Japan (JP1)',               region: 'asia' },
  { code: 'oc1',  label: 'Oceania (OC1)',             region: 'sea' },
  { code: 'na1',  label: 'North America (NA1)',       region: 'americas' },
  { code: 'euw1', label: 'EU West (EUW1)',            region: 'europe' },
  { code: 'eun1', label: 'EU Nordic & East (EUN1)',   region: 'europe' },
  { code: 'br1',  label: 'Brazil (BR1)',              region: 'americas' },
  { code: 'la1',  label: 'Latin America North (LA1)', region: 'americas' },
  { code: 'la2',  label: 'Latin America South (LA2)', region: 'americas' },
  { code: 'tr1',  label: 'Turkey (TR1)',              region: 'europe' },
  { code: 'ru',   label: 'Russia (RU)',               region: 'europe' },
];

const PLATFORMS = SERVERS.map(s => s.code);
const REGION_OPTIONS = SERVERS.map(s => ({ label: s.label, value: s.code }));
function regionOf(code) {
  const server = SERVERS.find(server => server.code === code);
  return server?.region;
}

// ---------- Riot API calls ----------
// Return a promise that finishes after the given number of milliseconds.
function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// One shared queue prevents overlapping searches from ignoring rate limits.
// Riot's Retry-After applies to ALL queued requests, not just one failed batch.
let requestQueue = Promise.resolve();
let nextRequestTime = 0;

async function requestFromRiot(url, options) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const remaining = nextRequestTime - Date.now();
    if (remaining > 0) await sleep(remaining);
    nextRequestTime = Date.now() + REQUEST_SPACING_MS;
    try {
      return await riot.get(url, options);
    } catch (error) {
      if (error.response?.status !== 429 || attempt === 3) throw error;
      const seconds = Number(error.response.headers['retry-after']);
      if (!Number.isFinite(seconds) || seconds < 0) throw error;
      nextRequestTime = Math.max(nextRequestTime, Date.now() + seconds * 1000);
      console.warn(`Riot rate limit: waiting ${seconds} seconds before retrying.`);
    }
  }
}

function riotGet(url, options) {
  const request = requestQueue.then(() => requestFromRiot(url, options));
  // Keep the queue usable even when a request fails.
  requestQueue = request.catch(() => {});
  return request;
}

async function getAccount(gameName, tagLine) {
  try {
    const res = await riotGet(
      `${ACCOUNT_HOST}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;   // expected: no such player
    throw err;
  }
}

async function getRank(platform, puuid) {
  const res = await riotGet(
    `https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${puuid}`
  );
  return res.data.find(e => e.queueType === 'RANKED_SOLO_5x5') ?? null;
}

// Complete results are kept for 10 minutes to avoid repeating many API calls.
const statsCache = new Map();
let championNames = null;
let dataDragonVersion = null;
let itemNames = null;
const matchCache = new Map();
const matchSessions = new Map();

function matchBase(platform) {
  const region = regionOf(platform);
  return `https://${region}.api.riotgames.com/lol/match/v5/matches`;
}

// Match lists contain IDs only; we need a separate request for each match.
async function getMatchDetails(base, ids) {
  const matches = [];
  let failed = 0;
  for (const id of ids) {
    const key = `${base}/${id}`;
    try {
      let match = matchCache.get(key);
      if (!match) {
        match = (await riotGet(key)).data;
        matchCache.set(key, match);
      }
      matches.push(match);
    } catch (error) {
      failed += 1;
      console.error('match load failed:', error.response?.status ?? error.message);
    }
  }
  return { matches, failed };
}

function countChampions(matches, puuid) {
  const counts = {};
  let counted = 0;

  for (const match of matches) {
    const player = match.info.participants.find(person => person.puuid === puuid);
    if (!player || !player.championName) continue;

    counted += 1;
    if (!counts[player.championName]) {
      counts[player.championName] = { games: 0, wins: 0 };
    }
    const champion = counts[player.championName];
    champion.games += 1;
    if (player.win) champion.wins += 1;
  }

  const champions = Object.entries(counts).map(([name, record]) => ({
    name,
    games: record.games,
    wins: record.wins,
    winRate: Math.round(record.wins / record.games * 100)
  }));
  champions.sort((a, b) => b.games - a.games || a.name.localeCompare(b.name));
  return { counted, champions };
}

async function getRecentStats(platform, puuid) {
  const base = matchBase(platform);
  // No queue filter: ranked, normal, ARAM and other available modes are included.
  const response = await riotGet(`${base}/by-puuid/${puuid}/ids`, {
    params: { count: RECENT_GAMES }
  });
  const ids = response.data;
  const details = await getMatchDetails(base, ids);
  const stats = countChampions(details.matches, puuid);
  return { ...stats, matches: details.matches, requested: ids.length, failed: details.failed };
}

async function getYearlyStats(platform, puuid) {
  const year = new Date().getUTCFullYear();
  const cacheKey = `${platform}:${puuid}:${year}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CACHE_MS) return cached.data;

  const base = matchBase(platform);
  const startTime = Math.floor(Date.UTC(year, 0, 1) / 1000);
  const endTime = Math.floor(Date.UTC(year + 1, 0, 1) / 1000);
  const ids = [];
  let reachedEnd = false;

  // Ask for one extra ID at the limit so the output can honestly flag a partial scan.
  while (ids.length <= YEARLY_MATCH_LIMIT) {
    const count = Math.min(MATCH_PAGE_SIZE, YEARLY_MATCH_LIMIT + 1 - ids.length);
    const response = await riotGet(`${base}/by-puuid/${puuid}/ids`, {
      params: { startTime, endTime, start: ids.length, count }
    });
    ids.push(...response.data);
    if (response.data.length < count) {
      reachedEnd = true;
      break;
    }
  }

  const scannedIds = ids.slice(0, YEARLY_MATCH_LIMIT);
  const details = await getMatchDetails(base, scannedIds);
  const stats = countChampions(details.matches, puuid);
  const data = {
    ...stats,
    year,
    requested: scannedIds.length,
    partial: !reachedEnd || details.failed > 0 || stats.counted < scannedIds.length
  };
  if (!data.partial) statsCache.set(cacheKey, { time: Date.now(), data });
  return data;
}

// Data Dragon translates mastery champion IDs into readable champion names.
async function getChampionNames() {
  if (championNames) return championNames;
  const versions = await axios.get('https://ddragon.leagueoflegends.com/api/versions.json');
  const version = versions.data[0];
  dataDragonVersion = version;
  const response = await axios.get(
    `https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion.json`
  );
  championNames = {};
  for (const champion of Object.values(response.data.data)) {
    championNames[champion.key] = champion.name;
  }
  return championNames;
}

async function getTopMastery(platform, puuid) {
  const response = await riotGet(
    `https://${platform}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}/top`,
    { params: { count: 3 } }
  );
  let names = {};
  try {
    names = await getChampionNames();
  } catch (error) {
    console.error('champion names failed:', error.message);
  }
  return response.data.map(champion => ({
    name: names[champion.championId] ?? `Champion ID ${champion.championId}`,
    level: champion.championLevel,
    points: champion.championPoints
  }));
}

// ---------- Building the Discord message ----------
function parseRiotId(input) {
  const hash = input.lastIndexOf('#');
  // Reject a missing separator, empty name, or empty tag.
  if (hash < 1 || hash === input.length - 1) {
    return null;
  }

  return {
    gameName: input.slice(0, hash),
    tagLine: input.slice(hash + 1)
  };
}

async function addRank(embed, platform, puuid) {
  const solo = await getRank(platform, puuid);
  if (!solo) {
    embed.setDescription(`Unranked in Ranked Solo/Duo on ${platform.toUpperCase()}`);
    return null;
  }
  const wins = solo.wins ?? 0;
  const losses = solo.losses ?? 0;
  const lp = solo.leaguePoints ?? 0;
  const games = wins + losses;
  // Avoid dividing by zero if there are no ranked games.
  let winRate = 0;
  if (games > 0) {
    winRate = Math.round((wins / games) * 100);
  }

  embed.setDescription(`${solo.tier} ${solo.rank} · ${lp} LP`)
       .addFields({ name: 'Record', value: `${wins}W ${losses}L (${winRate}%)`, inline: true });
  return solo;
}

// A session stores the 20 downloaded matches so browsing needs no more Riot calls.
function createMatchSession(matches, puuid, playerName, platform) {
  for (const [id, session] of matchSessions) {
    if (session.expires < Date.now()) matchSessions.delete(id);
  }
  const id = require('crypto').randomBytes(8).toString('hex');
  matchSessions.set(id, { matches, puuid, playerName, platform, expires: Date.now() + SESSION_MS });
  return id;
}

function matchButtons(sessionId, index, count, view) {
  const button = (label, target, style, disabled = false) => new ButtonBuilder()
    .setCustomId(`match:${sessionId}:${target}:${view}`).setLabel(label).setStyle(style).setDisabled(disabled);
  const nav = new ActionRowBuilder().addComponents(
    button('Previous', index - 1, ButtonStyle.Secondary, index === 0),
    button('Next', index + 1, ButtonStyle.Primary, index >= count - 1)
  );
  return [nav];
}

async function getItemNames() {
  if (itemNames) return itemNames;
  if (!dataDragonVersion) await getChampionNames();
  const response = await axios.get(
    `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/data/en_US/item.json`
  );
  itemNames = {};
  for (const [id, item] of Object.entries(response.data.data)) itemNames[id] = item.name;
  return itemNames;
}

// Cache downloaded icons so switching between matches is faster.
const itemIconCache = new Map();

async function getItemIcon(itemId) {
  const key = `${dataDragonVersion}:${itemId}`;
  if (!itemIconCache.has(key)) {
    const url = `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/item/${itemId}.png`;
    const pending = axios.get(url, { responseType: 'arraybuffer', timeout: 10000 })
      .then(response => sharp(Buffer.from(response.data)).resize(32, 32).composite([{input: Buffer.from('<svg width="32" height="32"><rect width="32" height="32" rx="6" fill="white"/></svg>'), blend:'dest-in'}]).png().toBuffer());
    itemIconCache.set(key, pending);
    pending.catch(() => itemIconCache.delete(key));
  }
  return itemIconCache.get(key);
}

// Escape player names before placing them in an SVG image.
function escapeImageText(text) {
  return String(text).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]);
}

// Player index persists across restarts. Only real Riot IDs observed in matches are saved.
const playerFile = path.join(__dirname, 'known-players.json');
function loadPlayers() {
  try { const data = JSON.parse(fs.readFileSync(playerFile, 'utf8')); return Array.isArray(data) ? data : []; }
  catch (error) { if (error.code !== 'ENOENT') console.error('Could not read known players:', error.message); return []; }
}
function rememberPlayers(platform, players) {
  const all = new Map(loadPlayers().map(p => [`${p.platform}:${p.id.toLowerCase()}`, p]));
  for (const p of players) {
    if (!p.riotIdGameName || !p.riotIdTagline) continue;
    const id = `${p.riotIdGameName}#${p.riotIdTagline}`;
    all.set(`${platform}:${id.toLowerCase()}`, { platform, id });
  }
  try { fs.writeFileSync(playerFile, JSON.stringify([...all.values()], null, 2)); }
  catch (error) { console.error('Could not save known players:', error.message); }
}
function findPlayers(platform, query) {
  return loadPlayers().filter(p => p.platform === platform && p.id.toLowerCase().includes(query.toLowerCase())).slice(0, 25);
}

// Download champion portraits; reuse the same promise for repeated champions.
const championIconCache = new Map();
async function getChampionIcon(name) {
  if (!/^[A-Za-z0-9]+$/.test(name || '')) throw new Error('Unknown champion');
  const key = `${dataDragonVersion}:${name}`;
  if (!championIconCache.has(key)) {
    const pending = axios.get(`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/champion/${name}.png`,
      { responseType: 'arraybuffer', timeout: 10000 })
      .then(r => sharp(Buffer.from(r.data)).resize(40, 40).composite([{input:Buffer.from('<svg width="40" height="40"><circle cx="20" cy="20" r="20" fill="white"/></svg>'),blend:'dest-in'}]).png().toBuffer());
    championIconCache.set(key, pending);
    pending.catch(() => championIconCache.delete(key));
  }
  return championIconCache.get(key);
}

// Render a compact match scoreboard as one image; Discord cannot place icons inline.
async function createBuildImage(participants, view = 'overview', ranks = new Map()) {
  let runes = new Map(), spells = new Map();
  try { runes = await getRuneMetadata(); } catch (error) { console.error('Runes unavailable:', error.message); }
  try { spells = await getSummonerSpells(); } catch (error) { console.error('Spells unavailable:', error.message); }
  const groups = new Map();
  for (const p of participants) { const id=p.teamId ?? 0; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(p); }
  const width=1120, rowHeight=62, headerHeight=38;
  const height=55+groups.size*headerHeight+participants.length*rowHeight;
  const parts=[`<rect width="100%" height="100%" fill="#22242e"/><text x="18" y="30" fill="#eef0fa" font-size="18" font-weight="bold">MATCH OVERVIEW</text>`];
  const images=[]; let y=48;
  const maxDealt=Math.max(1,...participants.map(p=>p.totalDamageDealtToChampions||0));
  const maxTaken=Math.max(1,...participants.map(p=>p.totalDamageTaken||0));
  for (const [teamId,players] of groups) {
    const won=players[0].win, kills=players.reduce((n,p)=>n+(p.kills||0),0);
    const gold=players.reduce((n,p)=>n+(p.goldEarned||0),0);
    parts.push(`<rect y="${y}" width="${width}" height="${headerHeight}" fill="#303340"/>`,
      `<text x="16" y="${y+25}" fill="${won?'#72a4ff':'#ff697e'}" font-weight="bold" font-size="15">${won?'VICTORY':'DEFEAT'} · ${teamId===100?'BLUE':teamId===200?'RED':`TEAM ${teamId}`}</text>`,
      `<text x="360" y="${y+25}" fill="#b9bfce" font-size="13">KDA</text><text x="470" y="${y+25}" fill="#b9bfce" font-size="13">DAMAGE / TAKEN</text><text x="630" y="${y+25}" fill="#b9bfce" font-size="13">WARDS</text><text x="705" y="${y+25}" fill="#b9bfce" font-size="13">CS</text><text x="790" y="${y+25}" fill="#b9bfce" font-size="13">ITEMS</text>`,
      `<text x="1090" y="${y+25}" text-anchor="end" fill="#b9bfce" font-size="11">${kills} kills · ${Math.round(gold/1000)}k gold</text>`);
    y+=headerHeight;
    for (const p of players) {
      const rowY=y, name=escapeImageText(String(p.riotIdGameName||p.summonerName||'Player').slice(0,23));
      const rank=ranks.get(p.puuid)||'Rank unavailable', tier=rank.split(' ')[0].toLowerCase();
      const cs=(p.totalMinionsKilled||0)+(p.neutralMinionsKilled||0), dealt=p.totalDamageDealtToChampions||0,taken=p.totalDamageTaken||0;
      const kda=(p.deaths||0)===0 ? 'Perfect' : ((p.kills||0)+(p.assists||0))/(p.deaths||1);
      const kdaText=typeof kda==='number'?`${kda.toFixed(2)}:1`:kda;
      const kp=kills?Math.round(((p.kills||0)+(p.assists||0))/kills*100):0;
      parts.push(`<rect y="${y}" width="${width}" height="${rowHeight}" fill="${won?'#293c59':'#51343c'}"/>`,
        `<text x="105" y="${y+22}" fill="#fff" font-size="14" font-weight="bold">${name}</text>`,
        `<text x="127" y="${y+43}" fill="#b6becf" font-size="12">${escapeImageText(rank)}</text>`,
        `<rect x="32" y="${y+39}" width="22" height="19" rx="7" fill="#202733"/><text x="43" y="${y+53}" text-anchor="middle" fill="#fff" font-size="12">${p.champLevel??'?'}</text>`,
        `<text x="360" y="${y+23}" fill="#dbe2f1" font-size="13">${p.kills??0}/${p.deaths??0}/${p.assists??0} (${kp}%)</text><text x="360" y="${y+43}" fill="#b8c8ed" font-size="12">${kdaText}</text>`,
        `<text x="470" y="${y+23}" fill="#e5e7ef" font-size="12">${dealt.toLocaleString('en-US')}</text><text x="536" y="${y+23}" fill="#e5e7ef" font-size="12">${taken.toLocaleString('en-US')}</text>`,
        `<rect x="470" y="${y+31}" width="56" height="6" fill="#242832"/><rect x="470" y="${y+31}" width="${Math.round(56*dealt/maxDealt)}" height="6" fill="#ed536c"/><rect x="536" y="${y+31}" width="56" height="6" fill="#242832"/><rect x="536" y="${y+31}" width="${Math.round(56*taken/maxTaken)}" height="6" fill="#95a0b4"/>`,
        `<text x="630" y="${y+23}" fill="#e5e7ef" font-size="12">${p.wardsPlaced??0} placed</text><text x="630" y="${y+43}" fill="#b8c8ed" font-size="12">${p.wardsKilled??0} cleared</text>`,
        `<text x="705" y="${y+23}" fill="#e5e7ef" font-size="12">${cs}</text>`);
      images.push(getChampionIcon(p.championName).then(input=>({input,left:15,top:rowY+7})).catch(()=>null));
      const rankTiers=['iron','bronze','silver','gold','platinum','emerald','diamond','master','grandmaster','challenger'];
      if (rankTiers.includes(tier)) images.push(getSmallIcon(`crest:${tier}`,`https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier}.png`).then(input=>({input,left:105,top:rowY+30})).catch(()=>null));
      for (const [n,id] of [p.summoner1Id,p.summoner2Id].entries()) { const file=spells.get(String(id)); if(file) images.push(getSmallIcon(`spell:${file}`,`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/spell/${file}`).then(input=>({input,left:58,top:rowY+8+n*19})).catch(()=>null)); }
      const styles=p.perks?.styles||[];
      for (const [n,id] of [styles[0]?.selections?.[0]?.perk,styles[1]?.style].entries()) { const icon=runes.get(id)?.icon; if(icon) images.push(getSmallIcon(`rune:${icon}`,`https://ddragon.leagueoflegends.com/cdn/img/${icon}`).then(input=>({input,left:79,top:rowY+8+n*19})).catch(()=>null)); }
      for(let slot=0;slot<=6;slot++){ const id=p[`item${slot}`], x=790+slot*37; parts.push(`<rect x="${x}" y="${y+12}" width="32" height="32" rx="6" fill="#77505a"/>`); if(Number.isInteger(id)&&id>0) images.push(getItemIcon(id).then(input=>({input,left:x,top:rowY+12})).catch(()=>null)); }
      y+=rowHeight;
    }
  }
  const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g font-family="Arial,sans-serif">${parts.join('')}</g></svg>`);
  // Place level badges above the circular portraits.
  let badgeY=48; const badges=[];
  for (const players of groups.values()) { badgeY+=headerHeight; for (const p of players) { badges.push(`<rect x="32" y="${badgeY+39}" width="22" height="19" rx="7" fill="#202733"/><text x="43" y="${badgeY+53}" text-anchor="middle" fill="#fff" font-family="Arial" font-size="12">${p.champLevel??'?'}</text>`); badgeY+=rowHeight; } }
  const badge=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${badges.join('')}</svg>`);
  return sharp(svg).composite([...(await Promise.all(images)).filter(Boolean),{input:badge,left:0,top:0}]).png().toBuffer();
}

// Spell and rune thumbnails are cached; ranks are current Solo/Duo ranks.
let spellMetadata;
const smallIconCache = new Map();
async function getSummonerSpells() {
  if (!spellMetadata) {
    const response = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/data/en_US/summoner.json`, {timeout:10000});
    spellMetadata = new Map(Object.values(response.data.data).map(spell => [spell.key, spell.image.full]));
  }
  return spellMetadata;
}
async function getSmallIcon(key, url) {
  if (!smallIconCache.has(key)) {
    const pending = axios.get(url, { responseType:'arraybuffer', timeout:10000 }).then(r => sharp(Buffer.from(r.data)).resize(17,17).png().toBuffer());
    smallIconCache.set(key,pending); pending.catch(() => smallIconCache.delete(key));
  }
  return smallIconCache.get(key);
}
const rankCache = new Map();
async function getParticipantRanks(platform, participants) {
  const results = await Promise.all(participants.map(async p => {
    if (!p.puuid) return [p.puuid, 'Rank unavailable'];
    const key = `${platform}:${p.puuid}`;
    const cached = rankCache.get(key);
    if (cached && Date.now() - cached.time < CACHE_MS) return [p.puuid, cached.value];
    try {
      const rank = await getRank(platform,p.puuid);
      const value = rank ? `${rank.tier} ${rank.rank}` : 'Unranked';
      rankCache.set(key,{value,time:Date.now()});
      return [p.puuid,value];
    } catch (error) { return [p.puuid,'Rank unavailable']; }
  }));
  return new Map(results);
}

// A timeline is fetched only for the match currently shown, and cached in memory.
const timelineCache = new Map();
async function getTimeline(platform, matchId) {
  if (!matchId || !regionOf(platform)) return null;
  const key = `${platform}:${matchId}`;
  if (!timelineCache.has(key)) {
    const pending = riotGet(`${matchBase(platform)}/${encodeURIComponent(matchId)}/timeline`)
      .then(response => response.data);
    timelineCache.set(key, pending);
    pending.catch(() => timelineCache.delete(key));
  }
  return timelineCache.get(key);
}

let runeMetadata;
async function getRuneMetadata() {
  if (!runeMetadata) {
    const response = await axios.get(`https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/data/en_US/runesReforged.json`, { timeout: 10000 });
    const all = new Map();
    for (const style of response.data) {
      all.set(style.id, { name: style.name, icon: style.icon, slots: style.slots });
      for (const slot of style.slots || []) for (const rune of slot.runes || []) all.set(rune.id, { name: rune.name, icon: rune.icon });
    }
    runeMetadata = all;
  }
  return runeMetadata;
}
const runeIconCache = new Map();
async function getRuneIcon(icon) {
  if (!/^[A-Za-z0-9_/. -]+\.png$/.test(icon) || icon.includes('..')) throw new Error('Invalid rune icon');
  if (!runeIconCache.has(icon)) {
    const pending = axios.get(`https://ddragon.leagueoflegends.com/cdn/img/${icon}`, { responseType: 'arraybuffer', timeout: 10000 })
      .then(r => sharp(Buffer.from(r.data)).resize(40, 40).png().toBuffer());
    runeIconCache.set(icon, pending);
    pending.catch(() => runeIconCache.delete(icon));
  }
  return runeIconCache.get(icon);
}

// Add the selected player's purchase timeline, skill order and selected runes.
async function addBuildAndRunes(scoreboard, player, timeline) {
  const participantId = player.participantId;
  const events = (timeline?.info?.frames || []).flatMap(frame => frame.events || [])
    .filter(event => event.participantId === participantId);
  const purchases = events.filter(event => event.type === 'ITEM_PURCHASED' && event.itemId > 0);
  const shown = purchases.slice(0, 36);
  const skills = events.filter(event => event.type === 'SKILL_LEVEL_UP' && event.levelUpType === 'NORMAL')
    .map(event => ['?', 'Q', 'W', 'E', 'R'][event.skillSlot] || '?').slice(0, 18);
  const styles = player.perks?.styles || [];
  let runes = new Map();
  try { runes = await getRuneMetadata(); } catch (error) { console.error('Rune metadata unavailable:', error.message); }
  const selected = styles.flatMap(style => [style.style, ...(style.selections || []).map(s => s.perk)]);
  const baseHeight = (await sharp(scoreboard).metadata()).height;
  const buyRows = Math.max(1, Math.ceil(shown.length / 18));
  const extraHeight = 365 + buyRows * 62;
  const width = 1120;
  let fragments = [`<rect width="100%" height="100%" fill="#272a35"/>`,
    `<text x="18" y="25" fill="#d7dce9" font-size="16" font-weight="bold">Item builds</text>`];
  const overlays = [];
  if (!shown.length) fragments.push(`<text x="18" y="55" fill="#aab3c5" font-size="13">${timeline ? 'No item purchases recorded.' : 'Match timeline unavailable.'}</text>`);
  shown.forEach((event, i) => {
    const x = 18 + (i % 18) * 60, y = 38 + Math.floor(i / 18) * 62;
    if (i % 18 !== 17 && i < shown.length-1) fragments.push(`<text x="${x+40}" y="${y+22}" fill="#8992a4" font-size="18">›</text>`);
    fragments.push(`<text x="${x}" y="${y+49}" fill="#aab3c5" font-size="11">${Math.floor((event.timestamp || 0)/60000)} min</text>`);
    overlays.push(getItemIcon(event.itemId).then(input => ({ input, left:x, top:baseHeight+y })).catch(() => null));
  });
  if (purchases.length > shown.length) fragments.push(`<text x="900" y="25" fill="#aab3c5" font-size="12">First ${shown.length} of ${purchases.length} purchases</text>`);
  const skillY = 45 + buyRows * 62;
  fragments.push(`<text x="18" y="${skillY}" fill="#d7dce9" font-size="15" font-weight="bold">Skill Order</text>`,
    ...skills.map((skill, i) => `<rect x="${18+i*45}" y="${skillY+8}" width="25" height="25" rx="4" fill="${skill === 'R' ? '#5389eb' : '#142d3f'}"/><text x="${26+i*45}" y="${skillY+26}" fill="#9dd6ff" font-size="14">${skill}</text>${i < skills.length-1 ? `<text x="${47+i*45}" y="${skillY+26}" fill="#8992a4">›</text>` : ''}`));
  const runeY = skillY + 55;
  fragments.push(`<text x="18" y="${runeY}" fill="#d7dce9" font-size="15" font-weight="bold">Runes</text>`);
  if (!selected.length) fragments.push(`<text x="18" y="${runeY+28}" fill="#aab3c5" font-size="13">Rune data unavailable for this match.</text>`);
  // Each tree includes all choices; selected runes stay coloured.
  styles.slice(0, 2).forEach((style, group) => {
    const tree = runes.get(style.style);
    const left = 90 + group * 320;
    const chosen = new Set((style.selections || []).map(selection => selection.perk));
    const startY = runeY + 20;
    if (tree?.icon) overlays.push(getRuneIcon(tree.icon).then(input => ({input,left:left+65,top:baseHeight+startY})).catch(() => null));
    (tree?.slots || []).slice(0,4).forEach((slot, row) => {
      (slot.runes || []).slice(0,4).forEach((rune, col) => {
        const x = left + col * 52, top = startY + 45 + row * 43;
        if (!rune.icon) return;
        overlays.push(getRuneIcon(rune.icon).then(async buffer => ({
          input: chosen.has(rune.id) ? buffer : await sharp(buffer).grayscale().modulate({brightness:0.45}).png().toBuffer(),
          left:x, top:baseHeight+top
        })).catch(() => null));
      });
    });
    fragments.push(`<text x="${left+40}" y="${startY+228}" fill="#b8c0ce" font-size="12">${escapeImageText(tree?.name || `Tree ${style.style}`)}</text>`);
  });
  const shards = player.perks?.statPerks;
  const shardInfo = {5008:['Adaptive force','statmodsadaptiveforceicon.png'],5005:['Attack speed','statmodsattackspeedicon.png'],5007:['Ability haste','statmodscdrscalingicon.png'],5001:['Scaling health','statmodshealthscalingicon.png'],5002:['Armor','statmodsarmoricon.png'],5003:['Magic resist','statmodsmagicresicon.png'],5010:['Move speed','statmodsmovementspeedicon.png'],5011:['Health','statmodshealthplusicon.png'],5013:['Tenacity','statmodstenacityicon.png']};
  if (shards) {
    fragments.push(`<text x="750" y="${runeY+46}" fill="#b8c0ce" font-size="13">Stat shards</text>`);
    [shards.offense,shards.flex,shards.defense].forEach((id,i)=>{
      const [label,file]=shardInfo[id] || [`Shard ${id ?? 'unavailable'}`,null];
      const top=runeY+60+i*48;
      fragments.push(`<circle cx="768" cy="${top+18}" r="18" fill="#202430" stroke="#c3a857"/><text x="795" y="${top+24}" fill="#b8c0ce" font-size="12">${escapeImageText(label)}</text>`);
      if(file) overlays.push(getSmallIcon(`shard:${file}`,`https://raw.communitydragon.org/latest/game/assets/perks/statmods/${file}`).then(input=>({input,left:760,top:baseHeight+top+9})).catch(()=>null));
    });
  } else fragments.push(`<text x="750" y="${runeY+46}" fill="#b8c0ce" font-size="12">Stat shards unavailable</text>`);
  const panel = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${extraHeight}"><g font-family="Arial,sans-serif">${fragments.join('')}</g></svg>`);
  const layer = await sharp(panel).png().toBuffer();
  return sharp(scoreboard).extend({ top:0, left:0, right:0, bottom:extraHeight, background:'#272a35' })
    .composite([{input:layer,left:0,top:baseHeight}, ...(await Promise.all(overlays)).filter(Boolean)]).png().toBuffer();
}

async function createRankImage(rank) {
  const title = rank ? `${rank.tier} ${rank.rank}` : 'UNRANKED';
  const record = rank ? `${rank.leaguePoints ?? 0} LP · ${rank.wins ?? 0}W ${rank.losses ?? 0}L` : 'No current Solo/Duo rank';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="620" height="145"><rect width="100%" height="100%" rx="12" fill="#292c38"/><text x="25" y="35" fill="#b6c3e0" font-family="Arial" font-size="15">RANKED SOLO / DUO</text><text x="25" y="82" fill="#ffffff" font-family="Arial" font-weight="bold" font-size="30">${escapeImageText(title)}</text><text x="25" y="115" fill="#a8b7da" font-family="Arial" font-size="17">${escapeImageText(record)}</text></svg>`)).png().toBuffer();
}

// A Discord embed displays the champion portrait and a readable ten-player overview.
// Item names are the final inventory; they are not the purchase order.
async function buildMatchPage(sessionId, index, view = 'overview') {
  if (!['overview', 'build', 'analysis'].includes(view)) return null;
  const session = matchSessions.get(sessionId);
  if (!session || session.expires < Date.now()) return null;
  if (!Number.isInteger(index) || index < 0 || index >= session.matches.length) return null;
  const match = session.matches[index];
  const info = match.info;
  const selected = info.participants.find(player => player.puuid === session.puuid);
  if (!selected) return null;
  let items = {};
  try { items = await getItemNames(); } catch (error) {
    console.error('Data Dragon failed:', error.message);
  }
  const seconds = info.gameDuration ?? 0;
  const minutes = Math.floor(seconds / 60);
  const date = info.gameStartTimestamp || info.gameCreation;
  const when = date ? `<t:${Math.floor(date / 1000)}:R>` : 'Unknown date';
  const embed = new EmbedBuilder()
    .setTitle(`${session.playerName} · Match ${index + 1}/${session.matches.length}`)
    .setColor(selected.win ? 0x2ecc71 : 0xe74c3c)
    .setDescription(`${selected.win ? 'Victory' : 'Defeat'} · ${info.gameMode || 'Unknown mode'} · ${minutes} min · ${when}\n` +
      `**${selected.championName}** · ${selected.kills}/${selected.deaths}/${selected.assists} · ` +
      `${(selected.totalMinionsKilled ?? 0) + (selected.neutralMinionsKilled ?? 0)} CS`);
  embed.setFooter({ text: 'Ranks are current Solo/Duo ranks, not historical · buttons expire after 30 minutes' });
  let files = [];
  const embeds = [embed];
  if (dataDragonVersion) {
    try {
      const ranks = await getParticipantRanks(session.platform, info.participants);
      const scoreboard = await createBuildImage(info.participants, view, ranks);
      let timeline = null;
      try { timeline = await getTimeline(session.platform, match.metadata?.matchId); }
      catch (error) { console.error('Timeline unavailable:', error.response?.status ?? error.message); }
      const image = await addBuildAndRunes(scoreboard, selected, timeline);
      const base = await sharp(scoreboard).metadata();
      const combined = await sharp(image).metadata();
      const detail = await sharp(image).extract({left:0, top:base.height, width:base.width, height:combined.height-base.height}).png().toBuffer();
      files = [new AttachmentBuilder(scoreboard, {name:'match-scoreboard.png'}), new AttachmentBuilder(detail, {name:'match-builds.png'})];
      embed.setImage('attachment://match-scoreboard.png');
      embeds.push(new EmbedBuilder().setColor(selected.win ? 0x2ecc71 : 0xe74c3c).setImage('attachment://match-builds.png'));
    } catch (error) {
      console.error('Build image failed:', error.message);
    }
  }
  // Remove the previous image when changing pages, then attach the new one.
  return { embeds, components: matchButtons(sessionId, index, session.matches.length, view), attachments: [], files };

}

async function handleMatchButton(interaction) {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'match' || parts.length !== 4) return false;
  await interaction.deferUpdate();
  const page = await buildMatchPage(parts[1], Number(parts[2]), parts[3]);
  if (!page) {
    await interaction.followUp({ content: 'This match view has expired. Search for the player again.', flags: 64 });
  } else {
    await interaction.editReply(page);
  }
  return true;
}

async function addYearlyChampions(embed, platform, puuid) {
  try {
    const stats = await getYearlyStats(platform, puuid);
    const lines = stats.champions.slice(0, 3).map(champion =>
      `**${champion.name}**: ${champion.games} games, ${champion.winRate}% WR`
    );
    let value = lines.length ? lines.join('\n') : 'No games found.';
    value += `\nAnalysed ${stats.counted} games since January 1 (UTC).`;
    if (stats.partial) value += `\nPartial results: scan limit or unavailable matches.`;
    embed.addFields({ name: `Top 3 champions in ${stats.year}`, value });
  } catch (error) {
    console.error('yearly champions failed:', error.response?.status ?? error.message);
    embed.addFields({ name: 'Yearly champions', value: "Couldn't load yearly statistics." });
  }
}

async function addMastery(embed, platform, puuid) {
  try {
    const champions = await getTopMastery(platform, puuid);
    const lines = champions.map(champion =>
      `**${champion.name}**: Level ${champion.level} · ${champion.points.toLocaleString('en-US')} points`
    );
    embed.addFields({ name: 'Top 3 champion mastery', value: lines.join('\n') || 'No mastery found.' });
  } catch (error) {
    console.error('mastery failed:', error.response?.status ?? error.message);
    embed.addFields({ name: 'Top 3 champion mastery', value: "Couldn't load mastery." });
  }
}

// The function index.js calls to get the result message
async function rankReply(platform, input) {
  if (!PLATFORMS.includes(platform)) {
    return { summary: { content: 'Unknown server.' } };
  }

  const id = parseRiotId(input);
  if (!id) {
    return { summary: { content: 'Please use the format `Name#TAG`, e.g. `Faker#KR1`' } };
  }

  const account = await getAccount(id.gameName, id.tagLine);
  if (!account) {
    return { summary: { content: `Couldn't find "${input}".` } };
  }

  const embed = new EmbedBuilder()
    .setTitle(`${account.gameName}#${account.tagLine}`)
    .setColor(0x0099FF)
    .setFooter({ text: `Server: ${platform.toUpperCase()}` });

  try {
    if (!dataDragonVersion) await getChampionNames();
    const summoner = await riotGet(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(account.puuid)}`);
    if (Number.isInteger(summoner.data.profileIconId)) {
      embed.setTitle(null).setAuthor({ name: `${account.gameName}#${account.tagLine}`, iconURL: `https://ddragon.leagueoflegends.com/cdn/${dataDragonVersion}/img/profileicon/${summoner.data.profileIconId}.png` });
    }
  } catch (error) { console.error('Summoner icon unavailable:', error.response?.status ?? error.message); }
  const rank = await addRank(embed, platform, account.puuid);
  rememberPlayers(platform, [{ riotIdGameName: account.gameName, riotIdTagline: account.tagLine }]);
  await addMastery(embed, platform, account.puuid);
  let matches = [];
  try {
    const recent = await getRecentStats(platform, account.puuid);
    matches = recent.matches.filter(match =>
      match.info.participants.some(player => player.puuid === account.puuid)
    );
    rememberPlayers(platform, matches.flatMap(match => match.info.participants));
  } catch (error) {
    console.error('recent games failed:', error.response?.status ?? error.message);
    embed.addFields({ name: 'Matches', value: "Couldn't load recent matches." });
  }
  const playerName = `${account.gameName}#${account.tagLine}`;
  const sessionId = matches.length ? createMatchSession(matches, account.puuid, playerName, platform) : null;
  const matchPage = sessionId ? await buildMatchPage(sessionId, 0) : null;
  let summary = { embeds: [embed] };
  try {
    const card = await createRankImage(rank);
    embed.setImage('attachment://rank-card.png');
    summary.files = [new AttachmentBuilder(card, { name: 'rank-card.png' })];
  } catch (error) { console.error('Rank card failed:', error.message); }
  return { summary, matchPage, platform, puuid: account.puuid, playerName };
}

// Runs separately so a lengthy yearly scan does not delay the recent-match view.
async function yearlyReply(platform, puuid, playerName) {
  const embed = new EmbedBuilder().setTitle(`${playerName} · Yearly champions`).setColor(0x0099FF);
  await addYearlyChampions(embed, platform, puuid);
  return { embeds: [embed] };
}

// ---------- Pop-up form ----------
// The pop-up: server dropdown + Riot ID box
function leagueModal() {
  const regionSelect = new StringSelectMenuBuilder()
    .setCustomId('region')
    .setPlaceholder('Pick a server')
    .addOptions(REGION_OPTIONS);

  const idInput = new TextInputBuilder()
    .setCustomId('riotId')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Faker#KR1');

  return new ModalBuilder()
    .setCustomId('league-modal')
    .setTitle('Search League player')
    .addLabelComponents(
      new LabelBuilder().setLabel('Server').setStringSelectMenuComponent(regionSelect),
      new LabelBuilder().setLabel('Riot ID').setDescription('Full Name#TAG, or part of a saved player name').setTextInputComponent(idInput)
    );
}

// Reads the submitted form, so the field names stay in this file
function readLeagueForm(interaction) {
  return {
    region: interaction.fields.getStringSelectValues('region')[0],
    riotId: interaction.fields.getTextInputValue('riotId').trim()
  };
}

module.exports = { rankReply, leagueModal, readLeagueForm, handleMatchButton, yearlyReply, findPlayers };