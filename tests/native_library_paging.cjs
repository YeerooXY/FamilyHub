const assert = require('node:assert/strict');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [process.cwd(), '../agent-dock']}));
const {origin, runWithFixture, fixturePage} = require('./music_popup_unification.cjs');

runWithFixture(async () => {
    assert.ok((await fetch(origin + '/fixture/startup/library-pages', {method: 'POST', redirect: 'error'})).ok);
    try {
        for (const [engine, options] of [[chromium, {viewport: {width:1280, height:850}}], [webkit, devices['iPhone 13']]]) {
            const browser = await engine.launch();
            try {
                const page = await fixturePage(browser, options);
                await page.goto(origin);
                await page.locator('.hub-card.hub-music').click();
                await page.locator('.workspace[data-app-view=Home]').waitFor();
                if (options.isMobile) {
                    await page.getByRole('button', {name:'Playlists', exact:true}).click();
                    await page.getByRole('button', {name:'Songs', exact:true}).click();
                } else {
                    for (const compact of [false, true]) {
                        const offset = await page.evaluate(compact => {
                            document.body.dataset.navigation = compact ? 'compact' : 'expanded';
                            document.body.style.setProperty('--sidebar-width', compact ? '72px' : '232px');
                            const center = selector => {
                                const box = document.querySelector(selector).getBoundingClientRect();
                                return box.x + box.width / 2;
                            };
                            return center('#open-home svg') - center('#open-hub svg');
                        }, compact);
                        assert(Math.abs(offset) <= 1, 'Header and sidebar centers differ by ' + offset);
                    }
                    await page.locator('#open-library').click();
                }
                const count = n => page.waitForFunction(n => document.querySelectorAll('.library-list .song-row').length === n, n);
                await count(50);
                const end = page.locator('playlist-page-end');
                await end.scrollIntoViewIfNeeded();
                await count(100);
                const filter = page.locator('#library-filter');
                await filter.fill('Library page song 101');
                await count(1);
                await filter.fill('');
                await count(100);
                await end.scrollIntoViewIfNeeded();
                await count(125);
                assert.equal(await end.count(), 0);
                await page.getByRole('button', {name:'Switch apps'}).click();
                await page.locator('#app-switcher').getByRole('button', {name:'Movies & TV',exact:true}).click();
                await page.locator('.workspace[data-app-view="Movies & TV"] .movie-library').waitFor({state:'attached'});
                assert.equal(await page.locator('.sidebar').isVisible(), false);
                assert.equal(await page.getByRole('button',{name:'Switch apps'}).isVisible(), true);
                console.log(engine.name() + ' Hub switcher, library paging and filter restoration passed');
            } finally { await browser.close(); }
        }
    } finally { await fetch(origin + '/fixture/startup/none', {method: 'POST', redirect: 'error'}); }
}).catch(e => { console.error(e); process.exitCode = 1; });
