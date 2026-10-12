// frame sequence at a spot: node tools/seq.mjs x y label [warm] [frames] [step ms] [height]
import { chromium } from 'playwright-core';
const [x, y, label, warm = 45, n = 6, step = 1500, h = 70] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 440 } });
await page.goto('http://localhost:5173/?hour=16&ui=0&tilt=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
await page.waitForTimeout(+warm * 1000);
await page.evaluate(([x, y, h]) => { const { camera, controls } = window.__three; camera.position.set(+x - 8, +h, +y + 18); controls.target.set(+x, 17, +y); controls.update(); }, [x, y, h]);
for (let k = 0; k < +n; k++) { await page.waitForTimeout(+step); await page.screenshot({ path: `../data/qa/seq_${label}_${k}.png` }); }
await browser.close();
