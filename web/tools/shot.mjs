// usage: node shot.mjs out.png [query] [w] [h]
import { chromium } from 'playwright-core';
const [out = 'shot.png', q = '', w = 1600, h = 1000] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) console.log('[http]', r.status(), r.url()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
const t0 = Date.now();
await page.goto(`${process.env.URL || "http://localhost:5173/"}?${q}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: +(process.env.TMO || 180000) });
console.log('ready in', Date.now() - t0, 'ms', await page.textContent('#stats'));
if (process.env.EXPR) console.log('expr:', JSON.stringify(await page.evaluate(process.env.EXPR)));
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
await browser.close();
