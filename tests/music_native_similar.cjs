const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

async function check(browser, options, scenario, mobile) {
    const page = await browser.newPage({...options, reducedMotion: 'reduce'});
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        assert.ok((await page.request.post(origin + '/fixture/startup/similar-' + scenario)).ok());
        await page.goto(origin);
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
        }
        assert.ok((await page.request.post(origin + '/fixture/similar-release')).ok());
        if (scenario === 'success' || scenario === 'preparing') {
            await results.getByRole('button', {name: 'Play Online Match'}).waitFor();
            assert.equal(await results.locator('.song-row').count(), scenario === 'preparing' ? 2 : 1);
            assert.equal(await results.getByText('Unrelated Song').count(), 0);
            assert.equal(await results.getByText('First Light', {exact: false}).count(), 0);
            if (scenario === 'preparing') {
                await page.getByText('The current song is preparing. Try again to update the queue.').waitFor();
                assert.equal(await results.getByRole('button', {name: 'Play Local Match'})
                    .evaluate(node => document.activeElement === node), true);
            } else {
                await page.locator('#show-queue').click();
                await page.getByRole('heading', {name: 'Queue', exact: true}).waitFor();
                await page.getByRole('button', {name: 'Play Online Match'}).waitFor();
            }
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

(async () => {
    const desktop = await chromium.launch();
    try {
        for (const scenario of ['success', 'preparing', 'empty', 'error']) {
            await check(desktop, {viewport: {width: 1280, height: 900}}, scenario, false);
            console.log('Desktop Chromium', scenario);
        }
    } finally {
        await desktop.close();
    }
    const phone = await webkit.launch();
    try {
        await check(phone, devices['iPhone 13'], 'preparing', true);
        console.log('iPhone WebKit profile', 'preparing');
    } finally {
        await phone.close();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
