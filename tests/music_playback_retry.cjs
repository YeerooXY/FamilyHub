// Generate authenticated markup with tests/music_browser_fixture.py first.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE ||
    require.resolve('playwright', { paths: [root, path.resolve(root, '../agent-dock')] }));
const fixture = path.join(root, '.local/music-browser');
const saved = [1, 2, 3].map(n => ({
    id: 'local-' + String(n).padStart(16, '0'), title: 'Local song ' + n, channel: 'Fixture artist', saved: true,
    duration: 40, download_url: '/fixture/audio.flac'
}));
const search = [1, 2].map(n => ({
    id: String(n).padStart(11, '0'), title: 'Search song ' + n, channel: 'Fixture artist', duration: 40,
    url: 'https://www.youtube.com/watch?v=' + String(n).padStart(11, '0')
}));
const playlist = { id: 'fixture-playlist', name: 'Fixture playlist',
    tracks: saved.map(track => ({ title: track.title, artist: track.channel, state: 'saved', match: track, candidates: [track] })) };
const tone = fs.readFileSync(path.join(fixture, 'tone.flac'));
const receiver = 'a'.repeat(32);
const profiles = [
    ['pc', chromium, { viewport: { width: 1280, height: 850 } }],
    ['mac', webkit, { viewport: { width: 1280, height: 850 } }],
    ['android', chromium, { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } }],
    ['iphone', webkit, { ...devices['iPhone 13'] }]
];

async function check([name, engine, profile]) {
    const browser = await engine.launch({ headless: true });
    try {
        const page = await browser.newPage(profile);
        page.setDefaultTimeout(6000);
        await page.addInitScript(() => {
            localStorage.setItem('music:autoplay', 'false');
            localStorage.setItem('music:queue-mode', 'order');
            localStorage.setItem('music:fade', '0');
            const timeout = AbortSignal.timeout.bind(AbortSignal);
            AbortSignal.timeout = ms => timeout(Math.min(ms, 1000));
        });
        const errors = [], requests = [], timings = [];
        let response = 'offline';
        page.on('pageerror', error => errors.push(error.message));
        await page.route('https://music.test/**', async route => {
            const request = route.request(), pathname = new URL(request.url()).pathname;
            if (pathname === '/') return route.fulfill({ path: path.join(fixture, 'index.html') });
            if (pathname === '/login') return route.fulfill({ path: path.join(fixture, 'login.html') });
            if (pathname.startsWith('/static/')) return route.fulfill({ path: path.join(root, 'music_web', pathname.slice(1)) });
            if (pathname === '/fixture/audio.flac') return route.fulfill({ body: tone, contentType: 'audio/flac' });
            if (pathname.startsWith('/fixture/hls/')) {
                const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/mp4' };
                return route.fulfill({ path: path.join(fixture, 'hls', path.basename(pathname)),
                    contentType: mime[path.extname(pathname)] });
            }
            if (pathname === '/api/library') return route.fulfill({ json: { results: saved } });
            if (pathname === '/api/search') return route.fulfill({ json: { results: search } });
            if (pathname === '/api/recommendations') return route.fulfill({ json: { results: search } });
            if (pathname === '/api/playlists') return route.fulfill({ json: { playlists: [playlist] } });
            if (pathname === '/api/queue') return route.fulfill({ json: { jobs: [] } });
            if (pathname === '/api/playback/diagnostics') {
                timings.push(request.postDataJSON());
                return route.fulfill({ json: { ok: true } });
            }
            if (pathname === '/api/playback/devices') return route.fulfill({ json: { devices: [
                { id: receiver, kind: 'android', name: 'Fixture phone', age: 0 }
            ] } });
            if (pathname === '/api/playback/transfer') return route.fulfill({ json: { id: 'fixture-handoff' } });
            if (pathname === '/api/playback/handoff/fixture-handoff') {
                // The source loses its connection just after the transfer is accepted.
                await new Promise(resolve => setTimeout(resolve, 1200));
                return route.abort().catch(() => {});
            }
            if (pathname === '/api/jobs' && request.method() === 'POST') {
                requests.push(request.postDataJSON());
                if (response === 'offline') return route.abort('internetdisconnected');
                if (response === 'timeout') {
                    await new Promise(resolve => setTimeout(resolve, 1200));
                    return route.abort().catch(() => {});
                }
                if (typeof response === 'number') return route.fulfill({ status: response, json: { error: 'Playback is temporarily unavailable. Try again.' } });
                return route.fulfill({ json: { job: { id: 'job', source_id: requests.at(-1).id, state: 'done',
                    media_url: '/fixture/hls/index.m3u8', fallback_url: '/fixture/audio.flac', message: 'Ready' } } });
            }
            return route.fulfill({ json: {} });
        });
        await page.goto('https://music.test/');
        await page.getByRole('button', { name: 'Play Local song 1' }).click();
        await page.locator('#show-queue').click();
        await page.getByRole('button', { name: 'Remove Local song 2' }).click();
        await page.getByRole('button', { name: 'Remove Local song 3' }).click();
        await page.getByText('No songs queued.', { exact: false }).waitFor();
        await page.screenshot({ path: path.join(fixture, 'empty-queue-' + name + '.png') });
        await page.getByRole('button', { name: 'Add saved songs' }).click();
        await page.waitForFunction(() => document.querySelectorAll('#queue li').length === 2);
        assert.deepEqual(await page.evaluate(() => queue.map(track => track.title)), ['Local song 2', 'Local song 3']);
        await page.locator('#nav-search').click();
        await page.locator('#q').fill('Search song');
        await page.locator('#q').press('Enter');
        await page.getByRole('button', { name: 'Play Search song 1' }).click();
        const retry = page.getByRole('button', { name: 'Retry playback' });
        await retry.waitFor();
        assert.match(await page.locator('#status-text').innerText(), /Cannot reach the server/);
        assert.equal(await page.locator('#play').getAttribute('aria-busy'), 'false');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(fixture, 'retry-' + name + '.png') });

        for (const [failure, message] of [[403, /temporarily unavailable/], [409, /temporarily unavailable/],
            [503, /temporarily unavailable/], ['timeout', /took too long/]]) {
            response = failure;
            await retry.click();
            await retry.waitFor();
            assert.match(await page.locator('#status-text').innerText(), message);
        }
        response = 'ready';
        await retry.click();
        await page.waitForFunction(() => currentJob?.id === 'job');
        if (engine === chromium) await page.waitForFunction(() => !decks[deckIndex].paused && decks[deckIndex].currentTime > .1);
        assert(await retry.isHidden());
        assert.equal(requests.length, 6);
        assert(requests.every(request => request.id === search[0].id && request.allow_new));
        if (engine === chromium) {
            const action = requests.at(-1).play_action;
            const reported = page.waitForResponse(response => response.url().endsWith('/api/playback/diagnostics') &&
                response.request().postDataJSON()?.stage === 'fallback_position_advanced');
            await page.evaluate(() => decks[deckIndex].dispatchEvent(new Event('error')));
            await page.waitForFunction(() => decks[deckIndex].dataset.mediaUrl === '/fixture/audio.flac' &&
                !decks[deckIndex].paused && playAction.stages.has('fallback_position_advanced'));
            await reported;
            for (const stage of ['play', 'ready', 'playing', 'stream_failed', 'fallback', 'fallback_playing', 'fallback_position_advanced'])
                assert(timings.some(entry => entry.action === action && entry.stage === stage), 'Missing timing ' + stage);
        }
        assert.deepEqual(await page.evaluate(() => queue.map(track => track.title)), ['Local song 2', 'Local song 3', 'Search song 2']);
        await page.locator('#connect-open').click();
        const target = page.getByRole('button', { name: 'Fixture phone' });
        await target.click();
        await page.waitForFunction(() => document.getElementById('connect-message').textContent.includes('Could not switch playback'));
        assert.equal(await target.getAttribute('aria-disabled'), 'false');
        assert.deepEqual(await page.evaluate(() => queue.map(track => track.title)), ['Local song 2', 'Local song 3', 'Search song 2']);
        await page.keyboard.press('Escape');
        await page.locator('#connect-panel').waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement.id === 'connect-open');
        await page.getByRole('button', { name: 'Recommend similar' }).click();
        await page.locator('#similar-results').getByRole('button', { name: 'Play Search song 2' }).click();
        await page.waitForFunction(id => currentJob?.source_id === id, search[1].id);
        await page.locator('#nav-library').click();
        await page.locator('#playlist-panel summary').click();
        await page.locator('#playlist-select').selectOption(playlist.id);
        await page.getByRole('button', { name: 'Play playlist' }).click();
        await page.waitForFunction(() => currentTrack?.title === 'Local song 1' && queue.length === 2);
        response = 401;
        await page.locator('#nav-search').click();
        await page.getByRole('button', { name: 'Play Search song 2' }).click();
        await page.waitForURL('**/login');
        assert.deepEqual(errors, []);
        console.log('PASS ' + name + ': local queue, playback and handoff recovery, and expired-session sign-in');
    } finally {
        await browser.close();
    }
}

(async () => {
    for (const profile of profiles) await check(profile);
})().catch(error => { console.error(error); process.exitCode = 1; });
