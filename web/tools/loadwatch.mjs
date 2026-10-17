// Records a whole-city load: every ~100 ms the caption (text, box and text rectangles, bar width) and the stage,
// plus a screenshot every ~700 ms. usage: node tools/loadwatch.mjs <outdir> [w h]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out, w = 1280, h = 800] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.text().includes('whole city')) console.log('console', m.text().slice(0, 200)); });
const t0 = Date.now(), log = [];
await page.goto('http://localhost:5173/', { waitUntil: 'commit' });
let lastShot = -1e9;
while (Date.now() - t0 < 40000) {
  const s = await page.evaluate(() => {
    const c = document.querySelector('.caption'), l = document.querySelector('#loading');
    const r = (e) => { if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.width * 10) / 10]; };
    return { loading: l && !l.classList.contains('hidden') ? document.querySelector('#loading-text').textContent : null,
      text: c?.querySelector('.txt').textContent, box: r(c), st: r(c?.querySelector('.st')), n: (() => { const e = c?.querySelector('.n'); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left * 10) / 10, Math.round(b.right * 10) / 10]; })(), bar: c?.querySelector('i').style.width, off: c?.classList.contains('off') };
  }).catch(() => null);
  const t = Date.now() - t0;
  if (s) log.push({ t, ...s });
  if (t - lastShot > 700) { lastShot = t; await page.screenshot({ path: `${out}/${String(t).padStart(5, '0')}.jpg`, quality: 75 }).catch(() => {}); }
  if (s?.off) break;
  await page.waitForTimeout(80);
}
fs.writeFileSync(`${out}/log.json`, JSON.stringify(log));
await browser.close();
