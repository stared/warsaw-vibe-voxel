import * as THREE from 'three';
import { Sky } from './sky';
import { beam, sunAt } from './sun';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';
import { visibility, WEATHERS, type Weather } from './weather';

export class Daylight {
  hour = 0;
  exposure = 1.15;
  day = 237;
  weather: Weather = WEATHERS.clear;
  night = 0;
  readonly sky = new Sky();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
  ao: { intensity: number; aoRadius: number } | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private env: THREE.WebGLRenderTarget | null = null;
  private envKey = '';
  private shadowKey = '';
  private northTheta = 0;

  constructor(renderer: THREE.WebGLRenderer, private readonly scene: THREE.Scene) {
    const sun = this.sun, size = Math.min(8192, renderer.capabilities.maxTextureSize);
    sun.castShadow = true;
    sun.shadow.mapSize.set(size, size);
    sun.shadow.bias = -0.0004;
    sun.shadow.radius = 3;
    scene.add(sun, sun.target, this.hemi, this.sky.mesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

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
    hemi.color.setRGB(0.63, 0.77, 1).lerp(new THREE.Color(0x46557a).lerp(new THREE.Color(0x4a443c), deep), night);
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
      this.uniforms.uDeep.value = deep;
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
    const R = clamp(dist * 1.15, 300, Math.max(map.max.x, map.max.z) * 0.75), texel = (2 * R) / sun.shadow.mapSize.x;
    const L = this.lightDir;
    const key = `${Math.round(f.x / (texel * 8))},${Math.round(f.z / (texel * 8))},${R.toFixed(0)},${L.x.toFixed(4)},${L.y.toFixed(4)}`;
    if (key === this.shadowKey) return;
    this.shadowKey = key;
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
}
