import { chromium } from 'playwright-core';
const [cam, out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:5173/?ui=0&tilt=0&cam=${cam}`);
await page.waitForFunction(() => document.querySelector('.caption')?.classList.contains('off'), null, { timeout: 120000 });
await page.waitForTimeout(1000);
await page.screenshot({ path: out });
await browser.close();
