// Exercises the native player's shipped styles and seek binding in browser fixture markup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const paths = [root, path.resolve(root, '../agent-dock')];
const { chromium, webkit, devices } = require(require.resolve('playwright', { paths }));
const { PNG } = require(require.resolve('playwright-core/lib/utilsBundle', { paths }));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const web = 'clients/FamilyHub.App/wwwroot/';
const styles = [...read(web + 'index.html').matchAll(/rel="stylesheet" href="([^"]+)"/g)]
    .map(([, file]) => read(file === 'shell.css' ? 'music_web/static/shell.css' : web + file)).join('\n');
const seekSource = read('clients/FamilyHub.App/Components/SeekBar.razor');
const seekMarkup = seekSource.slice(seekSource.indexOf('<div class="seek-row">'), seekSource.indexOf('@code'))
    .replace(/style=".*"(?=>)/, 'style="--seek-position:50%"')
    .replaceAll('@Time(Position)', '1:30').replace('@Time(Player.Duration)', '3:00')
    .replace(/<input[\s\S]*?\/>/, '<input aria-label="Playback position" type="range" min="0" max="180" value="90" step="0.1">');
const icon = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"/></svg>';
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style>
<body data-theme="violet"><div id="app" style="display:contents">
<header class="app-header"></header><aside class="sidebar"></aside><div class="workspace"><main></main></div>
<footer class="player-bar">
  <div class="now-playing-group">
    <button id="show-queue" class="now-playing">
      <span class="cover"></span><span class="now-copy"><strong id="now-title"><span class="marquee-text">Dawn</span></strong><span id="now-artist">North Atlas</span></span>
    </button>
    <button id="now-add-playlist" class="quiet row-action song-playlist-add" aria-label="Add Dawn to playlist">${icon}</button>
  </div>
  <div class="transport"><div class="transport-buttons">
    <button id="shuffle-toggle" class="quiet">${icon}</button><button class="quiet">${icon}</button>
    <button id="play" class="primary round">${icon}</button><button class="quiet">${icon}</button>
    <button id="repeat-toggle" class="quiet">${icon}</button>
  </div>${seekMarkup}</div>
  <button id="player-more" class="quiet player-more">${icon}</button>
</footer><blazor-focus-on-navigate></blazor-focus-on-navigate></div></body>`;

const closeTo = (actual, expected, label) => assert(Math.abs(actual - expected) < 1, `${label}: ${actual} vs ${expected}`);
const centerY = box => box.y + box.height / 2;
const white = pixel => pixel.every(channel => channel >= 250);
const violetAccent = [199, 163, 255];
const blackBottom = png => png.data.subarray(-4 * png.width).every((channel, index) => index % 4 === 3 || channel === 0);
async function seekPixels(page, input) {
    const box = await input.boundingBox();
    const { fraction, fillPosition } = await input.evaluate(node => ({
        fraction: node.valueAsNumber / Number(node.max),
        fillPosition: parseFloat(node.parentNode.style.getPropertyValue('--seek-position')) / 100
    }));
    const png = PNG.sync.read(await page.screenshot({ scale: 'css' }));
    const pixel = (x, y) => [...png.data.subarray(4 * (Math.floor(y) * png.width + Math.floor(x)), 4 * (Math.floor(y) * png.width + Math.floor(x)) + 3)];
    const thumbX = box.x + 6 + (box.width - 12) * fraction;
    return {
        thumbX,
        blackBottom: blackBottom(png),
        thumb: pixel(thumbX, centerY(box) + 3),
        fill: pixel(box.x + box.width * fillPosition / 2, centerY(box)),
        trackEdge: pixel(box.x + box.width * .9, centerY(box) - 2),
        aboveTrack: pixel(box.x + box.width * .9, centerY(box) - 3)
    };
}

(async () => {
    for (const [name, engine, profile] of [
        ['Windows 1280', chromium, { viewport: { width: 1280, height: 900 } }],
        ['Windows 2000', chromium, { viewport: { width: 2000, height: 1060 } }],
        ['Windows 850', chromium, { viewport: { width: 850, height: 641 } }],
        ['Mac WebKit', webkit, { viewport: { width: 1440, height: 900 } }],
        ['Android Chromium', chromium, devices['Pixel 7']],
        ['iPhone WebKit', webkit, devices['iPhone 13']]
    ]) {
        const browser = await engine.launch({ headless: true });
        try {
            const page = await browser.newPage({ ...profile, reducedMotion: 'reduce' });
            await page.route('https://player.test/', route => route.fulfill({ contentType: 'text/html', body: html }));
            await page.goto('https://player.test/');
            await page.addScriptTag({ content: read(web + 'app.js') });
            const footer = page.locator('.player-bar');
            const input = page.getByRole('slider', { name: 'Playback position', includeHidden: true });
            const tip = footer.locator('.seek-tooltip');
            assert.deepEqual(await footer.evaluate(node => {
                const style = getComputedStyle(node);
                return [style.backgroundColor, style.backgroundImage];
            }), ['rgb(0, 0, 0)', 'none']);
            await input.evaluate(node => familyhub.bindSeekHover(node));
            if (profile.hasTouch) {
                assert.equal(await input.isVisible(), false, 'The phone mini player has no seek row');
                assert.equal(await footer.locator('#now-title .marquee-text').evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
                await footer.evaluate(node => node.classList.add('is-expanded'));
                const dispatch = type => input.dispatchEvent(type, { pointerType: 'touch', pointerId: 1, button: 0 });
                const cdp = engine === chromium ? await page.context().newCDPSession(page) : null;
                const box = await input.boundingBox();
                const points = [{ x: box.x + box.width / 2, y: centerY(box) }];
                assert(!white((await seekPixels(page, input)).thumb));
                assert.equal(await tip.isVisible(), false);
                if (cdp) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
                    const moved = [{ x: points[0].x + 20, y: points[0].y }];
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: moved });
                } else {
                    await dispatch('pointerenter');
                    await dispatch('pointerdown');
                }
                assert.equal(await tip.isVisible(), true);
                const dragged = await seekPixels(page, input);
                assert(white(dragged.thumb));
                assert.deepEqual(dragged.fill, violetAccent);
                if (cdp)
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                else
                    await dispatch('pointercancel');
                assert.equal(await tip.isVisible(), false);
                const idle = await seekPixels(page, input);
                assert(!white(idle.thumb));
                console.log(name, cdp ? 'emulated touch drag passed' : 'synthetic touch pointer states passed');
                continue;
            }

            const box = await input.boundingBox();
            const idle = await seekPixels(page, input);
            const bar = await footer.boundingBox();
            closeTo(bar.y + bar.height, profile.viewport.height, 'player bottom edge');
            assert(idle.blackBottom, 'Every RGB pixel at the desktop bottom edge is black');
            assert.equal(await tip.isVisible(), false);
            assert.deepEqual(idle.thumb, [0, 0, 0]);
            assert.deepEqual(idle.fill, [238, 238, 238]);
            assert.deepEqual(idle.trackEdge, [77, 77, 77]);
            assert.deepEqual(idle.aboveTrack, [0, 0, 0]);
            const pointerX = Math.floor(box.x + box.width * .66);
            await page.mouse.move(pointerX, centerY(box));
            const hover = await seekPixels(page, input);
            assert(white(hover.thumb));
            assert.deepEqual(hover.fill, violetAccent);
            const measureTip = async expectedX => {
                assert(await tip.isVisible());
                const rect = await tip.boundingBox();
                closeTo(rect.x + rect.width / 2, expectedX, 'tooltip centre');
                const gap = centerY(box) - 2 - (rect.y + rect.height);
                closeTo(gap, 9, 'tooltip gap');
                assert.equal(rect.height, 26);
                return gap;
            };
            const gap = await measureTip(pointerX);
            await page.mouse.move(Math.ceil(box.x + 1), centerY(box));
            closeTo((await tip.boundingBox()).x, box.x, 'left clamp');
            await page.mouse.move(Math.floor(box.x + box.width - 1), centerY(box));
            const right = await tip.boundingBox();
            closeTo(right.x + right.width, box.x + box.width, 'right clamp');
            await page.mouse.move(1, 1);
            await page.locator('#repeat-toggle').focus();
            await page.keyboard.press('Tab');
            assert(await input.evaluate(node => node.matches(':focus-visible')));
            assert.equal(await input.evaluate(node => getComputedStyle(node.parentNode).outlineWidth), '2px');
            const focused = await seekPixels(page, input);
            assert(white(focused.thumb));
            await measureTip(focused.thumbX);
            await page.keyboard.press('End');
            assert.equal(await input.inputValue(), '180');
            assert.equal(await tip.textContent(), '3:00');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await tip.isVisible(), false);
            await page.mouse.move(pointerX, centerY(box));
            await page.mouse.down();
            const dragged = await seekPixels(page, input);
            assert(white(dragged.thumb));
            await measureTip(dragged.thumbX);
            await page.mouse.move(pointerX, centerY(box) + 40);
            await page.mouse.up();
            assert.equal(await input.evaluate(node => node.parentNode.classList.contains('is-dragging')), false);

            const add = page.locator('#now-add-playlist');
            const short = await add.boundingBox();
            const title = page.locator('#now-title');
            await title.locator('.marquee-text').evaluate(node => { node.textContent = 'A Long Drive Along the Coast and the Slow Return Through the Mountains'; });
            await add.evaluate(node => node.classList.add('is-added'));
            assert.equal((await add.boundingBox()).x, short.x);
            assert.equal(short.width, 44);
            assert.equal(short.height, 44);
            closeTo(centerY(short), centerY(await page.locator('.now-copy').boundingBox()), 'text centre');
            closeTo(centerY(short), centerY(await page.locator('.now-playing .cover').boundingBox()), 'cover centre');
            assert(await title.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).textOverflow === 'ellipsis'));
            assert.equal((await add.locator('.icon').boundingBox()).width, 16);
            await add.hover();
            assert.equal(await add.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
            assert.equal(await add.evaluate(node => getComputedStyle(node).boxShadow), 'none');
            const buttons = await page.locator('.transport-buttons button').all();
            const controls = await Promise.all(buttons.map(button => button.boundingBox()));
            for (const [index, button] of controls.entries()) {
                assert.equal(button.width, 32);
                assert.equal(button.height, 32);
                if (index) closeTo(button.x - controls[index - 1].x - 32, 8, 'transport gap');
            }
            closeTo(controls[2].x + 16, box.x + box.width / 2, 'transport centre');
            console.log(name, `tooltip gap ${gap}px, fixed playlist slot x=${short.x}px`);
            if (name === 'Windows 850') {
                await footer.evaluate(node => node.insertAdjacentHTML('afterend',
                    '<div id="device-strip" class="device-strip" role="status">Playing on Kitchen</div>'));
                assert((await seekPixels(page, input)).blackBottom, 'The device status row has a black bottom edge');
                await footer.evaluate(node => {
                    document.getElementById('device-strip').remove();
                    node.classList.add('is-remote-peek');
                    node.insertAdjacentHTML('afterend',
                        '<section class="remote-mini"><span class="remote-mini-line">Playing on Kitchen</span></section>');
                });
                const remote = PNG.sync.read(await page.screenshot());
                assert(blackBottom(remote), 'The remote player has a black bottom edge');
            }
        } finally {
            await browser.close();
        }
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
