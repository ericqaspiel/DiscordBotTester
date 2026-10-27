// Discord bot entry point: connect to Discord and handle user interactions.
// The Riot API and form-building functions are in riot.js.
// ---------- Imports ----------
require('dotenv').config();
const {
  Client, GatewayIntentBits, Events, MessageFlags,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
} = require('discord.js');
const { rankReply, leagueModal, readLeagueForm, handleMatchButton, yearlyReply, findPlayers } = require('./riot');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ---------- Menu settings ----------
const MENU_CHANNEL_ID = '1465241239661183018';   // channel where the menu stays
const MENU_TEXT = '🎮 Main menu 🎮';
const MENU_DELAY_MS = 400;   // wait after a person's message


let menuMessage = null;      // the menu that is on screen now
let refreshTimer = null;
let refreshing = false;      // true while a refresh is running
let refreshAgain = false;    // true if another refresh was asked for in the meantime

// ---------- Menu (buttons) ----------
function buildMenu() {
  const leagueBtn = new ButtonBuilder()
    .setCustomId('open-league')
    .setLabel('🎮 Search League player')
    .setStyle(ButtonStyle.Primary);
  return {
    content: MENU_TEXT,
    components: [new ActionRowBuilder().addComponents(leagueBtn)]
  };
}

// Delete menus left over from earlier runs of the bot
async function clearOldMenus(channel) {
  const recent = await channel.messages.fetch({ limit: 50 });
  const oldMenus = recent.filter(message => {
    return message.author.id === client.user.id && message.content === MENU_TEXT;
  });

  for (const oldMenu of oldMenus.values()) {
    // A deleted or inaccessible message should not stop the remaining cleanup.
    await oldMenu.delete().catch(() => {});
  }
}

// Send the new menu first, then delete the old one without waiting for it
async function refreshMenu(channel) {
  // If a refresh is already running, request one more pass after it finishes.
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const oldMenu = menuMessage;
      menuMessage = await channel.send(buildMenu());

      if (oldMenu) {
        // Start deleting the previous menu without delaying the new one.
        oldMenu.delete().catch(() => {});
      }
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

// Wait a short moment of quiet, then move the menu down
function scheduleMenuRefresh(channel, delay) {
  // Reset the timer whenever another message arrives.
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshMenu(channel).catch(err => console.error('menu refresh failed:', err));
  }, delay);
}

// ---------- Events ----------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}!`);
  try {
    const channel = await client.channels.fetch(MENU_CHANNEL_ID);
    await clearOldMenus(channel);
    await refreshMenu(channel);
  } catch (err) {
    console.error('menu setup failed:', err);
  }
});

client.on('messageCreate', message => {
  // Keep the menu at the bottom of its channel.
  // Skip the menu itself, or posting it would trigger another refresh forever.
  const isBotMessage = message.author.id === client.user.id;
  const isTheMenu = isBotMessage && message.content === MENU_TEXT;
  if (message.channelId === MENU_CHANNEL_ID && !isTheMenu) {
    scheduleMenuRefresh(message.channel, MENU_DELAY_MS);
  }
});

// Search results and match pages are posted to the channel.
async function runSearch(channel, region, riotId) {
  await channel.send('Searching Riot match history. Rate limits may cause a wait.');
  const result = await rankReply(region, riotId);
  await channel.send(result.summary);
  if (result.matchPage) await channel.send(result.matchPage);
  if (result.puuid) yearlyReply(result.platform, result.puuid, result.playerName)
    .then(message => channel.send(message))
    .catch(error => console.error('yearly scan failed:', error));
}

client.on(Events.InteractionCreate, async interaction => {
  try {
    // Browse the already-downloaded match history.
    if (interaction.isButton() && interaction.customId.startsWith('match:')) {
      await handleMatchButton(interaction);
      return;
    }

    // Button click -> open the pop-up
    if (interaction.isButton() && interaction.customId === 'open-league') {
      return await interaction.showModal(leagueModal());
    }

    // A partial name searches only players this bot has already seen.
    if (interaction.isModalSubmit() && interaction.customId === 'league-modal') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const { region, riotId } = readLeagueForm(interaction);
      if (!riotId.includes('#')) {
        if (!riotId.trim()) return await interaction.editReply('Enter a player name or full Riot ID.');
        const found = findPlayers(region, riotId.trim());
        if (!found.length) return await interaction.editReply('No saved players match that name. Search using the full Name#TAG first.');
        const menu = new StringSelectMenuBuilder().setCustomId(`saved-player:${region}`)
          .setPlaceholder('Choose a saved player')
          .addOptions(found.map((p, i) => ({ label: p.id.slice(0, 100), value: String(i) })));
        // IDs are retained in the ephemeral menu labels, avoiding an extra shared session.
        return await interaction.editReply({ content: 'Choose a previously seen player:', components: [new ActionRowBuilder().addComponents(menu)] });
      }
      await interaction.editReply('Searching. Results will appear in the channel.');
      await runSearch(interaction.channel, region, riotId);
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('saved-player:')) {
      const region = interaction.customId.split(':')[1];
      const selected = interaction.component.options.find(o => o.value === interaction.values[0]);
      if (!selected) return await interaction.reply({ content: 'Selection expired; search again.', flags: MessageFlags.Ephemeral });
      await interaction.update({ content: `Searching ${selected.label}. Results will appear in the channel.`, components: [] });
      await runSearch(interaction.channel, region, selected.label);
      return;
    }
  } catch (err) {
    console.error('interaction failed:', err);
  }
});

// ---------- Start ----------
client.login(process.env.DISCORD_TOKEN);