// screenshots of hotspots after the sim has run: node tools/spots.mjs "x,y,label;x,y,label" [warmup s]
import { chromium } from 'playwright-core';
const [spots, warm = 40] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
await page.goto('http://localhost:5173/?hour=16&ui=0&tilt=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });
await page.waitForTimeout(+warm * 1000);
for (const sp of spots.split(';')) {
  const [x, y, label] = sp.split(',');
  await page.evaluate(([x, y]) => {
    const { camera, controls } = window.__three;
    camera.position.set(+x - 14, 95, +y + 26); controls.target.set(+x, 17, +y); controls.update();
  }, [x, y]);
  for (let k = 0; k < 3; k++) { await page.waitForTimeout(1200); await page.screenshot({ path: `../data/qa/${label}_${k}.png` }); }
}
await browser.close();
