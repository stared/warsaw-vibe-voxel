// What full 1 m detail costs: mesh every level-1 tile once (triangles, GPU bytes, column-data bytes, mesh ms) and
// write the table; tools/costviews.mjs uses it to price views and squares. usage: node tools/cost1m.mjs <out.json>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/cost1m.json'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5173/?ui=0');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
const res = await page.evaluate(async () => {
  const S = window.__streamer, d = S.dims[1], rows = [];
  S.update = () => {}; // freeze the streamer: we drive it
  for (let ty = 0; ty < d.ny; ty++) {
    const ps = [];
    for (let tx = 0; tx < d.nx; tx++) ps.push(S.request(1, tx, ty, 1e9, true));
    S.pump(); await Promise.all(ps);
    for (let tx = 0; tx < d.nx; tx++) {
      const n = S.nodes.get(S.key(1, tx, ty));
      const dataB = n.data ? n.data.counts.byteLength + n.data.ground.byteLength + n.data.runs.byteLength + n.data.off.byteLength : 0;
      rows.push({ tx, ty, tris: n.tris || 0, bytes: (n.bytes || 0) - dataB, dataB });
      S.free(n);
    }
  }
  return { rows, timing: S.timing };
});
fs.writeFileSync(out, JSON.stringify(res));
const R = res.rows, sum = (k) => R.reduce((a, r) => a + r[k], 0);
console.log(`tiles ${R.length}  tris ${(sum('tris') / 1e6).toFixed(1)} M  gpu ${(sum('bytes') / 2 ** 20).toFixed(0)} MB  data ${(sum('dataB') / 2 ** 20).toFixed(0)} MB`);
const t = R.map((r) => r.tris).sort((a, b) => a - b);
console.log('tris per tile p50', t[t.length >> 1], 'p90', t[Math.floor(t.length * 0.9)], 'max', t.at(-1), ' bytes/tri', (sum('bytes') / sum('tris')).toFixed(0));
const ms = res.timing.filter((x) => x[0] === 1).map((x) => x[1] + x[2]).sort((a, b) => a - b);
console.log('fetch+mesh ms per tile p50', ms[ms.length >> 1], 'p90', ms[Math.floor(ms.length * 0.9)]);
await browser.close();
