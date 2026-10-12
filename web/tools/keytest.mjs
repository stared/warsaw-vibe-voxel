import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/?view=zlota&ui=0');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
const cam = () => page.evaluate(() => { const c = window.__three.camera.position, t = window.__three.controls.target; return [c.x, c.y, c.z, t.x, t.z].map((v) => +v.toFixed(1)); });
await page.mouse.click(500, 350);
const a = await cam();
for (const [key, ms] of [['w', 1000], ['d', 500], ['e', 500]]) { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); console.log(key, await cam()); }
console.log('start', a, 'errors', errs);
await page.screenshot({ path: '../data/debug/keytest.png' });
await browser.close();
