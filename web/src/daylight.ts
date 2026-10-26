import * as THREE from 'three';
import { Sky } from './sky';
import { sunAt } from './sun';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';
import { visibility, WEATHERS, type FogEffect, type Weather } from './weather';

// The light of an hour on a day, under some weather: sun or moon, sky, haze and reflections. The shadow map covers
// only the part of the city in view (a square around the focus, growing with distance), snapped to whole texels so
// shadows don't shimmer.
export class Daylight {
  hour = 0;
  day = 237;
  weather: Weather = WEATHERS.clear;
  night = 0;
  readonly sky = new Sky();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
  fog: FogEffect | null = null;
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
    const sun = this.sun, hemi = this.hemi;
    sun.color.setRGB(1, lerp(0.97, 0.66, golden), lerp(0.92, 0.42, golden)).lerp(new THREE.Color(0x9fb4ff), night);
    sun.intensity = lerp(lerp(4.4, 4.8, golden), 0.5, night) * (elDeg > -2 ? smooth(-2, 3, elDeg) * day + night : night) * lerp(1, 0.08, cloud);
    sun.shadow.normalBias = clamp(0.3 / Math.max(dir.y, 0.05), 0.5, 3);
    hemi.color.set(0xbfd6ff).lerp(new THREE.Color(0xffc49a), golden * 0.5).lerp(new THREE.Color(0x4a64b0), night); // facades stay blue at night, never black
    hemi.groundColor.set(0x6b5a48).lerp(new THREE.Color(0x3a2a30), night);
    hemi.intensity = lerp(0.3, lerp(0.95, 0.6, deep), night);
    if (cloud > 0) { // under a cloud deck the light comes from the whole sky, grey and shadowless
      hemi.color.lerp(new THREE.Color(0xd4d8de).lerp(new THREE.Color(0x5a5250), night), cloud);
      hemi.groundColor.lerp(new THREE.Color(0x6e6a66).lerp(new THREE.Color(0x2a2420), night), cloud);
      hemi.intensity = lerp(hemi.intensity, lerp(1.15 * smooth(-4, 25, elDeg) + 0.45, 0.75, night), cloud);
    }
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep, cloud });
    this.lightDir.copy(dir);
    this.shadowKey = '';
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uDeep.value = deep;
      this.uniforms.uHorizon.value.copy(this.sky.horizon).convertSRGBToLinear();
      this.uniforms.uWet.value = Math.max(w.rain, w.fog * 0.3);
      this.uniforms.uSnow.value = w.cover;
      this.uniforms.uDay.value = this.day;
    }
    if (this.fog) this.setGroundFog(this.fog, w.fog, dir, elDeg, night);
    if (this.bloom) this.bloom.intensity = lerp(0.15, 0.9, night);
    this.scene.fog = new THREE.Fog(this.sky.horizon.clone(), 2500, 7000);
    const key = `${(elDeg / 0.6).toFixed(0)},${cloud}`;
    if (key !== this.envKey) { // reflections, baked only when the sky has visibly changed
      this.env?.dispose();
      this.env = this.pmrem.fromScene(this.sky.envScene(), 0, 1, 10000);
      this.scene.environment = this.env.texture;
      this.envKey = key;
    }
    this.scene.environmentIntensity = lerp(lerp(0.38, 0.7, cloud), lerp(0.55, 0.3, deep), night);
  }

  // radiation fog: a sea ~60 m deep over the river (Vistula ~4 m in the scene, the escarpment's top ~40 m), lit warm
  // from above by a low sun
  private setGroundFog(fog: FogEffect, f: number, dir: THREE.Vector3, elDeg: number, night: number) {
    fog.u('uDensity').value = f / 55;
    fog.u('uTop').value = 64;
    fog.u('uFalloff').value = 0.2;
    fog.u('uFogCol').value.copy(new THREE.Color(0xd9d8d6).lerp(new THREE.Color(0x3a3c48), night)).convertSRGBToLinear().multiplyScalar(lerp(1, 0.35, night));
    fog.u('uSunCol').value.copy(this.sun.color).multiplyScalar(smooth(-1, 6, elDeg) * (1 - smooth(10, 40, elDeg) * 0.6) * 0.9);
    fog.u('uSunDir').value.copy(dir);
  }

  // haze beyond what you look at; in rain or snow it closes in, but what you look at stays in view
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
