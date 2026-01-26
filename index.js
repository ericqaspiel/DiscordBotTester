// Import required modules 
const { Client, GatewayIntentBits } = require('discord.js');
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
client.on('messageCreate', message => {

  // Ignore messages from bots 
  if (message.author.bot) return;

  // Respond to a specific message 
  if (message.content.toLowerCase() === 'hello') {
    message.reply('Hi there! 👋 I am your friendly bot.');
  }
  if (message.content.toLowerCase() === 'test') {
    message.reply('Hi there! 👋 I am your friendly bot.');
  }

  if (message.content.toLowerCase.includes('/weather')){
    let str = message.split(" ");
    let result = coord(str[1])
    message.reply("Today's temperature is "+ getWeather(result))

};

const axios = require('axios');

async function coord(input) {
  const res = await axios.get("https://geocoding-api.open-meteo.com/v1/search?name="+input+"&count=10&language=en&format=json/");
  return res.data.results[0];
}

async function getWeather(coord) {
  const res = await axios.get("https://api.open-meteo.com/v1/forecast?latitude="+coord.latitude+"&longitude="+coord.longtitude+"&current=apparent_temperature&timezone=Asia%2FSingapore")

}




// Log in to Discord using token from .env 
client.login(process.env.DISCORD_TOKEN); 
