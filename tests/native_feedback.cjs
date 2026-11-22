const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const paths = [root, path.resolve(root, '../agent-dock')];
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths}));
const {PNG} = require(require.resolve('playwright-core/lib/utilsBundle', {paths}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const thumbnailImage = new PNG({width: 128, height: 72});
for (let y = 0; y < 72; y++) for (let x = 0; x < 128; x++) {
    const level = Math.hypot(x - 51, y - 36) <= 5 ? 245 : x >= 12 && x <= 115 && Math.abs(y - 36) <= 1 ? (x < 51 ? 188 : 80) : 20;
    thumbnailImage.data.fill(level, 4 * (y * 128 + x), 4 * (y * 128 + x) + 3);
    thumbnailImage.data[4 * (y * 128 + x) + 3] = 255;
}
const png = PNG.sync.write(thumbnailImage);
const capture = process.env.FEEDBACK_CAPTURE;

async function check(name, engine, profile) {
    const browser = await engine.launch();
    const page = await browser.newPage({...profile, reducedMotion: name === 'iphone-webkit' ? 'reduce' : 'no-preference'});
    page.setDefaultTimeout(12000);
    try {
        await page.request.post(origin + '/fixture/startup/none');
        await page.goto(origin);
        const profileButton = page.getByRole('button', {name: 'Profile menu'});
        await profileButton.press('Enter');
        await page.getByRole('button', {name: 'Feedback', exact: true}).press('Enter');
        const dialog = page.locator('#feedback-dialog');
        await dialog.waitFor();
        const description = dialog.getByLabel('Description', {exact: true});
        assert.equal(await dialog.getByLabel('Title', {exact: true}).count(), 0);
        assert.equal(await dialog.getByText(/include recent diagnostics/i).count(), 0);
        await description.pressSequentially('private-typed-content');
        await description.fill('The seek bar disappeared.');
        await description.press('Tab');
        const attach = dialog.getByLabel('Attach pictures here', {exact: true});
        assert(await attach.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Shift+Tab');
        assert(await description.evaluate(node => node === document.activeElement));
        await attach.setInputFiles({name: 'seek-bar.png', mimeType: 'image/png', buffer: png});
        const thumbnail = dialog.getByRole('button', {name: 'View seek-bar.png'});
        await thumbnail.waitFor();
        const feature = dialog.getByRole('button', {name: 'Request a feature'});
        await feature.press('Space');
        await page.waitForFunction(() => document.querySelector('.feedback-types')?.dataset.feature === 'true');
        assert.equal(await description.inputValue(), 'The seek bar disappeared.');
        assert(await thumbnail.isVisible());
        const duration = await dialog.locator('.feedback-types').evaluate(node => getComputedStyle(node, '::before').transitionDuration);
        assert.equal(duration, name === 'iphone-webkit' ? '0s' : '0.2s');
        await thumbnail.press('Enter');
        const image = page.getByRole('dialog', {name: 'seek-bar.png'});
        await image.getByRole('img', {name: 'seek-bar.png'}).waitFor();
        await page.waitForFunction(() => document.querySelector('#feedback-image-dialog img')?.naturalWidth === 128);
        await image.getByRole('button', {name: 'Close screenshot'}).press('Space');
        await image.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.id?.startsWith('feedback-thumb-'));
        assert(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth));
        if (capture) await dialog.screenshot({path: path.join(capture, name + '.png'), animations: 'disabled'});
        await page.keyboard.press('Escape');
        await dialog.waitFor({state: 'hidden'});
        assert.equal(await page.request.get(origin + '/fixture/feedback-draft').then(response => response.json()), true);
        await page.reload();
        await profileButton.press('Enter');
        await page.getByRole('button', {name: 'Feedback', exact: true}).press('Enter');
        await thumbnail.waitFor();
        assert.equal(await description.inputValue(), 'The seek bar disappeared.');

        await dialog.getByRole('button', {name: 'Review report'}).press('Enter');
        await dialog.getByRole('heading', {name: 'Review feedback'}).waitFor();
        assert(await dialog.getByText('The seek bar disappeared.', {exact: true}).isVisible());
        await page.waitForFunction(() => document.activeElement?.id === 'feedback-title');
        await page.request.post(origin + '/fixture/startup/feedback-offline');
        const send = dialog.getByRole('button', {name: 'Send feedback'});
        await send.press('Enter');
        await dialog.getByText('Feedback is offline. Try again.').waitFor();
        assert(await send.evaluate(node => node === document.activeElement));
        await page.request.post(origin + '/fixture/startup/none');
        await send.press('Enter');
        await dialog.getByText('Feedback sent.').waitFor();
        assert.equal(await page.request.get(origin + '/fixture/feedback-draft').then(response => response.json()), false);
        const payload = await page.request.get(origin + '/fixture/feedback-submission').then(response => response.json());
        assert.equal(payload.kind, 'feature');
        assert.equal(payload.images[0].name, 'seek-bar.png');
        assert(payload.events.some(event => event.event === 'key' && event.key === 'Enter'));
        assert(!JSON.stringify(payload.events).includes('private-typed-content'));
        assert(!JSON.stringify(payload.events).includes('The seek bar disappeared.'));
        await dialog.getByRole('button', {name: /The seek bar disappeared/}).click();
        await dialog.getByRole('heading', {name: 'Feature request'}).waitFor();
        await dialog.getByRole('button', {name: 'seek-bar.png'}).click();
        await image.getByRole('img').waitFor();
        await page.keyboard.press('Escape');
        await image.waitFor({state: 'hidden'});
        await page.keyboard.press('Escape');
        await dialog.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.id === 'profile-toggle');
        console.log(name + ' feedback, screenshot, retry, privacy and keyboard focus passed');
        if (name === 'windows-chromium') {
            await page.request.post(origin + '/fixture/startup/feedback-admin');
            await profileButton.press('Enter');
            await page.getByRole('button', {name: 'Feedback', exact: true}).press('Enter');
            await dialog.getByRole('button', {name: 'My feedback'}).press('Enter');
            await dialog.getByRole('button', {name: 'Developer inbox'}).click();
            await dialog.getByRole('button', {name: /The seek bar disappeared/}).click();
            await dialog.getByText('Diagnostics', {exact: true}).click();
            assert(await dialog.locator('.feedback-diagnostics li').count() > 0);
            await dialog.getByLabel('Reply', {exact: true}).fill('Which Windows version was this?');
            await dialog.getByRole('button', {name: 'Send reply'}).click();
            await dialog.getByText('Which Windows version was this?', {exact: true}).waitFor();
            await dialog.getByText('Reply sent.', {exact: true}).waitFor();
            await dialog.getByRole('button', {name: 'Close report'}).click();
            await dialog.getByRole('button', {name: 'Reopen'}).waitFor();
            assert.equal(await dialog.getByLabel('Reply', {exact: true}).count(), 0);
            console.log('Developer inbox diagnostics, reply and close passed');
        }
    } finally {
        await browser.close();
    }
}

(async () => {
    await check('windows-chromium', chromium, {viewport: {width: 1280, height: 900}});
    await check('desktop-webkit', webkit, {viewport: {width: 850, height: 900}});
    await check('android-chromium', chromium, devices['Pixel 7']);
    await check('iphone-webkit', webkit, {...devices['iPhone 13'], viewport: {width: 320, height: 750}});
})().catch(error => { console.error(error); process.exitCode = 1; });
