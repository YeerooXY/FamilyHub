// Screenshots the static pages at phone and desktop sizes and reports horizontal overflow.
const out = __dirname.split(String.fromCharCode(92)).join('/');
const { reviewRuntime } = require('C:/Users/you/Projects/agent-dock/electron/review-browser.cjs');
(async () => {
  const browser = await reviewRuntime().chromium.launch({ headless: true });
  for (const [w, h] of [[390, 844], [320, 640], [1280, 800]]) for (const p of ['home', 'playlist', 'playlist-scrolled', 'now-playing']) {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    await page.goto(`file:///${out}/${p}.html`); await page.waitForTimeout(300);
    if (p === 'playlist-scrolled') await page.evaluate(() => { document.getElementById('content').scrollTop = 600; });
    const over = await page.evaluate(() => [...document.querySelectorAll('main *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.home-shelf')).map(e => String(e.className || e.tagName)).slice(0, 5));
    console.log(w, p, 'overflow:', JSON.stringify(over));
    await page.screenshot({ path: `${out}/${p}-${w}.png` }); await page.close();
  }
  await browser.close();
})();
