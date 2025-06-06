require('dotenv').config();
const express = require('express');
const { spawn } = require('child_process');
const axios = require('axios');
const treeKill = require('tree-kill');

const app = express();
const PORT = 1313;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let processusArbitrage = null;
let processusPS = null;
let processusSBO = null;

function envoyerNotificationTelegram(message) {
  return axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    chat_id: TELEGRAM_CHAT_ID,
    text: message,
    parse_mode: 'Markdown'
  }).catch(err => {
    console.warn('⚠️ Erreur envoi Telegram :', err.message);
  });
}

function estActif(proc) {
  return proc && !proc.killed && proc.exitCode === null;
}

function arreterTousLesBots() {
  console.log('🛑 Fermeture de tous les bots (tree-kill)...');

  const tuer = (proc, nom) => {
    if (proc && proc.pid) {
      treeKill(proc.pid, 'SIGKILL', (err) => {
        if (err) {
          console.warn(`⚠️ ${nom} non tué :`, err.message);
        } else {
          console.log(`✅ ${nom} tué (pid: ${proc.pid})`);
        }
      });
    } else {
      console.warn(`⚠️ ${nom} n'était pas actif`);
    }
  };

  tuer(processusArbitrage, 'arbitrage.js');
  tuer(processusPS, 'bot_ps3838.js');
  tuer(processusSBO, 'bot_sbobet.js');

  processusArbitrage = processusPS = processusSBO = null;
}

process.on('exit', arreterTousLesBots);
process.on('SIGINT', () => process.exit());     // Ctrl+C
process.on('SIGTERM', () => process.exit());    // kill ou shutdown
process.on('uncaughtException', (err) => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});

app.get('/toggle', async (req, res) => {
  const isActif = estActif(processusArbitrage) || estActif(processusPS) || estActif(processusSBO);

  if (!isActif) {
    console.log('🚀 Démarrage de tous les bots...');
    processusArbitrage = spawn('node', ['arbitrage.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });
    processusPS = spawn('node', ['bot_ps3838.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });
    processusSBO = spawn('node', ['bot_sbobet.js'], {
      cwd: __dirname,
      stdio: 'inherit',
      shell: true
    });

    await envoyerNotificationTelegram('🟢 *Tous les bots ont été ACTIVÉS*');
    res.send('🟢 Tous les bots sont lancés.');
  } else {
    console.log('🛑 Arrêt de tous les bots...');
    arreterTousLesBots();
    await envoyerNotificationTelegram('🔴 *Tous les bots ont été DÉSACTIVÉS*');
    res.send('🔴 Tous les bots sont arrêtés.');
  }
});

app.get('/status', (req, res) => {
  const etats = [
    estActif(processusArbitrage) ? '🟢 arbitrage.js' : '🔴 arbitrage.js',
    estActif(processusPS) ? '🟢 bot_ps3838.js' : '🔴 bot_ps3838.js',
    estActif(processusSBO) ? '🟢 bot_sbobet.js' : '🔴 bot_sbobet.js',
  ];
  res.send(etats.join('\n'));
});

app.listen(PORT, () => {
  console.log(`🚀 Contrôleur dispo sur http://localhost:${PORT} (/toggle, /status)`);
});
