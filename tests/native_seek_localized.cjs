const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

async function checkSeek() {
    const browser = await chromium.launch();
    const page = await browser.newPage({viewport: {width: 850, height: 641}, reducedMotion: 'reduce'});
    page.setDefaultTimeout(10000);
    try {
        await page.request.post(origin + '/fixture/startup/seek-localized');
        await page.goto(origin);
        await page.getByRole('button', {name: 'Music', exact: true}).click();
        await page.locator('#open-library').click();
        await page.locator('.song-row').filter({hasText: 'First Light'}).locator('.song-primary').click();
        const seek = page.getByRole('slider', {name: 'Playback position'});
        await page.waitForFunction(() => document.querySelector('.seek-control input:enabled'));
        const box = await seek.boundingBox();
        const x = fraction => box.x + 6 + fraction * (box.width - 12);
        const y = box.y + box.height / 2;
        const tip = page.locator('.seek-tooltip');
        const elapsed = page.locator('.seek-elapsed');
        await page.mouse.move(x(.35), y);
        await tip.waitFor();
        assert.equal(await seek.getAttribute('max'), '317.5', `Range max was ${await seek.getAttribute('max')} and hover showed ${await tip.textContent()}`);
        assert.match(await tip.textContent(), /^1:\d{2}$/);
        const tipRect = await tip.boundingBox();
        assert(Math.abs(tipRect.x + tipRect.width / 2 - x(.35)) < 1);
        assert(tipRect.y + tipRect.height < y);

        await page.mouse.click(x(.35), y);
        await page.waitForFunction(() => document.querySelector('.seek-control input:enabled')?.getAttribute('aria-valuetext').startsWith('1:'));
        assert.match(await elapsed.textContent(), /^1:\d{2}$/);
        const afterClick = Number(await seek.inputValue());
        assert(Math.abs(afterClick - 317.5 * .35) < 2);

        await page.mouse.move(x(afterClick / 317.5), y);
        await page.mouse.down();
        await page.mouse.move(x(.8), y, {steps: 6});
        await tip.waitFor();
        assert.match(await tip.textContent(), /^4:\d{2}$/);
        await page.mouse.up();
        await page.waitForFunction(() => document.querySelector('.seek-control input:enabled')?.getAttribute('aria-valuetext').startsWith('4:'));
        assert.match(await elapsed.textContent(), /^4:\d{2}$/);
        assert(Math.abs(Number(await seek.inputValue()) - 317.5 * .8) < 2);
        assert(await seek.evaluate(node => node === document.activeElement));
        if (process.env.SEEK_CAPTURE) await page.locator('.player-bar').screenshot({path: process.env.SEEK_CAPTURE});
        await page.mouse.move(1, 1);
        await seek.press('End');
        await page.waitForFunction(() => document.querySelector('.seek-control input:enabled')?.getAttribute('aria-valuetext') === '5:17');
        assert.equal(await seek.inputValue(), '317.5');
        console.log('PASS: localized native seek hover, click, drag, keyboard, time display, and focus');
    } finally {
        await page.request.post(origin + '/fixture/startup/none');
        await browser.close();
    }
}

checkSeek().catch(error => { console.error(error); process.exitCode = 1; });
