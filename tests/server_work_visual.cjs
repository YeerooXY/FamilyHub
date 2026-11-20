const { chromium, webkit, devices } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs = require('fs');
const assert = require('assert/strict');
(async () => {
  const output = 'docs/verification/play-on-demand-2026-11-19'; fs.mkdirSync(output, {recursive:true});
  const profiles = [
    ['windows', chromium, {viewport:{width:1280,height:900}}],
    ['mac', webkit, {viewport:{width:1440,height:900},userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'}],
    ['android', chromium, {...devices['Pixel 7']}],
    ['iphone', webkit, {...devices['iPhone 13']}],
    ['wide', chromium, {viewport:{width:2000,height:1100}}]
  ];
  for(const [name,engine,profile] of profiles) {
    const browser=await engine.launch({headless:true});
    const page=await browser.newPage(profile);
    for(const state of ['error','loaded']) {
      await page.setContent(fs.readFileSync(`.local/ui/${state}.html`,'utf8'));
      await page.evaluate(()=>document.fonts.ready);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth), `${name} ${state} overflow`);
      if(state==='error') {
        await page.getByRole('button',{name:'Retry server work',exact:true}).focus();
        assert(await page.getByRole('button',{name:'Retry song review',exact:true}).isVisible());
        assert.equal(await page.locator('[aria-busy="true"]').count(),0);
      }
      if(state==='loaded') {
        await page.getByText('Server details', {exact:true}).click();
        await page.getByText('Worker slots', {exact:true}).click();
      }
      await page.screenshot({path:`${output}/${name}-${state}.png`,fullPage:true});
      console.log(`PASS ${name} ${state}, ${await page.locator('button').count()} controls`);
    }
    await browser.close();
  }
})().catch(e=>{console.error(e);process.exit(1)});
