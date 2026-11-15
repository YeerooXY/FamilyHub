// Real browser/decks and synthetic HLS; controlled API states, no injected transition plan.
const {chromium} = require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, '.local/music-browser');
const tracks = Array.from({length: 5}, (_, i) => ({id: String(i+1).padStart(11,'0'), url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'0')}`, title:`Track ${i+1}`, channel:'Test artist', saved:true, duration:40}));
const jobs = new Map(), requests = [], errors = [];
const playlistReads = new Map(), assetReads = new Map();
let failId = null, transitionDelay = null;
function job(t, priority=0) {
  if (!jobs.has(t.id)) jobs.set(t.id,{id:'job-'+t.id,source_id:t.id,priority,state:'running',preview_state:'ready',message:'Preparing',media_url:`/api/jobs/job-${t.id}/media/index.m3u8`});
  const j=jobs.get(t.id); j.priority=priority;
  if(t.id===failId){j.state='error';delete j.media_url;}
  return j;
}
(async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://music.test/**',async route=>{
   const request=route.request(), p=new URL(request.url()).pathname;
   const mime={'.js':'text/javascript','.css':'text/css','.m3u8':'application/vnd.apple.mpegurl','.mp4':'video/mp4','.m4s':'video/mp4'};
   if(p==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(fixture,'index.html'))});
   if(p.startsWith('/static/'))return route.fulfill({contentType:mime[path.extname(p)],body:fs.readFileSync(path.join(root,'music_web',p))});
   if(p.includes('/media/')) {
    assetReads.set(p,(assetReads.get(p)||0)+1);
    let body=fs.readFileSync(path.join(fixture,'hls',path.basename(p)));
    if(p.endsWith('index.m3u8')) {
     const count=playlistReads.get(p)||0;playlistReads.set(p,count+1);
     if(count===0) body=Buffer.from(body.toString().match(/^[\s\S]*?seg00000\.m4s\r?\n/)[0]);
    }
    return route.fulfill({contentType:mime[path.extname(p)],body});
   }
   const data=request.method()==='POST'?request.postDataJSON():null;
   if(p==='/api/jobs'&&data)await new Promise(r=>setTimeout(r,2000));
   requests.push({p,data});
   let body={};
   if(p==='/api/library'||p==='/api/search')body={results:tracks};
   else if(p==='/api/jobs'&&data)body={job:job(tracks.find(t=>t.url===data.url))};
   else if(p==='/api/jobs')body={jobs:[...jobs.values()]};
   else if(p==='/api/queue')body={jobs:data.tracks.map((t,i)=>job(t,i+1))};
   else if(p==='/api/transition'){
    if(transitionDelay)await transitionDelay;
    body={plan:{out:40-data.fade,in:0,rate:1,fade:data.fade,mode:'Crossfade'}};
   }else body={job:[...jobs.values()].find(j=>p.endsWith(j.id))};
   await route.fulfill({json:body});
  });
  await page.goto('https://music.test/');
  const base='/api/jobs/job-'+tracks[2].id+'/media/';
  await page.waitForFunction(()=>prepared.size>=3);
  const until=Date.now()+10000;
  while(!assetReads.has(base+'seg00002.m4s') && Date.now()<until)await page.waitForTimeout(100);
  assert(assetReads.has(base+'seg00002.m4s'),'Opening audio must reach browser before selection');
  assert(!assetReads.has(base+'seg00006.m4s'),'Background preview fetched beyond the short prefix');
  const started=Date.now();
  await page.locator('#library-list button').nth(2).click();
  await page.waitForFunction(()=>decks[deckIndex].currentTime>.15&&!decks[deckIndex].paused);
  const startup=Date.now()-started;
  assert(startup<1500,'Prepared opening waited for the delayed promotion API');
  assert.equal(assetReads.get(base+'init.mp4'),1,'Cached initialization was downloaded again');
  assert.equal(assetReads.get(base+'seg00000.m4s'),1,'Cached opening segment was downloaded again');
  await page.waitForTimeout(2500);
  assert(await page.evaluate(()=>decks[deckIndex].currentTime>2),'Playback did not continue beyond its opening');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({prefixBeforeClick:true,prefixOnly:true,cachedOpeningReused:true,promotionDelayMs:2000,startupMs:startup,continuedPlayback:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
