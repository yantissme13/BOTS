const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Cache des matchs déjà associés
const matchCache = {};

// Dictionnaire de correspondance des sports
const sportMap = {
  'Tennis': 'Tennis'
};

async function safeReadJSON(filepath, maxRetries = 5, delay = 50) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const contenu = fs.readFileSync(filepath, 'utf-8');
      if (contenu.trim().endsWith('}')) {
        return JSON.parse(contenu);
      }
    } catch {}
    await new Promise(res => setTimeout(res, delay));
  }
  throw new Error(`Fichier ${filepath} toujours illisible après ${maxRetries} tentatives.`);
}

// Appel du serveur NLP
async function appelerServeurNLP(matchPS, matchesSBO) {
  try {
    const response = await axios.post('http://127.0.0.1:8000/match', {
      new_event: matchPS,
      existing_events: matchesSBO
    });

    return response.data.match;
  } catch (e) {
    console.error('❌ Erreur NLP:', e.message);
    return null;
  }
}

// Fonction principale
async function unifierParSport(psData, sboData) {
  const fusion = {};

  for (const sport in psData) {
    const sportNormalisé = sportMap[sport];
    console.log(`🔎 Sport détecté : ${sport} (normalisé : ${sportNormalisé})`);
    console.log(`📂 sboData[${sportNormalisé}] contient ${(sboData[sportNormalisé] || []).length} matchs`);

    if (!sportNormalisé) continue;

    if (!fusion[sportNormalisé]) fusion[sportNormalisé] = [];

    for (const event of psData[sport]) {
      const cle = `${sportNormalisé}:${event.match}`;

      if (matchCache[cle]) {
        const matchLive = (sboData[sportNormalisé] || []).find(e => e.match === matchCache[cle].match);
        if (matchLive) {
          fusion[sportNormalisé].push({
            match: event.match,
            ps3838: event,
            sbobet: matchLive
          });
          matchCache[cle] = matchLive;
          console.log(`♻️ Mise à jour via cache : ${event.match} ⇔ ${matchLive.match} (cotes SBOBET : ${JSON.stringify(matchLive.odds)})`);
        }
        continue;
      }

      const candidats = (sboData[sportNormalisé] || []).map(e => e.match);
      const resultat = await appelerServeurNLP(event.match, candidats);
      console.log(`🧠 Traitement NLP : "${event.match}" VS [${candidats.length}] matchs SBOBET...`);

      if (resultat) {
        const matchedEvent = sboData[sportNormalisé].find(e => e.match === resultat);
        if (matchedEvent) {
          console.log(`✅ Match associé NLP : "${event.match}" ⇔ "${matchedEvent.match}" [${sportNormalisé}]`);
          fusion[sportNormalisé].push({
            match: event.match,
            ps3838: event,
            sbobet: matchedEvent
          });
          matchCache[cle] = matchedEvent;
        }
      }
    }
  }

  return fusion;
}

// Boucle d’unification toutes les 250ms
setInterval(async () => {
  try {
    const psPath = 'ps_tennis_moneylines.json';
    const sboPath = 'vip_ibc_tennis_live.json';

    const psData = await safeReadJSON(psPath);
    const rawSboData = await safeReadJSON(sboPath);
	const sboData = { Tennis: Object.entries(rawSboData).map(([match, data]) => ({
	  match,
	  odds: data.moneyline,
	  timestamp: data.timestamp
	})) };


    const fusion = await unifierParSport(psData, sboData);
    fs.writeFileSync('evenements_fusionnes_par_sport.json', JSON.stringify(fusion, null, 2));
    console.log('🔄 Fichier fusionné mis à jour.');
  } catch (err) {
    console.error('❌ Erreur lors de l’unification :', err.message);
  }
}, 250);
