// Flow over time + root causes of stuck cars, following car.by (who blocks me) to the end of each chain.
// usage: node tools/roots.mjs [secs=180] [sim=''] [hour=17]
import { chromium } from 'playwright-core';
const [secs = 180, sim = '', hour = 17] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
await page.goto(`http://localhost:5173/?hour=${hour}&ui=0&sim=${sim}`);
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
await page.evaluate(() => { setInterval(() => { for (const c of window.__life.cars) c.stuckT = c.v < 0.3 ? (c.stuckT || 0) + 1 : 0; }, 1000); });
for (let t = 30; t <= +secs; t += 30) {
  await page.waitForTimeout(30000);
  console.log(JSON.stringify(await page.evaluate(() => {
    const L = window.__life, v = L.cars.map((c) => c.v);
    return { t: Math.round(L.t), cars: L.cars.length, meanV: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), stuck60: L.cars.filter((c) => c.stuckT > 60).length, assertive: L.nAssert || 0, breaks: L.nBreak || 0 };
  })));
}
console.log(JSON.stringify(await page.evaluate(() => {
  const L = window.__life, why = {}, roots = {}, cycles = {}, rootCars = new Map();
  const tag = (y) => (L.trams.includes(y) ? 'TRAM:' : '') + y.why;
  const stuck = L.cars.filter((c) => c.stuckT > 40);
  for (const c of stuck) {
    why[c.why] = (why[c.why] || 0) + 1;
    let x = c; const seen = [];
    while (x && x.by && !seen.includes(x)) { seen.push(x); x = x.by; }
    if (x && seen.includes(x)) { // cycle: name it by the reasons along the loop
      const loop = [...new Set(seen.slice(seen.indexOf(x)).map(tag))].sort().join(' + ');
      cycles[loop] = (cycles[loop] || 0) + 1;
      rootCars.set(x, 'cycle');
    } else {
      const isT = L.trams.includes(x);
      const k = tag(x) + (isT || L.cars.includes(x) ? '' : ' (GONE)') + ((isT ? x.v < 0.3 : x.stuckT > 40) ? '' : ' (moving)');
      roots[k] = (roots[k] || 0) + 1;
      rootCars.set(x, k);
    }
  }
  const sample = [...rootCars].slice(0, 16).map(([x, k]) => {
    if (L.trams.includes(x)) return `${k}: tram ${L.tramPaths[x.p].ref} s${x.s.toFixed(0)} v${x.v.toFixed(1)} why:${x.why} by:${x.by ? (L.trams.includes(x.by) ? 'tram' : 'car e' + x.by.e + '/' + x.by.why + ' v' + x.by.v.toFixed(1)) : '-'}`;
    const e = L.roads[x.e];
    return `${k}: e${x.e} s${x.s.toFixed(1)}/${e.L.toFixed(0)} lane${x.lane}/${e.lanes} next${x.next} turn${x.boxTurn} box${x.boxNode} why:${x.why} by:${x.by ? 'e' + x.by.e + '/' + x.by.why : '-'} v${x.v.toFixed(1)}`;
  });
  return { stuck: stuck.length, why, roots, cycles, sample };
}), null, 1));
await browser.close();
