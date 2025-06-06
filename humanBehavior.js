// humanBehavior.js

module.exports = async function simulateHumanBehavior(page) {
  const delay = (ms) => new Promise((res) => setTimeout(res, ms));

  async function moveMouseRandomly() {
    const box = await page.viewportSize();
    const x = Math.floor(Math.random() * box.width);
    const y = Math.floor(Math.random() * box.height);
    await page.mouse.move(x, y, { steps: 10 });
  }

  async function scrollRandomly() {
    const scrollY = Math.floor(Math.random() * 1000);
    await page.evaluate(y => window.scrollBy(0, y), scrollY);
  }

  async function clickSomething() {
    const clickable = await page.$$('a, button, .oddbox-value, .betMarketOddCard');
    if (clickable.length === 0) return;
    const el = clickable[Math.floor(Math.random() * clickable.length)];
    try {
      await el.scrollIntoViewIfNeeded();
      await delay(300 + Math.random() * 500);
      await el.click({ delay: 100 });
    } catch (e) {
      // Ignorer les erreurs silencieusement
    }
  }

  // Boucle continue en tâche de fond
  (async function loop() {
    while (true) {
      await moveMouseRandomly();
      await delay(1000 + Math.random() * 2000);

      if (Math.random() < 0.3) await scrollRandomly();

      // Pause entre 5 et 15 secondes avant prochain comportement
      await delay(5000 + Math.random() * 10000);
    }
  })();
};
