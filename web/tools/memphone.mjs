import { chromium } from 'playwright-core';
const url = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, screen: { width: 390, height: 844 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  const big = []; window.__gpu = { tex: 0, buf: 0, big };
  const bpp = (f, t) => (t === 0x1406 ? 4 : t === 0x1403 || t === 0x1402 ? 2 : 1) * ({ 0x1908: 4, 0x1907: 3, 0x8227: 2, 0x8228: 2, 0x1903: 1, 0x8D94: 1, 0x8D99: 4, 0x8D98: 3 }[f] ?? 4);
  for (const C of [WebGL2RenderingContext]) {
    const ti = C.prototype.texImage2D;
    C.prototype.texImage2D = function (...a) { if (a.length >= 9) { const n = a[3] * a[4] * bpp(a[6], a[7]); __gpu.tex += n; if (n > 4e6) big.push([a[3], a[4], n]); } else if (a[5]?.width) { const n = a[5].width * a[5].height * 4; __gpu.tex += n; if (n > 4e6) big.push([a[5].width, a[5].height, n]); } return ti.apply(this, a); };
    const ts = C.prototype.texStorage2D;
    C.prototype.texStorage2D = function (t, l, f, w, h) { const n = w * h * 4; __gpu.tex += n; if (n > 4e6) big.push([w, h, n, 'st']); return ts.apply(this, arguments); };
    const bd = C.prototype.bufferData;
    C.prototype.bufferData = function (t, d) { __gpu.buf += typeof d === 'number' ? d : d?.byteLength ?? 0; return bd.apply(this, arguments); };
  }
});
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
for (let i = 0; i < 6; i++) {
  await page.waitForTimeout(5000);
  console.log(await page.evaluate(() => JSON.stringify({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), texMB: Math.round(__gpu.tex / 1e6), bufMB: Math.round(__gpu.buf / 1e6), url: location.search })));
}
console.log(JSON.stringify(await page.evaluate(() => __gpu.big)));
await browser.close();
