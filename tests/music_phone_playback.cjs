const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const {chromium}=require(require.resolve('playwright',{paths:[root,path.resolve(root,'../agent-dock')]}));
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const css=['music_web/static/shell.css','clients/FamilyHub.App/wwwroot/app-native.css','clients/FamilyHub.App/wwwroot/player-native.css','clients/FamilyHub.App/wwwroot/paddock-theme.css','clients/FamilyHub.App/wwwroot/home-mobile.css'].map(read).join('\n');
(async()=>{const browser=await chromium.launch({headless:true});try{
for(const width of [360,412,720]){
 const page=await browser.newPage({viewport:{width,height:850}});
 await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="app"><div class="workspace"><main></main></div><footer class="player-bar"><div class="now-playing-group"><button id="show-queue" class="now-playing"><span class="cover"></span><span class="now-copy"><strong id="now-title"><span class="marquee-text">A long song title that should scroll through the compact mini player without overflowing</span></strong><span id="now-artist">Artist</span></span></button></div><div class="transport"><div class="transport-buttons"><button>Mix</button><button>Prev</button><button id="play">Play</button><button id="next">Next</button></div><div class="seek-row"></div></div><section class="lyrics-view"><header class="lyrics-header"><button>Close</button><span class="cover"></span><div><strong>Title</strong><span>Artist</span></div><div class="lyrics-timing"><button>Earlier</button><span>Original timing</span><button>Later</button></div></header><ol class="lyrics-lines"><li><button class="lyric-line">First lyric line</button></li></ol></section><button class="player-more">More</button></footer></div>`);
 await page.addScriptTag({content:read('clients/FamilyHub.App/wwwroot/app.js')});
 await page.evaluate(()=>familyhub.fitTitle());
 const metrics=await page.evaluate(()=>{const r=s=>{const e=document.querySelector(s),b=e.getBoundingClientRect();return {top:b.top,bottom:b.bottom,left:b.left,right:b.right,height:b.height,display:getComputedStyle(e).display}};return {header:r('.lyrics-header'),line:r('.lyric-line'),bar:r('.player-bar'),play:r('#play'),next:r('#next'),title:r('#now-title'),animations:familyhub.titleAnimations?.length}});
 assert(metrics.line.top>=metrics.header.bottom,JSON.stringify(metrics));
 assert(metrics.play.top>=metrics.bar.top&&metrics.play.bottom<=metrics.bar.bottom,JSON.stringify(metrics));
 assert(metrics.title.display!=='none');assert.equal(metrics.animations,2);
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(50);
 assert.equal(await page.evaluate(()=>familyhub.titleAnimations.length),0);
 await page.evaluate(()=>familyhub.setNativeActive(false));
 assert(await page.locator('body').evaluate(e=>e.classList.contains('native-hidden')));
 await page.close();
}
console.log('PASS: phone lyrics header, compact controls, marquee, reduced motion and lifecycle (Chromium fixtures).');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
