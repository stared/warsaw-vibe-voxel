// How a level-of-detail swap plays out over time, with the camera still: settle at full detail, switch the
// streamer to its normal error budget (coarser tiles come in), and screenshot ~every 100 ms; then back to full
// detail. tools/lodfade.py scores the frame-to-frame change: one big step is a flip, small ones a dissolve.
// usage: node tools/lodfade.mjs <outdir> [query, e.g. "fade=0"]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/lodfade', q = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const CASES = { // distances where the default budget draws the view mostly at 2 m (tools/lodflip.mjs)
  pkin: { t: [749, 110, 1229], dir: [0.55, 0.35, 0.76], d: 1450 },
  varso: { t: [300, 120, 1330], dir: [-0.6, 0.4, 0.7], d: 1600 },
  bridge: { t: [2916, 25, 834], dir: [0.2, 0.3, 0.93], d: 1450 },
};
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:5173/?ui=0&hour=14${q ? '&' + q : ''}`);
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 300000 });
const settle = async () => {
  await page.waitForTimeout(400);
  await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0 && window.__streamer.fading.size === 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);
};
const setErr = (e) => page.evaluate((e) => { window.__streamer.err = e; window.__streamer.dirty = true; }, e);
const shots = async (tag, n) => {
  const t0 = Date.now(), ts = [];
  for (let i = 0; i < n; i++) { await page.screenshot({ path: `${out}/${tag}_${String(i).padStart(2, '0')}.png` }); ts.push(Date.now() - t0); }
  return ts;
};
const log = {};
for (const [name, c] of Object.entries(CASES)) {
  await page.evaluate(([t, dir, d]) => {
    const T = window.__three, n = Math.hypot(...dir);
    window.__life.group.visible = false; T.P.fountains = false; T.nav.cancelFly?.();
    T.controls.target.set(...t);
    T.camera.position.set(t[0] + dir[0] / n * d, t[1] + dir[1] / n * d, t[2] + dir[2] / n * d);
    T.controls.update();
  }, [c.t, c.dir, c.d]);
  await setErr(0.25); await settle();
  const floor = await shots(`${name}_still`, 3);
  await setErr(3); // to the coarser tiles (they are cached: the swap starts at the next refresh)
  const down = await shots(`${name}_down`, 25);
  await settle();
  await setErr(0.25);
  const up = await shots(`${name}_up`, 25);
  await settle();
  log[name] = { floor, down, up };
  console.log(name, 'ms per shot ~', Math.round(down.at(-1) / down.length));
}
await page.evaluate(() => { window.__streamer.err = 3; });
fs.writeFileSync(`${out}/log.json`, JSON.stringify(log));
await browser.close();
