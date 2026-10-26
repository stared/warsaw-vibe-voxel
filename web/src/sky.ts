import * as THREE from 'three';
import { clamp } from './util';

const VERT = `varying vec3 vDir;
void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_Position.z = gl_Position.w * 0.99999; }`;

const FRAG = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uWarm; uniform float uGolden; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uTrueSun; uniform vec3 uSunCol; uniform float uNight; uniform float uDeep;
uniform vec3 uAfterglow; uniform vec3 uCityGlow; uniform vec3 uCloudLit; uniform vec3 uCloudDark; uniform float uCloud;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + .1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 sh = normalize(uSunDir.xz + 1e-5), dh = normalize(d.xz + 1e-5);
  float toward = pow(max(dot(sh, dh), 0.), 2.0);
  vec3 col = mix(mix(uHorizon, uWarm, uGolden * (0.25 + 0.75 * toward)), uTop, pow(clamp(h, 0., 1.), 0.5));
  float tw = pow(max(dot(normalize(uTrueSun.xz + 1e-5), dh), 0.), 3.0);
  col += uAfterglow * tw * exp(-max(h, 0.) * 14.0);
  col += uCityGlow * exp(-max(h, 0.) * 14.0);
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float s = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(s, 600.) * 6. * (1. - uCloud) + pow(s, 12.) * 0.35 + pow(s, 3.) * 0.12) * (1. - uNight) * (1. - 0.8 * uCloud);
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.12) * 1.4;
    float f = fbm(uv * 1.3 + vec2(3.7, 1.2));
    float cov = mix(smoothstep(0.52, 0.78, f) * smoothstep(0.02, 0.25, h), 1.0, uCloud);
    float under = 1. - smoothstep(0.02, 0.5, h);
    vec3 cl = mix(uCloudDark, uCloudLit, clamp(0.35 + 0.65 * under, 0., 1.)) + uAfterglow * tw * 0.6;
    cl *= 1. - uCloud * 0.22 * smoothstep(0.35, 0.75, f);
    col = mix(col, cl, cov * mix(0.85, 1.0, uCloud));
    if (uDeep > 0.01) col += vec3(step(0.9965, hash(floor(d * 380.)))) * uDeep * 0.2 * smoothstep(0.08, 0.4, h) * (1. - cov);
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const C = (h: number) => new THREE.Color(h);
const mixC = (a: THREE.Color, b: THREE.Color, t: number) => a.clone().lerp(b, clamp(t, 0, 1));

export interface SkyState {
  elDeg: number;
  sunDir: THREE.Vector3;
  trueSun: THREE.Vector3;
  golden: number;
  night: number;
  deep: number;
  cloud: number;
}

export class Sky {
  readonly horizon = C(0xdfe8ee);
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly u = {
    uTop: { value: C(0x6fa3d8) }, uHorizon: { value: C(0xdfe8ee) }, uGround: { value: C(0x8a8478) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTrueSun: { value: new THREE.Vector3(0, 1, 0) },
    uWarm: { value: C(0xffc89a) }, uGolden: { value: 0 }, uSunCol: { value: C(0xfff2d8) }, uNight: { value: 0 },
    uDeep: { value: 0 }, uAfterglow: { value: C(0x000000) }, uCityGlow: { value: C(0x000000) },
    uCloudLit: { value: C(0xffffff) }, uCloudDark: { value: C(0xdde3ea) }, uCloud: { value: 0 },
  };
  private env: THREE.Scene | null = null;

  constructor() {
    this.material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.u, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
  }

  // night: 0 by day .. 1 after sunset; deep: 0 at blue hour .. 1 in full night
  set({ elDeg, sunDir, trueSun, golden, night, deep, cloud }: SkyState) {
    const u = this.u;
    const nightTop = mixC(C(0x0a2f6a), C(0x050508), deep), nightHor = mixC(C(0x5a6f98), C(0x2b2922), deep);
    u.uTop.value.copy(mixC(mixC(C(0x4f8fd8), C(0x6f8fd0), golden * 0.5), nightTop, night));
    u.uHorizon.value.copy(mixC(C(0xdde8f1), nightHor, night));
    u.uWarm.value.copy(mixC(C(0xffc596), mixC(C(0x7a5a50), C(0x2b2922), deep), night));
    u.uGolden.value = golden;
    u.uGround.value.copy(mixC(C(0xc9cdd0), C(0x10121c), night));
    u.uSunDir.value.copy(sunDir);
    u.uTrueSun.value.copy(trueSun);
    u.uSunCol.value.copy(mixC(C(0xfff2d8), C(0xffa060), golden));
    u.uNight.value = night;
    u.uDeep.value = deep;
    const afterglow = Math.max(0, 1 - Math.abs(elDeg + 3) / 11) * (elDeg < 2 ? 1 : 0);
    u.uAfterglow.value.copy(C(0xff9a4a)).multiplyScalar(0.55 * afterglow);
    u.uCityGlow.value.copy(C(0x5a5244)).multiplyScalar(0.3 * night * deep);
    u.uCloudLit.value.copy(mixC(C(0xffffff), mixC(C(0x55607a), C(0x1c1b1a), deep), night));
    u.uCloudDark.value.copy(mixC(C(0xd8dfe8), mixC(C(0x22324f), C(0x0a0a0c), deep), night));
    const deckLit = mixC(C(0xc4c9cf), C(0x3e3a36), night), deckDark = mixC(C(0x8e959e), C(0x24221f), night);
    u.uCloudLit.value.lerp(deckLit, cloud);
    u.uCloudDark.value.lerp(deckDark, cloud);
    u.uHorizon.value.lerp(mixC(C(0xb8bdc2), C(0x3a3632), night), cloud);
    u.uTop.value.lerp(deckDark, cloud);
    u.uWarm.value.lerp(u.uHorizon.value, cloud);
    u.uGolden.value = golden * (1 - cloud);
    u.uCityGlow.value.multiplyScalar(1 - 0.6 * cloud);
    u.uAfterglow.value.multiplyScalar(1 - cloud);
    u.uDeep.value = deep * (1 - cloud);
    u.uCloud.value = cloud;
    this.horizon.copy(u.uHorizon.value).lerp(u.uWarm.value, golden * 0.4 * (1 - cloud));
  }

  // a small copy of the sky to bake reflections from
  envScene() {
    if (!this.env) {
      this.env = new THREE.Scene();
      this.env.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material));
    }
    return this.env;
  }
}

const WARM = new THREE.Color(0.95, 0.74, 0.4);
const PKIN_COLOURS = [0xa890e0, 0x30d060, 0xf070a8, 0x4a80ff, 0xffffff];
export function pkinLight(day: number, t: number, out: THREE.Color) {
  const r = Math.abs(Math.sin(day * 91.17 + 7.3)) * 1e4 % 1;
  if (r < 0.6) return out.copy(WARM);
  if (r < 0.9) return out.set(PKIN_COLOURS[Math.floor((r - 0.6) / 0.3 * PKIN_COLOURS.length)]).convertSRGBToLinear().lerp(WARM, 0.35);
  const k = t / 6, i = Math.floor(k) % PKIN_COLOURS.length, f = k % 1;
  return out.set(PKIN_COLOURS[i]).convertSRGBToLinear().lerp(new THREE.Color(PKIN_COLOURS[(i + 1) % PKIN_COLOURS.length]).convertSRGBToLinear(), smoothF(f)).lerp(WARM, 0.35);
}
const smoothF = (x: number) => x * x * (3 - 2 * x);
