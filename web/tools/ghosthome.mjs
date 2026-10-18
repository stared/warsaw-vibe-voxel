// PROTOTYPE: the Home view at 2x resolution for each treatment of what lies outside the real area.
// usage: node tools/ghosthome.mjs <outdir> name=query ...
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out, ...vs] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
for (const v of vs) {
  const [name, q] = v.split('=', 2).length === 2 ? [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)] : [v, ''];
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
  await page.goto(`http://localhost:5173/?ui=0&${q}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.waitForTimeout(7000);
  // settled: every tile the streamer wants is loaded (no stand-ins on screen)
  await page.waitForFunction(() => { const S = window.__streamer, cam = window.__three.camera;
    return !S.inflight && !S.queue.length; }, null, { timeout: 120000, polling: 250 }).catch(() => console.log('  not settled'));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, 'ok');
  await page.close();
}
await browser.close();
