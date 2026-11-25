const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const address = new URL(process.env.POPUP_URL || 'http://127.0.0.1:38869');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname), 'Use a loopback music fixture');
const origin = address.origin;
const captures = path.join(root, '.local', 'music-1-5-1');
const blockExternal = page => page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort());

async function check(browser, options, scenario, mobile) {
    const page = await browser.newPage({...options, reducedMotion: 'reduce'});
    await blockExternal(page);
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        assert.ok((await page.request.post(origin + '/fixture/startup/similar-' + scenario)).ok());
        await page.goto(origin);
        await page.getByRole('button', {name: /^Music/}).click();
        await page.waitForFunction(() => document.body.dataset.view === 'home');
        if (mobile) {
            await page.getByRole('button', {name: 'Playlists', exact: true}).click();
            await page.getByRole('button', {name: 'Songs', exact: true}).click();
        } else {
            await page.locator('#open-library').click();
        }
        const button = page.locator('#recommend-similar');
        await page.locator('.song-row').filter({hasText: 'First Light'}).locator('.song-primary').click();
        await page.locator('#now-title').getByText('First Light').waitFor();
        if (mobile) {
            await page.locator('#show-queue').tap();
            await page.locator('.player-bar.is-expanded').waitFor();
            await page.locator('#player-more').tap();
            await page.locator('#player-options.is-open').waitFor();
            await button.tap();
        } else {
            await button.focus();
            assert.equal(await page.evaluate(() => document.activeElement.id), 'recommend-similar');
            await page.keyboard.press(scenario === 'preparing' ? 'Space' : 'Enter');
        }
        const results = page.getByRole('region', {name: 'Similar songs', exact: true});
        await results.waitFor({state: 'attached'});
        await page.waitForFunction(() => document.activeElement.id === 'view-title');
        await page.locator('#similar-status').getByText(scenario === 'preparing' ? 'Checking for more similar songs…' : 'Finding similar songs…').waitFor();
        assert.equal(await results.getAttribute('aria-busy'), 'true');
        if (scenario === 'preparing') {
            await results.getByRole('button', {name: 'Play Local Match'}).focus();
            assert.equal(await results.getByRole('button', {name: 'Play Online Match'}).count(), 0);
            await page.getByText('Similar songs added to the queue.', {exact: true}).waitFor();
        }
        if (scenario === 'navigate') {
            await page.locator('#show-queue').click();
            await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
        }
        if (scenario === 'playback-changed') await page.locator('#play').click();
        assert.ok((await page.request.post(origin + '/fixture/similar-release')).ok());
        if (scenario === 'navigate') {
            await page.getByRole('button', {name: 'Play Online Match'}).waitFor();
            assert.deepEqual(errors, []);
            return;
        }
        if (scenario === 'playback-changed') {
            await results.getByRole('button', {name: 'Play Online Match'}).waitFor();
            await page.getByText('Playback changed. Try again to queue songs similar to the current song.').waitFor();
            await page.locator('#show-queue').click();
            await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
            assert.equal(await page.getByRole('button', {name: 'Play Online Match'}).count(), 0);
            assert.deepEqual(errors, []);
            return;
        }
        if (scenario === 'success' || scenario === 'preparing') {
            await results.getByRole('button', {name: 'Play Online Match'}).waitFor();
            assert.equal(await results.locator('.song-row').count(), scenario === 'preparing' ? 2 : 1);
            assert.equal(await results.getByText('Unrelated Song').count(), 0);
            assert.equal(await results.getByText('First Light', {exact: false}).count(), 0);
            assert.equal(await results.locator('[data-recording-id="deezer:42"] .storage-state').getAttribute('aria-label'), 'Not on server');
            if (scenario === 'preparing') {
                assert.equal(await results.getByRole('button', {name: 'Play Local Match'})
                    .evaluate(node => document.activeElement === node), true);
            }
            await page.locator('#show-queue').click();
            if (mobile) await page.locator('#player-queue').tap();
            await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
            await page.getByRole('button', {name: 'Play Online Match'}).waitFor();
            if (scenario === 'preparing') await page.getByRole('button', {name: 'Play Local Match'}).waitFor();
        } else {
            const action = scenario === 'empty' ? 'Browse your library' : 'Try again';
            const recovery = page.getByRole('button', {name: action, exact: true});
            await recovery.waitFor();
            assert.equal(await results.getAttribute('aria-busy'), 'false');
            await page.keyboard.press('Tab');
            assert.equal(await recovery.evaluate(node => document.activeElement === node), true);
            await page.keyboard.press('Shift+Tab');
            assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
            if (scenario === 'error')
                assert.ok((await page.request.post(origin + '/fixture/startup/similar-error')).ok());
            await recovery.focus();
            await page.keyboard.press('Space');
            if (scenario === 'empty') {
                await page.waitForFunction(() => document.body.dataset.view === 'library' && document.activeElement.id === 'content');
            } else {
                await page.getByText('Finding similar songs…').waitFor();
                assert.ok((await page.request.post(origin + '/fixture/similar-release')).ok());
                await recovery.waitFor();
                assert.equal(await page.evaluate(() => document.activeElement.id), 'view-title');
            }
        }
        assert.deepEqual(errors, []);
    } catch (error) {
        console.error(await page.evaluate(() => ({
            view: document.body.dataset.view, focus: document.activeElement?.id, menu: document.querySelector('#player-options')?.className
        })));
        throw error;
    } finally {
        await page.close();
    }
}

async function checkPlaylist(browser, options, width, profile) {
    const page = await browser.newPage({...options, reducedMotion: 'reduce'});
    await blockExternal(page);
    page.setDefaultTimeout(10000);
    try {
        assert.ok((await page.request.post(origin + '/fixture/startup/playlist-follow')).ok());
        await page.goto(origin);
        await page.getByRole('button', {name: /^Music/}).click();
        await page.getByRole('button', {name: 'Playlists', exact: true}).first().click();
        const tools = page.locator('.playlist-tools');
        await tools.waitFor();
        const layout = await tools.evaluate(node => {
            const filters = node.querySelector('.playlist-filters');
            const search = node.querySelector('.playlist-search').getBoundingClientRect();
            const sort = node.querySelector('#playlist-sort').getBoundingClientRect();
            const switchRow = document.querySelector('.playlist-switch-row');
            const tabs = switchRow.querySelector('.library-switch').getBoundingClientRect();
            const create = switchRow.querySelector('#create-playlist').getBoundingClientRect();
            return {
                overflow: Math.max(document.documentElement.scrollWidth - innerWidth, node.scrollWidth - node.clientWidth),
                singleFilterRow: new Set([...filters.children].map(pill => pill.offsetTop)).size === 1,
                sameRow: Math.abs(search.top + search.height / 2 - sort.top - sort.height / 2) < 2,
                createRow: !tabs.width || Math.abs(tabs.top + tabs.height / 2 - create.top - create.height / 2) < 2
            };
        });
        assert.ok(layout.overflow <= 1 && layout.singleFilterRow && layout.sameRow && layout.createRow, JSON.stringify({width, ...layout}));
        await page.screenshot({path: path.join(captures, `${profile}-${width}-playlists.png`)});
        await page.keyboard.press('Tab');
        await page.locator('#playlist-sort').focus();
        assert.equal(await page.locator('#playlist-sort').evaluate(node => node.matches(':focus-visible')), true);
        await page.keyboard.press('Space');
        await page.getByRole('dialog', { name: 'Sort playlists' }).waitFor();
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement.id === 'playlist-sort');
        await page.locator('[data-playlist-key="fixture:mix0"]').click();
        const download = page.locator('#keep-playlist');
        await page.getByRole('button', {name: 'Pause download', exact: true}).waitFor();
        assert.equal(await download.evaluate(node => node.getAttribute('title') ?? node.dataset.tooltip), 'Pause download');
        assert.equal(await download.locator('.download-arc').evaluate(node => getComputedStyle(node).animationName), 'none');
        assert.equal(await download.locator('.download-arc').evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        assert.equal(await page.locator('#transfer-progress-action').count(), 0);
        await page.keyboard.press('Tab');
        await download.focus();
        await page.keyboard.press('Space');
        await page.getByRole('button', {name: 'Resume download', exact: true}).waitFor();
        assert.equal(await download.evaluate(node => node.getAttribute('title') ?? node.dataset.tooltip), 'Resume download');
        assert.equal(await download.evaluate(node => node === document.activeElement), true);
        await page.screenshot({path: path.join(captures, `${profile}-${width}-paused.png`)});
        await page.keyboard.press('Enter');
        await page.getByRole('button', {name: 'Pause download', exact: true}).waitFor();
        assert.equal(await download.evaluate(node => node === document.activeElement), true);
        await page.locator('#play-playlist').click();
        await page.locator('#now-title').getByText('First Light').waitFor();
        // The queue sheet is a desktop surface here; phones open the expanded player first and are covered by the Home check below.
        if (width > 720) {
            await page.locator('#show-queue').click();
            await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
        }
        assert.equal(await page.getByRole('button', {name: 'Play Second Track'}).count(), 0);
        assert.ok((await page.request.post(origin + '/fixture/playlist-step/1')).ok());
        await page.getByRole('button', {name: 'Play Second Track'}).waitFor();
        assert.ok((await page.request.post(origin + '/fixture/playlist-step/2')).ok());
        await page.getByRole('button', {name: 'Play Third Track'}).waitFor();
        assert.deepEqual(await page.locator('main .song-primary').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')).slice(-2)),
            ['Play Second Track', 'Play Third Track']);
    } finally {
        await page.close();
    }
}

async function checkHome(browser, options, width, profile) {
    const page = await browser.newPage({...options, reducedMotion: 'reduce'});
    await blockExternal(page);
    page.setDefaultTimeout(15000);
    try {
        assert.ok((await page.request.post(origin + '/fixture/startup/home-151')).ok());
        await page.goto(origin);
        await page.getByRole('button', {name: /^Music/}).click();
        const daily = page.getByRole('button', {name: 'Play Daily mix', exact: true});
        await daily.waitFor();
        for (const mix of ['Recently added mix', 'Morning mix', 'Jazz mix'])
            assert.equal(await page.getByRole('button', {name: 'Play ' + mix, exact: true}).count(), 1);
        const open = page.getByRole('button', {name: 'Open Evening Signals by North Atlas', exact: true});
        const opener = await open.getAttribute('id');
        const tile = await open.boundingBox();
        assert.ok(tile.width <= 248);
        assert.equal(await daily.evaluate(node => getComputedStyle(node).transitionDuration), '0s');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({path: path.join(captures, `${profile}-${width}-home.png`)});
        await daily.click();
        await page.locator('#now-title').getByText('City Lights').waitFor();
        assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');

        if (options.hasTouch) await open.tap();
        else { await open.focus(); await page.keyboard.press('Enter'); }
        const retry = page.getByRole('button', {name: 'Retry album', exact: true});
        await retry.waitFor();
        await page.waitForFunction(() => document.activeElement.id === 'view-title');
        assert.equal(await page.getByRole('button', {name: 'Play library songs', exact: true}).count(), 1);
        await retry.focus();
        await page.keyboard.press('Space');
        await page.getByText('3 of 4 in your library', {exact: true}).waitFor();
        await page.waitForFunction(() => document.activeElement.id === 'view-title');
        const missing = page.locator('[data-recording-id="deezer:42"]');
        await missing.getByText('Missing from library', {exact: true}).waitFor();
        assert.ok(await missing.getByRole('button', {name: 'Play Album Finale', exact: true}).getAttribute('aria-describedby'));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.screenshot({path: path.join(captures, `${profile}-${width}-album.png`)});

        const play = page.getByRole('button', {name: 'Play album', exact: true});
        await play.focus();
        await page.keyboard.press('Enter');
        await page.locator('#now-title').getByText('First Light').waitFor();
        assert.equal(await page.evaluate(() => document.activeElement.id), 'play-album');
        assert.ok((await page.request.post(origin + '/fixture/playlist-step/1')).ok());
        await page.getByText('4 of 4 in your library', {exact: true}).waitFor();
        assert.equal(await missing.count(), 0);
        await page.locator('.playlist-back').filter({hasText: 'Home'}).click();
        await page.waitForFunction(id => document.activeElement.id === id, opener);
        await page.locator('#show-queue').click();
        const queueHeading = page.getByRole('heading', {name: 'Queue', exact: true});
        await queueHeading.waitFor({timeout: 2500}).catch(async () => {
            if (await page.locator('#player-queue').isVisible()) await page.locator('#player-queue').click();
            else await page.locator('#show-queue').click();
        });
        await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
        await page.getByRole('button', {name: 'Play Album Finale', exact: true}).waitFor();
        assert.equal(await page.locator('main .song-primary').last().getAttribute('aria-label'), 'Play Album Finale');

    } finally {
        await page.close();
    }
}

(async () => {
    const desktop = await chromium.launch();
    try {
        for (const scenario of ['success', 'preparing', 'empty', 'error', 'navigate', 'playback-changed']) {
            await check(desktop, {viewport: {width: 1280, height: 900}}, scenario, false);
            console.log('Desktop Chromium', scenario);
        }
        await checkPlaylist(desktop, {viewport: {width: 1280, height: 900}}, 1280, 'windows-chromium');
        await checkPlaylist(desktop, {...devices['Pixel 7'], viewport: {width: 320, height: 760}}, 320, 'android-chromium');
        await checkHome(desktop, {viewport: {width: 1280, height: 900}}, 1280, 'windows-chromium');
        await checkHome(desktop, {viewport: {width: 2000, height: 1060}}, 2000, 'windows-chromium');
        await checkHome(desktop, {...devices['Pixel 7'], viewport: {width: 320, height: 760}}, 320, 'android-chromium');
    } finally {
        await desktop.close();
    }
    const phone = await webkit.launch();
    try {
        await check(phone, devices['iPhone 13'], 'preparing', true);
        console.log('iPhone WebKit profile', 'preparing');
        await checkPlaylist(phone, {...devices['iPhone 13'], viewport: {width: 390, height: 844}}, 390, 'iphone-webkit');
        for (const width of [768, 2000]) await checkPlaylist(phone, {viewport: {width, height: 900}}, width, 'mac-webkit');
        await checkHome(phone, {viewport: {width: 768, height: 900}}, 768, 'mac-webkit');
        await checkHome(phone, {...devices['iPhone 13'], viewport: {width: 390, height: 844}}, 390, 'iphone-webkit');
    } finally {
        await phone.close();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
