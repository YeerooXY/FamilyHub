const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

async function audit(browserType, options) {
    const browser = await browserType.launch();
    try {
        const page = await browser.newPage(options);
        await page.goto(origin);
        const profile = page.locator('#profile-toggle');
        await profile.click();
        await page.locator('#open-settings').click();
        const name = page.getByLabel('Display name', {exact: true});
        const save = page.getByRole('button', {name: 'Save name', exact: true});
        assert.equal(await name.inputValue(), 'Alex');
        assert.equal(await save.getAttribute('aria-disabled'), 'true');
        await name.fill('June');
        await page.locator('#profile-save-name:not([aria-disabled])').waitFor();
        await name.press('Enter');
        await page.getByText('A profile with this name already exists.', {exact: true}).waitFor();
        assert.equal(await name.evaluate(el => el === document.activeElement), true);
        assert.equal(await profile.evaluate(el => el.title || el.dataset.tooltip), 'Alex');
        await name.fill('  Mária 🌿  ');
        await page.keyboard.press('Tab');
        assert.equal(await save.evaluate(el => el === document.activeElement), true);
        await save.press('Space');
        await page.getByText('Display name saved.', {exact: true}).waitFor();
        assert.equal(await name.inputValue(), 'Mária 🌿');
        assert.equal(await save.evaluate(el => el === document.activeElement), true);
        await page.keyboard.press('Shift+Tab');
        assert.equal(await name.evaluate(el => el === document.activeElement), true);
        assert.equal(await name.evaluate(el => el.closest('section').scrollWidth <= el.closest('section').clientWidth), true);
        await profile.click();
        await page.getByRole('heading', {name: 'Mária 🌿', exact: true}).waitFor();
    } finally {
        await browser.close();
    }
}

(async () => {
    await audit(chromium, {viewport: {width: 1280, height: 900}});
    await audit(chromium, devices['Pixel 7']);
    await audit(webkit, devices['iPhone 13']);
    console.log('PASS: display rename, error recovery, profile menu propagation, and keyboard focus.');
})().catch(error => { console.error(error); process.exitCode = 1; });
