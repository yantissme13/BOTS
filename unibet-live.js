const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

let actif = true;

app.post('/etat-bot', (req, res) => {
  actif = req.body.actif;
  console.log(`🔄 Changement d'état du bot : ${actif ? '✅ ACTIF' : '⛔ EN PAUSE'}`);
  res.sendStatus(200);
});

let opportuniteEnCours = null;

app.post('/unibet/arret-scraping-et-pari', async (req, res) => {
  const { match, sport, team, odds } = req.body;
  console.log(`🛑 Reçu ordre d'arrêt scraping pour opportunité : ${team} @ ${odds}`);
  opportuniteEnCours = { match, sport, team, odds };
  res.sendStatus(200);
});

app.listen(5002, () => {
  console.log('🌐 Serveur Bot Unibet prêt sur le port 5002');
});

const fs = require('fs');
const { chromium } = require('playwright');

const { patchPageForHumanBehavior } = require('./humanPatch');
const simulateHumanBehavior = require('./humanBehavior');

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const context = await browser.newContext({
	  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
	  viewport: { width: 1280, height: 800 },
	  locale: 'fr-FR',
	  timezoneId: 'Europe/Paris',
	});

  const page = await context.newPage();
  await patchPageForHumanBehavior(page);
  await simulateHumanBehavior(page);


  await page.goto('https://www.unibet.fr/sport', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a[href="/live"] span:text("Paris en live")', { timeout: 10000 });
  const boutonLive = await page.$('a[href="/live"]');

  if (boutonLive) {
    console.log("✅ Onglet 'Paris en live' trouvé, tentative de clic...");
    try {
      await Promise.all([
        page.waitForNavigation({ timeout: 5000 }),
        boutonLive.click({ delay: 100 })
      ]);
      console.log("✅ Clic réussi, onglet live ouvert !");
    } catch (err) {
      console.warn("⚠️ Clic normal n'a pas navigué. Tentative clic JS natif...");
      await page.evaluate(el => el.click(), boutonLive);
      await page.waitForTimeout(3000);
    }
  } else {
    console.log("❌ Impossible de trouver l'onglet 'Paris en live'.");
    await browser.close();
    return;
  }

  console.log('🔍 Surveillance des événements en live...');

  async function scraperUnibet(page) {
	  const result = await page.$$eval('.sport', sportSections => {
		const data = {};
		const sportsTrouvés = [];

		for (const sportSection of sportSections) {
		  const sportName = sportSection.querySelector('.live-event-list_sport-header h2')?.textContent?.trim();
		  if (!sportName) continue;

		  sportsTrouvés.push(sportName);
		  const events = sportSection.querySelectorAll('.eventcard');

		  for (const card of events) {
			let home = null;
			let away = null;

			const resume = card.querySelector('.eventcard-content-resume');
			if (resume) {
			  home = resume.querySelector('.home')?.textContent?.trim();
			  away = resume.querySelector('.away')?.textContent?.trim();
			} else {
			  const noms = card.querySelectorAll('.inplay-table-board-name');
			  if (noms.length >= 2) {
				home = noms[0]?.textContent?.trim();
				away = noms[1]?.textContent?.trim();
			  }
			}

			if (!home || !away) continue;

			const cotesNodes = card.querySelectorAll('.oddbox-value span');
			const labelNodes = card.querySelectorAll('.oddbox-label span');

			const cotes = [];
			for (let i = 0; i < cotesNodes.length; i++) {
			  const label = labelNodes[i]?.textContent?.trim();
			  const odd = parseFloat(cotesNodes[i]?.textContent?.replace(',', '.'));
			  if (label && !isNaN(odd)) {
				cotes.push({ team: label, odd });
			  }
			}

			if (cotes.length !== 2) continue;

			if (!data[sportName]) data[sportName] = [];
			data[sportName].push({
			  match: `${home} - ${away}`,
			  odds: cotes
			});
		  }
		}

		return { data, sportsTrouvés };
	  });

	  // Sécurité si rien n’est retourné
	  if (!result || !result.data) {
		console.warn('⚠️ Aucune donnée scrapée pour l’instant...');
		return {};
	  }

	  console.log('🧩 Sports détectés sur la page :', result.sportsTrouvés);
	  return result.data;
	}


  // Boucle d’actualisation toutes les 250 ms
  (async function boucleScraping() {
	  let nextPause = Date.now() + (15 * 60_000 + Math.random() * 5 * 60_000); // entre 15 et 20 min
	  let nextRefresh = Date.now() + 30 * 60_000; // 30 minutes

	  while (true) {
		const now = Date.now();
		if (!actif) {
		  console.log('⛔ Le bot est en pause, navigation désactivée.');
		  await new Promise(r => setTimeout(r, 10_000));
		  continue;
		}

		if (opportuniteEnCours) {
		  console.log(`🛑 Scraping suspendu pour tentative de pari sur ${opportuniteEnCours.team} @ ${opportuniteEnCours.odds}`);
		  await tenterPariHumainement(page, opportuniteEnCours);
		  opportuniteEnCours = null; // ✅ On réinitialise
		  console.log('🔁 Reprise du scraping.');
		  continue; // ✅ Reprend la boucle au tour suivant
		}

		if (now >= nextPause) {
		  const pauseDurée = 110_000 + Math.random() * 50_000; // 110–160 sec
		  console.log(`😴 Pause humaine simulée pendant ${(pauseDurée / 1000).toFixed(0)} secondes...`);
		  await new Promise(res => setTimeout(res, pauseDurée));
		  nextPause = Date.now() + (15 * 60_000 + Math.random() * 5 * 60_000); // prochaine pause
		  console.log('✅ Reprise du scraping.');
		}
		
		if (now >= nextRefresh) {
		  console.log('🔄 Rafraîchissement complet de la page Unibet...');

		  try {
			await page.reload({ waitUntil: 'domcontentloaded' });
			await page.waitForTimeout(3000);

			const boutonLive = await page.$('a[href="/live"]');
			if (boutonLive) {
			  try {
				await Promise.all([
				  page.waitForNavigation({ timeout: 5000 }).catch(() => null), // tolérant
				  boutonLive.click({ delay: 100 })
				]);
				await page.waitForTimeout(3000);
				console.log("✅ Onglet 'Paris en live' rouvert après refresh !");
			  } catch (err) {
				console.warn("⚠️ Clic JS forcé après refresh...");
				await page.evaluate(el => el.click(), boutonLive);
				await page.waitForTimeout(3000);
			  }
			} else {
			  console.warn("❌ Impossible de retrouver l’onglet 'Paris en live' après refresh.");
			}
		  } catch (err) {
			console.error('❌ Erreur pendant le refresh :', err.message);
		  }

		  nextRefresh = Date.now() + 30 * 60_000; // planifie le prochain refresh dans 30 min
		}

		try {
		  const structuredData = await scraperUnibet(page);
		  fs.writeFileSync('unibet_live_structured.json', JSON.stringify(structuredData, null, 2));
		  console.log('💾 Fichier unibet_live_structured.json mis à jour.');
		} catch (e) {
		  console.error('❌ Erreur dans la boucle de scrape Unibet:', e.message);
		}

		console.log('🔁 Itération terminée, lancement immédiat de la suivante.');

	  }
	})();

async function tenterPariHumainement(page, opportunite) {
  console.log(`🎯 Tentative de pari pour ${opportunite.team} @ ${opportunite.odds}`);

  // Cherche la bonne carte de cote
  const cartes = await page.locator('.oddbox-content').all();

  let pariEffectue = false;

  for (const carte of cartes) {
	const teamText = await carte.locator('.oddbox-label span').textContent().catch(() => null);
    const oddText = await carte.locator('.oddbox-value span').textContent().catch(() => null);

    if (!teamText || !oddText) continue;

    const team = teamText.trim();
    const odd = parseFloat(oddText.replace(',', '.'));

    if (team.includes(opportunite.team)) {
	  // clique sur la cote, puis dans le panier, vérifie la cote finale
	  await carte.scrollIntoViewIfNeeded();
      const box = await carte.boundingBox();
      if (!box) continue;

      console.log(`🖱️ Clique humain sur ${team} @ ${odd}`);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 120 });
      await page.waitForTimeout(500); // Laisse le panier s’ouvrir

		try {
		  const input = page.locator('div.input-stake input.input');
		  await input.waitFor({ timeout: 3000 }); // ✅ Attend que le panier apparaisse
		  await input.scrollIntoViewIfNeeded();  // ✅ Scroll seulement quand il existe
		  await input.click();
		  for (let i = 0; i < 4; i++) {
			await page.keyboard.press('Delete');
			await page.waitForTimeout(50);
		  }
		  await input.type('20');
		  console.log(`💰 Mise de 20€ saisie.`);

		  await page.waitForTimeout(500);

		  const coteFinale = await page.locator('.betslip-card .odd b').first().textContent().catch(() => null);
		  console.log(`🔎 Cote lue dans le panier : ${coteFinale}`);
		  const coteNumerique = coteFinale ? parseFloat(coteFinale.replace(',', '.')) : null;

		  if (coteNumerique && coteNumerique >= opportunite.odds) {
			console.log(`✅ Cote encore valide (${coteNumerique}), cette opportunité aurait pu être exploitée.`);
			await axios.post('http://localhost:5001/detecteur/opportunite-validee', {
			  match: opportunite.match,
			  sport: opportunite.sport,
			  team: opportunite.team,
			  odds: coteNumerique,
			  bookmaker: 'Unibet'
			});
			console.log('📨 Confirmation envoyée au détecteur.');
		  } else {
			console.log(`❌ Cote incorrecte ou plus disponible (${coteNumerique}), abandon.`);
		  }
		  try {
			  const croix = page.locator('section#cps-betslip-card .betslip-card-remove');
			  await croix.first().click({ timeout: 3000 });
			  console.log('❌ Pari annulé, panier vidé via croix.');
			} catch (err) {
			  console.warn('⚠️ Impossible de cliquer sur la croix du panier :', err.message);
			}

		} catch (e) {
		  console.warn(`❌ Erreur lors du placement de mise ou lecture panier : ${e.message}`);
		}
		pariEffectue = true;
		break; // on sort de la boucle même si ça a échoué pour cette carte

    }
  }
  if (!pariEffectue) {
	  console.warn(`❌ Aucune carte trouvée pour ${opportunite.team} @ ${opportunite.odds} sur cette page.`);
	}
}

})();
