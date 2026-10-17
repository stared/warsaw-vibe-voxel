// PROTOTYPE (proto-ghost branch), engine A preview: the whole city at 1 m, no levels. ?all1m=1
// Loads progressively and replaces the usual preload: the coarsest level arrives first and shows as clay from its
// first tile, then each 128 m cell turns real as soon as its 1 m tile is meshed, nearest to where you look first.
// A real tile never goes back, so nothing swaps twice. (No compact vertex format or temporal anti-aliasing yet:
// this is today's meshes, all of them.)
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';

export async function installAll1m({ streamer: S, material, meta, paletteTex, controls, nav, caption: cap }) {
  const d = S.dims[1], coarse = S.levels[0], dc = S.dims[coarse], total = d.nx * d.ny;
  const maskData = new Uint8Array(d.nx * d.ny);
  const mask = new THREE.DataTexture(maskData, d.nx, d.ny, THREE.RedFormat, THREE.UnsignedByteType);
  mask.unpackAlignment = 1; mask.needsUpdate = true;
  const clay = makeVoxelMaterial({ paletteTex, lampTex: material.userData.uniforms.uLampMap.value, W: meta.W, D: meta.D, ghost: { style: 1, mask }, shared: material.userData.uniforms });
  for (let ty = 0; ty < dc.ny; ty++) for (let tx = 0; tx < dc.nx; tx++) S.request(coarse, tx, ty, 1e9);
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, 0, true);
  let done = 0, shaping = false, t0 = performance.now();
  S.update = (camera) => {
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position;
    let tris = 0, ready = 0, changed = false;
    for (const n of S.nodes.values()) {
      if (n.s === coarse) {
        if (n.mesh && !n.clay) { n.mesh.material = clay; n.clay = true; if (!shaping) { shaping = true; if (!done) cap.start('Shaping the city'); } }
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        continue;
      }
      if (n.s !== 1) { if (n.mesh) n.mesh.visible = false; continue; }
      if (n.state === 'queued') n.prio = -Math.hypot((n.tx + 0.5) * 128 - f.x, (n.ty + 0.5) * 128 - f.z);
      else if (n.state === 'ready') {
        ready++;
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        const i = n.ty * d.nx + n.tx;
        if (!maskData[i]) { maskData[i] = 255; changed = true; cap.arrived(n.tx * 128, n.ty * 128, (n.tx + 1) * 128, (n.ty + 1) * 128); }
      }
    }
    if (changed) mask.needsUpdate = true;
    S.tris = tris;
    S.pump();
    if (ready !== done) { done = ready; cap.progress(done, total); if (done === total) console.log(`whole city at 1 m: ${((now - t0) / 1000).toFixed(1)} s`); }
  };
  S.pump();
}
