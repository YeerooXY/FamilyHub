// Real styles and focus helpers with fixture markup; this does not exercise native audio or Razor.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths:[root,path.resolve(root,'../agent-dock')]}));
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const css = ['music_web/static/shell.css','clients/FamilyHub.App/wwwroot/app-native.css','clients/FamilyHub.App/wwwroot/player-native.css','clients/FamilyHub.App/wwwroot/paddock-theme.css','clients/FamilyHub.App/wwwroot/home-mobile.css','clients/FamilyHub.App/wwwroot/server-stats.css','clients/FamilyHub.App/wwwroot/create-playlist.css','clients/FamilyHub.App/wwwroot/popup-native.css'].map(read).join('\n');
const icon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M4 12h16M12 4v16"/></svg>';
const cover = (n, missing = false, kind = '') => {
 const hue = (n * 73 + 186) % 360;
 const art = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240"><rect width="240" height="240" fill="hsl(${hue} 36% 31%)"/><circle cx="118" cy="118" r="80" fill="hsl(${hue} 53% 55%)"/><path d="M0 160Q100 100 240 180V240H0Z" fill="#171b2d" opacity=".65"/></svg>`;
 return `<span class="cover ${kind}" aria-hidden="true">${missing ? `<span class="discovery-cover-empty">${icon}</span>` : `<img src="data:image/svg+xml,${encodeURIComponent(art)}" alt="">`}</span>`;
};
const shelf = (id, title, cards) => `<section class="home-section${id === 'discovery-shelf' ? '' : ' home-collection'}"><div class="home-section-heading"><h2>${title}</h2></div>
<div class="shelf-frame"><div class="home-shelf" id="${id}">${cards}</div>
<button class="shelf-arrow is-back is-end" data-shelf="${id}" data-dir="-1" aria-label="Scroll ${title} back">${icon}</button>
<button class="shelf-arrow is-forward is-end" data-shelf="${id}" data-dir="1" aria-label="Scroll ${title} forward">${icon}</button></div></section>`;
const names = ['North Atlas', 'June Echo', 'Glass Harbor', 'Silver Current'];
const titles = ['First Light', 'City Lights', 'Afterglow', 'Northbound'];
const mixes = ['Late Night Mix', 'Quiet Mornings', 'Weekend Drive', 'After Hours', 'On the Road', 'House Mix', 'November Picks', 'First Listen'];
const albums = ['Evening Signals', 'Night Windows', 'Long Way Home', 'Early Hours', 'All Along the Water', 'Motion Study', 'Winter Sessions', 'Return to the Coast'];
const releases = ['Quiet Harbour', 'The Skyline at Dawn', 'Turning Point', 'Paper Planes', 'Signals', 'Landmarks', 'Late Return', 'Sundown'];
const shortcut = (title, i, radio = false) => `<button class="home-shortcut" ${radio ? `id="home-radio-${i}" aria-label="Start ${title} Radio"` : `aria-label="Play ${title}"`}>${cover(i)}<span>${radio ? '<span aria-hidden="true">📻</span> ' : ''}${title}</span></button>`;
const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body data-view="home"><div id="app" style="display:contents">
<header class="app-header"><form id="search-form"><input type="search" id="q" aria-label="Search songs" placeholder="Search songs or artists"></form></header>
<aside class="sidebar"><button class="nav-button">Home</button></aside>
<div class="workspace"><main id="content" tabindex="-1">
<div class="home-view">
${shelf('discovery-shelf', 'New from artists you play', releases.map((title,i) => `<div class="home-card-holder discovery-card"><div class="home-card"><div class="discovery-art">${cover(i+11,i===1,'discovery-cover')}<button class="discovery-play" aria-label="Play ${title}">${icon}</button><button class="discovery-dismiss" aria-label="Dismiss ${title}">${icon}</button></div><strong>${title}</strong><span>${names[i%4]}</span></div></div>`).join(''))}
<section class="home-section"><h2>Radio</h2><div class="home-shortcuts">${titles.map((title,i)=>shortcut(title,i,true)).join('')}</div></section>
<section class="home-section"><h2 class="sr">Recently played</h2><div class="home-shortcuts">${titles.map((title,i)=>shortcut(title,i)).join('')}</div></section>
${shelf('home-playlists-shelf', 'Your playlists', mixes.map((title,i) => `<button class="home-card">${cover(i+20)}<strong>${title}</strong><span>4 songs</span></button>`).join(''))}
${shelf('home-albums-shelf', 'Albums for you', albums.map((title,i) => `<div class="home-card-holder"><button ${i===0 ? 'id="album-open"' : ''} class="home-card" aria-label="Open ${title} by ${names[i%4]}">${cover(i)}<strong>${title}</strong><span>${names[i%4]}</span></button><button ${i===0 ? 'id="album-save"' : ''} class="home-card-save" aria-label="Save ${title} as a playlist">${icon}</button></div>`).join(''))}
</div>
<div class="playlist-grid"><button id="create-playlist" class="playlist-card glass-panel"><span class="cover generated-cover create-cover">${icon}</span><strong>Create playlist</strong></button></div>
</main></div><footer class="player-bar"><div id="player-options" class="player-tools is-open"><div class="dialog-heading"><h2>Player options</h2><button class="quiet player-tools-close" aria-label="Close player options">${icon}</button></div>
<button id="sheet-lyrics" class="quiet" aria-label="Lyrics">${icon}</button>
<button id="sheet-add-playlist" class="quiet sheet-only" aria-label="Add to playlist">${icon}</button><button id="sheet-queue" class="quiet sheet-only" aria-label="Go to queue">${icon}</button>
<button id="listen-together" class="quiet listen-together-button" aria-label="Listen Together">${icon}</button><button id="connect-device" class="quiet" aria-label="Connect to a device">${icon}</button>
<button id="trim-test" class="quiet trim-request" aria-label="Needs trimming">${icon}</button><button id="recommend-similar" class="quiet discover-button" aria-label="Play similar songs next">${icon}</button></div></footer></div></body>`;

(async()=>{
 for(const [name,engine,profile] of [
  ['windows-1280',chromium,{viewport:{width:1280,height:900}}],
  ['windows-2000',chromium,{viewport:{width:2000,height:1060}}],
  ['narrow-windows-chromium',chromium,{viewport:{width:800,height:900}}],
  ['mac-webkit-emulated',webkit,{viewport:{width:1440,height:900}}],
  ['android-chromium-emulated',chromium,devices['Pixel 7']],
  ['iphone-webkit-emulated',webkit,devices['iPhone 13']]
 ]){
  const browser = await engine.launch({headless:true});
  try {
   const page = await browser.newPage(profile);
   await page.route('https://home.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
   await page.goto('https://home.test/');
   await page.addScriptTag({content:read('clients/FamilyHub.App/wwwroot/app.js')});
   if (profile.isMobile) await page.locator('#player-options').evaluate(node => node.classList.add('popup-panel','popup-menu'));
   await page.evaluate(() => {
    document.querySelectorAll('.home-shelf').forEach(shelf => familyhub.watchShelf(shelf.id));
    document.querySelectorAll('.shelf-arrow').forEach(button => {
     button.onclick = () => familyhub.scrollShelf(button.dataset.shelf, Number(button.dataset.dir));
    });
   });
   const layout = await page.evaluate(() => {
    const width = selector => document.querySelector(selector).getBoundingClientRect().width;
    const shortcutStyle = node => {
     const css = getComputedStyle(node);
     return [node.offsetWidth, node.offsetHeight, css.backgroundColor, css.borderRadius, css.fontSize];
    };
    const radio = shortcutStyle(document.querySelector('#home-radio-0'));
    const recent = shortcutStyle(document.querySelector('[aria-label="Play First Light"]'));
    return {tile:width('#album-open'), playlist:width('#home-playlists-shelf .home-card'), release:width('#discovery-shelf .home-card'), radio, recent};
   });
   assert.deepEqual(layout.radio, layout.recent, name + ': radio and recent cards differ');
   assert.equal(layout.tile, layout.playlist);
   if (name === 'windows-1280') assert.equal(layout.tile,224);
   if (name === 'windows-2000') assert.equal(layout.tile,248);
   if (profile.isMobile) assert.equal(layout.tile,148);
   assert.equal(layout.release, profile.isMobile ? 148 : 180);
   assert(layout.tile <= 248);
   if (!profile.hasTouch) {
    await page.locator('#home-playlists-shelf').hover();
    const next = page.locator('[data-shelf="home-playlists-shelf"][data-dir="1"]');
    await page.waitForFunction(button => getComputedStyle(button).opacity === '1', await next.elementHandle());
    const arrow = await next.boundingBox(), art = await page.locator('#home-playlists-shelf .cover').first().boundingBox();
    assert(Math.abs(arrow.y + arrow.height / 2 - art.y - art.height / 2) < 1);
    await next.click();
    await page.waitForFunction(() => document.getElementById('home-playlists-shelf').scrollLeft > 0);
    await page.locator('#home-playlists-shelf').evaluate(shelf => shelf.scrollLeft = 0);
   } else {
    assert.equal(await page.locator('.shelf-arrow:visible').count(), 0);
   }
   if(profile.isMobile) {
    assert.equal(await page.locator('#album-save').evaluate(node=>getComputedStyle(node).opacity),'1',name+': touch save button hidden before interaction');
   }
   if(!profile.isMobile) {
    assert.equal(await page.locator('.player-tools-close').isVisible(),false,name+': mobile close button shown on desktop');
    assert.equal(await page.locator('#sheet-add-playlist').isVisible(),false,name+': mobile playlist action shown on desktop');
    assert.equal(await page.locator('#sheet-queue').isVisible(),false,name+': mobile queue action shown on desktop');
   }
   const tools = await page.locator('.player-tools>button:not(.player-tools-close):visible').evaluateAll(nodes=>nodes.map(node=>{
    const box=node.getBoundingClientRect(); return {id:node.id||node.className,width:box.width,height:box.height};
   }));
   assert(tools.every(box=>Math.abs(box.width-tools[0].width)<.5 && Math.abs(box.height-tools[0].height)<.5 && box.width>=43.5 && box.height>=43.5),name+': unequal tool targets '+JSON.stringify(tools));
   // Hover and press only exist with a mouse; touch profiles show the tools as a sheet list.
   if (!profile.hasTouch) {
    await page.locator('#recommend-similar').hover({force:true});
    assert.equal(await page.locator('#recommend-similar').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
    assert.equal(await page.locator('#recommend-similar').evaluate(node=>getComputedStyle(node).boxShadow),'none');
    await page.mouse.down();
    const pressed = await page.locator('#recommend-similar').evaluate(node=>getComputedStyle(node).transform);
    const scale = pressed === 'none' ? 1 : Number(pressed.slice(7).split(',')[0]); assert(scale >= .98, name+': pressed tool moves '+pressed);
    await page.mouse.up();
   }
   await page.locator('#trim-test').evaluate(node=>node.focus({focusVisible:true}));
   assert.equal(await page.locator('#trim-test').evaluate(node=>getComputedStyle(node).outlineStyle),'solid');
   await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'recommend-similar');
   await page.keyboard.press('Shift+Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'trim-test');
   await page.evaluate(()=>{
    familyhub.focusIfWithin('.player-tools .trim-request','recommend-similar');
    document.getElementById('trim-test').remove();
   });
   assert.equal(await page.evaluate(()=>document.activeElement.id),'recommend-similar',name+': removing trimming action lost focus');
   if(profile.isMobile) {
    await page.locator('#sheet-lyrics').focus();
    await page.evaluate(()=>{
     familyhub.focusIfWithin('#sheet-lyrics','listen-together');
     document.getElementById('sheet-lyrics').remove();
    });
    assert.equal(await page.evaluate(()=>document.activeElement.id),'listen-together',name+': removing lyrics action lost focus');
    await page.locator('#sheet-queue').focus();
    await page.evaluate(()=>{
     familyhub.focusIfWithin('#sheet-add-playlist,#sheet-queue,#sheet-lyrics','listen-together');
     document.getElementById('sheet-add-playlist').remove();
     document.getElementById('sheet-queue').remove();
    });
    assert.equal(await page.evaluate(()=>document.activeElement.id),'listen-together',name+': removing song actions lost focus');
   }
   // Hide the fixture sheet so the Home controls can be checked at phone sizes.
   await page.evaluate(()=>document.querySelector('.player-tools').classList.remove('is-open'));
   await page.locator('#album-save').focus();
   await page.waitForFunction(()=>getComputedStyle(document.getElementById('album-save')).opacity==='1');
   const hit = await page.locator('#album-save').boundingBox();
   assert(hit.width>=44 && hit.height>=44);
   await page.locator('#album-save').evaluate(node=>{node.onclick=()=>{node.classList.add('is-saved');node.setAttribute('aria-disabled','true');};});
   for(const key of ['Enter','Space']) {
    await page.keyboard.press(key);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'album-save');
   }
   await page.locator('#album-open').focus();await page.keyboard.press('Tab');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'album-save');
   await page.locator('#home-radio-1').focus();
   await page.evaluate(()=>{document.getElementById('home-radio-1').remove();familyhub.restoreFocus('home-radio-1','home-radio-0');});
   assert.equal(await page.evaluate(()=>document.activeElement.id),'home-radio-0');
   const before = await page.locator('.create-cover').evaluate(node=>node.getAnimations()[0]?.currentTime);
   await page.waitForTimeout(200);
   const after = await page.locator('.create-cover').evaluate(node=>node.getAnimations()[0]?.currentTime);
   assert(after>before,name+': gradient is not animating');
   await page.locator('#create-playlist').focus();
   assert.equal(await page.locator('.create-cover').evaluate(node=>getComputedStyle(node).animationDuration),'3s');
   assert(Number(await page.locator('#create-playlist>strong').evaluate(node=>getComputedStyle(node).fontWeight))>=800);
   await page.emulateMedia({reducedMotion:'reduce'});
   assert.equal(await page.locator('.create-cover').evaluate(node=>node.getAnimations().length),0);
   assert.equal(await page.locator('#album-save').evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   if(profile.isMobile) {
    await page.locator('#album-save').evaluate(node=>node.classList.remove('is-saved'));
    await page.locator('#home-radio-0').focus();
    {const info=await page.locator('#album-save').evaluate(node=>({o:getComputedStyle(node).opacity,t:getComputedStyle(node).transitionDuration,hover:matchMedia('(hover:none)').matches,coarse:matchMedia('(pointer:coarse)').matches,cls:node.className})); assert.notEqual(info.o,'0',name+': touch save button hidden '+JSON.stringify(info));}
   }
  } finally { await browser.close(); }
 }
 console.log('PASS: Home shelf sizing, caps, arrow alignment, radio styling, focus and motion across six browser profiles');
})().catch(error=>{console.error(error);process.exitCode=1;});
