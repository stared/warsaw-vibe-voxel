// Where a frame's time goes: GPU time (timer queries) and CPU time of one composer.render, the triangles and draw calls,
// for the full frame and with one part removed at a time, at a few render sizes and pixel ratios.
// usage: node tools/probe.mjs http://localhost:5188 [view] [--swift] [--vp=1440x900]
import { chromium } from 'playwright-core';
const args = process.argv.slice(2), flags = args.filter((a) => a.startsWith('--')), [base, view = ''] = args.filter((a) => !a.startsWith('--'));
const swift = flags.includes('--swift'), [w, h] = (flags.find((f) => f.startsWith('--vp='))?.slice(5) ?? '1440x900').split('x').map(Number);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: swift ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window); window.__raf = raf; window.__pause = false;
  window.requestAnimationFrame = (cb) => raf((t) => (window.__pause ? window.requestAnimationFrame(cb) : cb(t)));
  let s = 1234567; Math.random = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); });
await page.goto(`${base}/?date=06-21&hour=16&weather=clear${view ? `&view=${view}` : ''}`);
await page.waitForFunction(() => window.__three && window.__ready && !document.body.classList.contains('loading'), null, { timeout: 900000, polling: 500 });
const setBudget = (p) => page.evaluate((p) => { const i = document.querySelector('#perf input'); i.value = String(p); i.dispatchEvent(new Event('input')); }, p);
const settle = () => page.waitForFunction(() => { const s = window.__streamer, c = window.__three.city(); return s.inflight === 0 && s.queue.length === 0 && c.settled; }, null, { timeout: 900000, polling: 500 }).then(() => page.waitForTimeout(3000));

const measure = () => page.evaluate(async () => {
  const T = window.__three, r = T.renderer, gl = r.getContext(), ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const S = window.__streamer, life = window.__life, post = T.post, passes = post.composer.passes;
  window.__pause = true;
  await new Promise((res) => setTimeout(res, 100));
  const meshes = (pred) => [...S.nodes.values()].filter((n) => n.mesh && pred(n)).map((n) => n.mesh);
  const parts = {
    life: () => { const g = life?.group; if (!g) return () => {}; const v = g.visible; g.visible = false; return () => { g.visible = v; }; },
    foliage: () => { const m = meshes((n) => n.foliage && n.mesh.visible); m.forEach((x) => { x.visible = false; }); return () => m.forEach((x) => { x.visible = true; }); },
    clay: () => { const m = meshes((n) => n.s === 8 && n.mesh.visible); m.forEach((x) => { x.visible = false; }); return () => m.forEach((x) => { x.visible = true; }); },
    buildings: () => { const m = meshes((n) => n.s === 1 && !n.foliage && n.mesh.visible); m.forEach((x) => { x.visible = false; }); return () => m.forEach((x) => { x.visible = true; }); },
    ao: () => { passes[1].enabled = false; return () => { passes[1].enabled = true; }; },
    bloom: () => { passes[2].enabled = false; return () => { passes[2].enabled = true; }; },
    tilt: () => { const e = passes[3].enabled; passes[3].enabled = false; return () => { passes[3].enabled = e; }; },
    sunShadowEveryFrame: null,
  };
  const frame = async (redraw) => {
    const q = gl.createQuery();
    if (redraw) T.daylight.redrawShadow();
    r.info.reset();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const c0 = performance.now();
    post.composer.render();
    const cpu = performance.now() - c0;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    const info = { tris: r.info.render.triangles, calls: r.info.render.calls };
    await new Promise((res) => window.__raf(res));
    for (let k = 0; k < 100 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((res) => setTimeout(res, 5));
    const gpu = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
    gl.deleteQuery(q);
    return { gpu, cpu, ...info };
  };
  const run = async (redraw = false) => {
    const fs = [];
    for (let i = 0; i < 4; i++) await frame(redraw);
    for (let i = 0; i < 12; i++) fs.push(await frame(redraw));
    const med = (k) => fs.map((f) => f[k]).sort((a, b) => a - b)[6];
    return { gpu: +med('gpu').toFixed(2), cpu: +med('cpu').toFixed(2), Mtris: +(med('tris') / 1e6).toFixed(2), calls: med('calls') };
  };
  const out = {};
  for (const ratio of [2, 1]) {
    r.setPixelRatio(ratio); post.composer.setSize(innerWidth, innerHeight);
    out[`full@${ratio}x`] = await run();
    out[`+sun shadow redraw@${ratio}x`] = await run(true);
    for (const [k, f] of Object.entries(parts)) { if (!f) continue; const undo = f(); out[`-${k}@${ratio}x`] = await run(); undo(); }
    const undos = Object.values(parts).filter(Boolean).map((f) => f());
    out[`bare (nothing above)@${ratio}x`] = await run();
    undos.reverse().forEach((u) => u());
  }
  let lt = 0;
  if (life) { const t0 = performance.now(); for (let i = 0; i < 30; i++) life.update(1 / 60, T.daylight.hour, T.daylight.night, T.controls.target); lt = (performance.now() - t0) / 30; }
  out.lifeUpdateCpuMs = +lt.toFixed(2);
  r.setPixelRatio(2); post.composer.setSize(innerWidth, innerHeight);
  window.__pause = false;
  return out;
});

for (const p of [1, 0.5, 0]) {
  await setBudget(p);
  await settle();
  const b = await page.evaluate(() => window.__three.budget());
  console.log(`== view ${view || 'default'} budget ${Number.isFinite(b) ? (b / 1e6).toFixed(2) + ' M' : 'whole'}`);
  const m = await measure();
  console.table(Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'object')));
  console.log('life.update CPU ms', m.lifeUpdateCpuMs);
}
await browser.close();
