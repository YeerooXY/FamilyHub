const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const {constants, setPriority} = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths: [root, path.resolve(root, '../agent-dock')]}));
const fixtureAddress = new URL(process.env.POPUP_URL || 'http://127.0.0.1:38869');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(fixtureAddress.hostname), 'Use a loopback popup fixture');
const origin = fixtureAddress.origin;
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
        const avatar = document.getElementById('profile-toggle');
        return {
            style: Object.fromEntries(properties.map(property => [property, css[property]])),
            backdrop: node.matches('dialog') ? getComputedStyle(node, '::backdrop').backgroundColor : null,
            viewport: [innerWidth, innerHeight],
            anchor: node.id === 'profile-menu' && avatar ? px(avatar) : null,
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

function sceneSurfaceName(name) { return name.endsWith('/update'); }

function checkGeometry(metrics, name, phone, connect) {
    const {style, box, title, close, rows} = metrics;
    const anchored = name.endsWith('/profile-menu');
    const centered = /\/(create-playlist|genre)$/.test(name);
    const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 0.11,
        name + ' ' + label + ' was ' + actual + ', expected ' + expected);
    if (connect && !anchored && !centered) {
        // The update dialog keeps its night-sky scene instead of the standard dark panel fill.
        const sceneSurface = name.endsWith('/update');
        const {backgroundColor, backgroundImage, ...shape} = style;
        const {backgroundColor: panelColor, backgroundImage: panelImage, ...panelShape} = connect.style;
        if (sceneSurface) assert.deepEqual(shape, panelShape, name + ' surface');
        else assert.deepEqual(style, connect.style, name + ' surface');
        if (metrics.backdrop !== null) assert.equal(metrics.backdrop, connect.backdrop, name + ' backdrop');
        near(close.width, connect.close.width, 'close target width');
        near(close.height, connect.close.height, 'close target height');
        near(close.icon.width, connect.close.icon.width, 'close icon width');
        if (title.height === connect.title.height)
            near(title.text.y - metrics.header.y, connect.title.text.y - connect.header.y, 'heading baseline');
    }
    if (!sceneSurfaceName(name)) assert.equal(style.backgroundColor, phone ? 'rgb(31, 31, 31)' : 'rgb(18, 18, 18)', name);
    assert.equal(style.borderTopLeftRadius, anchored || centered ? '12px' : phone ? '18px' : '8px', name);
    assert.equal(style.borderTopWidth, '0px', name);
    assert.equal(style.animationName, 'none', name + ' reduced motion');
    near(title.x - box.x, phone ? 24 : 16, 'heading left inset');
    near(box.x + box.width - close.x - close.width, phone ? 12 : 8, 'close right inset');
    near(title.y + title.height / 2, close.y + close.height / 2, 'close center');
    const textRow = rows.find(row => row.text);
    if (rows.length) near(box.width, anchored ? 264 : phone ? 390 : 340, 'menu width');
    const [viewportWidth, viewportHeight] = metrics.viewport;
    if (centered) {
        near(box.x + box.width / 2, viewportWidth / 2, 'horizontal center');
        near(box.y + box.height / 2, viewportHeight / 2, 'vertical center');
        assert.ok(box.x >= 16 && box.y >= 16, name + ' viewport inset');
    }
    if (anchored) {
        const {anchor} = metrics;
        near(box.y - anchor.y - anchor.height, 8, 'gap below avatar');
        near(box.x + box.width, Math.min(viewportWidth - 8, anchor.x + anchor.width), 'right edge under avatar');
        assert.ok(box.y + box.height < viewportHeight - 7 && box.height < 340,
            `${name} compact height (${box.height}px at y=${box.y}px in a ${viewportHeight}px viewport)`);
    }
    const rowHeight = phone ? (anchored ? 52 : 56) : 44;
    for (const row of rows) {
        near(row.icon.width, 20, row.label + ' icon width');
        near(row.icon.height, 20, row.label + ' icon height');
        near(row.icon.x, title.x, row.label + ' icon column');
        near(row.icon.y + 10, row.box.y + row.box.height / 2, row.label + ' icon center');
        near(row.box.height, rowHeight, row.label + ' row height');
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
    const page = await fixturePage(browser, {...options, reducedMotion: 'reduce'});
    const captures = {};
    let connect;
    const pageErrors = [];
    const target = id => page.locator('#' + id);
    const heading = text => page.getByRole('heading', {name: text, exact: true});
    const select = async node => { if (phone) await node.tap(); else await node.click(); };
    const openMusic = () => select(page.locator('.hub-card.hub-music'));
    const closeByEscape = async surface => { await page.keyboard.press('Escape'); await surface.waitFor({state: 'hidden'}); };
    const focused = id => page.waitForFunction(expected => document.activeElement?.id === expected, id);
    const open = async (opener, id) => {
        await select(opener);
        const surface = target(id);
        await surface.waitFor();
        return surface;
    };
    const nav = async label => {
        if (phone && label === 'Server work') await open(target('profile-toggle'), 'profile-menu');
        await select(page.getByRole('button', {name: label, exact: true}).first());
        await heading(label).waitFor();
        await page.waitForFunction(view => document.body.dataset.view === view,
            label === 'Server work' ? 'stats' : label.toLowerCase());
    };
    // The Server page is the admin-only Server section of Settings; the leaderboard is on Home.
    const openServerSettings = async () => {
        await open(target('profile-toggle'), 'profile-menu');
        await select(target('open-settings'));
        await heading('Settings').waitFor();
        await select(target('settings-server'));
    };
    const capture = async (state, surface, menu = false) => {
        const scene = surface || page.locator('main#content');
        await scene.waitFor();
        if (!phone) await page.mouse.move(2, 2);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const metrics = surface ? await geometry(surface) : await scene.evaluate((node, state) => {
            const root = document.documentElement, box = node.getBoundingClientRect();
            const starts = {
                // In Settings the title belongs to the Settings window; the section lines up with the Settings content edge.
                'server-work': document.querySelector('.settings-page .server-work-page') ? ['.settings-page .server-work-page', '.settings-page .server-work-page > :first-child'] : ['#view-title', '.server-work-page'],
                leaderboard: [document.querySelector('.home-activity') ? '.home-activity' : '#view-title', '.leaderboard-page'],
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
        if (!before) assert.ok((await page.request.post(origin + '/fixture/startup/health-admin')).ok());
        await page.goto(origin);
        if (!before) await openMusic();
        await page.locator('#discovery-shelf .home-card').nth(7).waitFor();
        if (!before) {
            const radio = target('home-radio-daily').locator('.radio-shortcut-title .icon');
            await radio.waitFor();
            const icon = await radio.boundingBox();
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
        if (!before) {
            const songSearch = page.getByRole('searchbox', {name: 'Search songs', exact: true});
            const rows = page.locator('.library-list [data-recording-id]');
            await songSearch.fill('first light');
            await rows.filter({hasText: 'First Light'}).waitFor();
            await page.waitForFunction(() => document.querySelectorAll('.library-list [data-recording-id]').length === 1);
            await select(page.getByRole('button', {name: 'Clear song search'}));
            await focused('library-filter');
            await songSearch.fill('missing recording');
            await page.getByText('No songs match these filters.', {exact: true}).waitFor();
            await select(page.getByRole('button', {name: 'Reset song filters'}));
            await focused('library-filter');

            const genres = await open(target('genre-toggle'), 'genre-dialog');
            await capture('genre', genres);
            await focused('genre-close');
            await page.keyboard.press('Tab');
            await focused('genre-search');
            const genreSearch = genres.getByRole('combobox', {name: 'Search genres'});
            await genreSearch.fill('missing genre');
            await genres.getByText('No genres match this search.', {exact: true}).waitFor();
            await genreSearch.fill('rnb');
            const alias = genres.getByRole('option', {name: 'R&B / Soul', exact: true});
            await alias.waitFor();
            await genres.getByRole('option', {name: 'All genres', exact: true}).waitFor({state: 'hidden'});
            await page.keyboard.press('ArrowDown');
            await page.waitForFunction(() => document.getElementById('genre-search').getAttribute('aria-activedescendant') === 'genre-option-0');
            await page.keyboard.press('Enter');
            await genres.waitFor({state: 'hidden'});
            await focused('genre-toggle');
            await page.waitForFunction(() => document.querySelectorAll('.library-list [data-recording-id]').length === 6);
            await open(target('genre-toggle'), 'genre-dialog');
            await select(genres.getByRole('option', {name: 'All genres', exact: true}));
            await genres.waitFor({state: 'hidden'});
            await focused('genre-toggle');

            const libraryToolbar = await target('library-filter').boundingBox();
            await select(page.getByRole('button', {name: 'Downloaded', exact: true}).filter({visible: true}));
            const kept = page.getByRole('button', {name: /^Kept downloads/});
            await kept.waitFor();
            await focused('content');
            const downloadedToolbar = await target('library-filter').boundingBox();
            assert.deepEqual([libraryToolbar.x, libraryToolbar.height], [downloadedToolbar.x, downloadedToolbar.height], name + ' shared song search');
            assert.equal(await kept.getAttribute('aria-pressed'), 'true');
            assert.match(await kept.locator('.device-size').innerText(), /^1 song, 2[.,]0 MB$/);
            await rows.filter({hasText: 'Winter Sessions – Part 3'}).waitFor();
            assert.equal(await rows.count(), 1);
            const cache = page.getByRole('button', {name: /^Playback cache/});
            assert.match(await cache.locator('.device-size').innerText(), /^1 song, 1[.,]0 MB$/);
            await cache.press('Space');
            await rows.filter({hasText: 'Sand and Stone'}).waitFor();
            assert.equal(await rows.count(), 1);
            assert.equal(await cache.getAttribute('aria-pressed'), 'true');
            await focused('cached-downloads');
            await open(target('genre-toggle'), 'genre-dialog');
            await genres.getByRole('option', {name: 'Ambient', exact: true}).waitFor();
            await closeByEscape(genres);
            await focused('genre-toggle');
            await capture('downloaded');
            if (phone) await select(page.getByRole('button', {name: 'Songs', exact: true}));
            else await select(target('open-library'));
        }

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
        const playlistCard = key => page.locator(`[data-playlist-key="${key}"]`);
        const filterPlaylists = label => select(page.getByRole('button', {name: label, exact: true}));
        if (!before) {
            await heading('Playlists').waitFor();
            const shared = playlistCard('june:shared');
            await filterPlaylists('Mine');
            await shared.waitFor({state: 'hidden'});
            const playlistSearch = target('playlist-search');
            await playlistSearch.fill('cafe');
            await shared.waitFor();
            await playlistCard('fixture:mix0').waitFor({state: 'hidden'});
            await select(page.getByRole('button', {name: 'Clear playlist search'}));
            await focused('playlist-search');
            await playlistSearch.fill('missing playlist');
            await page.getByText('No playlists match.', {exact: true}).waitFor();
            await select(page.getByRole('button', {name: 'Clear playlist search'}));
            await filterPlaylists('Shared with me');
            await shared.waitFor();
            await playlistCard('fixture:mix0').waitFor({state: 'hidden'});
            await filterPlaylists('Radio & mixes');
            await playlistCard('fixture:radio').waitFor();
            await playlistCard('fixture:old-radio').waitFor();
            await playlistCard('fixture:mix0').waitFor();
            await shared.waitFor({state: 'hidden'});
            await filterPlaylists('All');
            await shared.waitFor();
            await capture('playlist-collection');
        }
        const sort = await open(target('playlist-sort'), 'playlist-sort-options');
        await capture('playlist-sort', sort, true);
        await closeByEscape(sort);
        const create = await open(target('create-playlist'), 'create-playlist-dialog');
        await capture('create-playlist', create);
        if (!before) {
            await focused('create-playlist-heading');
            await page.keyboard.press('Shift+Tab');
            await focused('create-playlist-submit');
            await page.keyboard.press('Tab');
            assert.equal(await create.getByRole('button', {name:'Close create playlist'}).evaluate(button => button === document.activeElement), true);
            await page.emulateMedia({reducedMotion: 'no-preference'});
            assert.equal(await create.evaluate(node => getComputedStyle(node).animationName), 'popup-fade-in');
        }
        await closeByEscape(create);
        if (!before) {
            await focused('create-playlist');
            await page.emulateMedia({reducedMotion: 'reduce'});
        }
        await select(playlistCard('fixture:mix0'));
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
        if (before) {
            const songSort = await open(target('playlist-song-sort'), 'playlist-song-sort-options');
            await capture('song-sort', songSort, true);
            await closeByEscape(songSort);
        } else {
            const titleSort = page.locator('.playlist-column-headings [data-sort="Title"]');
            for (const direction of ['ascending', 'descending', null]) {
                await select(titleSort);
                await page.waitForFunction(value => document.querySelector('[data-sort="Title"]').getAttribute('data-direction') === value, direction);
            }
        }
        await select(target('open-home'));
        await select(page.locator('#home-albums-shelf .home-card').first());
        await target('play-album').waitFor();
        await capture('album');

        if (before) await nav('Server work'); else await openServerSettings();
        await page.locator('.server-page[aria-busy=false]').waitFor();
        if (!before) await target('catalogue-filter-metadata').waitFor();
        await capture('server-work');
        if (!before) {
            assert.equal(await target('catalogue-category-panel').count(), 0);
            const automatic = page.getByRole('region', {name: 'Automatic work', exact: true});
            assert.equal(await automatic.locator('details').getAttribute('open'), null);
            assert.equal(await page.locator('.srv-review-links button').count(), 8);
            const workers = automatic.locator('summary');
            await workers.focus();
            await workers.press('Space');
            assert(await workers.evaluate(node => node.parentElement.open && document.activeElement === node));
            await workers.press('Enter');
            assert(await workers.evaluate(node => !node.parentElement.open && document.activeElement === node));
            const queue = target('catalogue-view-queue');
            await queue.focus();
            await queue.press('Enter');
            await focused('review-action-heading');
            await select(target('catalogue-filter-playlists'));
            await heading('Queued recording').waitFor();
            await page.getByText(/No verified recording match/).waitFor();
            await focused('catalogue-category-title');
            await page.keyboard.press('Shift+Tab');
            await focused('catalogue-back');
            await page.keyboard.press('Space');
            await focused('catalogue-filter-playlists');
            await page.keyboard.press('Shift+Tab');
            await focused('catalogue-back');
            await page.keyboard.press('Enter');
            await focused('catalogue-view-queue');
            await page.keyboard.press('Tab');
            await focused('catalogue-view-fixed');
            await page.keyboard.press('Enter');
            await heading('Fixed recordings and details').waitFor();
            await select(target('catalogue-back'));
            await focused('catalogue-view-fixed');
        }
        await select(page.getByRole('button', {name: /Song details/}));
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
        if (!before) await select(target('catalogue-back'));
        await select(page.getByRole('button', {name: /Missing from playlists/}));
        await open(page.getByRole('button', {name: /Review the recording of Station Lights/}), 'transfer-review-dialog');
        await target('transfer-review-dialog').getByText('Station Lights', {exact: true}).first().waitFor();
        await capture('review-recording', target('transfer-review-dialog'));
        await closeByEscape(target('transfer-review-dialog'));

        if (before) await nav('Leaderboard'); else await select(target('open-home'));
        await page.locator('.leaderboard-page[aria-busy=false]').waitFor();
        await capture('leaderboard');
        await target('lb-wrapped-title').evaluate(node => {
            const main = node.closest('main');
            main.scrollTop += node.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
        });
        await page.waitForFunction(selector => {
            const main = document.getElementById('content').getBoundingClientRect();
            const comparison = document.querySelector(selector)?.getBoundingClientRect();
            return comparison && comparison.top >= main.top && comparison.top < main.bottom;
        }, before ? '.lb-wrapped-card' : '.lb-year-metrics');
        await capture('wrapped');
        if (!before) {
            const picker = target('lb-wrapped-member');
            const metrics = page.locator('.lb-year-metrics');
            const check = async (label, value) => {
                const text = await metrics.locator('div').filter({has:page.getByText(label,{exact:true})}).locator('dd').innerText();
                assert.equal(text,value);
            };
            assert.equal(await picker.getAttribute('aria-label'), 'Choose listener, Alex');
            assert.equal(await metrics.locator('dt').count(),9);
            await check('Songs added','14');
            await check('Listening time','116 min');
            await check('Favourite artist','North Atlas');
            await check('Most replayed','Station Lights (1 replay, North Atlas)');
            assert(await metrics.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            await picker.focus();
            await page.keyboard.press('Enter');
            const menu = target('lb-person-menu');
            await menu.waitFor();
            await menu.getByRole('button',{name:'June'}).focus();
            await page.keyboard.press('Space');
            await menu.waitFor({state:'hidden'});
            await page.waitForFunction(() => document.querySelector('#lb-wrapped-member').textContent.includes('June'));
            await check('Listening time','63 min');
            assert(await picker.evaluate(node => node === document.activeElement));
            await picker.press('Enter');
            await menu.waitFor();
            await page.keyboard.press('Escape');
            await menu.waitFor({state:'hidden'});
            await picker.press('Enter');
            // Reopened right after Escape: let the menu settle before pointing at a row.
            await page.waitForTimeout(400);
            await menu.getByRole('button',{name:'Alex'}).click();
            await menu.waitFor({state:'hidden'});
            const help = target('lb-wrapped-help');
            await help.press('Enter');
            await page.getByText('Deezer chart checked 18 Nov 2026.').waitFor();
            await help.press('Enter');
            assert(await help.evaluate(node => node === document.activeElement), 'Toggling help must preserve focus');
            assert(await heading('Records').evaluate(node => Boolean(document.querySelector('.lb-wrapped')
                .compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)), 'Records must follow annual listening');
        }
        const listener = page.locator('.listener-options').first();
        if (await listener.count()) {
            const id = (await listener.getAttribute('id')) + '-dialog';
            await open(listener, id);
            await capture('listener-menu', target(id), true);
            await closeByEscape(target(id));
        }
        const profile = await open(target('profile-toggle'), 'profile-menu');
        await capture('profile-menu', profile, true);
        if (!before) {
            await focused('profile-menu-close');
            await page.keyboard.press('Shift+Tab');
            await focused('open-feedback'); // Feedback is the last control in the menu, so focus wraps to it.
            await page.keyboard.press('Tab');
            await focused('profile-menu-close');
            await closeByEscape(profile);
            await focused('profile-toggle');
            await page.waitForFunction(() => document.getElementById('profile-toggle').getAttribute('aria-expanded') === 'false');
            await open(target('profile-toggle'), 'profile-menu');
        }
        await select(target('open-settings'));
        await heading('Settings').waitFor();
        await page.waitForFunction(() => document.body.dataset.view === 'preferences');
        await capture('settings');
        if (!before) {
            const backToCategories = async category => {
                if (!phone) return;
                await select(page.getByRole('button', {name: 'Back to settings categories'}));
                await focused(category);
            };
            await target('settings-general').focus();
            await page.keyboard.press('Tab');
            await focused('settings-music');
            await page.keyboard.press('Tab');
            await focused('settings-movies');
            await page.keyboard.press('Space');
            // Streaming quality moved to Settings > Data (round 4); settings_shell covers it there.
            await target('movie-preferred-audio').and(page.locator(':enabled')).waitFor();
            if (output) await page.screenshot({path: path.join(output, name,
                name + '-movie-settings.png'), scale: 'css', animations: 'disabled'});
            const audio = target('movie-preferred-audio');
            await audio.selectOption('hu');
            await page.waitForFunction(() => JSON.parse(localStorage.getItem(
                'familyhub:movie-tracks:' + JSON.stringify({server: 'https://music.fixture.test/', profile: 'fixture'})))?.audio === 'hu');
            const subtitles = target('movie-preferred-subtitles');
            await subtitles.selectOption('off');
            await page.waitForFunction(() => JSON.parse(localStorage.getItem(
                'familyhub:movie-tracks:' + JSON.stringify({server: 'https://music.fixture.test/', profile: 'fixture'})))?.subtitles === 'off');
            await backToCategories('settings-movies');
            await target('settings-movies').focus();
            await page.keyboard.press('Shift+Tab');
            await focused('settings-music');
            await page.keyboard.press('Enter');
            await heading('Music playback').waitFor();
            await focused(phone ? 'settings-category' : 'settings-music');
            await backToCategories('settings-music');
            await target('settings-movies').press('Enter');
            await page.waitForFunction(() => document.getElementById('movie-preferred-audio')?.value === 'hu');
            assert.equal(await subtitles.inputValue(), 'off');
            await backToCategories('settings-movies');
            await target('settings-music').press('Enter');
            // The phone shell focuses the new category after rendering it.
            await focused(phone ? 'settings-category' : 'settings-music');
            const diagnostics = page.getByRole('region', {name: 'Playback diagnostics'});
            await diagnostics.getByRole('button', {name: 'Load attempts'}).press('Enter');
            const refreshAttempts = diagnostics.getByRole('button', {name: 'Refresh attempts'});
            const action = diagnostics.locator('summary').filter({hasText: 'Started, then stopped unexpectedly.'});
            await action.waitFor();
            assert.match(await action.innerText(), /First Light\s*, \d{1,2}:\d{2}.*:\s+Started, then stopped unexpectedly\./);
            const older = diagnostics.locator('summary').filter({hasText: 'Unknown song, Time unavailable'});
            assert.match(await older.nth(0).innerText(), /Time unavailable:\s+The retry loaded\. Playback start is unconfirmed\./);
            assert.match(await older.nth(1).innerText(), /Time unavailable:\s+Started playing\./);
            assert.doesNotMatch(await diagnostics.innerText(), /fedcba98|adb80533|cdb80533/);
            assert.equal(await refreshAttempts.evaluate(node => node === document.activeElement), true,
                name + '/settings: loading diagnostics should retain focus on Refresh attempts');
            const firstAttempt = diagnostics.locator('summary').first();
            await page.keyboard.press('Tab');
            assert.equal(await firstAttempt.evaluate(node => node === document.activeElement), true);
            await page.keyboard.press('Shift+Tab');
            assert.equal(await refreshAttempts.evaluate(node => node === document.activeElement), true);
            await action.focus();
            await page.keyboard.press('Space');
            await diagnostics.getByText(/stream response ready/i).waitFor();
            assert.equal(await action.evaluate(node => node === document.activeElement), true);
            const persisted = diagnostics.locator('summary').filter({hasText: 'Playback interrupted at 0:49.'});
            assert.match(await persisted.innerText(), /City Lights/);
            await persisted.press('Enter');
            await diagnostics.getByText('Stream ended early', {exact: true}).waitFor();
            await diagnostics.getByText(/song position 0:49/).waitFor();
            const mirrored = diagnostics.locator('summary').filter({hasText: 'Playback interrupted at 0:50.'});
            await mirrored.press('Enter');
            await diagnostics.getByText('Audio player reported an error (the player timed out)', {exact: true}).waitFor();
            await diagnostics.getByText(/song position 0:50/).waitFor();
            assert.doesNotMatch(await diagnostics.innerText(), /fedcba98|adb80533|cdb80533|edcba987|ddcba987/);
        }
        const clearHistory = await open(target('clear-history'), 'clear-history-dialog');
        await capture('clear-history', clearHistory);
        if (!before) assert.equal(await clearHistory.getByRole('button', {name: 'Close clear listening history', exact: true}).count(), 1);
        await closeByEscape(clearHistory);
        if (!before) {
            await focused('clear-history');
            if (phone) {
                await select(target('settings-exit'));
                await focused('settings-music');
            }
            await select(target('settings-exit'));
            await target('settings-exit').waitFor({state: 'hidden'});
            await focused('profile-toggle');
        }

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
        if (!before) {
            await select(playlists);
            const recent = page.getByRole('region', {name: 'Recent', exact: true});
            const pinned = page.getByRole('region', {name: 'Pinned', exact: true});
            await recent.locator('[data-playlist-key="fixture:mix0"]').waitFor();
            await select(playlistCard('fixture:mix0'));
            await focused('view-title');
            await playlistMenu();
            assert.equal(await target('pin-playlist').innerText(), 'Pin playlist');
            await select(target('pin-playlist'));
            await focused('playlist-menu-toggle');
            await select(page.getByRole('button', {name: 'All playlists', exact: true}));
            await pinned.locator('[data-playlist-key="fixture:mix0"]').waitFor();
            await focused('playlist-card-fixture:mix0');
            await page.reload();
            await openMusic();
            await select(playlists);
            await pinned.locator('[data-playlist-key="fixture:mix0"]').waitFor();
            await select(playlistCard('fixture:mix0'));
            await playlistMenu();
            assert.equal(await target('pin-playlist').innerText(), 'Unpin playlist');
            await select(target('pin-playlist'));
            await focused('playlist-menu-toggle');
            await select(page.getByRole('button', {name: 'All playlists', exact: true}));
            await recent.locator('[data-playlist-key="fixture:mix0"]').waitFor();
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
        try {
            if (!before) await page.request.post(origin + '/fixture/startup/none');
        } finally {
            await browser.close();
        }
    }
}

async function runWithFixture(run) {
    setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
    const ready = () => fetch(origin + '/fixture/update-check', {signal: AbortSignal.timeout(500), redirect: 'error'})
        .then(response => response.ok, () => false);
    if (await ready()) return run();
    assert.ok(!process.env.POPUP_URL, `Popup fixture did not respond at ${origin}`);
    const executable = path.join(__dirname, 'fixtures/music-popup-host/bin/Debug/net10.0-windows10.0.19041.0/MusicPopupHost.exe');
    assert.ok(fs.existsSync(executable), 'Build the existing Windows music popup fixture before running its browser checks');
    if (!before) {
        const native = path.join(root, 'clients/FamilyHub.App/bin/x64/Debug/net10.0-windows10.0.19041.0/win-x64');
        for (const name of ['FamilyHub.App.dll', 'FamilyHub.Client.Core.dll']) {
            const source = path.join(native, name);
            const target = path.join(path.dirname(executable), name);
            assert.ok(fs.existsSync(source), 'Build the Windows Debug app before running its browser checks');
            // The fixture serves current wwwroot files directly. Load the matching Razor build even if the host was built first.
            if (!fs.existsSync(target) || !fs.readFileSync(source).equals(fs.readFileSync(target)))
                fs.copyFileSync(source, target);
        }
    }
    const host = spawn(executable, {
        cwd: root, windowsHide: true, stdio: 'inherit', env: {...process.env, POPUP_URL: origin}
    });
    let startupError;
    host.on('error', error => { startupError = error; });
    try {
        const deadline = Date.now() + 15000;
        while (!await ready()) {
            if (startupError) throw startupError;
            if (host.exitCode !== null || Date.now() >= deadline)
                throw Error(`MusicPopupHost did not start at ${origin}`);
            await delay(200);
        }
        await run();
    } finally {
        host.kill();
    }
}

async function fixturePage(browser, options) {
    const page = await browser.newPage({...options, serviceWorkers: 'block'});
    await page.route('**/*', route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.abort());
    return page;
}

module.exports = {origin, runWithFixture, fixturePage};

async function playbackRecovery() {
    const browser = await chromium.launch({headless: true});
    const page = await fixturePage(browser, devices['Pixel 7']);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const trigger = name => page.locator('#fixture-' + name).evaluate(button => button.click());
    const first = '00000000001', next = '00000000002';
    const playing = (opens, position, track = first, state = 'playing') =>
        page.waitForFunction(([opens, position, track, state]) => {
            const value = document.getElementById('fixture-playback')?.dataset;
            return value && Number(value.opens) === opens && Number(value.position) === position &&
                value.track === track && value.state === state;
        }, [opens, position, track, state], {timeout: 13000});
    const diagnostics = async () => (await page.request.get(origin + '/fixture/playback-diagnostics')).json();
    try {
        assert((await page.request.post(origin + '/fixture/startup/playback-recovery')).ok());
        assert((await page.request.get(origin + '/fixture/playback-diagnostics')).ok(),
            'Rebuild MusicPopupHost with the playback recovery fixture before running this suite');
        assert((await page.goto(origin + '/outage/playback')).ok());
        await page.locator('#fixture-playback').waitFor();
        await page.locator('.hub-card.hub-music').tap();
        await page.locator('#play').waitFor();
        await trigger('start');
        await playing(1, 0);
        await page.waitForFunction(async () => {
            const result = await fetch('/fixture/playback-diagnostics');
            return (await result.json()).some(event => event.stage === 'play');
        }, null, {polling: 100});
        await trigger('background');
        await page.evaluate(() => familyhub.setNativeActive(false));
        for (const [opens, position] of [[2, 37], [3, 44], [4, 44]]) {
            await trigger('interrupt');
            await playing(opens, position);
        }
        await trigger('interrupt');
        await playing(5, 0, next);
        assert(!(await diagnostics()).some(event => ['stream_failed', 'stream_retry', 'failed', 'stream_skipped'].includes(event.stage)));

        await page.evaluate(() => familyhub.setNativeActive(true));
        await trigger('resume');
        await page.locator('#play').click();
        await playing(5, 0, next, 'paused');
        await page.waitForFunction(async () => {
            const result = await fetch('/fixture/playback-diagnostics');
            return (await result.json()).some(event => event.stage === 'stream_skipped');
        }, null, {polling: 100});
        const rows = await diagnostics();
        const action = rows.find(event => event.stage === 'stream_skipped').action;
        const stages = rows.filter(event => event.action === action);
        assert(stages.some(event => event.stage === 'stream_failed'));
        assert(stages.some(event => event.stage === 'failed'));
        assert.deepEqual(stages.filter(event => event.stage === 'stream_retry').map(event => event.position_ms), [37000, 44000, 44000]);
        assert.deepEqual(errors, []);
        console.log('PASS Android fixture: stream resume, skip and queued diagnostics');
    } finally {
        try {
            await page.request.post(origin + '/fixture/startup/none');
        } finally {
            await browser.close();
        }
    }
}

if (require.main === module) {
    runWithFixture(async () => {
        const requested = process.env.POPUP_PROFILES?.split(',');
        if (!before && (!requested || requested.includes('android-chrome-390'))) await playbackRecovery();
        for (const profile of profiles.filter(([name]) => !requested || requested.includes(name))) await audit(...profile);
    }).catch(error => { console.error(error); process.exitCode = 1; });
}
