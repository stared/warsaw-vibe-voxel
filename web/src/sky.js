import * as THREE from 'three';

const vert = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position.z = gl_Position.w * 0.99999; }`;
const frag = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uWarm; uniform float uGolden; uniform vec3 uGround;
uniform vec3 uSunDir; uniform vec3 uTrueSun; uniform vec3 uSunCol; uniform float uNight; uniform float uDeep;
uniform vec3 uAfterglow; uniform vec3 uCityGlow; uniform vec3 uCloudLit; uniform vec3 uCloudDark;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(h2(i), h2(i+vec2(1,0)), f.x), mix(h2(i+vec2(0,1)), h2(i+vec2(1,1)), f.x), f.y); }
float fbm(vec2 p){ float a = 0.5, s = 0.; for (int i = 0; i < 5; i++){ s += a * noise(p); p = p * 2.03 + 3.1; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 sh = normalize(uSunDir.xz + 1e-5), dh = normalize(d.xz + 1e-5);
  float toward = pow(max(dot(sh, dh), 0.), 2.0);
  vec3 hor = mix(uHorizon, uWarm, uGolden * (0.25 + 0.75 * toward));
  vec3 col = mix(hor, uTop, pow(clamp(h, 0., 1.), 0.5));
  // afterglow: the sun just below the horizon leaves a warm band on its side of the sky
  vec2 th = normalize(uTrueSun.xz + 1e-5);
  float tw = pow(max(dot(th, dh), 0.), 3.0);
  float band = exp(-max(h, 0.) * 9.0);
  col += uAfterglow * tw * band;
  // light pollution: warm city glow low on the horizon all around
  col += uCityGlow * exp(-max(h, 0.) * 14.0);
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float s = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(s, 600.) * 6. + pow(s, 12.) * 0.35 + pow(s, 3.) * 0.12) * (1. - uNight);
  // clouds on a virtual plane; lit by the sun by day, from below by the city at night
  if (h > 0.02) {
    vec2 uv = d.xz / (h + 0.12) * 1.4;
    float c = fbm(uv * 1.3 + vec2(3.7, 1.2));
    float cov = smoothstep(0.52, 0.78, c) * smoothstep(0.02, 0.25, h);
    float under = 1. - smoothstep(0.02, 0.5, h);
    vec3 cl = mix(uCloudDark, uCloudLit, clamp(0.35 + 0.65 * under, 0., 1.)) + uAfterglow * tw * 0.6;
    col = mix(col, cl, cov * 0.85);
    // stars (deep night), hidden by clouds
    if (uDeep > 0.01) {
      vec3 q = floor(d * 380.);
      float st = step(0.9965, hash(q));
      col += vec3(st) * uDeep * 0.9 * smoothstep(0.08, 0.4, h) * (1. - cov);
    }
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const C = (h) => new THREE.Color(h);
const lerpC = (a, b, t) => a.clone().lerp(b, Math.min(1, Math.max(0, t)));

export class Sky {
  constructor() {
    this.uniforms = {
      uTop: { value: C(0x6fa3d8) }, uHorizon: { value: C(0xdfe8ee) }, uGround: { value: C(0x8a8478) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTrueSun: { value: new THREE.Vector3(0, 1, 0) },
      uWarm: { value: C(0xffc89a) }, uGolden: { value: 0 }, uSunCol: { value: C(0xfff2d8) }, uNight: { value: 0 },
      uDeep: { value: 0 }, uAfterglow: { value: C(0x000000) }, uCityGlow: { value: C(0x000000) },
      uCloudLit: { value: C(0xffffff) }, uCloudDark: { value: C(0xdde3ea) },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.horizon = C(0xdfe8ee);
  }

  // night: 0 day .. 1 after sunset; deep: 0 blue hour .. 1 full night
  set(elDeg, sunDir, golden, night, trueSun = sunDir, deep = night) {
    const u = this.uniforms;
    // blue hour: saturated deep blue (photos of PKiN at dusk); full night: darker navy, still not black
    const nightTop = lerpC(C(0x1c3778), C(0x0a1430), deep);
    const nightHor = lerpC(C(0x4a62a8), C(0x1e2a52), deep);
    u.uTop.value.copy(lerpC(lerpC(C(0x4f8fd8), C(0x6f8fd0), golden * 0.5), nightTop, night));
    u.uHorizon.value.copy(lerpC(C(0xdde8f1), nightHor, night));
    u.uWarm.value.copy(lerpC(C(0xffc596), C(0x6a5a88), night));
    u.uGolden.value = golden;
    u.uGround.value.copy(lerpC(C(0xc9cdd0), C(0x10121c), night));
    u.uSunDir.value.copy(sunDir);
    u.uTrueSun.value.copy(trueSun);
    u.uSunCol.value.copy(lerpC(C(0xfff2d8), C(0xffa060), golden));
    u.uNight.value = night;
    u.uDeep.value = deep;
    // afterglow strongest just after sunset, gone by ~-14°
    const glow = Math.max(0, 1 - Math.abs(elDeg + 3) / 11) * (elDeg < 2 ? 1 : 0);
    u.uAfterglow.value.copy(C(0xff7a3c)).multiplyScalar(0.55 * glow);
    u.uCityGlow.value.copy(C(0x8a5a6a)).multiplyScalar(0.35 * night);
    u.uCloudLit.value.copy(lerpC(C(0xffffff), lerpC(C(0x6a5f86), C(0x3a3550), deep), night));
    u.uCloudDark.value.copy(lerpC(C(0xd8dfe8), lerpC(C(0x223260), C(0x0e1428), deep), night));
    this.horizon.copy(u.uHorizon.value).lerp(u.uWarm.value, golden * 0.4);
  }

  envScene() {
    if (!this._env) {
      this._env = new THREE.Scene();
      this._envMesh = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), this.material);
      this._env.add(this._envMesh);
    }
    return this._env;
  }
}
