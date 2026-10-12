import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
await page.goto('http://localhost:5173/?hour=17&ui=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
await page.evaluate(() => { setInterval(() => { for (const c of window.__life.cars) c.stuckT = c.v < 0.3 ? (c.stuckT || 0) + 1 : 0; }, 1000); });
await page.waitForTimeout(+(process.argv[2] || 100) * 1000);
console.log(JSON.stringify(await page.evaluate(() => {
  const L = window.__life, roots = {};
  const d = (c) => `e${c.e} s${c.s.toFixed(1)}/${L.roads[c.e].L.toFixed(0)} lane${c.lane}/${L.roads[c.e].lanes} next${c.next} why:${c.why} box${c.boxNode} v${c.v.toFixed(1)}`;
  for (const c of L.cars.filter((c) => c.stuckT > 40)) {
    let x = c, path = [], seen = new Set();
    while (x && x.why === 'spatial' && x.block && !seen.has(x)) { seen.add(x); path.push(x); x = x.block.o; }
    let root = x ? d(x) + (seen.has(x) ? ' (CYCLE)' : '') : 'none';
    if (x && x.why === 'box-busy') {
      const n = L.roads[x.e].b, hs = [...(L.box.get(n) || [])];
      root += ' || holders@' + n + ': ' + hs.map((h) => d(h) + ' inCars:' + L.cars.includes(h) + ' stuck' + (h.stuckT || 0) + ' from' + h.boxFrom).join(' ; ');
    }
    roots[root] = (roots[root] || 0) + 1;
  }
  return Object.entries(roots).sort((a, b) => b[1] - a[1]).slice(0, 10);
}), null, 1));
await browser.close();
