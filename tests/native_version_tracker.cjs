const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const project = fs.readFileSync(path.join(root, 'clients/FamilyHub.App/FamilyHub.App.csproj'), 'utf8');
const version = project.match(/<ApplicationDisplayVersion>([^<]+)/)[1];
const build = project.match(/<ApplicationVersion>([^<]+)/)[1];
const history = 'https://github.com/YeerooXY/FamilyHub/releases';

async function audit(browserType, viewport, scenario, expected, historyKey) {
    const browser = await browserType.launch();
    try {
        const page = await browser.newPage(viewport);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.request.post(origin + '/fixture/startup/' + scenario);
        await page.goto(origin);
        if (scenario === 'update') {
            await page.locator('#update-dialog[open]').waitFor();
            await page.getByRole('button', {name: 'Later', exact: true}).click();
        }
        await page.locator('#profile-toggle').click();
        await page.locator('#open-settings').click();
        const status = page.locator('#settings-update-status');
        await page.waitForFunction(text => document.getElementById('settings-update-status')?.textContent.trim() === text, expected);
        assert.equal(await status.getAttribute('role'), 'status');
        assert.equal(await page.locator('#installed-app-version').innerText(), `${version} · Build ${build} · Windows (x64)`);
        const release = page.locator('#settings-release-history');
        const install = page.locator('#settings-app-update');
        assert.equal(await install.count(), scenario === 'update' ? 1 : 0);
        await page.getByRole('button', {name: 'Change server', exact: true}).focus();
        await page.keyboard.press('Tab');
        assert.equal(await release.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press(historyKey);
        await page.waitForFunction(async url => (await (await fetch('/fixture/update-check')).json()).lastAddress === url, history);
        assert.equal(await release.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await page.getByRole('button', {name: 'Change server', exact: true}).evaluate(node => node === document.activeElement), true);
        assert.equal(await status.evaluate(node => node.closest('section').scrollWidth <= node.closest('section').clientWidth), true);
        const checked = await (await page.request.get(origin + '/fixture/update-check')).json();
        assert.equal(checked.count, 1, 'Settings and startup issued separate update checks');
        assert.deepEqual(errors, []);
    } finally {
        await pageReset(browser);
        await browser.close();
    }
}

async function publicPopup(browserType, viewport, background) {
    const browser = await browserType.launch();
    try {
        const page = await browser.newPage(viewport);
        await page.request.post(origin + '/fixture/startup/' + (background ? 'update-current' : 'update-offline'));
        await page.goto(origin);
        const profile = page.locator('#profile-toggle');
        await profile.waitFor();
        if (background) {
            await page.waitForFunction(async () => (await (await fetch('/fixture/update-check')).json()).count === 1);
            await profile.focus();
            await page.request.post(origin + '/fixture/startup/update-background');
            await page.evaluate(() => window.dispatchEvent(new Event('online')));
        }
        const dialog = page.getByRole('dialog', {name: 'FamilyHub 9.9.9 is available'});
        const later = dialog.getByRole('button', {name: 'Later'});
        await dialog.waitFor();
        assert.equal(await later.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await dialog.getByRole('button', {name: 'Download and restart'}).evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        await page.keyboard.press('Space');
        await dialog.waitFor({state: 'hidden'});
        const update = page.getByRole('button', {name: 'Update available', exact: true});
        await update.press('Enter');
        await dialog.waitFor();
        await page.keyboard.press('Escape');
        await dialog.waitFor({state: 'hidden'});
        assert.equal(await update.evaluate(node => node === document.activeElement), true);
    } finally {
        await pageReset(browser);
        await browser.close();
    }
}

async function pageReset(browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) await page.request.post(origin + '/fixture/startup/none');
}

(async () => {
    await audit(chromium, {viewport: {width: 1280, height: 900}}, 'update-current', `${version} · Up to date`, 'Enter');
    await audit(chromium, {viewport: {width: 820, height: 900}}, 'update-old', '0.0.1 · Installed version is newer', 'Space');
    await audit(chromium, devices['Pixel 7'], 'update', '9.9.9 available', 'Enter');
    await audit(webkit, devices['iPhone 13'], 'update-failed', 'Could not check for updates', 'Space');
    await audit(webkit, devices['Desktop Safari'], 'none', 'No release for this platform', 'Enter');
    await publicPopup(chromium, {viewport: {width: 1280, height: 900}}, true);
    await publicPopup(webkit, devices['iPhone 13'], false);
    console.log('PASS: installed and server versions, update states, canonical release history, keyboard focus, and one update check.');
})().catch(error => { console.error(error); process.exitCode = 1; });
