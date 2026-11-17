// Real styles and focus helpers with fixture markup; this does not exercise native audio or Razor.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths:[root,path.resolve(root,'../agent-dock')]}));
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const css = ['music_web/static/shell.css','clients/FamilyHub.App/wwwroot/app-native.css','clients/FamilyHub.App/wwwroot/player-native.css','clients/FamilyHub.App/wwwroot/paddock-theme.css','clients/FamilyHub.App/wwwroot/home-mobile.css','clients/FamilyHub.App/wwwroot/server-stats.css','clients/FamilyHub.App/wwwroot/create-playlist.css'].map(read).join('\n');
const icon = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" d="M4 12h16M12 4v16"/></svg>';
const html = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><div id="app" style="display:contents">
<div class="workspace"><main id="content" tabindex="-1">
<section class="home-section"><h2>Radio</h2><div class="home-radio-row">
<button id="home-radio-0" class="home-radio home-radio-current"><span class="cover"></span><span><strong>Song Radio</strong><small>Artist</small></span>${icon}</button>
<button id="home-radio-1" class="home-radio"><span class="cover"></span><span><strong>Another Song Radio</strong><small>Artist</small></span>${icon}</button></div></section>
<div class="home-shelf"><div class="home-card-holder"><button id="album-play" class="home-card"><span class="cover"></span><strong>Album</strong></button>
<button id="album-save" class="home-card-save" aria-label="Save album as playlist">${icon}</button></div></div>
<div class="playlist-grid"><button id="create-playlist" class="playlist-card glass-panel"><span class="cover generated-cover create-cover">${icon}</span><strong>Create playlist</strong></button></div>
</main></div><footer class="player-bar"><div class="player-tools is-open"><button class="quiet player-tools-close" aria-label="Close player options">${icon}</button>
<button id="sheet-lyrics" class="quiet" aria-label="Lyrics">${icon}</button>
<button id="sheet-add-playlist" class="quiet sheet-only" aria-label="Add to playlist">${icon}</button><button id="sheet-queue" class="quiet sheet-only" aria-label="Go to queue">${icon}</button>
<button id="listen-together" class="quiet listen-together-button" aria-label="Listen Together">${icon}</button><button id="connect-device" class="quiet" aria-label="Connect to a device">${icon}</button>
<button id="trim-test" class="quiet trim-request" aria-label="Needs trimming">${icon}</button><button id="recommend-similar" class="quiet discover-button" aria-label="Play similar songs next">${icon}</button></div></footer></div></body>`;

(async()=>{
 for(const [name,engine,profile] of [
  ['windows-chromium',chromium,{viewport:{width:1440,height:900}}],
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
   await page.locator('#album-play').focus();await page.keyboard.press('Tab');
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
 console.log('PASS: Home fixture targets, focus, hover, save state and motion across five browser profiles');
})().catch(error=>{console.error(error);process.exitCode=1;});
