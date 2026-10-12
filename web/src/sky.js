import * as THREE from 'three';

const vert = `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); gl_Position.z = gl_Position.w * 0.99999; }`;
const frag = `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uWarm; uniform float uGolden; uniform vec3 uGround; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform float uNight;
varying vec3 vDir;
float hash(vec3 p){ p = fract(p*0.3183099+.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec2 sh = normalize(uSunDir.xz + 1e-5), dh = normalize(d.xz + 1e-5);
  float toward = pow(max(dot(sh, dh), 0.), 2.0);
  vec3 hor = mix(uHorizon, uWarm, uGolden * (0.25 + 0.75 * toward));
  vec3 col = mix(hor, uTop, pow(clamp(h, 0., 1.), 0.5));
  col = mix(col, uGround, smoothstep(0.0, -0.25, h));
  float s = max(dot(d, uSunDir), 0.);
  col += uSunCol * (pow(s, 600.) * 6. + pow(s, 12.) * 0.35 + pow(s, 3.) * 0.12) * (1. - uNight);
  // stars
  if (uNight > 0.01 && h > 0.05) {
    vec3 q = floor(d * 380.);
    float st = step(0.9965, hash(q));
    col += vec3(st) * uNight * 0.9 * smoothstep(0.05, 0.4, h);
  }
  gl_FragColor = vec4(col, 1.);
  #include <colorspace_fragment>
}`;

const C = (h) => new THREE.Color(h);

export class Sky {
  constructor() {
    this.uniforms = {
      uTop: { value: C(0x6fa3d8) }, uHorizon: { value: C(0xdfe8ee) }, uGround: { value: C(0x8a8478) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uWarm: { value: C(0xffc89a) }, uGolden: { value: 0 }, uSunCol: { value: C(0xfff2d8) }, uNight: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(6000, 48, 24), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.horizon = C(0xdfe8ee);
  }

  set(elDeg, sunDir, golden, night) {
    const u = this.uniforms;
    const top = C(0x4f8fd8).lerp(C(0x6f8fd0), golden * 0.5).lerp(C(0x101a3a), night);
    const hor = C(0xdde8f1).lerp(C(0x2b3560), night);
    u.uWarm.value.copy(C(0xffc596).lerp(C(0x3a2a40), night));
    u.uGolden.value = golden;
    u.uTop.value.copy(top);
    u.uHorizon.value.copy(hor);
    u.uGround.value.copy(C(0xc9cdd0).lerp(C(0x0b0c12), night));
    u.uSunDir.value.copy(sunDir);
    u.uSunCol.value.copy(C(0xfff2d8).lerp(C(0xffa060), golden));
    u.uNight.value = night;
    this.horizon.copy(hor).lerp(u.uWarm.value, golden * 0.4);
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
