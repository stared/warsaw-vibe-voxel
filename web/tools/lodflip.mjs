// Level-of-detail flips: zoom the same views through many distances and render each step twice, with the normal
// detail budget and with full detail (?err=0.25). Whatever differs is what the coarse tiles change on screen,
// and it jumps when a tile switches level. Traffic, people and fountains off; tools/lodflip.py scores the pairs.
// usage: node tools/lodflip.mjs <outdir> [query for the tested build, e.g. "err=1"] [views, e.g. "pkin,varso"]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [out = '/private/tmp/claude-501/lodflip', q = '', only = ''] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
// target (scene x, y, z) and the direction from it to the camera
const VIEWS = {
  pkin: { t: [749, 110, 1229], dir: [0.55, 0.35, 0.76] },
  varso: { t: [300, 120, 1330], dir: [-0.6, 0.4, 0.7] },
  stadium: { t: [3579, 30, 1342], dir: [-0.7, 0.45, 0.55] },
  bridge: { t: [2916, 25, 834], dir: [0.2, 0.3, 0.93] },
  kopernik: { t: [2580, 20, 696], dir: [-0.5, 0.55, 0.67] },
};
const DIST = Array.from({ length: 22 }, (_, i) => Math.round(250 * 1.13 ** i)); // 250 m .. ~3.4 km
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const open = async (query) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:5173/?ui=0&hour=14${query ? '&' + query : ''}`);
  await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 300000 });
  await page.evaluate(() => { window.__life.group.visible = false; window.__three.P.fountains = false; window.__three.P.labels = false; });
  return page;
};
const pages = { test: await open(q), ref: await open('err=0.25') };
const pose = async (page, v, d) => {
  await page.evaluate(([t, dir, d]) => {
    const T = window.__three, n = Math.hypot(...dir);
    window.__life.group.visible = false;
    T.nav.cancelFly?.(); // the opening flight would otherwise keep moving one page's camera
    T.controls.target.set(...t);
    T.camera.position.set(t[0] + dir[0] / n * d, t[1] + dir[1] / n * d, t[2] + dir[2] / n * d);
    T.controls.update();
  }, [v.t, v.dir, d]);
};
const settle = async (page) => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => window.__streamer.inflight === 0 && window.__streamer.queue.length === 0, null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(900);
};
const log = [];
for (const [name, v] of Object.entries(VIEWS)) {
  if (only && !only.split(',').includes(name)) continue;
  for (const d of DIST) {
    await Promise.all(Object.values(pages).map((p) => pose(p, v, d)));
    await Promise.all(Object.values(pages).map(settle));
    const levels = await pages.test.evaluate(() => {
      const c = {}; for (const n of window.__streamer.nodes.values()) if (n.mesh?.visible) c[n.s] = (c[n.s] || 0) + (n.tris || 0);
      return c;
    });
    // same pose again on both, then check the cameras agree before shooting
    await Promise.all(Object.values(pages).map((p) => pose(p, v, d)));
    await Promise.all(Object.values(pages).map((p) => p.waitForTimeout(300)));
    const cams = await Promise.all(Object.values(pages).map((p) => p.evaluate(() => window.__three.camera.position.toArray().map((x) => +x.toFixed(1)))));
    if (cams[0].some((x, i) => Math.abs(x - cams[1][i]) > 0.5)) console.log('  camera mismatch', JSON.stringify(cams));
    for (const [k, p] of Object.entries(pages)) await p.screenshot({ path: `${out}/${name}_${String(d).padStart(4, '0')}_${k}.png` });
    log.push({ view: name, d, levels });
    process.stdout.write(`${name} ${d} m ${JSON.stringify(levels)}\n`);
  }
}
fs.writeFileSync(`${out}/log.json`, JSON.stringify(log));
await browser.close();
