const {chromium,webkit}=require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');
const track=(id,title,channel,genre,saved=false)=>({id,url:'https://www.youtube.com/watch?v='+id,title,channel,genre,duration:180,saved});
const seed=track('00000000001','Numb','Linkin Park','Rock',true);
const faint=track('00000000002','Faint','Linkin Park','Rock');
const rock=track('00000000003','Bring Me To Life','Evanescence','Rock',true);
const pop=track('00000000004','Barbie Girl','Aqua','Pop',true);
(async()=>{
 for(const [name,engine,viewport] of [['desktop',chromium,{width:1360,height:880}],['iphone',webkit,{width:390,height:844}]]) {
 const browser=await engine.launch();
 try {
  const page=await browser.newPage({viewport});const errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));let fail=false;
  await page.route('https://music.test/**',async route=>{
   const req=route.request(),p=new URL(req.url()).pathname;
   if(p==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'.local/music-browser/index.html'))});
   if(p.startsWith('/static/'))return route.fulfill({contentType:p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.png')?'image/png':'image/svg+xml',body:fs.readFileSync(path.join(root,'music_web',p))});
   if(p.startsWith('/api/artwork/'))return route.fulfill({status:404});
   const data=req.method()==='POST'?req.postDataJSON():null;requests.push({p,data});
   if(p==='/api/recommendations') {
    await new Promise(r=>setTimeout(r,100));
    if(fail)return route.fulfill({status:502,json:{error:'Discovery unavailable.'}});
    return route.fulfill({json:{results:[faint,pop],seed_genre:'Rock'}});
   }
   return route.fulfill({json:p==='/api/library'?{results:[seed,rock,pop]}:p==='/api/playlists'?{playlists:[]}:{jobs:[]}});
  });
  await page.goto('https://music.test/');await page.waitForFunction(()=>pool.length===3);
  await page.evaluate(seed=>{currentTrack=seed;similarSeed={...seed};renderQueue();},seed);
  const button=page.locator('#recommend-similar');await button.focus();
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'shuffle-toggle');
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'recommend-similar');
  await page.waitForFunction(()=>document.querySelector('#similar-panel').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('#similar-results li').count(),2);
  assert(!(await page.locator('#similar-results').innerText()).includes('Barbie Girl'));
  assert((await page.locator('#similar-results').innerText()).includes('Faint'));
  await page.screenshot({path:path.join(root,'.local/music-browser/similar-success-'+name+'.png')});
  assert(!requests.some(r=>r.p==='/api/jobs'&&r.data),'Opening recommendations must not download');
  assert(!requests.some(r=>r.p==='/api/queue'&&r.data?.tracks.length),'Opening recommendations must not enqueue');
  await page.locator('#similar-results .queue-add').first().click();
  await page.waitForFunction(()=>queue.length===1);
  assert(requests.some(r=>r.p==='/api/queue'&&r.data?.tracks.some(t=>t.requested)));
  const anchor=await page.evaluate(()=>similarSeed);
  await page.evaluate(async({rock,pop})=>{
   queue=[];manualQueue.clear();pool=[rock,pop];visibleResults=[pop];
   currentTrack=rock;$('autoplay').checked=true;$('allow-new').checked=false;$('queue-mode').value='mix';
   await fillQueue();
  },{rock,pop});
  assert.deepEqual(await page.evaluate(()=>similarSeed),anchor,'Advancing must preserve seed');
  assert(!(await page.evaluate(()=>queue.map(t=>t.title))).includes('Barbie Girl'));
  fail=true;await button.focus();await page.keyboard.press('Space');
  await page.waitForFunction(()=>document.querySelector('#similar-status').textContent==='Discovery unavailable.');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'recommend-similar');
  assert.equal(await page.locator('#similar-results li').count(),0);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');
  await page.screenshot({path:path.join(root,'.local/music-browser/similar-'+name+'.png')});
  assert.deepEqual(errors,[]);console.log(name+': suggestions, unsaved songs, no pop drift, explicit queueing, errors and keyboard focus passed');
 } finally {await browser.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
