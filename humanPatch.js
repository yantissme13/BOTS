const delay = (ms) => new Promise(res => setTimeout(res, ms));
const random = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function patchPageForHumanBehavior(page) {
  // Patch click souris
  const originalMouseClick = page.mouse.click;
  page.mouse.click = async (x, y, options = {}) => {
    await page.mouse.move(x, y);
    await page.evaluate(({ x, y }) => {
      const event = new MouseEvent('mousemove', {
        clientX: x,
        clientY: y,
        bubbles: true
      });
      document.dispatchEvent(event);
    }, { x, y });

    await delay(random(100, 300));
    await originalMouseClick.call(page.mouse, x, y, options);
  };

  // Patch page.click
  const originalPageClick = page.click;
  page.click = async (selector, options = {}) => {
    try {
      const el = await page.$(selector);
      const box = await el.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;

      await page.mouse.move(x, y);
      await delay(random(100, 300));
      await page.mouse.click(x, y);
    } catch (err) {
      console.warn(`Erreur sur click patché : ${err.message}`);
      try {
        await originalPageClick.call(page, selector, options);
      } catch (fallbackErr) {
        console.error(`Fallback échoué : ${fallbackErr.message}`);
      }
    }
  };

  // Patch page.fill
  const originalFill = page.fill;
  page.fill = async (selector, value) => {
    await page.focus(selector);
    await page.$eval(selector, el => el.value = '');
    for (let char of value) {
      if (Math.random() < 0.05) {
        await page.keyboard.type(String.fromCharCode(char.charCodeAt(0) + 1));
        await page.keyboard.press('Backspace');
      }
      await page.keyboard.type(char);
      await delay(random(100, 200));
    }
  };
}

module.exports = {
  patchPageForHumanBehavior
};
