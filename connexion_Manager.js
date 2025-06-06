// fichier : connexion_Manager.js

const axios = require('axios');

const bots = [
  { name: 'ps3838', url: 'http://localhost:5001', active: true, lastBalance: null },
  { name: 'sbobet', url: 'http://localhost:5002', active: true, lastBalance: null }
];

function getRandomDelay(minMinutes, maxMinutes) {
  const minMs = minMinutes * 60 * 1000;
  const maxMs = maxMinutes * 60 * 1000;
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

async function askBalance(bot) {
  try {
    const res = await axios.get(`${bot.url}/solde`);
    return res.data.balance;
  } catch (err) {
    console.error(`❌ Erreur de récupération du solde pour ${bot.name}:`, err.message);
    return null;
  }
}

async function sendCommand(bot, action) {
  try {
    await axios.post(`${bot.url}/action`, { action });
    console.log(`📢 Commande "${action}" envoyée au bot ${bot.name}`);
  } catch (err) {
    console.error(`❌ Erreur d'envoi de la commande à ${bot.name}:`, err.message);
  }
}

async function checkBots() {
  for (const bot of bots) {
    if (!bot.active) continue;

    const currentBalance = await askBalance(bot);

    if (currentBalance === null) continue;

    if (bot.lastBalance !== null && currentBalance < bot.lastBalance) {
      console.log(`⚠️ Baisse du solde détectée pour ${bot.name} : ${currentBalance} < ${bot.lastBalance}`);

      bot.active = false;

      await sendCommand(bot, 'pause');
      await sendCommand(bot, 'disconnect');

      const waitTime = getRandomDelay(10, 20);
      console.log(`⏳ Bot ${bot.name} en pause pour ${Math.floor(waitTime / 60000)} minutes.`);

      setTimeout(async () => {
        console.log(`🔄 Tentative de reconnexion du bot ${bot.name}...`);
        await sendCommand(bot, 'reconnect');

        const newBalance = await askBalance(bot);

        if (newBalance !== null && newBalance >= bot.lastBalance) {
          console.log(`✅ Solde récupéré pour ${bot.name} (${newBalance} >= ${bot.lastBalance}), reprise.`);
          bot.active = true;
          await sendCommand(bot, 'resume');
          bot.lastBalance = newBalance;
        } else {
          console.log(`🔁 Solde toujours insuffisant pour ${bot.name}, nouvelle pause.`);
          setTimeout(() => checkBots(), getRandomDelay(10, 20));
        }
      }, waitTime);

    } else {
      bot.lastBalance = currentBalance;
      console.log(`✅ Solde OK pour ${bot.name} : ${currentBalance}`);
    }
  }
}

// Vérification toutes les 10 minutes
setInterval(checkBots, 10 * 60 * 1000);

console.log('🚀 connexion_Manager lancé. Surveillance des bots en cours...');
