const fs = require('fs');
const axios = require('axios');
const player = require('play-sound')();

const fichierFusion = './evenements_fusionnes_par_sport.json';
let opportunitesActives = {}; // { id: { start: timestamp, match, arbitrage } }
let confirmations = {}; // { id: { Unibet: true, Betsson: true } }

function calculArbitrage(cote1, cote2) {
  const inv1 = 1 / cote1;
  const inv2 = 1 / cote2;
  const total = inv1 + inv2;
  return {
    isArbitrage: total < 1,
    profit: +(100 * (1 - total)).toFixed(2)
  };
}

const TELEGRAM_BOT_TOKEN = '7569528340:AAHShvC_2FUQaIrzQMK8kjchFAsE3Balt1U';
const TELEGRAM_CHAT_ID = '-1002426777212';

const sendTelegramAlert = async (match, arbitrage, type = 'detection') => {
  const TOTAL_AMOUNT = 20;
  let message = '';

  if (type === 'confirmation') {
    message += `🟢 *Confirmation : Opportunité Réelle !*\n\n`;
    message += `✅ *Les deux bots ont validé que l’arbitrage était exploitable.*\n`;
    message += `💰 *Profit possible :* *${arbitrage.percentage}%*\n`;
    if (arbitrage.duree) {
      message += `⏱️ *Durée de validité observée :* ${arbitrage.duree} sec\n`;
    }
    message += `\n🎯 *Match :* ${match.unibet.match}\n`;
  } else {
    message += `🚀 *Opportunité d’Arbitrage Détectée !*\n\n`;
    message += `📅 *Match :* ${match.unibet.match}\n`;
    message += `🎯 *Profit Potentiel :* *${arbitrage.percentage}%*\n`;
    if (arbitrage.duree) {
      message += `⏱️ *Durée d’existence :* ${arbitrage.duree} sec\n`;
    }
    message += `\n`;
  }

  let totalProb = arbitrage.bets.reduce((acc, bet) => acc + (1 / bet.odds), 0);
  message += `📊 *Bookmakers et mises optimales* (sur *${TOTAL_AMOUNT}€*) :\n`;

  arbitrage.bets.forEach(bet => {
    const stake = (TOTAL_AMOUNT * (1 / bet.odds)) / totalProb;
    message += `🏦 *${bet.bookmaker}* - *${bet.team}* | Cote : *${bet.odds}* | Mise : *${stake.toFixed(2)}€*\n`;
  });

  for (let i = 0; i < 5; i++) {
    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      });
      break;
    } catch (err) {
      console.warn(`⚠️ Tentative ${i + 1}/5 échouée :`, err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
};


const envoyerAuxBots = async (match, sport, arbitrage) => {
  const endpoints = {
    'Unibet': 'http://localhost:5002/unibet/arret-scraping-et-pari',
    'Betsson': 'http://localhost:5003/betsson/arret-scraping-et-pari'
  };
  
  // ✅ 🔊 Lecture du son dès qu’on envoie aux bots
  player.play('./alert.mp3', err => {
    if (err) console.error('❌ Erreur lecture audio :', err);
  });
  
  for (const bet of arbitrage.bets) {
    const endpoint = endpoints[bet.bookmaker];
    if (!endpoint) continue;

    try {
      await axios.post(endpoint, {
        match: match.unibet.match,
        sport,
        team: bet.team,
        odds: bet.odds
      });
      console.log(`📨 Opportunité envoyée à ${bet.bookmaker} pour ${bet.team} @ ${bet.odds}`);
    } catch (err) {
      console.warn(`❌ Échec envoi à ${bet.bookmaker} :`, err.message);
    }
  }
};

const express = require('express');
const app = express();
app.use(express.json());

app.post('/detecteur/opportunite-validee', async (req, res) => {
  const { match, sport, team, odds, bookmaker } = req.body;
  const id = `${sport} | ${match}`;
  
  if (!confirmations[id]) confirmations[id] = {};
  confirmations[id][bookmaker] = true;

  if (confirmations[id].Unibet && confirmations[id].Betsson) {
    const opportunite = opportunitesActives[id];
    if (opportunite) {
      const durée = ((Date.now() - opportunite.start) / 1000).toFixed(2);
      opportunite.arbitrage.duree = durée;
      console.log(`✅ Opportunité ${id} confirmée par les deux bots après ${durée}s`);
      await sendTelegramAlert(opportunite.match, opportunite.arbitrage, 'confirmation');

      // On nettoie après confirmation
      delete confirmations[id];
      delete opportunitesActives[id];
    }
  }

  res.sendStatus(200);
});

function analyser() {
  let data;
  try {
    const contenu = fs.readFileSync(fichierFusion, 'utf-8');
    if (!contenu.trim().endsWith('}')) {
      // JSON probablement incomplet
      throw new Error('Fichier JSON incomplet, tentative ignorée.');
    }
    data = JSON.parse(contenu);
  } catch (e) {
    console.warn('⚠️ Lecture reportée :', e.message);
    return;
  }

  const maintenant = Date.now();
  const nouvelles = {};

  for (const sport in data) {
    for (const match of data[sport]) {
      if (!match.unibet || !match.betsson) continue;

      const id = `${sport} | ${match.match}`;
      const [coteU1, coteU2] = match.unibet.odds.map(o => o.odd);
      const [coteB1, coteB2] = match.betsson.odds.map(o => o.odd);

      const arb1 = calculArbitrage(coteU1, coteB2);
      const arb2 = calculArbitrage(coteU2, coteB1);

      if (arb1.isArbitrage) {
		  if (!opportunitesActives[id]) {
			opportunitesActives[id] = {
			  start: maintenant,
			  match,
			  arbitrage: {
				percentage: arb1.profit,
				bets: [
				  { bookmaker: 'Unibet', team: match.unibet.odds[0].team, odds: coteU1 },
				  { bookmaker: 'Betsson', team: match.betsson.odds[1].team, odds: coteB2 }
				]
			  }
			};
			envoyerAuxBots(match, sport, opportunitesActives[id].arbitrage);
			console.log(`📢 Nouvelle opportunité (U1 vs B2) pour ${id} | Profit : ${arb1.profit}%`);
		  }
		  nouvelles[id] = true;
		} else if (arb2.isArbitrage) {
		  if (!opportunitesActives[id]) {
			opportunitesActives[id] = {
			  start: maintenant,
			  match,
			  arbitrage: {
				percentage: arb2.profit,
				bets: [
				  { bookmaker: 'Unibet', team: match.unibet.odds[1].team, odds: coteU2 },
				  { bookmaker: 'Betsson', team: match.betsson.odds[0].team, odds: coteB1 }
				]
			  }
			};
			envoyerAuxBots(match, sport, opportunitesActives[id].arbitrage);
			console.log(`📢 Nouvelle opportunité (U2 vs B1) pour ${id} | Profit : ${arb2.profit}%`);
		  }
		  nouvelles[id] = true;
		}

    }
  }

  for (const id in opportunitesActives) {
	  if (!nouvelles[id]) {
		const { start, match, arbitrage } = opportunitesActives[id];
		const durée = ((maintenant - start) / 1000).toFixed(2);
		console.log(`⛔ Fenêtre pour ${id} fermée après ${durée} secondes`);

		// ✅ Ajoute durée dans l'objet arbitrage
		arbitrage.duree = durée;
		sendTelegramAlert(match, arbitrage);
	  }
	}


  for (const id in opportunitesActives) {
	  if (!nouvelles[id]) continue;
	  nouvelles[id] = opportunitesActives[id];
	}
	opportunitesActives = nouvelles;
}


// 🚀 Lancement de la boucle
console.log('🧠 Serveur de détection d’arbitrage lancé (intervalle 0.1s)...');

setInterval(analyser, 100);

app.listen(5001, () => {
  console.log('🧠 Serveur de détection en écoute sur le port 5001');
});
