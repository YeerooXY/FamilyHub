const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const capture = process.env.WORDLE_CAPTURE;

async function openWordle(page) {
    await page.goto(origin);
    await page.getByRole('button', {name: /^Daily Wordle\b/}).click();
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
        await page.request.post(origin + '/fixture/startup/default');
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        await page.request.post(origin + '/fixture/wordle-member/-1/false');
        const panel = await openWordle(page);
        const june = panel.getByRole('button', {name: /^June, 1 of 6 guesses/});
        assert.equal(await june.locator('.dw-mini i').count(), 30);
        assert.equal(await june.locator('.dw-mini .correct').count(), 1);
        const keyboard = panel.getByRole('group', {name: 'On-screen keyboard'});
        const theme = panel.getByRole('button', {name: 'Dark theme'});
        const statsButton = panel.getByRole('button', {name: 'Statistics', exact: true});
        const stats = panel.locator('.dw-stats-page');
        const junePlayer = stats.getByRole('article', {name: /^June statistics/});
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
        assert.equal(await member.locator('.dw-inspect-count').count(), 0);
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
        // The statistics sit below the puzzle: the button scrolls there and focuses the heading.
        await statsButton.press('Enter');
        await stats.getByRole('heading', {name: 'Statistics', exact: true}).waitFor();
        await page.waitForFunction(() => document.activeElement?.id === 'dw-stats-title');
        await junePlayer.locator('.dw-favorites').waitFor();
        assert.match(await junePlayer.locator('.dw-favorites').innerText(), /Favorite guesses\s+GRAPE/);
        assert.equal(await junePlayer.getByText('Today’s guesses').count(), 0);
        await stats.getByRole('button', {name: 'Back to puzzle'}).press('Enter');
        await page.waitForFunction(() => document.activeElement?.classList.contains('daily-wordle'));

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
        const dayText = await panel.locator('.dw-context').boundingBox();
        assert(!dayText || (dayText.width <= 1 && dayText.height <= 1), `${name} the day text is not drawn`);
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
        await stats.getByText('in 4 puzzles played').waitFor();
        await page.request.post(origin + '/fixture/wordle-member/-1/true');
        await panel.getByRole('button', {name: /^June, 2 of 6 guesses/}).press('Enter');
        await member.locator('.dw-inspect li[aria-label*="G, absent"]').waitFor();
        await member.getByText('(12 left)', {exact: true}).waitFor();
        await member.getByText('0:11 active time').waitFor();
        const bounds = await member.boundingBox();
        const viewport = page.viewportSize();
        assert(bounds.width >= Math.min(610, viewport.width - 30), `${name} member dialog is ${bounds.width}px wide`);
        assert(await member.evaluate(node => node.scrollWidth === node.clientWidth));
        await member.getByRole('heading', {name: 'June'}).click();
        assert(await member.isVisible());
        if (capture) await member.screenshot({path: path.join(capture, name + '-member.png')});
        if (options.isMobile) await page.touchscreen.tap(4, 4);
        else await page.mouse.click(4, 4);
        await member.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.id === 'dw-board-june');
        await theme.press('Enter');
        await statsButton.press('Enter');
        await stats.getByText('3 wins', {exact: true}).waitFor();
        await stats.getByText('2 of 2 finished').waitFor();
        await stats.getByText('4 days').first().waitFor();
        await stats.getByRole('heading', {name: 'Rounds won'}).waitFor();
        await junePlayer.getByText('Average guesses to solve').waitFor();
        await junePlayer.getByText('2.5', {exact: true}).waitFor();
        await junePlayer.getByText('Slowest word').waitFor();
        await junePlayer.getByText('Today’s guesses').waitFor();
        await junePlayer.locator('summary').press('Enter');
        assert.match(await junePlayer.locator('.dw-inspect li').first().getAttribute('aria-label'), /G, absent.*R, right spot/);
        // Grade icons and times keep one column each, however long the "(N left)" text is.
        const inspectRows = junePlayer.locator('.dw-inspect-meta');
        const columns = await inspectRows.evaluateAll(rows => rows.map(row => ({
            icon: Math.round(row.querySelector('.dw-grade-icon')?.getBoundingClientRect().left ?? -1),
            time: Math.round(row.querySelector('.dw-guess-time')?.getBoundingClientRect().right ?? -1)})));
        assert(columns.length > 1 && new Set(columns.map(column => column.icon)).size === 1, `${name} grade icons share a column: ${JSON.stringify(columns)}`);
        assert(new Set(columns.map(column => column.time)).size === 1, `${name} guess times share a column`);
        assert(await stats.evaluate(node => node.scrollWidth <= node.clientWidth), `${name} statistics fit the width`);
        if (capture) await stats.screenshot({path: path.join(capture, name + '-stats.png')});
        await stats.getByRole('button', {name: 'Back to puzzle'}).press('Enter');
        await page.waitForFunction(() => document.activeElement?.classList.contains('daily-wordle'));
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
        await page.getByRole('button', {name: /^Daily Wordle\b/}).click();
        await page.waitForFunction(() => document.querySelector('.daily-wordle')?.dataset.playing === 'true');
        assert.equal(await page.getByRole('button', {name: /^June,/}).count(), 0);
        console.log('Wordle spoiler setting saved and hid family boards');
    } finally { await browser.close(); }
}

async function recapOnce() {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({reducedMotion: 'reduce'});
        await page.request.post(origin + '/fixture/startup/wordle-recap');
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        await page.request.post(origin + '/fixture/wordle-member/-1/false');
        const panel = await openWordle(page);
        const recap = page.getByRole('dialog', {name: 'Yesterday’s results'});
        await recap.waitFor();
        await recap.getByText('GRAPE', {exact: true}).waitFor();
        await recap.getByText('Hard Mode rules', {exact: true}).waitFor();
        assert.match(await recap.getByRole('listitem').first().getAttribute('aria-label'), /^1\. June, solved in 3 guesses, 0:41 active time, Hard Mode rules, won the round/);
        await recap.getByText('Did not play: Sam').waitFor();
        await page.keyboard.press('Escape');
        await recap.waitFor({state: 'hidden'});
        assert(await page.evaluate(() => document.activeElement !== document.body), 'closing the recap keeps focus on the page');
        // The same day shows it once: leaving and coming back does not open it again.
        await page.locator('#open-hub').click();
        await page.getByRole('button', {name: /^Daily Wordle\b/}).click();
        await page.getByRole('heading', {name: 'Wordle', exact: true}).waitFor();
        await page.waitForFunction(() => document.querySelector('.daily-wordle')?.dataset.playing === 'true');
        await page.waitForTimeout(600);
        assert.equal(await recap.isVisible(), false);
        console.log('Yesterday’s results opened once and returned focus');
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
        await panel.locator('.dw-stats-page').getByRole('heading', {name: 'Winning guesses'}).waitFor();
        console.log('Live family presence, draft deletion, committed tiles, focus and flip timing passed');
    } finally {
        await member(-1);
        await browser.close();
    }
}

async function resultsPopup(scenario, reducedMotion) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({viewport: {width: 1280, height: 900}, reducedMotion});
        await page.request.post(origin + '/fixture/startup/' + scenario);
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        const panel = await openWordle(page);
        const lucky = scenario === 'wordle-lucky';
        const guesses = lucky ? ['crate'] : ['slate', 'brave', 'audio', 'whisk', 'frost', 'roast'];
        for (const [index, word] of guesses.entries()) {
            await panel.focus();
            await page.keyboard.type(word);
            await page.keyboard.press('Enter');
            await panel.locator('.dw-row').nth(index).locator('.dw-reveal').first().waitFor();
        }
        const result = panel.getByRole('dialog', {name: 'Alex'});
        if (reducedMotion !== 'reduce') assert.equal(await result.isVisible(), false);
        await result.getByRole('heading', {name: lucky ? 'Lucky guess' : 'Unlucky finish'}).waitFor();
        await result.getByText('0:23 active time').waitFor();
        await result.getByText(lucky ? '(0 left)' : '(1 left)', {exact: true}).waitFor();
        if (!lucky) {
            await result.getByRole('button', {name: 'Guess 2: Inaccuracy'}).press('Enter');
            await result.getByText('Speed rank 1 of 5 among Inaccuracy guesses.').waitFor();
            await result.getByText('Suggested guess CRANE.').waitFor();
        }
        if (capture) await result.screenshot({path: path.join(capture, scenario + '.png')});
        await result.getByRole('button', {name: 'Close family board'}).press('Space');
        await result.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Statistics');
        if (lucky) {
            assert.equal(await panel.locator('.dw-family-card').first().getAttribute('id'), 'dw-board-june');
            await panel.locator('#dw-board-june').press('Enter');
            await panel.getByRole('dialog', {name: 'June'}).getByText('0:11 active time').waitFor();
        }
        console.log(scenario + ' result, active time, guess counts and focus passed');
    } finally { await browser.close(); }
}

async function ordinaryWinReview(name, engine, options) {
    const browser = await engine.launch();
    try {
        const page = await browser.newPage({...options, colorScheme: 'dark', reducedMotion: name === 'iphone-webkit' ? 'reduce' : 'no-preference'});
        await page.request.post(origin + '/fixture/startup/default');
        await page.request.post(origin + '/fixture/wordle-reset/86400');
        const panel = await openWordle(page);
        for (const [index, word] of ['slate', 'crate'].entries()) {
            await panel.focus();
            await page.keyboard.type(word);
            await page.keyboard.press('Enter');
            await panel.locator('.dw-row').nth(index).locator('.dw-reveal').first().waitFor();
        }
        const result = panel.getByRole('dialog', {name: 'Alex'});
        assert.equal(await result.isVisible(), false);
        await result.getByText('Solved in 2 guesses').waitFor();
        await result.getByText('Played with hard-mode rules', {exact: true}).waitFor();
        await result.locator('.dw-guess-time').filter({hasText: '0:04'}).waitFor();
        await result.locator('.dw-guess-time').filter({hasText: '0:18'}).waitFor();
        const book = result.getByRole('button', {name: 'Guess 1: Book'});
        const best = result.getByRole('button', {name: 'Guess 2: Best'});
        await page.keyboard.press('Tab');
        assert(await book.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Enter');
        await result.getByText('A strong opening word. It tests common letters in useful places.').waitFor();
        assert(await book.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Tab');
        assert(await best.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Shift+Tab');
        assert(await book.evaluate(node => node === document.activeElement));
        await page.keyboard.press('Space');
        await result.locator('.dw-grade-detail').waitFor({state: 'hidden'});
        if (options.hasTouch) {
            await best.tap();
            await result.getByText('No other word does better from here.').waitFor();
            await best.tap();
        }
        assert(await result.evaluate(node => node.scrollWidth <= node.clientWidth));
        assert.equal(await page.request.get(origin + '/wordle-grades.png').then(r => r.status()), 200);
        if (capture) await result.screenshot({path: path.join(capture, name + '-review.png')});
        await result.getByRole('button', {name: 'Close family board'}).press('Space');
        await result.waitFor({state: 'hidden'});
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Statistics');
        console.log(name + ' ordinary win opened review with ratings, per-guess time and preserved keyboard focus');
    } finally { await browser.close(); }
}

async function boardFit() {
    const shots = capture || path.resolve(root, 'docs/verification/wordle-fit-2026-11-23');
    require('node:fs').mkdirSync(shots, {recursive: true});
    const profiles = [
        ['pixel7-412x915', chromium, {...devices['Pixel 7'], viewport: {width: 412, height: 915}}],
        ['iphone-390x844', webkit, {...devices['iPhone 13'], viewport: {width: 390, height: 844}}],
        ['iphone-se-375x667', webkit, {...devices['iPhone 13'], viewport: {width: 375, height: 667}}],
        ['desktop-1280x800', chromium, {viewport: {width: 1280, height: 800}}]
    ];
    for (const [name, engine, options] of profiles) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage({...options, colorScheme: 'light', reducedMotion: 'reduce'});
            await page.request.post(origin + '/fixture/wordle-reset/86400');
            await page.request.post(origin + '/fixture/wordle-member/-1/false');
            const panel = await openWordle(page);
            await page.waitForTimeout(300);
            const m = await page.evaluate(() => {
                const rect = selector => document.querySelector(selector).getBoundingClientRect();
                const area = document.querySelector('.dw-play-area');
                const wordle = document.querySelector('.daily-wordle');
                const rows = document.querySelectorAll('.dw-row');
                const tile = rect('.dw-tile');
                return {
                    row6Bottom: rows[5].getBoundingClientRect().bottom, keyboardTop: rect('.dw-keyboard').top,
                    keyboardBottom: rect('.dw-keyboard').bottom, innerHeight,
                    docScroll: document.documentElement.scrollHeight - document.documentElement.clientHeight,
                    areaScroll: area.scrollHeight - area.clientHeight,
                    overflowX: wordle.scrollWidth - wordle.clientWidth, docOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                    tile: Math.round(tile.width * 10) / 10, tileSquare: Math.abs(tile.width - tile.height) < 0.6,
                    keyHeight: rect('.dw-key').height, boardTop: rect('.dw-board').top
                };
            });
            console.log(name, JSON.stringify(m));
            assert(m.row6Bottom <= m.keyboardTop, `${name} row 6 bottom ${m.row6Bottom} is below keyboard top ${m.keyboardTop}`);
            assert(m.docScroll <= 0, `${name} document scrolls by ${m.docScroll}px`);
            assert(m.areaScroll <= 0, `${name} play area scrolls by ${m.areaScroll}px`);
            assert(m.overflowX <= 0 && m.docOverflowX <= 0, `${name} has horizontal overflow`);
            assert(m.tileSquare && m.tile >= 36, `${name} tile ${m.tile}px`);
            assert(m.keyboardBottom <= m.innerHeight, `${name} keyboard is cut off`);
            await page.screenshot({path: path.join(shots, name + '.png')});
        } finally { await browser.close(); }
    }
    console.log('Wordle six rows fit above the keyboard without scrolling on four viewports');
}

(async () => {
    if (process.env.WORDLE_ONLY === 'fit') { await boardFit(); return; }
    for (const [name, engine, profile] of [
        ['windows-chromium', chromium, {viewport: {width: 1280, height: 900}}],
        ['mac-webkit', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}}],
        ['android-chromium', chromium, {...devices['Pixel 7'], viewport: {width: 390, height: 844}}],
        ['iphone-webkit', webkit, {...devices['iPhone 13'], viewport: {width: 320, height: 750}}]
    ]) {
        if (process.env.WORDLE_ONLY !== 'grades') await dailyPlay(name, engine, profile);
        await ordinaryWinReview(name, engine, profile);
    }
    if (process.env.WORDLE_ONLY === 'grades') return;
    await boardFit();
    await recapOnce();
    await rollover();
    await localScoring();
    await liveFamily();
    await preferences();
    await resultsPopup('wordle-lucky', 'no-preference');
    await resultsPopup('wordle-unlucky', 'reduce');
})().catch(error => { console.error(error); process.exitCode = 1; });
