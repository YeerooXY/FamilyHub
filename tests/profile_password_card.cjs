// Rendered check of the profile password card (sign in and create) on four browser/device profiles.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const output = path.resolve(root, process.env.PASSWORD_CAPTURE || '.local/profile-sign-in-review');
fs.mkdirSync(output, {recursive: true});
const profiles = [
    ['windows-chromium-1280', chromium, {viewport: {width: 1280, height: 900}}],
    ['mac-webkit-850', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}}],
    ['android-chrome-390', chromium, {...devices['Pixel 7'], viewport: {width: 390, height: 844}}],
    ['iphone-webkit-390', webkit, {...devices['iPhone 13'], viewport: {width: 390, height: 844}, reducedMotion: 'reduce'}]
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
                await page.addInitScript(() => {
                    const animate = Element.prototype.animate;
                    Element.prototype.animate = function (keyframes, timing) {
                        if (this.matches('.profile-sign-in-identity .profile-avatar')) window.avatarEntrance = {keyframes, timing};
                        return animate.call(this, keyframes, timing);
                    };
                });
                await page.request.post(origin + '/fixture/startup/' + scenario);
                await page.goto(origin + '/');
                const choice = page.locator('#profile-choice-fixture');
                const creating = scenario === 'password-create';
                if (options.hasTouch) await choice.tap();
                else await choice.press(creating ? 'Space' : 'Enter');
                const card = page.locator('.profile-password-card');
                await card.waitFor();
                const label = creating ? 'create' : 'signin';
                assert.equal(await card.locator('h1').innerText(), 'Yeeroo');
                assert.equal(await page.locator('.profile-choices').evaluate(element => element.inert), true);
                assert.equal(await card.locator('.profile-sign-in-identity .profile-avatar').count(), 1);
                await page.waitForFunction(() => document.activeElement?.id === 'profile-password', null, {timeout: 5000}).catch(() => assert.fail(name + ': password field has no focus'));
                const field = page.locator('#profile-password');
                assert.equal(await field.getAttribute('autocomplete'), creating ? 'new-password' : 'current-password');
                const submit = card.locator('button[type=submit]');
                await page.locator('.profile-choices').waitFor({state: 'hidden'});
                await card.locator('.profile-avatar').evaluate(avatar => Promise.all(avatar.getAnimations().map(animation => animation.finished)));
                const animation = await page.evaluate(() => window.avatarEntrance);
                if (options.reducedMotion === 'reduce') assert.equal(animation, undefined);
                else {
                    assert.match(animation?.keyframes[0].transform, /translate\(.+\) scale\(/);
                    assert.equal(animation.timing.duration, 280);
                }
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
                // Layout and usable touch targets.
                const box = await card.boundingBox();
                assert(box.x >= 0 && box.x + box.width <= options.viewport.width + 0.5, name + ': card inside width');
                const avatar = await card.locator('.profile-avatar').boundingBox();
                const main = await page.locator('main.entry-screen').boundingBox();
                assert(Math.abs(avatar.x + avatar.width / 2 - (main.x + main.width / 2)) < 2, name + ': selected avatar centered');
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': no horizontal overflow');
                const buttons = await card.locator('.password-actions button').evaluateAll(items => items.map(item => item.getBoundingClientRect()));
                assert(buttons.every(rect => rect.width >= 44 && rect.height >= 44), name + ': touch targets');
                // Keyboard: Tab from the field reaches the eye, then the submit; focus never falls to body
                await field.focus();
                await page.keyboard.press('Tab');
                assert(await page.evaluate(() => document.activeElement?.classList.contains('password-eye')), name + ': Tab reaches eye');
                await page.keyboard.press('Shift+Tab');
                assert.equal(await field.evaluate(input => input === document.activeElement), true);
                // Return to the same choice by keyboard or touch.
                if (options.hasTouch) await card.getByRole('button', {name: 'Back to profiles'}).tap();
                else await field.press('Escape');
                await card.waitFor({state: 'detached', timeout: 5000});
                await page.waitForFunction(() => document.activeElement?.id === 'profile-choice-fixture');
                await choice.press('Enter');
                await field.waitFor();
                if (!creating) {
                    await field.fill('incorrect password');
                    await disabled(page, false, name + ': typed password enables sign-in');
                    await field.press('Enter');
                    await card.getByRole('alert').getByText('Incorrect password. Try again.').waitFor();
                    await page.waitForFunction(() => document.activeElement?.id === 'profile-password');
                    await page.screenshot({path: path.join(output, `${name}-signin-error.png`), animations: 'disabled'});
                }
                await field.fill('long enough pass');
                if (creating) await card.locator('#profile-password-confirm').fill('long enough pass');
                await disabled(page, false, name + ': valid credentials enable sign-in');
                await submit.press('Enter');
                await card.waitFor({state: 'detached'});
                await page.waitForFunction(() => document.activeElement?.id === 'content' && !document.querySelector('.profile-picker'));
                await context.close();
            }
        } finally { await browser.close(); }
        console.log('ok', name);
    }
})().catch(error => { console.error(error); process.exit(1); });
