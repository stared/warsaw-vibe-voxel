// Search box: type, screenshot the suggestions, pick one, screenshot the result. usage: node tools/searchtest.mjs outdir query...
import { chromium } from 'playwright-core';
const [out = '/tmp', ...qs] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/?hour=16');
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(1500);
for (const [i, q] of qs.entries()) {
  await page.fill('.search input', '');
  await page.type('.search input', q, { delay: 30 });
  await page.waitForTimeout(300);
  console.log(q, '→', await page.$$eval('.search li', (ls) => ls.map((l) => l.textContent)));
  await page.screenshot({ path: `${out}/search${i}a.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/search${i}b.png` });
}
console.log('errors', errs);
await browser.close();
