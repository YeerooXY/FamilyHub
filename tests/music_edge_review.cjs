const {chromium,webkit,devices}=require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('assert');
const root=path.resolve(__dirname,'../.local/edge-review'),shots=path.join(root,'verification');fs.mkdirSync(shots,{recursive:true});
const server=http.createServer((req,res)=>{
 const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(name!=='/'&&name!=='/index.html'&&name!=='/review.csv'&&!/^\/clips\/[a-f0-9]{64}-(beginning|ending)(-extended)?\.m4a$/.test(name)){res.writeHead(404);return res.end()}
 const file=path.join(root,name==='/'?'index.html':name.slice(1)),data=fs.readFileSync(file),range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
 res.setHeader('Content-Type',name.endsWith('.m4a')?'audio/mp4':name.endsWith('.csv')?'text/csv':'text/html');
 res.setHeader('Accept-Ranges','bytes');
 if(range){const start=+range[1],end=Math.min(data.length-1,range[2]?+range[2]:data.length-1);res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${data.length}`,'Content-Length':end-start+1});return res.end(data.subarray(start,end+1))}
 res.end(data);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port,results=[];
 try{
 for(const [name,engine,profile] of [['windows-chromium',chromium,{viewport:{width:1440,height:1000}}],['mac-webkit-emulated',webkit,{viewport:{width:1440,height:1000}}],['android-chromium-emulated',chromium,devices['Pixel 7']],['iphone-webkit-emulated',webkit,devices['iPhone 13']]]){
  const browser=await engine.launch({headless:true});try{
   const page=await browser.newPage(profile),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(url);assert.equal(await page.locator('#song-list button').count(),102);
   assert.match(await page.locator('#count').innerText(),/20 \/ 102/);
   assert.match(await page.locator('h2').innerText(),/Remember the Time/);
   assert.match(await page.getByLabel('Notes',{exact:true}).inputValue(),/last section is random/);
   if(engine===chromium){
    await page.getByRole('button',{name:'Play around end cue'}).click();await page.waitForFunction(()=>document.querySelector('#audio-ending').duration>119);
    await page.locator('#audio-ending').evaluate(el=>{el.pause();el.currentTime=90});
    const mark=page.getByRole('button',{name:'Set end here',exact:true});await mark.click();
    assert(Math.abs(Number(await page.locator('#end').inputValue())-528.32)<.05,'Original-time cue ignored preview offset');
    assert(await mark.evaluate(el=>document.activeElement===el),'Marking a cue lost keyboard focus');
   }
   await page.getByLabel('Find a song or artist').fill('thriller');assert.equal(await page.locator('#song-list button:visible').count(),1);
   await page.locator('#song-list button:visible').click();assert.match(await page.locator('h2').innerText(),/Thriller/);
   const proposed=Number(await page.locator('#end').inputValue());assert(proposed>185&&proposed<187,'Thriller quiet tail was missed');
   await page.getByLabel('Decision',{exact:true}).focus();await page.getByLabel('Decision',{exact:true}).selectOption('keep-original');assert.equal(await page.locator('#end').inputValue(),'201.06');assert.equal(await page.evaluate(()=>document.activeElement.tagName),'SELECT');
   await page.getByLabel('Decision',{exact:true}).selectOption('use-proposal');assert.equal(Number(await page.locator('#end').inputValue()),proposed);
   await page.getByLabel('Notes',{exact:true}).fill('Manual review test');await page.getByLabel('Notes',{exact:true}).press('Tab');
   await page.reload();await page.getByLabel('Find a song or artist').fill('thriller');await page.locator('#song-list button:visible').click();assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Manual review test');
   let audio='not checked';
   if(engine===chromium){await page.getByRole('button',{name:'Play around end cue'}).click();await page.waitForFunction(()=>document.querySelector('#audio-ending').currentTime>.1&&!document.querySelector('#audio-ending').paused);audio='AAC preview decoded and advanced';await page.locator('#audio-ending').evaluate(el=>el.pause())}
   const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export decisions'}).click();const exported=await download;const file=path.join(shots,name+'-decisions.json');await exported.saveAs(file);const decisions=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(decisions.decisions.length,102);
   await page.locator('#import').setInputFiles(file);await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Imported 102'));
   await page.getByLabel('Find a song or artist').fill('');await page.getByRole('button',{name:'Next song',exact:true}).focus();for(const key of ['Enter','Space']){await page.keyboard.press(key);assert.equal(await page.evaluate(()=>document.activeElement.id),'next')}
   await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'next');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
   await page.screenshot({path:path.join(shots,name+'.png'),fullPage:true});assert.deepEqual(errors,[]);results.push({profile:name,search:true,decisionsAndPersistence:true,exportImport:true,focus:true,overflow:false,audio});
  }finally{await browser.close()}
 }
 fs.writeFileSync(path.join(shots,'checks.json'),JSON.stringify({coverage:'Browser engine emulation; no physical-device claim',results},null,2));console.log(JSON.stringify(results));
 }finally{await new Promise(resolve=>server.close(resolve))}
})().catch(e=>{console.error(e);process.exitCode=1});
