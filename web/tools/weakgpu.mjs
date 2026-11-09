// A slower GPU, simulated: each frame waits ms per million triangles drawn and per million pixels; the render size
// it settles at, every 3 s. usage: node tools/weakgpu.mjs http://localhost:5188 [ms/Mtri=3] [ms/Mpx=8] [seconds=90]
import { chromium } from 'playwright-core';
const [base, kt = '3', kp = '8', secs = '90'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`${base}/?date=06-21&hour=16&weather=clear`);
await page.waitForFunction(() => window.__three?.post, null, { timeout: 60000, polling: 50 });
await page.evaluate(([kt, kp]) => {
  const T = window.__three, c = T.post.composer, render = c.render.bind(c);
  c.render = (...a) => {
    render(...a);
    const r = T.renderer, px = r.domElement.width * r.domElement.height / 1e6, ms = kt * r.info.render.triangles / 1e6 + kp * px;
    const t = performance.now(); while (performance.now() - t < ms);
  };
}, [+kt, +kp]);
const t0 = Date.now();
while ((Date.now() - t0) / 1000 < +secs) {
  await page.waitForTimeout(3000);
  console.log(JSON.stringify(await page.evaluate(() => ({ t: Math.round(performance.now() / 1000), level: +window.__three.level().toFixed(2), ratio: window.__three.renderer.getPixelRatio(),
    loading: document.body.classList.contains('loading'), fps: document.querySelector('#perf .fps')?.textContent }))));
}
await browser.close();
