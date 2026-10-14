// PROTOTYPE (proto-ghost branch): one real level and a ghost city.
// Real: 1 m tiles in a square of the map (side SIDE metres) centred on the look-at point. Ghost: every tile of
// level GL, always loaded, drawn in a ghost style except where a real tile is on screen (uMask).
// ?ghost=<style 1..5>&side=<m>&gl=<4|8>
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';
import { Effect, EffectAttribute, EffectPass } from 'postprocessing';

// blur outside the real area, as wide as a ghost cell looks at that pixel (cell metres * focal px / depth): the
// ghost's coarser blocks then carry no visible structure that 1 m tiles would add
class FocusBlur extends Effect {
  constructor(cell = 4) {
    super('FocusBlur', `
      uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform vec2 uFocus; uniform float uRad; uniform float uFocal; uniform float uCell;
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        outputColor = inputColor;
        if (depth >= 1.0) return;
        vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0); v /= v.w;
        vec3 w = (uCamWorld * v).xyz;
        float k = smoothstep(uRad * 0.55, uRad * 0.97, length(w.xz - uFocus));
        float rad = k * uCell * uFocal / max(1.0, -v.z);
        if (rad < 0.5) return;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 32; i++) {
          float a = float(i) * 2.39996, r = sqrt((float(i) + 0.5) / 32.0) * rad;
          acc += texture2D(inputBuffer, uv + vec2(cos(a), sin(a)) * r * texelSize).rgb;
        }
        outputColor = vec4(acc / 32.0, inputColor.a);
      }`, { attributes: EffectAttribute.DEPTH, uniforms: new Map([['uInvProj', new THREE.Uniform(new THREE.Matrix4())], ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
      ['uFocus', new THREE.Uniform(new THREE.Vector2())], ['uRad', new THREE.Uniform(1e9)], ['uFocal', new THREE.Uniform(800)], ['uCell', new THREE.Uniform(cell)]]) });
  }
  set(camera, renderer, f, h) {
    const u = this.uniforms;
    u.get('uInvProj').value.copy(camera.projectionMatrixInverse); u.get('uCamWorld').value.copy(camera.matrixWorld);
    u.get('uFocus').value.set(f.x, f.z); u.get('uRad').value = h;
    u.get('uFocal').value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(camera.fov * Math.PI / 360));
  }
}

export async function installProto({ streamer: S, material, composer, n8, camera, renderer, meta, paletteTex, lampTex, controls, nav, qs }) {
  const U = material.userData.uniforms;
  U.uFow.value = +(qs.get('fow') || 0);
  const blur = qs.get('blur') ? new FocusBlur(+qs.get('blur')) : null;
  if (blur) { const i = composer.passes.indexOf(n8); composer.addPass(new EffectPass(camera, blur), i + 1); }
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
    if (n.mesh) { n.mesh.material = ghostMat; n.mesh.castShadow = !!qs.get('gshadow'); n.mesh.visible = !qs.get('gnone'); n.ghost = true; }
  }
  const proto = { side: SIDE, ghostMat };
  S.update = (camera) => {
    const now = performance.now();
    if (now - (S._t || 0) < 100) return;
    S._t = now;
    const f = nav.mode === 'orbit' ? controls.target : camera.position, h = proto.side / 2;
    U.uFocus.value.set(f.x, f.z); U.uRad.value = U.uFow.value || blur ? h : 1e9;
    if (blur) blur.set(camera, renderer, f, +(qs.get('brad') || h)); // brad: blur radius apart from the real area (to measure)
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
