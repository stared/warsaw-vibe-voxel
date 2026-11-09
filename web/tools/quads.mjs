// What the foliage and building quads are: by facing (top, side, bottom), by size (1x1 cells or merged), by height.
// usage: node tools/quads.mjs http://localhost:5188
import { chromium } from 'playwright-core';
const [base] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.route('**/src/stream.ts*', async (route) => {
  const r = await route.fetch();
  await route.fulfill({ response: r, body: (await r.text()).replace('.onUpload(releaseArray)', '.onUpload(() => {})') });
});
await page.goto(`${base}/?date=06-21&hour=16&weather=clear`);
await page.waitForFunction(() => window.__three && window.__ready && !document.body.classList.contains('loading'), null, { timeout: 900000, polling: 500 });
await page.waitForTimeout(3000);
console.log(JSON.stringify(await page.evaluate(() => {
  const res = {};
  for (const n of window.__streamer.nodes.values()) {
    if (!n.mesh || n.s !== 1) continue;
    const k = n.foliage ? 'foliage' : 'buildings', g = n.mesh.geometry, P = g.attributes.position.array, A = g.attributes.vattr.array;
    const nq = Math.min(g.drawRange.count, g.index.count) / 6;
    const r = (res[k] ??= { quads: 0, top: 0, bottom: 0, side: 0, unit: 0, unitTop: 0, low: 0, tiles: 0 });
    r.tiles++;
    for (let q = 0; q < nq; q++) {
      const v = q * 4, nrm = A[v * 4] & 7, d = nrm >> 1;
      const xs = [0, 1, 2, 3].map((c) => P[(v + c) * 3]), ys = [0, 1, 2, 3].map((c) => P[(v + c) * 3 + 1]), zs = [0, 1, 2, 3].map((c) => P[(v + c) * 3 + 2]);
      const ex = Math.max(...xs) - Math.min(...xs), ey = Math.max(...ys) - Math.min(...ys), ez = Math.max(...zs) - Math.min(...zs);
      const area = [ex, ey, ez].filter((e) => e > 0).reduce((a, b) => a * b, 1);
      r.quads++;
      if (d === 2) { (nrm & 1) ? r.top++ : r.bottom++; } else r.side++;
      if (area <= 1) { r.unit++; if (d === 2 && (nrm & 1)) r.unitTop++; }
      if (Math.max(...ys) <= Math.min(...ys) + 1 && Math.min(...ys) < 200) r.low++;
    }
  }
  return res;
})));
await browser.close();
