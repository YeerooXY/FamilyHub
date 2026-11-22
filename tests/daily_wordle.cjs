const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const capture = process.env.WORDLE_CAPTURE;

async function openWordle(page) {
    await page.goto(origin);
    await page.getByRole('button', {name: 'Daily Wordle', exact: true}).click();
    await page.getByRole('heading', {name: 'Wordle', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Submit guess', exact: true}).waitFor();
    await page.waitForFunction(() => document.querySelector('.daily-wordle')?.dataset.playing === 'true');
    await page.waitForFunction(() => document.querySelector('.daily-wordle')?.dataset.theme);
    return page.locator('.daily-wordle');
}

async function dailyPlay(name, engine, options) {
    const browser = await engine.launch();
    try {
        const page = await browser.newPage({...options, colorScheme: 'light', reducedMotion: 'reduce'});
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        const panel = await openWordle(page);
        const june = panel.getByRole('button', {name: /^June, 1 of 6 guesses/});
        assert.equal(await june.locator('.dw-mini i').count(), 30);
        assert.equal(await june.locator('.dw-mini .correct').count(), 1);
        const keyboard = panel.getByRole('group', {name: 'On-screen keyboard'});
        const theme = panel.getByRole('button', {name: 'Dark theme'});
        const statsButton = panel.getByRole('button', {name: 'Statistics', exact: true});
        const stats = panel.getByRole('dialog', {name: 'Statistics'});
        const juneDetails = stats.locator('details').filter({has: page.locator('summary').filter({hasText: 'June'})});
        const status = panel.locator('.dw-message');
        const row = number => panel.locator('.dw-row').nth(number - 1);
        const typed = async word => {
            await panel.focus();
            await page.keyboard.type(word);
            await panel.getByRole('group', {name: new RegExp(word.toUpperCase().split('').join(', '))}).waitFor();
        };
        const erase = async () => { for (let i = 0; i < 5; i++) await keyboard.getByRole('button', {name: 'Delete last letter'}).click(); };

        assert.equal(await theme.getAttribute('aria-pressed'), 'false');
        assert.equal(await panel.evaluate(node => node.scrollWidth <= node.clientWidth), true);
        assert.equal(await keyboard.locator('.dw-key').count(), 28);
        const checkKeyboard = async () => {
            const bounds = await keyboard.boundingBox();
            const bottomGap = await page.evaluate(() => innerHeight) - bounds.y - bounds.height;
            assert(bottomGap >= 0 && bottomGap <= 20, name + ' keyboard gap ' + bottomGap);
            assert.deepEqual(await keyboard.getByRole('button', {name: 'Q', exact: true})
                .evaluate(el => [getComputedStyle(el).color, getComputedStyle(el).backgroundColor]),
                ['rgb(255, 255, 255)', 'rgb(129, 131, 132)']);
        };
        await checkKeyboard();
        await panel.focus();
        await page.keyboard.press('Tab');
        assert(await panel.getByRole('button', {name: /^Alex \(you\),/}).evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        assert(await june.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Space');
        const member = panel.getByRole('dialog', {name: 'June'});
        await member.getByText('Finish your puzzle to see the letters.').waitFor();
        assert.equal(await member.locator('.dw-inspect li > span:nth-child(2)').first().textContent(), '');
        await page.keyboard.press('Escape');
        await member.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.id === 'dw-board-june');
        await page.keyboard.press('Tab');
        const helpButton = panel.getByRole('button', {name: 'How to play'});
        assert(await helpButton.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Space');
        const help = panel.getByRole('dialog', {name: 'How to play'});
        await help.waitFor();
        await page.keyboard.press('Escape');
        await help.waitFor({state: 'hidden'});
        assert(await helpButton.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        assert(await panel.getByRole('button', {name: 'Statistics', exact: true}).evaluate(node => node === document.activeElement));
        await page.keyboard.press('Shift+Tab');
        assert(await helpButton.evaluate(node => node === document.activeElement));
        await theme.press('Enter');
        assert.equal(await theme.getAttribute('aria-pressed'), 'true');
        assert(await theme.evaluate(node => node === document.activeElement));
        await checkKeyboard();
        if (capture) await panel.screenshot({path: path.join(capture, name + '-dark.png')});
        await statsButton.press('Enter');
        await juneDetails.locator('summary').press('Enter');
        await juneDetails.getByText('2 guesses', {exact: true}).waitFor();
        assert.equal(await juneDetails.getByRole('heading', {name: 'Today’s guesses'}).count(), 0);
        await page.keyboard.press('Escape');
        await stats.waitFor({state: 'hidden'});

        if (options.isMobile) {
            for (const letter of 'SLATE') await keyboard.getByRole('button', {name: letter, exact: true}).tap();
            await keyboard.getByRole('button', {name: 'Submit guess'}).tap();
        } else {
            await theme.press('Space');
            const selectedTheme = await theme.getAttribute('aria-pressed');
            assert(await theme.evaluate(node => node === document.activeElement));
            await page.keyboard.type('slate');
            await page.keyboard.press('Enter');
            assert.equal(await theme.getAttribute('aria-pressed'), selectedTheme);
        }
        await row(1).getByText('S').waitFor();
        await row(1).locator('.dw-reveal').first().waitFor();
        assert.doesNotMatch(await panel.locator('.dw-context').innerText(), /\/6 guesses/);
        assert.match(await row(1).getAttribute('aria-label'), /S, absent.*A, right spot/);
        assert.deepEqual(await row(1).locator('.dw-tile span').evaluateAll(letters =>
            letters.map(letter => getComputedStyle(letter).color)), Array(5).fill('rgb(255, 255, 255)'));
        assert.equal(await row(1).locator('.dw-reveal').first().evaluate(node => getComputedStyle(node).animationName), 'none');
        if (capture) await panel.screenshot({path: path.join(capture, name + '-guess.png')});
        await typed('zzzzz');
        await page.keyboard.press('Enter');
        await status.getByText('This word isn’t accepted. Try another.').waitFor();
        assert.equal(await row(2).locator('.dw-filled').count(), 5);
        await erase();
        await typed('plate');
        await page.keyboard.press('Enter');
        await status.getByText('The puzzle changed. Check your guesses and try again.').waitFor();
        assert.match(await row(2).getAttribute('aria-label'), /B, absent/);
        await erase();
        await typed('crate');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Statistics');
        assert.equal(await panel.getByText('Solved in 3 guesses', {exact: true}).isVisible(), false);
        assert.equal(await panel.getByRole('button', {name: 'View results'}).count(), 0);
        if (!options.isMobile) await panel.getByRole('complementary', {name: 'Family statistics'}).getByText('4 puzzles', {exact: false}).waitFor();
        await june.press('Enter');
        await member.locator('.dw-inspect li[aria-label*="G, absent"]').waitFor();
        await page.keyboard.press('Escape');
        await member.waitFor({state: 'hidden'});
        await theme.press('Enter');
        await statsButton.press('Enter');
        await stats.getByText('Solved in 3 guesses', {exact: true}).waitFor();
        await stats.getByText('3 wins in 4 puzzles').waitFor();
        await stats.getByText('2 of 2 finished · 2 solved').waitFor();
        assert(await stats.getByRole('button', {name: 'Close statistics'}).evaluate(node => node === document.activeElement));
        await juneDetails.getByRole('heading', {name: 'Today’s guesses'}).waitFor();
        assert.match(await juneDetails.locator('.dw-inspect li').getAttribute('aria-label'), /G, absent.*R, right spot/);
        await juneDetails.getByText('3 guesses', {exact: true}).waitFor();
        if (capture) await stats.screenshot({path: path.join(capture, name + '-stats.png')});
        await page.keyboard.press('Escape');
        await stats.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Statistics');
        assert.deepEqual(errors, []);
        console.log(name + ' Wordle board, guesses, conflict, results, theme and focus passed');
    } finally { await browser.close(); }
}

async function preferences() {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        await page.goto(origin);
        await page.locator('#profile-toggle').click();
        await page.locator('#open-settings').click();
        await page.locator('#settings-wordle').click();
        const setting = page.getByRole('checkbox', {name: 'Hide family results until I finish'});
        await setting.check();
        await page.getByText('Wordle settings saved.', {exact: true}).waitFor();
        assert(await setting.evaluate(node => node === document.activeElement));
        await page.locator('#open-hub').click();
        await page.getByRole('button', {name: 'Daily Wordle', exact: true}).click();
        await page.waitForFunction(() => document.querySelector('.daily-wordle')?.dataset.playing === 'true');
        assert.equal(await page.getByRole('button', {name: /^June,/}).count(), 0);
        console.log('Wordle spoiler setting saved and hid family boards');
    } finally { await browser.close(); }
}

async function rollover() {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.request.post(origin + '/fixture/wordle-reset/8');
        const panel = await openWordle(page);
        const before = await panel.locator('.dw-context span').first().textContent();
        await panel.focus();
        await page.keyboard.type('crate');
        await panel.getByRole('group', {name: 'Guess 1: C, R, A, T, E'}).waitFor();
        await page.keyboard.press('Enter');
        await panel.locator('.dw-win').first().waitFor();
        await page.waitForFunction(previous => {
            const wordle = document.querySelector('.daily-wordle');
            return wordle?.dataset.playing === 'true' && wordle.querySelector('.dw-context span')?.textContent !== previous;
        }, before, {timeout: 10000});
        assert.equal(await panel.locator('.dw-row .dw-tile span').allTextContents().then(letters => letters.join('')), '');
        await page.waitForFunction(() => document.querySelector('.daily-wordle')?.contains(document.activeElement));
        console.log('Open finished puzzle advanced automatically at reset');
    } finally { await browser.close(); }
}

async function localScoring() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
        await page.request.post(origin + '/fixture/startup/wordle-delayed');
        const panel = await openWordle(page);
        const submit = async word => {
            await panel.focus();
            await page.keyboard.type(word);
            await panel.getByRole('group', {name: new RegExp(word.toUpperCase().split('').join(', '))}).waitFor();
            await page.keyboard.press('Enter');
        };
        await submit('zzzzz');
        await panel.getByText(/Try another/).waitFor({timeout: 1000});
        for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        await submit('eerie');
        const started = Date.now();
        await panel.locator('.dw-row').first().locator('.dw-reveal').first().waitFor({timeout: 1000});
        assert.match(await panel.locator('.dw-row').first().getAttribute('aria-label'), /E, absent, E, absent, R, different spot, I, absent, E, right spot/);
        await submit('eerie');
        await panel.getByText('Already guessed.', {exact: true}).waitFor({timeout: 1000});
        assert.equal(await panel.locator('.dw-row').nth(1).locator('.dw-filled').count(), 5);
        for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
        await submit('crate');
        await panel.locator('.dw-row').nth(1).locator('.dw-win').first().waitFor({timeout: 1000});
        assert(Date.now() - started < 4000, 'Second guess waited for the first save');
        console.log('Local scoring accepted two rows before the delayed server save.');
    } finally {
        await page.request.post(origin + '/fixture/startup/default');
        await browser.close();
    }
}

async function liveFamily() {
    const browser = await chromium.launch();
    const page = await browser.newPage({reducedMotion: 'no-preference'});
    const member = (count, submitted = false) => page.request.post(`${origin}/fixture/wordle-member/${count}/${submitted}`);
    try {
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        await member(-1);
        const panel = await openWordle(page);
        const june = panel.getByRole('button', {name: /^June,/});
        const theme = panel.getByRole('button', {name: 'Dark theme'});
        await theme.focus();
        await member(0);
        await june.locator('.dw-playing-dot').waitFor({timeout: 1000});
        for (const count of [1, 3, 2, 0]) {
            await member(count);
            await page.waitForFunction(expected =>
                document.querySelectorAll('.dw-family-card[aria-label^="June,"] .dw-draft').length === expected,
                count, {timeout: 1000});
        }
        await june.focus();
        await member(0, true);
        await page.waitForFunction(() => document.querySelector('.dw-family-card[aria-label^="June, 2 of 6"]'), null, {timeout: 1000});
        assert.equal(await june.locator('.dw-mini .correct').count(), 6);
        assert.equal(await panel.locator('.dw-family-card').first().getAttribute('id'), 'dw-board-june');
        await page.waitForFunction(() => document.activeElement?.id === 'dw-board-june');
        await member(-1, true);
        await june.locator('.dw-playing-dot').waitFor({state: 'hidden', timeout: 1000});

        await panel.focus();
        const outgoing = count => page.waitForFunction(async ({ origin, count }) => {
            const state = await fetch(origin + '/fixture/wordle-activity').then(response => response.json());
            return state.row === 0 && state.draft_count === count && !Object.hasOwn(state, 'word');
        }, {origin, count}, {timeout: 1000, polling: 50});
        await page.keyboard.type('sl');
        await outgoing(2);
        await page.keyboard.press('Backspace');
        await outgoing(1);
        await page.keyboard.press('Backspace');
        await outgoing(0);
        await page.keyboard.type('slate');
        await page.keyboard.press('Enter');
        const flip = panel.locator('.dw-row').first().locator('.dw-reveal');
        await flip.last().waitFor();
        assert.deepEqual(await flip.evaluateAll(nodes => nodes.map(node => {
            const style = getComputedStyle(node);
            return [style.animationDuration, style.animationDelay];
        })), [['0.25s, 0.25s', '0s, 0.25s'], ['0.25s, 0.25s', '0.3s, 0.55s'],
            ['0.25s, 0.25s', '0.6s, 0.85s'], ['0.25s, 0.25s', '0.9s, 1.15s'], ['0.25s, 0.25s', '1.2s, 1.45s']]);
        await page.keyboard.type('audio');
        await page.keyboard.press('Enter');
        await panel.locator('.dw-row').nth(1).locator('.dw-reveal').last().waitFor();
        await page.keyboard.type('crate');
        await page.keyboard.press('Enter');
        await panel.locator('.dw-row').nth(2).locator('.dw-win').last().waitFor();
        assert.equal(await panel.locator('.dw-family-card').first().getAttribute('id'), 'dw-board-june');
        await panel.getByRole('complementary', {name: 'Family statistics'}).getByRole('heading', {name: 'Winning guesses'}).waitFor();
        const [center, aside] = await Promise.all([panel.locator('.dw-shell').boundingBox(), panel.locator('.dw-server-stats').boundingBox()]);
        assert(aside.x >= center.x + center.width);
        console.log('Live family presence, draft deletion, committed tiles, focus and flip timing passed');
    } finally {
        await member(-1);
        await browser.close();
    }
}

(async () => {
    for (const [name, engine, profile] of [
        ['windows-chromium', chromium, {viewport: {width: 1280, height: 900}}],
        ['mac-webkit', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}}],
        ['android-chromium', chromium, {...devices['Pixel 7'], viewport: {width: 390, height: 844}}],
        ['iphone-webkit', webkit, {...devices['iPhone 13'], viewport: {width: 320, height: 750}}]
    ]) await dailyPlay(name, engine, profile);
    await rollover();
    await localScoring();
    await liveFamily();
    await preferences();
})().catch(error => { console.error(error); process.exitCode = 1; });
