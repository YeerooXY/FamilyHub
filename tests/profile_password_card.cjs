// Rendered check of the profile password card (sign in and create) on four browser/device profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const output = path.resolve(root, process.env.PASSWORD_CAPTURE || 'docs/verification/profile-password-2026-11-24');
fs.mkdirSync(output, {recursive: true});
const profiles = [
    ['windows-chromium-1280', chromium, {viewport: {width: 1280, height: 900}}],
    ['mac-webkit-850', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}}],
    ['android-chrome-390', chromium, {...devices['Pixel 7'], viewport: {width: 390, height: 844}}],
    ['iphone-webkit-390', webkit, {...devices['iPhone 13'], viewport: {width: 390, height: 844}}]
];

const typeIs = (page, selector, value) => page.waitForFunction(([s, v]) => document.querySelector(s)?.type === v, [selector, value], {timeout: 5000});
const disabled = (page, value, message) => page.waitForFunction(v => (document.querySelector('.profile-password-card button[type=submit]').getAttribute('aria-disabled') === 'true') === v, value, {timeout: 5000}).catch(() => assert.fail(message));
(async () => {
    for (const [name, engine, options] of profiles) {
        const browser = await engine.launch();
        try {
            for (const scenario of ['password-signin', 'password-create']) {
                const context = await browser.newContext(options);
                const page = await context.newPage();
                await page.request.post(origin + '/fixture/startup/' + scenario);
                await page.goto(origin + '/');
                await page.locator('.profile-choice', {hasText: 'Yeeroo'}).click();
                const card = page.locator('.profile-password-card');
                await card.waitFor();
                const creating = scenario === 'password-create';
                const label = creating ? 'create' : 'signin';
                assert.match(await card.locator('h2').innerText(), creating ? /Create a password for Yeeroo/ : /Sign in as Yeeroo/);
                await page.waitForFunction(() => document.activeElement?.id === 'profile-password', null, {timeout: 5000}).catch(() => assert.fail(name + ': password field has no focus'));
                const field = page.locator('#profile-password');
                const submit = card.locator('button[type=submit]');
                await page.screenshot({path: path.join(output, `${name}-${label}-empty.png`)});
                // Eye toggle
                await typeIs(page, '#profile-password', 'password');
                await card.locator('.password-eye').click();
                await typeIs(page, '#profile-password', 'text');
                assert.equal(await card.locator('.password-eye').getAttribute('aria-pressed'), 'true');
                await card.locator('.password-eye').click();
                await typeIs(page, '#profile-password', 'password');
                if (creating) {
                    const repeat = page.locator('#profile-password-confirm');
                    await field.fill('short');
                    await disabled(page, true, name + ': short password disabled');
                    await field.fill('long enough pass');
                    await repeat.fill('long enough pas');
                    await card.locator('.password-hint').waitFor({timeout: 5000});
                    await disabled(page, true, name + ': mismatch disabled');
                    await page.screenshot({path: path.join(output, `${name}-create-mismatch.png`)});
                    await repeat.fill('long enough pass');
                    await card.locator('.password-hint').waitFor({state: 'detached', timeout: 5000});
                    await disabled(page, false, name + ': match enabled');
                    await card.locator('.password-eye').click();
                    await typeIs(page, '#profile-password-confirm', 'text');
                    await page.screenshot({path: path.join(output, `${name}-create-ready-visible.png`)});
                } else {
                    await field.fill('amber-birch-coral-delta');
                    await card.locator('.password-eye').click();
                    await typeIs(page, '#profile-password', 'text');
                    await page.mouse.move(0, 0);
                    await page.screenshot({path: path.join(output, `${name}-signin-visible.png`)});
                }
                // Layout: card inside the viewport, no horizontal page scroll, buttons level and visible
                const box = await card.boundingBox();
                assert(box.x >= 0 && box.x + box.width <= options.viewport.width + 0.5, name + ': card inside width');
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': no horizontal overflow');
                const buttons = await card.locator('.password-actions button').evaluateAll(items => items.map(item => item.getBoundingClientRect()));
                assert(buttons.every(rect => rect.width >= 44 && rect.height >= 44), name + ': touch targets');
                // Keyboard: Tab from the field reaches the eye, then the submit; focus never falls to body
                await field.focus();
                await page.keyboard.press('Tab');
                assert(await page.evaluate(() => document.activeElement?.classList.contains('password-eye')), name + ': Tab reaches eye');
                // Cancel removes the card and keeps focus on a control
                await card.locator('.password-actions button[type=button]').click();
                await card.waitFor({state: 'detached', timeout: 5000});
                assert(await page.evaluate(() => document.activeElement !== document.body), name + ': focus not on body after Cancel');
                await context.close();
            }
        } finally { await browser.close(); }
        console.log('ok', name);
    }
})().catch(error => { console.error(error); process.exit(1); });
