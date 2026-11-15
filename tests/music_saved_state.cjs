// Real browser/decks and synthetic HLS; controlled API states, no injected transition plan.
const {chromium} = require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, '.local/music-browser');
const tracks = Array.from({length: 5}, (_, i) => ({id: String(i+1).padStart(11,'0'), url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'0')}`, title:`Track ${i+1}`, channel:'Test artist', saved:true, duration:40}));
const jobs = new Map(), requests = [], errors = [];
tracks[4].saved=false;
const playlistReads = new Map();
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
    let body=fs.readFileSync(path.join(fixture,'hls',path.basename(p)));
    if(p.endsWith('index.m3u8')) {
     const count=playlistReads.get(p)||0;playlistReads.set(p,count+1);
     if(count===0) body=Buffer.from(body.toString().match(/^[\s\S]*?seg00000\.m4s\r?\n/)[0]);
    }
    return route.fulfill({contentType:mime[path.extname(p)],body});
   }
   const data=request.method()==='POST'?request.postDataJSON():null;
   requests.push({p,data});
   let body={};
   if(p==='/api/library')body={results:tracks.filter(t=>t.saved)};
   else if(p==='/api/search')body={results:tracks};
   else if(p==='/api/jobs'&&data){const t=tracks.find(t=>t.url===data.url);body={job:job(t)};setTimeout(()=>{t.saved=true;const j=jobs.get(t.id);j.saved=true;j.state='done';},500);}
   else if(p==='/api/jobs')body={jobs:[...jobs.values()]};
   else if(p==='/api/queue')body={jobs:data.tracks.map((t,i)=>job(t,i+1))};
   else if(p==='/api/transition'){
    if(transitionDelay)await transitionDelay;
    body={plan:{out:40-data.fade,in:0,rate:1,fade:data.fade,mode:'Crossfade'}};
   }else body={job:[...jobs.values()].find(j=>p.endsWith(j.id))};
   await route.fulfill({json:body});
  });
  await page.goto('https://music.test/');
  await page.locator('#q').fill('Test'); await page.locator('#search-form button[type=submit]').click();
  const selected=page.locator('#results .song-primary').last();
  assert.equal(await selected.locator('.storage-state').getAttribute('aria-label'),'Available to download');
  await selected.click();
  await page.waitForFunction(()=>document.querySelector('#results .song-primary:last-child') || visibleResults.length);
  await page.waitForFunction(()=>[...document.querySelectorAll('#results .song-primary')].at(-1).querySelector('.storage-state').getAttribute('aria-label')==='Saved on server');
  assert(await selected.evaluate(n=>n===document.activeElement),'Import completion stole search-row focus');
  assert(await page.evaluate(()=>savedSources.has('00000000005')));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({savedBadgeUpdated:true,searchFocusPreserved:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
