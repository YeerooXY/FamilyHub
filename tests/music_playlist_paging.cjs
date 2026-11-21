const assert = require('node:assert/strict');
const { chromium, webkit, devices } = require(require.resolve('playwright', {paths: [process.cwd(), '../agent-dock']}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

(async () => {
    await fetch(origin + '/fixture/startup/paging', {method:'POST'});
    try {
        for (const [engine, options] of [[chromium, {viewport:{width:1280,height:900}}],
            [chromium, {viewport:{width:850,height:900}}], [webkit, devices['iPhone 13']]]) {
            const browser = await engine.launch();
            try {
                const page = await browser.newPage(options);
                await page.goto(origin);
                await page.getByRole('button', {name:'Playlists',exact:true}).first().click();
                await page.locator('.playlist-card[data-playlist-key="fixture:mix0"]').click();
                const count = n => page.waitForFunction(n => document.querySelectorAll('.playlist-song-list .song-row').length === n, n);
                await count(50);
                const end = page.locator('playlist-page-end');
                await end.scrollIntoViewIfNeeded();
                await count(100);
                await page.locator('#playlist-song-search-toggle').click();
                const filter = page.locator('#playlist-song-search');
                await filter.fill('Paging song 121');
                await count(1);
                await filter.fill('');
                await count(100);
                const title = page.locator('button[data-sort="Title"]');
                await title.focus();
                await page.keyboard.press('Tab');
                await page.keyboard.press('Shift+Tab');
                for (const [key, direction] of [['Enter','ascending'],['Space','descending'],['Enter',null]]) {
                    await page.keyboard.press(key);
                    await page.waitForFunction(d => document.activeElement.dataset.sort === 'Title' &&
                        (document.activeElement.dataset.direction || null) === d, direction);
                    await count(100);
                }
                for (const header of await page.locator('.playlist-column-headings button').all()) {
                    assert(await header.isVisible());
                    const label = await header.getAttribute('data-tooltip');
                    assert(label);
                    if (!options.isMobile) {
                        await header.hover();
                        await page.waitForFunction(text => document.querySelector('#app-control-tooltip.is-visible')?.textContent === text, label);
                    }
                }
                await end.scrollIntoViewIfNeeded();
                await count(125);
                assert.equal(await end.count(), 0);
                console.log(engine.name(), 'passed automatic paging, filter restoration, header sorting and focus');
            } finally { await browser.close(); }
        }
    } finally { await fetch(origin + '/fixture/startup/none', {method:'POST'}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
