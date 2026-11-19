// Run tests/music_browser_fixture.py first, or set FAMILYHUB_WEB_FIXTURE to a local family-mode server.
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE ||
  require.resolve('playwright', { paths: [root, path.resolve(root, '../agent-dock')] }));

async function verify(browserType, profile, name) {
  const browser = await browserType.launch();
  try {
    const page = await browser.newPage(profile);
    page.setDefaultTimeout(6000);
    await page.addInitScript(() => {
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      AbortSignal.timeout = ms => timeout(new URLSearchParams(location.search).has('short') ? 300 : ms);
    });
    const server = process.env.FAMILYHUB_WEB_FIXTURE;
    const origin = server || 'https://music.test';
    if (!server) {
      await page.route(origin + '/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/') return route.fulfill({ path: path.join(root, '.local/music-browser/index.html') });
        if (pathname.startsWith('/static/')) return route.fulfill({ path: path.join(root, 'music_web', pathname) });
        return route.fulfill({ json: { results: [], playlists: [], items: [], jobs: [] } });
      });
    }
    let requests = 0;
    const track = (id, title) => ({id, title, channel:'Fixture artist', url:'https://www.youtube.com/watch?v=' + id});
    const first = track('abcdefghijk', 'First recording');
    const second = track('mnopqrstuvw', 'Later recording');
    await page.route(origin + '/api/search', async route => {
      const {query} = route.request().postDataJSON();
      if (query === 'timed out') await new Promise(resolve => setTimeout(resolve, 900));
      const complete = query !== 'Björk & 雨' || ++requests > 2;
      if (query === 'Björk & 雨' && requests > 1)
        assert.equal(route.request().headers()['x-familyhub-activity'], 'background');
      await route.fulfill({json:{complete, results: query !== 'Björk & 雨' ? [] : complete ? [first, second] : [first]}});
    });
    if (server) {
      await page.goto(origin + '/login');
      await page.locator('button.family-profile').first().click();
    } else await page.goto(origin + '/');
    const query = page.locator('#q');
    const status = page.locator('#search-status');
    const submit = async text => { await query.fill(text); await query.press('Enter'); };
    if (!await query.isVisible()) await page.locator('#nav-search').click();
    await submit('Björk & 雨');
    const firstAction = page.getByRole('button', {name:'Add First recording to queue'});
    await firstAction.focus();
    await page.getByRole('button', {name:'Add Later recording to queue'}).waitFor();
    assert.equal(await firstAction.count(), 1);
    assert(await firstAction.evaluate(button => button === document.activeElement));
    assert.equal(await page.locator('#pick').getAttribute('aria-busy'), 'false');
    await page.goto(origin + '/?short');
    if (!await query.isVisible()) await page.locator('#nav-search').click();
    await submit('timed out');
    await status.filter({hasText:'The server took too long. Try again.'}).waitFor();
    assert.equal(await page.locator('#pick').getAttribute('aria-busy'), 'false');
    if (process.env.FAMILYHUB_FLOW_SCREENSHOTS) await page.screenshot({
      path: path.join(process.env.FAMILYHUB_FLOW_SCREENSHOTS, 'search-timeout-' + name + '.png')
    });
    await submit('retry');
    await status.filter({hasText:'No songs match this search.'}).waitFor();
    console.log(name + ' passed partial results, focus, timeout, and retry');
  } finally { await browser.close(); }
}

(async () => {
  await verify(chromium, {viewport:{width:1280,height:900}}, 'windows');
  await verify(webkit, {viewport:{width:1280,height:900}}, 'mac-webkit');
  await verify(chromium, {...devices['Pixel 7'],viewport:{width:390,height:844}}, 'android');
  await verify(webkit, devices['iPhone 13'], 'iphone');
})().catch(error => { console.error(error); process.exitCode = 1; });
