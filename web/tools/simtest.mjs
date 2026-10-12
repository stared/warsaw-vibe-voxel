// runs the page, lets the simulation run, reports stats + screenshot of a signalled junction
import { chromium } from 'playwright-core';
const [out = '../data/debug/sim.png', q = 'hour=17&ui=0&tilt=0', wait = 20000] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://localhost:5173/?${q}`);
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
const stats = async () => page.evaluate(() => {
  const L = window.__life;
  const cars = L.cars, v = cars.map((c) => c.v);
  const stopped = v.filter((x) => x < 0.3).length;
  const waiting = L.people.filter((p) => p.wait).length;
  return { t: +L.t.toFixed(1), cars: cars.length, meanV: +(v.reduce((a, b) => a + b, 0) / (v.length || 1)).toFixed(2), stopped, people: L.people.length, waitingAtCrossings: waiting };
});
console.log(await stats());
await page.waitForTimeout(+wait);
console.log(await stats());
await page.screenshot({ path: out });
console.log('errors', errs.slice(0, 5));
await browser.close();
