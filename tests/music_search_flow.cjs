// Real browser/decks and synthetic HLS; controlled API states, no injected transition plan.
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), fixture = path.join(root, '.local/music-browser');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE ||
  require.resolve('playwright', {paths:[root, path.resolve(root, '../agent-dock')]}));
const tracks = Array.from({length: 24}, (_, i) => ({id: String(i+1).padStart(11,'0'), url:`https://www.youtube.com/watch?v=${String(i+1).padStart(11,'0')}`, title:`Track ${i+1}`, channel:'Test artist', saved:true, duration:40}));
const jobs = new Map(), requests = [], errors = [];
tracks.forEach(t=>t.saved=false);
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
  const page=await browser.newPage({viewport:{width:1360,height:600}});page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('music:queue-mode','order'));
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
   else if(p==='/api/search')body={results:tracks.slice(data.offset||0,(data.offset||0)+8),next_offset:(data.offset||0)+8<tracks.length?(data.offset||0)+8:null};
   else if(p==='/api/jobs'&&data){const t=tracks.find(t=>t.url===data.url);body={job:job(t)};setTimeout(()=>{t.saved=true;const j=jobs.get(t.id);j.saved=true;j.state='done';},500);}
   else if(p==='/api/jobs')body={jobs:[...jobs.values()]};
   else if(p==='/api/queue')body={jobs:[...new Map([...data.tracks,...(data.previews||[])].map(t=>[t.id,t])).values()].map((t,i)=>job(t,i+1))};
   else if(p==='/api/transition'){
    if(transitionDelay)await transitionDelay;
    body={plan:{out:40-data.fade,in:0,rate:1,fade:data.fade,mode:'Crossfade'}};
   }else body={job:[...jobs.values()].find(j=>p.endsWith(j.id))};
   await route.fulfill({json:body});
  });
  await page.goto('https://music.test/');
  await page.locator('#q').fill('Test');
  await page.waitForSelector('#results .song-primary');
  assert(requests.some(r=>r.p==='/api/search'),'Typing triggers search');
  await page.waitForTimeout(300);
  assert(!requests.some(r=>r.p==='/api/queue'&&r.data.previews?.length),'Browsing search requested speculative audio');
  await page.locator('#results .song-primary').nth(2).click();
  await page.waitForFunction(()=>currentTrack?.id==='00000000003'&&queue.length>0);
  assert.equal(await page.evaluate(()=>queue[0].id),'00000000004','Next follows selected row');
  await page.locator('#next').click();
  await page.waitForFunction(()=>currentTrack?.id==='00000000004');
  assert.equal(await page.evaluate(()=>queue[0].id),'00000000005','Skip continues result order');
  await page.locator('#content').evaluate(n=>n.scrollTop=n.scrollHeight);
  await page.waitForFunction(()=>visibleResults.length>8);
  await page.waitForTimeout(350);
  assert(!requests.some(r=>r.p==='/api/queue'&&r.data.previews?.length),'Scrolling search requested speculative audio');
  await page.locator('#profile-toggle').click();await page.locator('#nav-settings').click();
  await page.locator('#include-long-mixes').focus();await page.keyboard.press('Space');
  assert(await page.locator('#settings-view').isVisible());
  assert(await page.evaluate(()=>document.activeElement.id==='include-long-mixes'));
  await page.locator('#clear-search').click();
  assert.equal(await page.locator('#q').inputValue(),'');
  assert(await page.evaluate(()=>document.activeElement.id==='q'),'Clear keeps focus in search');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({typeSearch:true,orderedSkipping:true,searchWithoutAudioPrefetch:true,infiniteScroll:true,settingsFocus:true,clearFocus:true}));
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
