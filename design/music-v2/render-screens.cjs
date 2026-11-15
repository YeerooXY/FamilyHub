const {chromium,webkit,devices}=require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const path=require('path'),fs=require('fs'),assert=require('assert');
const root=__dirname,base='file:///'+path.join(root,'screens.html').replace(/\\/g,'/');
const instances=[];
(async()=>{
 const browser=await chromium.launch({headless:true});
 instances.push(browser);
 const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:1});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const [file,params,size] of [
 ['01-player-desktop.png','view=player',{width:1440,height:1000}],
 ['02-library-desktop.png','view=library',{width:1440,height:1000}],
 ['03-search-desktop.png','view=search',{width:1440,height:1000}],
 ['04-player-mobile.png','view=player',{width:390,height:844}],
 ['05-library-mobile.png','view=library',{width:390,height:844}],
 ['06-search-mobile.png','view=search',{width:390,height:844}],
 ['07-crossfading.png','view=player&state=mixing',{width:1440,height:1000}],
 ['08-preparing-next.png','view=player&state=preparing',{width:1440,height:1000}],
 ['09-autoplay-off.png','view=player&state=off',{width:1440,height:1000}],
 ['15-settings-desktop.png','view=settings',{width:1440,height:1080}],
 ['16-settings-mobile.png','view=settings',{width:390,height:844}],
 ['12-next-track-error.png','view=player&state=error',{width:1440,height:1000}]
 ,['13-unmatched-artwork-genre.png','view=player&track=fight-back',{width:1440,height:1000}]
 ,['14-player-compact-phone.png','view=player',{width:390,height:664}]
 ]){
  await page.setViewportSize(size);await page.goto(base+'?'+params);await page.locator('.cover').first().waitFor();await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
  assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),file+' overflow');
  await page.waitForTimeout(250);await page.screenshot({path:path.join(root,file),fullPage:false});
 }
 assert.deepEqual(errors,[]);await browser.close();
 const checks=[];
 for(const [name,engine,opts] of [
 ['windows-chromium',chromium,{viewport:{width:1440,height:1000}}],
 ['mac-webkit-emulated',webkit,{viewport:{width:1440,height:1000}}],
 ['android-chromium-emulated',chromium,{...devices['Pixel 7']}],
 ['iphone-webkit-emulated',webkit,{...devices['iPhone 13']}]
 ]){
  const b=await engine.launch({headless:true});const context=await b.newContext(opts);const p=await context.newPage();
  instances.push(b);
  const issues=[];p.on('pageerror',e=>issues.push(e.message));
  for(const view of ['player','library','search','settings']){
   await p.goto(base+'?view='+view);await p.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
   assert(!await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),name+' '+view+' overflow');
   await p.waitForTimeout(250);await p.screenshot({path:path.join(root,'verification',name+'-'+view+'.png'),fullPage:true});
  }
  await p.goto(base+'?view=library');
  await p.getByRole('button',{name:'Pop',exact:true}).focus();await p.keyboard.press('Space');
  assert(await p.evaluate(()=>document.activeElement.dataset.filter==='Pop'),'Filter focus');
  await p.keyboard.press('Tab');await p.keyboard.press('Shift+Tab');
  assert(await p.evaluate(()=>document.activeElement.dataset.filter==='Pop'),'Tab cycle');
  await p.locator('.song-primary').first().focus();await p.keyboard.press('Enter');
  assert(await p.locator('.rail-current h3').innerText()==='Bad Romance','Row click plays the selected song');
  assert(await p.evaluate(()=>document.activeElement.dataset.action==='play'),'Play focus');
  await p.locator('[data-action="settings"]:visible').first().click();
  await p.locator('#autoplay').focus();await p.keyboard.press('Space');
  assert(!await p.locator('#autoplay').isChecked());
  assert(await p.evaluate(()=>document.activeElement.id==='autoplay'),'Autoplay focus');
  await p.keyboard.press('Space');
  assert(await p.locator('#autoplay').isChecked());
  await p.locator('#fade-enabled').focus();await p.keyboard.press('Space');
  assert(await p.locator('#fade-setting').isDisabled());
  assert(await p.evaluate(()=>document.activeElement.id==='fade-enabled'));
  await p.keyboard.press('Space');assert(await p.locator('#fade-setting').isEnabled());
  await p.locator('#fade-setting').evaluate(n=>{n.value='8';n.dispatchEvent(new Event('input'));});assert.equal(await p.locator('#fade-value').innerText(),'8 s');
  assert.deepEqual(issues,[]);
  await p.goto(base+'?view=library');
  await p.locator('[data-track="one-kiss"]').first().click();
  assert.equal(await p.locator('.genre-context').count(),0);
  await p.goto(base+'?view=library');
  await p.locator('[data-track="wake-me-up"]').first().click();
  assert(await p.getByText('No more House songs saved',{exact:true}).isVisible());
  if(opts.isMobile){
   await p.goto(base+'?view=player');
   const ready=await p.locator('.next-pane>.readiness').boundingBox();
   const nav=await p.locator('.mobile-nav').boundingBox();
   const mini=await p.locator('.mini-player').boundingBox();
   assert(ready.y+ready.height<mini.y,name+' next readiness must be visible above navigation '+JSON.stringify({ready,nav}));
   await p.goto(base+'?view=library');
   const skip=p.locator('.compact-actions [data-action="next"]');
   assert(await skip.isVisible(),'Compact bar needs Next');
   await skip.focus();await p.keyboard.press('Enter');
   assert.equal(await p.locator('.rail-current h3').innerText(),"Don't Start Now");
   assert(await p.evaluate(()=>document.activeElement.dataset.action==='play'),'Next retains logical focus');
  }
  await p.goto(base+'?view=player');
  const queued=await p.locator('.playlist-row').evaluateAll(rows=>rows.map(r=>r.dataset.track));
  assert(queued.length>=5&&queued.length<=10,'Up next should show 5–10 examples');
  assert.equal(new Set(queued).size,queued.length,'Queue rows must be unique');
  assert.equal(await p.locator('.playlist>h2').innerText(),'Up next');
  checks.push({profile:name,views:['player','library','search','settings'],imagesLoaded:true,settings:true,overflow:false,keyboard:true,oneClickSelection:true,autoplayFocus:true});
  await b.close();
 }
 fs.writeFileSync(path.join(root,'verification','checks.json'),JSON.stringify(checks,null,2));
 console.log(JSON.stringify(checks));
})().catch(async e=>{console.error(e);for(const b of instances)await b.close().catch(()=>{});process.exitCode=1;});
