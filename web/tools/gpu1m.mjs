// Frame time with the whole city drawn at 1 m (every level-1 tile shown, streamer frozen), from given views,
// against the normal streamed picture. Headless rAF is paced at 60 Hz, so frame intervals over 16.7 ms mean the
// GPU/CPU could not keep up; a 1-pixel readback each frame waits for the GPU to finish it. usage: node tools/gpu1m.mjs [views "overview,pkin"]
import { chromium } from 'playwright-core';
const [views = 'overview,pkin,skyline'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5173/?ui=0');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const frames = () => page.evaluate(() => new Promise((res) => { const ts = [], gl = window.__three.renderer.getContext(), px = new Uint8Array(4); const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); ts.push(performance.now()); if (ts.length < 120) requestAnimationFrame(f); else {
  const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b); res({ p50: d[d.length >> 1].toFixed(1), p90: d[Math.floor(d.length * 0.9)].toFixed(1) }); } }; requestAnimationFrame(f); }));
const go = (v) => page.evaluate((v) => { const T = window.__three, V = window.__meta?.views?.[v]; T.nav.cancelFly?.(); }, v);
for (const v of views.split(',')) {
  await page.evaluate((v) => { const T = window.__three; T.nav.cancelFly?.(); T.flyTo && null; }, v);
  await page.goto(`http://localhost:5173/?ui=0&view=${v}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
  await page.evaluate(() => window.__three.nav.cancelFly?.());
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const normal = await frames(), ntris = await page.evaluate(() => window.__streamer.tris);
  const tris = await page.evaluate(async () => {
    const S = window.__streamer, d = S.dims[1], ps = [];
    S.update = () => {};
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) ps.push(S.request(1, tx, ty, 1e9));
    S.pump(); await Promise.all(ps);
    let tris = 0;
    for (const n of S.nodes.values()) { if (!n.mesh) continue; n.mesh.visible = n.s === 1; if (n.s === 1) tris += n.tris; }
    return tris;
  });
  await page.waitForTimeout(1500);
  const all = await frames();
  console.log(`${v}: streamed ${(ntris / 1e6).toFixed(1)} M tris frame ms p50/p90 ${normal.p50}/${normal.p90} | all 1 m ${(tris / 1e6).toFixed(1)} M tris ${all.p50}/${all.p90}`);
}
await browser.close();
