const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const origin = process.env.POPUP_URL || 'http://127.0.0.1:38869';
const before = process.env.POPUP_BASELINE === '1';
const output = process.env.POPUP_CAPTURE;
const profiles = [
    ['windows-1280', chromium, {viewport: {width: 1280, height: 900}}],
    ['windows-2000', chromium, {viewport: {width: 2000, height: 1060}}],
    ['mac-webkit-850', webkit, {...devices['Desktop Safari'], viewport: {width: 850, height: 900}}],
    ['android-chrome-390', chromium, {...devices['Pixel 7'], viewport: {width: 390, height: 844}}],
    ['iphone-webkit-390', webkit, {...devices['iPhone 13'], viewport: {width: 390, height: 844}}]
];
const styleProperties = ['backgroundColor', 'backgroundImage', 'borderTopWidth', 'borderTopLeftRadius',
    'borderBottomLeftRadius', 'boxShadow', 'backdropFilter', 'color', 'animationName'];

function artwork(url) {
    const address = new URL(url);
    const artworkPath = address.searchParams.get('u') || address.pathname;
    const seed = [...artworkPath]
        .reduce((value, char) => (value * 31 + char.charCodeAt(0)) % 360, 0);
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 360"><rect width="360" height="360" fill="hsl(' +
        seed + ' 31% 30%)"/><circle cx="158" cy="145" r="112" fill="hsl(' + ((seed + 45) % 360) +
        ' 46% 64%)"/><path d="M0 274Q158 136 360 254V360H0Z" fill="hsl(' + ((seed + 165) % 360) +
        ' 34% 16%)"/><path d="M0 311Q175 244 360 279V360H0Z" fill="hsl(' + ((seed + 205) % 360) + ' 30% 24%)"/></svg>';
}

async function geometry(surface) {
    return surface.evaluate((node, properties) => {
        const px = element => {
            const {x,y,width,height} = element.getBoundingClientRect();
            return {x,y,width,height};
        };
        const firstText = element => {
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const text = walker.currentNode;
                const first = text.textContent.search(/\S/);
                if (first < 0) continue;
                const range = new Range();
                range.setStart(text, first);
                range.setEnd(text, first + 1);
                if (range.getBoundingClientRect().width) return px(range);
            }
            return null;
        };
        const css = getComputedStyle(node);
        const header = node.querySelector('.dialog-heading,.connect-header,.lyrics-header,.report-dialog header,.settings-profile');
        const title = header?.querySelector('h2,strong');
        const close = header?.querySelector('button');
        const rows = [...node.querySelectorAll(':scope > button')].filter(row =>
            row.getClientRects().length && row.querySelector(':scope > .icon') && !row.classList.contains('player-tools-close'));
        return {
            style: Object.fromEntries(properties.map(property => [property, css[property]])),
            backdrop: node.matches('dialog') ? getComputedStyle(node, '::backdrop').backgroundColor : null,
            box: px(node), header: header ? px(header) : null, title: title ? {...px(title), text: firstText(title)} : null,
            close: close ? {...px(close), icon: px(close.querySelector('.icon'))} : null,
            rows: rows.map(row => ({
                box: px(row), icon: px(row.querySelector(':scope > .icon')),
                label: row.textContent.trim() || row.getAttribute('aria-label'),
                text: firstText(row), font: getComputedStyle(row).fontSize, line: getComputedStyle(row).lineHeight,
                gap: getComputedStyle(row).columnGap, padding: getComputedStyle(row).padding
            }))
        };
    }, styleProperties);
}

function checkGeometry(metrics, name, phone, connect) {
    const {style, box, title, close, rows} = metrics;
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.11,
        name + ' ' + label + ' was ' + actual + ', expected ' + expected);
    if (connect) {
        assert.deepEqual(style, connect.style, name + ' surface');
        if (metrics.backdrop !== null) assert.equal(metrics.backdrop, connect.backdrop, name + ' backdrop');
        near(close.width, connect.close.width, 'close target width');
        near(close.height, connect.close.height, 'close target height');
        near(close.icon.width, connect.close.icon.width, 'close icon width');
        if (title.height === connect.title.height)
            near(title.text.y - metrics.header.y, connect.title.text.y - connect.header.y, 'heading baseline');
    }
    assert.equal(style.backgroundColor, phone ? 'rgb(31, 31, 31)' : 'rgb(18, 18, 18)', name);
    assert.equal(style.borderTopLeftRadius, phone ? '18px' : '8px', name);
    assert.equal(style.borderTopWidth, '0px', name);
    assert.equal(style.animationName, 'none', name + ' reduced motion');
    near(title.x - box.x, phone ? 24 : 16, 'heading left inset');
    near(box.x + box.width - close.x - close.width, phone ? 12 : 8, 'close right inset');
    near(title.y + title.height / 2, close.y + close.height / 2, 'close center');
    const textRow = rows.find(row => row.text);
    if (rows.length) near(box.width, phone ? 390 : 340, 'menu width');
    for (const row of rows) {
        near(row.icon.width, 20, row.label + ' icon width');
        near(row.icon.height, 20, row.label + ' icon height');
        near(row.icon.x, title.x, row.label + ' icon column');
        near(row.icon.y + 10, row.box.y + row.box.height / 2, row.label + ' icon center');
        near(row.box.height, phone ? 56 : 44, row.label + ' row height');
        assert.equal(row.gap, '12px', name + ' ' + row.label + ' gap');
        assert.equal(row.padding, phone ? '0px 12px' : '0px 8px', name + ' ' + row.label + ' padding');
        if (row.text) {
            near(row.text.x - row.icon.x, 32, row.label + ' label column');
            near(row.text.y - row.box.y, textRow.text.y - textRow.box.y, row.label + ' baseline');
        }
    }
}

async function touchDismiss(page, engine, header) {
    const box = await header.boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + 12);
    if (engine === chromium) {
        const client = await page.context().newCDPSession(page);
        await client.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x,y}]});
        for (const dy of [12, 36, 62, 96, 116]) {
            await client.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x, y: y + dy}]});
        }
        await client.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
        await client.detach();
    } else {
        await header.evaluate((target, {x,y}) => {
            const send = (type, distance) => {
                const event = new Event(type, {bubbles: true, cancelable: true});
                const touch = {identifier: 1, target, clientX: x, clientY: y + distance};
                Object.defineProperty(event, 'touches', {value: type === 'touchend' ? [] : [touch]});
                target.dispatchEvent(event);
            };
            send('touchstart', 0);
            send('touchmove', 116);
            send('touchend', 116);
        }, {x,y});
    }
}

async function audit(name, engine, options) {
    const browser = await engine.launch({headless: true});
    const phone = Boolean(options.isMobile);
    const page = await browser.newPage({...options, reducedMotion: 'reduce'});
    const captures = {};
    let connect;
    const pageErrors = [];
    const target = id => page.locator('#' + id);
    const heading = text => page.getByRole('heading', {name: text, exact: true});
    const select = async node => { if (phone) await node.tap(); else await node.click(); };
    const closeByEscape = async surface => { await page.keyboard.press('Escape'); await surface.waitFor({state: 'hidden'}); };
    const open = async (opener, id) => {
        await select(opener);
        const surface = target(id);
        await surface.waitFor();
        return surface;
    };
    const nav = async label => {
        if (phone && ['Server work', 'Leaderboard'].includes(label)) await open(target('profile-toggle'), 'profile-menu');
        await select(page.getByRole('button', {name: label, exact: true}).first());
        await heading(label).waitFor();
        await page.waitForFunction(view => document.body.dataset.view === view, label === 'Server work' ? 'stats' : label.toLowerCase());
    };
    const capture = async (state, surface, menu = false) => {
        const scene = surface || page.locator('main#content');
        await scene.waitFor();
        if (!phone) await page.mouse.move(2, 2);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metrics = surface ? await geometry(surface) : await scene.evaluate((node, state) => {
            const root = document.documentElement, box = node.getBoundingClientRect();
            const starts = {
                'server-work': ['#view-title', '.server-work-page'],
                leaderboard: ['#view-title', '.leaderboard-page'],
                'artist-mappings': ['.artist-mappings > .music-admin-heading > p', '#artist-mapping-results']
            }[state];
            return {viewport: [innerWidth, innerHeight], content: [box.x, box.y, box.width, box.height],
                contentWidth: node.scrollWidth, horizontalOverflow: root.scrollWidth - innerWidth,
                headingAlignment: starts?.map(selector => node.querySelector(selector).getBoundingClientRect().x)};
        }, state);
        if (!before && !surface) assert.equal(metrics.horizontalOverflow, 0, name + '/' + state);
        if (!before && metrics.headingAlignment) assert.equal(...metrics.headingAlignment, name + '/' + state + ' left alignment');
        captures[state] = metrics;
        if (!before && surface) checkGeometry(menu ? metrics : {...metrics, rows: []}, name + '/' + state, phone, connect);
        if (output) {
            const folder = path.join(output, name);
            fs.mkdirSync(folder, {recursive: true});
            await page.screenshot({path: path.join(folder, state + '.png'), scale: 'css', animations: 'disabled'});
            fs.writeFileSync(path.join(folder, 'measurements.json'), JSON.stringify(captures, null, 2));
        }
        console.log(name, state);
        return metrics;
    };

    try {
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => pageErrors.push(error.message));
        for (const pattern of ['**/fh-art/**', '**/test/**', 'https://art.fixture.test/**']) {
            await page.route(pattern, route => route.fulfill({contentType: 'image/svg+xml', body: artwork(route.request().url())}));
        }
        await page.goto(origin);
        await page.locator('#discovery-shelf .home-card').nth(7).waitFor();
        if (!before) {
            const icon = await target('home-radio-0').locator('.radio-shortcut-title .icon').boundingBox();
            assert.deepEqual([icon.width, icon.height], [16, 16], name + ' radio icon size');
        }
        await capture('home');
        const tools = async () => {
            if (phone && !await target('player-options').isVisible()) await open(target('player-more'), 'player-options');
        };
        await tools();
        const device = await open(target('connect-device'), 'audio-output-dialog');
        await device.getByText('Living room PC').waitFor();
        connect = await capture('connect', device);
        if (!before) {
            assert.equal(await device.locator('.audio-output-option[aria-pressed=true]').evaluate(node => getComputedStyle(node).color),
                'rgb(30, 215, 96)', name + ' selected audio output color');
            await page.emulateMedia({reducedMotion: 'no-preference'});
            assert.equal(await device.evaluate(node => getComputedStyle(node).animationName), phone ? 'popup-sheet-in' : 'popup-side-in');
            await page.emulateMedia({reducedMotion: 'reduce'});
            const close = target('audio-output-close');
            assert.equal(await close.evaluate(node => node === document.activeElement), true);
            await page.keyboard.press('Shift+Tab');
            await page.waitForFunction(() => document.activeElement.id === 'connect-bluetooth');
            await page.keyboard.press('Tab');
            await page.waitForFunction(() => document.activeElement.id === 'audio-output-close');
            if (phone) await touchDismiss(page, engine, device.locator('.dialog-heading'));
            else await page.mouse.click(30, 200);
            await device.waitFor({state: 'hidden'});
            await page.waitForFunction(() => document.activeElement.id === 'connect-device');
        } else {
            await select(target('audio-output-close'));
            await device.waitFor({state: 'hidden'});
        }
        await tools();
        const together = await open(target('listen-together'), 'listen-together-dialog');
        await capture('listen-together', together);
        if (before) {
            await select(target('close-listening'));
            await together.waitFor({state: 'hidden'});
        } else await closeByEscape(together);
        if (phone && await target('player-options').isVisible()) await closeByEscape(target('player-options'));
        if (phone) await select(page.getByRole('button', {name: 'Search', exact: true}));
        await target('q').fill('North Atlas');
        await target('clear-search').waitFor();
        await target('q').press('Enter');
        await target('pick').waitFor();
        await page.locator('#results .song-row').first().waitFor();
        await capture('search');

        const playlists = page.locator('#music-navigation button[aria-label=Playlists]:visible');
        if (phone) {
            await select(playlists);
            await select(page.getByRole('button', {name:'Songs', exact:true}));
        } else await select(target('open-library'));
        await target('library-add-songs').waitFor();
        await capture('library');

        const add = await open(target('library-add-songs'), 'add-songs-dialog');
        await capture('add-songs', add);
        if (!before) {
            const tiles = await add.locator('.create-file-choice').evaluateAll(nodes => nodes.map(node => {
                const {y, x, width, height} = node.getBoundingClientRect();
                const icon = node.querySelector('.icon').getBoundingClientRect();
                const text = node.querySelector('strong').getBoundingClientRect();
                return [y, width, height, icon.x - x, icon.y - y, text.x - x, text.y - y];
            }));
            assert.deepEqual(tiles[0], tiles[1], name + ' upload card and label alignment');
        }
        await target('add-songs-upload-audio-file').setInputFiles({
            name: 'North Atlas - Station Lights.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVE')
        });
        await add.getByText('North Atlas - Station Lights.wav').waitFor();
        await capture('upload', add);
        await closeByEscape(add);

        const firstSong = page.locator('.song-row').first();
        await select(firstSong.locator('.song-primary'));
        await page.waitForFunction(() => document.getElementById('now-title').textContent.includes('First Light'));
        const rowOpener = firstSong.locator('.row-more');
        const rowId = await rowOpener.getAttribute('id');
        const song = await open(rowOpener, rowId + '-menu');
        await capture('song-menu', song, true);
        if (!before) {
            const report = song.getByRole('button', {name: 'Report problem'});
            assert.equal(await report.locator('.icon').count(), 1);
            await open(report, 'report-song-dialog');
            await capture('report', target('report-song-dialog'));
            assert.equal(await target('report-song-track').textContent(), 'First Light');
            await closeByEscape(target('report-song-dialog'));
            await page.waitForFunction(id => document.activeElement.id === id, await report.getAttribute('id'));
        }
        const picker = await open(song.getByRole('button', {name: 'Add to playlist', exact: true}), 'song-playlist-dialog');
        await capture('song-playlist-picker', picker);
        await closeByEscape(picker);
        await select(song.getByRole('button', {name: 'Needs trimming', exact: true}));
        await song.getByRole('button', {name: 'Added to trimming pool'}).waitFor();
        await capture('trim-request', song, true);
        await closeByEscape(song);
        if (!before) await page.waitForFunction(id => document.activeElement.id === id, rowId);
        await tools();
        if (phone) {
            await capture('player-menu', target('player-options'), true);
            if (!before) {
                await open(target('report-song'), 'report-song-dialog');
                await closeByEscape(target('report-song-dialog'));
                await page.waitForFunction(() => document.activeElement.id === 'report-song');
            }
        }
        if (before) {
            await open(target('report-song'), 'report-song-dialog');
            await capture('report', target('report-song-dialog'));
            await select(target('report-song-dialog').locator('.report-close'));
            await target('report-song-dialog').waitFor({state: 'hidden'});
        }
        const lyrics = await open(target('sheet-lyrics'), 'lyrics-view');
        await lyrics.locator('.lyric-line.is-active').waitFor();
        await capture('lyrics', lyrics);
        const [lyricBox, bar] = await Promise.all([lyrics.boundingBox(), page.locator('.player-bar').boundingBox()]);
        assert.ok(lyricBox.y + lyricBox.height <= bar.y + .11, name + ' Lyrics overlaps the player');
        if (phone && !before) {
            await touchDismiss(page, engine, lyrics.locator('.dialog-heading'));
            await lyrics.waitFor({state: 'hidden'});
            await page.waitForFunction(() => document.activeElement.id === 'player-more');
        } else await closeByEscape(lyrics);
        if (phone) {
            await select(target('show-queue'));
            await page.locator('.player-bar.is-expanded').waitFor();
            await capture('now-playing');
            await select(target('player-queue'));
        } else {
            await capture('now-playing');
            await select(target('show-queue'));
        }
        await heading('Queue').waitFor();
        await capture('queue');

        await select(playlists);
        const sort = await open(target('playlist-sort'), 'playlist-sort-options');
        await capture('playlist-sort', sort, true);
        await closeByEscape(sort);
        const create = await open(target('create-playlist'), 'create-playlist-dialog');
        await capture('create-playlist', create);
        await closeByEscape(create);
        await select(page.locator('[data-playlist-key="fixture:mix0"]'));
        await heading('Late Night Mix').waitFor();
        await page.locator('.playlist-hero[data-tint-source]').waitFor();
        await capture('playlist');
        const playlistMenu = () => open(target('playlist-menu-toggle'), 'playlist-options');
        const preload = await open(target('keep-playlist'), 'preload-dialog');
        await capture('playlist-download', preload);
        await closeByEscape(preload);
        const menu = await playlistMenu();
        await capture('playlist-menu', menu, true);
        await open(target('playlist-saved-songs'), 'add-song-dialog');
        await capture('choose-saved-songs', target('add-song-dialog'));
        await closeByEscape(target('add-song-dialog'));
        for (const [button, id, state] of [
            ['playlist-details-open', 'playlist-details-dialog', 'playlist-details'],
            ['playlist-coauthors', 'playlist-coauthors-dialog', 'playlist-coauthors'],
            ['delete-playlist', 'delete-playlist-dialog', 'delete-playlist']
        ]) {
            await playlistMenu();
            await open(target(button), id);
            await capture(state, target(id));
            await closeByEscape(target(id));
        }
        await playlistMenu();
        await select(target('playlist-import-link'));
        const transfer = target('add-songs-dialog').or(target('transfer-import-dialog')).filter({visible:true});
        await capture('playlist-import', transfer);
        await closeByEscape(transfer);
        const songSort = await open(target('playlist-song-sort'), 'playlist-song-sort-options');
        await capture('song-sort', songSort, true);
        await closeByEscape(songSort);
        await select(target('open-home'));
        await select(page.locator('#home-albums-shelf .home-card').first());
        await target('play-album').waitFor();
        await capture('album');

        await nav('Server work');
        await page.locator('.server-page[aria-busy=false]').waitFor();
        await capture('server-work');
        await select(page.getByRole('button', {name: /Missing metadata/}));
        await target('metadata-00000000001').waitFor();
        await target('catalogue-review-title').evaluate(node => {
            const main = node.closest('main');
            main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
        });
        await capture('song-review');
        await open(target('metadata-00000000001'), 'metadata-review-dialog');
        await capture('song-metadata', target('metadata-review-dialog'));
        await closeByEscape(target('metadata-review-dialog'));
        await select(target('artist-mappings-title'));
        await page.locator('.artist-mapping-row').first().waitFor();
        await page.locator('.artist-mappings').scrollIntoViewIfNeeded();
        await capture('artist-mappings');
        await select(page.getByRole('button', {name: /Missing from playlists/}));
        await open(page.getByRole('button', {name: /Review the recording of Station Lights/}), 'transfer-review-dialog');
        await target('transfer-review-dialog').getByText('Station Lights', {exact: true}).first().waitFor();
        await capture('review-recording', target('transfer-review-dialog'));
        await closeByEscape(target('transfer-review-dialog'));

        await nav('Leaderboard');
        await page.locator('.leaderboard-page[aria-busy=false]').waitFor();
        await capture('leaderboard');
        await target('lb-wrapped-title').evaluate(node => {
            const main = node.closest('main');
            main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
        });
        await page.waitForFunction(() => {
            const main = document.getElementById('content').getBoundingClientRect();
            const card = document.querySelector('.lb-wrapped-card').getBoundingClientRect();
            return card.top >= main.top && card.top < main.bottom;
        });
        await capture('wrapped');
        const listener = page.locator('.listener-options').first();
        if (await listener.count()) {
            const id = (await listener.getAttribute('id')) + '-dialog';
            await open(listener, id);
            await capture('listener-menu', target(id), true);
            await closeByEscape(target(id));
        }
        await open(target('profile-toggle'), 'profile-menu');
        await capture('profile-menu', target('profile-menu'), true);
        await select(target('open-settings'));
        await heading('Settings').waitFor();
        await page.waitForFunction(() => document.body.dataset.view === 'preferences');
        await capture('settings');
        await open(target('clear-history'), 'clear-history-dialog');
        await capture('clear-history', target('clear-history-dialog'));
        await closeByEscape(target('clear-history-dialog'));

        if (output) {
            await page.request.post(origin + '/fixture/listening-request/true');
            const request = page.locator('.listening-poke');
            try {
                await request.waitFor();
                await capture('listening-request', request);
            } finally {
                await page.request.post(origin + '/fixture/listening-request/false');
            }
        }
        for (const [scenario, id, state] of [
            ['update', 'update-dialog', 'update'],
            ['spotify', 'spotify-question-dialog', 'spotify-question']
        ]) {
            await page.request.post(origin + '/fixture/startup/' + scenario);
            try {
                await page.reload();
                await capture(state, target(id));
                await closeByEscape(target(id));
            } finally {
                await page.request.post(origin + '/fixture/startup/none');
            }
        }
        if (!before) assert.deepEqual(pageErrors, []);
    } catch (error) {
        if (output) {
            console.error('Visible content:', (await page.locator('body').innerText()).slice(0, 1500));
            await page.screenshot({path: path.join(output, name, 'failure.png'), scale: 'css'});
        }
        throw error;
    } finally {
        await browser.close();
    }
}

(async () => {
    const requested = process.env.POPUP_PROFILES?.split(',');
    for (const profile of profiles.filter(([name]) => !requested || requested.includes(name))) await audit(...profile);
})().catch(error => { console.error(error); process.exitCode = 1; });
