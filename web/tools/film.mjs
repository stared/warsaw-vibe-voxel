// The loading as a visitor sees it: a screenshot and the state (caption, budget, fps) every 2 s, over a throttled
// network. usage: node tools/film.mjs http://localhost:5173 out/ [Mbps=20] [seconds=40]
import { chromium } from 'playwright-core';
const [base, out, mbps = '20', secs = '40'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 30, downloadThroughput: (+mbps * 1e6) / 8, uploadThroughput: 1e6 });
const t0 = Date.now();
await page.goto(`${base}/?date=06-21&hour=16&weather=clear`);
for (let i = 0; (Date.now() - t0) / 1000 < +secs; i++) {
  await page.waitForTimeout(2000);
  const s = await page.evaluate(() => ({
    loading: document.body.classList.contains('loading'),
    cap: document.querySelector('.caption:not(.off)')?.textContent ?? '',
    budget: window.__three?.budget?.(), level: window.__three?.level?.(), ratio: window.__three?.renderer.getPixelRatio(), real: window.__three?.city?.()?.realTris,
    fps: document.querySelector('#perf .fps')?.textContent ?? '',
  })).catch(() => ({}));
  const t = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(t, JSON.stringify(s));
  await page.screenshot({ path: `${out}/${String(i).padStart(2, '0')}_${t}s.png`, scale: 'css' });
}
await browser.close();
