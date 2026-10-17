// PROTOTYPE (proto-ghost branch), engine A preview: the whole city at 1 m, no levels. ?all1m=1
// Loads from nothing: no clay, no coarse stand-in. 1 m tiles load nearest to the view first (landmarks a little
// sooner); each column gets the time it became complete (its tile, or for a building the last tile under it,
// scripts/zones.py ids) and the vertex shader builds it up from then on (voxelMaterial.js BUILD_VERTEX): ground,
// then buildings rising, trees growing, details. Labels wait for their building, traffic for the whole city.
// (No compact vertex format or temporal anti-aliasing yet: this is today's meshes, all of them.)
import * as THREE from 'three';
import { makeBuildDepthMaterial, makeVoxelMaterial } from './voxelMaterial.js';

export async function installAll1m({ streamer: S, material, meta, paletteTex, controls, nav, caption: cap, P }) {
  const d = S.dims[1], total = d.nx * d.ny, U = material.userData.uniforms, { W, D } = meta, T = 128;
  // nearest first, landmarks a little sooner; nothing else streams
  S.update = () => {};
  const lmTile = new Set(meta.labels.map((l) => Math.floor(l.y / T) * d.nx + Math.floor(l.x / T)));
  const prio = (tx, ty, f) => -Math.hypot((tx + 0.5) * T - f.x, (ty + 0.5) * T - f.z) + (lmTile.has(ty * d.nx + tx) ? 300 : 0);
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, prio(tx, ty, controls.target), true);
  S.pump();
  const [zbuf, zj] = await Promise.all([
    fetch('data/zones.bin').then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    fetch('data/zones.json').then((r) => r.json())]);
  // building id per column as two bytes (RG8: an integer texture read back wrong on ANGLE/Metal after an in-tab reload)
  const idTex = new THREE.DataTexture(new Uint8Array(zbuf, W * D * 2, W * D * 2), W, D, THREE.RGFormat, THREE.UnsignedByteType);
  idTex.unpackAlignment = 2; idTex.needsUpdate = true;
  const nb = zj.buildings.length, bT = new Float32Array(128 * Math.ceil((nb + 1) / 128)).fill(1e9), tT = new Float32Array(total).fill(1e9);
  const floatTex = (a, w) => { const t = new THREE.DataTexture(a, w, a.length / w, THREE.RedFormat, THREE.FloatType); t.needsUpdate = true; return t; };
  const bTex = floatTex(bT, 128);
  U.uBldId.value = idTex; U.uBldT.value = bTex;
  const tilesOf = zj.buildings.map((b) => { const t = [];
    for (let ty = Math.floor(b[4] / T); ty <= Math.min(d.ny - 1, Math.floor((b[6] - 1) / T)); ty++)
      for (let tx = Math.floor(b[3] / T); tx <= Math.min(d.nx - 1, Math.floor((b[5] - 1) / T)); tx++) t.push(ty * d.nx + tx);
    return t; });
  const onTile = Array.from({ length: total }, () => []);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));
  const t0 = performance.now(), sec = () => (performance.now() - t0) / 1000;
  // a label shows once its building has had time to rise
  window.__labelGate = (x, z) => { const i = Math.floor(z / T) * d.nx + Math.floor(x / T); return tT[i] < 1e8 && sec() - tT[i] > 2.5; };
  let done = 0, first;
  const firstTile = new Promise((r) => { first = r; });
  S.update = (camera) => {
    U.uBT.value = sec();
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position;
    let tris = 0, ready = 0, changed = false;
    for (const n of S.nodes.values()) {
      if (n.s !== 1) { if (n.mesh) n.mesh.visible = false; continue; }
      if (n.state === 'queued') n.prio = prio(n.tx, n.ty, f);
      else if (n.state === 'ready') {
        ready++;
        if (n.mesh && !n.built) { // its own material (same compiled shader) carrying the tile's time, main and shadow pass
          const own = { ...U, uMeshT: { value: tT[n.ty * d.nx + n.tx] < 1e8 ? tT[n.ty * d.nx + n.tx] : sec() } };
          n.mesh.material = makeVoxelMaterial({ paletteTex, lampTex: U.uLampMap.value, W, D, shared: own });
          n.mesh.customDepthMaterial = makeBuildDepthMaterial(own); n.built = true;
        }
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        const i = n.ty * d.nx + n.tx;
        if (tT[i] > 1e8) {
          tT[i] = sec(); changed = true; first();
          cap.arrived(n.tx * T, n.ty * T, (n.tx + 1) * T, (n.ty + 1) * T);
          for (const b of onTile[i]) if (tilesOf[b].every((k) => tT[k] < 1e8)) bT[b + 1] = tT[i];
        }
      }
    }
    if (changed) bTex.needsUpdate = true;
    if (window.__life) window.__life.group.visible = done === total && P.life; // traffic only once the city is all there
    S.tris = tris;
    S.pump();
    if (ready !== done) { done = ready; cap.progress(done, total); if (done === total) console.log(`whole city at 1 m: ${sec().toFixed(1)} s`); }
  };
  await firstTile; // the opening caption stays until the first square starts building
}
