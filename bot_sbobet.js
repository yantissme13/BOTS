require('dotenv').config();
const { chromium } = require('playwright');
const axios = require('axios');
const { patchPageForHumanBehavior } = require('./humanPatch');
const simulateHumanBehavior = require('./humanBehavior');
const fs = require('fs');
const path = require('path');
const { Mutex } = require('async-mutex');
// Un seul mutex pour tous les endpoints de pari
const betMutex = new Mutex();
const express = require('express');
const app = express();
app.use(express.json());

let connected = false; // passe à true quand la connexion au broker est établie
let relanceSBOBETEnCours = false;

// Exporte un état de "prêt"
app.get('/ready', (req, res) => {
  if (connected) {
    res.send('READY');
  } else {
    res.status(503).send('NOT READY');
  }
});

app.get('/status', (req, res) => res.send('OK'));

app.listen(5002, () => {
  console.log('🚀 API du bot SBOBET ouverte sur le port 5002');
});
let botActive = true;
let page; // 📣 page globale pour toute l'API express
let currentBet = {}; // ← stocke match, équipe et cote
let lastScrapingFailed = false;


const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

// 🎯 Configuration des sélecteurs CSS dynamiques (à modifier facilement si besoin)
const SELECTOR_TABLE_BODY = 'table tbody'; 
const SELECTOR_PLAYER_NAME = 'span._60009f88.notranslate'; // nom des joueurs
const SELECTOR_MARKET_BOX = 'div._15c2d96c._4391f9a9';
const SELECTOR_JOUEUR_SBOBET = 'div._fd0370f > span';
const SELECTOR_BEST_ODD = 'div._485c525._77abfddd';
const SELECTOR_STAKE_INPUT = 'input.stake-input';
const SELECTOR_ODD_INPUT = 'input.price-input';
const SELECTOR_IN_RUNNING_BTN = 'div._44b62776';
const SELECTOR_STAKE_AT_PRICE = 'span._67640807'; 
const SELECTOR_REAL_ODD_REALTIME = 'span._76dee4ce';
const SELECTOR_STAKE_AT_PRICE_REALTIME = 'span._76b3d29d';
const CROIX_DE_FERMETURE = 'svg._2fd3addc._52918e3a'
const SELECTOR_SOLDE = 'span._16aaeaa2 > span._7c4bfd50:nth-of-type(2)'; 
const SELECTOR_SCORE_ROW = 'div._ec19f8d';
// sélecteur pour la liste des paris déjà placés (table “betBarBody”)
const SELECTOR_PLACED_BETS = '#betBarBody table tbody tr';
const ORDER_ID_DIV_SELECTOR      = 'td div._379a895';
// sélecteur du span qui affiche “unplaced” ou “success”
const SELECTOR_STATUS_SPAN = 'span._42e65996';
// sélecteur de la barre de progression contenant le style "width: calc(XX.XX% + …)"
const PERCENT_STATUS_SELECTOR = 'div._1ea4b7ce';
// seuil minimum de remplissage pour considérer le pari validé
const PERCENT_THRESHOLD = 0;

// 🔁 Lecture plus souple du joueur dans le panier (réessaye plusieurs fois avec pause)
async function lireJoueurAvecAttente(maxTentatives = 5, delaiMs = 300) {
  for (let i = 0; i < maxTentatives; i++) {
    try {
      const joueur = await page.$eval('.ticket-runner-name span', el => el.innerText.trim());
      if (joueur) return joueur;
    } catch (e) {}
    try {
      const joueur = await page.$eval(SELECTOR_JOUEUR_SBOBET, el => el.innerText.trim());
      if (joueur) return joueur;
    } catch (e) {}
    await page.waitForTimeout(delaiMs);
  }
  return null;
}

async function verifierEtFermerPaniersMultiples() {
  const paniers = await page.$$(SELECTOR_MARKET_BOX);
  if (paniers.length > 1) {
    console.warn(`⚠️ ${paniers.length} paniers détectés ! Fermeture forcée...`);

    const croix = await page.$$(CROIX_DE_FERMETURE);
    for (const bouton of croix) {
      const box = await bouton.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(250);
      }
    }
    return true; // paniers fermés
  }

  return false; // pas de doublon
}

async function reessayerPari(match, team, soldeAvant) {
	if (relanceSBOBETEnCours) {
	  console.warn('⏳ Relance déjà en cours, nouvelle tentative ignorée.');
	  return;
	}
	relanceSBOBETEnCours = true;

	
  try {
	await axios.post('http://127.0.0.1:5001/ps3838/fermer-panier');
    // Clique une seule fois via appel local
    const response = await axios.post('http://127.0.0.1:5002/sbobet/arret-scraping-et-pari', {
      match,
      team,
      odds: 0,
      stake: 0
    });

    // Première lecture
    const { newOdds, stakeAtPrice, soldeActuel, score } = response.data;

    let joueurAffiche = null;
    try {
      joueurAffiche = await lireJoueurAvecAttente();
      console.log(`🧐 Joueur affiché dans le panier : ${joueurAffiche}`);
    } catch (e) {
      console.warn('⚠️ Impossible de lire le joueur pendant relance.');
    }

    let matchValide = false;
    if (joueurAffiche) {
      try {
        const resp = await axios.post('http://127.0.0.1:8000/match', {
          new_event: team,
          existing_events: [joueurAffiche]
        });
        const score = resp.data.score;
        console.log(`🔍 Score NLP entre "${team}" et "${joueurAffiche}" : ${score}`);
        if (resp.data.match && score >= 90) {
          matchValide = true;
        } else {
          console.warn(`❌ Joueur incorrect : "${joueurAffiche}" vs "${team}"`);
        }
      } catch (e) {
        console.warn('⚠️ Erreur NLP dans reessayerPari() SBOBET :', e.message);
      }
    }

    if (!matchValide) {
      console.warn('🚫 Abandon relance SBOBET : joueur incorrect.');
	  relanceSBOBETEnCours = false;
      return;
    }

    // 🔁 Surveillance en temps réel toutes les 5 sec
    let enCoursRelance = false;

	const intervalRelance = setInterval(async () => {
	  if (enCoursRelance) return; // ← ignore si déjà une relance en cours
	  enCoursRelance = true;

	  try {
		const soldeText = await page.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
		const soldeActuelVerif = parseFloat(soldeText.replace(/[^\d.]/g, ''));
		const soldeEUR = await convertirMonnaie(soldeActuelVerif, 'usdt');

		if (soldeEUR < soldeAvant) {
		  clearInterval(intervalRelance);
		  console.log(`✅ Solde diminué : pari probablement pris automatiquement (${soldeEUR} < ${soldeAvant})`);
		  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			match,
			bookmaker: 'SBOBET',
			succes: true,
			nouveauSolde: soldeEUR
		  });
		  relanceSBOBETEnCours = false;
		  return;
		}


		let rawStake = await page.$eval(SELECTOR_STAKE_AT_PRICE_REALTIME, el => el.innerText.trim()).catch(() => null);
		let rawCote  = await page.$eval(SELECTOR_REAL_ODD_REALTIME, el => el.innerText.trim()).catch(() => null);

		let stakeNum = rawStake ? parseFloat(rawStake.replace(/[^\d.]/g, '')) : null;
		let oddsNum = rawCote ? parseFloat(rawCote.replace(/[^\d.]/g, '')) : null;
		let stakeEUR = stakeNum ? await convertirMonnaie(stakeNum, 'usdt') : null;

		// Relecture du score comme avant
		let scoreTexte = '';
		try {
		  const row = await page.$(`tr:has-text("${joueurAffiche}")`);
		  if (row) {
			const scoreDiv = await row.$(SELECTOR_SCORE_ROW);
			if (scoreDiv) {
			  const spans = await scoreDiv.$$('span');
			  const fragments = [];

			  for (let i = 0; i < spans.length - 2; i += 3) {
				const part1 = await spans[i].innerText();
				const slash = await spans[i + 1].innerText();
				const part2 = await spans[i + 2].innerText();
				const num1 = parseInt(part1);
				const num2 = parseInt(part2);

				if (
				  slash === '/' &&
				  !isNaN(num1) && !isNaN(num2) &&
				  num1 <= 7 && num2 <= 7
				) {
				  fragments.push(`${num1}/${num2}`);
				}
			  }

			  scoreTexte = fragments.join(' ').trim();
			  console.log(`📊 Score sets uniquement : ${scoreTexte}`);
			}
		  }
		} catch (e) {
		  console.warn('⚠️ Erreur lecture score ligne joueur :', e.message);
		}

		const relancePayload = {
		  match,
		  team,
		  joueurAffiche: joueurAffiche || '',
		  odds: oddsNum || newOdds,
		  maxBet: stakeEUR || stakeAtPrice,
		  solde: soldeEUR || soldeActuel,
		  matchType: score || '',
		  pariplace: false,
		  source: 'SBOBET',
		  scoreComplet: scoreTexte || ''
		};

		// ⏳ Ajout de timeout pour éviter les bloquages prolongés
		await axios.post('http://127.0.0.1:3000/relance-arbitrage', relancePayload, { timeout: 3000 });
		console.log('📡 Relance SBOBET envoyée');

	  } catch (err) {
		console.warn('⚠️ Erreur pendant relance SBOBET :', err.message);
	  } finally {
		enCoursRelance = false;
		relanceSBOBETEnCours = false;
	  }
	}, 5000);


    } catch (err) {
	  console.error('❌ Erreur reessayerPari SBOBET:', err.message);
	} finally {
	  relanceSBOBETEnCours = false;
	}

}

// Retourne le max order ID actuellement affiché dans la table des paris (ou 0 s’il n’y a rien)
async function getMaxOrderId() {
  const rows = await page.$$(SELECTOR_PLACED_BETS);
  let maxId = 0;
  for (const row of rows) {
    const idText = await row.$eval('td:nth-child(1) ._2eeac985', el => el.innerText.trim());
    const idNum = parseInt(idText, 10);
    if (!isNaN(idNum) && idNum > maxId) maxId = idNum;
  }
  return maxId;
}

async function convertirMonnaie(amount, from) {
  try {
    const response = await axios.get(`http://127.0.0.1:5010/convert?amount=${amount}&from=${from}`);
    return response.data.converted;
  } catch (error) {
    console.error('❌ Erreur lors de la conversion monnaie:', error.message);
    return null;
  }
}

// 🔔 Fonction simple pour envoyer un message libre sur Telegram
async function sendTelegramMessage(message) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('📨 Message libre Telegram envoyé.');
  } catch (err) {
    console.warn('⚠️ Erreur envoi Telegram :', err.message);
  }
}

// 🔄 Fonction pour demander aux deux bots de reprendre leur scraping
async function reprendreScraping() {
  try {
    await axios.post('http://127.0.0.1:5001/action', { action: 'resume' });
    console.log('▶️ Bot PS3838 relancé');
  } catch (err) {
    console.warn('⚠️ Bot PS3838 pas joignable:', err.message);
  }

  try {
    await axios.post('http://127.0.0.1:5002/action', { action: 'resume' });
    console.log('▶️ Bot SBOBET relancé');
  } catch (err) {
    console.warn('⚠️ Bot SBOBET pas joignable:', err.message);
  }
}

// 🚀 API pour recevoir une action de pari
app.post('/sbobet/arret-scraping-et-pari', async (req, res) => {
	// Refuse toute nouvelle instruction de pari si on est déjà en train d'en traiter une
	await betMutex.runExclusive(async () => {
		
		const paniersFermes = await verifierEtFermerPaniersMultiples();
		if (paniersFermes) {
		  return res.status(400).json({ error: 'multiple_paniers_detectes' });
		}

		if (!botActive) {
		  console.warn('⚠️ Requête d’arret de scraping refusée : bot occupé');
		  return res.status(409).send('Bot occupé, réessayez plus tard');
		}
	  const { match, team, odds, stake } = req.body;
	  currentBet = { match, team, odds };
	  console.log(`📥 Instruction de pari SBOBET reçue : ${stake}€ sur ${team} @${odds} pour ${match}`);


	  botActive = false; // Arrêter temporairement le scraping

	  try {
		const matchs = await page.$$(SELECTOR_TABLE_BODY + ' tr');
		console.log(`🔍 Liste des matchs visibles actuellement :`);

			// ———————————————— NLP Matching à ≥85% ————————————————
		// 1) On extrait tous les "Home vs Away" dans events[], et leurs <tr> dans items[]
		const events = [];
		const items = [];
		for (const item of matchs) {
		  let home = "", away = "";
		  for (const td of await item.$$('td')) {
			const span = await td.$(SELECTOR_PLAYER_NAME);
			if (span) {
			  const txt = (await span.innerText()).trim();
			  if (!home) home = txt;
			  else if (!away) away = txt;
			}
		  }
		  if (home && away) {
			events.push(`${home} vs ${away}`);
			items.push(item);
		  }
		}

		// 2) On appelle le serveur NLP pour matcher "match" contre events[]
		let matchTrouve = null;
		let matchHome = "";
		let matchAway = "";
		try {
		  const resp = await axios.post('http://127.0.0.1:8000/match', {
			new_event: match,
			existing_events: events
		  });
		  const nlpMatch = resp.data.match; // null si < 85%
		  console.log(`🧠 NLP matched: "${match}" → "${nlpMatch}" (score ${resp.data.score})`);
		  if (nlpMatch) {
			const idx = events.indexOf(nlpMatch);
			matchTrouve = items[idx];
			[matchHome, matchAway] = nlpMatch.split(' vs ');
		  }
		} catch (err) {
		  console.warn('⚠️ Erreur appel NLP server:', err.message);
		}


		if (!matchTrouve) {
		  console.warn('❌ Match non trouvé sur SBOBET.');
		  res.status(404).send('Match non trouvé');
		  return;
		}

		// Clique sur la cote correspondante (sans vérifier l'odd ici)
		const boutonsCotes = await matchTrouve.$$('td[data-id]');

		if (boutonsCotes.length < 2) {
		  console.warn('❌ Pas assez de cotes trouvées.');
		  return res.status(404).send('Pas assez de cotes trouvées');
		}

		// 🧹 Nettoie les noms pour comparaison
		const clean = (str) => str.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim();
		const teamClean = clean(team);
		const homeClean = clean(matchHome);
		const awayClean = clean(matchAway);


		let boutonCote = null;
		if (teamClean === homeClean) {
		  boutonCote = boutonsCotes[0]; // premier joueur
		} else if (teamClean === awayClean) {
		  boutonCote = boutonsCotes[1]; // deuxième joueur
		} else {
		  console.warn('❌ Joueur demandé non reconnu.');
		  return res.status(404).send('Joueur non reconnu dans ce match');
		}


		if (boutonCote) {
		  // 1) Faire défiler jusqu'au bouton si nécessaire
		  await boutonCote.scrollIntoViewIfNeeded();

		  try {
		  await boutonCote.scrollIntoViewIfNeeded();
		  await boutonCote.click({ force: true });
		  console.log('✅ Clic réussi sur la cote (via click() direct).');
		} catch (err) {
		  console.warn('❌ Échec du clic direct sur la cote :', err.message);
		}

		} else {
		  console.warn('⚠️ Aucun bouton de cote disponible pour cette équipe.');
		}

		// ⏳ Attendre que le bloc de pari s'ouvre
		await page.waitForSelector(SELECTOR_MARKET_BOX, { timeout: 5000 });
		// 🔍 Vérifie que le joueur affiché dans le panier est bien celui attendu
		let joueurAffiche = await lireJoueurAvecAttente();
		if (joueurAffiche) {
		  console.log(`🧐 Joueur affiché dans le panier : ${joueurAffiche}`);
		} else {
		  return res.status(400).json({ error: 'player_not_found' });
		}

		let matchValide = false;
		if (joueurAffiche) {
		  try {
			const resp = await axios.post('http://127.0.0.1:8000/match', {
			  new_event: team, // 🟢 Ajout ici
			  existing_events: [joueurAffiche]
			});
			const score = resp.data.score;
			console.log(`🔍 Score NLP entre "${team}" et "${joueurAffiche}" : ${score}`);

			if (resp.data.match && score >= 90) {
			  matchValide = true;
			} else {
			  console.warn(`❌ Le joueur affiché (${joueurAffiche}) ne correspond pas à la demande (${team})`);
			}
		  } catch (e) {
			console.warn('⚠️ Erreur NLP lors de la vérification joueur affiché :', e.message);
		  }
		}

		if (!matchValide) {
		  // 🚫 Ferme la fenêtre de pari
		  try {
			const boutonCroix = await page.$(CROIX_DE_FERMETURE);
			if (boutonCroix) {
			  const box = await boutonCroix.boundingBox();
			  if (box) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
				console.log('❌ Panier fermé à cause d’un conflit joueur.');
			  }
			}
		  } catch (e) {
			console.warn('⚠️ Impossible de fermer le panier après mauvais joueur.');
		  }

		  // 📩 Envoie une alerte Telegram

		  botActive = true;
		  return res.status(400).json({ error: 'player_mismatch' });
		}

		// 🔥 Clique sur "Best Odd"
		try {
		  const bestOddDivs = await page.$$(SELECTOR_BEST_ODD);
		  let bestOddDiv = null;

		  for (const div of bestOddDivs) {
			const spans = await div.$$('span');
			for (const span of spans) {
			  const text = (await span.innerText()).trim().toLowerCase();
			  if (text === 'best') {
				bestOddDiv = div;
				break;
			  }
			}
			if (bestOddDiv) break;
		  }

		  if (bestOddDiv) {
			  const box = await bestOddDiv.boundingBox();
			  if (box) {
				const x = box.x + box.width / 2;
				const y = box.y + box.height / 2;

				let success = false;
				for (let tentative = 0; tentative < 3; tentative++) {
				  await page.mouse.move(x, y);
				  await page.mouse.click(x, y);
				  await page.waitForTimeout(100); // pause minimale
				  success = await page.$(SELECTOR_STAKE_INPUT); // ou autre élément qui montre que ça a fonctionné
				  if (success) break;
				}
			  }
			}


		} catch (err) {
		  console.warn('⚠️ Erreur tentative clic Best Odd:', err.message);
		}



		// Lire la cote affichée dans le bloc de pari (input price-input)
		// 🔁 Lecture simultanée des trois valeurs
		const [
		  coteFinale,
		  rawStakeAtPrice,
		  rawSoldeActuel
		] = await Promise.all([
		  page.$eval(SELECTOR_ODD_INPUT, el => el.value.trim()),
		  page.$eval(SELECTOR_STAKE_AT_PRICE, el => el.innerText.trim()).catch(() => null),
		  page.$eval(SELECTOR_SOLDE, el => el.innerText.trim()).catch(() => null)
		]);

		console.log(`🔍 Nouvelle cote affichée dans panier : ${coteFinale}`);
		if (rawStakeAtPrice) console.log(`🔍 Stake at Price détecté : ${rawStakeAtPrice}`);
		if (rawSoldeActuel) console.log(`🔍 Solde détecté : ${rawSoldeActuel}`);

		let stakeAtPrice = rawStakeAtPrice;
		let soldeActuel = rawSoldeActuel ? parseFloat(rawSoldeActuel.replace(/[^\d.]/g, '')) : null;


		// Conversion de USDT à EUR avant envoi à l'arbitrage détecteur
		let stakeAtPriceEur = null;
		let soldeActuelEur = null;

		try {
		  const [convertedStake, convertedSolde] = await Promise.all([
			stakeAtPrice ? convertirMonnaie(parseFloat(stakeAtPrice.replace(/[^\d.-]/g, '')), 'usdt') : null,
			soldeActuel ? convertirMonnaie(soldeActuel, 'usdt') : null
		  ]);
		  stakeAtPriceEur = convertedStake;
		  soldeActuelEur = convertedSolde;
		} catch (e) {
		  console.warn('⚠️ Erreur conversion USDT ➔ EUR:', e.message);
		}



		// Envoi uniquement des valeurs converties en EUR au détecteur
		res.json({
		  newOdds: parseFloat(coteFinale),
		  stakeAtPrice: stakeAtPriceEur,
		  soldeActuel: soldeActuelEur
		});



	  } catch (error) {
		console.error('❌ Erreur pendant le traitement pari SBOBET:', error.message);
		res.status(500).send('Erreur traitement pari');
	  } finally {
		botActive = true; // Reprendre le scraping
	  }
	});
});

// 🚀 Route spéciale pour recevoir les cotes finales après avoir cliqué + misé
// 🔁 Route pour écrire uniquement la mise finale (en EUR) reçue du détecteur
app.post('/sbobet/ecrire-mise-final', async (req, res) => {
	await betMutex.runExclusive(async () => {
		
	    const paniersFermes = await verifierEtFermerPaniersMultiples();
		if (paniersFermes) {
		  return res.status(400).json({ error: 'multiple_paniers_detectes' });
		}

	  const { stake } = req.body;
	  console.log(`📥 Mise finale reçue à écrire : ${stake} EUR`);

	  if (!page) {
		console.warn('❌ Aucune page active.');
		await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
		  match: currentBet.match,
		  bookmaker: 'SBOBET',
		  succes: false,
		  nouveauSolde: currentBet.soldeAvant ?? 0
		});


		return res.status(400).send('Page inactive');
	  }

	  try {
		// Conversion EUR -> USDT
		let finalStake = await convertirMonnaie(stake, 'eur');
		finalStake = Math.max(0, finalStake - 0.1); // soustraction de 0.1 USDT
		finalStake = Math.round(finalStake * 100) / 100; // arrondi à 2 décimales

		console.log(`💱 Mise convertie : ${stake} EUR = ${finalStake} USDT`);


		// 🎯 Remplissage du champ de mise dans le panier
		const input = await page.$(SELECTOR_STAKE_INPUT);
		if (!input) {
		  console.warn('❌ Champ de mise non trouvé.');
		  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			  match: currentBet.match,
			  bookmaker: 'SBOBET',
			  succes: false,
			  nouveauSolde: currentBet.soldeAvant ?? 0
			});
		  return res.status(404).send('Champ de mise introuvable');
		}
		
		await input.fill('');
		await input.type(finalStake.toString()); // saisie instantanée
		console.log(`✅ Mise ${finalStake} USDT saisie dans le champ.`);
		let boutonPlaceTrouve = false;
		// 🕵️ Lire le solde juste avant le clic
		const rawSoldeAvant = await page.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
		const soldeAvantUSDT = parseFloat(rawSoldeAvant.replace(/[^\d.]/g, ''));
		currentBet.soldeAvantUSDT = soldeAvantUSDT;
		currentBet.soldeAvant = await convertirMonnaie(soldeAvantUSDT, 'usdt'); // ← converti en EUR
		console.log(`💶 Solde avant clic : ${currentBet.soldeAvant} EUR`);

		// ✅ Clique sur "Place" avec plusieurs tentatives si nécessaire
		// ─── CODE DE PLACEMENT ───────────────────────────────────────────
		try {
		  // 📥 Récupérer l’order ID de la première ligne avant le clic
		  const firstOrderIdBefore = await page.$$eval(
			SELECTOR_PLACED_BETS,
			(rows, orderIdSel) => {
			  if (rows.length === 0) return null;
			  const idDiv = rows[0].querySelector(orderIdSel);
			  return idDiv ? idDiv.textContent.trim() : null;
			},
			ORDER_ID_DIV_SELECTOR
		  );
		  console.log(`🔢 Order ID en tête avant clic : ${firstOrderIdBefore}`);

		  // Préparer et cliquer sur le bouton "Place"
		  const placeBtn = page.locator('button:has-text("Place")');
		  await placeBtn.waitFor({ state: 'visible', timeout: 5000 });
		  await placeBtn.scrollIntoViewIfNeeded();

		  let boutonPlaceValide = false;

		  for (let tentative = 0; tentative < 3; tentative++) {
			console.log(`🖱️ Tentative ${tentative + 1} de clic sur "Place"`);
			await placeBtn.click();
			await page.waitForTimeout(1500);

			// 📥 Récupérer l’order ID de la première ligne après le clic
			const firstOrderIdAfter = await page.$$eval(
			  SELECTOR_PLACED_BETS,
			  (rows, orderIdSel) => {
				if (rows.length === 0) return null;
				const idDiv = rows[0].querySelector(orderIdSel);
				return idDiv ? idDiv.textContent.trim() : null;
			  },
			  ORDER_ID_DIV_SELECTOR
			);
			console.log(`🔢 Order ID en tête après tentative ${tentative + 1} : ${firstOrderIdAfter}`);

			if (firstOrderIdAfter && firstOrderIdAfter !== firstOrderIdBefore) {
			  console.log('✅ Le premier order ID a changé, pari validé.');
			  boutonPlaceValide = true;
			  break;
			}
		  }

		  if (!boutonPlaceValide) {
			console.warn('⚠️ Le premier order ID n’a pas changé après 3 tentatives.');
			await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			  match: currentBet.match,
			  bookmaker: 'SBOBET',
			  succes: false,
			  nouveauSolde: currentBet.soldeAvant ?? 0
			});


			await sendTelegramMessage(
			  `⚠️ Échec du placement automatique\n` +
			  `Match : ${currentBet.match}\n` +
			  `Équipe : ${currentBet.team}\n` +
			  `Côte : ${currentBet.odds}\n` +
			  `Mise à placer manuellement : ${finalStake} USDT`
			);
		  }

		  // 🗑️ Fermer le panier
		  const boutonCroix = await page.$(CROIX_DE_FERMETURE);
		  if (boutonCroix) {
			for (let i = 0; i < 2; i++) {
			  const box = await boutonCroix.boundingBox();
			  if (!box) break;
			  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			  console.log(`✅ Tentative ${i + 1} : clic sur la croix pour fermer le panier.`);
			  await page.waitForTimeout(500);
			}
		  }
		  // 🕒 Vérification 30 secondes après fermeture du panier
		  setTimeout(async () => {
			  try {
				const rawSoldeFinal = await page.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
				const soldeFinalUSDT = parseFloat(rawSoldeFinal.replace(/[^\d.]/g, ''));
				const soldeFinalEUR = await convertirMonnaie(soldeFinalUSDT, 'usdt');

				console.log(`🕒 Vérification post-pari : Solde = ${soldeFinalEUR} EUR (avant clic : ${currentBet.soldeAvant} EUR)`);


				if (soldeFinalUSDT >= currentBet.soldeAvantUSDT) {
				  const diff = (soldeFinalEUR - currentBet.soldeAvant).toFixed(2);
				  console.warn(`🔔 Solde inchangé ou augmenté (+${diff}€) : pari probablement refusé.`);

				  await sendTelegramMessage(
					`❌ *Pari probablement refusé sur SBOBET*\n` +
					`*Match* : ${currentBet.match}\n` +
					`*Équipe* : ${currentBet.team}\n` +
					`*Côte* : ${currentBet.odds}\n\n` +
					`🕒 *Vérification 30s après tentative*\n` +
					`💶 Solde avant clic : ${currentBet.soldeAvant}€\n` +
					`💵 Solde 30s après : ${soldeFinalEUR}€\n` +
					`📈 *Aucune baisse détectée ➜ mise non prélevée ou refusée.*\n\n` +
					`_Merci de vérifier et de placer manuellement le pari si nécessaire._`
				  );

				  // 🚨 Relance automatique
				  await reessayerPari(currentBet.match, currentBet.team, soldeFinalEUR);
				}else {
				  console.log('✅ Solde cohérent 30s après. Aucun remboursement détecté.');
				  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
					match: currentBet.match,
					bookmaker: 'SBOBET',
					succes: true,
					nouveauSolde: soldeFinalEUR
				  });
				  console.log('📩 Retour pari envoyé au détecteur (SBOBET)');
				}


			  } catch (e) {
				console.error('❌ Erreur vérification post-pari SBOBET :', e.message);
			  }
			}, 30000);


		  // 🔄 Reprise du scraping
		  await reprendreScraping();
		  res.sendStatus(200);

		} catch (e) {
		  console.error('❌ Erreur lors du clic “Place” ou de la récupération de l’order ID :', e.message);
		  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			  match: currentBet.match,
			  bookmaker: 'SBOBET',
			  succes: false,
			  nouveauSolde: currentBet.soldeAvant ?? 0
			});

		  res.status(500).send('Erreur placement/order ID');
		  await sendTelegramMessage(
			  `❌ *Erreur lors du clic sur "Place"*\n` +
			  `Match : ${currentBet.match}\n` +
			  `Équipe : ${currentBet.team}\n` +
			  `Côte : ${currentBet.odds}\n` +
			  `Mise convertie : ${finalStake} USDT\n\n` +
			  `_Vérifie si le bouton était désactivé ou si la cote a changé._`
			);
		}
	  } catch (err) {
		// <-- Ici tu closes le premier try
		console.error('❌ Erreur dans ecrire-mise-final:', err.message);
		await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
		  match: currentBet.match,
		  bookmaker: 'SBOBET',
		  succes: false,
		  nouveauSolde: currentBet.soldeAvant ?? 0
		});

		await sendTelegramMessage(
		  `❌ *Erreur lors de la saisie de la mise finale sur SBOBET*\n` +
		  `Match : ${currentBet.match}\n` +
		  `Équipe : ${currentBet.team}\n` +
		  `Côte : ${currentBet.odds}\n` +
		  `Mise initiale reçue : ${stake} EUR\n\n` +
		  `_Message d'erreur : ${err.message}_`
		);

		return res.status(500).send('Erreur écriture mise finale');
	  }	
    });
});

app.post('/sbobet/fermer-panier', async (req, res) => {
	await betMutex.runExclusive(async () => {

	  try {
		console.log('🛑 Fermeture forcée du panier SBOBET');
		const boutonCroix = await page.$(CROIX_DE_FERMETURE);
		if (boutonCroix) {
		  const box = await boutonCroix.boundingBox();
		  if (box) {
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			console.log('✅ Panier SBOBET fermé.');
		  }
		}
		res.sendStatus(200);
	  } catch (e) {
		console.error('❌ Erreur fermeture panier SBOBET:', e.message);
		res.sendStatus(500);
	  }
	});
});

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.123 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'fr-FR',
    timezoneId: 'Europe/Oslo',
    extraHTTPHeaders: {
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    }
  });

  page = await context.newPage();
  await patchPageForHumanBehavior(page);
  await simulateHumanBehavior(page);

  console.log('🌍 Navigation vers VIP-IBC...');
  await page.goto('https://vip-ibc.com/', { waitUntil: 'load', timeout: 120000 }); // 2 minutes

  try {
    let loginPage;

    console.log('🖱️ Clic humain sur "LOG IN"...');
    const loginPageBtn = await page.waitForSelector('a.elementor-button-link:has-text("Log in")', { timeout: 10000 });
    const box = await loginPageBtn.boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      const [loginPageTmp] = await Promise.all([
        context.waitForEvent('page'),
        page.mouse.click(box.x + box.width / 2, box.y + box.height / 2),
      ]);
      loginPage = loginPageTmp;
      await loginPage.waitForLoadState('domcontentloaded');
    } else {
      throw new Error('🔴 Bouton "LOG IN" introuvable.');
    }

    console.log('🔎 Remplissage humain des identifiants VIP-IBC...');
    await loginPage.locator('label:has(span:text("username")) input[type="text"]').fill(process.env.VIP_IBC_USERNAME);
	await loginPage.locator('label:has(span:text("password")) input[type="password"]').fill(process.env.VIP_IBC_PASSWORD);


    console.log('🖱️ Clic humain sur "Login"...');
    const loginBtn = await loginPage.locator('button:has(label:text("log In"))').first();
	await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
	const box2 = await loginBtn.boundingBox();
	if (box2) {
	  await loginPage.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
	  await loginPage.mouse.click(box2.x + box2.width / 2, box2.y + box2.height / 2);
	  console.log('✅ Connexion VIP-IBC lancée !');
	} else {
	  throw new Error('🔴 Bouton "Log In" introuvable (via label).');
	}

    await loginPage.waitForTimeout(5000);

    // ✅ Maintenant on change page = loginPage pour utiliser une seule variable
    page = loginPage;

    console.log('🎾 Sélection du sport "Tennis"...');
    const tennisBtn = await page.waitForSelector('a[href="/trade/tennis"]', { timeout: 10000 });
    const tennisBox = await tennisBtn.boundingBox();
    if (tennisBox) {
      await page.mouse.move(tennisBox.x + tennisBox.width / 2, tennisBox.y + tennisBox.height / 2);
      await page.mouse.click(tennisBox.x + tennisBox.width / 2, tennisBox.y + tennisBox.height / 2);
      console.log('✅ Tennis sélectionné.');
      await page.waitForTimeout(3000);
    } else {
      throw new Error('🔴 Lien Tennis introuvable.');
    }
	
	connected = true;

    const outputFile = path.join(__dirname, 'vip_ibc_tennis_live.json');
    let isScraping = false;
    let previousData = {};

    setInterval(async () => {
	  if (isScraping || !botActive) return;
	  isScraping = true;

	  try {
		let liveRows = [];

		try {
		  await page.waitForSelector(SELECTOR_TABLE_BODY, { timeout: 5000 });
		  liveRows = await page.$$(SELECTOR_TABLE_BODY + ' tr');
		  if (lastScrapingFailed) {
			  await sendTelegramMessage(
				`✅ *Blocage résolu sur VIP-IBC*\n` +
				`Le scraping fonctionne de nouveau correctement.\n` +
				`_Le bouton "in-running" ou l'action manuelle a débloqué la situation._`
			  );
			  lastScrapingFailed = false;
			}

		} catch (err) {
		  console.warn('⚠️ Erreur scraping VIP-IBC:', err.message);

		  if (err.message.includes('Timeout') && err.message.includes(SELECTOR_TABLE_BODY)) {
			  console.log('🔁 Tentative de clic sur "in-running"...');

			  // 🔔 Notification TELEGRAM en cas de blocage grave
			  await sendTelegramMessage(
				`❌ *Blocage détecté sur VIP-IBC*\n` +
				`📛 Erreur : Timeout sur le sélecteur \`${SELECTOR_TABLE_BODY}\`\n` +
				`📍 Action recommandée : *redémarrer manuellement le bot VIP-IBC*.\n\n` +
				`_Le scraping est probablement bloqué ou la session expirée._`
			  );
			  lastScrapingFailed = true;


			console.log('🔁 Tentative de clic sur "in-running"...');

			try {
			  const btn = await page.$('div:has-text("in-running")');
			  if (btn) {
				const box = await btn.boundingBox();
				if (box) {
				  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				  await page.mouse.down();
				  await page.waitForTimeout(100 + Math.random() * 200); // pause humaine
				  await page.mouse.up();
				  console.log('✅ Bouton "in-running" cliqué avec simulation humaine.');
				} else {
				  console.warn('⚠️ Impossible de localiser la position du bouton "in-running".');
				}
			  } else {
				console.warn('❌ Bouton "in-running" introuvable.');
			  }
			} catch (clickErr) {
			  console.error('❌ Erreur lors du clic sur "in-running" :', clickErr.message);
			}
		  }
		  // Quitte cette itération
		  isScraping = false;
		  return;
		}



		const now = new Date().toISOString();
		const newData = {};

		for (const row of liveRows) {
		  try {
			let isLive = false;
			const spans = await row.$$('td span');
			for (const span of spans) {
			  const text = (await span.innerText()).trim().toLowerCase();
			  if (text.includes('live') || text.includes('set') || text.match(/^\d+\/\d+$/)) {
				isLive = true;
				if (text.includes('live') || text.includes('set') || text.match(/^\d+\/\d+$/)) {
				  isLive = true;
				  break;
				}

				break;
			  }
			}
			if (!isLive) continue;

			const cells = await row.$$('td');
			let player1 = "";
			let player2 = "";
			let odd1 = "";
			let odd2 = "";

			for (const cell of cells) {
			  const dataId = await cell.getAttribute('data-id');
			  if (dataId) {
				const oddText = (await cell.innerText()).trim();
				if (!odd1) {
				  odd1 = oddText;
				} else if (!odd2) {
				  odd2 = oddText;
				}
			  }

		    const span = await cell.$(SELECTOR_PLAYER_NAME);
			if (span) {
			  const playerName = (await span.innerText()).trim();
			  if (!player1) {
				player1 = playerName;
			  } else if (!player2) {
				player2 = playerName;
			  }
			}

			}

			if (player1 && player2 && !isNaN(parseFloat(odd1)) && !isNaN(parseFloat(odd2))) {
			  newData[`${player1} vs ${player2}`] = {
				moneyline: {
				  [player1]: odd1,
				  [player2]: odd2
				},
				timestamp: now
			  };
			}

		  } catch (error) {
			console.warn('⚠️ Erreur lecture ligne live:', error.message);
		  }
		}

		fs.writeFileSync(outputFile, JSON.stringify(newData, null, 2), 'utf-8');
		console.log(`💾 MAJ ${Object.keys(newData).length} matchs - ${now}`);
		if (Object.keys(newData).length === 0) {
		  console.log('📭 Aucun match détecté, tentative de clic sur "in-running"...');
		  try {
			const allBtns = await page.$$(SELECTOR_IN_RUNNING_BTN);
			let inRunningBtn = null;

			for (const btn of allBtns) {
			  const textContent = await btn.innerText();
			  if (textContent.toLowerCase().includes('in-running')) {
				inRunningBtn = btn;
				break;
			  }
			}

			if (inRunningBtn) {
			  const box = await inRunningBtn.boundingBox();
			  if (box) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.down();
				await page.waitForTimeout(100 + Math.random() * 200); // pause humaine
				await page.mouse.up();
				console.log('✅ Clic simulé sur le bouton "in-running".');
			  } else {
				console.warn('⚠️ Position du bouton "in-running" non détectable.');
			  }
			} else {
			  console.warn('❌ Bouton "in-running" introuvable.');
			}
		  } catch (err) {
			console.error('❌ Erreur lors du clic "in-running" :', err.message);
		  }
		}


	  } catch (err) {
		console.warn('⚠️ Erreur scraping VIP-IBC:', err.message);
	  } finally {
		isScraping = false;
	  }
	}, 250);


  } catch (error) {
    console.error('❌ Erreur durant le process VIP-IBC :', error.message);
    await browser.close();
  }
})();
