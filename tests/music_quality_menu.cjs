// Render the native Razor menu's markup and CSS; session behavior is covered in .NET.
const {chromium, webkit, devices} = require('C:/Users/you/Projects/agent-dock/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const root = path.resolve(__dirname, '..'), output = path.join(root, '.local/mobile-conversion/quality-menu');
fs.mkdirSync(output, {recursive:true});
const razor = fs.readFileSync(path.join(root, 'clients/FamilyHub.App/Components/Pages/Music.razor'), 'utf8');
let menu = razor.slice(razor.indexOf('<div id="profile-menu">'));
menu = razor.slice(razor.indexOf('<div id="profile-menu"'), razor.indexOf('<AppUpdate', razor.indexOf('<div id="profile-menu"'))) + '</div>';
menu = menu
  .replace(/<MusicIcon[^>]*\/>/g, '')
  .replace('@Session.ProfileName', 'Alex')
  .replace('value="@Session.PlaybackQuality"', 'value="max"')
  .replace(' disabled="@Player.Preparing"', '')
  .replace(/@foreach[\s\S]*?<\/option> }/, '<option value="classic">Paddock</option><option value="blue">Blue</option>');
const css = ['music_web/static/shell.css', 'clients/FamilyHub.App/wwwroot/app-native.css', 'clients/FamilyHub.App/wwwroot/player-native.css', 'packages/paddock-effects/effects.css']
  .map(file => fs.readFileSync(path.join(root,file),'utf8')).join('\n');
(async () => {
  const results = [];
  for (const [name, engine, profile] of [
    ['windows-chromium',chromium,{viewport:{width:1440,height:900}}],
    ['mac-webkit-emulated',webkit,{viewport:{width:1440,height:900}}],
    ['android-chromium-emulated',chromium,devices['Pixel 7']],
    ['iphone-webkit-emulated',webkit,devices['iPhone 13']]
  ]) {
    const browser = await engine.launch({headless:true});
    try {
      const page = await browser.newPage(profile);
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body><header class="app-header"><div class="header-start"><form id="search-form"><input placeholder="Search songs or artists"></form></div><div class="sidebar-account"><button id="profile-toggle">Alex</button>${menu}</div></header></body>`);
      const control = page.getByLabel('Audio quality', {exact:true});
      assert.equal(await control.inputValue(),'max');
      await control.focus(); await control.selectOption('lower');
      assert.equal(await page.evaluate(() => document.activeElement.id),'playback-quality');
      await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id),'playback-quality');
      // Enter and Space operate the adjacent semantic checkbox without losing focus.
      const toggle = page.getByLabel('Theme effects', {exact:true});
      await toggle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('Enter');
      assert.equal(await toggle.evaluate(node => document.activeElement === node),true);
      const bounds = await page.locator('#profile-menu').boundingBox();
      assert(bounds.x >= 0 && bounds.x+bounds.width <= page.viewportSize().width+1,JSON.stringify({name,bounds,viewport:page.viewportSize()}));
      assert(bounds.y+bounds.height <= page.viewportSize().height+1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false);
      await page.screenshot({path:path.join(output,name+'.png')});
      results.push({profile:name,menuInBounds:true,focus:true,defaultQuality:'max'});
    } finally { await browser.close(); }
  }
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({coverage:'Native markup in browser engines; not physical native shells',results},null,2));
  console.log('PASS: quality menu defaults, focus, keyboard controls and bounds across four profiles');
})().catch(error => { console.error(error); process.exitCode = 1; });
