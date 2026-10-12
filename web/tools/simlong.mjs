import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto('http://localhost:5173/?hour=17&ui=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
for (let i = 0; i < 8; i++) {
  await page.waitForTimeout(15000);
  console.log(JSON.stringify(await page.evaluate(() => {
    const L = window.__life, v = L.cars.map((c) => c.v);
    // cars stopped for long: track via age of stop
    L.cars.forEach((c) => { c.stopT = c.v < 0.3 ? (c.stopT || 0) + 15 : 0; });
    const stuck = L.cars.filter((c) => c.stopT >= 60).length;
    const fps = L._fps;
    return { t: Math.round(L.t), cars: L.cars.length, meanV: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), stopped: v.filter((x) => x < 0.3).length, stuck60s: stuck, people: L.people.length, waiting: L.people.filter((p) => p.wait).length };
  })));
}
await browser.close();
