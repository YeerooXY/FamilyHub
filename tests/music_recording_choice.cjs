const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {
    paths: [root, path.resolve(root, '../agent-dock'), process.cwd()]
}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

async function audit(engine, options, phone = false) {
    const browser = await engine.launch();
    try {
        const page = await browser.newPage(options);
        const target = id => page.locator('#' + id);
        const focused = node => {
            return page.waitForFunction(element => element === document.activeElement, node, {timeout: 5000});
        };
        const focusOn = async node => focused(await node.elementHandle());
        const category = name => page.getByRole('button', {name: new RegExp(name)}).first();
        const dialog = page.getByRole('dialog', {name: 'Choose recording'});
        const close = dialog.getByRole('button', {name: 'Close recording choice'});
        const url = dialog.getByRole('textbox', {name: 'YouTube recording link'});
        const queue = dialog.getByRole('button', {name: 'Queue replacement', exact: true});

        await page.goto(origin);
        await page.getByRole('button', {name: 'Music', exact: true}).click();
        await page.locator('#discovery-shelf .home-card').nth(7).waitFor();
        if (phone) await target('profile-toggle').tap();
        await page.getByRole('button', {name: 'Server work', exact: true}).first().click();
        await category('Song reports').click();
        const report = page.getByRole('button', {name: 'Choose a recording for First Light'});
        await report.focus();
        await report.press('Enter');
        await dialog.waitFor();
        await focusOn(close);
        const search = dialog.getByRole('link', {name: /Search for this song/});
        assert.match(await search.getAttribute('href'), /North%20Atlas%20First%20Light/);
        if (!phone) {
            await page.keyboard.press('Tab');
            if (engine === chromium) {
                await focusOn(search);
                await page.keyboard.press('Tab');
            }
            await focusOn(url);
            await page.keyboard.press('Shift+Tab');
            await focusOn(engine === chromium ? search : close);
        }
        await page.keyboard.press('Escape');
        await dialog.waitFor({state: 'hidden'});
        await focusOn(report);

        await report.press('Space');
        await dialog.waitFor();
        await queue.click();
        await dialog.getByText('Enter a YouTube recording link.').waitFor();
        await focusOn(url);
        await url.fill('https://example.com/recording');
        await url.press('Enter');
        await dialog.getByText('Choose a valid YouTube recording link.').waitFor();
        assert.equal(await url.inputValue(), 'https://example.com/recording');
        assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
        await url.fill('https://youtu.be/Station0001');
        await url.press('Enter');
        await dialog.waitFor({state: 'hidden'});
        await focusOn(target('catalogue-category-title'));
        await page.getByText('Replacement queued', {exact: true}).waitFor();
        assert.equal(await report.getAttribute('aria-disabled'), 'true');

        await target('catalogue-back').click();
        await focusOn(target('catalogue-filter-reports'));
        await category('Damaged audio').click();
        const quality = page.getByRole('button', {name: 'Choose a recording for Evening Signals'});
        await quality.click();
        const preview = dialog.getByRole('link', {name: /Preview the suggested recording/});
        assert.equal(await preview.getAttribute('href'), 'https://www.youtube.com/watch?v=Station0001');
        await dialog.getByRole('button', {name: 'Queue suggested recording'}).press('Space');
        await dialog.waitFor({state: 'hidden'});
        await focusOn(target('catalogue-category-title'));
        await target('catalogue-back').click();
        await focusOn(target('catalogue-filter-damaged'));
        await category('Unofficial uploads').click();
        await page.getByRole('button', {name: 'Choose a recording for Northbound'}).click();
        await dialog.waitFor();
        assert.equal(await dialog.getByRole('button', {name: 'Queue suggested recording'}).count(), 0);
        await url.fill('https://youtu.be/Station0001');
        await url.press('Enter');
        await dialog.waitFor({state: 'hidden'});
        await focusOn(target('catalogue-category-title'));
        console.log(engine.name(), options.viewport.width, 'recording choice passed');
    } finally {
        await browser.close();
    }
}

(async () => {
    await audit(chromium, {viewport: {width: 1280, height: 900}});
    await audit(webkit, {viewport: {width: 850, height: 900}, reducedMotion: 'reduce'});
    await audit(chromium, {...devices['Pixel 7'], reducedMotion: 'reduce'}, true);
    await audit(webkit, {...devices['iPhone 13'], reducedMotion: 'reduce'}, true);
})().catch(error => { console.error(error); process.exitCode = 1; });
