// A short film for social media, rendered frame by frame on a virtual clock: every frame advances the page exactly
// 1/FPS s (requestAnimationFrame and performance.now are the recorder's), so camera moves, people and fades run at
// true speed however slow 1080p rendering and screenshots are. The loading at the start is paced in wall time.
// usage: node tools/film.mjs <outdir> [stills]      (stills: first, middle and last frame of each shot only)
//   then: ffmpeg -framerate 30 -i <outdir>/f%04d.png -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -movflags +faststart film.mp4
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/film', mode = ''] = process.argv.slice(2);
const FPS = 30, W = +(process.env.W || 1920), H = +(process.env.H || 1080), stills = mode === 'stills';
fs.mkdirSync(out, { recursive: true });

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ease = (t) => t * t * (3 - 2 * t);
const path = (...k) => (t) => { // keyframes [pos, target], eased over the whole shot, linear between keys
  const s = ease(t) * (k.length - 1), i = Math.min(k.length - 2, Math.floor(s)), f = s - i;
  return [lerp(k[i][0], k[i + 1][0], f), lerp(k[i][1], k[i + 1][1], f)];
};
const orbit = (c, r, h, a0, a1) => (t) => { const a = (a0 + (a1 - a0) * ease(t)) * Math.PI / 180; return [[c[0] + r * Math.sin(a), h, c[2] + r * Math.cos(a)], c]; };

const SHOTS = JSON.parse(fs.readFileSync(process.env.FILM || new URL('./film.json', import.meta.url)));
const camOf = (s) => s.orbit ? orbit(...s.orbit) : path(...s.keys);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.addInitScript(() => {
  let vt = 0;
  const cbs = [];
  performance.now = () => vt;
  window.requestAnimationFrame = (cb) => cbs.push(cb);
  window.cancelAnimationFrame = () => {};
  const held = [], Real = window.Worker;
  window.__rate = Infinity; // tiles the mesher workers may hand back per frame: the loading paced by frames, not wall time
  window.Worker = class extends Real {
    set onmessage(fn) { super.onmessage = (e) => held.push(() => fn.call(this, e)); }
    get onmessage() { return super.onmessage; }
  };
  window.__vstep = (ms) => {
    vt += ms;
    for (const r of held.splice(0, Math.min(held.length, window.__rate))) r();
    for (const f of cbs.splice(0)) f(vt);
  };
});
const q = SHOTS.query;
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${q}`);
await page.addStyleTag({ content: '#bar, #hud { display: none !important; }' });
const step = (cam, ms = 1000 / FPS) => page.evaluate(([cam, ms]) => {
  const T = window.__three;
  if (cam && T.nav.mode === 'orbit') { T.camera.position.set(...cam[0]); T.controls.target.set(...cam[1]); T.controls.update(); }
  window.__vstep(ms);
}, [cam, ms]);

let n = 0;
const snap = async (keep = true) => { if (keep) await page.screenshot({ path: `${out}/f${String(n).padStart(4, '0')}.png` }); n++; };
const t0 = Date.now();
for (const [si, s] of SHOTS.shots.entries()) {
  if (si > +(process.env.LAST ?? 99)) break;
  const cam = camOf(s), frames = Math.round(s.sec * FPS);
  if (s.loading) { // the first shot: the page boots and loads while the camera moves, one frame per `wall` ms
    await page.waitForFunction(() => window.__three?.camera);
    await page.evaluate((r) => { window.__rate = r; }, s.rate);
  } else {
    for (let k = 0; k < (s.warm ?? 3) * FPS; k++) await step(cam(0)); // people walk, labels find their places
  }
  const mid = Math.floor(frames / 2);
  for (let f = 0; f < frames; f++) {
    const t = f / (frames - 1);
    if (s.ride && f === Math.round(s.ride.at * FPS) - 15) // where everyone is half a second before: who is walking
      await page.evaluate(() => { window.__was = new Map(window.__life.listOf('person').filter((o) => o.rp).map((o) => [o, [o.rp.x, o.rp.z]])); });
    if (s.ride && f === Math.round(s.ride.at * FPS)) {
      const r = await page.evaluate((R) => {
        const T = window.__three, L = window.__life;
        const cand = L.listOf('person').filter((o) => o.rp && Math.hypot(o.rp.x - R.near[0], o.rp.z - R.near[1]) < R.within && window.__was.has(o)
            && Math.hypot(o.rp.x - window.__was.get(o)[0], o.rp.z - window.__was.get(o)[1]) > 0.45)
          .map((o) => ({ o, h: L.pose('person', o).h })).filter(({ h }) => Math.abs(Math.atan2(Math.sin(h - R.heading), Math.cos(h - R.heading))) < 0.5)
          .sort((a, b) => Math.hypot(a.o.rp.x - R.near[0], a.o.rp.z - R.near[1]) - Math.hypot(b.o.rp.x - R.near[0], b.o.rp.z - R.near[1]));
        if (!cand.length) return null;
        T.nav.startRide({ kind: 'person', obj: cand[0].o, label: 'person' });
        return [cand[0].o.rp.x, cand[0].o.rp.z, cand.length];
      }, s.ride);
      console.log('ride', r);
    }
    await step(cam(t));
    if (s.loading) await page.waitForTimeout(40);
    if (s.loading && f % 15 === 0) console.log('frame', f, await page.evaluate(() => document.querySelector('.caption')?.textContent + (document.body.classList.contains('loading') ? '' : ' DONE')));
    await snap(!stills || f === 0 || f === mid || f === frames - 1 || (s.loading && f % 15 === 0));
  }
  if (s.loading) await page.evaluate(() => { window.__rate = Infinity; });
  console.log(`shot ${si} ${s.name}: ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (s.ride) await page.evaluate(() => { const T = window.__three; T.nav.cancelFly?.(); });
}
await browser.close();
