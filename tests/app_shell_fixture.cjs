const assert = require('node:assert/strict');
const path = require('node:path');
const {chromium, webkit, devices} = require(require.resolve('playwright', {
    paths: [path.resolve(__dirname, '..'), path.resolve(__dirname, '../../agent-dock')]
}));
const {origin, runWithFixture, fixturePage} = require('./music_popup_unification.cjs');

function verifyShell(check) {
    return runWithFixture(async () => {
        for (const [engine, device] of [[chromium, 'Pixel 7'], [webkit, 'iPhone 13']]) {
            const browser = await engine.launch({headless: true});
            try {
                for (const width of [320, 390, 1280, 1920]) {
                    const phone = width < 721;
                    const options = phone ? devices[device] : {};
                    const page = await fixturePage(browser, {...options,
                        viewport: {width, height: phone ? 780 : 900},
                        reducedMotion: width === 390 ? 'reduce' : 'no-preference'});
                    try {
                        await page.goto(origin);
                        await page.locator('.hub-card.hub-music').click();
                        await page.locator('.workspace[data-app-view="Home"]').waitFor();
                        await check(page, phone);
                        console.log(`${engine.name()} ${width}: passed`);
                    } finally { await page.close(); }
                }
            } finally { await browser.close(); }
        }
    });
}

function focused(page, id) {
    return page.waitForFunction(expected => document.activeElement?.id === expected, id);
}

async function fits(page, surface) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth &&
        document.body.scrollWidth <= innerWidth && document.activeElement !== document.body), true,
        'The app must fit the viewport and keep focus off body');
    assert.equal(await surface.evaluate(node => node.scrollWidth <= node.clientWidth), true,
        'The panel must fit its own scroll area');
}

module.exports = {verifyShell, focused, fits};
