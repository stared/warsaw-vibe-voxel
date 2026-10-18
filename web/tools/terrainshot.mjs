// The terrain-only first moment: tile files are held back, so only terrain.bin shows. usage: node tools/terrainshot.mjs out.jpg [url-suffix]
import { chromium } from 'playwright-core';
const [out, q = ''] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.route(/\/tiles\//, () => {}); // never answered
await page.goto(`http://localhost:5173/${q}`);
await page.waitForSelector('#loading.hidden', { state: 'attached', timeout: 30000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: out, quality: 85 });
await browser.close();
