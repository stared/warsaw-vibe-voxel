// PROTOTYPE (proto-ghost branch), engine A preview: the whole city at 1 m, no levels. ?all1m=1
// Loads progressively and replaces the usual preload: the coarsest level arrives first and shows as clay from its
// first tile, then each 128 m cell turns real as soon as its 1 m tile is meshed, nearest to where you look first.
// A building turns real only once every tile under it is in (scripts/zones.py building map), so no building is cut
// by the seam; traffic waits until the whole city is there. A real tile never goes back, so nothing swaps twice.
// (No compact vertex format or temporal anti-aliasing yet: this is today's meshes, all of them.)
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';

export async function installAll1m({ streamer: S, material, meta, paletteTex, controls, nav, caption: cap, P }) {
  const d = S.dims[1], coarse = S.levels[0], dc = S.dims[coarse], total = d.nx * d.ny;
  const maskData = new Uint8Array(d.nx * d.ny);
  const mask = new THREE.DataTexture(maskData, d.nx, d.ny, THREE.RedFormat, THREE.UnsignedByteType);
  mask.unpackAlignment = 1; mask.needsUpdate = true;
  // what is real, per 1 m column, kept here and uploaded as a plain R8 map (an integer id texture read back wrong
  // on ANGLE/Metal after an in-tab reload): a tile's open ground turns real with the tile, a building (zones.py ids)
  // only once every tile under it is in
  // tiles start loading at once (the clay first), while the building map arrives
  S.update = () => {};
  const clayReady = [];
  for (let ty = 0; ty < dc.ny; ty++) for (let tx = 0; tx < dc.nx; tx++) clayReady.push(S.request(coarse, tx, ty, 1e9));
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, -Math.hypot((tx + 0.5) * 128 - controls.target.x, (ty + 0.5) * 128 - controls.target.z), true);
  S.pump();
  const U = material.userData.uniforms, { W, D } = meta;
  const [zbuf, zj] = await Promise.all([
    fetch('data/zones.bin').then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
    fetch('data/zones.json').then((r) => r.json())]);
  const bld = new Uint16Array(zbuf, W * D * 2, W * D), real = new Uint8Array(W * D);
  const realTex = new THREE.DataTexture(real, W, D, THREE.RedFormat, THREE.UnsignedByteType);
  realTex.unpackAlignment = 1; realTex.needsUpdate = true;
  U.uZFBld.value = realTex; U.uZMode.value = 7;
  const tilesOf = zj.buildings.map((b) => { const t = [];
    for (let ty = Math.floor(b[4] / 128); ty <= Math.min(d.ny - 1, Math.floor((b[6] - 1) / 128)); ty++)
      for (let tx = Math.floor(b[3] / 128); tx <= Math.min(d.nx - 1, Math.floor((b[5] - 1) / 128)); tx++) t.push(ty * d.nx + tx);
    return t; });
  const onTile = Array.from({ length: d.nx * d.ny }, () => []);
  tilesOf.forEach((t, i) => t.forEach((k) => onTile[k].push(i)));
  const fill = (x0, y0, x1, y1, id) => { // id 0: open ground; else that building's columns
    for (let y = y0; y < Math.min(y1, D); y++) for (let x = x0, r = y * W; x < Math.min(x1, W); x++) if (bld[r + x] === id) real[r + x] = 255; };
  const clay = makeVoxelMaterial({ paletteTex, lampTex: material.userData.uniforms.uLampMap.value, W: meta.W, D: meta.D, ghost: { style: 1, mask }, shared: material.userData.uniforms });
  let done = 0, t0 = performance.now();
  S.update = (camera) => {
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position;
    let tris = 0, ready = 0, changed = false;
    for (const n of S.nodes.values()) {
      if (n.s === coarse) {
        if (n.mesh && !n.clay) { n.mesh.material = clay; n.clay = true; }
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        continue;
      }
      if (n.s !== 1) { if (n.mesh) n.mesh.visible = false; continue; }
      if (n.state === 'queued') n.prio = -Math.hypot((n.tx + 0.5) * 128 - f.x, (n.ty + 0.5) * 128 - f.z);
      else if (n.state === 'ready') {
        ready++;
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        const i = n.ty * d.nx + n.tx;
        if (!maskData[i]) {
          maskData[i] = 255; changed = true; cap.arrived(n.tx * 128, n.ty * 128, (n.tx + 1) * 128, (n.ty + 1) * 128);
          fill(n.tx * 128, n.ty * 128, (n.tx + 1) * 128, (n.ty + 1) * 128, 0);
          for (const b of onTile[i]) if (tilesOf[b].every((k) => maskData[k])) { const z = zj.buildings[b]; fill(z[3], z[4], z[5], z[6], b + 1); }
        }
      }
    }
    if (changed) { mask.needsUpdate = true; realTex.needsUpdate = true; }
    if (window.__life) window.__life.group.visible = done === total && P.life; // traffic only once the city is all there
    S.tris = tris;
    S.pump();
    if (ready !== done) { done = ready; cap.progress(done, total); if (done === total) console.log(`whole city at 1 m: ${((now - t0) / 1000).toFixed(1)} s`); }
  };
  S.pump();
  await Promise.all(clayReady); // the opening caption stays up until the clay city is complete
  for (const n of S.nodes.values()) if (n.s === coarse && n.mesh) { n.mesh.material = clay; n.clay = true; n.mesh.visible = true; }
  cap.start('Shaping the city');
}
