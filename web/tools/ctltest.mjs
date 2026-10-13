// Smoke test of the casual controls: drag-pan, ride a tram (hover tip, view switch, next, hop off), click-to-walk, look-drag, fly up, pegman drop.
// usage: node tools/ctltest.mjs [outdir]
import { chromium } from 'playwright-core';
const [out = '/tmp/ctl'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:5173/?view=station&hour=13');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 180000 });
await page.waitForTimeout(2000);
const st = () => page.evaluate(() => { const { camera: c, controls: t, nav } = window.__three; return { pos: c.position.toArray().map((v) => +v.toFixed(1)), tgt: t.target.toArray().map((v) => +v.toFixed(1)), mode: nav.mode, ride: nav.ride && nav.ride.label, hint: document.querySelector('#hud .hint').textContent.slice(0, 40), who: document.querySelector('#hud .who').textContent }; });
const log = async (s) => console.log(s.padEnd(18), JSON.stringify(await st()));
const shot = (n) => page.screenshot({ path: `${out}-${n}.png` });
await log('start');
await page.mouse.move(640, 500); await page.mouse.down(); await page.mouse.move(540, 450, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(400);
await log('drag-pan');
// find a visible tram on screen
const tp = await page.evaluate(() => { const { camera } = window.__three; const L = window.__life; const v = new (camera.position.constructor)();
  for (const [tr, x, z, , y] of L.tramSections) { v.set(x, y + 1.6, z).project(camera); const sx = (v.x + 1) / 2 * innerWidth, sy = (1 - v.y) / 2 * innerHeight; if (v.z < 1 && sx > 50 && sx < 900 && sy > 80 && sy < 700) return [sx, sy]; } return null; });
console.log('tram on screen at', tp);
if (tp) {
  await page.mouse.move(tp[0], tp[1]); await page.waitForTimeout(300);
  console.log('tooltip:', await page.textContent('#hud .tip'), 'cursor:', await page.evaluate(() => document.querySelector('canvas').style.cursor));
  await shot('1-hover');
  await page.mouse.click(tp[0], tp[1]); await page.waitForTimeout(2500);
  await log('ride'); await shot('2-ride-eyes');
  await page.keyboard.press('KeyV'); await page.waitForTimeout(1800); await shot('3-ride-behind');
  await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(400, 400, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(300);
  await shot('4-ride-look');
  await page.keyboard.press('KeyN'); await page.waitForTimeout(1800); await log('next');
  await page.keyboard.press('Escape'); await page.waitForTimeout(1200); await log('hop off'); await shot('5-hopoff');
}
if ((await st()).mode !== 'orbit') { await page.keyboard.press('Escape'); await page.waitForTimeout(2200); }
await log('esc -> sky'); await shot('5b-sky');
await page.evaluate(() => window.__three.flyTo({ pos: [520, 182, 1720], target: [560, 40, 1560], ms: 10 })); await page.waitForTimeout(500);
await page.keyboard.press('KeyG'); await page.waitForTimeout(1800);
await log('walk'); await shot('6-walk');
await page.mouse.move(640, 600); await page.waitForTimeout(300);
console.log('marker visible:', await page.evaluate(() => window.__three.nav.marker.visible));
await page.mouse.click(640, 600); await page.waitForTimeout(2500); await log('click-walk');
await page.mouse.move(640, 400); await page.mouse.down(); await page.mouse.move(840, 400, { steps: 10 }); await page.mouse.up(); await page.waitForTimeout(300);
await log('look-drag'); await shot('7-look');
await page.mouse.wheel(0, -300); await page.waitForTimeout(1200); await log('wheel fwd');
await page.click('#hud .btns button'); /* walk mode: the only button is Fly up */ await page.waitForTimeout(2200); await log('fly up'); await shot('8-flyup');
// pegman drag onto the map
const wb = await page.locator('#hud .walker').boundingBox();
await page.mouse.move(wb.x + 18, wb.y + 18); await page.mouse.down(); await page.mouse.move(500, 420, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(2000);
await log('pegman drop'); await shot('9-pegman');
console.log('errors', errs);
await browser.close();
