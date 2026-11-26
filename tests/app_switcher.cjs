const assert = require('node:assert/strict');
const {verifyShell, focused, fits} = require('./app_shell_fixture.cjs');

verifyShell(async (page, phone) => {
    const opener = page.locator('#open-hub');
    const popup = page.getByRole('dialog', {name: 'Switch apps', exact: true});
    const app = name => popup.getByRole('button', {name, exact: true});
    const icon = () => opener.locator('svg').innerHTML();
    const open = async key => {
        await opener.press(key);
        await popup.waitFor();
        await focused(page, 'switcher-app-0');
        await page.waitForFunction(() => document.getElementById('open-hub').getAttribute('aria-expanded') === 'true');
        await fits(page, popup);
    };
    const dismiss = async () => {
        await page.keyboard.press('Escape');
        await popup.waitFor({state: 'hidden'});
        await focused(page, 'open-hub');
        await page.waitForFunction(() => document.getElementById('open-hub').getAttribute('aria-expanded') === 'false');
    };

    const musicIcon = await icon();
    assert.equal(await opener.getAttribute('aria-label'), 'Switch apps');
    await open('Enter');
    assert.equal(await opener.locator('svg rect').count(), 4);
    assert.equal(await app('Music').getAttribute('aria-current'), 'true');
    const reducedMotion = page.viewportSize().width === 390;
    assert.equal(await popup.evaluate(node => getComputedStyle(node).animationName), reducedMotion ? 'none' : 'popup-fade-in');
    for (const [key, index] of [['ArrowRight', 1], ['ArrowDown', 3], ['ArrowLeft', 2], ['ArrowUp', 0]]) {
        await page.keyboard.press(key);
        await focused(page, `switcher-app-${index}`);
    }
    await page.keyboard.press('Shift+Tab');
    await focused(page, 'switcher-hub');
    await page.keyboard.press('Tab');
    await focused(page, 'switcher-app-0');
    await dismiss();
    assert.equal(await icon(), musicIcon);

    await page.evaluate(() => { document.body.dataset.effects = 'off'; });
    await open('Space');
    assert.equal(await popup.evaluate(node => getComputedStyle(node).animationName), 'none');
    const filesIcon = await app('Files').locator('svg').innerHTML();
    if (phone) await app('Files').tap();
    else {
        await page.keyboard.press('ArrowRight');
        await focused(page, 'switcher-app-1');
        await page.keyboard.press('ArrowDown');
        await focused(page, 'switcher-app-3');
        await page.keyboard.press('Enter');
    }
    const workspace = page.locator('.workspace[data-app-view="Files"]');
    await workspace.waitFor();
    await page.waitForFunction(() => document.getElementById('open-hub').getAttribute('aria-expanded') === 'false');
    await fits(page, workspace.locator('main'));
    assert.equal(await icon(), filesIcon);
    await open('Space');
    assert.equal(await app('Files').getAttribute('aria-current'), 'true');
    const hubIcon = await app('FamilyHub home').locator('svg').innerHTML();
    await app('FamilyHub home').press('Enter');
    await page.locator('.hub-card.hub-music').waitFor();
    await page.waitForFunction(() => document.getElementById('open-hub').getAttribute('aria-expanded') === 'false');
    assert.equal(await icon(), hubIcon);
    await fits(page, page.locator('#content'));

    if (page.viewportSize().width === 1280) {
        const geometry = await page.evaluate(() => {
            // Model the CSS metrics supplied by the WinUI bridge. The browser has no native caption buttons.
            const style = document.documentElement.style;
            style.setProperty('--caption-height', '48px');
            style.setProperty('--window-controls-width', '139.2px');
            document.body.classList.add('native-titlebar');
            const header = document.querySelector('.app-header');
            const {top, height} = header.getBoundingClientRect();
            const avatar = document.getElementById('profile-toggle').getBoundingClientRect();
            const switcher = document.getElementById('open-hub').getBoundingClientRect();
            const reserved = innerWidth - avatar.right;
            return {top, height, reserved, aligned: avatar.top + avatar.height / 2 === switcher.top + switcher.height / 2,
                background: getComputedStyle(header).backgroundColor};
        });
        assert.equal(geometry.top, 0);
        assert.equal(geometry.height, 48);
        assert.ok(geometry.reserved >= 139.2);
        assert.equal(geometry.aligned, true);
        assert.equal(geometry.background, 'rgb(0, 0, 0)');
    }
}).catch(error => { console.error(error); process.exitCode = 1; });
