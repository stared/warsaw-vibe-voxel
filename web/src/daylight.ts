import * as THREE from 'three';
import { Sky } from './sky';
import { beam, sunAt } from './sun';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';
import { visibility, WEATHERS, type Weather } from './weather';

// The city's shadow map is drawn only when the city or the light changes; what moves (traffic, people) has its own map
// from a twin of the sun, of no intensity, redrawn every frame. The sun's light is dimmed by both.
const SHADOW = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';
if (!THREE.ShaderChunk.lights_fragment_begin.includes(SHADOW)) throw new Error('three: lights_fragment_begin changed');
THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(SHADOW, `
  #if UNROLLED_LOOP_INDEX == 0 && NUM_DIR_LIGHT_SHADOWS > 1
  ${SHADOW.replace(') : 1.0;', ') * getShadow( directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, directionalLightShadows[ 1 ].shadowIntensity, directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, vDirectionalShadowCoord[ 1 ] ) : 1.0;')}
  #elif UNROLLED_LOOP_INDEX != 1
  ${SHADOW}
  #endif`);

export class Daylight {
  hour = 0;
  exposure = 1.15;
  day = 237;
  weather: Weather = WEATHERS.clear;
  night = 0;
  readonly sky = new Sky();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
  redraws = 0;
  ao: { intensity: number; aoRadius: number } | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly twin = new THREE.DirectionalLight(0xffffff, 0);
  private readonly gate = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
  private still: THREE.Object3D | null = null;
  private moving: () => THREE.Object3D | null = () => null;
  private shown: [boolean, boolean] | null = null;
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private env: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private shadowKey = '';
  private northTheta = 0;

  constructor(renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene, shadowSize = 8192) {
    const sun = this.sun, size = Math.min(shadowSize, renderer.capabilities.maxTextureSize);
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = true;
    const twin = this.twin;
    twin.castShadow = true;
    twin.shadow.mapSize.set(size, size);
    scene.add(sun, sun.target, twin, twin.target, this.hemi, this.sky.mesh);
    this.watchShadows(scene);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  // the first object the shadow pass meets: it shows each map only its own casters, and the main pass shows them all again
  private watchShadows(scene: THREE.Scene) {
    const g = this.gate;
    g.castShadow = true;
    g.frustumCulled = false;
    scene.add(g);
    scene.children.unshift(scene.children.pop()!);
    g.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
      const still = this.still, moving = this.moving();
      if (!still) return;
      this.shown ??= [still.visible, moving?.visible ?? false];
      const city = shadowCamera === this.sun.shadow.camera;
      if (city) this.redraws++;
      still.visible = city && this.shown[0];
      if (moving) moving.visible = !city && this.shown[1];
    };
    g.onBeforeRender = () => {
      if (!this.shown || !this.still) return;
      this.still.visible = this.shown[0];
      const moving = this.moving();
      if (moving) moving.visible = this.shown[1];
      this.shown = null;
    };
  }

  casters(still: THREE.Object3D, moving: () => THREE.Object3D | null) {
    this.still = still;
    this.moving = moving;
  }

  redrawShadow() { this.sun.shadow.needsUpdate = true; }

  // the grid is turned (scripts/aoi.py): compass bearings turn by theta in the scene
  set theta(t: number) { this.northTheta = t; this.apply(this.hour); }

  private skyDir(az: number, el: number) {
    const a = az + this.northTheta;
    return new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el));
  }

  apply(hour: number) {
    this.hour = hour;
    const { el, az } = sunAt(this.day, hour), elDeg = el * 180 / Math.PI, w = this.weather, cloud = w.cloud;
    const night = this.night = 1 - smooth(-7, 1, elDeg), day = 1 - night;
    const deep = smooth(-9, -17, elDeg), golden = (1 - smooth(8, 34, elDeg)) * (1 - cloud);
    const dir = elDeg > -2 ? this.skyDir(az, Math.max(el, 2.5 * Math.PI / 180)) : new THREE.Vector3(0.45, 0.75, 0.5).normalize(); // the moon, high in the SE
    const sun = this.sun, hemi = this.hemi, light = elDeg > -2 ? dir.clone().lerp(new THREE.Vector3(0, 1, 0), 0.8 * cloud).normalize() : dir;
    const T = beam(elDeg), lumT = T[0] * 0.2126 + T[1] * 0.7152 + T[2] * 0.0722, sinEl = Math.max(0, Math.sin(el));
    const sky = Math.max(0.22 * sinEl * (1 - lumT), 0.025 * smooth(-7, 2, elDeg)), sunH = lumT * sinEl;
    const adapt = clamp((0.62 / (sunH + sky)) ** 0.72, 1, 8);
    sun.color.setRGB(T[0] / T[0], T[1] / T[0], T[2] / T[0]).lerp(new THREE.Color(0xa8b4cc), night).lerp(new THREE.Color(0xd8dde6), cloud * day);
    sun.intensity = lerp(5.9 * lumT * adapt, 0.5, night) * (elDeg > -2 ? smooth(-2, 1, elDeg) * day + night : night) * lerp(1, 0.4 * sinEl, cloud);
    sun.shadow.radius = lerp(3, 22, cloud);
    sun.shadow.normalBias = clamp(0.3 / Math.max(light.y, 0.05), 0.5, 3);
    const skyRel = sky / 0.075 * adapt;
    hemi.color.setRGB(0.63, 0.77, 1).lerp(new THREE.Color(1, 0.82, 0.66), golden * 0.45).lerp(new THREE.Color(0x46557a).lerp(new THREE.Color(0x4a443c), deep), night);
    hemi.groundColor.copy(sun.color).multiplyScalar(0.4).lerp(new THREE.Color(0x4a3c2c), night);
    hemi.intensity = lerp(0.14 * skyRel, lerp(0.95, 0.5, deep), night);
    if (cloud > 0) {
      hemi.color.lerp(new THREE.Color(0xd4d8de).lerp(new THREE.Color(0x5e5850), night), cloud);
      hemi.groundColor.lerp(new THREE.Color(0x6e6a66).lerp(new THREE.Color(0x2a2420), night), cloud);
      hemi.intensity = lerp(hemi.intensity, lerp(1.6 * smooth(-4, 6, elDeg) * (0.3 + 0.7 * sinEl) ** 0.4, 1.15, night), cloud);
    }
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep, cloud });
    this.lightDir.copy(light);
    this.shadowKey = '';
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uHorizon.value.copy(this.sky.horizon).convertSRGBToLinear();
      this.uniforms.uWet.value = w.rain;
      this.uniforms.uSnow.value = w.cover;
      this.uniforms.uDay.value = this.day;
    }
    if (this.bloom) this.bloom.intensity = lerp(0.15, 0.9, night);
    if (this.ao) Object.assign(this.ao, { intensity: lerp(2.2, 3.4, cloud * day), aoRadius: lerp(6, 9, cloud * day) });
    this.scene.fog = new THREE.Fog(this.sky.horizon.clone(), 2500, 7000);
    const key = `${(elDeg / 0.6).toFixed(0)},${cloud.toFixed(1)}`;
    if (key !== this.envKey) {
      this.env?.dispose();
      this.env = this.pmrem.fromScene(this.sky.envScene(), 0, 1, 10000);
      this.scene.environment = this.env.texture;
      this.envKey = key;
    }
    this.scene.environmentIntensity = lerp(lerp(0.38 * Math.min(skyRel, 2), 0.9 * smooth(-4, 6, elDeg), cloud), lerp(0.55, 0.3, deep), night);
    const e = lerp(this.exposure, 1, night);
    sun.intensity *= e; hemi.intensity *= e; this.scene.environmentIntensity *= e;
  }

  setFogFrom(dist: number) {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    const k = visibility(this.weather);
    fog.near = Math.max(2500 * k * k, dist * (0.6 + 0.45 * k));
    fog.far = fog.near + 4500 * k;
  }

  fitShadow(focus: THREE.Vector3, camera: THREE.Camera, viewDist: number, map: THREE.Box3) {
    if (map.isEmpty()) return;
    const sun = this.sun, f = focus;
    const dist = viewDist + Math.max(0, camera.position.y - (map.min.y + 80));
    // refit in steps (a tenth in size, a sixteenth across), not every frame the view moves: each refit redraws the city
    const top = Math.max(map.max.x, map.max.z) * 0.75, R = clamp(dist * 1.15, 300, top);
    const Rq = Math.min(top, 1.1 ** Math.ceil(Math.log(R) / Math.log(1.1))), g = Rq / 16;
    const c = new THREE.Vector3(Math.round(f.x / g) * g, 0, Math.round(f.z / g) * g), Rf = Rq + 0.75 * g, texel = (2 * Rf) / sun.shadow.mapSize.x;
    const L = this.lightDir;
    const key = `${c.x},${c.z},${Rq.toFixed(1)},${L.x.toFixed(4)},${L.y.toFixed(4)}`;
    if (key !== this.shadowKey) {
      this.shadowKey = key;
      this.fitSun(c, Rf, texel, map);
    }
    this.fitTwin();
  }

  private fitSun(f: THREE.Vector3, R: number, texel: number, map: THREE.Box3) {
    const sun = this.sun, L = this.lightDir;
    const c = new THREE.Vector3(f.x, 0, f.z);
    sun.target.position.copy(c);
    sun.position.copy(c).addScaledVector(L, 2500);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    const inv = new THREE.Matrix4().lookAt(sun.position, c, new THREE.Vector3(0, 1, 0)).invert(), pts = [];
    for (const x of [f.x - R, f.x + R]) for (const z of [f.z - R, f.z + R]) for (const y of [0, map.max.y]) pts.push(new THREE.Vector3(x, y, z).sub(sun.position).applyMatrix4(inv));
    const b = new THREE.Box3().setFromPoints(pts), snap = (v: number) => Math.floor(v / texel) * texel, cam = sun.shadow.camera;
    cam.left = snap(b.min.x); cam.right = cam.left + Math.ceil((b.max.x - b.min.x) / texel) * texel;
    cam.bottom = snap(b.min.y); cam.top = cam.bottom + Math.ceil((b.max.y - b.min.y) / texel) * texel;
    cam.near = Math.max(1, -b.max.z - 700); // towers outside the square still cast into it
    cam.far = -b.min.z + 10;
    cam.updateProjectionMatrix();
    sun.shadow.needsUpdate = true;
  }

  private fitTwin() {
    const sun = this.sun, twin = this.twin, a = sun.shadow, b = twin.shadow;
    twin.position.copy(sun.position); twin.target.position.copy(sun.target.position);
    twin.updateMatrixWorld(); twin.target.updateMatrixWorld();
    const ca = a.camera, cb = b.camera;
    if (cb.left !== ca.left || cb.right !== ca.right || cb.top !== ca.top || cb.bottom !== ca.bottom || cb.near !== ca.near || cb.far !== ca.far) {
      Object.assign(cb, { left: ca.left, right: ca.right, top: ca.top, bottom: ca.bottom, near: ca.near, far: ca.far });
      cb.updateProjectionMatrix();
    }
    Object.assign(b, { bias: a.bias, normalBias: a.normalBias, radius: a.radius, intensity: a.intensity });
  }
}
