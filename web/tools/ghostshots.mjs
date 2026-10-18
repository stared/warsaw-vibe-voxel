// PROTOTYPE: screenshots of the ghost styles (proto.js) from the Home view and closer to the edge of the real square.
// usage: node tools/ghostshots.mjs <outdir> [styles "1,2,3"] [extra query]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/ghost', styles = '1,2,3,4,5', extra = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const POSES = { home: null, top: { t: [1100, 20, 1400], dir: [0.15, 0.9, 0.42], d: 4200 }, night: 'night' };
for (const st of styles.split(',')) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:5173/?ui=0&ghost=${st}${extra ? '&' + extra : ''}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(7000);
  for (const [name, p] of Object.entries(POSES)) {
    if (p === 'night') { await page.evaluate(() => { window.__three.applyTime(22); window.__three.nav.cancelFly?.(); }); await page.goto(page.url()); }
    if (p === 'night') { await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 }); await page.waitForTimeout(7000); await page.evaluate(() => window.__three.applyTime(22)); }
    else if (p) await page.evaluate(({ t, dir, d }) => { const T = window.__three, n = Math.hypot(...dir); T.nav.cancelFly?.(); T.controls.target.set(...t);
      T.camera.position.set(t[0] + dir[0] / n * d, t[1] + dir[1] / n * d, t[2] + dir[2] / n * d); T.controls.update(); }, p);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/s${st}_${name}.png` });
  }
  console.log('style', st, await page.evaluate(() => (window.__streamer.tris / 1e6).toFixed(1) + ' M tris'));
  await page.close();
}
await browser.close();
