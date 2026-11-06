import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileStreamer } from './stream';
import type { Meta, Zones } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import { makeBuildDepthMaterial, makeClayDepthMaterial, makeVoxelMaterial, type VoxelUniforms } from './voxelMaterial';

const T = 128;
const RINGS: [string, number][] = [['Buildings in view', 0], ['Buildings within 1 km', 1000], ['Buildings within 2 km', 2000], ['Buildings to the edge', Infinity]];

// The city at 1 m, as much of it as the budget allows (triangles of 1 m buildings, city blocks nearest to the focus
// first; on most computers all of it), shown as it arrives, in one order:
//   1. the ground: the terrain, one small file; where the budget leaves some city out, the whole map at 8 m as clay
//   2. landmarks: their tiles first, each landmark as soon as all its tiles are in (not over clay)
//   3. everything else, nearest to the view first, each building once all its tiles are in; over clay a city block
//      turns real once every tile under it is in, and back to clay when the budget moves on
//   4. foliage: trees and grass, their own tiles (tiles/1f), then traffic
export async function installCity({ streamer: S, uniforms: U, meta, scene, focus, camera, caption, budget }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.Camera;
  caption: Caption;
  budget: () => number;
}) {
  const d = S.dims[1], total = d.nx * d.ny, { W, D } = meta, index = (tx: number, ty: number) => ty * d.nx + tx;
  const zonesIn = Promise.all([fetchGzip('data/zones.bin'), fetchJson<Zones>('data/zones.json')]);
  let terrain: Awaited<ReturnType<typeof loadTerrain>> | null = null;
  const d8 = S.dims[8], n8 = d8.nx * d8.ny, clayIn: Promise<void>[] = [];
  let claysIn = 0;
  if (Number.isFinite(budget())) {
    for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) clayIn.push(S.request(8, tx, ty, 1e9).then(() => { claysIn++; }));
    S.pump();
  } else {
    caption.show('Terrain', 0, 2 * total);
    terrain = await loadTerrain(meta, scene, d.nx, d.ny);
  }
  const [zbuf, zones] = await zonesIn;
  document.querySelector('#loading')?.classList.add('hidden');
  const bld = new Uint16Array(zbuf, W * D * 2, W * D);
  S.bldMap = { data: bld, W };
  const nb = zones.buildings.length, shown = new Uint8Array(128 * Math.ceil((nb + 1) / 128));
  const shownTex = dataTexture(shown, 128, shown.length / 128, THREE.RedFormat);
  U.uBldOn.value = shownTex;
  U.uStage.value = 1;
  const tilesIn = (x0: number, y0: number, x1: number, y1: number) => {
    const t = [];
    for (let ty = Math.floor(y0 / T); ty <= Math.min(d.ny - 1, Math.floor((y1 - 1) / T)); ty++)
      for (let tx = Math.floor(x0 / T); tx <= Math.min(d.nx - 1, Math.floor((x1 - 1) / T)); tx++) t.push(index(tx, ty));
    return t;
  };
  const tilesOf = zones.buildings.map((b) => tilesIn(b[3], b[4], b[5], b[6]));
  const onTile = Array.from({ length: total }, () => [] as number[]);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));

  // city blocks [cx, cy, n, x0, y0, x1, y1, triangles] (scripts/zones.py), each real or clay as a whole
  const blocks = zones.blocks, nk = blocks.length, cityTris = blocks.reduce((a, b) => a + (b[7] || 0), 0);
  const blockTiles = blocks.map((b) => tilesIn(b[3], b[4], b[5], b[6]));
  const blkWant = new Uint8Array(nk + 1).fill(1), want = new Uint8Array(total).fill(1);
  const flags = new Uint8Array(64 * Math.ceil((nk + 1) / 64)), flagTex = dataTexture(flags, 64, flags.length / 64, THREE.RedFormat);
  U.uZFBlk.value = flagTex;
  const blkIds = dataTexture(new Uint16Array(zbuf, 0, W * D), W, D, THREE.RedIntegerFormat, THREE.UnsignedShortType);
  blkIds.internalFormat = 'R16UI';
  U.uZBlk.value = blkIds;
  const bdist = (b: number[], f: THREE.Vector3) => Math.hypot(Math.max(b[3] - f.x, 0, f.x - b[5]), Math.max(b[4] - f.z, 0, f.z - b[6]));
  const order = blocks.map((_, k) => k);
  let whole = true;
  const choose = (f: THREE.Vector3) => {
    const B = budget();
    whole = B >= cityTris;
    if (whole) { blkWant.fill(1); want.fill(1); return; }
    order.sort((a, b) => bdist(blocks[a], f) - bdist(blocks[b], f));
    let sum = 0;
    const next = new Uint8Array(nk + 1);
    for (const k of order) {
      sum += blocks[k][7] || 0;
      if (sum > B * (blkWant[k + 1] ? 1.1 : 1)) break;
      next[k + 1] = 1;
    }
    blkWant.set(next);
    want.fill(0);
    for (let k = 0; k < nk; k++) if (blkWant[k + 1]) for (const i of blockTiles[k]) want[i] = 1;
  };

  const bldAt = (x: number, y: number) => bld[Math.min(D - 1, Math.round(y)) * W + Math.min(W - 1, Math.round(x))] - 1;
  const landmarks = [...new Set(meta.labels.map((l) => bldAt(l.x, l.y)).filter((b) => b >= 0))], isLandmark = new Set(landmarks);
  const lmPrio = new Map<number, number>();
  landmarks.forEach((b, j) => tilesOf[b].forEach((k) => { if (!lmPrio.has(k)) lmPrio.set(k, 1e6 - j); }));

  const seen = new Uint8Array(total), frustum = new THREE.Frustum(), box = new THREE.Box3(), pm = new THREE.Matrix4();
  const look = () => {
    camera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) {
      box.min.set(tx * T, 0, ty * T); box.max.set((tx + 1) * T, 330, (ty + 1) * T);
      seen[index(tx, ty)] = frustum.intersectsBox(box) ? 1 : 0;
    }
  };
  const away = (i: number, f: THREE.Vector3) => Math.hypot((i % d.nx + 0.5) * T - f.x, (Math.floor(i / d.nx) + 0.5) * T - f.z);
  const prio = (i: number, f: THREE.Vector3) => (clay === 'none' ? lmPrio.get(i) : undefined) ?? (seen[i] ? 1e5 : 0) - away(i, f);
  const request = (f: THREE.Vector3) => {
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) if (want[index(tx, ty)]) S.request(1, tx, ty, prio(index(tx, ty), f), true);
  };

  // clay: the whole map at 8 m, fetched the first time the budget leaves some city out; the terrain goes then
  let clay: 'none' | 'loading' | 'ready' = 'none';
  const clayMat = makeVoxelMaterial(U, { clay: true }), clayDepth = makeClayDepthMaterial(U);
  const startClay = () => {
    clay = 'loading';
    if (stage === 1) toStage2();
    if (!clayIn.length) {
      for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) clayIn.push(S.request(8, tx, ty, 1e9).then(() => { claysIn++; }));
      S.pump();
    }
    Promise.all(clayIn).then(() => {
      for (const n of S.nodes.values()) if (n.s === 8 && n.mesh) { n.mesh.material = clayMat; n.mesh.customDepthMaterial = clayDepth; n.mesh.visible = true; }
      terrain?.dropUnder(new Uint8Array(total).fill(1));
      U.uZOn.value = 1;
      clay = 'ready';
    });
  };

  const depthMat = makeBuildDepthMaterial(U), folMat = makeVoxelMaterial(U);
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2; // grass wins over the base's bare earth
  const inTile = new Uint8Array(total), folTile = new Uint8Array(total), complete = new Uint8Array(nb), counted = new Set<string>();
  let lmShown = 0, stage = 1, last = 0, flagKey = '', realTris = 0, settled = false;
  const show = (b: number) => { if (!shown[b + 1]) { shown[b + 1] = 255; if (isLandmark.has(b)) lmShown++; } };
  function toStage2() {
    stage = U.uStage.value = 2;
    for (let b = 0; b < nb; b++) if (complete[b]) show(b);
    shownTex.needsUpdate = true;
  }

  look();
  choose(focus());
  if (!whole) startClay();
  request(focus());
  S.pump();

  // the caption's parts of the long building stage: what you see, then rings around you
  const progress = (f: THREE.Vector3, wanted: number, tilesNow: number, folNow: number) => {
    const base = clay === 'none' ? 0 : n8, all = base + 2 * wanted;
    if (stage === 4 && clay !== 'loading') { caption.finish('Foliage', all); return; }
    if (clay === 'loading' && claysIn < n8) { caption.show('Ground', claysIn, all); return; }
    if (stage >= 3) { caption.show('Foliage', base + wanted + folNow, all); return; }
    if (stage === 1) { caption.show('Landmarks', tilesNow, all); return; }
    const size = [0, 0, 0, 0];
    let ends = base;
    for (let i = 0; i < total; i++) {
      if (!want[i]) continue;
      if (clay === 'none' && lmPrio.has(i)) { ends++; continue; }
      const r = away(i, f);
      size[seen[i] ? 0 : r < 1000 ? 1 : r < 2000 ? 2 : 3]++;
    }
    let part = 0;
    for (ends += size[0]; part < 3 && base + tilesNow >= ends; ends += size[++part]);
    caption.show(RINGS[part][0], base + tilesNow, all);
  };

  S.update = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    S.retire();
    const f = focus();
    look();
    choose(f);
    if (!whole && clay === 'none') startClay();
    request(f);
    S.reprioritize((n) => (n.s === 8 ? 1e9 : prio(index(n.tx, n.ty), f)));
    let changed = false;
    for (const n of [...S.nodes.values()]) {
      if (n.s !== 1 || n.state !== 'ready') continue;
      const i = index(n.tx, n.ty);
      if (!want[i]) {
        if (n.mesh && clay === 'ready') n.mesh.visible = false;
        if (clay === 'ready' && now - n.used > 4000 && !(n.pinned > now)) {
          if (counted.delete(n.key)) { if (n.foliage) folTile[i] = 0; else inTile[i] = 0; }
          S.free(n);
        }
        continue;
      }
      n.used = now;
      if (counted.has(n.key)) { if (n.mesh) n.mesh.visible = true; continue; }
      counted.add(n.key);
      if (n.foliage) { folTile[i] = 1; if (n.mesh) { n.mesh.material = folMat; n.mesh.visible = true; } continue; }
      inTile[i] = 1;
      if (n.mesh) { n.mesh.customDepthMaterial = depthMat; n.mesh.visible = true; }
      for (const b of onTile[i]) if (!complete[b] && tilesOf[b].every((k) => inTile[k])) {
        complete[b] = 1;
        if (isLandmark.has(b) || stage >= 2) { show(b); changed = true; }
      }
    }
    let wanted = 0, tilesNow = 0, folNow = 0;
    for (let i = 0; i < total; i++) if (want[i]) { wanted++; tilesNow += inTile[i]; folNow += folTile[i]; }
    settled = tilesNow === wanted;
    if (stage === 1 && lmShown === landmarks.length) toStage2();
    if (stage === 2 && tilesNow === wanted) stage = U.uStage.value = 3;
    if (stage >= 3) for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) {
      const i = index(tx, ty);
      if (want[i] && inTile[i] && !folTile[i]) S.requestFoliage(tx, ty, prio(i, f));
    }
    if (stage === 3 && folNow === wanted) stage = 4;
    if (terrain && stage >= 2) terrain.dropUnder(inTile);
    if (terrain && stage >= 3 && whole) terrain.dispose();
    if (changed) shownTex.needsUpdate = true;
    realTris = 0;
    for (let k = 0; k < nk; k++) {
      const real = blkWant[k + 1] > 0 && blockTiles[k].every((i) => inTile[i]);
      flags[k + 1] = real ? 255 : 0;
      if (real) realTris += blocks[k][7] || 0;
    }
    if (clay === 'ready') {
      const key = flags.join('');
      if (key !== flagKey) { flagKey = key; flagTex.needsUpdate = true; }
      S.dropQueued((n) => n.s === 8 || want[index(n.tx, n.ty)] > 0 || n.pinned > now);
    }
    progress(f, wanted, tilesNow, folNow);
    S.pump();
  };

  const labelled = new Map(meta.labels.map((l) => [`${l.x + 0.5},${l.y + 0.5}`, bldAt(l.x, l.y)]));
  return {
    // a building's label once it shows; the others (parks, the river) with the foliage; over clay, all of them
    gate: (x: number, z: number) => { const b = labelled.get(`${x},${z}`) ?? -1; return clay !== 'none' || (b >= 0 ? shown[b + 1] > 0 : stage >= 4); },
    get complete() { return stage >= 4 && clay !== 'loading'; },
    get realTris() { return realTris; },
    // every tile the budget asks for is in
    get settled() { return settled; },
    cityTris,
  };
}

// one terrain piece per 128 m tile (heights every 4 m, ground colours every 2 m), each dropped once its tile is in:
// under the real ground it would flicker through
async function loadTerrain(meta: Meta, scene: THREE.Scene, nx: number, ny: number) {
  const { W, D } = meta, buf = await fetchGzip('data/terrain.bin');
  const tw = Math.ceil(W / 4), th = Math.ceil(D / 4), hd = new Uint16Array(buf, 0, tw * th), C = T / 4;
  const cw = Math.floor(W / 2), ch = Math.floor(D / 2), rgb = new Uint8Array(buf, tw * th * 2, cw * ch * 3), rgba = new Uint8Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) { rgba.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i); rgba[4 * i + 3] = 255; }
  const tex = dataTexture(rgba, cw, ch, THREE.RGBAFormat);
  Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, magFilter: THREE.NearestFilter, minFilter: THREE.LinearMipmapLinearFilter, generateMipmaps: true, anisotropy: 8 });
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95 });
  const pieces: (THREE.Mesh | null)[] = new Array(nx * ny).fill(null);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const c0 = tx * C, r0 = ty * C, nc = Math.min(C, tw - 1 - c0) + 1, nr = Math.min(C, th - 1 - r0) + 1;
    if (nc < 2 || nr < 2) continue;
    const pos = new Float32Array(nc * nr * 3), uv = new Float32Array(nc * nr * 2), idx = new Uint16Array((nc - 1) * (nr - 1) * 6);
    for (let r = 0; r < nr; r++) for (let c = 0; c < nc; c++) {
      const k = r * nc + c;
      pos.set([(c0 + c) * 4, hd[(r0 + r) * tw + c0 + c] / 10, (r0 + r) * 4], k * 3);
      uv.set([(c0 + c) * 2 / cw, (r0 + r) * 2 / ch], k * 2);
    }
    for (let r = 0, k = 0; r < nr - 1; r++) for (let c = 0; c < nc - 1; c++, k += 6) { const i = r * nc + c; idx.set([i, i + nc, i + 1, i + 1, i + nc, i + nc + 1], k); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    scene.add(m);
    pieces[ty * nx + tx] = m;
  }
  return {
    dropUnder(inTile: Uint8Array) {
      pieces.forEach((m, i) => { if (m && inTile[i]) { scene.remove(m); m.geometry.dispose(); pieces[i] = null; } });
    },
    dispose() { if (tex.image.data) { tex.dispose(); tex.image.data = null as unknown as Uint8Array; } },
  };
}
