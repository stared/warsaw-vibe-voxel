import { chromium } from 'playwright-core';
const [q = '', expr = '1'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.goto(`http://localhost:5173/?${q}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(500);
console.log(JSON.stringify(await page.evaluate(expr), null, 1));
await browser.close();
