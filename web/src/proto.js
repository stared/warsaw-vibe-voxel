// PROTOTYPE (proto-ghost branch): one real level and a ghost city.
// Real: 1 m tiles in a square of the map (side SIDE metres) centred on the look-at point. Ghost: every tile of
// level GL, always loaded, drawn in a ghost style except where a real tile is on screen (uMask).
// ?ghost=<style 1..5>&side=<m>&gl=<4|8>
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';

export async function installProto({ streamer: S, material, meta, paletteTex, lampTex, controls, nav, qs }) {
  const style = +qs.get('ghost'), SIDE = +(qs.get('side') || 1024), GL = +(qs.get('gl') || 4);
  const d1 = S.dims[1], dg = S.dims[GL];
  const maskData = new Uint8Array(d1.nx * d1.ny);
  const mask = new THREE.DataTexture(maskData, d1.nx, d1.ny, THREE.RedFormat, THREE.UnsignedByteType);
  mask.unpackAlignment = 1; // rows of 31 bytes
  mask.needsUpdate = true;
  const ghostMat = makeVoxelMaterial({ paletteTex, lampTex, W: meta.W, D: meta.D, ghost: { style, mask }, shared: material.userData.uniforms });
  // the ghost: all of level GL
  const ps = [];
  for (let ty = 0; ty < dg.ny; ty++) for (let tx = 0; tx < dg.nx; tx++) ps.push(S.request(GL, tx, ty, 1e9));
  S.pump(); await Promise.all(ps);
  for (let ty = 0; ty < dg.ny; ty++) for (let tx = 0; tx < dg.nx; tx++) {
    const n = S.nodes.get(S.key(GL, tx, ty));
    if (n.mesh) { n.mesh.material = ghostMat; n.mesh.castShadow = false; n.mesh.visible = true; n.ghost = true; }
  }
  const proto = { side: SIDE, ghostMat };
  S.update = (camera) => {
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position, h = proto.side / 2;
    const want = new Map();
    for (let ty = Math.max(0, Math.floor((f.z - h) / 128)); ty <= Math.min(d1.ny - 1, Math.floor((f.z + h) / 128)); ty++)
      for (let tx = Math.max(0, Math.floor((f.x - h) / 128)); tx <= Math.min(d1.nx - 1, Math.floor((f.x + h) / 128)); tx++)
        want.set(S.key(1, tx, ty), Math.hypot((tx + 0.5) * 128 - f.x, (ty + 0.5) * 128 - f.z));
    for (const [k, dist] of want) { const [, r] = k.split('/'); const [tx, ty] = r.split('_').map(Number); S.request(1, tx, ty, -dist, dist < 450); }
    S.pump();
    maskData.fill(0);
    let tris = 0;
    for (const n of [...S.nodes.values()]) {
      if (n.ghost) { if (n.mesh) tris += n.tris; continue; }
      const on = n.s === 1 && want.has(n.key) && n.state === 'ready';
      if (n.mesh) n.mesh.visible = on;
      if (on) { maskData[n.ty * d1.nx + n.tx] = 255; tris += n.tris || 0; n.used = now; }
      else if (n.s !== 1 && n.mesh) n.mesh.visible = false;
      if (!on && n.state === 'ready' && !want.has(n.key) && now - (n.used || 0) > 4000 && n.s !== S.levels[0]) S.free(n);
    }
    // the coarsest level (preloaded fallback) stays hidden unless it is the ghost
    mask.needsUpdate = true;
    S.tris = tris;
    S.queue = S.queue.filter((n) => want.has(n.key) || n.ghost);
  };
  window.__proto = proto;
}
