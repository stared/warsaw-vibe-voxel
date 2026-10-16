// PROTOTYPE (proto-ghost branch), engine A preview: the whole city at 1 m, no levels. ?all1m=1
// Loads progressively: the coarsest level (already preloaded) stands in as clay, and each 128 m cell turns real as
// soon as its 1 m tile is meshed, nearest to where you look first. A real tile never goes back, so nothing swaps
// twice. (No compact vertex format or temporal anti-aliasing yet: this is today's meshes, all of them.)
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';

export function installAll1m({ streamer: S, material, meta, paletteTex, controls, nav, status }) {
  const d = S.dims[1], coarse = S.levels[0], total = d.nx * d.ny;
  const maskData = new Uint8Array(d.nx * d.ny);
  const mask = new THREE.DataTexture(maskData, d.nx, d.ny, THREE.RedFormat, THREE.UnsignedByteType);
  mask.unpackAlignment = 1; mask.needsUpdate = true;
  const clay = makeVoxelMaterial({ paletteTex, lampTex: material.userData.uniforms.uLampMap.value, W: meta.W, D: meta.D, ghost: { style: 1, mask }, shared: material.userData.uniforms });
  for (const n of S.nodes.values()) if (n.mesh) { n.mesh.visible = n.s === coarse; if (n.s === coarse) { n.mesh.material = clay; n.clay = true; } }
  for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) S.request(1, tx, ty, 0, true);
  let done = 0, t0 = performance.now();
  S.update = (camera) => {
    const now = performance.now();
    if (now - (S._t || 0) < 150) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position;
    let tris = 0, ready = 0, changed = false;
    for (const n of S.nodes.values()) {
      if (n.clay) { if (n.mesh) tris += n.tris; continue; }
      if (n.s !== 1) { if (n.mesh) n.mesh.visible = false; continue; }
      if (n.state === 'queued') n.prio = -Math.hypot((n.tx + 0.5) * 128 - f.x, (n.ty + 0.5) * 128 - f.z);
      else if (n.state === 'ready') {
        ready++;
        if (n.mesh) { n.mesh.visible = true; tris += n.tris; }
        const i = n.ty * d.nx + n.tx;
        if (!maskData[i]) { maskData[i] = 255; changed = true; }
      }
    }
    if (changed) mask.needsUpdate = true;
    S.tris = tris;
    S.pump();
    if (ready !== done) {
      done = ready;
      status?.(done < total ? `Whole city at 1 m: ${done} / ${total} cells` : `Whole city at 1 m: loaded in ${((now - t0) / 1000).toFixed(1)} s`);
    }
  };
}
