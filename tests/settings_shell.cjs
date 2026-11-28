const assert = require('node:assert/strict');
const {verifyShell, focused, fits} = require('./app_shell_fixture.cjs');

verifyShell(async (page, phone) => {
    const button = name => page.getByRole('button', {name, exact: true});
    const categories = page.getByRole('navigation', {name: 'Settings categories'});
    const close = button('Close settings');
    const back = button('Back to settings categories');
    const panel = page.locator('#settings-category');
    const open = async () => {
        // The first press can land before the app attaches its handlers in WebKit.
        await button('Profile menu').waitFor();
        await page.waitForTimeout(250);
        await button('Profile menu').press('Enter');
        await focused(page, 'profile-menu-close');
        await page.locator('#profile-menu[open] #open-settings').press('Space');
        await focused(page, 'view-title');
        assert.equal(await page.getByRole('searchbox', {name: 'Search settings'}).count(), 1);
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
    await focused(page, 'settings-search');
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
        if (id === 'about') {
            assert.match(await panel.locator(control).textContent(), /^\d+\.\d+\.\d+ \(build \d+\), .+$/);
            const attribution = panel.locator('#settings-tmdb-credit');
            await attribution.waitFor();
            assert.equal(await attribution.locator('strong').textContent(), 'TMDB');
            assert.match(await attribution.textContent(),
                /Film data from TMDB\. This product uses the TMDB API but is not endorsed or certified by TMDB\./);
        }
        if (!phone) {
            const [rail, content] = await Promise.all([categories.boundingBox(), panel.boundingBox()]);
            assert.ok(rail.x + rail.width <= content.x && Math.abs(rail.y - content.y) <= 1);
            assert.equal(await categories.locator('#settings-' + id).getAttribute('aria-current'), 'true');
        }
        await returnToList(id);
    }

    if (page.viewportSize().width >= 1920) {
        await categories.locator('#settings-movies').press('ArrowDown');
        await focused(page, 'settings-data');
    }
    const search = page.getByRole('searchbox', {name: 'Search settings'});
    const results = page.getByRole('region', {name: 'Settings search results'});
    await search.fill('subtit');
    const subtitles = results.getByRole('button', {name: 'Preferred subtitles Movies & TV'});
    await subtitles.waitFor();
    assert.equal((await subtitles.locator('mark').textContent()).toLowerCase(), 'subtit');
    await search.press('Escape');
    await focused(page, 'settings-search');
    await page.waitForFunction(() => document.getElementById('settings-search')?.value === '', null, {timeout: 3000}).catch(() => {});
    assert.equal(await search.inputValue(), '');
    await results.waitFor({state: 'detached'});
    await search.fill('TRICKPLAY');
    const preview = results.getByRole('button', {name: /Picture previews when seeking.*Movies & TV.*trickplay/i});
    await preview.waitFor();
    assert.equal(await preview.locator('mark').textContent(), 'trickplay');
    await preview.press('Enter');
    await focused(page, 'movie-seek-pictures');
    assert.equal(await search.inputValue(), '');
    assert.equal(await panel.locator('#movie-seek-pictures').isChecked(), true);
    await returnToList('movies');
    await select('data', 'Space');
    const quality = panel.locator('#movie-data-saver input[value="good"]:enabled');
    await quality.press('Space');
    await panel.getByText('About 1.1 GB per hour').waitFor();
    await panel.getByText('Estimates for a typical film.', {exact: false}).waitFor();
    await panel.locator('#movie-data-used').filter({hasText: '0 MB'}).waitFor();
    await page.waitForFunction(() => [...Object.keys(localStorage)].some(key => key.startsWith('familyhub:movie-tracks:') &&
        JSON.parse(localStorage.getItem(key)).dataSaver === 'good'));
    await returnToList('data');
    await page.keyboard.press('Escape');
    await focused(page, 'profile-toggle');
    await open();
    await select('data', 'Enter');
    await panel.locator('#movie-data-saver input[value="good"]:checked').waitFor();
}).catch(error => { console.error(error); process.exitCode = 1; });
