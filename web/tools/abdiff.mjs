// Same views from two servers (e.g. main in a worktree on :5174, this branch on :5173), frozen and screenshot, then a
// literal pixel diff (tools/abdiff.py). Randomness is seeded, the clock stops once the city is in, traffic is removed
// unless --life. usage: node tools/abdiff.mjs out/ http://localhost:5174 http://localhost:5173 [views] [--life] [--vp=1440x900x2]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2), flags = args.filter((a) => a.startsWith('--')), [out, A, B, views = 'overview,pkin,skyline,station,vistula,stadium,zlota,city'] = args.filter((a) => !a.startsWith('--'));
const life = flags.includes('--life'), [w, h, dpr] = (flags.find((f) => f.startsWith('--vp='))?.slice(5) ?? '1440x900x2').split('x').map(Number);
const query = flags.find((f) => f.startsWith('--q='))?.slice(4) ?? 'date=06-21&hour=16&weather=clear';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });

async function shot(base, view, file) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  await page.addInitScript(() => {
    let s = 1234567;
    Math.random = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
  });
  await page.goto(`${base}/?ui=0&view=${view}&${query}`);
  await page.waitForFunction(() => window.__three && window.__ready && !document.body.classList.contains('loading'), null, { timeout: 600000, polling: 250 });
  await page.waitForFunction(() => !window.__three.budget || window.__three.budget() === Infinity, null, { timeout: 180000, polling: 500 }).catch(() => {});
  await page.waitForFunction(() => { const s = window.__streamer; return s && s.inflight === 0 && s.queue.length === 0; }, null, { timeout: 120000, polling: 250 }).catch(() => {});
  await page.waitForTimeout(2000);
  await page.evaluate((life) => {
    const t = performance.now();
    performance.now = () => t;
    if (!life && window.__life) { window.__life.update = () => {}; window.__life.group.removeFromParent(); }
  }, life);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: file });
  await page.close();
}

for (const v of views.split(',')) {
  await shot(A, v, `${out}/${v}_a.png`);
  await shot(B, v, `${out}/${v}_b.png`);
  console.log(execFileSync('uv', ['run', '--with', 'numpy', '--with', 'pillow', 'python', '-I', new URL('./abdiff.py', import.meta.url).pathname, `${out}/${v}_a.png`, `${out}/${v}_b.png`, `${out}/${v}_diff.png`]).toString().trim());
}
await browser.close();
