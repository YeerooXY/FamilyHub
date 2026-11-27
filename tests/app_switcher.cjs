const assert = require('node:assert/strict');
const {verifyShell, focused, fits} = require('./app_shell_fixture.cjs');
const {origin} = require('./music_popup_unification.cjs');

verifyShell(async (page, phone) => {
    const opener = page.locator('#open-hub');
    const popup = page.getByRole('dialog', {name: 'Switch apps', exact: true});
    const app = name => popup.getByRole('button', {name, exact: true});
    const icon = () => opener.locator('svg').innerHTML();
    const narrow = page.viewportSize().width === 360;
    const header = page.locator('.app-header');
    const checkHeader = async searchSelector => {
        const profile = await header.getByRole('button', {name: 'Profile menu'}).boundingBox();
        const switcher = await header.getByRole('button', {name: 'Switch apps', exact: true}).boundingBox();
        assert.ok(profile && switcher && switcher.width >= 44 && switcher.height >= 44);
        assert.equal((await opener.innerText()).trim(), '', 'The phone switcher displays only its icon');
        // app.js moves title into data-tooltip once the control has been focused or hovered.
        assert.equal(await opener.getAttribute('title') ?? await opener.getAttribute('data-tooltip'), 'Switch apps');
        if (searchSelector) {
            const search = header.locator(searchSelector);
            await search.waitFor();
            const box = await search.boundingBox();
            assert.ok(box && switcher.x + switcher.width < box.x && box.x + box.width < profile.x,
                'The phone search pill fits with gaps between the switcher and profile');
        } else {
            assert.equal(await header.getByRole('searchbox').count(), 0);
            assert.ok(switcher.x + switcher.width < profile.x, 'The Files header controls fit with a gap');
        }
    };
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
    if (page.viewportSize().width === 1280) {
        const shortcut = await page.locator('#q').evaluate(input => {
            const chrome = window.chrome ??= {};
            const previousWebView = chrome.webview;
            chrome.webview = {};
            const methods = [];
            window.familyhub.bindAppFullscreen({invokeMethodAsync: async method => { methods.push(method); }});
            const f11 = repeat => input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'F11', bubbles: true, cancelable: true, repeat
            }));
            const defaultAllowed = [f11(false), f11(true)];
            input.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Escape', bubbles: true, cancelable: true
            }));
            window.familyhub.bindAppFullscreen(null);
            if (previousWebView === undefined) delete chrome.webview;
            else chrome.webview = previousWebView;
            return {methods, defaultAllowed};
        });
        assert.deepEqual(shortcut, {methods: ['ToggleAppFullscreen'], defaultAllowed: [false, false]});
    }
    if (narrow) await checkHeader('#q');
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
    if (narrow) await checkHeader();
    await open('Space');
    assert.equal(await app('Files').getAttribute('aria-current'), 'true');
    const hubIcon = await app('FamilyHub home').locator('svg').innerHTML();
    await app('FamilyHub home').press('Enter');
    await page.locator('.hub-card.hub-music').waitFor();
    await page.waitForFunction(() => document.getElementById('open-hub').getAttribute('aria-expanded') === 'false');
    assert.equal(await icon(), hubIcon);
    await fits(page, page.locator('#content'));

    if (narrow) {
        assert.ok((await page.request.post(origin + '/fixture/startup/movies-polish')).ok());
        try {
            await open('Enter');
            await app('Movies & TV').tap();
            await popup.waitFor({state: 'hidden'});
            await checkHeader('.movie-search');
        } finally {
            await page.request.post(origin + '/fixture/startup/none');
        }
    }

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
}, [320, 360, 390, 1280, 1920]).catch(error => { console.error(error); process.exitCode = 1; });
