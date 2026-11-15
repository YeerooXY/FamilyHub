const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const root = process.env.SHARED_EFFECTS_ROOT || path.resolve(__dirname, '..');
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<!doctype html><link rel="stylesheet" href="/effects.css"><body><div id="app"><div id="panel" style="background:#29292d;width:600px;height:400px;margin:100px">Music</div></div>' +
        (url.searchParams.has('esm') ? '<script type="module">import effects from "/index.mjs";window.effectModule=effects;</script>' : '<script src="/effects.js"></script>'));
    } else if (['/effects.js', '/effects.css', '/index.mjs'].includes(url.pathname)) {
      response.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      response.end(fs.readFileSync(path.join(root, url.pathname.slice(1))));
    } else { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const address = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(address);
    const themes = await page.evaluate(() => PaddockEffects.themes);
    assert.equal(themes.length, 11);
    for (const { id } of themes) {
      await page.evaluate(theme => PaddockEffects.apply(theme, true), id);
      await page.waitForTimeout(60);
      const actual = await page.evaluate(() => ({
        canvas: document.querySelectorAll('#paddock-background canvas').length,
        panel: getComputedStyle(document.querySelector('#panel')).backgroundColor,
        z: getComputedStyle(document.querySelector('#paddock-background')).zIndex,
        theme: document.body.dataset.trim,
        color: getComputedStyle(document.body).getPropertyValue('--frame-a').trim(),
      }));
      assert.equal(actual.canvas, 1);
      assert.equal(actual.panel, 'rgb(41, 41, 45)');
      assert.equal(actual.z, '-1');
      assert.equal(actual.theme, id);
      assert.ok(actual.color.length);
    }
    await page.evaluate(() => PaddockEffects.apply('gamer', false));
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.panel-sky')).visibility), 'hidden');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).animationPlayState), 'paused');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => PaddockEffects.apply('gamer', true));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).animationName), 'none');
    assert.equal(await page.evaluate(() => PaddockEffects.apply('black')), 'normal');
    assert.equal(await page.evaluate(() => PaddockEffects.apply('unknown')), 'classic');
    await page.goto(address + '?esm');
    await page.waitForFunction(() => window.effectModule);
    // Paddock mounts canvases in existing panels, without changing body styling.
    await page.evaluate(() => {
      const panel = document.querySelector('#panel');
      panel.style.position = 'relative'; panel.dataset.frame = 'violet';
      panel.innerHTML = '<button id="before">Before</button><button id="toggle">Motion</button><button id="after">After</button>';
      document.querySelector('#toggle').onclick = () => {
        effectModule.setSkyLevel(2, false);
        effectModule.mountSky(panel, 1);
        effectModule.refreshSky();
      };
      effectModule.mountSky(panel, 1);
      effectModule.mountSky(panel, 1);
    });
    assert.equal(await page.locator('#panel > canvas').count(), 1);
    assert.equal(await page.locator('#paddock-background').count(), 0);
    await page.locator('#toggle').focus();
    for (const key of ['Enter', 'Space', 'Tab', 'Shift+Tab']) await page.keyboard.press(key);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'toggle');
    assert.equal(await page.locator('#panel > canvas').count(), 1);
    assert.equal(await page.evaluate(() => effectModule.apply('icy', true)), 'icy');
    assert.deepEqual(errors, []);
    console.log('PASS: 11 themes, reused canvas, panel API and keyboard focus, backdrop stacking, effects toggle, reduced motion, aliases and ESM.');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
