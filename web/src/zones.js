// PROTOTYPE (proto-ghost branch): the real 1 m city in a chosen shape around the look-at point, clay elsewhere.
// ?shape=square|circle|building|block|budget|ragged  &r=<metres, half size / radius>  &budget=<M triangles>
// Units (buildings, city blocks: scripts/zones.py) are whole: a unit turns real only once every tile under it is
// loaded, so there are never holes. The clay (8 m tiles, always loaded) and the real tiles each hide, per pixel,
// where the other is drawn (voxelMaterial.js, ZONES).
import * as THREE from 'three';
import { makeVoxelMaterial } from './voxelMaterial.js';
import { Effect, EffectAttribute, EffectPass } from 'postprocessing';

// blur outside the real area: per pixel, the world column it shows is looked up in a map of the real area (4 m cells,
// softened over ~16 m so the blur grows in from the edge); the blur is as wide as uCell metres look at that depth
class ZoneBlur extends Effect {
  constructor(real, W, D) {
    super('ZoneBlur', `
      uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform sampler2D uReal; uniform vec2 uSize; uniform float uFocal; uniform float uCell;
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        outputColor = inputColor;
        if (depth >= 1.0) return;
        vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0); v /= v.w;
        vec3 w = (uCamWorld * v).xyz;
        float k = 1.0 - clamp(texture2D(uReal, w.xz / uSize).r * 2.0, 0.0, 1.0);
        // capped at 2.5 % of the screen height: close up, a block would otherwise smear into huge blobs
        float rad = min(k * uCell * uFocal / max(1.0, -v.z), 0.025 / texelSize.y);
        if (rad < 0.5) return;
        float rot = 6.2832 * fract(52.9829 * fract(dot(gl_FragCoord.xy, vec2(0.06711, 0.00584)))); // per-pixel turn of the pattern: grain, not rings
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 32; i++) {
          float a = float(i) * 2.39996 + rot, r = sqrt((float(i) + 0.5) / 32.0) * rad;
          acc += texture2D(inputBuffer, uv + vec2(cos(a), sin(a)) * r * texelSize).rgb;
        }
        outputColor = vec4(acc / 32.0, inputColor.a);
      }`, { attributes: EffectAttribute.DEPTH, uniforms: new Map([['uInvProj', new THREE.Uniform(new THREE.Matrix4())], ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())],
      ['uReal', new THREE.Uniform(real)], ['uSize', new THREE.Uniform(new THREE.Vector2(W, D))], ['uFocal', new THREE.Uniform(800)], ['uCell', new THREE.Uniform(0)]]) });
  }
  update(renderer, input, dt) {
    const u = this.uniforms, cam = this.camera;
    u.get('uInvProj').value.copy(cam.projectionMatrixInverse); u.get('uCamWorld').value.copy(cam.matrixWorld);
    u.get('uFocal').value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(cam.fov * Math.PI / 360));
  }
}

const MODES = { square: 1, circle: 2, building: 3, block: 4, budget: 5, ragged: 6 };

export async function installZones({ streamer: S, material, meta, paletteTex, controls, nav, qs, composer, n8, camera }) {
  let mode = MODES[qs.get('shape')] || 4, R = +(qs.get('r') || 250), BUDGET = +(qs.get('budget') || 2) * 1e6;
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
  const G = clay.userData.ghost;
  G.uGStyle.value = qs.get('outside') === 'colour' ? 0 : 1;
  // the real-area map for the blur: 4 m cells, block / building ids sampled at each cell's centre
  const C = 4, rw = Math.ceil(W / C), rh = Math.ceil(D / C), blk4 = new Uint16Array(rw * rh), bld4 = new Uint16Array(rw * rh);
  { const a = new Uint16Array(zbuf, 0, W * D), b = new Uint16Array(zbuf, W * D * 2, W * D);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) { const i = Math.min(D - 1, y * C + 2) * W + Math.min(W - 1, x * C + 2); blk4[y * rw + x] = a[i]; bld4[y * rw + x] = b[i]; } }
  const realData = new Uint8Array(rw * rh), tmp = new Float32Array(rw * rh);
  const realTex = new THREE.DataTexture(realData, rw, rh, THREE.RedFormat, THREE.UnsignedByteType);
  realTex.unpackAlignment = 1; realTex.magFilter = realTex.minFilter = THREE.LinearFilter; realTex.needsUpdate = true;
  const blur = new ZoneBlur(realTex, W, D); blur.camera = camera;
  const blurPass = new EffectPass(camera, blur);
  composer.addPass(blurPass, composer.passes.indexOf(n8) + 1);
  const setBlur = (m) => { blur.uniforms.get('uCell').value = m; blurPass.enabled = m > 0; };
  setBlur(+(qs.get('blur') || 0));
  let realKey = '';
  const fillReal = (fx, fz, shownR) => { // 1 inside the real area, softened by a 4-cell box blur each way
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const i = y * rw + x, dx = x * C + 2 - fx, dz = y * C + 2 - fz, bl = bld4[i];
      let r;
      if (mode === 1) r = Math.max(Math.abs(dx), Math.abs(dz)) < shownR;
      else if (mode === 2) r = Math.hypot(dx, dz) < shownR;
      else if ((mode === 3 || mode === 6) && bl) r = fBld.image.data[bl] > 0;
      else if (mode === 3) r = Math.hypot(dx, dz) < shownR;
      else r = fBlk.image.data[blk4[i]] > 0;
      tmp[i] = r ? 1 : 0;
    }
    const K = 4, row = new Float32Array(Math.max(rw, rh));
    for (let y = 0; y < rh; y++) { for (let x = 0; x < rw; x++) row[x] = tmp[y * rw + x];
      for (let x = 0; x < rw; x++) { let a = 0, n = 0; for (let j = Math.max(0, x - K); j <= Math.min(rw - 1, x + K); j++) { a += row[j]; n++; } tmp[y * rw + x] = a / n; } }
    for (let x = 0; x < rw; x++) { for (let y = 0; y < rh; y++) row[y] = tmp[y * rw + x];
      for (let y = 0; y < rh; y++) { let a = 0, n = 0; for (let j = Math.max(0, y - K); j <= Math.min(rh - 1, y + K); j++) { a += row[j]; n++; } realData[y * rw + x] = Math.round(a / n * 255); } }
    realTex.needsUpdate = true;
  };
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
    if (blurPass.enabled) { const key = mode <= 3 ? `${mode},${Math.round(f.x / 4)},${Math.round(f.z / 4)},${shownR},${[...onBld].join()}` : `${mode},${[...onBlk].join()},${[...onBld].join()}`;
      if (key !== realKey) { realKey = key; fillReal(f.x, f.z, shownR); } }
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
  // the Experimental menu changes these live
  return { MODES, get shape() { return Object.keys(MODES).find((k) => MODES[k] === mode); },
    set shape(v) { mode = MODES[v]; U.uZMode.value = mode; S._t = 0; },
    get r() { return R; }, set r(v) { R = v; S._t = 0; },
    get budget() { return BUDGET / 1e6; }, set budget(v) { BUDGET = v * 1e6; S._t = 0; },
    get outside() { return G.uGStyle.value ? 'clay' : 'colour'; }, set outside(v) { G.uGStyle.value = v === 'clay' ? 1 : 0; },
    get blur() { return blur.uniforms.get('uCell').value; }, set blur(v) { setBlur(v); realKey = ''; S._t = 0; } };
}
