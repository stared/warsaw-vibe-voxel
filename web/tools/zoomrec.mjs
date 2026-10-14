// Record what a person sees while zooming with the mouse wheel: the default page (no test switches), wheel steps
// in toward the screen point and back out, a screenshot every ~100 ms. Look at the frames, not just a metric.
// Spots: 'home' (after the opening flight) or a seed for a random place (same seed, same place on every build).
// usage: PORT=5173 node tools/zoomrec.mjs <outdir> [spots, e.g. "home,1,2,3"] [query]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/zoomrec', spots = 'home', q = ''] = process.argv.slice(2);
const port = process.env.PORT || 5173;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`http://localhost:${port}/${q ? '?' + q : ''}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(6000); // opening flight
const log = [];
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const spot of spots.split(',')) {
  if (spot !== 'home') {
    const r = rng(+spot * 7919 + 17); r();
    const [W, D] = await page.evaluate(() => [window.__streamer.W ?? 3950, window.__streamer.D ?? 3150]);
    const t = [300 + r() * (W - 600), 0, 300 + r() * (D - 600)], az = r() * 2 * Math.PI, el = 0.45 + r() * 0.5, d = 1400 + r() * 900;
    await page.evaluate(([t, az, el, d]) => {
      const T = window.__three;
      T.nav.cancelFly?.();
      T.controls.target.set(...t);
      T.camera.position.set(t[0] + Math.cos(el) * Math.sin(az) * d, Math.sin(el) * d, t[2] + Math.cos(el) * Math.cos(az) * d);
      T.controls.update();
    }, [t, az, el, d]);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  let i = 0;
  await page.mouse.move(520, 420); // the middle of the map left of the settings panel
  for (const [tag, dy, n] of [['in', -100, 28], ['hold', 0, 10], ['out', 100, 28], ['hold2', 0, 10]]) {
    for (let k = 0; k < n; k++) {
      if (dy) await page.mouse.wheel(0, dy);
      await page.waitForTimeout(60);
      await page.screenshot({ path: `${out}/${spot}_${String(i).padStart(3, '0')}_${tag}.png` });
      // levels drawn (by tiles shown) and tiles wanted but not ready yet (a coarser ancestor stands in)
      const st = await page.evaluate(() => { const S = window.__streamer, shown = {}, miss = {};
        for (const n of S.nodes.values()) if (n.mesh?.visible) shown[n.s] = (shown[n.s] || 0) + 1;
        for (const n of S.nodes.values()) if (n.state !== 'ready' && n.s !== 8) miss[n.s] = (miss[n.s] || 0) + 1;
        return { shown, miss, d: Math.round(window.__three.camera.position.distanceTo(window.__three.controls.target)) }; });
      log.push({ spot, i: i++, tag, ...st });
    }
  }
  console.log('done', spot);
}
fs.writeFileSync(`${out}/log.json`, JSON.stringify(log));
await browser.close();
