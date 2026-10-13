// Frame-time percentiles while flying between views (streaming stutter check). usage: node tools/jank.mjs <url> [label]
import { chromium } from 'playwright-core';
const [url = 'http://localhost:5173/', label = ''] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
await page.waitForTimeout(3000);
const r = await page.evaluate(async () => {
  const ts = []; let last = performance.now(), run = true;
  const tick = (n) => { ts.push(n - last); last = n; if (run) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const keys = ['Digit2', 'Digit6', 'Digit7', 'Digit1', 'Digit3', 'Digit8', 'Digit9', 'Digit1'];
  for (const k of keys) { window.dispatchEvent(new KeyboardEvent('keydown', { code: k, key: k.slice(-1) })); await new Promise((r) => setTimeout(r, 2600)); }
  run = false;
  ts.sort((a, b) => a - b);
  const q = (p) => +ts[Math.min(ts.length - 1, Math.floor(ts.length * p))].toFixed(1);
  return { frames: ts.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: +ts[ts.length - 1].toFixed(1), over50ms: ts.filter((t) => t > 50).length };
});
console.log(label, JSON.stringify(r));
await browser.close();
