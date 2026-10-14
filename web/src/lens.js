// PROTOTYPE (proto-ghost branch): a lens decides what is sharp, and the sharpness decides the detail.
// Thin-lens depth of field of a miniature photographed with a macro lens: focus at the orbit target, aperture
// A metres in scene units. Circle of confusion at depth z: coc = A * F / zf * |1 - zf / z| px (F focal length px).
// A tile may be drawn with cells of s metres only where that blur hides them: ALPHA * (s - 1) <= A * |z / zf - 1|
// (blur radius >= ALPHA cells: at 4 a coarse tile and the 1 m truth differ in ~4 % of pixels, tools/ghosthome
// measurements). Where a coarser tile stands in while the right one loads, the pixel is blurred as much as its
// cells need, and eases into focus when the sharp tile arrives (no pop: the picture only sharpens).
// ?lens=<A m>&alpha=<4>
import * as THREE from 'three';
import { Effect, EffectAttribute, EffectPass } from 'postprocessing';

const FRAG = `
  uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform float uF; uniform float uZf; uniform float uA; uniform float uAlpha;
  uniform float uMaxR; uniform vec2 uDir; uniform sampler2D uCell; uniform vec2 uGrid;
  float radiusAt(vec2 uv, float depth) {
    if (depth >= 1.0) return min(uMaxR, uA * uF / uZf);
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0); v /= v.w;
    float z = max(1.0, -v.z);
    vec3 w = (uCamWorld * v).xyz;
    float coc = uA * uF / uZf * abs(1.0 - uZf / z);
    float cell = texture2D(uCell, w.xz / 128.0 / uGrid).r; // bilinear: the extra blur ramps across a 128 m cell, no edge
    return min(uMaxR, max(coc, uAlpha * max(0.0, cell - 1.0) * uF / z));
  }
  void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
    float r = radiusAt(uv, depth);
    outputColor = inputColor;
    if (r < 0.6) return;
    float sig = r * 0.5; vec3 acc = vec3(0.0); float wsum = 0.0;
    for (int i = -16; i <= 16; i++) {
      float t = float(i) / 16.0 * r;
      vec2 suv = uv + uDir * t * texelSize;
      // a sharp foreground pixel doesn't smear into its blurred neighbours (and vice versa, mostly)
      float rs = radiusAt(suv, readDepth(suv));
      float w = exp(-0.5 * t * t / (sig * sig)) * clamp(rs / max(abs(t), 0.5), 0.0, 1.0);
      if (i == 0) w = 1.0;
      acc += texture2D(inputBuffer, suv).rgb * w; wsum += w;
    }
    outputColor = vec4(acc / wsum, inputColor.a);
  }`;

class LensBlur extends Effect {
  constructor(dir, shared) {
    const u = new Map(Object.entries(shared).map(([k, v]) => [k, v]));
    u.set('uDir', new THREE.Uniform(new THREE.Vector2(...dir)));
    super('LensBlur', FRAG, { attributes: EffectAttribute.DEPTH, uniforms: u });
  }
}

export function installLens({ streamer: S, composer, n8, camera, renderer, controls, qs, tiltPass, P }) {
  const A = +qs.get('lens'), ALPHA = +(qs.get('alpha') || 4);
  const d1 = S.dims[1];
  const cellData = new Float32Array(d1.nx * d1.ny).fill(8), target = new Float32Array(d1.nx * d1.ny);
  const half = new Uint16Array(d1.nx * d1.ny);
  const cellTex = new THREE.DataTexture(half, d1.nx, d1.ny, THREE.RedFormat, THREE.HalfFloatType);
  cellTex.magFilter = cellTex.minFilter = THREE.LinearFilter; cellTex.wrapS = cellTex.wrapT = THREE.ClampToEdgeWrapping; cellTex.unpackAlignment = 2;
  cellTex.needsUpdate = true;
  // the stand-in while a tile loads is never coarser than 4 m: all of level 4 stays loaded (it is small)
  const d4 = S.dims[4];
  for (let ty = 0; ty < d4.ny; ty++) for (let tx = 0; tx < d4.nx; tx++) S.request(4, tx, ty, 1e9).then(() => { const n = S.nodes.get(S.key(4, tx, ty)); if (n) n.pinned = Infinity; });
  S.pump();
  const shared = { uInvProj: new THREE.Uniform(new THREE.Matrix4()), uCamWorld: new THREE.Uniform(new THREE.Matrix4()), uF: new THREE.Uniform(1000),
    uZf: new THREE.Uniform(1000), uA: new THREE.Uniform(A), uAlpha: new THREE.Uniform(ALPHA), uMaxR: new THREE.Uniform(128),
    uCell: new THREE.Uniform(cellTex), uGrid: new THREE.Uniform(new THREE.Vector2(d1.nx, d1.ny)) };
  const i = composer.passes.indexOf(n8);
  composer.addPass(new EffectPass(camera, new LensBlur([1, 0], shared)), i + 1);
  composer.addPass(new EffectPass(camera, new LensBlur([0, 1], shared)), i + 2);
  P.tilt = false; tiltPass.enabled = false;

  // detail from the lens: refine a node while the blur over it can't hide its cells
  const pick0 = S.pick.bind(S);
  S.pick = (cam, track = true) => {
    const zf = cam.position.distanceTo(controls.target);
    const cp = cam.position, fine = S.levels[S.levels.length - 1];
    const want = new Set(), refined = new Set();
    const wide = cam.clone(); wide.fov = Math.min(150, cam.fov * 1.35); wide.aspect = cam.aspect; wide.far = 20000;
    wide.updateProjectionMatrix(); wide.updateMatrixWorld();
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(wide.projectionMatrix, wide.matrixWorldInverse));
    const box = new THREE.Box3(), v = new THREE.Vector3();
    const walk = (s, tx, ty) => {
      const [x0, y0, x1, y1] = S.bounds(s, tx, ty);
      box.min.set(x0, 0, y0); box.max.set(x1, 330, y1);
      const dmin = Math.max(1, box.distanceToPoint(cp));
      let dmax = 0; for (const x of [x0, x1]) for (const z of [y0, y1]) for (const y of [0, 330]) dmax = Math.max(dmax, v.set(x, y, z).distanceTo(cp));
      const zs = zf < dmin ? dmin : zf > dmax ? dmax : zf; // the depth in the node closest to focus
      const seen = dmin < 30 || fr.intersectsBox(box);
      const k = S.key(s, tx, ty), h = S.refined.has(k) ? 0.9 : 1.1; // hysteresis: refined stays refined until the blur is 10 % wider than needed
      const hidden = ALPHA * (s - 1) <= A * Math.abs(zs / zf - 1) * h; // the blur there covers cells of s m
      if (s > fine && (seen ? !hidden : s > 4 && dmin < 600)) {
        if (track) refined.add(k);
        const c = s / 2, d = S.dims[c];
        for (let cy = ty * 2; cy < Math.min(ty * 2 + 2, d.ny); cy++) for (let cx = tx * 2; cx < Math.min(tx * 2 + 2, d.nx); cx++) walk(c, cx, cy);
      } else want.add(S.key(s, tx, ty) + '|' + dmin.toFixed(0));
    };
    const top = S.levels[0], d = S.dims[top];
    for (let ty = 0; ty < d.ny; ty++) for (let tx = 0; tx < d.nx; tx++) walk(top, tx, ty);
    if (track) S.refined = refined;
    return want;
  };
  const update0 = S.update.bind(S);
  let last = performance.now();
  S.update = (cam) => {
    update0(cam);
    const now = performance.now(), dt = Math.min(100, now - last); last = now;
    // the cell size drawn at each 128 m square, eased down (into focus) when finer tiles arrive
    target.fill(8);
    for (const n of S.nodes.values()) if (n.mesh?.visible) {
      for (let y = n.ty * n.s; y < Math.min((n.ty + 1) * n.s, d1.ny); y++) for (let x = n.tx * n.s; x < Math.min((n.tx + 1) * n.s, d1.nx); x++) target[y * d1.nx + x] = Math.min(target[y * d1.nx + x], n.s);
    }
    const ease = 1 - Math.exp(-dt / 180);
    for (let j = 0; j < cellData.length; j++) cellData[j] = target[j] > cellData[j] ? target[j] : cellData[j] + (target[j] - cellData[j]) * ease;
    for (let j = 0; j < cellData.length; j++) half[j] = THREE.DataUtils.toHalfFloat(cellData[j]);
    cellTex.needsUpdate = true;
    shared.uInvProj.value.copy(cam.projectionMatrixInverse); shared.uCamWorld.value.copy(cam.matrixWorld);
    shared.uZf.value = cam.position.distanceTo(controls.target);
    shared.uF.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(cam.fov * Math.PI / 360));
  };
  window.__lens = { shared, cellData };
}
