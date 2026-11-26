const assert = require('node:assert/strict');
const {verifyShell, focused, fits} = require('./app_shell_fixture.cjs');

verifyShell(async (page, phone) => {
    const button = name => page.getByRole('button', {name, exact: true});
    const categories = page.getByRole('navigation', {name: 'Settings categories'});
    const close = button('Close settings');
    const back = button('Back to settings categories');
    const panel = page.locator('#settings-category');
    const open = async () => {
        await button('Profile menu').press('Enter');
        await focused(page, 'profile-menu-close');
        await page.locator('#profile-menu[open] #open-settings').press('Space');
        await focused(page, 'view-title');
        assert.equal(await page.getByRole('searchbox').count(), 0);
        assert.equal(await close.count(), 1);
        assert.equal(await panel.isVisible(), !phone);
        await fits(page, categories);
    };
    const select = async (id, key) => {
        await categories.locator('#settings-' + id).press(key);
        await focused(page, phone ? 'settings-category' : 'settings-' + id);
        await fits(page, panel);
    };
    const returnToList = async id => {
        if (!phone) return;
        await back.waitFor();
        assert.equal(await close.count(), 0);
        assert.equal(await categories.isVisible(), false);
        await page.keyboard.press('Escape');
        await focused(page, 'settings-' + id);
        assert.equal(await panel.isVisible(), false);
    };

    await open();
    await page.keyboard.press('Tab');
    await focused(page, 'settings-exit');
    await page.keyboard.press('Tab');
    await focused(page, 'settings-general');
    await page.keyboard.press('Shift+Tab');
    await focused(page, 'settings-exit');

    for (const [id, control] of [['general', '#profile-display-name'], ['music', '#crossfade-seconds'],
        ['wordle', '#wordle-settings-choice'], ['appearance', '#appearance-theme'],
        ['storage', '#cache-limit'], ['about', '#installed-app-version']]) {
        await select(id, 'Enter');
        await panel.locator(control).waitFor();
        if (!phone) {
            const [rail, content] = await Promise.all([categories.boundingBox(), panel.boundingBox()]);
            assert.ok(rail.x + rail.width <= content.x && Math.abs(rail.y - content.y) <= 1);
            assert.equal(await categories.locator('#settings-' + id).getAttribute('aria-current'), 'true');
        }
        await returnToList(id);
    }

    await select('movies', 'Space');
    const quality = panel.locator('#movie-data-saver:enabled');
    await quality.selectOption('good');
    await page.waitForFunction(() => [...Object.keys(localStorage)].some(key => key.startsWith('familyhub:movie-tracks:') &&
        JSON.parse(localStorage.getItem(key)).dataSaver === 'good'));
    await returnToList('movies');
    await page.keyboard.press('Escape');
    await focused(page, 'profile-toggle');
    await open();
    await select('movies', 'Enter');
    await page.waitForFunction(() => document.getElementById('movie-data-saver')?.value === 'good');
}).catch(error => { console.error(error); process.exitCode = 1; });
