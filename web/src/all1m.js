// The whole city at 1 m, loaded once, no levels (the default engine). ?shape= runs the zones.js prototype instead.
// It shows what has arrived, in one order, with no timing of its own (voxelMaterial.js BUILD_VERTEX):
//   1. terrain: the bare ground (terrain.bin, one small file), nothing else
//   2. landmarks: their tiles are fetched first, landmark after landmark; each shows the moment all its tiles are in
//   3. everything else: the rest of the tiles, nearest to the view first; each building once all its tiles are in
//   4. foliage and details (lamps, signs, cars) once every tile is in; then traffic
// The caption counts one thing throughout: tiles in, out of all of them.
// (No compact vertex format or temporal anti-aliasing yet: this is today's meshes, all of them.)
import * as THREE from 'three';
import { makeBuildDepthMaterial } from './voxelMaterial.js';

async function fetchBytes(url, onBytes) { // with progress: the caption shows the bytes as they come
  const res = await fetch(url), total = +res.headers.get('content-length') || 0, reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(got, total); }
  return new Blob(parts).arrayBuffer();
}
const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

export async function installAll1m({ streamer: S, material, meta, scene, controls, nav, caption: cap, P }) {
  const d = S.dims[1], total = d.nx * d.ny, U = material.userData.uniforms, { W, D } = meta, T = 128;
  S.update = () => {};
  // 1. terrain
  const tbuf = await gunzip(await fetchBytes('data/terrain.bin', () => {}));
  cap.show(`Terrain · 0 / ${total} tiles`, 0, total);
  const tw = Math.ceil(W / 4), th = Math.ceil(D / 4), hd = new Uint16Array(tbuf);
  const tpos = new Float32Array(tw * th * 3), tidx = new Uint32Array((tw - 1) * (th - 1) * 6);
  for (let r = 0; r < th; r++) for (let c = 0; c < tw; c++) { const i = r * tw + c; tpos.set([Math.min(c * 4, W), hd[i] / 10 - 0.4, Math.min(r * 4, D)], i * 3); }
  for (let r = 0, k = 0; r < th - 1; r++) for (let c = 0; c < tw - 1; c++, k += 6) { const i = r * tw + c; tidx.set([i, i + tw, i + 1, i + 1, i + tw, i + tw + 1], k); }
  const tgeo = new THREE.BufferGeometry();
  tgeo.setAttribute('position', new THREE.BufferAttribute(tpos, 3)); tgeo.setIndex(new THREE.BufferAttribute(tidx, 1)); tgeo.computeVertexNormals();
  const terrain = new THREE.Mesh(tgeo, new THREE.MeshStandardMaterial({ color: 0xb9b4aa, roughness: 0.95 })); // 0.4 m under the voxel ground
  terrain.receiveShadow = true;
  scene.add(terrain);
  // building ids (zones.bin): the mesher keeps buildings apart and tags each vertex; one flag per building says shown
  const [zbuf, zj] = await Promise.all([fetch('data/zones.bin').then((r) => r.arrayBuffer()).then(gunzip), fetch('data/zones.json').then((r) => r.json())]);
  const bld = new Uint16Array(zbuf, W * D * 2, W * D);
  S.bldMap = { data: bld, W };
  const nb = zj.buildings.length, on = new Uint8Array(128 * Math.ceil((nb + 1) / 128));
  const onTex = new THREE.DataTexture(on, 128, on.length / 128, THREE.RedFormat, THREE.UnsignedByteType);
  onTex.unpackAlignment = 1; onTex.needsUpdate = true;
  U.uBldOn.value = onTex; U.uStage.value = 1;
  const tilesOf = zj.buildings.map((b) => { const t = [];
    for (let ty = Math.floor(b[4] / T); ty <= Math.min(d.ny - 1, Math.floor((b[6] - 1) / T)); ty++)
      for (let tx = Math.floor(b[3] / T); tx <= Math.min(d.nx - 1, Math.floor((b[5] - 1) / T)); tx++) t.push(ty * d.nx + tx);
    return t; });
  const onTile = Array.from({ length: total }, () => []);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));
  // 2. landmarks: the labelled buildings in the labels' order; their tiles are fetched first, in that order
  const bldAt = (x, y) => bld[Math.min(D - 1, Math.round(y)) * W + Math.min(W - 1, Math.round(x))] - 1;
  const landmarks = [...new Set(meta.labels.map((l) => bldAt(l.x, l.y)).filter((b) => b >= 0))], isLm = new Set(landmarks);
  const lmPrio = new Map();
  landmarks.forEach((b, j) => tilesOf[b].forEach((k) => { if (!lmPrio.has(k)) lmPrio.set(k, 1e6 - j); }));
  const prio = (tx, ty, f) => lmPrio.get(ty * d.nx + tx) ?? -Math.hypot((tx + 0.5) * T - f.x, (ty + 0.5) * T - f.z);
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, prio(tx, ty, controls.target), true);
  S.pump();
  cap.split(lmPrio.size, total); // the landmarks' tiles come first
  const depthMat = makeBuildDepthMaterial(U);
  const inTile = new Uint8Array(total), complete = new Uint8Array(nb);
  let tilesIn = 0, lmShown = 0, bShown = 0, stage = 1;
  const show = (b) => { if (!on[b + 1]) { on[b + 1] = 255; bShown++; if (isLm.has(b)) lmShown++; } };
  // labels: a building's label once it shows; the others (parks, the river) with the foliage
  const lblB = new Map(meta.labels.map((l) => [`${l.x + 0.5},${l.y + 0.5}`, bldAt(l.x, l.y)]));
  window.__labelGate = (x, z) => { const b = lblB.get(`${x},${z}`); return b >= 0 ? on[b + 1] > 0 : stage >= 3; };
  const t0 = performance.now();
  S.update = (camera) => {
    if (performance.now() - (S._t || 0) < 100) return;
    S._t = performance.now();
    S.retire();
    const f = nav.mode === 'orbit' ? controls.target : camera.position;
    let tris = 0, changed = false;
    for (const n of S.nodes.values()) {
      if (n.s !== 1) continue;
      if (n.state === 'queued') { n.prio = prio(n.tx, n.ty, f); continue; }
      if (n.state !== 'ready') continue;
      const i = n.ty * d.nx + n.tx;
      if (!inTile[i]) {
        inTile[i] = 1; tilesIn++;
        if (n.mesh) { n.mesh.customDepthMaterial = depthMat; n.mesh.visible = true; }
        for (const b of onTile[i]) if (!complete[b] && tilesOf[b].every((k) => inTile[k])) {
          complete[b] = 1;
          if (isLm.has(b) || stage >= 2) { show(b); changed = true; }
        }
      }
      if (n.mesh) tris += n.tris;
    }
    // the stages follow what has arrived: everything else once every landmark is in, the foliage once every tile is
    if (stage === 1 && lmShown === landmarks.length) { stage = 2; U.uStage.value = 2; for (let b = 0; b < nb; b++) if (complete[b]) show(b); changed = true; }
    if (stage === 2 && tilesIn === total) { stage = 3; U.uStage.value = 3; console.log(`whole city at 1 m: ${((performance.now() - t0) / 1000).toFixed(1)} s`); }
    if (changed) onTex.needsUpdate = true;
    if (window.__life) window.__life.group.visible = stage >= 3 && P.life;
    if (stage < 3) cap.show(`${stage === 1 ? 'Landmarks' : 'Buildings'} · ${tilesIn} / ${total} tiles`, tilesIn, total);
    else cap.finish(`Foliage · ${total} / ${total} tiles`);
    S.tris = tris;
    S.pump();
  };
}
