// Render the city from given camera poses, to set beside reference photos (tools/../scripts: photo comparison).
// usage: node tools/photoshot.mjs shots.json outdir    shots: [{id, pos:[x,y,z], yaw (deg, grid: 0 = -z, 90 = +x), pitch (deg), vfov, w, h, hour}]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [inp, out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const shots = JSON.parse(fs.readFileSync(inp, 'utf8'));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:5173/?ui=0&tilt=0&engine=full');
await page.waitForFunction(() => window.__ready === true && document.querySelector('.caption.off') && window.__life, null, { timeout: 120000 });
await page.waitForFunction(() => !document.querySelector('.caption') || document.querySelector('.caption .n').textContent.startsWith('1550 /'), null, { timeout: 120000 });
for (const s of shots) {
  await page.setViewportSize({ width: s.w, height: s.h });
  await page.evaluate((s) => {
    const T = window.__three; T.P.tilt = false; window.__life.group.visible = false;
    T.controls.maxPolarAngle = Math.PI * 0.97; T.controls.minDistance = 1;
    if (s.hour) T.applyTime(s.hour);
    const y = s.yaw * Math.PI / 180, p = s.pitch * Math.PI / 180, d = 400;
    T.camera.position.set(...s.pos);
    T.controls.target.set(s.pos[0] + Math.sin(y) * Math.cos(p) * d, s.pos[1] + Math.sin(p) * d, s.pos[2] - Math.cos(y) * Math.cos(p) * d);
    T.camera.fov = s.vfov; T.camera.updateProjectionMatrix(); T.controls.update();
  }, s);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/${s.id}.png` });
}
await browser.close();
