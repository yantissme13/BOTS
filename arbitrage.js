// 📂 Détecteur d'Arbitrage Live avec Tableau + Alertes Telegram
// Fermeture propre si process terminé
process.on('SIGINT', () => {
  console.log('🛑 arbitrage.js reçu SIGINT, fermeture propre.');
  process.exit();
});
process.on('SIGTERM', () => {
  console.log('🛑 arbitrage.js reçu SIGTERM, fermeture propre.');
  process.exit();
});

const fs = require('fs');
const axios = require('axios');
const { Mutex } = require('async-mutex');
// Un mutex pour séquencer les envois d’arbitrages
const sendMutex = new Mutex();
const express = require('express');
const app = express();
app.use(express.json());

const statutBots = {
  PS3838: null,
  SBOBET: null
};

const fichierFusion = './evenements_fusionnes_par_sport.json';
const TELEGRAM_BOT_TOKEN = '7569528340:AAHShvC_2FUQaIrzQMK8kjchFAsE3Balt1U';
const TELEGRAM_CHAT_ID = '-1002426777212';

const opportunitesActives = {}; // { id: { profit: X, dernierProfitAlerte: Y, match, bets } }

let enAttenteDeRéponse = false;
let dernierEnvoiAuxBots = 0;
let verrouPariEnCours = false;
let relanceActive = false;


function estFinImminente(scoreComplet) {
  if (!scoreComplet || typeof scoreComplet !== 'string') return false;

  try {
    const sets = scoreComplet.match(/\d+\/\d+/g) || [];
    if (sets.length === 0) return false;

    let setsGagnesJ1 = 0;
    let setsGagnesJ2 = 0;

    // Analyser les sets déjà terminés (sauf le dernier)
    for (const set of sets.slice(0, -1)) {
      const [j1, j2] = set.split('/').map(Number);
      if (j1 >= 6 && j1 - j2 >= 2) setsGagnesJ1++;
      else if (j2 >= 6 && j2 - j1 >= 2) setsGagnesJ2++;
    }

    // Dernier set en cours
    const dernierSet = sets[sets.length - 1];
    const [gamesJ1, gamesJ2] = dernierSet.split('/').map(Number);

    // Si un joueur a déjà 2 sets gagnés => match terminé
    if (setsGagnesJ1 >= 2 || setsGagnesJ2 >= 2) return true;

    // Si un joueur a déjà 1 set gagné et est sur le point de gagner le 2e
    if (
      (setsGagnesJ1 === 1 && (
        (gamesJ1 === 5 && gamesJ2 <= 3) ||
        (gamesJ1 === 6 && gamesJ2 <= 4) ||
        (gamesJ1 === 7 && gamesJ2 <= 5)
      )) ||
      (setsGagnesJ2 === 1 && (
        (gamesJ2 === 5 && gamesJ1 <= 3) ||
        (gamesJ2 === 6 && gamesJ1 <= 4) ||
        (gamesJ2 === 7 && gamesJ1 <= 5)
      ))
    ) {
      return true; // Fin imminente possible dès ce set
    }

    return false;
  } catch (e) {
    console.warn('⚠️ Erreur parsing scoreComplet :', e.message);
    return false;
  }
}


function calculArbitrage(cote1, cote2) {
  const inv1 = 1 / cote1;
  const inv2 = 1 / cote2;
  const total = inv1 + inv2;
  return {
    isArbitrage: total < 1,
    profit: +(100 * (1 - total)).toFixed(4)
  };
}

async function sendTelegramAlert(match, arbitrage, succes = false, relance = false) {
  const TOTAL_AMOUNT = arbitrage.bets.reduce((acc, bet) => acc + (bet.stake || 0), 0) || 20;
  let message = '';
  const isPerte = arbitrage.percentage < 0;
  const perteEuro = arbitrage.perteEuro || ((Math.abs(arbitrage.percentage) / 100) * TOTAL_AMOUNT).toFixed(2);

  if (succes) {
    if (isPerte) {
		message += `🔴 *Pari de Limitation de Pertes*`;
		if (relance) message += ` (après relance)`;
		message += `\n\n💀 *Perte estimée :* *${perteEuro}€* (${arbitrage.percentage}%)\n\n`;
	  } else {
		if (relance) {
		  message += `🔁🟢 *Arbitrage Récupéré après Relance !*\n\n`;
		  message += `♻️ *Profit confirmé malgré changement de cotes.*\n`;
		} else {
		  message += `🟢 *Paris Exécutés avec Succès !*\n\n`;
		}

		message += `✅ *Arbitrage Confirmé* après prise de pari.\n`;
		message += `💰 *Profit Final Observé :* *${arbitrage.percentage}%*\n`;

		const profitEuro = ((arbitrage.percentage / 100) * TOTAL_AMOUNT).toFixed(2);
		message += `💵 *Gain estimé :* *${profitEuro}€*\n\n`;
		message += `🎯 *Mise totale engagée :* *${TOTAL_AMOUNT.toFixed(2)}€*\n\n`;
	  }
	  
    let soldeTotal = 0;
    let liquiditeTotale = 0;

    arbitrage.bets.forEach(bet => {
      soldeTotal += bet.solde || 0;
      liquiditeTotale += bet.liquidite || 0;
    });

    message += `💼 *Budget total disponible* : *${soldeTotal.toFixed(2)}€*\n`;
    message += `🌊 *Liquidité totale* : *${liquiditeTotale.toFixed(2)}€*\n\n`;
	
	arbitrage.bets.forEach(bet => {
	  message += `🌊 *Liquidité ${bet.bookmaker}* : *${(bet.liquidite ?? 0).toFixed(2)}€*\n`;
	});
	message += `\n`;


    message += `📊 *Mises finales optimales :*\n`;
    arbitrage.bets.forEach(bet => {
      message += `🏦 *${bet.bookmaker}* - *${bet.team}* | Cote : *${bet.odds}* | Mise : *${bet.stake.toFixed(2)}€*\n`;
	  if (bet.solde_apres !== undefined && bet.solde !== undefined && bet.stake !== undefined) {
		  const pourcentageUtilisé = ((bet.stake / bet.solde) * 100).toFixed(1);
		  message += `🔻 *Solde après pari :* *${bet.solde_apres.toFixed(2)}€*\n`;
		  message += `📉 *% du solde utilisé :* *${pourcentageUtilisé}%*\n`;
		}
    });

  } else {
    message += `❌ *Échec du Placement Automatique !*\n\n`;
	message += `⚠️ Une erreur est survenue lors de la saisie des mises.\n`;
	message += `📅 *Match :* ${match.match}\n`;
	message += `🎯 *Profit Visé :* *${arbitrage.percentage}%*\n`;

	const profitEuro = ((arbitrage.percentage / 100) * TOTAL_AMOUNT).toFixed(2);
	message += `💵 *Gain estimé :* *${profitEuro}€*\n\n`;
	message += `🎯 *Mise totale engagée :* *${TOTAL_AMOUNT.toFixed(2)}€*\n\n`;
	const totalProb = arbitrage.bets.reduce((acc, bet) => acc + (1 / bet.odds), 0);

	let soldeTotal = 0;
	let liquiditeTotale = 0;
	arbitrage.bets.forEach(bet => {
	soldeTotal += bet.solde || 0;
	liquiditeTotale += bet.liquidite || 0;
	});

	message += `💼 *Budget total disponible* : *${soldeTotal.toFixed(2)}€*\n`;
	message += `🌊 *Liquidité totale* : *${liquiditeTotale.toFixed(2)}€*\n\n`;

	arbitrage.bets.forEach(bet => {
		message += `🌊 *Liquidité ${bet.bookmaker}* : *${(bet.liquidite ?? 0).toFixed(2)}€*\n`;
	});
	message += `\n`;

    message += `📊 *Mises optimales (pour ${TOTAL_AMOUNT}€) :*\n`;
    arbitrage.bets.forEach(bet => {
      const mise = (TOTAL_AMOUNT * (1 / bet.odds)) / totalProb;
      message += `🏦 *${bet.bookmaker}* - *${bet.team}* | Cote : *${bet.odds}* | Mise : *${mise.toFixed(2)}€*\n`;
    });
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log('📨 Alerte Telegram envoyée.');
  } catch (err) {
    console.warn('⚠️ Erreur envoi Telegram :', err.message);
  }
}


function lireJSON(filepath) {
  try {
    const contenu = fs.readFileSync(filepath, 'utf-8');
    if (contenu.trim().endsWith('}')) {
      return JSON.parse(contenu);
    }
    throw new Error('JSON incomplet');
  } catch (e) {
    console.warn('⚠️ Lecture reportée:', e.message);
    return null;
  }
}

const envoyerAuxBots = async (match, sport, arbitrage, relance = false) => {

	let newOddsPS = null, soldePS = null, maxBetPS = null;
	let newOddsSBO = null, soldeSBO = null, maxBetSBO = null;

	await sendMutex.runExclusive(async () => {
	  console.log('🚀 Envoi de l’opportunité aux deux bots...');
	  // ⏳ Vérification si on attend encore une réponse ou si 10s ne sont pas écoulées
	  const maintenant = Date.now();
	  if (verrouPariEnCours) {
		console.log('🔒 Un pari est déjà en cours de finalisation. Aucun nouvel arbitrage envoyé.');
		return;
	  }
	  if (enAttenteDeRéponse && (maintenant - dernierEnvoiAuxBots < 10000)) {
		console.log('⏳ En attente de réponses des bots. Pas d’envoi pour le moment.');
		return;
	  }


	  // ✅ Sinon on peut envoyer
	  enAttenteDeRéponse = true;
	  dernierEnvoiAuxBots = maintenant;
	  // ⏱️ Sécurité : forcer le reset après 15 secondes si un bot ne répond jamais
		setTimeout(() => {
		  if (enAttenteDeRéponse) {
			console.warn('⏳ Timeout de sécurité atteint. Réinitialisation de enAttenteDeRéponse.');
			enAttenteDeRéponse = false;
			verrouPariEnCours = false;
		  }
		}, 15000); // 15 secondes


	  const bets = arbitrage.bets;


	  let psBet = bets.find(b => b.bookmaker === 'PS3838');
	  let sbobetBet = bets.find(b => b.bookmaker === 'SBOBET');


	  try {
		verrouPariEnCours = true; // 🔒 On bloque l'envoi de nouveaux arbitrages
		const psPromise = new Promise(resolve => setTimeout(() => {
		  axios.post('http://localhost:5001/ps3838/arret-scraping-et-pari', {
			match: match.match,
			team: psBet.team,
			odds: psBet.odds,
			stake: 0
		  }).then(resolve).catch(resolve); // pour ne pas bloquer en cas d’erreur
		}, 4000)); // délai de 4 secondes

		const sbobetPromise = axios.post('http://localhost:5002/sbobet/arret-scraping-et-pari', {
		  match: match.match,
		  team: sbobetBet.team,
		  odds: sbobetBet.odds,
		  stake: 0
		});

		const [psResponse, sbobetResponse] = await Promise.all([psPromise, sbobetPromise]);


	    newOddsPS = Number(psResponse.data.newOdds);
		soldePS = Number(psResponse.data.soldeActuel);
		maxBetPS = Number((psResponse.data.maxBet || 1000).toString().replace(/\s/g, '').replace(',', '.'));

		newOddsSBO = Number(sbobetResponse.data.newOdds);
		soldeSBO = Number(sbobetResponse.data.soldeActuel);
		maxBetSBO = Number((sbobetResponse.data.stakeAtPrice || 1000).toString().replace(/\s/g, '').replace(',', '.'));
		
		if (!newOddsPS || !newOddsSBO || !soldePS || !soldeSBO) {
		  console.warn('⚠️ Valeur nulle détectée dans les données reçues des bots.');
		  await Promise.all([
			axios.post('http://localhost:5001/ps3838/fermer-panier'),
			axios.post('http://localhost:5002/sbobet/fermer-panier')
		  ]);
		  enAttenteDeRéponse = false;
		  verrouPariEnCours = false;
		  console.log('🔓 Verrou pari levé après échec de récupération des données.');
		  return;
		}
		// 🔎 Test spécifique : parier si un joueur a 2 sets ou plus et perte < 20% (en relance uniquement)
		if (relance) {
		  const scoreComplet = sbobetResponse.data.scoreComplet || '';
		  const finImminente = estFinImminente(scoreComplet);

		  if (finImminente) {
			const invPS = 1 / newOddsPS;
			const invSBO = 1 / newOddsSBO;
			const totalInv = invPS + invSBO;
			const pertePotentielle = +((totalInv - 1) * 100).toFixed(2);

			if (pertePotentielle < 100) {
			  console.log(`🎯 Condition de rattrapage activée : perte = ${pertePotentielle}%`);

			  const totalStake = 100;
			  const ratioPS = invPS / totalInv;
			  const ratioSBO = invSBO / totalInv;
			  const stakePS = +(totalStake * ratioPS).toFixed(2);
			  const stakeSBO = +(totalStake * ratioSBO).toFixed(2);

			  const perteEuro = ((pertePotentielle / 100) * totalStake).toFixed(2);

			  await Promise.all([
				axios.post('http://localhost:5001/ps3838/ecrire-mise-final', { stake: stakePS }),
				axios.post('http://localhost:5002/sbobet/ecrire-mise-final', { stake: stakeSBO })
			  ]);

			  await sendTelegramAlert(match, {
				percentage: -pertePotentielle,
				perteEuro: perteEuro,
				bets: [
				  { bookmaker: 'PS3838', team: psBet.team, odds: newOddsPS, stake: stakePS, solde: soldePS, liquidite: maxBetPS },
				  { bookmaker: 'SBOBET', team: sbobetBet.team, odds: newOddsSBO, stake: stakeSBO, solde: soldeSBO, liquidite: maxBetSBO }
				]
			  }, false, true); // false = pas un succès, true = relance

			  console.log(`📉 Pari effectué malgré perte estimée (${pertePotentielle}%)`);
			  return;
			}
		  }
		}



			
		const stakeTotal = soldePS + soldeSBO;
		console.log('🧪 Début du calcul de mises optimales :');
		console.log(`- newOddsPS = ${newOddsPS}`);
		console.log(`- soldePS = ${soldePS}`);
		console.log(`- maxBetPS = ${maxBetPS}`);
		console.log(`- newOddsSBO = ${newOddsSBO}`);
		console.log(`- soldeSBO = ${soldeSBO}`);
		console.log(`- maxBetSBO = ${maxBetSBO}`);


		let invPS = 1 / newOddsPS;
		let invSBO = 1 / newOddsSBO;
		let totalInv = invPS + invSBO;
		
		console.log(`- invPS = ${invPS}`);
		console.log(`- invSBO = ${invSBO}`);
		console.log(`- totalInv = ${totalInv}`);

		const ratioPS = invPS / totalInv;
		const ratioSBO = invSBO / totalInv;
		
		console.log(`- ratioPS = ${ratioPS}`);
		console.log(`- ratioSBO = ${ratioSBO}`);

		// On veut miser au plus haut possible sans dépasser les limites max
		const maxBudgetPossible = Math.min(
		  maxBetPS / ratioPS,
		  maxBetSBO / ratioSBO,
		  soldePS / ratioPS,
		  soldeSBO / ratioSBO
		);

		console.log(`- maxBudgetPossible (avant mise) = ${maxBudgetPossible}`);

		const finalStakePS = +(maxBudgetPossible * ratioPS).toFixed(2);
		const finalStakeSBO = +(maxBudgetPossible * ratioSBO).toFixed(2);
		
		console.log(`- finalStakePS = ${finalStakePS}€`);
		console.log(`- finalStakeSBO = ${finalStakeSBO}€`);


		// 🟢 Les deux bots ont répondu : on libère l'attente
		enAttenteDeRéponse = false;

		console.log(`✅ PS3838 a pris cote ${newOddsPS} (liquidité ${maxBetPS})`);
		console.log(`✅ SBOBET a pris cote ${newOddsSBO} (liquidité ${maxBetSBO})`);


		const gainPS = finalStakePS * newOddsPS;
		const gainSBO = finalStakeSBO * newOddsSBO;
		const totalStake = finalStakePS + finalStakeSBO;

		const gainNetPS = gainPS - totalStake;
		const gainNetSBO = gainSBO - totalStake;
		const gainNetMin = Math.min(gainNetPS, gainNetSBO);
		const roiReel = +(100 * (gainNetMin / totalStake)).toFixed(2);
		const gainNetArrondi = +gainNetMin.toFixed(2);

		if (roiReel > 0) {
		  console.log(`🎯 Arbitrage valide après cotes mises à jour (ROI réel ${roiReel}%) — Gain estimé : ${gainNetArrondi}€`);
		  console.log(`🧮 Nouvelles mises recalculées : PS3838=${finalStakePS}€, SBOBET=${finalStakeSBO}€`);
				  
		  if (gainNetArrondi >= 20) {

			// 🔴 Vérification des mises minimales
			if (finalStakePS < 5 || finalStakeSBO < 1) {
			  console.warn(`❌ Mise trop faible (PS3838=${finalStakePS}€, SBOBET=${finalStakeSBO}€). Annulation du pari.`);
			  try {
				await Promise.all([
				  axios.post('http://localhost:5001/ps3838/fermer-panier'),
				  axios.post('http://localhost:5002/sbobet/fermer-panier')
				]);
				console.log('🛑 Paniers fermés après détection mise trop faible.');
			  } catch (err2) {
				console.warn('⚠️ Impossible de fermer les paniers :', err2.message);
			  }
			  enAttenteDeRéponse = false;
			  setTimeout(() => {
				verrouPariEnCours = false;
				console.log('🔓 Verrou pari levé. Nouvelles opportunités autorisées.');
			  }, 30000);
			  return;
			}

			// 👉 on place enfin les mises
			let verif;
			try {
			  console.log(`🔍 Vérification de la cote dans le panier PS3838 : ${newOddsPS}`);
			  verif = await axios.post('http://localhost:5001/ps3838/verifier-cote-panier', {
				cote: newOddsPS
			  });
			} catch (err) {
			  console.error('❌ Échec de la requête vers /verifier-cote-panier :', err.message);
			  await axios.post('http://localhost:5001/ps3838/fermer-panier');
			  await axios.post('http://localhost:5002/sbobet/fermer-panier');
			  enAttenteDeRéponse = false;
			  verrouPariEnCours = false;
			  return;
			}


			if (!verif.data.valide) {
			  console.warn('❌ Cote PS3838 trop basse au dernier moment, annulation.');
			  await axios.post('http://localhost:5001/ps3838/fermer-panier');
			  await axios.post('http://localhost:5002/sbobet/fermer-panier');
			  enAttenteDeRéponse = false;
			  verrouPariEnCours = false;
			  return;
			}

			try {
			  await Promise.all([
				axios.post('http://localhost:5001/ps3838/ecrire-mise-final', { stake: Number(finalStakePS) }),
				axios.post('http://localhost:5002/sbobet/ecrire-mise-final', { stake: Number(finalStakeSBO) })
			  ]);
			} catch (errMise) {
			  console.error('❌ Erreur lors de l’envoi des mises finales :', errMise.message);
			  await sendTelegramAlert(match, {
				  percentage: newProfit,
				  bets: [
					{ bookmaker: 'PS3838', team: psBet.team, odds: newOddsPS, stake: finalStakePS, solde: soldePS, liquidite: maxBetPS },
					{ bookmaker: 'SBOBET', team: sbobetBet.team, odds: newOddsSBO, stake: finalStakeSBO, solde: soldeSBO, liquidite: maxBetSBO }
				  ]
				}, false, relance);
			  return; // on sort, pas besoin de continuer
			}

			// on notifie le succès
			psBet.solde_apres = +(soldePS - finalStakePS).toFixed(2);
			sbobetBet.solde_apres = +(soldeSBO - finalStakeSBO).toFixed(2);

			await sendTelegramAlert(match, {
			  percentage: roiReel,
			  gain_estime: gainNetArrondi,
			  bets: [
				{
				  bookmaker: 'PS3838',
				  team: psBet.team,
				  odds: newOddsPS,
				  stake: finalStakePS,
				  solde: soldePS,
				  solde_apres: psBet.solde_apres,
				  liquidite: maxBetPS
				},
				{
				  bookmaker: 'SBOBET',
				  team: sbobetBet.team,
				  odds: newOddsSBO,
				  stake: finalStakeSBO,
				  solde: soldeSBO,
				  solde_apres: sbobetBet.solde_apres,
				  liquidite: maxBetSBO
				}
			  ]
			}, true);



			// pause et levée du verrou
			await new Promise(resolve => setTimeout(resolve, 60000));
			verrouPariEnCours = false;
			console.log('🔓 Verrou pari levé après exécution réussie.');
			return true;

		  
		  } else {
			// si le profit recalculé inferieur à 20 euros, on annule
			console.warn(`❌ Gain estimé (${gainNetArrondi.toFixed(2)}€) < 20€, annulation du pari.`);
			try {
			  await Promise.all([
				axios.post('http://localhost:5001/ps3838/fermer-panier'),
				axios.post('http://localhost:5002/sbobet/fermer-panier')
			  ]);
			  console.log('🛑 Paniers fermés après annulation pour faible profit.');
			} catch (err2) {
			  console.warn('⚠️ Impossible de fermer les paniers :', err2.message);
			}
			enAttenteDeRéponse = false;
			verrouPariEnCours = false;
			console.log('🔓 Verrou pari levé après annulation.');
			return;
		  }
		

		}  else {
		  console.warn('❌ Arbitrage disparu après cotes mises à jour.');
		  console.warn(`📉 Nouvelle somme des inverses = ${totalInv}`);
		  console.warn(`Cotes finales : PS=${newOddsPS}, SBO=${newOddsSBO}`);
		  try {
			await Promise.all([
			  axios.post('http://localhost:5001/ps3838/fermer-panier'),
			  axios.post('http://localhost:5002/sbobet/fermer-panier')
			]);
			console.log('🛑 Paniers fermés après disparition arbitrage.');
		  } catch (err2) {
			console.warn('⚠️ Impossible de fermer les paniers après disparition arbitrage:', err2.message);
		  }

		  enAttenteDeRéponse = false;
		  verrouPariEnCours = false;
		  console.log('🔓 Verrou pari levé après disparition arbitrage.');
		}
       
	   } catch (err) {
		  console.error('❌ Erreur dans envoyerAuxBots :', err);
		  // On libère les verrous pour ne pas bloquer la suite
		  // 🔴 Envoie une alerte Telegram d'échec

		  enAttenteDeRéponse = false;
		  verrouPariEnCours    = false;
		  // Et on ferme les paniers au cas où ils seraient restés ouverts
		  try {
			await Promise.all([
			  axios.post('http://localhost:5001/ps3838/fermer-panier'),
			  axios.post('http://localhost:5002/sbobet/fermer-panier')
			]);
		  } catch (_) { /* swallow */ }
		}
	});
}; 

app.post('/relance-arbitrage', async (req, res) => {
  const relance = req.body;
  console.log(`📩 Relance reçue : ${relance.source} => ${relance.team} @${relance.odds}`);

  relanceActive = true;

  // 🔒 Timeout de sécurité
  setTimeout(() => {
    if (relanceActive) {
      console.warn('⚠️ Timeout de relance expiré. Réinitialisation forcée.');
      relanceActive = false;
    }
  }, 60000);

  try {
    const fichier = lireJSON(fichierFusion);
    if (!fichier) throw new Error('JSON fusionné illisible');

    const matchTrouvé = Object.values(fichier)
      .flat()
      .find(m => m.match === relance.match);

    if (!matchTrouvé || !matchTrouvé.ps3838 || !matchTrouvé.sbobet) {
      throw new Error('Match introuvable dans le fichier fusionné');
    }

    const [teamPS1, cotePS1] = Object.entries(matchTrouvé.ps3838.odds)[0];
    const [teamPS2, cotePS2] = Object.entries(matchTrouvé.ps3838.odds)[1];
    const [teamSBO1, coteSBO1] = Object.entries(matchTrouvé.sbobet.odds)[0];
    const [teamSBO2, coteSBO2] = Object.entries(matchTrouvé.sbobet.odds)[1];

    const combinaisons = [
      {
        bets: [
          { bookmaker: 'PS3838', team: teamPS1, odds: parseFloat(cotePS1) },
          { bookmaker: 'SBOBET', team: teamSBO2, odds: parseFloat(coteSBO2) }
        ]
      },
      {
        bets: [
          { bookmaker: 'PS3838', team: teamPS2, odds: parseFloat(cotePS2) },
          { bookmaker: 'SBOBET', team: teamSBO1, odds: parseFloat(coteSBO1) }
        ]
      }
    ];

    for (const combo of combinaisons) {
      const arbitrage = calculArbitrage(combo.bets[0].odds, combo.bets[1].odds);
      if (!arbitrage.isArbitrage || arbitrage.profit < 3) continue;

      // ❗ Protection anti-collision
      if (verrouPariEnCours || enAttenteDeRéponse) {
        console.log('⛔ Une opération critique est déjà en cours. Relance annulée.');
        break;
      }

      const matchData = {
        match: relance.match,
        bets: combo.bets
      };

      console.log(`🔁 Tentative de re-arbitrage après relance (${arbitrage.profit}%)`);
      await envoyerAuxBots(matchData, 'live', {
        percentage: arbitrage.profit,
        bets: combo.bets
      }, true); // true = relance

      break;
    }

    res.send('Relance traitée');
  } catch (err) {
    console.error('❌ Erreur lors de la relance arbitrage :', err.message);
    res.status(500).send('Erreur relance');
  } finally {
    relanceActive = false;
  }
});



function calculArbitrage(cote1, cote2) {
  const inv1 = 1 / cote1;
  const inv2 = 1 / cote2;
  const total = inv1 + inv2;
  return {
    isArbitrage: total < 1,
    profit: +(100 * (1 - total)).toFixed(4)
  };
}

async function lancerRelanceCoteFixe(botEchec, botFixe) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
	  chat_id: TELEGRAM_CHAT_ID,
	  text: `🔁 *Relance Simple en cours* sur *${botEchec.bookmaker}*, en attente de cote favorable...`,
	  parse_mode: 'Markdown'
	});

  console.log(`🔁 Relance du bot ${botEchec.bookmaker} sur cote fixe ${botFixe.odds}`);
  const coteFixe = botFixe.odds;
  const stakeFixe = 20;

  const relancer = setInterval(async () => {
    try {
      const scraping = await axios.get(`http://localhost:${botEchec.bookmaker === 'PS3838' ? 5001 : 5002}/scraping`);
      const event = scraping.data.find(e => e.match === botEchec.match);
      if (!event) return;

      const liveCote = event.odds[botEchec.team];
      const arbitrage = calculArbitrage(coteFixe, liveCote);
      if (arbitrage.isArbitrage && arbitrage.profit >= 5) {
        const inv1 = 1 / coteFixe;
        const inv2 = 1 / liveCote;
        const total = inv1 + inv2;
        const stake = +(stakeFixe * (inv2 / total)).toFixed(2);
        await axios.post(`http://localhost:${botEchec.bookmaker === 'PS3838' ? 5001 : 5002}/ecrire-mise-final`, {
          stake
        });
		await sendTelegramAlert({ match: botEchec.match }, {
		  percentage: arbitrage.profit,
		  bets: [
			{
			  bookmaker: botFixe.bookmaker,
			  team: botFixe.team,
			  odds: botFixe.odds,
			  stake: stakeFixe,
			  solde: botFixe.solde || 0,
			  solde_apres: botFixe.solde ? botFixe.solde - stakeFixe : undefined,
			  liquidite: botFixe.liquidite || 0
			},
			{
			  bookmaker: botEchec.bookmaker,
			  team: botEchec.team,
			  odds: liveCote,
			  stake,
			  solde: botEchec.solde || 0,
			  solde_apres: botEchec.solde ? botEchec.solde - stake : undefined,
			  liquidite: botEchec.liquidite || 0
			}
		  ]
		}, true, true); // le dernier true = relance

        console.log(`✅ Relance envoyée à ${botEchec.bookmaker} à ${liveCote}`);
        clearInterval(relancer);
      }
    } catch (err) {
      console.warn('⚠️ Erreur relance fixe :', err.message);
    }
  }, 5000);
}

async function lancerRelanceDouble(ps, sbo) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
	  chat_id: TELEGRAM_CHAT_ID,
	  text: `🔁 *Relance Double en cours* : PS3838 + SBOBET`,
	  parse_mode: 'Markdown'
	});

  console.log('🔁 Double relance PS3838 + SBOBET');
  const relancer = setInterval(async () => {
    try {
      const [psLive, sboLive] = await Promise.all([
        axios.get('http://localhost:5001/scraping'),
        axios.get('http://localhost:5002/scraping')
      ]);
      const e1 = psLive.data.find(e => e.match === ps.match);
      const e2 = sboLive.data.find(e => e.match === sbo.match);
      if (!e1 || !e2) return;

      const cote1 = e1.odds[ps.team];
      const cote2 = e2.odds[sbo.team];
      const arbitrage = calculArbitrage(cote1, cote2);
      if (arbitrage.isArbitrage && arbitrage.profit >= 5) {
        const totalInv = (1 / cote1) + (1 / cote2);
        const stakeTotal = 100;
        const stake1 = +(stakeTotal * ((1 / cote1) / totalInv)).toFixed(2);
        const stake2 = +(stakeTotal * ((1 / cote2) / totalInv)).toFixed(2);

        await Promise.all([
          axios.post('http://localhost:5001/ps3838/ecrire-mise-final', { stake: stake1 }),
          axios.post('http://localhost:5002/sbobet/ecrire-mise-final', { stake: stake2 })
        ]);
		await sendTelegramAlert({ match: ps.match }, {
		  percentage: arbitrage.profit,
		  bets: [
			{
			  bookmaker: ps.bookmaker,
			  team: ps.team,
			  odds: cote1,
			  stake: stake1,
			  solde: ps.solde || 0,
			  solde_apres: ps.solde ? ps.solde - stake1 : undefined,
			  liquidite: ps.liquidite || 0
			},
			{
			  bookmaker: sbo.bookmaker,
			  team: sbo.team,
			  odds: cote2,
			  stake: stake2,
			  solde: sbo.solde || 0,
			  solde_apres: sbo.solde ? sbo.solde - stake2 : undefined,
			  liquidite: sbo.liquidite || 0
			}
		  ]
		}, true, true);
        console.log(`✅ Relance double effectuée`);
        clearInterval(relancer);
      }
    } catch (err) {
      console.warn('⚠️ Erreur relance double :', err.message);
    }
  }, 250);
}

async function analyser() {
  const data = lireJSON(fichierFusion);
  if (!data) return;

  for (const sport in data) {
    for (const match of data[sport]) {
      if (!match.ps3838 || !match.sbobet) continue;

      const [teamPS1, cotePS1] = Object.entries(match.ps3838.odds)[0];
      const [teamPS2, cotePS2] = Object.entries(match.ps3838.odds)[1];
      const [teamSBO1, coteSBO1] = Object.entries(match.sbobet.odds)[0];
      const [teamSBO2, coteSBO2] = Object.entries(match.sbobet.odds)[1];

      const combinaisons = [
        {
          id: `${sport} | ${match.match} | PS1-SBO2`,
          arbitrage: calculArbitrage(parseFloat(cotePS1), parseFloat(coteSBO2)),
          bets: [
            { bookmaker: 'PS3838', team: teamPS1, odds: parseFloat(cotePS1) },
            { bookmaker: 'SBOBET', team: teamSBO2, odds: parseFloat(coteSBO2) }
          ]
        },
        {
          id: `${sport} | ${match.match} | PS2-SBO1`,
          arbitrage: calculArbitrage(parseFloat(cotePS2), parseFloat(coteSBO1)),
          bets: [
            { bookmaker: 'PS3838', team: teamPS2, odds: parseFloat(cotePS2) },
            { bookmaker: 'SBOBET', team: teamSBO1, odds: parseFloat(coteSBO1) }
          ]
        }
      ];

      for (const combo of combinaisons) {
		  const { id, arbitrage, bets } = combo;

		  // 🛑 Nouveau : ignore directement si ce n'est pas un vrai arbitrage
		  if (!arbitrage.isArbitrage) {
			// Si une opportunité est déjà active mais devient non rentable, on la supprime aussi
			if (opportunitesActives[id]) {
			  delete opportunitesActives[id];
			  console.log(`🗑️ Opportunité devenue non rentable supprimée : ${id}`);
			}
			continue; // on passe au suivant
		  }

		  // ✅ Sinon (vrai arbitrage), on continue normalement
		  if (!opportunitesActives[id]) {
			  opportunitesActives[id] = {
				profit: arbitrage.profit,
				dernierProfitAlerte: null,
				match,
				bets,
				lastOdds: bets.map(b => b.odds) // ➕ on stocke les cotes
			  };
			} else {
			  // Vérification des cotes : si identiques, on ignore
			  const lastOdds = opportunitesActives[id].lastOdds;
			  const currentOdds = bets.map(b => b.odds);
			  const cotesIdentiques = lastOdds.every((odds, i) => odds === currentOdds[i]);

			  if (cotesIdentiques) {
				// ⛔ On saute cette itération car cotes inchangées
				continue;
			  }

			  // ✅ Mise à jour car cotes changées
			  opportunitesActives[id].profit = arbitrage.profit;
			  opportunitesActives[id].lastOdds = currentOdds;
			}


		  const opp = opportunitesActives[id];

		  if (arbitrage.profit >= 3) {
			const succes = await envoyerAuxBots(match, sport, { percentage: arbitrage.profit, bets });
			if (succes) {
				// Met à jour dernierProfitAlerte si tu veux (facultatif)
				opp.dernierProfitAlerte = arbitrage.profit;
				console.log(`📢 Alerte Telegram envoyée pour ${id} : ${arbitrage.profit}%`);
			}
		  }
		}

    }
  }

  // 🔥 Nettoyage des opportunités mortes
  for (const id in opportunitesActives) {
    const opp = opportunitesActives[id];
    if (opp.profit <= 0.00000001 || isNaN(opp.profit)) {
      delete opportunitesActives[id];
      console.log(`🗑️ Opportunité supprimée : ${id}`);
    }
  }
    // 🔥 Suppression des événements disparus du fichier
  const idsActuels = new Set();
  for (const sport in data) {
    for (const match of data[sport]) {
      if (!match.ps3838 || !match.sbobet) continue;

      const id1 = `${sport} | ${match.match} | PS1-SBO2`;
      const id2 = `${sport} | ${match.match} | PS2-SBO1`;
      idsActuels.add(id1);
      idsActuels.add(id2);
    }
  }

  for (const id in opportunitesActives) {
    if (!idsActuels.has(id)) {
      console.log(`🗑️ Opportunité supprimée (match disparu) : ${id}`);
      delete opportunitesActives[id];
    }
  }

  //afficherTableau();
}


// function afficherTableau() {
  // const tableau = [];

  // for (const id in opportunitesActives) {
    // const opp = opportunitesActives[id];
    // tableau.push({
      // Match: id,
      // 'Profit (%)': opp.profit.toFixed(4) // ➔ Bien formaté 4 décimales
    // });
  // }

  //Trie par meilleur profit descendant
  // tableau.sort((a, b) => parseFloat(b['Profit (%)']) - parseFloat(a['Profit (%)']));

  // console.clear();
  // console.log('📋 Opportunités d’arbitrage en cours :');
  // console.table(tableau);
// }


async function attendreServeurPret(url, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await axios.get(url);
      return true;
    } catch {
      await new Promise(res => setTimeout(res, 500)); // attend 0,5s
    }
  }
  throw new Error(`❌ Timeout d'attente pour ${url}`);
}

let interval = null;

(async () => {
  console.log("⏳ Attente des bots PS3838 et SBOBET...");
  try {
    await attendreServeurPret("http://localhost:5001/status");
    await attendreServeurPret("http://localhost:5002/status");
    console.log("✅ Tous les bots sont prêts. Démarrage de la détection.");
    console.log("🧠 Détecteur d'arbitrage actif...");
    setInterval(analyser, 250);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
})();



process.on('SIGINT', () => {
  clearInterval(interval);
  process.exit();
});
process.on('SIGTERM', () => {
  clearInterval(interval);
  process.exit();
});

app.listen(3000, () => {
  console.log('🚀 Serveur arbitrage en écoute sur le port 3000');
});

