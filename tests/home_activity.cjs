// Home activity: Online now, the leaderboard, and the Music tabs that moved.
// Needs the music-popup fixture host running (POPUP_URL, default http://127.0.0.1:38869).
// Set HOME_ACTIVITY_SLOW=1 to also wait out one 30 second refresh while the app is hidden.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(process.env.PLAYWRIGHT_MODULE ||
    require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';

const profiles = [
    ['1280', {viewport: {width: 1280, height: 900}}, false],
    ['2000', {viewport: {width: 2000, height: 1080}}, false],
    ['pixel7', devices['Pixel 7'], false],
    ['iphone13', devices['iPhone 13'], true],
];

const members = rows => JSON.stringify({members: rows});
const known = {
    alex: {id: 'fixture', name: 'Alex', kind: 'listening', title: 'Station Lights', subtitle: 'North Atlas', cover: 'Station0001'},
    june: {id: 'june', name: 'June', kind: 'watching', title: 'Harbor Lights', subtitle: 'Season 1, episode 2', poster: 'https://art.fixture.test/poster1.svg', progress: 0.4},
    sam: {id: 'sam', name: 'Sam', kind: 'wordle'},
    robin: {id: 'robin', name: 'Robin', kind: 'online'},
    kit: {id: 'kit', name: 'Kit', kind: 'online'},
};

async function start(page, scenario) {
    await page.request.post(origin + '/fixture/startup/' + scenario);
    await page.goto(origin + '/outage/playback');
    await page.getByRole('button', {name: /^Music\b/}).click();
}

async function setOnline(page, ...names) {
    await page.request.post(origin + '/fixture/online', {data: members(names.map(name => known[name])), headers: {'content-type': 'application/json'}});
}

// The playback fixture's buttons switch the app between hidden and visible. A script click leaves keyboard focus where it was.
const hideApp = page => page.evaluate(() => document.getElementById('fixture-background').click());
const showApp = page => page.evaluate(() => document.getElementById('fixture-resume').click());
const requests = async page => Number(await (await page.request.get(origin + '/fixture/online-requests')).text());

async function check(browser, profileName, profile, reduced, engineName) {
    const name = engineName + '-' + profileName;
    const page = await browser.newPage({...profile, reducedMotion: reduced ? 'reduce' : 'no-preference'});
    page.setDefaultTimeout(12000);
    try {
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.route('https://art.fixture.test/**', route => route.fulfill({contentType: 'image/svg+xml',
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="60"><rect width="40" height="60" fill="#556"/></svg>'}));
        const phone = (profile.viewport?.width ?? 1280) < 700;
        await start(page, 'health-admin');
        const online = page.getByRole('region', {name: 'Online now', exact: true});
        const board = page.locator('.leaderboard-page');
        await online.getByRole('heading', {name: 'Online now', level: 2}).waitFor();

        // Online now: one row per online member, the artwork of what they are doing and their lines of detail.
        const rows = online.getByRole('listitem');
        await rows.nth(3).waitFor();
        assert.equal(await rows.count(), 4, name + ' one row per online member');
        const row = who => rows.filter({hasText: who});
        await row('Alex').getByText('Listening to Station Lights', {exact: true}).waitFor();
        await row('Alex').getByText('North Atlas', {exact: true}).waitFor();
        await row('June').getByText('Watching Harbor Lights', {exact: true}).waitFor();
        await row('June').getByText('Season 1, episode 2', {exact: true}).waitFor();
        await row('June').getByText('40% watched', {exact: true}).waitFor();
        assert.equal(await row('June').locator('.online-progress').evaluate(el => el.style.width), '40%');
        await row('Sam').getByText('Playing Wordle', {exact: true}).waitFor();
        assert.equal(await row('Sam').locator('.online-wordle').count(), 1);
        await row('Robin').getByText('Online', {exact: true}).waitFor();
        assert.equal(await row('Robin').locator('.online-art').count(), 0, name + ' no artwork when nothing is playing');
        // Live bars keep animating; only reduced motion stops them.
        const bars = await row('Alex').locator('.listener-equalizer i').first().evaluate(el => getComputedStyle(el).animationName);
        assert.equal(bars, reduced ? 'none' : 'listener-bars', name + ' listening bars');
        // Nothing is shown twice: person controls live in Online now only.
        assert.equal(await page.getByRole('button', {name: /^Options for /}).count(), 4);
        assert.equal(await board.getByRole('button', {name: /^Options for /}).count(), 0);

        // Music Home shows Online now across the page; the leaderboard is its own app.
        assert.equal(await board.count(), 0, name + ' no leaderboard on Music Home');
        const shots = path.join(root, '.local/home-activity');
        fs.mkdirSync(shots, {recursive: true});
        const activity = page.locator('.home-activity');
        await activity.scrollIntoViewIfNeeded();
        await activity.screenshot({path: path.join(shots, name + '-activity.png'), animations: 'disabled'});
        const switcher = page.locator('#app-switcher');
        const openApp = async label => {
            await page.getByRole('button', {name: 'Switch apps', exact: true}).click();
            await switcher.getByRole('button', {name: label, exact: true}).click();
        };
        await openApp('Leaderboard');
        await page.getByRole('heading', {name: 'Leaderboard', level: 1, exact: true}).waitFor();

        // Leaderboard: Weekly, Monthly and All time; each person has a labelled music bar and watch bar.
        const periods = page.getByRole('group', {name: 'Leaderboard period', exact: true});
        assert.deepEqual(await periods.getByRole('button').allInnerTexts(), ['Weekly', 'Monthly', 'All time']);
        assert.equal(await periods.getByRole('button', {name: 'Monthly'}).getAttribute('aria-pressed'), 'true');
        const top = page.getByRole('list', {name: 'Top three, monthly'});
        await top.getByRole('listitem').nth(2).waitFor();
        const first = top.getByRole('listitem').first();
        await first.getByText('June', {exact: true}).waitFor();
        const measure = async (card, label) => {
            const item = card.locator('.lb-measure').filter({has: page.getByText(label, {exact: true})});
            assert.equal(await item.locator('.lb-bar').getAttribute('aria-hidden'), 'true');
            return item.locator('.lb-measure-value').innerText();
        };
        assert.equal(await measure(first, 'Music'), '1 h 3 min');
        assert.equal(await measure(first, 'Watching'), '2 h 30 min');
        assert.equal(await first.locator('.lb-measure').count(), 2);
        await page.screenshot({path: path.join(shots, name + '-leaderboard.png'), animations: 'disabled'});
        await page.getByRole('list', {name: 'Everyone else, monthly'}).getByText('Sam', {exact: true}).waitFor();
        assert.equal(await board.getByRole('heading', {name: "Who's here"}).count(), 0);

        // Switching period keeps focus on the control that was used.
        const focusedPeriod = () => page.evaluate(() => document.activeElement?.closest('.lb-periods') ? document.activeElement.textContent.trim() : document.activeElement?.tagName);
        await periods.getByRole('button', {name: 'Weekly'}).focus();
        await page.keyboard.press('Enter');
        await page.getByRole('list', {name: 'Top three, weekly'}).waitFor();
        assert.equal(await periods.getByRole('button', {name: 'Weekly'}).getAttribute('aria-pressed'), 'true');
        assert.equal(await focusedPeriod(), 'Weekly');
        await page.getByRole('list', {name: 'Top three, weekly'}).getByRole('listitem').first().getByText('Alex', {exact: true}).waitFor();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Space');
        await page.getByRole('list', {name: 'Top three, monthly'}).waitFor();
        assert.equal(await focusedPeriod(), 'Monthly');
        await page.keyboard.press('Tab');
        await page.keyboard.press('Enter');
        await page.getByRole('list', {name: 'Top three, all time'}).waitFor();
        assert.equal(await focusedPeriod(), 'All time');
        await periods.getByRole('button', {name: 'Monthly'}).click();
        await openApp('Music');
        await online.getByRole('heading', {name: 'Online now', level: 2}).waitFor();

        // Someone coming online slides and fades in; reduced motion and effects off show them at once.
        const requested = await requests(page);
        await hideApp(page);
        await page.waitForTimeout(400);
        assert.equal(await requests(page), requested, name + ' a hidden app makes no requests');
        await setOnline(page, 'alex', 'june', 'sam', 'robin', 'kit');
        await showApp(page);
        const kit = online.locator('[data-profile-key="kit"]');
        await kit.waitFor();
        const entering = await kit.evaluate(el => ({entering: el.classList.contains('is-entering'), animation: getComputedStyle(el).animationName}));
        assert.deepEqual(entering, reduced ? {entering: false, animation: 'none'} : {entering: true, animation: 'online-in'}, name + ' entering');
        await page.evaluate(() => { document.body.dataset.effects = 'off'; });
        assert.equal(await kit.evaluate(el => getComputedStyle(el).animationName), 'none', name + ' effects off stops the slide');
        await page.evaluate(() => { delete document.body.dataset.effects; });

        // Leaving fades out, and focus inside the row that leaves moves to the next row.
        await page.evaluate(() => {
            window.__leaving = false;
            new MutationObserver(() => { if (document.querySelector('.online-row.is-leaving')) window.__leaving = true; })
                .observe(document.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['class']});
        });
        await online.getByRole('button', {name: 'Options for Sam'}).focus();
        await setOnline(page, 'alex', 'june', 'robin', 'kit');
        await hideApp(page);
        await showApp(page);
        await online.locator('[data-profile-key="sam"]').waitFor({state: 'detached'});
        assert.equal(await page.evaluate(() => window.__leaving), !reduced, name + ' leaving fade');
        // Focus moves right after the render that removes the row; give that render a moment to finish.
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Options for Robin', null, {timeout: 2000})
            .catch(() => {});
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Options for Robin', name + ' focus moves to the next row');
        assert.equal(await rows.count(), 4);

        // Empty list: the heading stays and focus does not fall to the page.
        await online.getByRole('button', {name: 'Options for Kit'}).focus();
        await setOnline(page);
        await hideApp(page);
        await showApp(page);
        await online.getByText('Nobody is online right now.').waitFor();
        await page.waitForFunction(() => document.activeElement && document.activeElement !== document.body, null, {timeout: 2000}).catch(() => {});
        assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', name + ' focus stays in the page');
        assert.equal(await page.evaluate(() => document.activeElement?.id), 'online-now-title');

        if (process.env.HOME_ACTIVITY_SLOW === '1' && profileName === '1280') {
            await hideApp(page);
            const hidden = await requests(page);
            await page.waitForTimeout(32000);
            assert.equal(await requests(page), hidden, name + ' no refresh while hidden for a full interval');
            await showApp(page);
            await page.waitForFunction(async expected => Number(await (await fetch('/fixture/online-requests')).text()) > expected, hidden);
        }

        // The Music navigation no longer has Leaderboard or Server.
        if (phone) await page.getByRole('button', {name: 'Profile menu'}).press('Enter');
        for (const label of ['Leaderboard', 'Server', 'Server work']) assert.equal(await page.getByRole('button', {name: label, exact: true}).count(), 0, name + ' ' + label);
        if (phone) await page.keyboard.press('Escape');

        // Administrators reach Server in Settings.
        await page.getByRole('button', {name: 'Profile menu'}).press('Enter');
        await page.getByRole('button', {name: 'Settings', exact: true}).press('Enter');
        await page.getByRole('heading', {name: 'Settings', level: 1, exact: true}).waitFor();
        await page.getByRole('button', {name: 'Server', exact: true}).press('Enter');
        await page.getByRole('region', {name: 'Server settings', exact: true}).waitFor();
        await page.getByRole('region', {name: 'Automatic work', exact: true}).waitFor();
        assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), 'BODY', name + ' focus after opening Server');

        // Everyone else has no Server section.
        await start(page, 'none');
        await page.getByRole('button', {name: 'Profile menu'}).press('Enter');
        await page.getByRole('button', {name: 'Settings', exact: true}).press('Enter');
        await page.getByRole('heading', {name: 'Settings', level: 1, exact: true}).waitFor();
        assert.equal(await page.getByRole('button', {name: 'Server', exact: true}).count(), 0, name + ' no Server section without admin rights');
        assert.deepEqual(pageErrors, [], name + ' page errors');
        console.log('PASS', name);
    } finally {
        await page.close();
    }
}

(async () => {
    for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
        const browser = await engine.launch({headless: true});
        try {
            for (const [profileName, profile, reduced] of profiles) await check(browser, profileName, profile, reduced, name);
        } finally { await browser.close(); }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
