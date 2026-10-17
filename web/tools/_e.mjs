import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('pageerror', e.message));
const t0 = Date.now();
await page.goto(process.argv[2]);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
console.log('ready', Date.now() - t0);
await page.waitForTimeout(4000);
console.log(JSON.stringify(await page.evaluate(() => {
  const S = window.__streamer; let real = [0, 0, 0], clay = [0, 0];
  for (const n of S.nodes.values()) { if (n.clay) { clay[0]++; if (n.mesh?.visible) clay[1]++; } else if (n.s === 1) { real[0]++; if (n.state === 'ready') real[1]++; if (n.mesh?.visible) real[2]++; } }
  const u = S.material.userData.uniforms;
  return { real, clay, mode: u.uZMode.value, rad: u.uZRad.value, focus: [u.uZFocus.value.x, u.uZFocus.value.y], flags: u.uZFBld.value.image.data.reduce((a, b) => a + (b > 0), 0), fw: u.uZFBld.value.image.width, fh: u.uZFBld.value.image.height }; })));
await page.screenshot({ path: '/private/tmp/claude-501/load/dbg.png' });
await browser.close();
