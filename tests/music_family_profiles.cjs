// Actual rendered chooser and shared-playlist controls, with keyboard navigation.
const {chromium}=require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const {execFileSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');
(async()=>{
 const browser=await chromium.launch();
 try {
  const html=execFileSync(path.join(root,'.local/playlist-reader-venv/Scripts/python.exe'),['-c',
   "import sys;sys.path.insert(0,'tests');from test_family_profiles import FamilyProfiles;c=FamilyProfiles();c.setUp();print(c.go(c.app.test_client(),'GET','/login').get_data(as_text=True));c.doCleanups()"],{cwd:root,encoding:'utf8'});
  const page=await browser.newPage();
  await page.setContent(html);
  await page.addStyleTag({path:path.join(root,'music_web/static/app.css')});
  await page.addStyleTag({path:path.join(root,'music_web/static/profiles.css')});
  await page.evaluate(()=>{window.selected=[];document.addEventListener('submit',e=>{e.preventDefault();selected.push(new FormData(e.target).get('profile_id'));});});
  const buttons=page.locator('.family-profile');
  await buttons.nth(0).focus();await page.keyboard.press('Tab');
  assert(await buttons.nth(1).evaluate(e=>e===document.activeElement));
  await page.keyboard.press('Shift+Tab');await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');await page.keyboard.press('Space');
  assert.deepEqual(await page.evaluate(()=>selected),['sample-a','sample-b']);
  assert(await page.evaluate(()=>document.activeElement!==document.body));
  await page.keyboard.press('Tab');await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert(await page.locator('#profile-name').evaluate(e=>e===document.activeElement));

  const markup=fs.readFileSync(path.join(root,'music_web/templates/index.html'),'utf8');
  await page.setContent(markup.match(/<details id="playlist-panel">[\s\S]*?<\/details>/)[0]);
  await page.evaluate(()=>{
   window.$=id=>document.getElementById(id);
   window.el=(tag,attrs={},...children)=>{const e=document.createElement(tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);e.append(...children);return e;};
   const track={title:'Song',artist:'Artist',candidates:[],state:'unmatched'};
   window.api=async()=>({playlists:[
    {id:'same',owner_id:'sample-a',owner_name:'A',can_edit:true,name:'Mine',tracks:[track]},
    {id:'same',owner_id:'sample-b',owner_name:'B',can_edit:false,name:'Shared',tracks:[track]}
   ]});
  });
  await page.addScriptTag({path:path.join(root,'music_web/static/playlists.js')});
  await page.locator('summary').click();
  await page.waitForFunction(()=>document.querySelector('#playlist-select').options.length===3);
  await page.locator('#playlist-select').selectOption('sample-b:same');
  assert.equal(await page.locator('#playlist-name').textContent(),'Shared');
  assert(await page.locator('#playlist-match').isDisabled());
  assert(await page.locator('#playlist-download').isDisabled());
  await page.locator('#playlist-select').selectOption('sample-a:same');
  assert.equal(await page.locator('#playlist-name').textContent(),'Mine');
  assert(await page.locator('#playlist-match').isEnabled());
  console.log('PASS: profile chooser Tab/Shift+Tab/Enter/Space, Add profile focus, shared playlist owner collisions and read-only controls');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
