import { chromium } from 'playwright-core';
import fs from 'node:fs';
const P = JSON.parse(fs.readFileSync('/private/tmp/claude-501/street.json')); const out = '/private/tmp/claude-501/street'; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/?ui=0&hour=16.5');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 300000 });
for (const [k, [x, z]] of Object.entries(P)) {
  await page.evaluate(([x, z]) => { const T = window.__three; T.nav.setMode('orbit'); T.controls.target.set(x, 30, z); T.camera.position.set(x - 200, 220, z + 200); T.controls.update(); T.nav.setMode('walk', { at: new (T.camera.position.constructor)(x, 30, z) }); }, [x, z]);
  await page.waitForTimeout(2500);
  await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/${k}.png` });
}
console.log('errors', errs);
await browser.close();
