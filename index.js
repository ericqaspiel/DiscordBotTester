// Import required modules 
const { Client, GatewayIntentBits } = require('discord.js');
const axios = require('axios');
require('dotenv').config();

// Create a new Discord client with message intent 
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent]
});

// Bot is ready 
client.once('clientReady', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
});

// Listen and respond to messages 
client.on('messageCreate', async message => {

  // Ignore messages from bots 
  if (message.author.bot) return;

  // Respond to a specific message 
  if (message.content.toLowerCase() === 'hello') {
    message.reply('Hi there! 👋 I am your friendly bot.');
  }
  if (message.content.toLowerCase() === 'test') {
    message.reply('Hi there! 👋 I am your friendly bot.');
  }

  if (message.content.toLowerCase().includes('/weather')){
    let str = message.content.split(" ");
    let result = await coord(str[1]);
    console.log('res object'+result);
    let temperature = await getWeather(result);
    console.log('temp here' + temperature);
    message.reply("Today's temperature is "+ temperature + "°C");
  };
});


async function coord(input) {
  let url = "https://geocoding-api.open-meteo.com/v1/search?name="+input+"&count=10&language=en&format=json"
  console.log('url 1: ' + url);
  const res = await axios.get(url);
  console.log('res 1' + res.data.results[0].name);
  return res.data.results[0];
}

async function getWeather(coord) {
  let url = "https://api.open-meteo.com/v1/forecast?latitude="+coord.latitude+"&longitude="+coord.longitude+"&current=apparent_temperature&timezone=Asia%2FSingapore"
  console.log('url 2: ' + url);
  const res = await axios.get(url);
  console.log('res 2: ' + res.data.current.apparent_temperature);
  return res.data.current.apparent_temperature;
}


// Log in to Discord using token from .env 
client.login(process.env.DISCORD_TOKEN); 
