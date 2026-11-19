const assert = require('node:assert/strict');
const { mkdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const origin = process.env.FAMILYHUB_TEST_ORIGIN;
const imagePath = process.env.FAMILYHUB_TEST_PROFILE_IMAGE;
const captures = process.env.FAMILYHUB_TEST_CAPTURES;
if (!origin || !imagePath) throw new Error('Set FAMILYHUB_TEST_ORIGIN and FAMILYHUB_TEST_PROFILE_IMAGE for an isolated family-mode fixture.');
const waitForFocus = (page, id) => page.waitForFunction(id => document.activeElement.id === id, id);

async function checkNativeOptions(context) {
    const app = path.join(__dirname, '../clients/FamilyHub.App');
    const read = file => readFile(path.join(app, file), 'utf8');
    const [source, reporting, styles] = await Promise.all([
        read('Components/Pages/Music.razor'), read('Components/ReportSong.razor'), read('wwwroot/player-native.css'),
    ]);
    const backdrop = source.match(/<(button|div) class="player-tools-backdrop"[^>]*><\/\1>/)[0];
    const close = source.match(/<button id="player-options-close".*?<\/button>/)[0];
    const report = reporting.match(/<button id="report-song".*?<\/button>/)[0];
    const page = await context.newPage();
    try {
        await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style>
            <footer class="player-bar">${backdrop}<div class="player-tools is-open">${close}${report}</div></footer>`
            .replaceAll(/ @onclick="[^"]*"/g, ''));
        assert.equal(await page.getByRole('button', { name: 'Close player options', exact: true }).count(), 1);
        assert.equal(await page.locator('.player-tools-backdrop').evaluate(node => node.tabIndex), -1);
        const reportButton = page.getByRole('button', { name: 'Report song', exact: true });
        assert.equal(await reportButton.innerText(), '');
        assert.equal(await reportButton.evaluate(node => getComputedStyle(node, '::after').content), '"Report song"');
    } finally { await page.close(); }
}

async function check(page, name, touch, image) {
    await page.goto(origin);
    const choice = page.getByRole('button', { name: 'sample-a', exact: true });
    await choice.focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator(':focus').getByText('sample-b').count(), 1);
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    await page.waitForURL(origin + '/');
    await page.getByText('No saved songs yet.').waitFor();
    const token = await page.locator('meta[name=csrf-token]').getAttribute('content');
    const result = await page.request.post(origin + '/api/profile/image', {
        headers: { Origin: origin, 'X-CSRFToken': token }, data: { image }
    });
    assert.equal(result.status(), 200, await result.text());

    const opener = page.locator('#connect-open');
    if (touch) await opener.tap();
    else { await opener.focus(); await page.keyboard.press('Space'); }
    await waitForFocus(page, 'connect-close');
    await page.keyboard.press('Tab');
    await waitForFocus(page, 'output-summary');
    await page.keyboard.press('Shift+Tab');
    await waitForFocus(page, 'connect-close');
    await page.keyboard.press('Escape');
    await waitForFocus(page, 'connect-open');
    if (name === 'android') {
        await opener.tap();
        await page.locator('#connect-panel[open]').waitFor();
        const grip = await page.locator('.connect-header').boundingBox();
        const cdp = await page.context().newCDPSession(page);
        const touchPoint = y => [{ x: grip.x + 24, y }];
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touchPoint(grip.y + 24) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touchPoint(grip.y + 80) });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.locator('#connect-panel[open]').waitFor({ state: 'hidden' });
        await waitForFocus(page, 'connect-open');
        await cdp.detach();
    }

    const openSettings = async () => {
        await page.locator('#profile-toggle').press('Enter');
        await page.locator('#nav-settings').waitFor();
        if (touch) await page.locator('#nav-settings').tap();
        else {
            await waitForFocus(page, 'nav-settings');
            await page.keyboard.press('Enter');
        }
        await page.getByRole('region', { name: 'Settings', exact: true }).waitFor();
    };
    await opener.click();
    await page.locator('#connect-panel[open]').waitFor();
    const focusedAfterClosing = await page.evaluate(() => new Promise(resolve => {
        const panel = document.getElementById('connect-panel');
        panel.addEventListener('close', () => resolve(document.activeElement.id), { once: true });
        panel.close();
        document.getElementById('profile-toggle').focus();
    }));
    assert.equal(focusedAfterClosing, 'profile-toggle');
    await page.locator('#profile-toggle').press('Enter');
    await waitForFocus(page, 'nav-settings');
    await page.keyboard.press('Escape');
    await waitForFocus(page, 'profile-toggle');
    await openSettings();
    await page.locator('#fade').fill('7');
    await page.locator('#fade').press('Tab');
    await page.reload();
    await openSettings();
    assert.equal(await page.locator('#fade').inputValue(), '7');
    const portrait = page.viewportSize();
    if (name === 'windows' || touch) {
        await page.setViewportSize(touch ? { width: 740, height: 390 } : { width: 850, height: 640 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewportSize(portrait);
    }

    // Switching profiles in a second tab rotates the shared cookie's CSRF token.
    const other = await page.context().newPage();
    await other.goto(origin);
    const latestToken = await other.locator('meta[name=csrf-token]').getAttribute('content');
    const resultOfSwitch = await other.evaluate(async csrf => {
        const result = await fetch('/login', {
            method: 'POST', body: new URLSearchParams({ csrf_token: csrf, profile_id: 'sample-b' })
        });
        return { status: result.status, switched: (await result.text()).includes('data-user="sample-b"') };
    }, latestToken);
    assert.deepEqual(resultOfSwitch, { status: 200, switched: true });
    await other.close();
    const switchProfile = page.getByRole('button', { name: 'Switch profile', exact: true });
    const rejected = page.waitForResponse(response => response.url().endsWith('/logout') && response.status() === 400);
    await switchProfile.click();
    await rejected;
    await page.getByRole('alert').filter({ hasText: 'Reload FamilyHub' }).waitFor();
    if (captures) await page.screenshot({ path: `${captures}/expired-${name}.png`, scale: 'css' });
    await Promise.all([
        page.waitForURL(origin + '/'),
        page.getByRole('link', { name: 'Reload FamilyHub' }).click(),
    ]);
    await openSettings();
    await page.getByRole('button', { name: 'Switch profile', exact: true }).click();
    await choice.waitFor();
    await page.waitForFunction(() => {
        const image = document.querySelector('.family-profile img');
        return image?.complete && image.naturalWidth > 0;
    });
    assert.equal(await choice.locator('img').getAttribute('alt'), '');
    if (captures) await page.screenshot({ path: `${captures}/chooser-${name}.png`, scale: 'css' });

    await choice.click();
    await page.getByText('No saved songs yet.').waitFor();
    await page.clock.install();
    const requested = page.waitForRequest('**/api/library?genre_filters=1');
    await page.route('**/api/library?genre_filters=1', () => {});
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await requested;
    await page.clock.fastForward(16_000);
    await page.locator('#library-error').filter({ hasText: /timed out.*Refresh/ }).waitFor();
    await page.unroute('**/api/library?genre_filters=1');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByText('No saved songs yet.').waitFor();
    assert.equal(await page.locator('#library-error').innerText(), '');
    console.log(name, 'passed');
}

(async () => {
    if (captures) await mkdir(captures, { recursive: true });
    const image = 'data:image/jpeg;base64,' + (await readFile(imagePath)).toString('base64');
    for (const [name, engine, profile, touch] of [
        ['windows', chromium, { viewport: { width: 1280, height: 800 } }, false],
        ['mac', webkit, { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 } }, false],
        ['android', chromium, { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }, true],
        ['iphone', webkit, devices['iPhone 13'], true],
    ]) {
        const browser = await engine.launch({ headless: true });
        try {
            const context = await browser.newContext({ ...profile, ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
            const page = await context.newPage();
            page.setDefaultTimeout(6500);
            await check(page, name, touch, image);
            if (touch) await checkNativeOptions(context);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
