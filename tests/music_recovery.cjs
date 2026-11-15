// Real browser/decks and synthetic HLS; controlled API states, no injected transition plan.
const {chromium} = require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, '.local/music-browser');
const tracks = Array.from({length: 5}, (_, i) => ({id: String(i+1).padStart(11,'0'), url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'0')}`, title:`Track ${i+1}`, channel:'Test artist', saved:true, duration:40}));
const jobs = new Map(), requests = [], errors = [];
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
  await page.locator('#library-list button').first().click();
  await page.waitForFunction(()=>document.getElementById('total').textContent==='0:40');
  assert.equal(await page.locator('#library-list .is-current').count(),1);
  await page.locator('#profile-toggle').click(); await page.locator('#nav-settings').click();
  await page.locator('#autoplay').check();
  await page.waitForFunction(()=>Boolean(plan?.fade)&&decks[deckIndex].currentTime>2.3&&decks[deckIndex].duration>=40&&decks[1-deckIndex].readyState>=2);
  await page.waitForFunction(()=>document.querySelector('#library-list .is-next'));
  assert(await page.evaluate(()=>Boolean(decks[deckIndex].hls)),'Growing playlists should use HLS/MSE where supported');
  assert([...playlistReads.values()].some(n=>n>1),'Growing playlist was never refreshed');
  assert(requests.some(r=>r.p==='/api/transition'),'Running but playable next job should plan a transition');
  // Failure stays on the selected next song; automatic replacement is deferred.
  failId=tracks[1].id;job(tracks[1],1);
  await page.waitForFunction(()=>document.getElementById('queue-state').textContent.includes('could not prepare'));
  assert(await page.evaluate(()=>!decks[deckIndex].paused),'Failure interrupted current playback');
  const before=await page.evaluate(()=>queue.map(t=>t.id));
  await page.evaluate(()=>advance());
  assert.deepEqual(await page.evaluate(()=>queue.map(t=>t.id)),before,'Failure reordered the playlist');
  failId=null;jobs.delete(tracks[1].id);
  await page.evaluate(()=>prepare());
  await page.locator('#nav-queue').click();
  await page.locator('#library').click();await page.locator('#library').click();
  await page.evaluate(async()=>{await fillQueue();renderQueue();await prepare();});
  assert(await page.evaluate(()=>new Set(queue.map(sourceKey)).size===queue.length),'Duplicate queue sources');
  // A setting edited while an older plan request is in flight must win.
  let release;transitionDelay=new Promise(r=>release=r);
  await page.locator('#profile-toggle').click(); await page.locator('#nav-settings').click();
  await page.locator('#fade').fill('6');
  await page.waitForTimeout(100);
  await page.locator('#fade').fill('2');release();transitionDelay=null;
  await page.waitForFunction(()=>plan?.fade===2);
  await page.waitForFunction(()=>decks[1-deckIndex].readyState>=2);
  const starting=await page.evaluate(()=>deckIndex);
  await page.locator('#seek').evaluate(node=>{node.value=38.4;node.dispatchEvent(new Event('input'));});
  await page.waitForFunction(()=>blending);
  const overlap=await page.evaluate(async()=>{
   const analyzers=gains.map(g=>{const a=audioContext.createAnalyser();g.connect(a);return a;});
   await new Promise(r=>setTimeout(r,300));
   const levels=analyzers.map((a,i)=>{const d=new Float32Array(a.fftSize);a.getFloatTimeDomainData(d);gains[i].disconnect(a);return Math.sqrt(d.reduce((n,x)=>n+x*x,0)/d.length);});
   return {levels,incomingTime:decks[1-deckIndex].currentTime};
  });
  assert(overlap.levels.every(n=>n>.001),'Both decoded decks must contribute during overlap');
  assert(overlap.incomingTime>0,'Incoming audio must progress before the fade');
  assert(overlap.incomingTime<1.2,'Seeking near the end must not skip the incoming intro');
  await page.waitForFunction(i=>deckIndex!==i,starting);
  assert(await page.evaluate(()=>!decks[deckIndex].paused&&gains[deckIndex].gain.value>.99),'Handoff must retain playing incoming deck');
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(()=>currentTrack.title),'Track 2');
  // No-crossfade autoplay must adopt the already buffered deck, then keep advancing.
  await page.locator('#fade').fill('0');
  await page.locator('#fade').dispatchEvent('change');
  for(let turn=0;turn<2;turn++) {
    await page.waitForFunction(()=>decks[1-deckIndex].readyState>=2&&Boolean(upcoming()?.media_url));
    await page.waitForFunction(()=>Number.isFinite(decks[deckIndex].duration)&&decks[deckIndex].duration>=40);
    const expected=await page.evaluate(()=>({index:1-deckIndex,title:queue[0].title,url:decks[1-deckIndex].dataset.mediaUrl}));
    const started=Date.now();
    await page.locator('#seek').evaluate(node=>{node.value=39.7;node.dispatchEvent(new Event('input'));});
    await page.waitForFunction(title=>currentTrack.title===title&&!decks[deckIndex].paused&&decks[deckIndex].currentTime>.1,expected.title);
    assert.equal(await page.evaluate(()=>deckIndex),expected.index,'Autoplay discarded preloaded deck');
    assert.equal(await page.evaluate(()=>decks[deckIndex].dataset.mediaUrl),expected.url);
    assert(Date.now()-started<2500,'Buffered handoff waited for preparation');
  }
  // Pause fades the output before stopping the media clock; resume restores it.
  await page.locator('#play').click();
  await page.waitForTimeout(70);
  assert(await page.evaluate(()=>masterGain.gain.value>0 && masterGain.gain.value<1),'Pause must ramp, not cut');
  await page.waitForFunction(()=>decks[deckIndex].paused);
  await page.locator('#play').click();
  await page.waitForFunction(()=>!decks[deckIndex].paused && masterGain.gain.value>.99);
  // Manual Next uses the prepared deck and preserves both signals through the fade.
  await page.locator('#fade').fill('2'); await page.locator('#fade').dispatchEvent('change');
  await page.waitForFunction(()=>decks[1-deckIndex].readyState>=2 && Boolean(upcoming()?.media_url));
  const manualIndex = await page.evaluate(()=>deckIndex);
  await page.locator('#next').click();
  await page.waitForFunction(()=>blending);
  assert(await page.evaluate(()=>!decks[deckIndex].paused),'Skip stopped outgoing deck abruptly');
  await page.waitForFunction(i=>deckIndex!==i,manualIndex);
  const handoffTime = await page.evaluate(()=>decks[deckIndex].currentTime);
  await page.waitForTimeout(600);
  assert(await page.evaluate(t=>decks[deckIndex].currentTime>t, handoffTime),'Incoming restarted after manual handoff');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({runningPreviewTransition:true,failedNextPreserved:true,noDuplicateSources:true,latestSettingWins:true,seekOverlap:overlap,playingHandoff:true,twoNaturalAutoplayHandoffs:true,bufferedDeckReused:true,scope:'Synthetic API/HLS browser integration; not live acquisition'}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
