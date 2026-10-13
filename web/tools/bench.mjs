// usage: node tools/bench.mjs <outdir>  — CPU per browser process over 10 s + screenshots of fixed views
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const out = process.argv[2] || 'bench'; fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const bcdp = await browser.newBrowserCDPSession();
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
const load = async (q) => {
  await page.goto(`http://localhost:5173/?${q}${process.env.Q ? '&' + process.env.Q : ''}`);
  await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 180000 });
  await page.waitForTimeout(2500);
};
const res = {};
// --- CPU over 10 s on the default view (life on)
await load('');
await page.evaluate(() => { window.__nf = 0; const f = () => { window.__nf++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
const proc = async () => Object.fromEntries((await bcdp.send('SystemInfo.getProcessInfo')).processInfo.map((p) => [`${p.type}:${p.id}`, p.cpuTime]));
const met = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const p0 = await proc(), m0 = await met(), f0 = await page.evaluate(() => window.__nf);
const T = 10; await page.waitForTimeout(T * 1000);
const p1 = await proc(), m1 = await met(), f1 = await page.evaluate(() => window.__nf);
const byType = {};
for (const k in p1) { const t = k.split(':')[0]; byType[t] = (byType[t] || 0) + (p1[k] - (p0[k] || 0)); }
for (const t in byType) byType[t] = +(100 * byType[t] / T).toFixed(1); // % of one core
res.cpu_pct_of_core = byType;
res.cpu_total_pct = +Object.values(byType).reduce((a, b) => a + b, 0).toFixed(1);
res.fps = +((f1 - f0) / T).toFixed(1);
const d = (k) => +((m1[k] - m0[k]) / (f1 - f0) * 1000).toFixed(2);
res.main_thread_ms_per_frame = { task: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration'), style: d('RecalcStyleDuration') };
res.draw_calls = await page.evaluate(async () => { const i = window.__three.renderer.info; await new Promise(requestAnimationFrame); i.autoReset = false; i.reset(); await new Promise(requestAnimationFrame); const c = i.render.calls; i.autoReset = true; return c; });
// --- screenshots: static city (life + fountains hidden, clock frozen) and with life
for (const v of ['overview', 'pkin', 'station', 'skyline']) {
  await load(`view=${v}`);
  await page.evaluate(() => { window.__life.group.visible = false; window.__three.P.fountains = false; });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${v}-static.png` });
  await page.evaluate(() => { window.__life.group.visible = true; });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${v}-life.png` });
}
fs.writeFileSync(`${out}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res, null, 1));
await browser.close();
