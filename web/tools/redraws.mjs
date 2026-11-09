// How often the city's shadow map is redrawn (and what each redraw draws), while loading, then while the visitor
// rotates, zooms, pans, and sits still.
// usage: node tools/redraws.mjs http://localhost:5188
import { chromium } from 'playwright-core';
const [base] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${base}/?date=06-21&hour=16&weather=clear`);
await page.waitForFunction(() => window.__three?.daylight?.gate, null, { timeout: 60000, polling: 50 });
await page.evaluate(() => {
  const d = window.__three.daylight, g = d.gate, f = g.onBeforeShadow, r = window.__three.renderer;
  window.__redraws = [];
  g.onBeforeShadow = function (a, b, c, cam, ...rest) { if (cam === d.sun.shadow.camera) window.__redraws.push(performance.now()); return f.call(this, a, b, c, cam, ...rest); };
});
const t0 = await page.evaluate(() => performance.now());
await page.waitForFunction(() => !document.body.classList.contains('loading'), null, { timeout: 900000, polling: 250 });
const span = async (label, act) => {
  const a = await page.evaluate(() => [performance.now(), window.__redraws.length]);
  await act();
  const b = await page.evaluate(() => [performance.now(), window.__redraws.length]);
  console.log(label.padEnd(26), `${b[1] - a[1]} redraws in ${((b[0] - a[0]) / 1000).toFixed(1)} s`);
};
console.log('loading'.padEnd(26), `${await page.evaluate(() => window.__redraws.length)} redraws in ${((await page.evaluate(() => performance.now()) - t0) / 1000).toFixed(1)} s`);
await span('after load, growing 20 s', () => page.waitForTimeout(20000));
await span('still 5 s', () => page.waitForTimeout(5000));
const cx = 720, cy = 450;
await span('rotate 5 s', async () => { await page.mouse.move(cx, cy); await page.mouse.down(); for (let i = 0; i < 100; i++) { await page.mouse.move(cx + i * 4, cy); await page.waitForTimeout(50); } await page.mouse.up(); });
await span('zoom 5 s', async () => { await page.mouse.move(cx, cy); for (let i = 0; i < 50; i++) { await page.mouse.wheel(0, i < 25 ? -40 : 40); await page.waitForTimeout(100); } });
await span('pan 5 s', async () => { await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' }); for (let i = 0; i < 100; i++) { await page.mouse.move(cx + i * 3, cy + i); await page.waitForTimeout(50); } await page.mouse.up({ button: 'right' }); });
await span('still 5 s', () => page.waitForTimeout(5000));
await browser.close();
