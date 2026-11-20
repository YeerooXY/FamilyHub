/* Browser composition/keyboard/player checks with synthetic media and controlled API responses.
   Backend acquisition/ownership is exercised separately by the Python suite. */
const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const root = path.resolve(__dirname, '..'), out = path.join(root, '.local/music-browser');
const tracks = [1, 2, 3].map((n) => ({ id: String(n).padStart(11, '0'), url: `https://www.youtube.com/watch?v=${String(n).padStart(11, '0')}`, title: `Synthetic recording ${n}`, channel: n < 3 ? 'Related artist' : 'Other artist', genre: n < 3 ? 'Pop' : 'Rock', duration: 40, saved: true }));
const mime = { '.svg':'image/svg+xml', '.png':'image/png', '.js': 'text/javascript', '.css': 'text/css', '.m3u8': 'application/vnd.apple.mpegurl', '.mp4': 'video/mp4', '.m4s': 'video/mp4' };
async function check(name, engine, contextOptions) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage(), errors = [], jobs = new Map();
  let requests = [], failSearch = false;
  const testPlaylist={id:'3ZOpGHzrl9qpQ3qTSxn5Nl',name:'Example playlist',notice:'Public entries may be incomplete.',tracks:[{title:tracks[0].title,artist:tracks[0].channel,duration:40,candidates:[],state:'unmatched'}]};
  let importedPlaylist=false;
  page.on('pageerror', (e) => errors.push(e.message));
  function job(track, priority = 0) {
    const previous = jobs.get(track.id);
    const result = { id: 'job-' + track.id, source_id: track.id, state: 'done', phase: 'done', priority,
      message: priority ? 'Prepared' : 'Saved', artist: track.channel, title: track.title, preview_state: 'ready',
      media_url: `/api/jobs/job-${track.id}/media/index.m3u8`, analysis: { reliable: true, bpm: 120,
        beats: Array.from({ length: 80 }, (_, i) => i * .5), confidence: .9 } };
    jobs.set(track.id, previous && !priority ? { ...result, id: previous.id } : result);
    return jobs.get(track.id);
  }
  await page.route('https://music.test/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (p.startsWith('/api/artwork/')) return route.fulfill({status:404});
    if (p === '/') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(out, 'index.html')) });
    if (p === '/login') return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(out, 'login.html')) });
    if (p.startsWith('/static/')) {
      const file = path.join(root, 'music_web', p.slice(1));
      return route.fulfill({ contentType: mime[path.extname(file)], body: fs.readFileSync(file) });
    }
    if (p.includes('/media/')) {
      const file = path.join(out, 'hls', path.basename(p));
      return route.fulfill({ contentType: mime[path.extname(file)], body: fs.readFileSync(file) });
    }
    const data = req.method() === 'POST' ? req.postDataJSON() : null;
    if (data) requests.push({ p, data });
    let body = {};
    if (p === '/api/playlists') body={playlists:importedPlaylist?[testPlaylist]:[]};
    else if (p === '/api/playlists/spotify') {importedPlaylist=true;body={playlist:testPlaylist};}
    else if (p.startsWith('/api/playlists/') && p.endsWith('/match')) {testPlaylist.tracks[0].candidates=[{...tracks[0],recommended:true}];testPlaylist.tracks[0].state='ready';body={track:testPlaylist.tracks[0]};}
    else if (p.startsWith('/api/playlists/') && p.endsWith('/download')) {testPlaylist.tracks[0].state='saved';testPlaylist.tracks[0].match=tracks[0];body={job:job(tracks[0])};}
    else if (p === '/api/search') {
      if (failSearch) return route.fulfill({ status: 502, json: { error: 'Search failed. Try again later.' } });
      body = { results: tracks };
    } else if (p === '/api/jobs' && data) {
      const track = tracks.find((t) => t.url === data.url);
      body = { job: job(track) };
    } else if (p === '/api/jobs') body = { jobs: [...jobs.values()] };
    else if (p === '/api/queue') body = { jobs: data.tracks.filter((t) => data.allow_new || t.saved).map((t, i) => job(t, i + 1)) };
    else if (p === '/api/library') body = { results: tracks, genre_keys: {Pop: 'pop', Rock: 'rock'},
      genres: [{key:'pop',label:'Pop',plays:2},{key:'rock',label:'Rock',plays:1}] };
    else if (p === '/api/transition') body = { plan: { out: 36, in: .5, rate: 1, fade: data.fade, mode: data.dj ? 'Beat blend' : 'Crossfade' } };
    else if (p.endsWith('/cancel')) body = { job: [...jobs.values()][0] };
    else body = { job: [...jobs.values()].find((j) => p.endsWith(j.id)) };
    return route.fulfill({ json: body });
  });
  try {
    await page.goto('https://music.test/');
    await page.waitForSelector('#library-list article');
    assert.equal(await page.locator('#library-list article').count(), 3);
    await page.locator('#library-filter').fill('Related artist');
    await page.waitForFunction(() => [...document.querySelectorAll('#library-list article')].filter(node => !node.hidden).length === 2);
    await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(() => document.activeElement.id === 'library-filter'));
    await page.locator('#library-filter').fill('');
    await page.locator('#library-genres [data-genre="rock"]').click();
    assert.equal(await page.locator('#library-list article:visible').count(),1);
    await page.locator('#library-genres [data-genre="rock"]').click();
    await page.locator('#playlist-panel summary').click();
    await page.locator('#spotify-playlist-url').fill('https://open.spotify.com/playlist/3ZOpGHzrl9qpQ3qTSxn5Nl');
    await page.locator('#spotify-playlist-url').press('Enter');
    await page.waitForFunction(()=>document.querySelector('#playlist-tracks').children.length===1);
    await page.locator('#playlist-match').click();
    await page.waitForFunction(()=>document.querySelector('#playlist-tracks select').value==='0' && !document.querySelector('#playlist-download').disabled);
    await page.locator('#playlist-download').click();
    await page.getByText('1 recording saved.', {exact:true}).waitFor();
    await page.locator('#playlist-detail').scrollIntoViewIfNeeded();
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'Playlist overflow');
    await page.screenshot({path:path.join(out,name+'-playlist-import.png')});
    await page.locator('#playlist-panel summary').click();
    await page.locator('#profile-toggle').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#profile-toggle').getAttribute('aria-expanded'), 'true');
    await page.locator('#nav-settings').focus();
    await page.screenshot({ path: path.join(out, name + '-profile.png'), fullPage: false });
    await page.keyboard.press('Escape');
    assert(await page.locator('#profile-menu').isHidden());
    assert(await page.evaluate(() => document.activeElement.id === 'profile-toggle'), 'Profile Escape must restore focus');
    await page.keyboard.press('Enter');
    await page.locator('#nav-settings').focus();
    await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(() => document.activeElement.id === 'profile-toggle'), 'Profile reverse tab order');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement.id === 'nav-settings'), 'Profile tab order');
    await page.keyboard.press('Enter');
    assert(await page.locator('#settings-view').isVisible());
    assert(await page.locator('#profile-menu').isHidden());
    assert(await page.evaluate(() => document.activeElement.tagName !== 'BODY'), 'Settings navigation lost focus');
    assert(!await page.locator('#include-long-mixes').isChecked(), 'Long mixes are excluded by default');
    await page.locator('#include-long-mixes').focus();
    await page.keyboard.press('Space');
    assert(await page.locator('#include-long-mixes').isChecked());
    assert(await page.evaluate(() => document.activeElement.id === 'include-long-mixes'), 'Long-mix option lost focus');
    await page.keyboard.press('Space');
    assert(!await page.locator('#include-long-mixes').isChecked());
    await page.locator('#nav-search').click();
    await page.locator('#q').fill('Synthetic');
    await page.locator('#q').press('Enter');
    await page.waitForSelector('#results button');
    assert(await page.locator('#queue-view').isHidden(), 'Queue is separate from search');
    assert.equal(await page.locator('#nav-queue').count(), 0);
    const add = page.locator('#results .queue-add').last();
    await add.focus(); await page.keyboard.press('Enter');
    assert(await add.evaluate(n => n === document.activeElement), 'Queue addition lost focus');
    assert.equal(await add.getAttribute('aria-disabled'), 'true');
    assert.equal(await page.evaluate(() => queue[0].id), tracks[2].id);
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => queue.filter(t => t.id === '00000000003').length), 1);
    await page.waitForTimeout(250);
    assert(!requests.some(r => r.p === '/api/queue' && r.data.previews?.length), 'Search requested audio before playback');
    const geometry = await page.evaluate(() => {
      const row = document.querySelector('#results li'), button = row.querySelector('.song-primary');
      const content = document.querySelector('#content'), style = getComputedStyle(content);
      return {height:button.getBoundingClientRect().height, available:content.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom), width:innerWidth,
        plusInside:row.querySelector('.queue-add').getBoundingClientRect().right <= row.getBoundingClientRect().right,
        durationHidden:getComputedStyle(row.querySelector('.time')).display === 'none'};
    });
    assert(geometry.height >= 56 && geometry.plusInside && geometry.durationHidden);
    if(geometry.width > 860) assert(Math.abs(geometry.height * 10 - geometry.available) < 2, 'Ten desktop rows fit the viewport');
    const searchIcon = await page.evaluate(() => {
      const button = document.querySelector('#search-form button').getBoundingClientRect();
      const icon = document.querySelector('#search-form button .icon').getBoundingClientRect();
      return Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2);
    });
    assert(searchIcon < 1, 'Search icon is vertically centered');
    await page.locator('#results button').first().focus();
    await page.evaluate(() => {
      const button = document.querySelector('#results .song-primary'); button.click();
      if(!button.classList.contains('is-selected')) throw Error('Selection did not update synchronously');
    });
    await page.waitForFunction(() => currentJob?.state === 'done' && currentJob.media_url);
    assert.equal(await page.locator('#nav-import').count(), 0);
    const barEdges = await page.locator('.player-bar').boundingBox();
    if (page.viewportSize().width > 860) {
      assert(Math.abs(barEdges.x) < 1 && Math.abs(barEdges.width - page.viewportSize().width) < 1, 'Player must reach both window edges');
    }
    if (engine === chromium) await page.waitForFunction(() => !document.querySelector('#seek').disabled && decks[deckIndex].currentTime > 0);
    if (engine === chromium) await page.evaluate(() => {
      const seek = document.querySelector('#seek'); seek.focus();
      const player = decks[deckIndex];
      player.currentTime = 5; player.dispatchEvent(new Event('timeupdate'));
      if (Math.abs(Number(seek.value) - 5) > .1) throw Error('Focused seek slider froze');
      seek.dispatchEvent(new Event('pointerdown'));
      seek.value = 8; player.currentTime = 6; player.dispatchEvent(new Event('timeupdate'));
      if (Number(seek.value) !== 8) throw Error('Dragging slider was overwritten');
      window.dispatchEvent(new Event('pointerup'));
      if (Math.abs(Number(seek.value) - 6) > .1 || document.activeElement !== seek) throw Error('Seek did not resume with focus preserved');
    });
    const playerHandle = await page.locator('#preview-player').elementHandle();
    await page.locator('#profile-toggle').click();
    await page.locator('#nav-settings').click();
    await page.locator('#autoplay').check();
    await page.waitForFunction(() => queue.length > 0);
    await page.locator('#show-queue').focus(); await page.keyboard.press('Enter');
    assert(await page.locator('#queue-current .song-primary').count() === 1, 'Current song missing from queue');
    assert(await page.evaluate(()=>document.activeElement.id==='queue-h'), 'Queue entry focus lost');
    await page.locator('#queue li').first().getByText('Remove', { exact: true }).focus();
    await page.keyboard.press('Enter');
    assert(await page.evaluate(() => document.activeElement.tagName !== 'BODY'), 'queue removal lost focus');
    await page.locator('#profile-toggle').click();
    await page.locator('#nav-settings').click();
    await page.evaluate(() => {
      const savedTrack=currentTrack, savedQueue=queue, savedManual=new Set(manualQueue);
      const seed={title:'Alone',channel:'Maduk',url:'seed'};
      const duplicate={title:'Maduk - Alone (Lyrics)',channel:'Uploader',url:'duplicate'};
      const different={title:'Not Alone',channel:'Maduk',url:'different'};
      try {
        currentTrack=seed; queue=[]; manualQueue.clear();
        const eligible=eligibleAutoplay([seed,duplicate,different]);
        if(eligible.length!==1 || eligible[0]!==different) throw Error('Autoplay retained duplicate recording');
        listeningHistory.record(different,'played');
        if(eligibleAutoplay([different]).length) throw Error('Autoplay repeated recent listen');
        queue=[{...seed,playlistEntry:'p:1'},{...seed,playlistEntry:'p:2'}];pruneQueue();
        if(queue.length!==2) throw Error('Explicit playlist repetitions lost');
        queue=[duplicate,different];manualQueue.add(sourceKey(duplicate));pruneQueue();
        if(queue.length!==1 || queue[0]!==duplicate) throw Error('Manual queue priority lost');
      } finally {currentTrack=savedTrack;queue=savedQueue;manualQueue.clear();savedManual.forEach(k=>manualQueue.add(k));}
    });
    await page.locator('#clear-history').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,name+'-listening-history.png')});
    await page.locator('#clear-history').focus(); await page.keyboard.press('Enter');
    assert(await page.evaluate(()=>listeningHistory.entries().length===0 && document.activeElement.id==='clear-history'),'Clear history failed or lost focus');
    await page.locator('#autoplay').focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert(await page.evaluate(() => document.activeElement.id === 'autoplay'));
    await page.locator('#nav-search').click();
    failSearch = true;
    await page.locator('#q').fill('Failed search');
    await page.locator('#q').press('Enter');
    await page.waitForFunction(() => document.querySelector('#search-status').textContent.includes('Search failed'));
    assert(await page.evaluate(() => document.activeElement.id === 'q'));
    assert(await playerHandle.evaluate((node) => node === document.getElementById('preview-player')), 'player replaced');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert(!overflow, 'horizontal overflow');
    assert.equal(await page.locator('#search-form input[type=search]').count(),1,'One global search field');
    const shell=await page.evaluate(()=>{
      const box=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}};
      return {header:box('.app-header'),content:box('#content'),player:box('.player-bar'),nav:box('.sidebar'),rail:box('.workspace-rail'),height:innerHeight,width:innerWidth};
    });
    assert(shell.player.bottom<=shell.height+1,'Player extends below window');
    if(shell.width>1150){
      assert.equal(shell.nav.w,232,'Measured desktop sidebar width');
      assert(shell.content.x>=shell.nav.right+7,'Panel separation');
      assert(shell.content.bottom<=shell.player.y,'Player overlaps scrolling content');
      assert.equal(shell.rail.w,0,'Now-playing rail removed');
    }
    // Real HLS/MSE decoding in Chromium; WebKit on this Windows host lacks audio support.
    let audio = { capability: await page.evaluate(() => Boolean(window.AudioContext)) };
    if (engine === chromium) {
      await page.evaluate(() => { if (decks[deckIndex].paused) document.getElementById('play').click(); });
      await page.waitForFunction(() => decks[deckIndex].currentTime > .3, { timeout: 15000 });
      audio = await page.evaluate(async () => {
        const analyzer = audioContext.createAnalyser(); gains[deckIndex].connect(analyzer);
        await new Promise((r) => setTimeout(r, 250));
        const data = new Float32Array(analyzer.fftSize); analyzer.getFloatTimeDomainData(data);
        gains[deckIndex].disconnect(analyzer);
        return { time: decks[deckIndex].currentTime, rms: Math.sqrt(data.reduce((n, x) => n + x * x, 0) / data.length), hls: Boolean(decks[deckIndex].hls), pitch: decks[deckIndex].preservesPitch };
      });
      assert(audio.rms > .001, 'HLS has no decoded signal at the mixing output');
      await page.locator('#play').click();
      await page.waitForFunction(() => decks[deckIndex].paused, null, {timeout:1500});
      await page.locator('#play').click();
      await page.locator('#volume').evaluate((node) => { node.value = .6; node.dispatchEvent(new Event('input')); });
      assert(await page.evaluate(() => Math.abs(outputGain.gain.value - .6) < .001
        && decks.every((deck, i) => deck.volume === (nodes[i] ? 1 : .6))));
      await page.locator('#volume').evaluate((node) => { node.value = 1; node.dispatchEvent(new Event('input')); });
      await page.locator('#seek').evaluate((node) => { node.value = 10; node.dispatchEvent(new Event('input')); });
      assert(await page.evaluate(() => decks[deckIndex].currentTime >= 9.9), 'Seek control must move the active deck');

    }
    failSearch = false;
    await page.locator('#q').fill('Synthetic');
    await page.locator('#q').press('Enter');
    await page.waitForSelector('#results button');
    await page.mouse.move(0,0);await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, name + '-search.png'), fullPage: false });
    await page.evaluate(() => { history.push({id:'00000000002',url:'https://www.youtube.com/watch?v=00000000002',title:'Synthetic recording 2',channel:'Related artist',duration:40,saved:true}); });
    await page.locator('#show-queue').click();
    await page.locator('#queue-history summary').click();
    await page.locator('#queue-history-list .song-primary').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(()=>currentTrack?.id==='00000000002');
    assert.equal(await page.locator('#queue-current .song-primary').getAttribute('data-source'),'00000000002');
    assert(await page.evaluate(()=>document.activeElement.tagName!=='BODY'),'History replay lost focus');
    await page.screenshot({path:path.join(out,name+'-queue-timeline.png')});

    await page.locator('#nav-library').click();
    await page.mouse.move(0,0);await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(out, name + '.png'), fullPage: false });
    for (const view of ['search', 'settings']) {
      if (view === 'settings') await page.locator('#profile-toggle').click();
      await page.locator('#nav-' + view).click();
      await page.mouse.move(0,0);await page.waitForTimeout(200);
      assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), view + ' horizontal overflow');
      await page.screenshot({ path: path.join(out, name + '-' + view + '.png'), fullPage: false });
    }
    // Reflow and keyboard access at the narrowest supported layout, including the bottom of Settings.
    await page.setViewportSize({width:320,height:640});
    await page.locator('#settings-player').focus();
    assert(await page.evaluate(()=>document.activeElement.id==='settings-player'));
    await page.waitForFunction(() => {
      const focusBox = document.querySelector('#settings-player').getBoundingClientRect();
      const barBox = document.querySelector('.player-bar').getBoundingClientRect();
      return focusBox.y >= 64 && focusBox.bottom <= barBox.y + 1;
    }, { timeout: 3000 });
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),'320px reflow overflow');
    await page.screenshot({path:path.join(out,name+'-narrow-settings.png')});
    await page.goto('https://music.test/login');
    await page.locator('#username').focus();
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => document.activeElement.id === 'password'));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Space');
    assert(await page.locator('input[name=remember]').isChecked());
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), 'login horizontal overflow');
    await page.screenshot({ path: path.join(out, name + '-login.png'), fullPage: false });
    assert.deepEqual(errors, []);
    return { name, overflow, errors, audio, requests: requests.length, keyboard: 'Profile menu Escape/Tab/Shift+Tab/Enter/Space, queue removal and search failure focus passed' };
  } finally { await browser.close(); }
}
(async () => {
  const results = [];
  for (const [name, engine, options] of [
    ['windows-chromium', chromium, { viewport: { width: 1280, height: 900 } }],
    ['mac-webkit-emulated', webkit, { viewport: { width: 1280, height: 900 } }],
    ['android-chromium-emulated', chromium, { ...devices['Pixel 7'] }],
    ['iphone-webkit-emulated', webkit, { ...devices['iPhone 13'] }],
  ]) {
    try { results.push(await check(name, engine, options)); }
    catch (e) { results.push({ name, failure: e.stack }); }
  }
  fs.writeFileSync(path.join(out, 'browser-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => r.failure)) process.exitCode = 1;
})();
