const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const link = 'https://open.spotify.com/playlist/3x6xRt9FnSbfPbgiO6incZ?si=example';

async function check(name, engine, profile) {
    const browser = await engine.launch();
    try {
        const page = await browser.newPage({...profile, reducedMotion: 'reduce'});
        await page.request.post(origin + '/fixture/startup/none');
        await page.goto(origin);
        await page.getByRole('button', {name: 'Music', exact: false}).first().click();
        await page.locator('#music-navigation').getByRole('button', {name: 'Playlists', exact: true}).click();
        await page.locator('#create-playlist').press('Enter');
        const dialog = page.getByRole('dialog', {name: 'Create playlist'});
        await dialog.waitFor();
        const cards = dialog.locator('.illustrated-file-choices > .create-file-choice');
        assert.equal(await cards.count(), 2);
        assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node =>
            /playlist-choose-(songs|folder)\.webp/.exec(getComputedStyle(node).backgroundImage)?.[1])), ['songs', 'folder']);
        for (const type of ['songs', 'folder'])
            assert((await page.request.get(origin + '/playlist-choose-' + type + '.webp')).ok());
        assert.equal(await dialog.getByText(/Up to 500 songs|128 MB per song/).count(), 0);
        const cancel = dialog.getByRole('button', {name: 'Cancel', exact: true});
        const submit = dialog.getByRole('button', {name: 'Create empty playlist'});
        const [cancelRect, submitRect] = await Promise.all([cancel.boundingBox(), submit.boundingBox()]);
        assert(Math.abs(cancelRect.width - submitRect.width) < 1);
        assert.equal(cancelRect.height, submitRect.height);
        assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        if (process.env.CREATE_PLAYLIST_CAPTURE) await dialog.screenshot({
            path: path.join(process.env.CREATE_PLAYLIST_CAPTURE, name + '.png')
        });

        await page.evaluate(value => {
            window.fixtureClipboardText = value;
            window.familyhub.clipboardText = async () => window.fixtureClipboardText;
        }, link);
        const paste = dialog.getByRole('button', {name: 'Paste', exact: true});
        await paste.press('Space');
        const input = dialog.getByRole('textbox', {name: 'Playlist link'});
        const preview = dialog.locator('output[aria-label="Clipboard preview"]');
        await preview.waitFor();
        assert.equal(await input.inputValue(), link);
        assert.equal(await preview.textContent(), link);
        assert(await input.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Shift+Tab');
        assert(await paste.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        assert(await input.evaluate(node => node === document.activeElement));
        await dialog.getByRole('button', {name: 'Clear link'}).press('Enter');
        await preview.waitFor({state: 'hidden'});
        assert(await input.evaluate(node => node === document.activeElement));
        if (name === 'desktop-chromium') {
            const longerLink = 'https://www.youtube.com/playlist?list=PL1234567890&ref=' + 'a'.repeat(400);
            await page.evaluate(value => { window.fixtureClipboardText = value; }, longerLink);
            await paste.press('Enter');
            await preview.waitFor();
            assert.equal(await preview.textContent(), longerLink);
            assert.equal(await input.inputValue(), longerLink);
            await dialog.getByRole('button', {name: 'Clear link'}).press('Enter');
            await preview.waitFor({state: 'hidden'});
            await cards.first().locator('input').setInputFiles(Array.from({length: 501}, (_, index) => ({
                name: `song-${index}.mp3`, mimeType: 'audio/mpeg', buffer: Buffer.from([1])
            })));
            await dialog.getByRole('button', {name: 'Upload 501 songs'}).waitFor();
        }
        await cancel.press('Enter');
        await dialog.waitFor({state: 'hidden'});
        assert(await page.locator('#create-playlist').evaluate(node => node === document.activeElement));
        console.log(name + ' artwork, paste preview, actions and focus passed');
    } finally {
        await browser.close();
    }
}

(async () => {
    await check('desktop-chromium', chromium, {viewport: {width: 1280, height: 900}});
    await check('desktop-webkit', webkit, {viewport: {width: 850, height: 900}});
    await check('android-chromium', chromium, devices['Pixel 7']);
    await check('iphone-webkit', webkit, {...devices['iPhone 13'], viewport: {width: 320, height: 750}});
})().catch(error => { console.error(error); process.exitCode = 1; });
