const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(process.env.PLAYWRIGHT_MODULE ||
    require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const output = path.join(root, 'docs/verification/server-dashboard-2026-11-23');

const profiles = [
    ['1280', {viewport: {width: 1280, height: 900}}],
    ['2000', {viewport: {width: 2000, height: 1080}}],
    ['pixel7', devices['Pixel 7']],
    ['iphone13', devices['iPhone 13']],
];

async function openMusicSection(page, name) {
    await page.getByRole('button', {name: /^Music\b/}).click();
    if (await page.evaluate(() => innerWidth < 700)) {
        await page.getByRole('button', {name: 'Profile menu'}).press('Enter');
    }
    if (name === 'Leaderboard') {
        assert.equal(await page.getByRole('button', {name: 'Server', exact: true}).count(), 0);
    }
    await page.getByRole('button', {name, exact: true}).press('Enter');
    await page.getByRole('heading', {name, level: 1, exact: true}).waitFor();
    await page.waitForFunction(id => document.activeElement?.id === id,
        name === 'Server' ? 'view-title' : 'content');
}

async function state(page, value) {
    const response = await page.request.post(origin + '/fixture/server-health/' + value);
    assert(response.ok());
}

async function check(browser, profileName, profile, engineName) {
    const name = engineName + '-' + profileName;
    const page = await browser.newPage({...profile, reducedMotion: profileName === 'iphone13' ? 'reduce' : 'no-preference'});
    page.setDefaultTimeout(12000);
    try {
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.request.post(origin + '/fixture/startup/health-admin');
        await state(page, 'ready');
        await page.goto(origin);
        await openMusicSection(page, 'Server');
        const current = page.getByRole('region', {name: 'Current readings'});
        const history = page.getByRole('region', {name: 'History', exact: true});
        const radios = history.getByRole('radiogroup', {name: 'History range'});
        const ethernet = history.locator('.health-chart').filter({has: page.getByRole('heading', {name: 'Network: enp3s0', exact: true})});
        const tableToggle = ethernet.getByRole('button', {name: 'Network: enp3s0 data'});
        const historyRefresh = history.getByRole('button', {name: 'Refresh history'});
        await current.getByText('38 GiB used', {exact: true}).waitFor();
        // Seeding: every torrent against the 2.0 goal, loaded on its own.
        const seeding = page.getByRole('region', {name: 'Seeding', exact: true});
        await seeding.getByText('Peaky.Blinders.S01.1080p.BluRay.x264 [Season One]').waitFor();
        assert.equal(await seeding.getByRole('progressbar', {name: /^Share ratio for Peaky/}).getAttribute('aria-valuetext'), '0.003 / 2.0');
        assert.equal(await seeding.getByRole('progressbar', {name: /^Share ratio for Debian/}).getAttribute('aria-valuetext'), '2.4 / 2.0');
        await seeding.getByText('Pending').waitFor();
        assert(await seeding.evaluate(node => node.scrollWidth <= node.clientWidth), name + ' seeding fits the width');
        if (profile.isMobile === false || profileName.includes('desktop') || profileName.includes('windows')) await seeding.screenshot({path: path.join(process.env.SEEDING_CAPTURE || require('node:os').tmpdir(), name + '-seeding.png')});
        await current.getByText('Whole machine: Not measured', {exact: true}).first().waitFor();
        assert.equal(await current.locator('meter').first().evaluate(el => el.getBoundingClientRect().height), 8);
        assert(await current.getByText('CPU warm at 70 °C, hot at 85 °C').isVisible());
        assert.equal(await current.locator('.health-hot').textContent(), '55 °C');
        await ethernet.getByText(/^Latest/).first().waitFor();
        assert.equal(await ethernet.locator('path.health-trace').count(), 2);
        assert.equal(await ethernet.getByText(/recorded$/).count(), 2);
        assert(await history.getByRole('heading', {name: 'Network: VPN tun0'}).isVisible());

        const rangeResponses = expected => page.waitForFunction(range => {
            const section = document.querySelector('#health-history-title').closest('section');
            return section.dataset.range === range && section.querySelector('[role="status"]').textContent.trim().startsWith('Updated');
        }, expected);
        const hour = radios.getByRole('radio', {name: 'Last hour'});
        const day = radios.getByRole('radio', {name: '24 hours'});
        const week = radios.getByRole('radio', {name: '7 days', exact: true});
        assert(await hour.isChecked());
        await hour.press('ArrowRight');
        await rangeResponses('24h');
        assert(await day.isChecked());
        assert(await day.evaluate(el => el === document.activeElement));
        if (profile.isMobile) {
            await radios.getByText('7 days', {exact: true}).tap();
        } else {
            await day.press('ArrowRight');
        }
        await rangeResponses('7d');
        assert(await week.isChecked());

        if (profileName === '2000') {
            assert.equal(await current.locator('.health-tile').evaluateAll(tiles =>
                tiles.filter(tile => tile.offsetTop === tiles[0].offsetTop).length), 3);
            await historyRefresh.press('ArrowDown');
            assert(await week.evaluate(el => el === document.activeElement));
            await page.keyboard.press('ArrowDown');
            assert(await history.locator('.health-table-button:focus').count());
            const vpnToggle = history.getByRole('button', {name: 'Network: VPN tun0 data'});
            if (await vpnToggle.evaluate(el => el === document.activeElement)) await page.keyboard.press('ArrowLeft');
            assert(await tableToggle.evaluate(el => el === document.activeElement));
            await page.keyboard.press('ArrowRight');
            assert(await vpnToggle.evaluate(el => el === document.activeElement));
            assert(await tableToggle.evaluate(el => el.getBoundingClientRect().height >= 60));
        }
        if (profile.isMobile) {
            assert.equal(await radios.locator('label').evaluateAll(labels =>
                new Set(labels.map(label => label.offsetTop)).size), 1);
        }
        await tableToggle.press('Enter');
        const table = ethernet.getByRole('table', {name: 'Network: enp3s0 readings'});
        await table.waitFor();
        assert.equal(await table.getByRole('row').count(), 37);
        assert(await tableToggle.evaluate(el => el === document.activeElement));
        await tableToggle.press('Space');
        await table.waitFor({state: 'hidden'});
        assert(await tableToggle.evaluate(el => el === document.activeElement));
        assert(await page.evaluate(() => {
            const content = document.querySelector('#content');
            return document.documentElement.scrollWidth <= innerWidth && content.scrollWidth <= content.clientWidth;
        }));
        assert.deepEqual(pageErrors, []);

        const capture = async suffix => {
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            await page.screenshot({path: path.join(output, name + '-' + suffix + '.png'), animations: 'disabled'});
        };
        await page.locator('#view-title').evaluate(el => el.focus());
        await page.locator('#content').evaluate(el => {el.scrollTop = 0;});
        await capture('current');
        const scrollToPanel = locator => locator.evaluate(el => {
            const content = el.closest('#content');
            content.scrollTop += el.getBoundingClientRect().top - content.getBoundingClientRect().top - 12;
        });
        if (profile.isMobile) {
            await scrollToPanel(current.locator('.health-tile').filter({has: page.getByRole('heading', {name: 'Power', exact: true})}));
            await capture('sensors');
        }
        await scrollToPanel(history);
        await capture('history');

        if (profileName === '1280') {
            await state(page, 'history-timeout');
            await historyRefresh.press('Enter');
            await history.getByText(/Loading history. Last snapshot/).waitFor();
            assert(await current.getByText('38 GiB used', {exact: true}).isVisible());
            assert(await ethernet.isVisible());
            const retry = history.getByRole('button', {name: 'Retry history'});
            await retry.waitFor();
            assert(await retry.evaluate(el => el === document.activeElement));
            await state(page, 'ready');
            await retry.press('Space');
            await rangeResponses('7d');
            assert(await historyRefresh.evaluate(el => el === document.activeElement));
            await radios.getByRole('radio', {name: '90 days'}).press('Space');
            await rangeResponses('90d');

            await state(page, 'current-error');
            await current.getByRole('button', {name: 'Refresh readings'}).press('Enter');
            const retryCurrent = current.getByRole('button', {name: 'Retry current readings'});
            await retryCurrent.waitFor();
            assert(await retryCurrent.evaluate(el => el === document.activeElement));
            assert(await current.getByText('38 GiB used', {exact: true}).isVisible());
            await state(page, 'ready');
            await retryCurrent.press('Enter');
            await current.getByText(/^Updated/).waitFor();

            await state(page, 'empty-history');
            await historyRefresh.press('Enter');
            await tableToggle.focus();
            await history.getByText('No readings in this range.').waitFor();
            assert(await historyRefresh.evaluate(el => el === document.activeElement));
            await page.request.post(origin + '/fixture/startup/none');
            await page.reload();
            await openMusicSection(page, 'Leaderboard');
            await page.getByRole('group', {name: 'Listening period'}).waitFor();
            assert.equal(await page.getByRole('heading', {name: 'Current readings'}).count(), 0);
        }
        console.log('PASS', name);
    } finally {
        await page.close();
    }
}

(async () => {
    fs.mkdirSync(output, {recursive: true});
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [profileName, profile] of profiles) await check(browser, profileName, profile, name);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
