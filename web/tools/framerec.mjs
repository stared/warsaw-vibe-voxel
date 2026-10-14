// Every rendered frame of a wheel zoom, as the page draws it (~60 fps, not screenshots ~10 fps): after each frame a
// 480 x 300 copy of the canvas and which tiles became visible / hidden in it. Frame-to-frame change is then small
// for camera motion and jumps where the picture swaps (tools/framerec.py finds and shows those).
// usage: node tools/framerec.mjs <outdir> [spots "home,1,2"] [wheel ms between notches, default 120] [notches 25]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/framerec', spots = 'home', gap = '120', notches = '25'] = process.argv.slice(2);
const port = process.env.PORT || 5173;
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(7000);
const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (const spot of spots.split(',')) {
  if (spot !== 'home') { // same random place as tools/zoomrec.mjs
    const r = rng(+spot * 7919 + 17); r();
    const t = [300 + r() * 3350, 0, 300 + r() * 2550], az = r() * 2 * Math.PI, el = 0.45 + r() * 0.5, d = 1400 + r() * 900;
    await page.evaluate(([t, az, el, d]) => { const T = window.__three; T.nav.cancelFly?.(); T.controls.target.set(...t);
      T.camera.position.set(t[0] + Math.cos(el) * Math.sin(az) * d, Math.sin(el) * d, t[2] + Math.cos(el) * Math.cos(az) * d); T.controls.update(); }, [t, az, el, d]);
    await page.waitForTimeout(500);
    await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => { // start recording: a rAF callback registered after the app's runs right after its render
    const c = document.createElement('canvas'); c.width = 480; c.height = 300;
    const g = c.getContext('2d', { willReadFrequently: true });
    const src = window.__three.renderer.domElement, S = window.__streamer;
    const rec = window.__rec = { frames: [], on: true };
    let prev = new Set();
    const tick = (t) => {
      if (!rec.on) return;
      g.drawImage(src, 0, 0, 480, 300);
      const px = g.getImageData(0, 0, 480, 300).data, lum = new Uint8Array(480 * 300);
      for (let i = 0; i < lum.length; i++) lum[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      const vis = new Set(); for (const n of S.nodes.values()) if (n.mesh?.visible) vis.add(n.key);
      const shown = [...vis].filter((k) => !prev.has(k)), hidden = [...prev].filter((k) => !vis.has(k));
      prev = vis;
      const T = window.__three;
      rec.frames.push({ t: Math.round(t), lum, shown, hidden, d: Math.round(T.camera.position.distanceTo(T.controls.target)) });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.mouse.move(520, 420);
  for (const [dy, n] of [[-100, +notches], [0, 8], [100, +notches], [0, 8]]) for (let k = 0; k < n; k++) { if (dy) await page.mouse.wheel(0, dy); await page.waitForTimeout(+gap); }
  await page.evaluate(() => { window.__rec.on = false; });
  const n = await page.evaluate(() => window.__rec.frames.length);
  const meta = [];
  const bin = fs.openSync(`${out}/${spot}.lum`, 'w');
  for (let i = 0; i < n; i += 50) {
    const chunk = await page.evaluate(([a, b]) => window.__rec.frames.slice(a, b).map((f) => ({ ...f, lum: Array.from(f.lum) })), [i, i + 50]);
    for (const f of chunk) { fs.writeSync(bin, Buffer.from(Uint8Array.from(f.lum))); meta.push({ t: f.t, d: f.d, shown: f.shown, hidden: f.hidden }); }
  }
  fs.closeSync(bin);
  fs.writeFileSync(`${out}/${spot}.json`, JSON.stringify(meta));
  console.log(spot, n, 'frames', ((meta.at(-1).t - meta[0].t) / n).toFixed(1), 'ms/frame');
}
await browser.close();
