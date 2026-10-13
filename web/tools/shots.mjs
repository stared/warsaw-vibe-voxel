import { chromium } from 'playwright-core';
import fs from 'node:fs';
const out = '/private/tmp/claude-501/shots'; fs.mkdirSync(out, { recursive: true });
const S = JSON.parse(process.argv[2]); const hour = process.argv[3] || 17.5;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://localhost:5173/?ui=0&tilt=0&hour=${hour}${process.env.Q ? "&" + process.env.Q : ""}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
for (const [k, [x, y, z, dx, dy, dz]] of Object.entries(S)) {
  await page.evaluate(([x, y, z, dx, dy, dz]) => { const T = window.__three; T.controls.target.set(x, y, z); T.camera.position.set(x + dx, y + dy, z + dz); T.controls.update(); }, [x, y, z, dx, dy, dz]);
  await page.waitForTimeout(500);
  await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${k}.png` });
}
await browser.close();
