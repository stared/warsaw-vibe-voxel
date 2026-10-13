// Persistent browser you can drive step by step over HTTP — used for persona play-tests.
// usage: node tools/drive.mjs <port> <url> <outdir> [w] [h] [touch]
//   curl -s localhost:<port> -d '[{"a":"click","x":600,"y":400}]'   -> runs actions, waits, saves a screenshot, prints its path
// actions (all coordinates in CSS px):
//   {a:"move",x,y}  {a:"click",x,y,button?,count?}  {a:"drag",x,y,x2,y2,button?,ms?,mods?:["Shift"]}
//   {a:"wheel",x,y,dy,ctrl?}  (ctrl:true = trackpad pinch)   {a:"key",key:"KeyW",ms?}  {a:"type",text}
//   {a:"tap",x,y}  {a:"touchdrag",x,y,x2,y2,ms?}  {a:"pinch",x,y,from,to,ms?}  (two fingers, distance from->to)
//   {a:"twist",x,y,deg,ms?}  (two fingers rotate)   {a:"twodrag",x,y,dx,dy,ms?}  (two fingers move together)
//   {a:"wait",ms}   top-level {"wait":ms} after the batch (default 700)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
const [port = 9301, url = 'http://localhost:5173/', out = 'drive', w = 1280, h = 800, touch] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const isTouch = touch === 'touch';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, hasTouch: isTouch, isMobile: isTouch, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
const log = fs.createWriteStream(`${out}/state.log`, { flags: 'a' });
page.on('pageerror', (e) => log.write(`pageerror ${e.message}\n`));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
await page.waitForTimeout(1500);
let n = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const touches = async (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) });
async function gesture(ms, frame) { // frame(t in 0..1) -> list of points
  const N = Math.max(6, Math.round(ms / 16));
  await touches('touchStart', frame(0));
  for (let i = 1; i <= N; i++) { await touches('touchMove', frame(i / N)); await sleep(ms / N); }
  await touches('touchEnd', []);
}
async function run(A) {
  const m = page.mouse;
  switch (A.a) {
    case 'move': await m.move(A.x, A.y, { steps: 5 }); break;
    case 'click': await m.click(A.x, A.y, { button: A.button || 'left', clickCount: A.count || 1 }); if ((A.count || 1) > 1) await page.dispatchEvent('canvas', 'dblclick', { clientX: A.x, clientY: A.y, bubbles: true }).catch(() => {}); break;
    case 'drag': {
      for (const k of A.mods || []) await page.keyboard.down(k);
      await m.move(A.x, A.y); await m.down({ button: A.button || 'left' });
      const N = Math.max(8, Math.round((A.ms || 500) / 16));
      for (let i = 1; i <= N; i++) { await m.move(A.x + (A.x2 - A.x) * i / N, A.y + (A.y2 - A.y) * i / N); await sleep((A.ms || 500) / N); }
      await m.up({ button: A.button || 'left' });
      for (const k of A.mods || []) await page.keyboard.up(k);
      break;
    }
    case 'wheel': {
      await m.move(A.x, A.y);
      const steps = Math.max(1, Math.round(Math.abs(A.dy) / 100)), s = A.dy / steps;
      for (let i = 0; i < steps; i++) { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: A.x, y: A.y, deltaX: 0, deltaY: s, modifiers: A.ctrl ? 2 : 0 }); await sleep(30); }
      break;
    }
    case 'key': if (A.ms) { await page.keyboard.down(A.key); await sleep(A.ms); await page.keyboard.up(A.key); } else await page.keyboard.press(A.key); break;
    case 'type': await page.keyboard.type(A.text, { delay: 40 }); break;
    case 'tap': await page.touchscreen.tap(A.x, A.y); break;
    case 'touchdrag': await gesture(A.ms || 400, (t) => [[A.x + (A.x2 - A.x) * t, A.y + (A.y2 - A.y) * t]]); break;
    case 'pinch': await gesture(A.ms || 500, (t) => { const d = (A.from + (A.to - A.from) * t) / 2; return [[A.x - d, A.y], [A.x + d, A.y]]; }); break;
    case 'twist': await gesture(A.ms || 500, (t) => { const r = 80, a = (A.deg * t) * Math.PI / 180; return [[A.x - r * Math.cos(a), A.y - r * Math.sin(a)], [A.x + r * Math.cos(a), A.y + r * Math.sin(a)]]; }); break;
    case 'twodrag': await gesture(A.ms || 500, (t) => [[A.x - 60 + A.dx * t, A.y + A.dy * t], [A.x + 60 + A.dx * t, A.y + A.dy * t]]); break;
    case 'wait': await sleep(A.ms || 500); break;
  }
}
http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  try {
    let j = body ? JSON.parse(body) : [];
    const wait = Array.isArray(j) ? 700 : (j.wait ?? 700);
    const acts = Array.isArray(j) ? j : j.actions || [];
    for (const A of acts) await run(A);
    await sleep(wait);
    const p = `${out}/${String(++n).padStart(3, '0')}.png`;
    await page.screenshot({ path: p });
    // hidden ground truth for the experimenter (personas must not read this file)
    const st = await page.evaluate(() => { const T = window.__three; if (!T) return null; return { cam: T.camera.position.toArray().map((v) => +v.toFixed(1)), tgt: T.controls.target.toArray().map((v) => +v.toFixed(1)), mode: T.nav.mode, ride: T.nav.ride ? T.nav.ride.kind : null }; }).catch(() => null);
    log.write(`${n} ${JSON.stringify(acts)} -> ${JSON.stringify(st)}\n`);
    res.end(p + '\n');
  } catch (e) { res.statusCode = 500; res.end(String(e) + '\n'); }
}).listen(+port, () => console.log(`drive ready on ${port}`));
