import * as THREE from 'three';
import { Sky } from './sky';
import { clamp, lerp, smooth } from './util';
import type { VoxelUniforms } from './voxelMaterial';

const LAT = 52.23 * Math.PI / 180, DECL = 8 * Math.PI / 180; // late August

// the sun's elevation and azimuth (from north, clockwise) at an hour of the day, CEST
function sunAt(hour: number) {
  const H = (hour - 12.6) * 15 * Math.PI / 180;
  const el = Math.asin(Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(DECL) * Math.cos(LAT)) + Math.PI;
  return { el, az };
}

// The light of an hour: sun or moon, sky, haze and reflections. The shadow map covers only the part of the city in
// view (a square around the focus, growing with distance), snapped to whole texels so shadows don't shimmer.
export class Daylight {
  hour = 0;
  night = 0;
  readonly sky = new Sky();
  uniforms: VoxelUniforms | null = null;
  bloom: { intensity: number } | null = null;
  private readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  private readonly hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
  private readonly pmrem: THREE.PMREMGenerator;
  private readonly lightDir = new THREE.Vector3(0, 1, 0);
  private env: THREE.WebGLRenderTarget | null = null;
  private envHour = -99;
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
    const { el, az } = sunAt(hour), elDeg = el * 180 / Math.PI;
    const night = this.night = 1 - smooth(-7, 1, elDeg), day = 1 - night;
    const deep = smooth(-9, -17, elDeg), golden = 1 - smooth(8, 34, elDeg);
    const dir = elDeg > -2 ? this.skyDir(az, Math.max(el, 2.5 * Math.PI / 180)) : new THREE.Vector3(0.45, 0.75, 0.5).normalize(); // the moon, high in the SE
    const sun = this.sun, hemi = this.hemi;
    sun.color.setRGB(1, lerp(0.97, 0.66, golden), lerp(0.92, 0.42, golden)).lerp(new THREE.Color(0x9fb4ff), night);
    sun.intensity = lerp(lerp(4.4, 4.8, golden), 0.5, night) * (elDeg > -2 ? smooth(-2, 3, elDeg) * day + night : night);
    sun.shadow.normalBias = clamp(0.3 / Math.max(dir.y, 0.05), 0.5, 3);
    hemi.color.set(0xbfd6ff).lerp(new THREE.Color(0xffc49a), golden * 0.5).lerp(new THREE.Color(0x4a64b0), night); // facades stay blue at night, never black
    hemi.groundColor.set(0x6b5a48).lerp(new THREE.Color(0x3a2a30), night);
    hemi.intensity = lerp(0.3, lerp(0.95, 0.6, deep), night);
    this.sky.set({ elDeg, sunDir: dir, trueSun: this.skyDir(az, el), golden, night, deep });
    this.lightDir.copy(dir);
    this.shadowKey = '';
    if (this.uniforms) {
      this.uniforms.uNight.value = night;
      this.uniforms.uDeep.value = deep;
      this.uniforms.uHorizon.value.copy(this.sky.horizon).convertSRGBToLinear();
    }
    if (this.bloom) this.bloom.intensity = lerp(0.15, 0.9, night);
    this.scene.fog = new THREE.Fog(this.sky.horizon.clone(), 2500, 7000);
    if (!this.env || Math.abs(hour - this.envHour) > 0.08) { // reflections, baked only when the sky has visibly changed
      this.env?.dispose();
      this.env = this.pmrem.fromScene(this.sky.envScene(), 0, 1, 10000);
      this.scene.environment = this.env.texture;
      this.envHour = hour;
    }
    this.scene.environmentIntensity = lerp(0.38, lerp(0.55, 0.3, deep), night);
  }

  // haze beyond what you look at
  setFogFrom(dist: number) {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    fog.near = Math.max(2500, dist * 1.05);
    fog.far = fog.near + 4500;
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
