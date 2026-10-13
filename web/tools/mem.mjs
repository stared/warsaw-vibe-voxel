// Memory + frame-cost probe over a short camera tour: JS heap, GPU-side bytes (geometry + textures), process RSS.
// usage: node tools/mem.mjs [label]   (dev server on :5173)
import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
const label = process.argv[2] || 'run';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const bcdp = await browser.newBrowserCDPSession();
await page.goto('http://localhost:5173/' + (process.argv[3] || ''));
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(3000);
const pids = async () => (await bcdp.send('SystemInfo.getProcessInfo')).processInfo.map((p) => p.id);
const rss = async () => { const ps = await pids(); let kb = 0; for (const p of ps) { try { kb += +execSync(`ps -o rss= -p ${p}`).toString().trim(); } catch {} } return Math.round(kb / 1024); };
const probe = () => page.evaluate(() => {
  const { renderer, scene } = window.__three; let geo = 0, tris = 0, meshes = 0; const seen = new Set();
  scene.traverse((o) => { if (!o.isMesh || !o.geometry || seen.has(o.geometry)) return; seen.add(o.geometry); meshes++;
    if (o.userData.bytes) geo += o.userData.bytes; else { for (const a of Object.values(o.geometry.attributes)) geo += a.array ? a.array.byteLength : 0; if (o.geometry.index?.array) geo += o.geometry.index.array.byteLength; }
    if (o.geometry.index) tris += o.geometry.index.count / 3; });
  const i = renderer.info; const S = window.__streamer?.stats(); return { shownM: S ? +(S.tris / 1e6).toFixed(2) : null, cacheMB: S ? S.geoMB + S.dataMB : null, heapMB: Math.round(performance.memory.usedJSHeapSize / 2 ** 20), geoMB: Math.round(geo / 2 ** 20), tris: Math.round(tris), meshes, textures: i.memory.textures, calls: i.render.calls };
});
const tour = [['overview', null], ['pkin', null], ['station', null], ['skyline', null], ['vistula', null], ['stadium', null]];
const out = [];
for (const [v] of tour) {
  await page.evaluate((v) => { const T = window.__three; const V = window.__views?.[v]; }, v);
  await page.keyboard.press(`Digit${{ overview: 1, pkin: 2, station: 6, skyline: 7, vistula: 8, stadium: 9 }[v]}`); await page.waitForTimeout(+(process.env.WAIT || 4000));
  const p = await probe();
  const f = await page.evaluate(async () => { const ts = []; let l = performance.now(); for (let k = 0; k < 40; k++) { await new Promise(requestAnimationFrame); const n = performance.now(); ts.push(n - l); l = n; } ts.sort((a, b) => a - b); return +ts[20].toFixed(1); });
  out.push({ view: v, ...p, frameMs: f, rssMB: await rss() });
}
console.log(label); console.table(out);
await browser.close();
