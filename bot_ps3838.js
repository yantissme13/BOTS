require('dotenv').config();
const { chromium } = require('playwright');
const { patchPageForHumanBehavior } = require('./humanPatch');
const simulateHumanBehavior = require('./humanBehavior');
const { Mutex } = require('async-mutex');
// Un seul mutex pour tous les endpoints de pari
const betMutex = new Mutex();
const express = require('express');
const app = express();
app.use(express.json());
let psPage; // 👈 On la déclare vide au début
let botActive = true;
let soldeActuel = 1000; // ⚡ à remplacer par ton vrai solde récupéré dynamiquement
const axios = require('axios');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

async function fermerTousLesPaniersSiPlusieursOuverts() {
  const paniers = await psPage.$$('.bet-body .remove-icon');
  if (paniers.length > 1) {
    console.warn(`🧹 ${paniers.length} bulletins détectés, fermeture de tous.`);
    for (const croix of paniers) {
      try {
        const box = await croix.boundingBox();
        if (box) {
          await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await psPage.waitForTimeout(300); // Petite pause entre chaque clic
        }
      } catch (e) {
        console.warn('⚠️ Erreur fermeture d’un des paniers :', e.message);
      }
    }

    // ✅ Notification facultative (console ou Telegram)
    console.log('🗑️ Tous les bulletins de pari ont été fermés.');
    await sendTelegramMessage('🧹 *Plusieurs bulletins détectés sur PS3838*\nTous les paniers ont été fermés avant le nouveau pari.');
  }
}

async function sendTelegramMessage(message) {
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' }
    );
    console.log('📨 Notification Telegram envoyée.');
  } catch (err) {
    console.warn('⚠️ Erreur envoi Telegram :', err.message);
  }
}


// 🔁 Tentative de recapture automatique après refus
async function reessayerPari(match, team, soldeAvant) {
  try {
	await axios.post('http://127.0.0.1:5001/ps3838/fermer-panier');
    const response = await axios.post('http://127.0.0.1:5001/ps3838/arret-scraping-et-pari', {
      match,
      team,
      odds: 0,
      stake: 0
    });

    const { newOdds, maxBet, soldeActuel } = response.data;

    const joueurAffiche = await psPage.$eval('.bet-body .selection.title-tooltip', el => el.innerText.trim()).catch(() => null);
	let joueurNettoye = joueurAffiche?.replace(/\s*\(.*?\)\s*/g, '').trim();
	let matchValide = false;

	if (joueurNettoye) {
	  try {
		const resp = await axios.post('http://127.0.0.1:8000/match', {
		  new_event: team,
		  existing_events: [joueurNettoye]
		});
		const score = resp.data.score;
		console.log(`🔍 Score NLP entre "${team}" et "${joueurNettoye}" : ${score}`);
		if (resp.data.match && score >= 90) {
		  matchValide = true;
		} else {
		  console.warn(`❌ Joueur dans le panier incorrect : "${joueurNettoye}" vs "${team}"`);
		}
	  } catch (e) {
		console.warn('⚠️ Erreur NLP dans reessayerPari() :', e.message);
	  }
	}

	if (!matchValide) {
	  console.warn('🚫 Abandon relance : joueur incorrect.');
	  return;
	}

	let altText = '';
	try {
	  const element = await psPage.$('.bet-extra-info.title-tooltip');
	  if (element) {
		altText = await element.getAttribute('alt') || '';
		console.log(`🔍 Détail brut du champ alt : [${altText}]`);
	  } else {
		console.warn('⚠️ Élément .bet-extra-info.title-tooltip introuvable.');
	  }
	} catch (e) {
	  console.warn('⚠️ Exception lors de la lecture du champ alt :', e.message);
	}

    const isMatchBet = altText.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes('money line - match');

    // 🔁 Surveillance temps réel toutes les 0.25s après clic initial
	const relancePayload = {
	  match,
	  team,
	  joueurAffiche: joueurAffiche || '',
	  odds: newOdds,
	  maxBet,
	  solde: soldeActuel,
	  matchType: isMatchBet ? 'match' : 'autre',
	  pariplace: false,
	  source: 'PS3838'
	};

	let relanceEnvoyée = false;

	const intervalRelance = setInterval(async () => {
	  try {
		// Vérifie si le solde a diminué entre temps
		const soldeRes = await axios.get('http://127.0.0.1:5001/solde');
		const soldeActuelVerif = parseFloat(soldeRes.data.balance);

		if (soldeActuelVerif < soldeAvant) {
		  clearInterval(intervalRelance);
		  console.log(`✅ Solde diminué, pari probablement pris automatiquement (${soldeActuelVerif} < ${soldeAvant})`);
		  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			match,
			bookmaker: 'PS3838',
			succes: true,
			nouveauSolde: soldeActuelVerif
		  });
		  return;
		}

		// Sinon, continue à envoyer les données
		await axios.post('http://127.0.0.1:3000/relance-arbitrage', relancePayload);
		console.log('📡 Relance arbitrage PS3838 envoyée');
		relanceEnvoyée = true;

	  } catch (e) {
		console.warn('⚠️ Erreur relance PS3838 :', e.message);
	  }
	}, 250);


  } catch (err) {
    console.error('❌ Erreur dans reessayerPari() :', err.message);
  }
}


const SELECTOR_SOLDE = 'div.balance span.total';

// Route pour donner le solde actuel
app.get('/solde', (req, res) => {
  res.json({ balance: soldeActuel });
});

// Route pour recevoir une action
app.post('/action', async (req, res) => {
  const { action } = req.body;
  console.log(`📥 Action reçue : ${action}`);

  if (action === 'pause') {
    botActive = false;
    // Ici tu ajoutes le code pour mettre ton scraping en pause
  } else if (action === 'disconnect') {
    // Ici tu ajoutes ton code pour se déconnecter du site bookmaker
  } else if (action === 'reconnect') {
    // Ici tu ajoutes ton code pour se reconnecter au bookmaker
  } else if (action === 'resume') {
    botActive = true;
    // Ici tu reprends le scraping
  }

  res.sendStatus(200);
});

app.get('/ready', (req, res) => {
  if (connected) {
    res.send('READY');
  } else {
    res.status(503).send('NOT READY');
  }
});
app.get('/status', (req, res) => res.send('OK'));

// Lance le serveur API du bot
app.listen(5001, () => {
  console.log('🚀 API du bot PS3838 ouverte sur le port 5001');
});

// 🚀 Route spéciale pour arrêter scraping, cliquer sur cote, entrer la mise et lire la vraie cote affichée
app.post('/ps3838/arret-scraping-et-pari', async (req, res) => {
	await betMutex.runExclusive(async () => {
	  const { match, team, odds, stake } = req.body;
	  console.log(`📥 Instruction de pari reçue : ${stake}€ sur ${team} @${odds} pour ${match}`);
	  // Refuse toute nouvelle instruction pendant qu'on traite un pari
		botActive = false;
		// Sinon, on bloque le scraping immédiatement
	   // 🆕 Ajouté : Remet la page tout en haut pour éviter que les boutons soient hors écran
	  await psPage.evaluate(() => {
		window.scrollTo(0, 0);
	  });
	  // 🧼 Vérifie et ferme les paniers multiples avant de continuer
	  await fermerTousLesPaniersSiPlusieursOuverts();
	  
	  try {
		const matchs = await psPage.$$('.odds-container-live .events tr.mkline');
		let matchTrouve = null;
		let homeTeamFull = "";
		let awayTeamFull = "";

		for (const item of matchs) {
		  const teamsCell = await item.$('td.col-name');
		  const homeTeam = (await teamsCell?.getAttribute('data-home-team') || "").toLowerCase().replace(/\s+/g, ' ').trim();
		  const awayTeam = (await teamsCell?.getAttribute('data-away-team') || "").toLowerCase().replace(/\s+/g, ' ').trim();

		  if (!homeTeam || !awayTeam) continue;

		  const matchFormate = `${homeTeam} vs ${awayTeam}`;
		  const matchRecherche = match.toLowerCase().replace(/\s+/g, ' ').trim();

		  if (matchFormate.includes(matchRecherche) || matchRecherche.includes(matchFormate)) {
			matchTrouve = item;
			homeTeamFull = homeTeam; // <-- ON STOCKE les équipes trouvées directement
			awayTeamFull = awayTeam;
			break;
		  }
		}


		if (!matchTrouve) {
		  console.warn('❌ Match pas trouvé sur PS3838.');
		  res.status(404).send('Match non trouvé');
		  return;
		}
		
		console.log(`🏠 HomeTeam trouvé: ${homeTeamFull}`);
		console.log(`🆚 AwayTeam trouvé: ${awayTeamFull}`);
		console.log(`🎯 Team demandée: ${team}`);

		// Clique directement sur la cote correspondante (pas besoin de vérifier l'odds ici)
		// 📥 On récupère les 2 boutons de cote du premier "td.col-1x2.main-1x2" dans CE tr
		const premierBlocCote = await matchTrouve.$('td.col-1x2.main-1x2');
		if (!premierBlocCote) {
		  console.warn('❌ Pas de bloc de cote 1x2 trouvé pour ce match.');
		  return res.status(404).send('Bloc de cote 1x2 non trouvé');
		}

		const boutonsCotes = await premierBlocCote.$$('a');
		if (boutonsCotes.length < 2) {
		  console.warn('❌ Pas assez de boutons de cote disponibles.');
		  return res.status(404).send('Pas assez de cotes pour cliquer');
		}

		// 🧹 On nettoie les noms pour éviter des erreurs d'espaces/accents
		const teamNettoyee = team.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim();
		const homeTeamClean = homeTeamFull.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim();
		const awayTeamClean = awayTeamFull.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ').trim();


		// 🏹 Déjà calculé plus haut dans la fonction :
		// const teamNettoyee = team.toLowerCase()…
		// const homeTeamClean  = homeTeamFull.normalize(…)…
		// const awayTeamClean  = awayTeamFull.normalize(…)…

		// On choisit le bon bouton
		let boutonCote = null;
		for (const btn of boutonsCotes) {
		  const teamType = await btn.getAttribute('data-team-type');
		  if (
			(teamType === '0' && homeTeamClean === teamNettoyee) ||
			(teamType === '1' && awayTeamClean === teamNettoyee)
		  ) {
			boutonCote = btn;
			break;
		  }
		}


		if (boutonCote) {
		  // 1) Scroll via evaluate pour éviter le "not attached"
		  try {
			// Nouvelle version (à mettre à la place)
			await boutonCote.evaluate(el =>
			  el.scrollIntoView({ block: 'center', inline: 'center' })
			);

		  } catch (e) {
			console.warn('⚠️ Échec du scroll direct, relocalisation du bouton…');
			// On relocalise depuis le parent matchTrouve
			const refreshedBloc = await matchTrouve.$('td.col-1x2.main-1x2');
			const refreshedBoutons = await refreshedBloc.$$('a');
			boutonCote = (homeTeamClean === teamNettoyee)
			  ? refreshedBoutons[0]
			  : refreshedBoutons[1];
			// ← nouvelle version
			await boutonCote.evaluate(el =>
			  el.scrollIntoView({ block: 'center', inline: 'center' })
			);

		  }

		  // 2) On récupère sa position et on clique
		 // … après avoir calculé `boutonCote`
			const box = await boutonCote.boundingBox();
			if (box) {
			  await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			  await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			  console.log('✅ Cote cliquée.');

			  // ←——— Gérer l’alerte “Sélection non disponible”
			  const alert = await psPage.$('div.AlertComponent.confirm-alert');
			  if (alert) {
				const okBtn = await alert.$('button.okBtn');
				if (okBtn) {
				  await okBtn.click();
				  console.log('⚠️ Alerte “Sélection non disponible” fermée.');
				}
				botActive = true;
				return res.status(409).send('Sélection non disponible');
			  }

			  console.log(`🎯 Clic sur ${teamNettoyee === homeTeamClean ? '🏠 Domicile' : '🛫 Extérieur'} (${team})`);
			} else {
			  console.warn('⚠️ Impossible de récupérer la position du bouton de cote.');
			}

		} else {
		  console.warn('⚠️ Aucun bouton de cote trouvé pour cette équipe.');
		}



		
		// 🌀 Tentatives de détection du panier avec 3 essais max
		let panierTrouve = false;
		for (let tentative = 0; tentative < 3; tentative++) {
		  try {
			await psPage.waitForSelector('.bet-body', { timeout: 1000 }); // Attend 1s
			panierTrouve = true;
			console.log(`✅ Panier détecté après ${tentative + 1} tentative(s).`);
			await psPage.waitForTimeout(20); // ⏳ Laisse 0.5s pour charger champ mise
			break;
		  } catch (err) {
			console.warn(`⚠️ Panier non détecté à la tentative ${tentative + 1}. Réessai...`);
			const boxRetry = await boutonCote.boundingBox();
			if (boxRetry) {
			  await psPage.mouse.move(boxRetry.x + boxRetry.width / 2, boxRetry.y + boxRetry.height / 2);
			  await psPage.mouse.click(boxRetry.x + boxRetry.width / 2, boxRetry.y + boxRetry.height / 2);
			  console.log('🖱️ Nouveau clic sur la cote pour forcer le panier.');
			}
		  }
		}

		// 2️⃣ Recherche du champ de mise dans le panier chargé
		// 🔍 Lit la cote affichée dans le panier
		// 🔍 Attendre un peu que la cote s’affiche
		await psPage
		  .waitForSelector('.bet-body .odds-info .odds', { timeout: 3000 })
		  .catch(() => { /* si timeout, on passe quand même à la vérif */ });

		const el = await psPage.$('.bet-body .odds-info .odds');
		// 🔍 Vérifie le nom affiché dans le panier (champ sélection)
		let joueurAffiche = null;
		try {
		  joueurAffiche = await psPage.$eval('.bet-body .selection.title-tooltip', el => el.innerText.trim());
		  joueurAffiche = joueurAffiche.replace(/\s*\(.*?\)\s*/g, '').trim();
		  console.log(`🧐 Joueur affiché dans le panier : ${joueurAffiche}`);
		} catch (e) {
		  console.warn('⚠️ Impossible de lire le joueur sélectionné dans le panier.');
		}
		if (!joueurAffiche) {
		  console.warn('❌ Aucun joueur détecté dans le panier.');
		  return res.status(400).json({ error: 'player_not_found' });
		}


		// 🔍 NLP : vérifier si c’est bien le joueur demandé
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
			  console.warn(`❌ Le joueur affiché (${joueurAffiche}) ne correspond pas à la demande (${team})`);
			}
		  } catch (e) {
			console.warn('⚠️ Erreur lors de la requête NLP de vérification panier :', e.message);
		  }
		}

		if (!matchValide) {
		 
		  botActive = true;
		  return res.status(400).json({ error: 'player_mismatch' });
		}
		
		// 🔍 Vérifie que le pari est bien sur le match entier (et pas un set)
		let isMatchBet = false;
		try {
		  const infoElement = await psPage.$('.bet-extra-info.title-tooltip');
		  if (infoElement) {
			const altText = await infoElement.getAttribute('alt');
			console.log(`🔍 Détail brut du champ alt : [${altText}]`);

			const altTextClean = altText?.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim() || '';
			console.log(`🧼 Nettoyage pour comparaison : [${altTextClean}]`);

			if (altTextClean.includes('money line - match')) {
			  isMatchBet = true;
			} else {
			  console.warn(`❌ Le champ alt ne contient pas 'money line - match' (après nettoyage).`);
			}
		  } else {
			console.warn('⚠️ Élément .bet-extra-info.title-tooltip introuvable.');
		  }
		} catch (e) {
		  console.warn('⚠️ Exception lors de la lecture du champ alt :', e.message);
		}


		if (!isMatchBet) {
		  console.warn('❌ Le pari détecté ne porte pas sur le match entier.');
		  botActive = true;
		  return res.status(400).json({ error: 'not_match_bet' });
		}


		// dans bot_ps3838.js
		if (!el) {
		  botActive = true;
		  console.warn('⚠️ Impossible de lire la cote : sélecteur introuvable');
		  return res.status(404).json({ error: 'odds_not_found' });
		}

		const coteFinale = (await el.innerText()).trim();
		console.log(`🔍 Cote finale lue après saisie : ${coteFinale}`);

		// 💰 Lit le Max bet affiché
		let maxBetTexte = await psPage.$eval('.bet-body .max-bet .max-value', el => el.innerText.trim());
		console.log(`💰 Max bet brut détecté : ${maxBetTexte}`);

		// ✅ Convertit proprement le Max bet en nombre
		let maxBetNombre = null;
		if (maxBetTexte && /\d/.test(maxBetTexte)) {
		  const cleaned = maxBetTexte.replace(/,/g, '').replace(/[^\d.]/g, '');
		  maxBetNombre = parseFloat(cleaned);
		}
		console.log(`💰 Max bet transformé en nombre : ${maxBetNombre}`);


		// 🔍 Lire dynamiquement le solde actuel (EUR)
		let soldeActuelEUR = null;
		try {
		  const soldeTexte = await psPage.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
		  soldeActuelEUR = parseFloat(soldeTexte.replace(',', '.').replace(/[^\d.]/g, ''));
		  console.log(`💶 Solde détecté : ${soldeActuelEUR} EUR`);
		} catch (e) {
		  console.warn('⚠️ Solde non détecté :', e.message);
		}

		// 🚀 Renvoie la cote finale, max bet ET solde actuel
		res.json({ 
		  newOdds: parseFloat(coteFinale),
		  maxBet: maxBetNombre,
		  soldeActuel: soldeActuelEUR
		});


	  } catch (err) {
		console.error('❌ Erreur durant traitement pari:', err.message);
		res.status(500).send('Erreur traitement pari');
	  } finally {
		botActive = true; // remet scraping actif
	  }
	});
});

app.post('/ps3838/verifier-cote-panier', async (req, res) => {
  const coteAttendue = parseFloat(req.body.cote);

  try {
    const coteBrute = await psPage.$eval('.odds-info-container .odds', el => el.innerText.trim().replace(',', '.'));
    const coteNum = parseFloat(coteBrute);

    const coteArrondie = Math.round(coteNum * 1000) / 1000;
    const coteInitiale = Math.round(coteAttendue * 1000) / 1000;
	console.log(`🔍 Vérification cote PS3838 : actuelle = ${coteArrondie}, attendue = ${coteInitiale}`);

    return res.json({ valide: coteArrondie >= coteInitiale });
  } catch (err) {
    console.error('❌ Erreur lecture cote panier PS3838 :', err.message);
    return res.json({ valide: false });
  }
});


// ✅ Route spéciale pour écrire uniquement la mise finale (en EUR)
app.post('/ps3838/ecrire-mise-final', async (req, res) => {
	await betMutex.runExclusive(async () => {
	  let clicPariEffectue = false;
	  let soldeAvant;
	  const { stake, match, team, odds } = req.body;
	  console.log(`📥 Mise finale reçue à écrire (PS3838) : ${stake} EUR`);

	  if (!psPage) {
		console.warn('❌ Aucune page active (PS3838).');
		await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
		  match: req.body.match,
		  bookmaker: 'PS3838',
		  succes: false,
		  nouveauSolde: soldeAvant
		});

		await sendTelegramMessage(
			`❌ *erreur chargement page sur PS3838*\n` +
			`*Mise* : ${stake} EUR\n` +
			`_Aucune zone de saisie détectée dans le panier._`
		  );
		return res.status(400).send('Page inactive');
		
	  }
	  
	  let placed = false;
	   
	  try {
		const finalStake = stake.toFixed(2); // On force le format XX.XX
		console.log(`💶 Mise à écrire dans le champ (PS3838) : ${finalStake} EUR`);

		// 🖊️ Remplissage du champ de mise
		const input = await psPage.$('.bet-body input.input-stake.stake.risk');
		if (!input) {
		  console.warn('❌ Champ de mise introuvable.');
		  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			  match: req.body.match,
			  bookmaker: 'PS3838',
			  succes: false,
			  nouveauSolde: soldeAvant
			});

		  await sendTelegramMessage(
			`❌ *Champ de mise introuvable sur PS3838*\n` +
			`*Mise* : ${stake} EUR\n` +
			`_Aucune zone de saisie détectée dans le panier._`
		  );
		  return res.status(404).send('Champ de mise introuvable');
		}

		await input.fill('');
		await input.type(finalStake); // écriture instantanée, sans délai
		console.log(`✅ Mise saisie dans le champ (PS3838) : ${finalStake} EUR`);
		
		// ✅ Tentatives de clic sur "Placer Pari" + vérification du solde avant/après
		try {
		  // 1) lire le solde avant le clic
		  const rawSoldeAvant = await psPage.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
		  soldeAvant = parseFloat(rawSoldeAvant.replace(',', '.').replace(/[^\d.]/g, '')); 
		  console.log(`💰 Solde avant placement : ${soldeAvant} EUR`);
		  
		  for (let tentative = 1; tentative <= 3; tentative++) {
			await psPage.waitForSelector('button.place-bet-btn', {
			  state: 'visible',   // on attend qu'il soit rendu à l'écran
			  timeout: 5000       // optionnel : lève une erreur si au bout de 5 s il n'apparaît pas
			});
			const boutonPlacer = await psPage.$('button.place-bet-btn');
			if (!boutonPlacer) {
			  console.warn(`⚠️ Bouton "Placer Pari" introuvable, tentative ${tentative}`);
			  await psPage.waitForTimeout(500);
			  continue;
			}

			 // scroll + clic "haut-niveau"
			await boutonPlacer.scrollIntoViewIfNeeded();
			await boutonPlacer.click({ force: true, timeout: 5000 });
			console.log(`🖱️ Tentative ${tentative}: clic sur "Placer Pari"`);

			// attente pour mise à jour du solde
			await psPage.waitForTimeout(1500);

			// 2) relire le solde après le clic
			const rawSoldeApres = await psPage.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
			const soldeApres = parseFloat(rawSoldeApres.replace(',', '.').replace(/[^\d.]/g, ''));
			console.log(`💰 Solde après tentative ${tentative} : ${soldeApres} EUR`);

			// 3) si le solde a diminué, on considère que le pari a bien été placé
			if (soldeApres < soldeAvant) {
			  console.log(`✅ Pari validé (solde est passé de ${soldeAvant} à ${soldeApres})`);
			  placed = true;
			  clicPariEffectue = true;
			  break;
			} else {
			  console.warn(`⚠️ Solde inchangé (${soldeApres}), nouvelle tentative…`);
			}
		  }

		  if (!placed) {
			console.error('❌ Échec du placement automatique après 3 tentatives.');
			await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
			  match: req.body.match,
			  bookmaker: 'PS3838',
			  succes: false,
			  nouveauSolde: soldeAvant
			});

			// Notification Telegram pour pari manuel
			await sendTelegramMessage(
			  `⚠️ _Échec du placement automatique_\n` +
			  `*Match* : ${req.body.match}\n` +
			  `*Équipe* : ${req.body.team}\n` +
			  `*Côte* : ${req.body.odds}\n` +
			  `*Mise* : ${finalStake} EUR\n\n` +
			  `_Merci de placer manuellement ce pari._`
			);
		  }
		} catch (err) {
		  console.error('❌ Erreur lors du placement du pari :', err.message);
		}


		
		// 🗑️ Clique sur le bouton croix pour fermer le pari
		if (placed) {
		  const boutonCroix = await psPage.$('.bet-body .remove-icon');
		  if (boutonCroix) {
			const box = await boutonCroix.boundingBox();
			if (box) {
			  await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			  await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			  console.log('Pari fermé en cliquant sur la croix (PS3838).');
			}
		  }
		}
		// en dehors de if (placed), même si le pari semble raté, on vérifie dans 30s
		setTimeout(async () => {
		  try {
			const rawSoldeFinal = await psPage.$eval(SELECTOR_SOLDE, el => el.innerText.trim());
			const soldeFinal = parseFloat(rawSoldeFinal.replace(',', '.').replace(/[^\d.]/g, ''));
			console.log(`🕒 Vérification post-pari : Solde = ${soldeFinal} EUR (avant : ${soldeAvant} EUR)`);

			if (soldeFinal < soldeAvant && clicPariEffectue) {
			  console.log('✅ Pari validé a posteriori (solde a baissé après clic confirmé).');
			  await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
				match,
				bookmaker: 'PS3838',
				succes: true,
				nouveauSolde: soldeFinal
			  });
			  console.log('✅ Retour pari envoyé après 30s (PS3838)');
			} else {
			  const variation = (soldeFinal - soldeAvant).toFixed(2);
			  console.warn(`❌ Solde inchangé ou clic manqué → pari probablement ignoré ou refusé.`);

			  await sendTelegramMessage(
				`❌ *Pari échoué ou ignoré (PS3838)*\n` +
				`📉 Solde AVANT : ${soldeAvant}€\n` +
				`📈 Solde APRÈS : ${soldeFinal}€\n` +
				`_Nouvelle tentative de recapture..._`
			  );

			  await reessayerPari(req.body.match, req.body.team, soldeFinal);
			}
		  } catch (err) {
			console.error('❌ Erreur post-pari dans setTimeout :', err.message);
		  }
		}, 30000);




		res.sendStatus(200);
	  } catch (err) {
		console.error('❌ Erreur lors de la saisie de la mise finale (PS3838) :', err.message);
		await axios.post('http://127.0.0.1:3000/arbitrage/retour-pari', {
		  match: req.body.match,
		  bookmaker: 'PS3838',
		  succes: false,
		  nouveauSolde: soldeAvant
		});

		await sendTelegramMessage(
			`❌ *Erreur critique dans la saisie de la mise finale sur PS3838*\n` +
			`*Mise reçue* : ${stake} EUR\n\n` +
			`_Message d'erreur : ${err.message}_`
		  );
		res.status(500).send('Erreur saisie mise');
	  } finally {
		botActive = true; // 🔁 Reprise du scraping
	  }
	});
});

app.post('/ps3838/fermer-panier', async (req, res) => {
	await betMutex.runExclusive(async () => {

	  try {
		console.log('🛑 Fermeture forcée du panier PS3838');
		const boutonCroix = await psPage.$('div.remove-icon'); // ✅ pas page mais psPage
		if (boutonCroix) {
		  const box = await boutonCroix.boundingBox();
		  if (box) {
			await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			console.log('✅ Panier PS3838 fermé.');
		  }
		}
		res.sendStatus(200);
	  } catch (e) {
		console.error('❌ Erreur fermeture panier PS3838:', e.message);
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
			'Referer': 'https://www.ps898989.com/fr/',
		}
	});

	const page = await context.newPage();

	await patchPageForHumanBehavior(page);
	await simulateHumanBehavior(page);

	console.log('🌍 Navigation directe vers PS3838...');
	await page.goto('https://www.ps898989.com/fr/', { waitUntil: 'load', timeout: 120000 }); // 2 minutes

	psPage = page; // très important

	try {
		await psPage.waitForLoadState('domcontentloaded');
		await psPage.waitForTimeout(12000);

		console.log('🧑‍💻 Remplissage des identifiants PS3838...');
		await psPage.waitForSelector('input[name="loginId"]', { timeout: 10000 });
		await psPage.waitForSelector('input[name="password"]', { timeout: 10000 });

		await psPage.fill('input[name="loginId"]', process.env.PS3838_USERNAME);
		await psPage.fill('input[name="password"]', process.env.PS3838_PASSWORD);

		console.log('🖱️ Clic sur le bouton "Connexion"...');
		const loginBtn = await psPage.waitForSelector('#login', { timeout: 10000 });
		const box = await loginBtn.boundingBox();
		if (box) {
			await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
			await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
			console.log('✅ Connexion PS3838 lancée.');
		} else {
		    console.warn('⚠️ Bouton "Connexion" introuvable.');
		}

		await psPage.waitForTimeout(5000);

		console.log('🎾 Sélection du sport "Tennis"...');
		const tennisBtn = await psPage.$('.SportMenuItemComponent .sport-name:has-text("Tennis")');
		if (tennisBtn) {
			const box = await tennisBtn.boundingBox();
			if (box) {
				await psPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await psPage.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
				console.log('✅ Sport "Tennis" sélectionné.');
				await psPage.waitForTimeout(3000);
			}
		}
		
		connected = true;

		// 🎯 Début du SCRAPING
		const fs = require('fs');
		const path = require('path');

		const outputFile = path.join(__dirname, 'ps_tennis_moneylines.json');
		let isScraping = false;

		// 🎯 Début du SCRAPING
		setInterval(async () => {
		  if (isScraping) return;
		  isScraping = true;

		  try {
			const now = new Date().toISOString();
			const tennisMatches = [];

			// 1) On récupère toutes les lignes "live"
			const rows = await psPage.$$('.odds-container-live .events tr.mkline');

			// 2) On filtre celles qui contiennent un span .period-name avec "(Match)"
			const matchRows = [];
			for (const row of rows) {
			  const spans = await row.$$('.grading-unit-container .period-name');
			  if (spans.length === 0) continue;                      // pas de label => skip
			  const label = (await spans[0].innerText()).trim();
			  if (label.includes('(Match)')) matchRows.push(row);
			}

			// 3) On construit le tableau des matchs net
			for (const row of matchRows) {
			  const teamsCell = await row.$('td.col-name');
			  const home = await teamsCell.getAttribute('data-home-team');
			  const away = await teamsCell.getAttribute('data-away-team');
			  const oddsContainer = await row.$('td.col-1x2.main-1x2');
			  if (!oddsContainer) continue;

			  // Vérifie s'il y a 2 cadenas
			  // Vérifie qu’il y a bien 2 cotes actives (sinon match bloqué)
			  // Vérifie si les cotes sont cliquables (contenu numérique)
		   	  const oddButtons = await oddsContainer.$$('a');
			  const validOdds = [];

			  for (const btn of oddButtons) {
			    const isHidden = await btn.evaluate(el => el.offsetParent === null); // détecte si l'élément est masqué
			    const span = await btn.$('span');
			    const text = span ? (await span.innerText()).trim() : '';

			    if (!isHidden && /^\d+(\.\d+)?$/.test(text)) {
			   	  validOdds.push(text);
			    }
			  }

			  if (validOdds.length < 2) {
			    continue;
			  }




			  // Vérifie qu'on est bien dans un marché moneyline
			  const periodLabel = await row.$eval('.period-name', span => span.innerText.trim()).catch(() => '');
			  if (!periodLabel.includes('(Match)')) {
			    console.log(`⏭️ Marché ignoré : ${home} vs ${away} n'est pas un match entier`);
			    continue;
		      }

			  // Récupère les cotes visibles
			  const odds = await oddsContainer.$$eval('a span', spans =>
			    spans.map(span => span.innerText.trim()).filter(text => text !== '')
			  );

			  if (home && away && odds.length === 2) {
			    tennisMatches.push({
				  match: `${home} vs ${away}`,
				  odds: { [home]: odds[0], [away]: odds[1] }
			    });
			  } else {
			    console.log(`⚠️ Match ignoré (cotes incomplètes) : ${home} vs ${away}`);
			  }


			}

			// 4) On écrit le JSON
			fs.writeFileSync(outputFile, JSON.stringify({ Tennis: tennisMatches }, null, 2));
			console.log(`💾 ${tennisMatches.length} matchs mis à jour - ${now}`);


		  } catch (err) {
			console.warn('⚠️ Erreur scraping:', err.message);
		  } finally {
			isScraping = false;
		  }
		}, 250);

	} catch (error) {
		console.error('❌ Erreur durant la connexion ou le scraping :', error.message);
	}
})();

