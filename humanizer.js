const { chromium } = require('playwright');
const { mouseHelper } = require('./humanizer');
const { patchPageForHumanBehavior } = require('./humanPatch');

(async () => {
    const browser = await chromium.launch({ headless: false, slowMo: 50 });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Injecteur de curseur fantôme pour visuel humain
    await patchPageForHumanBehavior(page);

    // Accès à la page principale
    await page.goto('https://www.unibet.fr/sport');

    // Attente de la navbar avec "Paris en live"
    await page.waitForSelector('#cps-navbar', { timeout: 10000 });

    const boutonLive = await page.$('a[href="/live"]:has-text("Paris en live")');
    if (boutonLive) {
        const box = await boutonLive.boundingBox();
        if (box) {
            await boutonLive.scrollIntoViewIfNeeded();
            await humanClick(page, box.x + box.width / 2, box.y + box.height / 2);
            console.log("✅ Clic humain sur l'onglet 'Paris en live' effectué !");
            await page.waitForTimeout(3000); // Laisse le temps au contenu de charger
        } else {
            console.log("⚠️ BoundingBox non trouvée.");
        }
    } else {
        console.log("❌ Onglet 'Paris en live' introuvable.");
    }

    console.log('🔍 Onglet Live ouvert. Surveillance en cours...');

    // Fonction d'extraction
    const extraireEvenements = async () => {
        const evenements = await page.$$eval('#cps-eventcard-live', cards => {
            return cards.map(card => {
                const tournoi = card.querySelector('.title')?.textContent?.trim();
                const lignes = card.querySelectorAll('.scoreboard tr');
                const joueurs = [...lignes].map(tr => tr.querySelector('.inplay-table-board-name')?.textContent?.trim());
                const cotes = [...card.querySelectorAll('.oddbox-value span')].map(span => span.textContent?.trim());

                return {
                    tournoi,
                    participants: joueurs,
                    cotes
                };
            });
        });

        console.clear();
        console.table(evenements.map(e => ({
            Tournoi: e.tournoi,
            [`${e.participants?.[0]}`]: e.cotes?.[0],
            [`${e.participants?.[1]}`]: e.cotes?.[1],
        })));
    };

    // Boucle d’actualisation toutes les 250 ms
    setInterval(extraireEvenements, 250);
})();

// Fonction de clic humain
async function humanClick(page, x, y) {
    await page.mouse.move(x + 100, y + 100); // départ un peu loin
    const steps = Math.floor(Math.random() * 10) + 10;
    for (let i = 0; i < steps; i++) {
        const newX = x + (Math.random() - 0.5) * 2;
        const newY = y + (Math.random() - 0.5) * 2;
        await page.mouse.move(newX, newY);
        await page.waitForTimeout(Math.random() * 10 + 5);
    }
    await page.mouse.move(x, y);
    await page.mouse.click(x, y);
}
