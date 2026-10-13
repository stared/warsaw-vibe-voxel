// Render the same camera poses on a build for before/after comparisons (UI hidden, traffic + fountains off).
// usage: node tools/cmpshots.mjs <baseURL> <outdir> <rowShift> [n] [query] [zShift]
//   rowShift: grid rows to add to the (old 1.5 km map) poses, e.g. 480 for the 3950 x 3000 m map
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base, out, shift = 0, n = 16, q = '', zs = 0] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`${base}?ui=0&hour=17.7${q ? '&' + q : ''}`);
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 300000 });
await page.waitForTimeout(2000);
for (let i = 0; i < +n; i++) {
  await page.evaluate(([i, shift, zs]) => {
    let a = 2000 + i * 7919; const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const T = window.__three;
    window.__life.group.visible = false; T.P.fountains = false;
    const tx = 250 + rnd() * 1000, tz = 250 + rnd() * 1000 + shift;
    const dist = 60 + rnd() ** 1.5 * 900, el = 0.2 + rnd() * 0.9, az = rnd() * 6.283, g = 20 + zs; // zs: the new map's base is 22 m lower (the Vistula)
    T.controls.target.set(tx, g, tz);
    T.camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, g + Math.sin(el) * dist, tz + Math.cos(az) * Math.cos(el) * dist);
    T.controls.update();
  }, [i, +shift, +zs]);
  await page.waitForTimeout(400);
  // wait until streaming has settled (no-op on the old build)
  await page.waitForFunction(() => !window.__streamer || (window.__streamer.inflight === 0 && window.__streamer.queue.length === 0), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}.png` });
}
await browser.close();
