const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const {origin, runWithFixture, fixturePage} = require('./music_popup_unification.cjs');
const capture = process.env.PROFILE_CAPTURE;

async function audit(device, browserType, options) {
    const browser = await browserType.launch();
    try {
        const page = await fixturePage(browser, options);
        await page.goto(origin);
        const profile = page.locator('#profile-toggle');
        await profile.click();
        await page.locator('#open-settings').click();
        if (options.isMobile) await page.locator('#settings-general').click();
        const panel = page.getByRole('region', {name: 'Profile', exact: true});
        await panel.waitFor();
        const name = panel.getByLabel('Display name', {exact: true});
        const save = panel.getByRole('button', {name: 'Save name', exact: true});
        const picture = panel.getByLabel('Change picture', {exact: true});
        const [inputBounds, labelBounds, pictureBounds, saveBounds] = await Promise.all([
            name.boundingBox(), panel.locator('label[for="profile-display-name"]').boundingBox(),
            picture.boundingBox(), save.boundingBox()
        ]);
        assert(inputBounds.x - pictureBounds.x - pictureBounds.width <= 24);
        assert(Math.abs(labelBounds.x - inputBounds.x) <= 1 && labelBounds.y < inputBounds.y);
        assert(inputBounds.height >= 44 && saveBounds.height >= 44);
        if (page.viewportSize().width > 600) {
            assert(Math.abs(inputBounds.y - saveBounds.y) <= 1);
            assert(saveBounds.x + saveBounds.width - inputBounds.x <= 441);
        }
        const pictureCaption = panel.locator('.profile-picture-caption');
        await pictureCaption.waitFor();
        assert.equal(await pictureCaption.textContent(), 'Change picture');
        await name.focus();
        await page.keyboard.press('Shift+Tab');
        assert(await picture.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        assert(await name.evaluate(node => node === document.activeElement));
        if (capture) await panel.screenshot({path: path.join(capture, device + '-initial.png')});
        assert.equal(await name.inputValue(), 'Alex');
        assert.equal(await save.getAttribute('aria-disabled'), 'true');
        await name.fill('June');
        await page.locator('#profile-save-name:not([aria-disabled])').waitFor();
        await name.press('Enter');
        await page.getByText('A profile with this name already exists.', {exact: true}).waitFor();
        assert.equal(await name.evaluate(el => el === document.activeElement), true);
        assert.equal(await profile.evaluate(el => el.title || el.dataset.tooltip), 'Alex');
        if (capture) await panel.screenshot({path: path.join(capture, device + '-error.png')});
        await name.fill('  Mária 🌿  ');
        await page.keyboard.press('Tab');
        assert.equal(await save.evaluate(el => el === document.activeElement), true);
        await save.press('Space');
        await page.getByText('Name saved.', {exact: true}).waitFor();
        const feedback = panel.locator('#profile-name-feedback');
        const feedbackBounds = await feedback.boundingBox();
        assert(Math.abs(feedbackBounds.x - inputBounds.x) <= 1);
        assert.equal(await feedback.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
        assert.equal(await name.inputValue(), 'Mária 🌿');
        assert.equal(await save.evaluate(el => el === document.activeElement), true);
        if (capture) await panel.screenshot({path: path.join(capture, device + '-saved.png')});
        await page.keyboard.press('Shift+Tab');
        assert.equal(await name.evaluate(el => el === document.activeElement), true);
        assert.equal(await name.evaluate(el => el.closest('section').scrollWidth <= el.closest('section').clientWidth), true);
        await name.fill('Unsaved change');
        await feedback.waitFor({state: 'hidden'});
        if (options.isMobile) await page.getByRole('button', {name: 'Back to settings categories'}).click();
        await page.getByRole('button', {name: 'Close settings'}).click();
        await profile.click();
        await page.getByRole('heading', {name: 'Mária 🌿', exact: true}).waitFor();
    } finally {
        await browser.close();
    }
}

runWithFixture(async () => {
    await audit('windows-chromium', chromium, {viewport: {width: 1280, height: 900}});
    await audit('mac-webkit', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}});
    await audit('android-chromium', chromium, devices['Pixel 7']);
    await audit('iphone-webkit', webkit, {...devices['iPhone 13'], viewport: {width: 320, height: 750}});
    console.log('PASS: profile layout, display rename, error recovery, profile menu propagation, and keyboard focus.');
}).catch(error => { console.error(error); process.exitCode = 1; });
