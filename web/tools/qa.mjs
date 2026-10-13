// Street-life QA: per-frame metrics on rendered car/tram/person positions + screenshot sequences.
// usage: node tools/qa.mjs [seconds=60] [outdir=../data/qa]
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const [secs = 60, outdir = '../data/qa'] = process.argv.slice(2);
fs.mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/?hour=17&ui=0&tilt=0');
await page.waitForFunction(() => window.__ready === true && window.__life, null, { timeout: 120000 });

// install the probe: runs every animation frame inside the page
await page.evaluate(async () => {
  const mask = new Uint8Array(await new Response((await fetch('data/qa_roadmask.bin.gz')).body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const W = (await (await fetch('data/meta.json')).json()).W;
  const Q = (window.__qa = { frames: 0, ev: {}, samples: {}, last: new Map(), lastT: new Map() });
  const bump = (k, sample) => { Q.ev[k] = (Q.ev[k] || 0) + 1; if (sample && (!Q.samples[k] || Q.samples[k].length < 12)) (Q.samples[k] ||= []).push(sample); };
  const onRoad = (x, z) => { const v = mask[Math.floor(z) * W + Math.floor(x)]; return v; };
  function probe() {
    const L = window.__life, T = L.tramSections;
    Q.frames++;
    // cars: rendered positions/headings from smoothing state
    const cars = L.cars.filter((c) => c.rp);
    for (const c of cars) {
      const prev = Q.last.get(c);
      if (prev) {
        const d = Math.hypot(c.rp.x - prev.x, c.rp.z - prev.z);
        if (d > 4) bump('car_teleport>4m', [c.rp.x | 0, c.rp.z | 0, +d.toFixed(1)]);
        let dh = Math.abs(Math.atan2(Math.sin(c.rh - prev.h), Math.cos(c.rh - prev.h)));
        if (dh > 0.6) bump('car_heading_jump>35deg', [c.rp.x | 0, c.rp.z | 0, +(dh * 57).toFixed(0)]);
        // moving sideways / backwards relative to heading
        const vx = c.rp.x - prev.x, vz = c.rp.z - prev.z, sp = Math.hypot(vx, vz);
        if (sp > 0.15) {
          const fx = Math.sin(c.rh), fz = Math.cos(c.rh);
          const along = (vx * fx + vz * fz) / sp;
          if (along < 0.5) bump('car_crab_or_reverse', [c.rp.x | 0, c.rp.z | 0, +along.toFixed(2)]);
        }
      }
      Q.last.set(c, { x: c.rp.x, z: c.rp.z, h: c.rh });
      if (!onRoad(c.rp.x, c.rp.z)) bump('car_offroad', [c.rp.x | 0, c.rp.z | 0, L.roads[c.e].c]);
      Q.carSamples = (Q.carSamples || 0) + 1;
    }
    // car-car overlaps (oriented boxes approximated by circles of r=1.2 at front and back)
    const pts = [];
    for (const c of cars) {
      const fx = Math.sin(c.rh), fz = Math.cos(c.rh), h = (c.len / 2) - 1;
      pts.push([c, c.rp.x + fx * h, c.rp.z + fz * h], [c, c.rp.x - fx * h, c.rp.z - fz * h]);
    }
    const grid = new Map();
    for (const p of pts) { const k = (p[1] / 4 | 0) + ',' + (p[2] / 4 | 0); (grid.get(k) || grid.set(k, []).get(k)).push(p); }
    const seen = new Set();
    for (const p of pts) {
      const gx = p[1] / 4 | 0, gz = p[2] / 4 | 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const o of grid.get((gx + i) + ',' + (gz + j)) || []) {
        if (o[0] === p[0]) continue;
        if (Math.hypot(o[1] - p[1], o[2] - p[2]) < 1.6 && Math.abs(o[0].rp.y - p[0].rp.y) < 1.5) {
          const key = [L.cars.indexOf(p[0]), L.cars.indexOf(o[0])].sort().join('-');
          if (!seen.has(key)) {
            seen.add(key);
            const A = p[0], B = o[0], ea = L.roads[A.e], eb = L.roads[B.e];
            let cat;
            if (A.e === B.e) cat = A.lane === B.lane ? 'same-lane' : (A.lcTo !== undefined || B.lcTo !== undefined ? 'lane-change' : 'adjacent-lanes');
            else if (ea.b === eb.a || eb.b === ea.a) cat = 'consecutive';
            else if (ea.b === eb.b) cat = 'merge-into-node';
            else if (ea.a === eb.a) cat = 'diverge';
            else if (ea.w === eb.w) cat = 'same-way-opposite';
            else {
              // do the edges share a node 2 hops away (inside a dual-carriageway junction)?
              const near = (L.outs.get(ea.b) || []).some((j) => L.roads[j].b === eb.b || L.roads[j].a === eb.a) || (L.outs.get(eb.b) || []).some((j) => L.roads[j].b === ea.b);
              cat = near ? 'junction-2hop' : 'unrelated-ways';
            }
            bump('car_overlap:' + cat, [p[1] | 0, p[2] | 0, A.e, B.e, +A.s.toFixed(1), +B.s.toFixed(1), A.boxNode, B.boxNode]);
          }
        }
      }
    }
    // trams: sections from different trams within 6 m = collision; section off tram bed
    if (T) {
      const secs = T.map(([tr, x, z, h]) => [L.trams.indexOf(tr), x, z, h]);
      for (let a = 0; a < secs.length; a++) for (let b = a + 1; b < secs.length; b++) {
        const dxs = secs[b][1] - secs[a][1], dzs = secs[b][2] - secs[a][2], ha = secs[a][3];
        const alongS = Math.abs(dxs * Math.sin(ha) + dzs * Math.cos(ha)), latS = Math.abs(dxs * Math.cos(ha) - dzs * Math.sin(ha));
        if (secs[a][0] !== secs[b][0] && alongS < 10 && latS < 2.3) {
          const ta = L.trams[secs[a][0]], tb = L.trams[secs[b][0]];
          bump('tram_tram_overlap', [secs[a][1] | 0, secs[a][2] | 0, L.tramPaths[ta.p].ref + '/' + ta.p, L.tramPaths[tb.p].ref + '/' + tb.p, +ta.v.toFixed(1), +tb.v.toFixed(1)]);
        }
      }
      for (const s of secs) if (onRoad(s[1], s[2]) !== 2) bump('tram_off_trambed', [s[1] | 0, s[2] | 0]);
      // tram vs car
      for (const s of secs) for (const c of cars) {
        const dxs = c.rp.x - s[1], dzs = c.rp.z - s[2];
        const al = Math.abs(dxs * Math.sin(s[3]) + dzs * Math.cos(s[3])), la = Math.abs(dxs * Math.cos(s[3]) - dzs * Math.sin(s[3]));
        if (al < 6.5 && la < 2.0) {
          const tr = L.trams[s[0]], e = L.roads[c.e];
          bump('tram_car_overlap', [s[1] | 0, s[2] | 0, 'car e' + c.e + ' lane' + c.lane + '/' + e.lanes + ' off' + c.off.toFixed(1) + ' v' + c.v.toFixed(1) + ' why:' + c.why + (c.ghost > 0 ? ' GHOST' : ''), 'tram ' + L.tramPaths[tr.p].ref + ' v' + tr.v.toFixed(1)]);
        }
      }
    }
    requestAnimationFrame(probe);
  }
  requestAnimationFrame(probe);
});

await page.waitForTimeout(+secs * 1000);
const res = await page.evaluate(() => { const Q = window.__qa; return { frames: Q.frames, carSamples: Q.carSamples, ev: Q.ev, samples: Q.samples }; });
console.log(JSON.stringify(res, null, 1));
fs.writeFileSync(`${outdir}/metrics.json`, JSON.stringify(res, null, 1));
console.log('errors', errs);
await browser.close();
