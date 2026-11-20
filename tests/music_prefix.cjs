// Real browser/decks and synthetic HLS; controlled API states, no injected transition plan.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, '.local/music-browser');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE ||
  require.resolve('playwright', {paths:[root,path.resolve(root,'../agent-dock')]}));
const tracks = Array.from({length: 5}, (_, i) => ({id: String(i+1).padStart(11,'0'), url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'0')}`, title:`Track ${i+1}`, channel:'Test artist', saved:true, duration:40}));
const jobs = new Map(), requests = [], errors = [];
const assetReads = new Map();
let releaseTransfer;
const heldTransfer = new Promise(resolve => { releaseTransfer = resolve; });
function job(t, priority=0) {
  if (!jobs.has(t.id)) jobs.set(t.id,{id:'job-'+t.id,source_id:t.id,priority,state:'running',preview_state:'ready',message:'Preparing',media_url:`/api/jobs/job-${t.id}/media/index.m3u8`});
  const j=jobs.get(t.id); j.priority=priority;
  return j;
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(() => {
    const connection = new EventTarget();
    Object.assign(connection, {type:"wifi", saveData:true});
    Object.defineProperty(navigator, "connection", {value:connection});
    localStorage.setItem("music:queue-mode", "order");
    localStorage.setItem("music:autoplay", "true");
    localStorage.setItem("music:fade", "0");
    window.cancelledAudio = [];
    const request = window.fetch;
    window.fetch = (url, options) => {
      if (options?.headers?.["X-FamilyHub-Activity"] === "background" && String(url).includes("/media/"))
        options.signal.addEventListener("abort", () => cancelledAudio.push(new URL(url).pathname), {once:true});
      return request(url, options);
    };
  });
  await page.route('https://music.test/**',async route=>{
   const request=route.request(), p=new URL(request.url()).pathname;
   const mime={'.js':'text/javascript','.css':'text/css','.m3u8':'application/vnd.apple.mpegurl','.mp4':'video/mp4','.m4s':'video/mp4'};
   if(p==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(fixture,'index.html'))});
   if(p.startsWith('/static/'))return route.fulfill({contentType:mime[path.extname(p)],body:fs.readFileSync(path.join(root,'music_web',p))});
   if(p.includes('/media/')) {
    assetReads.set(p,(assetReads.get(p)||0)+1);
    if (p.includes(tracks[2].id) && p.endsWith('seg00000.m4s')) {
      await heldTransfer;
      return route.fulfill({contentType:mime[path.extname(p)], path:path.join(fixture,'hls',path.basename(p))}).catch(() => {});
    }
    return route.fulfill({contentType:mime[path.extname(p)],path:path.join(fixture,'hls',path.basename(p))});
   }
   const data=request.method()==='POST'?request.postDataJSON():null;
   if(p==='/api/jobs'&&data)await new Promise(r=>setTimeout(r,2000));
   requests.push({p,data});
   let body={};
   if(p==='/api/library'||p==='/api/search')body={results:tracks};
   else if(p==='/api/jobs'&&data)body={job:job(tracks.find(t=>t.url===data.url))};
   else if(p==='/api/jobs')body={jobs:[...jobs.values()]};
   else if(p==='/api/queue')body={jobs:data.tracks.map((t,i)=>job(t,i+1))};
   else if(p==='/api/transition')body={plan:{out:40-data.fade,in:0,rate:1,fade:data.fade,mode:'Crossfade'}};
   else body={job:[...jobs.values()].find(j=>p.endsWith(j.id))};
   await route.fulfill({json:body});
  });
  await page.goto('https://music.test/');
  await page.locator('#library-list button').first().click();
  await page.waitForFunction(()=>decks[deckIndex].currentTime>.15&&!decks[deckIndex].paused);
  assert(!requests.some(r=>r.p==='/api/queue'&&r.data.tracks.length),'Data Saver requested speculative audio');
  await page.evaluate(() => {
    Object.assign(navigator.connection, {type:"cellular", saveData:false});
    navigator.connection.dispatchEvent(new Event("change"));
  });
  await page.waitForTimeout(150);
  assert(!requests.some(r=>r.p==='/api/queue'&&r.data.tracks.length),'Cellular requested speculative audio');
  await page.evaluate(() => {
    navigator.connection.type="wifi";
    navigator.connection.dispatchEvent(new Event("change"));
  });
  const base='/api/jobs/job-'+tracks[1].id+'/media/';
  await page.waitForFunction(()=>prepared.size===1);
  const until=Date.now()+10000;
  while(!assetReads.has(base+'seg00002.m4s') && Date.now()<until)await page.waitForTimeout(50);
  assert(assetReads.has(base+'seg00002.m4s'),'Opening audio must reach browser before selection');
  assert(!assetReads.has(base+'seg00003.m4s'),'Background preview fetched beyond the short prefix');
  assert(!assetReads.has('/api/jobs/job-'+tracks[2].id+'/media/index.m3u8'),'Prefetch reached beyond the next recording');
  const started=Date.now();
  await page.locator('#next').click();
  await page.waitForFunction(id=>currentTrack.id===id&&decks[deckIndex].currentTime>.15&&!decks[deckIndex].paused, tracks[1].id);
  const startup=Date.now()-started;
  assert(startup<1500,'Prepared opening waited for the delayed promotion API');
  assert.equal(assetReads.get(base+'init.mp4'),1,'Cached initialization was downloaded again');
  assert.equal(assetReads.get(base+'seg00000.m4s'),1,'Cached opening segment was downloaded again');
  const obsolete = '/api/jobs/job-'+tracks[2].id+'/media/seg00000.m4s';
  const deadline = Date.now()+10000;
  while(!assetReads.has(obsolete) && Date.now()<deadline)await page.waitForTimeout(50);
  assert(assetReads.has(obsolete),'Next opening did not start');
  await page.evaluate(() => {
    navigator.connection.saveData = true;
    navigator.connection.dispatchEvent(new Event("change"));
  });
  await page.waitForFunction(url=>cancelledAudio.includes(url),obsolete);
  releaseTransfer();
  await page.waitForFunction(()=>decks[deckIndex].currentTime>7);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({prefixBeforeClick:true,prefixOnly:true,cachedOpeningReused:true,promotionDelayMs:2000,advancingPositionMs:startup,
    obsoleteTransferCancelled:true,continuedPlayback:true}));
 }finally{releaseTransfer();await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
