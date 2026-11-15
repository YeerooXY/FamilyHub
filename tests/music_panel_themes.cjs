const {chromium,webkit,devices} = require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.local/native-ui-review/panel-profiles');
fs.mkdirSync(out,{recursive:true});
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const css=['music_web/static/shell.css','clients/FamilyHub.App/wwwroot/app-native.css','clients/FamilyHub.App/wwwroot/player-native.css','packages/paddock-effects/effects.css'].map(read).join('\n');
(async()=>{
 const results=[];
 for(const [name,engine,profile] of [
  ['windows-chromium',chromium,{viewport:{width:1440,height:900}}],
  ['mac-webkit-emulated',webkit,{viewport:{width:1440,height:900}}],
  ['android-chromium-emulated',chromium,devices['Pixel 7']],
  ['iphone-webkit-emulated',webkit,devices['iPhone 13']]
 ]){
  const browser=await engine.launch({headless:true});
  try{
   const page=await browser.newPage(profile),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://panels.test/**',route=>route.fulfill({contentType:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header class="app-header"><button id="profile-toggle">Profile</button><select id="theme" aria-label="Theme"></select></header><aside class="sidebar"><nav><button id="library">Library</button></nav></aside><div class="workspace"><main id="content" tabindex="-1"><h1>Library</h1><button id="play-song">Play song</button><div style="height:1800px"></div><button id="last-song">Last song</button></main></div><footer class="player-bar">Player</footer></body>`}));
   await page.goto('https://panels.test/');
   await page.addScriptTag({content:read('packages/paddock-effects/effects.js')});
   await page.addScriptTag({content:read('clients/FamilyHub.App/wwwroot/app.js')});
   await page.evaluate(()=>{
    familyhub.loadAppearance('test');familyhub.observePanel();
    document.querySelector('#play-song').onclick=()=>window.playClicks=(window.playClicks||0)+1;
   });
   const themes=await page.evaluate(()=>PaddockEffects.themes);
   assert.equal(themes.length,11);
   for(const {id} of themes){
    await page.evaluate(id=>familyhub.saveAppearance('test',id,false,true),id);
    await page.waitForTimeout(65);
    const panels=await page.evaluate(()=>[...document.querySelectorAll('.workspace,.sidebar')].map(host=>{
     const canvas=host.querySelector(':scope > canvas'),ctx=canvas.getContext('2d');
     return {theme:host.dataset.frame,count:host.querySelectorAll(':scope > canvas').length,
      width:canvas.clientWidth,height:canvas.clientHeight,pointer:getComputedStyle(canvas).pointerEvents,
      background:getComputedStyle(host).backgroundImage,painted:ctx.getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4===3&&v>0)};
    }));
    for(const panel of panels){assert.equal(panel.theme,id);assert.equal(panel.count,1);assert(panel.width>0&&panel.height>0);assert.equal(panel.pointer,'none');assert(panel.painted);}
   }
   await page.evaluate(()=>familyhub.saveAppearance('test','classic',false,true));
   await page.locator('#play-song').click();assert.equal(await page.evaluate(()=>window.playClicks),1);
   for(const key of ['Tab','Shift+Tab','Enter','Space'])await page.keyboard.press(key);
   assert.equal(await page.evaluate(()=>document.activeElement.id),'play-song');
   await page.evaluate(()=>{for(let i=0;i<20;i++)familyhub.observePanel();});
   assert.equal(await page.locator('.workspace>canvas,.sidebar>canvas').count(),2);
   await page.locator('#content').evaluate(el=>el.scrollTop=300);
   assert(await page.locator('#content').evaluate(el=>el.scrollTop>0),JSON.stringify({name,geometry:await page.locator('#content').evaluate(el=>({height:el.clientHeight,scroll:el.scrollHeight,overflow:getComputedStyle(el).overflow,workspace:el.parentElement.getBoundingClientRect().toJSON()}))}));
   const geometry=await page.locator('.workspace>canvas').boundingBox();
   assert(geometry.y>=0&&geometry.y+geometry.height<=page.viewportSize().height+1);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.evaluate(()=>familyhub.saveAppearance('test','gamer',false,false));
   assert.equal(await page.locator('.workspace>canvas').evaluate(el=>getComputedStyle(el).visibility),'hidden');
   await page.emulateMedia({reducedMotion:'reduce'});
   await page.evaluate(()=>familyhub.saveAppearance('test','classic',false,true));
   const still=await page.locator('.workspace>canvas').evaluate(el=>el.toDataURL());
   await page.waitForTimeout(120);
   assert.equal(await page.locator('.workspace>canvas').evaluate(el=>el.toDataURL()),still);
   await page.locator('#content').evaluate(el=>el.scrollTop=0);
   await page.screenshot({path:path.join(out,name+'.png')});
   assert.deepEqual(errors,[]);results.push({profile:name,themes:11,pointerAndFocus:true,scroll:true,effectsOff:true,reducedMotion:true});
  }finally{await browser.close();}
 }
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({coverage:'Native panel structure in browser profiles; physical devices pending',results},null,2));
 console.log('PASS: native panel skies, 11 palettes, canvas reuse, clicks, focus, scroll, effects off and reduced motion in four profiles');
})().catch(e=>{console.error(e);process.exitCode=1});
