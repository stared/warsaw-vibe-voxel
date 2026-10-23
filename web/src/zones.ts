import * as THREE from 'three';
import { Effect, EffectAttribute, EffectPass, type EffectComposer, type Pass } from 'postprocessing';
import type { TileStreamer } from './stream';
import type { Meta, Zones } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import { makeVoxelMaterial, type VoxelUniforms, type ZoneUniforms } from './voxelMaterial';

// The real 1 m city in a shape around the focus, clay elsewhere (phones: the whole city at 1 m needs ~1 GB of GPU).
// ?shape=square|circle|building|block|budget|ragged  &r=<metres>  &budget=<M triangles>  &outside=colour  &blur=<m>
// Units (buildings, city blocks: scripts/zones.py) turn real only once every tile under them is in, so there are no
// holes; the clay (8 m tiles) and the real tiles each hide, per pixel, where the other is drawn.
const MODES: Record<string, number> = { square: 1, circle: 2, building: 3, block: 4, budget: 5, ragged: 6 };
const T = 128, C = 4;

// blur outside the real area, as wide as uCell metres look at that depth (capped at 2.5 % of the screen height)
class ZoneBlur extends Effect {
  constructor(private readonly view: THREE.PerspectiveCamera, real: THREE.Texture, W: number, D: number) {
    super('ZoneBlur', `
      uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform sampler2D uReal; uniform vec2 uSize; uniform float uFocal; uniform float uCell;
      void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
        outputColor = inputColor;
        if (depth >= 1.0) return;
        vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0); v /= v.w;
        vec3 w = (uCamWorld * v).xyz;
        float k = 1.0 - clamp(texture2D(uReal, w.xz / uSize).r * 2.0, 0.0, 1.0);
        float rad = min(k * uCell * uFocal / max(1.0, -v.z), 0.025 / texelSize.y);
        if (rad < 0.5) return;
        float rot = 6.2832 * fract(52.9829 * fract(dot(gl_FragCoord.xy, vec2(0.06711, 0.00584))));
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 32; i++) {
          float a = float(i) * 2.39996 + rot, r = sqrt((float(i) + 0.5) / 32.0) * rad;
          acc += texture2D(inputBuffer, uv + vec2(cos(a), sin(a)) * r * texelSize).rgb;
        }
        outputColor = vec4(acc / 32.0, inputColor.a);
      }`, { attributes: EffectAttribute.DEPTH, uniforms: new Map<string, THREE.Uniform>([
      ['uInvProj', new THREE.Uniform(new THREE.Matrix4())], ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())], ['uReal', new THREE.Uniform(real)],
      ['uSize', new THREE.Uniform(new THREE.Vector2(W, D))], ['uFocal', new THREE.Uniform(800)], ['uCell', new THREE.Uniform(0)]]) });
  }

  override update(renderer: THREE.WebGLRenderer) {
    const u = this.uniforms, cam = this.view;
    u.get('uInvProj')!.value.copy(cam.projectionMatrixInverse);
    u.get('uCamWorld')!.value.copy(cam.matrixWorld);
    u.get('uFocal')!.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * Math.tan(cam.fov * Math.PI / 360));
  }
}

// the real area on a 4 m grid, softened by a box blur each way, for the blur pass to look up
function realAreaMap(W: number, D: number, blk: Uint16Array, bld: Uint16Array) {
  const rw = Math.ceil(W / C), rh = Math.ceil(D / C), blk4 = new Uint16Array(rw * rh), bld4 = new Uint16Array(rw * rh);
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
    const i = Math.min(D - 1, y * C + 2) * W + Math.min(W - 1, x * C + 2);
    blk4[y * rw + x] = blk[i]; bld4[y * rw + x] = bld[i];
  }
  const data = new Uint8Array(rw * rh), tmp = new Float32Array(rw * rh), row = new Float32Array(Math.max(rw, rh));
  const tex = dataTexture(data, rw, rh, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  const boxBlur = (n: number, get: (j: number) => number, set: (j: number, v: number) => void, K = 4) => {
    for (let j = 0; j < n; j++) row[j] = get(j);
    for (let j = 0; j < n; j++) { let a = 0, c = 0; for (let k = Math.max(0, j - K); k <= Math.min(n - 1, j + K); k++) { a += row[k]; c++; } set(j, a / c); }
  };
  const fill = (real: (x: number, y: number, blk: number, bld: number) => boolean) => {
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) tmp[y * rw + x] = real(x * C + 2, y * C + 2, blk4[y * rw + x], bld4[y * rw + x]) ? 1 : 0;
    for (let y = 0; y < rh; y++) boxBlur(rw, (x) => tmp[y * rw + x], (x, v) => { tmp[y * rw + x] = v; });
    for (let x = 0; x < rw; x++) boxBlur(rh, (y) => tmp[y * rw + x], (y, v) => { data[y * rw + x] = Math.round(v * 255); });
    tex.needsUpdate = true;
  };
  return { tex, fill };
}

export async function installZones({ streamer: S, uniforms: U, meta, focus, qs, composer, n8, camera }: {
  streamer: TileStreamer;
  uniforms: VoxelUniforms & ZoneUniforms;
  meta: Meta;
  focus: () => THREE.Vector3;
  qs: URLSearchParams;
  composer: EffectComposer;
  n8: Pass;
  camera: THREE.PerspectiveCamera;
}) {
  const mode = MODES[qs.get('shape') ?? ''] ?? 4, R = +(qs.get('r') ?? 250), budget = +(qs.get('budget') ?? 2) * 1e6;
  const { W, D } = meta;
  const [zbuf, zones] = await Promise.all([fetchGzip('data/zones.bin'), fetchJson<Zones>('data/zones.json')]);
  const blkIds = new Uint16Array(zbuf, 0, W * D), bldIds = new Uint16Array(zbuf, W * D * 2, W * D);
  const ids = (a: Uint16Array) => { const t = dataTexture(a, W, D, THREE.RedIntegerFormat, THREE.UnsignedShortType); t.internalFormat = 'R16UI'; return t; };
  const flags = (n: number, w: number) => dataTexture(new Uint8Array(w * Math.ceil((n + 1) / w)), w, Math.ceil((n + 1) / w), THREE.RedFormat);
  const fBlk = flags(zones.blocks.length, 64), fBld = flags(zones.buildings.length, 128);
  const blkOn = fBlk.image.data as Uint8Array, bldOn = fBld.image.data as Uint8Array;
  U.uZBlk.value = ids(blkIds); U.uZBld.value = ids(bldIds); U.uZFBlk.value = fBlk; U.uZFBld.value = fBld;
  U.uZMode.value = mode;
  U.uZRad.value = 0;

  const clay = makeVoxelMaterial(U, { clay: true });
  clay.clay.value = qs.get('outside') === 'colour' ? 0 : 1;
  const real = realAreaMap(W, D, blkIds, bldIds), blur = new ZoneBlur(camera, real.tex, W, D);
  const blurPass = new EffectPass(camera, blur), cell = +(qs.get('blur') ?? 0);
  blur.uniforms.get('uCell')!.value = cell;
  blurPass.enabled = cell > 0;
  composer.addPass(blurPass, composer.passes.indexOf(n8) + 1);

  const d8 = S.dims[8], clayTiles = [];
  for (let ty = 0; ty < d8.ny; ty++) for (let tx = 0; tx < d8.nx; tx++) clayTiles.push(S.request(8, tx, ty, 1e9));
  S.pump();
  await Promise.all(clayTiles);
  for (const n of S.nodes.values()) if (n.s === 8 && n.mesh) { n.mesh.material = clay; n.mesh.visible = true; }

  const d1 = S.dims[1], folMat = makeVoxelMaterial(U);
  folMat.polygonOffset = true; folMat.polygonOffsetFactor = -1; folMat.polygonOffsetUnits = -2;
  const bdist = (b: number[], f: THREE.Vector3) => Math.hypot(Math.max(b[3] - f.x, 0, f.x - b[5]), Math.max(b[4] - f.z, 0, f.z - b[6])); // [cx, cy, n, x0, y0, x1, y1, tris]
  const hash = (i: number) => { let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); h ^= h >>> 13; return ((Math.imul(h, 0xc2b2ae35) >>> 0) % 1000) / 1000; };
  const tilesOf = (b: number[], out: Set<string>) => {
    for (let ty = Math.floor(b[4] / T); ty <= Math.min(d1.ny - 1, Math.floor((b[6] - 1) / T)); ty++)
      for (let tx = Math.floor(b[3] / T); tx <= Math.min(d1.nx - 1, Math.floor((b[5] - 1) / T)); tx++) out.add(S.key(1, tx, ty));
    return out;
  };
  const ready = (k: string) => S.nodes.get(k)?.state === 'ready';
  const allReady = (b: number[]) => [...tilesOf(b, new Set())].every(ready);
  const onBlk = new Set<number>(), onBld = new Set<number>();
  let shownR = 0, realKey = '', last = 0;

  // the units that should be real (entering at R, staying until 1.1 R), and the tiles they need
  const wanted = (f: THREE.Vector3) => {
    const blk: number[] = [], bld: number[] = [], need = new Set<string>();
    if (mode <= 3) tilesOf([0, 0, 0, f.x - R * 1.1, f.z - R * 1.1, f.x + R * 1.1, f.z + R * 1.1], need);
    if (mode === 3 || mode === 6) zones.buildings.forEach((b, i) => {
      const r = mode === 6 ? R * (0.6 + 0.8 * hash(i + 1)) : R;
      if (bdist(b, f) < r * (onBld.has(i + 1) ? 1.1 : 1)) { bld.push(i + 1); tilesOf(b, need); }
    });
    if (mode === 4 || mode === 6) zones.blocks.forEach((b, i) => { if (bdist(b, f) < R * (onBlk.has(i + 1) ? 1.1 : 1)) { blk.push(i + 1); tilesOf(b, need); } });
    if (mode === 5) {
      let sum = 0;
      for (const [b, i] of zones.blocks.map((b, i) => [b, i] as const).sort((a, c) => bdist(a[0], f) - bdist(c[0], f))) {
        sum += b[7] || 0;
        if (sum > budget * (onBlk.has(i + 1) ? 1.1 : 1)) break;
        blk.push(i + 1); tilesOf(b, need);
      }
    }
    return { blk, bld, need };
  };

  S.update = () => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    const f = focus();
    U.uZFocus.value.set(f.x, f.z);
    const { blk, bld, need } = wanted(f);
    for (const k of need) {
      const [tx, ty] = k.split('/')[1].split('_').map(Number), p = -Math.hypot((tx + 0.5) * T - f.x, (ty + 0.5) * T - f.z);
      S.request(1, tx, ty, p);
      S.requestFoliage(tx, ty, p - 1e4);
    }
    S.pump();
    onBlk.clear(); for (const i of blk) if (allReady(zones.blocks[i - 1])) onBlk.add(i);
    onBld.clear(); for (const i of bld) if (allReady(zones.buildings[i - 1])) onBld.add(i);
    blkOn.fill(0); for (const i of onBlk) blkOn[i] = 255; fBlk.needsUpdate = true;
    bldOn.fill(0); for (const i of onBld) bldOn[i] = 255; fBld.needsUpdate = true;
    if (mode <= 3) { if ([...need].every(ready)) shownR = R; U.uZRad.value = shownR; }
    if (blurPass.enabled) {
      const key = mode <= 3 ? `${Math.round(f.x / 4)},${Math.round(f.z / 4)},${shownR},${[...onBld]}` : `${[...onBlk]},${[...onBld]}`;
      if (key !== realKey) {
        realKey = key;
        real.fill((x, y, blkId, bldId) => {
          const dx = x - f.x, dz = y - f.z;
          if (mode === 1) return Math.max(Math.abs(dx), Math.abs(dz)) < shownR;
          if (mode === 2) return Math.hypot(dx, dz) < shownR;
          if ((mode === 3 || mode === 6) && bldId) return bldOn[bldId] > 0;
          if (mode === 3) return Math.hypot(dx, dz) < shownR;
          return blkOn[blkId] > 0;
        });
      }
    }
    for (const n of [...S.nodes.values()]) {
      if (n.s === 8) continue;
      const base = n.foliage ? S.key(1, n.tx, n.ty) : n.key;
      const on = need.has(base) && n.state === 'ready' && (!n.foliage || ready(base));
      if (n.mesh) { n.mesh.visible = on; if (n.foliage) n.mesh.material = folMat; }
      if (on) n.used = now;
      else if (n.state === 'ready' && now - n.used > 4000 && !(n.pinned > now)) S.free(n);
    }
    S.dropQueued((n) => n.s === 8 || need.has(n.foliage ? S.key(1, n.tx, n.ty) : n.key));
  };
}
