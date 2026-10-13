// Main-thread long tasks (> 50 ms) through a typical session: load, view flights, street level, a ride, fly up.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => { window.__lt = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration), window.__phase || 'load']); }).observe({ type: 'longtask', buffered: true }); });
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 300000 });
await page.waitForTimeout(3000);
const phase = (p) => page.evaluate((p) => { window.__phase = p; }, p);
await phase('views'); for (const k of ['Digit2', 'Digit8', 'Digit9', 'Digit1']) { await page.keyboard.press(k); await page.waitForTimeout(2500); }
await phase('walk'); await page.click('#hud .walker'); await page.waitForTimeout(3000);
await phase('walk-click'); await page.mouse.click(640, 600); await page.waitForTimeout(2000);
await phase('ride'); await page.evaluate(() => { const L = window.__life, n = window.__three.nav; const tr = L.trams.find((t) => t.rp); n.startRide({ kind: 'tram', obj: tr, label: 'tram' }); }); await page.waitForTimeout(3000);
await phase('flyup'); await page.keyboard.press('Escape'); await page.waitForTimeout(500); await page.keyboard.press('Escape'); await page.waitForTimeout(3000);
const lt = await page.evaluate(() => window.__lt);
const by = {}; for (const [t, d, p] of lt) (by[p] ||= []).push(d);
console.log(JSON.stringify(Object.fromEntries(Object.entries(by).map(([p, a]) => [p, { n: a.length, max: Math.max(...a), total: a.reduce((x, y) => x + y, 0) }]))));
await browser.close();
