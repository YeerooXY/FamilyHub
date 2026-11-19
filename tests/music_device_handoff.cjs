// Generate the media under .local/music-browser with tests/music_browser_fixture.py.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');

const root = path.resolve(__dirname, '..');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ||
    require.resolve('playwright', { paths: [root, path.resolve(root, '../agent-dock')] }));
const fixture = path.join(root, '.local/music-browser');
const tone = fs.readFileSync(path.join(fixture, 'tone.flac'));
const tracks = [1, 2, 3, 4].map(n => {
    const id = String(n).padStart(11, '0');
    return { id, title: 'Handoff track ' + n, channel: 'Fixture artist', duration: 40 };
});
const [previous, current, next, last] = tracks;
const saved = new Set([previous.id, current.id]);
const job = track => ({
    id: 'job-' + track.id, source_id: track.id, state: 'done', preview_state: 'ready',
    title: track.title, artist: track.channel, media_url: '/fixture/hls/' + track.id + '/index.m3u8'
});

const playbackServer = `
import logging
from flask import Flask, jsonify, render_template, request, g
from werkzeug.serving import make_server
from music_web.playback_devices import PlaybackDevices, register_playback_devices

app = Flask(__name__, template_folder='music_web/templates', static_folder='music_web/static')
app.jinja_env.globals['csrf_token'] = lambda: 'fixture-token'
logging.getLogger('werkzeug').setLevel(logging.ERROR)
devices = PlaybackDevices()
register_playback_devices(app, lambda limit: request.json, devices)

@app.before_request
def profile():
    g.user = 'handoff-fixture'

@app.get('/')
def index():
    return render_template('index.html', player_url='https://player.test', user=g.user, profile_name=g.user)

@app.post('/api/playback/activity')
def activity():
    data = request.json
    command, controls, epoch = devices.report(g.user, data['device_id'], data['device_info'],
        data['playing'], data.get('track'), data.get('position'))
    return jsonify(command=command, controls=controls, epoch=epoch)

server = make_server('127.0.0.1', 0, app)
print(server.port, flush=True)
server.serve_forever()
`;

async function run() {
    const server = spawn(process.env.FAMILYHUB_TEST_PYTHON || 'python', ['-u', '-c', playbackServer],
        { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
    const portOutput = createInterface({ input: server.stdout });
    const acks = [], playRequests = [], pageErrors = [];
    let releaseAck;
    const allowAck = new Promise(resolve => { releaseAck = resolve; });
    let browser;
    try {
        const port = await Promise.race([
            once(portOutput, 'line').then(([line]) => Number(line)),
            once(server, 'exit').then(([code]) => { throw new Error('Playback fixture exited with code ' + code); })
        ]);
        browser = await chromium.launch({ headless: true });

        async function open(autoplay) {
            const page = await browser.newPage();
            page.on('pageerror', error => pageErrors.push(error.message));
            await page.addInitScript(autoplay => {
                localStorage.setItem('music:autoplay', String(autoplay));
                localStorage.setItem('music:queue-mode', autoplay ? 'shuffle' : 'order');
                localStorage.setItem('music:fade', '0');
            }, autoplay);
            await page.route('https://music.test/**', async route => {
                const request = route.request(), url = new URL(request.url()), p = url.pathname;
                const data = request.postData();
                if (p === '/' || p.startsWith('/api/playback/')) {
                    const body = data && JSON.parse(data);
                    if (body?.device_info?.acks?.length) {
                        acks.push(body);
                        if (acks.length === 1) await allowAck;
                    }
                    const response = await fetch('http://127.0.0.1:' + port + p + url.search, {
                        method: request.method(), headers: { 'Content-Type': 'application/json' }, body: data
                    });
                    return route.fulfill({ status: response.status, contentType: response.headers.get('Content-Type'),
                        body: await response.text() });
                }
                if (p.startsWith('/static/')) return route.fulfill({ path: path.join(root, 'music_web', p.slice(1)) });
                if (p === '/fixture/tone.flac') {
                    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range);
                    const headers = { 'Accept-Ranges': 'bytes' };
                    if (!range) return route.fulfill({ body: tone, headers, contentType: 'audio/flac' });
                    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), tone.length - 1) : tone.length - 1;
                    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + tone.length;
                    return route.fulfill({ status: 206, body: tone.subarray(start, end + 1), headers, contentType: 'audio/flac' });
                }
                if (p.startsWith('/fixture/hls/')) {
                    const mime = { '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/mp4' };
                    return route.fulfill({ path: path.join(fixture, 'hls', path.basename(p)), contentType: mime[path.extname(p)] });
                }
                if (p === '/api/library') return route.fulfill({ json: { results: tracks.filter(t => saved.has(t.id)).map(t =>
                    ({ ...t, saved: true, download_url: '/fixture/tone.flac' })) } });
                if (p === '/api/jobs' && data) {
                    const track = JSON.parse(data);
                    playRequests.push(track);
                    if (!track.allow_new && !saved.has(track.id)) return route.fulfill({ status: 409, json: { error: 'This song is not saved.' } });
                    saved.add(track.id);
                    return route.fulfill({ json: { job: job(track) } });
                }
                if (p === '/api/queue') {
                    const body = JSON.parse(data);
                    return route.fulfill({ json: { jobs: body.tracks.filter(t => body.allow_new || t.requested || saved.has(t.id)).map(job) } });
                }
                return route.fulfill({ json: {} });
            });
            await page.goto('https://music.test/');
            await page.waitForFunction(() => deviceRegistered);
            return page;
        }

        async function playing(page, id) {
            try {
                await page.waitForFunction(id => currentTrack?.id === id && !decks[deckIndex].paused && !decks[deckIndex].ended,
                    id, { timeout: 8000 });
            } catch {
                const state = await page.evaluate(() => ({
                    track: currentTrack?.id, queue: queue.map(sourceKey), autoplay: $('autoplay').checked, status: $('playback-state').textContent,
                    position: decks[deckIndex].currentTime, duration: decks[deckIndex].duration, seeking: decks[deckIndex].seeking
                }));
                assert.fail('Expected ' + id + ' to play: ' + JSON.stringify(state));
            }
        }

        async function endSong(page) {
            await page.evaluate(() => {
                const deck = decks[deckIndex];
                window.fixtureTrackEnded = false;
                deck.addEventListener('ended', () => { window.fixtureTrackEnded = true; }, { once: true });
                deck.currentTime = deck.duration - .3;
            });
            await page.waitForFunction(() => window.fixtureTrackEnded, undefined, { timeout: 6000 });
        }

        const sender = await open(true);
        const receiver = await open(false);
        await receiver.locator('#library-list .song-primary').filter({ hasText: previous.title }).click();
        await playing(receiver, previous.id);
        await sender.waitForFunction(() => playbackEpoch > 0);
        const libraryRow = sender.locator('#library-list .song-primary').filter({ hasText: current.title });
        await libraryRow.click();
        await playing(sender, current.id);
        await receiver.waitForFunction(() => decks[deckIndex].paused);
        await sender.evaluate(({ previous, next, last }) => {
            repeatMode = "all";
            history = [pool.find(track => track.id === previous.id)];
            queue = [next, last].map(track => ({ ...track, url: 'https://www.youtube.com/watch?v=' + track.id }));
            queue.forEach(track => manualQueue.add(track.id));
            renderQueue();
            decks[deckIndex].currentTime = 4;
        }, { previous, next, last });
        await sender.waitForFunction(() => !checkingIn && sentQueueRev === queueRev);
        await receiver.evaluate(() => refreshRemotePlayback());
        await Promise.all([
            receiver.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/playback/activity')
                && request.postDataJSON().device_info?.acks?.length > 0, { timeout: 8000 }),
            receiver.locator('#remote-line').click()
        ]);
        assert.equal(await receiver.locator('#handoff-message').textContent(), 'Connecting...');
        await playing(sender, current.id);
        releaseAck();
        await playing(receiver, current.id);
        await sender.waitForFunction(() => !handoff && decks[deckIndex].paused);
        const elapsed = await receiver.evaluate(() => decks[deckIndex].currentTime);
        assert(elapsed >= 3 && elapsed < 10, 'Handoff should resume in the middle of the song');

        await sender.evaluate(() => {
            Object.defineProperty(document, 'hidden', { value: true, configurable: true });
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await endSong(receiver);
        await playing(receiver, next.id);
        assert(playRequests.some(track => track.id === next.id && track.allow_new), 'The receiver must prepare an unsaved queued song');
        assert.deepEqual(acks[0].device_info.queue, {
            track_ids: tracks.map(t => t.id), index: 1, shuffle: true, repeat_mode: 'all', autoplay: true
        }, 'Confirmation must publish the full queue on the receiver');

        await sender.evaluate(() => {
            delete document.hidden;
            document.dispatchEvent(new Event('visibilitychange'));
        });
        await sender.waitForFunction(id => remoteDevice?.track?.id === id, next.id);
        await sender.locator('#remote-line').click();
        await playing(sender, next.id);
        assert.deepEqual(await sender.evaluate(() => [history.map(sourceKey), queue.map(sourceKey)]),
            [[previous.id, current.id], [last.id]], 'Returning playback must keep the queue on both sides of the current song');
        await endSong(sender);
        await playing(sender, last.id);
        await endSong(sender);
        await playing(sender, previous.id);
        assert.deepEqual(await sender.evaluate(() => [history.map(sourceKey), queue.map(sourceKey)]),
            [[], [current.id, next.id, last.id]], 'Repeat all must restart with the same playback order');
        await sender.locator('#play').click();
        await sender.waitForFunction(() => decks[deckIndex].paused && !checkingIn);
        await receiver.evaluate(() => refreshRemotePlayback());
        await receiver.waitForFunction(id => remoteDevice?.track?.id === id && remoteDevice.status === 'paused', previous.id);
        await receiver.locator('#remote-line').click();
        await receiver.waitForFunction(id => !handoff && currentTrack?.id === id && decks[deckIndex].paused, previous.id);
        assert.deepEqual(await receiver.evaluate(() => queue.map(sourceKey)), [current.id, next.id, last.id],
            'A paused handoff must retain the upcoming songs');
        await receiver.locator('#play').click();
        await playing(receiver, previous.id);
        assert.deepEqual(pageErrors, []);
        console.log('PASS: competing playback, playing and paused handoff, unattended queue advance, return handoff, and repeat all.');
    } finally {
        releaseAck();
        await browser?.close();
        portOutput.close();
        server.kill();
    }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
