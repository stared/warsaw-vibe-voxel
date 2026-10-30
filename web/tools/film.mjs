// A short film for social media, rendered frame by frame on a virtual clock: every frame advances the page exactly
// 1/FPS s (requestAnimationFrame and performance.now are the recorder's), so camera moves, people and fades run at
// true speed however slow 1080p rendering and screenshots are. The loading at the start is paced in wall time.
// usage: node tools/film.mjs <outdir> [stills]      (stills: first, middle and last frame of each shot only)
//   then: ffmpeg -framerate 30 -i <outdir>/f%04d.png -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -movflags +faststart film.mp4
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/film', mode = ''] = process.argv.slice(2);
const FPS = 30, W = +(process.env.W || 1280), H = +(process.env.H || 720), DPR = 1.5, stills = mode === 'stills'; // 1920 x 1080, the UI at 1.5x
fs.mkdirSync(out, { recursive: true });

const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ease = (t) => t * t * (3 - 2 * t);
const path = (...k) => (t) => { // keyframes [pos, target], eased over the whole shot, linear between keys
  const s = ease(t) * (k.length - 1), i = Math.min(k.length - 2, Math.floor(s)), f = s - i;
  return [lerp(k[i][0], k[i + 1][0], f), lerp(k[i][1], k[i + 1][1], f)];
};
const orbit = (c, r, h, a0, a1) => (t) => { const a = (a0 + (a1 - a0) * ease(t)) * Math.PI / 180; return [[c[0] + r * Math.sin(a), h, c[2] + r * Math.cos(a)], c]; };

const SHOTS = JSON.parse(fs.readFileSync(process.env.FILM || new URL('./film.json', import.meta.url)));
const spline = (K) => (sec) => { // timed waypoints [t, pos, target]: a cubic Hermite through them, one continuous move
  const T = K.map((k) => k[0]), last = K.length - 1, at = Math.min(Math.max(sec, T[0]), T[last]);
  let i = 0;
  while (i < last - 1 && at > T[i + 1]) i++;
  const h = T[i + 1] - T[i], u = (at - T[i]) / h;
  const tan = (j, c) => j === 0 || j === last ? K[j][c].map(() => 0) : K[j + 1][c].map((v, d) => (v - K[j - 1][c][d]) / (T[j + 1] - T[j - 1]));
  const herm = (c) => K[i][c].map((p0, d) => {
    const p1 = K[i + 1][c][d], m0 = tan(i, c)[d] * h, m1 = tan(i + 1, c)[d] * h;
    return (2 * u ** 3 - 3 * u ** 2 + 1) * p0 + (u ** 3 - 2 * u ** 2 + u) * m0 + (-2 * u ** 3 + 3 * u ** 2) * p1 + (u ** 3 - u ** 2) * m1;
  });
  return [herm(1), herm(2)];
};
const camOf = (s) => s.spline ? spline(s.spline) : s.orbit ? orbit(...s.orbit) : path(...s.keys);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.addInitScript((seed) => {
  let a = seed >>> 0; // a seeded Math.random: the same people in the same places on every render of a take
  Math.random = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
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
}, +(process.env.SEED || SHOTS.seed || 1));
const q = SHOTS.query;
await page.goto(`http://localhost:${process.env.PORT || 5173}/?${q}`);
await page.addStyleTag({ content: `body:not(.film-bar) #bar, body:not(.film-hud) #hud { display: none !important; }
  #film-fade { position: fixed; inset: 0; background: #000; opacity: 0; pointer-events: none; z-index: 99; }` });
await page.evaluate(() => { const d = document.createElement('div'); d.id = 'film-fade'; document.body.appendChild(d); });
const fade = (a) => page.evaluate((a) => { document.getElementById('film-fade').style.opacity = String(a); }, a);
const step = (cam, ms = 1000 / FPS) => page.evaluate(([cam, ms]) => {
  const T = window.__three;
  if (cam && T.nav.mode === 'orbit') { T.camera.position.set(...cam[0]); T.controls.target.set(...cam[1]); T.controls.update(); }
  window.__vstep(ms);
}, [cam, ms]);

let n = 0, loadT = 0, lmDone;
const snap = async (keep = true) => { if (keep) await page.screenshot({ path: `${out}/f${String(n).padStart(4, '0')}.png` }); n++; };
const t0 = Date.now();
for (const [si, s] of SHOTS.shots.entries()) {
  if (si > +(process.env.LAST ?? 99)) break;
  const cam = camOf(s), frames = Math.round(s.sec * FPS);
  await page.evaluate((ui) => { for (const k of ['bar', 'hud']) document.body.classList.toggle(`film-${k}`, ui.includes(k)); }, s.ui ?? []);
  if (s.loading) { // the first shot: the page boots and loads while the camera moves, one frame per `wall` ms
    await page.waitForFunction(() => window.__three?.camera);
    await page.evaluate((r) => { window.__rate = r; }, s.rate);
  } else {
    for (let k = 0; k < (s.warm ?? 3) * FPS; k++) await step(cam(0)); // people walk, labels find their places
  }
  const mid = Math.floor(frames / 2);
  for (let f = 0; f < frames; f++) {
    const hold = (s.hold ?? 0) * FPS; // the camera still for the first `hold` s
    let t = s.spline ? f / FPS : s.ride ? Math.min(1, f / (s.ride.at * FPS)) : Math.max(0, f - hold) / (frames - 1 - hold); // a ride's descent ends where the follow begins
    if (s.followLoading) { // the camera pulls back as the buildings arrive, ring by ring, after the landmarks
      const [stage, done] = await page.evaluate(() => { const c = document.querySelector('.caption'); return [c?.querySelector('.st')?.textContent ?? '', +(c?.querySelector('.n')?.textContent.split('/')[0] ?? 0)]; });
      if (stage.startsWith('Buildings')) lmDone ??= done;
      if (s.rates) await page.evaluate((r) => { window.__rate = r; }, s.rates[stage.split(' ')[0]] ?? s.rate); // each stage its own pace
      const goal = stage === 'Terrain' || stage === 'Landmarks' || lmDone === undefined ? 0 : stage === 'Foliage' || !stage ? 1 : Math.min(1, (done - lmDone) / (s.followLoading - lmDone));
      loadT += (goal - loadT) * 0.15;
      t = loadT;
    }
    for (const [at, how, code] of s.keys_ ?? []) if (f === Math.round(at * FPS)) await page.keyboard[how](code); // keys pressed in the shot
    const first = (s.keys_ ?? []).find((k) => k[2] === 'Space');
    if (s.ride?.face !== undefined && first && f === Math.round(first[0] * FPS) + 1) // possessed (the frame before): facing there
      await page.evaluate((y) => { window.__three.nav.yaw = y; }, s.ride.face);
    if (s.ride && f === Math.round(s.ride.at * FPS) - 15) // where everyone is half a second before: who is walking
      await page.evaluate(() => { window.__was = new Map(window.__life.listOf('person').filter((o) => o.rp).map((o) => [o, [o.rp.x, o.rp.z]])); });
    if (s.ride && f === Math.round(s.ride.at * FPS)) {
      const r = await page.evaluate((R) => {
        const T = window.__three, L = window.__life;
        let cand = [];
        for (const [k, tol] of [[1, 0.5], [2, 0.5], [3, 0.5], [3, 9]]) { // at last: anyone walking, turned round when possessed
          const within = R.within * k;
          cand = L.listOf('person').filter((o) => o.rp && Math.hypot(o.rp.x - R.near[0], o.rp.z - R.near[1]) < within && window.__was.has(o)
            && Math.hypot(o.rp.x - window.__was.get(o)[0], o.rp.z - window.__was.get(o)[1]) > (R.minStep ?? 0.45))
          .map((o) => ({ o, h: L.pose('person', o).h })).filter(({ h }) => Math.abs(Math.atan2(Math.sin(h - R.heading), Math.cos(h - R.heading))) < tol)
          .sort((a, b) => Math.hypot(a.o.rp.x - R.near[0], a.o.rp.z - R.near[1]) - Math.hypot(b.o.rp.x - R.near[0], b.o.rp.z - R.near[1]));
          if (cand.length) break;
        }
        if (!cand.length) return null;
        T.nav.startRide({ kind: 'person', obj: cand[0].o, label: 'person' });
        return [cand[0].o.rp.x, cand[0].o.rp.z, cand.length];
      }, s.ride);
      console.log('ride', r);
    }
    if (s.ride?.swing && f > Math.round(s.ride.at * FPS) && f < (s.ride.swingUntil ?? 1e9) * FPS) { // the camera swings round the walker: the follow moves on screen
      const k = (f - s.ride.at * FPS) / (Math.min(frames, (s.ride.swingUntil ?? 1e9) * FPS) - s.ride.at * FPS), [y0, y1] = s.ride.swing;
      await page.evaluate((y) => { const R = window.__three.nav.ride; if (R) R.dyaw = y; }, y0 + (y1 - y0) * ease(Math.min(1, k)));
    }
    const fi = s.fadeIn ?? 0.35, fo = s.fadeOut ?? 0.35, sec = f / FPS; // through black between the shots
    await fade(Math.max(fi > 0 ? 1 - sec / fi : 0, fo > 0 ? 1 - (s.sec - 1 / FPS - sec) / fo : 0, 0));
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
