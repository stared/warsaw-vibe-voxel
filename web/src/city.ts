import * as THREE from 'three';
import type { Caption } from './caption';
import type { TileStreamer } from './stream';
import type { Meta, Zones } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import { makeBuildDepthMaterial, makeVoxelMaterial, type BuildUniforms, type VoxelUniforms } from './voxelMaterial';

const T = 128;
const RINGS: [string, number][] = [['Buildings in view', 0], ['Buildings within 1 km', 1000], ['Buildings within 2 km', 2000], ['Buildings to the edge', Infinity]];

// The whole city at 1 m, shown as it arrives, in one order:
//   1. terrain: the bare ground, one small file
//   2. landmarks: their tiles first, each landmark as soon as all its tiles are in
//   3. everything else, nearest to the view first, each building once all its tiles are in
//   4. foliage: trees and grass, their own tiles (tiles/1f), then traffic
export async function installCity({ streamer: S, uniforms: U, meta, scene, focus, camera, caption }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms & BuildUniforms;
  meta: Meta;
  scene: THREE.Scene;
  focus: () => THREE.Vector3;
  camera: THREE.Camera;
  caption: Caption;
}) {
  const d = S.dims[1], total = d.nx * d.ny, { W, D } = meta, index = (tx: number, ty: number) => ty * d.nx + tx;
  caption.show('Terrain', 0, 2 * total);
  const terrain = await loadTerrain(meta, scene, d.nx, d.ny);
  document.querySelector('#loading')?.classList.add('hidden');

  const [zbuf, zones] = await Promise.all([fetchGzip('data/zones.bin'), fetchJson<Zones>('data/zones.json')]);
  const bld = new Uint16Array(zbuf, W * D * 2, W * D);
  S.bldMap = { data: bld, W };
  const nb = zones.buildings.length, shown = new Uint8Array(128 * Math.ceil((nb + 1) / 128));
  const shownTex = dataTexture(shown, 128, shown.length / 128, THREE.RedFormat);
  U.uBldOn.value = shownTex;
  U.uStage.value = 1;
  const tilesOf = zones.buildings.map((b) => {
    const t = [];
    for (let ty = Math.floor(b[4] / T); ty <= Math.min(d.ny - 1, Math.floor((b[6] - 1) / T)); ty++)
      for (let tx = Math.floor(b[3] / T); tx <= Math.min(d.nx - 1, Math.floor((b[5] - 1) / T)); tx++) t.push(index(tx, ty));
    return t;
  });
  const onTile = Array.from({ length: total }, () => [] as number[]);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));

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
  const prio = (i: number, f: THREE.Vector3) => lmPrio.get(i) ?? (seen[i] ? 1e5 : 0) - away(i, f);
  look();
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, prio(index(tx, ty), focus()), true);
  S.pump();

  const depthMat = makeBuildDepthMaterial(U), folMat = makeVoxelMaterial(U);
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2; // grass wins over the base's bare earth
  const inTile = new Uint8Array(total), complete = new Uint8Array(nb), counted = new Set<string>();
  let tilesIn = 0, folIn = 0, lmShown = 0, stage = 1, last = 0;
  const show = (b: number) => { if (!shown[b + 1]) { shown[b + 1] = 255; if (isLandmark.has(b)) lmShown++; } };

  // the caption's parts of the long building stage: what you see, then rings around you
  const progress = (f: THREE.Vector3) => {
    if (stage === 4) { caption.finish('Foliage', 2 * total); return; }
    if (stage === 3) { caption.show('Foliage', total + folIn, 2 * total); return; }
    if (stage === 1) { caption.show('Landmarks', tilesIn, 2 * total); return; }
    const size = [0, 0, 0, 0];
    let ends = 0;
    for (let i = 0; i < total; i++) {
      if (lmPrio.has(i)) { ends++; continue; }
      const r = away(i, f);
      size[seen[i] ? 0 : r < 1000 ? 1 : r < 2000 ? 2 : 3]++;
    }
    let part = 0;
    for (ends += size[0]; part < 3 && tilesIn >= ends; ends += size[++part]);
    caption.show(RINGS[part][0], tilesIn, 2 * total);
  };

  S.update = () => {
    if (performance.now() - last < 100) return;
    last = performance.now();
    S.retire();
    const f = focus();
    look();
    S.reprioritize((n) => prio(index(n.tx, n.ty), f));
    let changed = false;
    for (const n of S.nodes.values()) {
      if (n.s !== 1 || n.state !== 'ready' || counted.has(n.key)) continue;
      counted.add(n.key);
      if (n.foliage) { folIn++; if (n.mesh) { n.mesh.material = folMat; n.mesh.visible = true; } continue; }
      const i = index(n.tx, n.ty);
      inTile[i] = 1; tilesIn++;
      if (n.mesh) { n.mesh.customDepthMaterial = depthMat; n.mesh.visible = true; }
      for (const b of onTile[i]) if (!complete[b] && tilesOf[b].every((k) => inTile[k])) {
        complete[b] = 1;
        if (isLandmark.has(b) || stage >= 2) { show(b); changed = true; }
      }
    }
    if (stage === 1 && lmShown === landmarks.length) {
      stage = U.uStage.value = 2;
      for (let b = 0; b < nb; b++) if (complete[b]) show(b);
      changed = true;
    }
    if (stage === 2 && tilesIn === total) {
      stage = U.uStage.value = 3;
      for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.requestFoliage(tx, ty, (seen[index(tx, ty)] ? 1e5 : 0) - away(index(tx, ty), f));
    }
    if (stage === 3 && folIn === total) stage = 4;
    if (stage >= 2) terrain.dropUnder(inTile);
    if (stage >= 3) terrain.dispose();
    if (changed) shownTex.needsUpdate = true;
    progress(f);
    S.pump();
  };

  const labelled = new Map(meta.labels.map((l) => [`${l.x + 0.5},${l.y + 0.5}`, bldAt(l.x, l.y)]));
  return {
    // a building's label once it shows; the others (parks, the river) with the foliage
    gate: (x: number, z: number) => { const b = labelled.get(`${x},${z}`) ?? -1; return b >= 0 ? shown[b + 1] > 0 : stage >= 4; },
    get complete() { return stage >= 4; },
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
