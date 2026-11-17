// Render the affected native layout with the app's real CSS and JavaScript.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const {chromium, webkit, devices} = require(require.resolve('playwright', {paths:[root,path.resolve(root,'../agent-dock')]}));
const read = file => fs.readFileSync(path.join(root,file),'utf8');
const out = path.join(root,'.local/native-ui-review/playlist-updates');
fs.mkdirSync(out,{recursive:true});
const css = ['music_web/static/shell.css','clients/FamilyHub.App/wwwroot/app-native.css','clients/FamilyHub.App/wwwroot/profile-images.css','clients/FamilyHub.App/wwwroot/player-native.css','packages/paddock-effects/effects.css','clients/FamilyHub.App/wwwroot/home-mobile.css'].map(read).join('\n');
const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="${name==='plus'?'M12 4v16M4 12h16':'M3 12h18'}"/></svg>`;
const avatar = name => `<span class="profile-avatar" style="--avatar-size:24px" aria-hidden="true">${name[0]}</span>`;
const author = name => `<span class="playlist-track-author" title="${name}"><span class="sr">Added by </span>${avatar(name)}<span>${name}</span></span>`;
const headings = '<div class="playlist-column-headings"><span>#</span><span>Title</span><span class="playlist-column-label" title="Album">Album</span><span class="playlist-added-heading"><span class="playlist-column-label" title="Date added">Date added</span><span>Added by</span></span><span aria-label="Duration">Time</span></div>';
const card = (name, owner, number) => `<button class="playlist-card glass-panel"><span class="cover"><img data-test-cover="${number}" alt=""></span><strong>${name}</strong><span class="playlist-attribution">${avatar(owner)}<span>Shared by ${owner}</span></span><span>14 songs</span></button>`;
const row = n => `<article class="native-song-row song-row has-playlist-columns"><span class="playlist-track-number">${n}</span><button class="song-primary" aria-label="Play Dynamite ${n}"><span class="song-artwork"><span class="cover"><img data-test-cover="0" alt=""></span></span><span class="song-text"><strong>Dynamite</strong><small>Taio Cruz</small></span></button><span class="playlist-track-album" title="Rokstarr">Rokstarr</span><span class="playlist-track-added"><span class="playlist-track-date" title="17 November 2026, 12:00">2 hours ago</span>${author(n===2?'Alexandra Long Profile Name':'Yeeroo')}</span><span class="playlist-track-duration">3:22</span><span class="storage-state" title="Cached">${icon('music')}</span><div class="row-actions"><button class="row-action" title="Add to playlist" aria-label="Add Dynamite ${n} to playlist">${icon('plus')}</button><button class="row-action row-more" title="More options">${icon('more')}</button></div></article>`;
const html = `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body data-view="playlists"><div id="app" style="display:contents"><header class="app-header"><form id="search-form"><input id="q" aria-label="Search songs" placeholder="Search songs or artists"></form></header><aside class="sidebar"><button>Home</button></aside><div class="workspace"><main id="content" tabindex="-1"><section id="overview"><div class="playlist-tools"><div class="genre-pills playlist-filters"><button>All</button><button>Yours</button></div><label class="playlist-search">${icon('search')}<span class="sr">Find in playlists</span><input id="playlist-search" type="search" placeholder="Find in playlists"></label><button id="playlist-sort">Recent</button></div><div class="playlist-grid"><button id="create-playlist" class="playlist-card glass-panel"><span class="cover generated-cover create-cover">${icon('plus')}</span><strong>Create playlist</strong></button>${card('larp','me',0)}${card('DnB','Alexandra Long Profile Name',1)}${card('Rock(?)','Nemozoli',2)}</div></section><section id="detail" hidden><button id="back">All playlists</button><div class="playlist-sticky"><strong>Shared mix</strong><button>Play playlist</button></div><section class="playlist-hero glass-panel" style="height:260px"><h1>Shared mix</h1></section>${headings}<div class="library-list playlist-song-list">${Array.from({length:24},(_,i)=>row(i+1)).join('')}</div></section></main></div><footer class="player-bar">Player</footer><dialog id="create-playlist-dialog"><label>Name<input id="new-playlist"></label><button id="close-create">Close</button></dialog></div></body>`;

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
   const page=await browser.newPage(profile), errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('https://playlists.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
   await page.goto('https://playlists.test/');
   await page.addScriptTag({content:read('packages/paddock-effects/effects.js')});
   await page.addScriptTag({content:read('clients/FamilyHub.App/wwwroot/app.js')});
   await page.evaluate(()=>{
    familyhub.loadAppearance('playlist-check');
    const images=Array.from({length:3},(_,n)=>{
     const c=document.createElement('canvas');c.width=c.height=160;const ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,160,160);
     ctx.fillStyle=n===2?'#e8b880':'#3976bf';ctx.fillRect(n===0?20:0,n===0?20:0,n===0?120:160,n===0?120:160);
     ctx.fillStyle='#e6b19e';ctx.beginPath();ctx.arc(80,70,26,0,Math.PI*2);ctx.fill();return c.toDataURL();
    });
    document.querySelectorAll('[data-test-cover]').forEach(img=>img.src=images[Number(img.dataset.testCover)]);
    document.getElementById('create-playlist').onclick=()=>familyhub.showDialog('create-playlist-dialog','new-playlist');
    document.getElementById('close-create').onclick=()=>familyhub.closeDialog('create-playlist-dialog','create-playlist');
   });
   await page.waitForFunction(()=>document.querySelector('[data-test-cover="0"]').style.width!=='',null,{timeout:5000}).catch(async error=>{ console.error(name,errors,await page.locator('[data-test-cover="0"]').first().evaluate(img=>({complete:img.complete,naturalWidth:img.naturalWidth,frame:img.parentElement.getBoundingClientRect().toJSON(),style:img.getAttribute('style')})));throw error; });
   const crop=await page.locator('[data-test-cover="0"]').first().evaluate(img=>({width:parseFloat(img.style.width),left:parseFloat(img.style.left)}));
   assert(crop.width>130 && crop.left<0,JSON.stringify(crop));
   assert.equal(await page.locator('[data-test-cover="1"]').evaluate(img=>img.style.width),'');
   assert.deepEqual(await page.evaluate(async()=>{
    const frame=document.createElement('span');frame.className='cover';frame.style.cssText='position:fixed;left:-200px;width:80px;height:80px';document.body.append(frame);
    const image=new Image();frame.append(image);
    const load=src=>new Promise(resolve=>{image.onload=resolve;image.src=src;});
    const canvas=document.createElement('canvas');canvas.width=canvas.height=160;const ctx=canvas.getContext('2d');
    ctx.fillStyle='#000';ctx.fillRect(0,0,160,160);await load(canvas.toDataURL());const allBlack=image.style.width==='';
    ctx.fillStyle='#3478be';ctx.fillRect(20,0,140,160);await load(canvas.toDataURL());const oneSided=image.style.width==='';
    await load(document.querySelector('[data-test-cover="0"]').src);const cropped=!!image.style.width;
    await load(document.querySelector('[data-test-cover="1"]').src);const reset=image.style.width==='';frame.remove();return {allBlack,oneSided,cropped,reset};
   }),{allBlack:true,oneSided:true,cropped:true,reset:true});
   await page.locator('#create-playlist').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>document.activeElement.id==='new-playlist');
   await page.locator('#close-create').click();assert.equal(await page.evaluate(()=>document.activeElement.id),'create-playlist');
   await page.keyboard.press('Space');await page.waitForFunction(()=>document.activeElement.id==='new-playlist');
   await page.locator('#close-create').click();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'create-playlist');
   assert.equal(await page.locator('#playlist-search').evaluate(node=>getComputedStyle(node).borderRadius),'28px');
   const searchAlignment=await page.locator('.playlist-search').evaluate(node=>{const a=node.querySelector('.icon').getBoundingClientRect(),b=node.querySelector('input').getBoundingClientRect();return Math.abs(a.top+a.height/2-b.top-b.height/2);});
   assert(searchAlignment<1,'Playlist search icon is not centered');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(out,name+'-playlists.png')});
   await page.evaluate(()=>{document.getElementById('overview').hidden=true;document.getElementById('detail').hidden=false;document.getElementById('back').focus();familyhub.observePlaylistHero();document.querySelectorAll('.playlist-song-list .cover img').forEach(familyhub.cropCover);});
   assert.equal(await page.locator('.playlist-track-author>span:last-child').first().innerText(),'Yeeroo');
   const authorBounds=await page.locator('.playlist-track-author').nth(1).boundingBox();assert(authorBounds.width>24);
   if(profile.viewport?.width>1000){
    await page.locator('.playlist-track-album').first().scrollIntoViewIfNeeded();await page.waitForTimeout(150);await page.mouse.move(0,0);
    await page.locator('.playlist-track-album').first().hover();await page.waitForFunction(()=>document.querySelector('.app-tooltip.is-visible')?.textContent==='Rokstarr',null,{timeout:4000});
    await page.locator('.playlist-track-date').first().hover();await page.waitForFunction(()=>document.querySelector('.app-tooltip.is-visible')?.textContent==='17 November 2026, 12:00',null,{timeout:4000});
    await page.evaluate(()=>document.getElementById('content').scrollTop=900);
    await page.waitForFunction(()=>Math.abs(document.querySelector('.playlist-sticky').getBoundingClientRect().bottom-document.querySelector('.playlist-column-headings').getBoundingClientRect().top)<1,null,{timeout:5000});
    const sticky=await page.evaluate(()=>({bar:document.querySelector('.playlist-sticky').getBoundingClientRect().bottom,head:document.querySelector('.playlist-column-headings').getBoundingClientRect().top,font:getComputedStyle(document.querySelector('.playlist-column-headings')).fontWeight}));
    assert(Math.abs(sticky.bar-sticky.head)<2,JSON.stringify(sticky));assert(Number(sticky.font)>=700);
   }
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(out,name+'-entries.png')});
   await page.emulateMedia({reducedMotion:'reduce'});await page.evaluate(()=>{document.getElementById('detail').hidden=true;document.getElementById('overview').hidden=false;document.getElementById('create-playlist').focus();});
   assert.equal(await page.locator('#create-playlist .icon').evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
   assert.deepEqual(errors,[]);results.push({profile:name,crop:true,bylines:true,keyboard:true,reducedMotion:true,overflow:false});
  }finally{await browser.close();}
 }
 fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify({coverage:'Affected native layout in browser engines; Apple and phone profiles emulated, not physical devices',results},null,2));
 console.log('PASS: playlist covers, attribution, search style, sticky headings and keyboard across four profiles');
})().catch(error=>{console.error(error);process.exitCode=1;});
