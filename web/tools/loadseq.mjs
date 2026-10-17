// PROTOTYPE: screenshots as fast as possible while the whole city loads, for each way of getting there.
// usage: node tools/loadseq.mjs <outdir> [runs]   -> <outdir>/<path><run>-<ms>.jpg   (paths: direct, menu, phone)
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out, runs = 1] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
async function rec(name, vp, go, dur) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('whole city')) console.log(name, m.text().slice(0, 200)); });
  const t0 = await go(page);
  while (Date.now() - t0 < dur) await page.screenshot({ path: `${out}/${name}-${String(Date.now() - t0).padStart(5, '0')}.jpg`, quality: 70 }).catch(() => {});
  await page.close();
}
for (let r = 0; r < runs; r++) {
  await rec(`direct${r}`, { width: 1280, height: 800 }, async (p) => { const t0 = Date.now(); await p.goto('http://localhost:5173/?all1m=1', { waitUntil: 'commit' }); return t0; }, 8000);
  await rec(`menu${r}`, { width: 1280, height: 800 }, async (p) => {
    await p.goto('http://localhost:5173/'); await p.waitForFunction(() => window.__ready === true, null, { timeout: 120000 }); await p.waitForTimeout(2000);
    const t0 = Date.now();
    p.evaluate(() => window.__three.gui.controllersRecursive().find((c) => c._name === 'engine').setValue('whole city at 1 m')).catch(() => {});
    await p.waitForTimeout(150); return t0; }, 8000);
  await rec(`phone${r}`, { width: 390, height: 844 }, async (p) => { const t0 = Date.now(); await p.goto('http://localhost:5173/?all1m=1', { waitUntil: 'commit' }); return t0; }, 6000);
}
await browser.close();
