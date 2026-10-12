import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
await page.goto('http://localhost:5173/?hour=17&ui=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
await page.evaluate(() => { setInterval(() => { for (const c of window.__life.cars) c.stuckT = c.v < 0.3 ? (c.stuckT || 0) + 1 : 0; }, 1000); });
await page.waitForTimeout(+(process.argv[2] || 100) * 1000);
console.log(JSON.stringify(await page.evaluate(() => {
  const L = window.__life, st = L.cars.filter((c) => c.stuckT > 40);
  const byWhy = {}, byEdge = {};
  for (const c of st) { byWhy[c.why] = (byWhy[c.why] || 0) + 1; const k = c.e + ':' + c.why; byEdge[k] = (byEdge[k] || 0) + 1; }
  const top = Object.entries(byEdge).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, n]) => { const [e] = k.split(':'); const r = L.roads[+e]; return [k, n, r.p[r.p.length - 1].slice(0, 2), r.L, r.lanes, r.c]; });
  const sp = st.filter((c) => c.why === 'spatial').slice(0, 10).map((c) => { const b = c.block?.o; return { e: c.e, s: +c.s.toFixed(1), lane: c.lane, off: +c.off.toFixed(2), lc: c.lcTo, next: c.next, box: c.boxNode, gap: c.block ? +c.block.gap.toFixed(2) : null, B: b ? { e: b.e, s: +b.s.toFixed(1), lane: b.lane, off: +b.off.toFixed(2), lc: b.lcTo, why: b.why, v: +b.v.toFixed(2), wait: +b.wait.toFixed(1), next: b.next } : null }; });
  return { stuck: st.length, cars: L.cars.length, byWhy, top: top.slice(0, 4), sp };
}), null, 1));
await browser.close();
