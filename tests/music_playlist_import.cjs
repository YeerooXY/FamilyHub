// Isolated import controls with the real playlist markup and event handlers.
const {chromium}=require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs=require('fs'), path=require('path'), assert=require('assert');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch();
 try {
  const page=await browser.newPage();
  const markup=fs.readFileSync(path.join(root,'music_web/templates/index.html'),'utf8');
  await page.setContent(markup.match(/<details id="playlist-panel">[\s\S]*?<\/details>/)[0]);
  await page.evaluate(()=>{
   window.$=id=>document.getElementById(id);
   window.el=(tag,attrs={},...children)=>{
    const e=document.createElement(tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);
    e.append(...children);return e;
   };
   window.imports=0;window.pendingImport=null;window.saved=[];
   window.api=async(url,options)=>{
    if(options){imports++;await new Promise(resolve=>window.pendingImport=resolve);
     const track=i=>({title:'Track '+i,artist:'Artist',spotify_uri:'spotify:track:'+i,
       state:'unmatched',candidates:[{id:String(i),title:'Recording '+i,channel:'Artist',recommended:false}]});
     saved=[{id:'test',name:'Test',notice:'549 tracks imported in playlist order.',
       tracks:Array.from({length:549},(_,i)=>track(i+imports))}];
     return {playlist:saved[0]};
    }return {playlists:saved};
   };
  });
  await page.addScriptTag({path:path.join(root,'music_web/static/playlists.js')});
  const summary=page.locator('summary'),input=page.locator('#spotify-playlist-url');
  await summary.focus();await page.keyboard.press('Space');
  await page.keyboard.press('Tab');assert(await input.evaluate(e=>e===document.activeElement));
  await input.fill('https://open.spotify.com/playlist/6CCDIMytDCox2aDcNi1ztu');
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>imports===1);
  assert(await input.evaluate(e=>e===document.activeElement),'Focus lost while import button disabled');
  await page.evaluate(()=>pendingImport());
  await page.waitForFunction(()=>document.querySelectorAll('#playlist-tracks li').length===549);
  assert(await input.evaluate(e=>e===document.activeElement),'Focus lost after importing');
  const choice=page.locator('[data-playlist-index="0"]');await choice.selectOption('0');
  await input.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  assert(await input.evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Enter');await page.waitForFunction(()=>imports===2);
  await page.evaluate(()=>pendingImport());
  await page.waitForFunction(()=>document.querySelector('#playlist-tracks strong').textContent==='Track 2');
  assert.equal(await choice.inputValue(),'','A stale choice survived the reordered import');
  assert(await page.evaluate(()=>document.activeElement!==document.body));
  console.log('PASS: 549 rendered entries, refreshed choices, Tab/Shift+Tab/Enter/Space and import focus');
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
