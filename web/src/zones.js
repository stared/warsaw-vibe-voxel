// PROTOTYPE (proto-ghost branch): the real 1 m city in a chosen shape around the look-at point, clay elsewhere.
// ?shape=square|circle|building|block|budget|ragged  &r=<metres, half size / radius>  &budget=<M triangles>
// Units (buildings, city blocks: scripts/zones.py) are whole: a unit turns real only once every tile under it is
// loaded, so there are never holes. The clay (8 m tiles, always loaded) and the real tiles each hide, per pixel,
// where the other is drawn (voxelMaterial.js, ZONES).
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';

const MODES = { square: 1, circle: 2, building: 3, block: 4, budget: 5, ragged: 6 };

export async function installZones({ streamer: S, material, meta, paletteTex, controls, nav, qs }) {
  const shape = qs.get('shape'), mode = MODES[shape] || 4, R = +(qs.get('r') || 250), BUDGET = +(qs.get('budget') || 2) * 1e6;
  const U = material.userData.uniforms, { W, D } = meta;
  const [zbuf, zj] = await Promise.all([
    fetch('data/zones.bin').then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    fetch('data/zones.json').then((r) => r.json())]);
  const idTex = (arr) => { const t = new THREE.DataTexture(arr, W, D, THREE.RedIntegerFormat, THREE.UnsignedShortType);
    t.internalFormat = 'R16UI'; t.unpackAlignment = 2; t.needsUpdate = true; return t; };
  U.uZBlk.value = idTex(new Uint16Array(zbuf, 0, W * D)); U.uZBld.value = idTex(new Uint16Array(zbuf, W * D * 2, W * D));
  const flagTex = (n, w) => { const h = Math.ceil((n + 1) / w), data = new Uint8Array(w * h);
    const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType); t.unpackAlignment = 1; t.needsUpdate = true; return t; };
  const fBlk = flagTex(zj.blocks.length, 64), fBld = flagTex(zj.buildings.length, 128);
  U.uZFBlk.value = fBlk; U.uZFBld.value = fBld; U.uZMode.value = mode; U.uZRad.value = 0;

  // the clay: all of level 8, loaded once, never changes
  const clay = makeVoxelMaterial({ paletteTex, lampTex: U.uLampMap.value, W, D, ghost: { style: 1, mask: null }, shared: U });
  const d8 = S.dims[8], ps = [];
  for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) ps.push(S.request(8, tx, ty, 1e9));
  S.pump(); await Promise.all(ps);
  for (const n of S.nodes.values()) if (n.s === 8 && n.mesh) { n.mesh.material = clay; n.mesh.visible = true; n.clay = true; }

  const d1 = S.dims[1], T = 128;
  const bdist = (b, f) => Math.hypot(Math.max(b[3] - f.x, 0, f.x - b[5]), Math.max(b[4] - f.z, 0, f.z - b[6])); // bbox [cx, cy, n, x0, y0, x1, y1]
  const hash = (i) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; return ((Math.imul(h, 0xc2b2ae35) >>> 0) % 1000) / 1000; };
  const tilesOf = (b, out) => { for (let ty = Math.floor(b[4] / T); ty <= Math.min(d1.ny - 1, Math.floor((b[6] - 1) / T)); ty++)
    for (let tx = Math.floor(b[3] / T); tx <= Math.min(d1.nx - 1, Math.floor((b[5] - 1) / T)); tx++) out.add(S.key(1, tx, ty)); return out; };
  const onBlk = new Set(), onBld = new Set();
  let shownR = 0;
  S.update = (cam) => {
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : cam.position;
    U.uZFocus.value.set(f.x, f.z);
    // the units that should be real (entering at R, staying until 1.1 R) and the tiles they need
    const wantBlk = [], wantBld = [], need = new Set();
    const ring = { x0: f.x - R * 1.1, y0: f.z - R * 1.1, x1: f.x + R * 1.1, y1: f.z + R * 1.1 };
    if (mode === 1 || mode === 2 || mode === 3) tilesOf([0, 0, 0, ring.x0, ring.y0, ring.x1, ring.y1], need);
    if (mode === 3 || mode === 6) zj.buildings.forEach((b, i) => { const r = mode === 6 ? R * (0.6 + 0.8 * hash(i + 1)) : R;
      if (bdist(b, f) < r * (onBld.has(i + 1) ? 1.1 : 1)) { wantBld.push(i + 1); tilesOf(b, need); } });
    if (mode === 4 || mode === 6) zj.blocks.forEach((b, i) => { if (bdist(b, f) < R * (onBlk.has(i + 1) ? 1.1 : 1)) { wantBlk.push(i + 1); tilesOf(b, need); } });
    if (mode === 5) { let sum = 0;
      for (const [b, i] of zj.blocks.map((b, i) => [b, i]).sort((a, c) => bdist(a[0], f) - bdist(c[0], f))) {
        sum += b[7] || 0; if (sum > BUDGET * (onBlk.has(i + 1) ? 1.1 : 1)) break; wantBlk.push(i + 1); tilesOf(b, need); } }
    for (const k of need) { const [, r] = k.split('/'); const [tx, ty] = r.split('_').map(Number);
      S.request(1, tx, ty, -Math.hypot((tx + 0.5) * T - f.x, (ty + 0.5) * T - f.z), false); }
    S.pump();
    const ready = (k) => S.nodes.get(k)?.state === 'ready';
    const allReady = (b) => { for (const k of tilesOf(b, new Set())) if (!ready(k)) return false; return true; };
    // a unit turns real only when all its tiles are there; it stays real while wanted
    onBlk.clear(); for (const i of wantBlk) if (allReady(zj.blocks[i - 1])) onBlk.add(i);
    onBld.clear(); for (const i of wantBld) if (allReady(zj.buildings[i - 1])) onBld.add(i);
    fBlk.image.data.fill(0); for (const i of onBlk) fBlk.image.data[i] = 255; fBlk.needsUpdate = true;
    fBld.image.data.fill(0); for (const i of onBld) fBld.image.data[i] = 255; fBld.needsUpdate = true;
    if (mode <= 3) { let ok = true; for (const k of need) if (!ready(k)) ok = false; if (ok) shownR = R; U.uZRad.value = shownR; }
    let tris = 0;
    for (const n of [...S.nodes.values()]) {
      if (n.clay) { tris += n.tris || 0; continue; }
      const on = n.s === 1 && need.has(n.key) && n.state === 'ready';
      if (n.mesh) n.mesh.visible = on;
      if (on) { tris += n.tris || 0; n.used = now; }
      else if (n.state === 'ready' && n.s !== 8 && now - (n.used || 0) > 4000 && !(n.pinned > now)) S.free(n);
    }
    S.tris = tris;
    S.queue = S.queue.filter((n) => need.has(n.key) || n.s === 8);
  };
  window.__zones = { onBlk, onBld };
}
