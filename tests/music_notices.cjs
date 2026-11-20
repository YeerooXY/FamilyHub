// Render the web fixture with tests/music_browser_fixture.py before running this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE ||
  require.resolve('playwright', { paths: [root, path.resolve(root, '../agent-dock')] }));
const output = process.env.FAMILYHUB_NOTICE_SCREENSHOTS;
const native = process.env.FAMILYHUB_NATIVE_NOTICE_FIXTURE;
const profiles = [
  ['windows-1280', chromium, { viewport: { width: 1280, height: 900 } }],
  ['windows-2000', chromium, { viewport: { width: 2000, height: 1060 } }],
  ['windows-850', chromium, { viewport: { width: 850, height: 900 } }],
  ['mac-webkit', webkit, { viewport: { width: 1280, height: 900 }, userAgent: devices['Desktop Safari'].userAgent }],
  ['android-chromium', chromium, { ...devices['Pixel 7'], viewport: { width: 390, height: 839 } }],
  ['iphone-webkit', webkit, devices['iPhone 13']]
];
const tracks = ['Evening Signals', 'Night Windows', 'Paper Planes', 'Afterglow'].map((title, index) => ({
  title, id: String(index + 1).padStart(11, '0'), channel: 'North Atlas', duration: 304,
  url: 'https://www.youtube.com/watch?v=' + String(index + 1).padStart(11, '0')
}));
const cases = [
  ['info', 'Preparing playback…'],
  ['success', 'Audio output updated.'],
  ['warning', 'The server is offline. Showing the last loaded review.'],
  ['error', 'The server did not answer while loading your library. Check that this device can reach your FamilyHub server.', 'Retry loading library'],
  ['empty', 'No songs queued.', 'Browse saved songs']
];

async function metrics(page, selector) {
  return page.locator(selector).evaluateAll(rows => rows.map(row => {
    const box = row.getBoundingClientRect();
    const icon = row.querySelector('.fh-notice-icon').getBoundingClientRect();
    const text = row.querySelector('.fh-notice-text');
    const wrap = text.getBoundingClientRect();
    const style = getComputedStyle(text);
    const action = row.querySelector('.fh-notice-action:not([hidden])')?.getBoundingClientRect();
    const line = parseFloat(style.lineHeight);
    const round = value => Math.round(value * 100) / 100;
    const svg = row.querySelector('svg');
    return {
      level: row.dataset.level, x: round(box.x), y: round(box.y), width: round(box.width), height: round(box.height),
      font: parseFloat(style.fontSize), lines: round(wrap.height / line),
      icon: round(icon.width), grid: svg.getAttribute('viewBox'), stroke: Number(svg.getAttribute('stroke-width')),
      gap: round(wrap.left - icon.right), inset: round(icon.left - box.left),
      centerDelta: round(icon.top + icon.height / 2 - (wrap.top + line / 2)),
      action: action ? { x: round(action.left), y: round(action.top), height: round(action.height),
        centerDelta: round(action.top + action.height / 2 - (box.top + box.height / 2)),
        fits: action.right <= box.right && action.bottom <= box.bottom } : null,
      fits: box.right <= innerWidth && wrap.right <= box.right && text.scrollWidth <= text.clientWidth + 1
    };
  }));
}

function checkMetrics(rows, mobile) {
  for (const row of rows) {
    assert(row.fits, JSON.stringify(row));
    assert.equal(row.font, 14);
    assert.equal(row.icon, 20);
    assert.equal(row.grid, '0 0 24 24');
    assert.equal(row.stroke, 2);
    assert.equal(row.gap, 10);
    assert.equal(row.inset, 13);
    assert(Math.abs(row.centerDelta) <= .5, JSON.stringify(row));
    if (row.action) {
      assert(row.action.fits, JSON.stringify(row));
      assert(row.action.height >= (mobile ? 44 : 34));
      if (row.lines === 1 && row.action.y < row.y + 20)
        assert(Math.abs(row.action.centerDelta) <= 1, JSON.stringify(row));
    }
  }
}

async function toastClearance(page) {
  return page.evaluate(() => {
    const stack = document.querySelector('.fh-toast-stack').getBoundingClientRect();
    const bounds = element => {
      const rect = element?.getBoundingClientRect();
      return rect?.height ? Math.round((rect.top - stack.bottom) * 100) / 100 : null;
    };
    const player = bounds(document.querySelector('.player-bar'));
    const sidebar = document.querySelector('#music-navigation') || document.querySelector('.sidebar');
    const nav = innerWidth <= 720 ? bounds(sidebar) : null;
    return { player, nav, top: Math.round(stack.top), right: Math.round(innerWidth - stack.right) };
  });
}

async function web(page, name, profile) {
  const origin = 'https://music.test';
  let rejectSearch = true;
  await page.route(origin + '/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ path: path.join(root, '.local/music-browser/index.html') });
    if (pathname.startsWith('/static/')) return route.fulfill({ path: path.join(root, 'music_web', pathname) });
    if (pathname === '/api/search') {
      const { query } = route.request().postDataJSON();
      if (rejectSearch) return route.fulfill({ status: 503, json: { error: 'HTTP 503 Service Unavailable' } });
      return route.fulfill({ json: { complete: true, results: query === 'North Atlas' ? tracks : [] } });
    }
    return route.fulfill({ json: { results: [], items: [], jobs: [], playlists: [], devices: [] } });
  });
  await page.goto(origin);
  await page.getByRole('status', { name: '' }).filter({ hasText: 'No saved songs.' }).waitFor();
  await page.getByRole('button', { name: 'Search music' }).click();
  const query = page.locator('#q');
  await query.fill('Unknown song');
  await query.press('Enter');
  const error = page.locator('#search-status').getByRole('alert');
  await error.waitFor();
  assert.equal(await error.textContent(), 'The server could not complete the request. Try again.');
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
  const retry = page.getByRole('button', { name: 'Retry search', exact: true });
  assert.equal(await retry.count(), 1);
  await page.locator('#view-title').focus();
  if (profile.hasTouch) await retry.focus();
  else await page.keyboard.press('Tab');
  assert(await retry.evaluate(button => button === document.activeElement));
  rejectSearch = false;
  await retry.press('Enter');
  await page.getByText('No songs match this search.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'view-title');
  await page.getByRole('button', { name: 'Edit search' }).click();
  assert(await query.evaluate(input => input === document.activeElement));
  await query.fill('North Atlas');
  await query.press('Enter');
  await page.getByRole('button', { name: 'Add Evening Signals to queue' }).waitFor();
  await page.clock.install();
  for (const track of tracks) await page.getByRole('button', { name: 'Add ' + track.title + ' to queue' }).click();
  const toasts = page.locator('.fh-toast-stack .fh-notice');
  assert.equal(await toasts.count(), 3);
  assert.equal(await toasts.getByRole('status').count(), 3);
  assert.equal(await page.evaluate(() => document.activeElement.closest('.fh-toast-stack') === null), true);
  const clearance = await toastClearance(page);
  assert(clearance.player >= 11 && clearance.top >= 0, JSON.stringify(clearance));
  if (profile.hasTouch) assert(clearance.nav > clearance.player, JSON.stringify(clearance));
  const paused = toasts.first();
  if (profile.hasTouch) await paused.focus();
  else await paused.hover();
  await page.clock.runFor(5200);
  assert.equal(await toasts.count(), 1);
  if (profile.hasTouch) await page.locator('#view-title').focus();
  else await page.mouse.move(10, 10);
  await page.clock.runFor(5200);
  assert.equal(await toasts.count(), 0);

  await page.evaluate(rows => {
    const section = document.createElement('section');
    section.id = 'notice-cases';
    section.setAttribute('aria-label', 'Notice examples');
    document.getElementById('view-title').after(section);
    for (const [level, message, label] of rows) {
      const target = document.createElement('div');
      section.append(target);
      FamilyHubNotices.set(target, message, { level, action: label && { label, run() {} } });
    }
    document.getElementById('pick').hidden = true;
  }, cases);
  const rows = await metrics(page, '#notice-cases .fh-notice');
  checkMetrics(rows, profile.hasTouch);
  if (profile.hasTouch) assert(rows.find(row => row.level === 'error').lines >= 3);
  assert.deepEqual(await page.locator('#notice-cases .fh-notice-text').evaluateAll(nodes =>
    nodes.map(node => [node.getAttribute('role'), node.getAttribute('aria-live')])),
    [['status', 'polite'], ['status', 'polite'], ['status', 'polite'], ['alert', null], ['status', 'polite']]);
  const showToasts = () => page.evaluate(() => {
    FamilyHubNotices.toast('Evening Signals added to queue.');
    FamilyHubNotices.toast('Listening history cleared.');
  });
  if (name !== 'iphone-webkit') await showToasts();
  if (output) await page.screenshot({ path: path.join(output, name + '-web.png'), scale: 'css' });
  if (name === 'iphone-webkit') {
    await page.locator('#notice-cases').evaluate(section => section.hidden = true);
    await showToasts();
    if (output) await page.screenshot({ path: path.join(output, name + '-web-toasts.png'), scale: 'css' });
  }
  assert(await toasts.first().evaluate(toast => getComputedStyle(toast).animationName === 'none'));
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const galleryClearance = await toastClearance(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => FamilyHubNotices.toast('Playlist created.'));
  assert.equal(await toasts.last().evaluate(toast => getComputedStyle(toast).animationDuration), '0.16s');
  return { rows, clearance: galleryClearance };
}

async function nativeApp(page, name, profile) {
  await page.goto(native);
  const query = page.locator('#q');
  await query.waitFor({ state: 'attached' });
  if (!await query.isVisible()) await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  await query.fill('Quiet Wire');
  await query.press('Enter');
  const edit = page.getByRole('button', { name: 'Edit search', exact: true });
  await edit.waitFor();
  const rows = await metrics(page, '.fh-notice[data-level=empty]:has(button):visible');
  assert(rows.length);
  checkMetrics(rows, profile.hasTouch);
  await edit.press('Enter');
  await page.waitForFunction(() => document.activeElement.id === 'q');
  await page.evaluate(() => {
    FamilyHubNotices.toast('Evening Signals queued next.');
    FamilyHubNotices.toast('Playlist selection saved.');
  });
  const clearance = await toastClearance(page);
  assert(clearance.player >= 11 && clearance.top >= 0, JSON.stringify(clearance));
  if (profile.hasTouch) assert(clearance.nav > clearance.player, JSON.stringify(clearance));
  if (output) await page.screenshot({ path: path.join(output, name + '-native.png'), scale: 'css' });
  await page.goto(new URL('/server-work', native).href);
  const serverRetry = page.getByRole('button', { name: 'Retry server work', exact: true });
  const reviewRetry = page.getByRole('button', { name: 'Retry song review', exact: true });
  await serverRetry.waitFor();
  await reviewRetry.waitFor();
  const serverErrors = page.locator('.server-work-page .fh-notice[data-level=error]:visible');
  assert.equal(await serverErrors.getByRole('alert').count(), 2);
  const serverRows = await metrics(page, '.server-work-page .fh-notice[data-level=error]:visible');
  checkMetrics(serverRows, profile.hasTouch);
  await serverRetry.focus();
  const lastNotice = await serverErrors.last().boundingBox();
  const player = await page.locator('.player-bar').boundingBox();
  assert(lastNotice.y + lastNotice.height <= player.y);
  if (output && ['windows-1280', 'iphone-webkit'].includes(name))
    await page.screenshot({ path: path.join(output, name + '-native-retry.png'), scale: 'css' });
  for (const [button, successor] of [[serverRetry, 'server-stats-refresh'], [reviewRetry, 'server-stats-refresh']]) {
    await button.press('Enter');
    await button.waitFor({ state: 'hidden' });
    await page.waitForFunction(id => document.activeElement.id === id, successor);
  }
  return { rows, clearance, serverRows };
}

(async () => {
  const evidence = {};
  if (output) fs.mkdirSync(output, { recursive: true });
  for (const [name, engine, profile] of profiles) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ ...profile, reducedMotion: 'reduce' });
      page.setDefaultTimeout(8000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      evidence[name] = { web: await web(page, name, profile) };
      assert.deepEqual(errors, []);
      if (native) {
        const app = await browser.newPage({ ...profile, reducedMotion: 'reduce' });
        app.setDefaultTimeout(8000);
        evidence[name].native = await nativeApp(app, name, profile);
      }
      console.log(name + ' passed notice geometry, roles, focus, and toast timing');
    } finally { await browser.close(); }
  }
  if (output) fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(evidence, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
