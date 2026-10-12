import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, VignetteEffect, TiltShiftEffect, HueSaturationEffect, BrightnessContrastEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { makePaletteTexture, makeVoxelMaterial } from './voxelMaterial.js';
import { Sky } from './sky.js';
import { Trams } from './trams.js';
import './style.css';

const $ = (s) => document.querySelector(s);
const status = (t) => { $('#loading-text').textContent = t; };

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.NoToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
$('#app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.495; // allow near-horizontal street-level views
controls.minDistance = 4;
controls.maxDistance = 4000;
controls.screenSpacePanning = false;
controls.zoomToCursor = true; // zoom where you point, so you can dive into a street
controls.listenToKeyEvents(window); // arrow keys pan
controls.keyPanSpeed = 25;

async function loadData() {
  status('Loading voxels…');
  const [meta, groundBuf, vox] = await Promise.all([
    fetch('data/meta.json').then((r) => r.json()),
    fetch('data/ground.bin').then((r) => r.arrayBuffer()),
    fetch('data/voxels.vxl').then((r) => new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()),
  ]);
  const N = meta.W * meta.D;
  const counts = new Uint16Array(vox, 0, N);
  const runs = new Uint16Array(vox, N * 2);
  return { meta, ground: new Uint16Array(groundBuf), counts, runs };
}

function makeLampMap(meta) {
  const s = 2; // px per metre
  const cv = document.createElement('canvas');
  cv.width = meta.W * s; cv.height = meta.D * s;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y] of meta.lamps) {
    const r = 16 * s;
    const gr = ctx.createRadialGradient((x + 0.5) * s, (y + 0.5) * s, 0, (x + 0.5) * s, (y + 0.5) * s, r);
    gr.addColorStop(0, 'rgba(255,190,110,0.55)');
    gr.addColorStop(0.35, 'rgba(255,170,90,0.18)');
    gr.addColorStop(1, 'rgba(255,150,80,0)');
    ctx.fillStyle = gr;
    ctx.fillRect((x + 0.5) * s - r, (y + 0.5) * s - r, 2 * r, 2 * r);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

function buildMeshes(data, material) {
  const { meta, counts, runs } = data;
  const CS = 32;
  const jobs = [];
  for (let y0 = 0; y0 < meta.D; y0 += CS) for (let x0 = 0; x0 < meta.W; x0 += CS) jobs.push({ x0, y0 });
  const nW = Math.min(navigator.hardwareConcurrency || 4, 8);
  const group = new THREE.Group();
  let done = 0, tris = 0;
  return new Promise((resolve) => {
    let next = 0;
    for (let w = 0; w < nW; w++) {
      const worker = new Worker(new URL('./mesher.worker.js', import.meta.url), { type: 'module' });
      worker.postMessage({ type: 'init', W: meta.W, D: meta.D, counts, runs });
      const feed = () => {
        if (next < jobs.length) {
          const j = jobs[next];
          worker.postMessage({ type: 'chunk', id: next++, x0: j.x0, y0: j.y0, cs: CS });
        } else worker.terminate();
      };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { feed(); return; }
        if (m.pos.length) {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
          geo.setAttribute('vattr', new THREE.BufferAttribute(m.attr, 4));
          geo.setAttribute('vpal', new THREE.BufferAttribute(m.pal, 1));
          geo.setIndex(new THREE.BufferAttribute(m.idx, 1));
          geo.computeBoundingBox();
          geo.computeBoundingSphere();
          const mesh = new THREE.Mesh(geo, material);
          mesh.castShadow = mesh.receiveShadow = true;
          group.add(mesh);
          tris += m.idx.length / 3;
        }
        done++;
        status(`Meshing ${done}/${jobs.length} chunks · ${(tris / 1e6).toFixed(2)} M triangles`);
        if (done === jobs.length) resolve({ group, tris });
        feed();
      };
    }
  });
}

// ------------------------------------------------------------------ lighting / time of day
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.castShadow = true;
const maxTex = renderer.capabilities.maxTextureSize;
sun.shadow.mapSize.set(Math.min(8192, maxTex), Math.min(8192, maxTex));
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
sun.shadow.radius = 3;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xbfd6ff, 0x6b5a48, 0.6);
scene.add(hemi);
const sky = new Sky();
scene.add(sky.mesh);
const pmrem = new THREE.PMREMGenerator(renderer);
let envRT = null;

const LAT = 52.23 * Math.PI / 180, DECL = 8 * Math.PI / 180; // late August
function sunAt(hour) {
  const H = (hour - 12.6) * 15 * Math.PI / 180; // solar noon ~12:36 CEST
  const el = Math.asin(Math.sin(LAT) * Math.sin(DECL) + Math.cos(LAT) * Math.cos(DECL) * Math.cos(H));
  let az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(LAT) - Math.tan(DECL) * Math.cos(LAT)) + Math.PI; // from north
  return { el, az };
}
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

let state = { hour: 18.9, night: 0 };
let trams = null;
let uniforms, bloom, center = new THREE.Vector3(), bbox = new THREE.Box3();

function applyTime(hour) {
  state.hour = hour;
  const { el, az } = sunAt(hour);
  const elDeg = el * 180 / Math.PI;
  const night = 1 - smooth(-7, 1, elDeg);
  state.night = night;
  const day = 1 - night;
  const golden = 1 - smooth(8, 34, elDeg);
  // light direction: sun by day, moon (fixed high SE) at night
  const dir = new THREE.Vector3();
  if (elDeg > -2) {
    const e = Math.max(el, 2.5 * Math.PI / 180);
    dir.set(Math.sin(az) * Math.cos(e), Math.sin(e), -Math.cos(az) * Math.cos(e));
  } else dir.set(0.45, 0.75, 0.5).normalize();
  const sunCol = new THREE.Color().setRGB(1, lerp(0.97, 0.66, golden), lerp(0.92, 0.42, golden));
  const moonCol = new THREE.Color(0x9fb4ff);
  sun.color.copy(sunCol).lerp(moonCol, night);
  sun.intensity = lerp(lerp(4.4, 4.8, golden), 0.35, night) * (elDeg > -2 ? smooth(-2, 3, elDeg) * day + night : night);
  hemi.color.set(0xbfd6ff).lerp(new THREE.Color(0xffc49a), golden * 0.5).lerp(new THREE.Color(0x2a3a66), night);
  hemi.groundColor.set(0x6b5a48).lerp(new THREE.Color(0x141018), night);
  hemi.intensity = lerp(0.3, 0.12, night);
  sky.set(elDeg, dir, golden, night);
  sun.shadow.normalBias = Math.min(3, Math.max(0.5, 0.3 / Math.max(dir.y, 0.05)));
  updateShadowCam(dir);
  if (uniforms) uniforms.uNight.value = night;
  if (bloom) bloom.intensity = lerp(0.15, 1.6, night);
  renderer.toneMappingExposure = 1;
  scene.fog = new THREE.Fog(sky.horizon.clone(), 2500, 7000);
  // environment for reflections
  if (envRT) envRT.dispose();
  envRT = pmrem.fromScene(sky.envScene(), 0, 1, 10000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = lerp(0.38, 0.08, night);
  $('#hour').value = hour;
  $('#hour-label').textContent = `${String(Math.floor(hour) % 24).padStart(2, '0')}:${String(Math.round((hour % 1) * 60) % 60).padStart(2, '0')}`;
}

function updateShadowCam(dir) {
  if (bbox.isEmpty()) return;
  sun.target.position.copy(center);
  sun.position.copy(center).addScaledVector(dir, 2000);
  sun.updateMatrixWorld();
  const view = new THREE.Matrix4().lookAt(sun.position, center, new THREE.Vector3(0, 1, 0));
  const inv = view.clone().invert();
  const pts = [];
  for (const x of [bbox.min.x, bbox.max.x]) for (const y of [bbox.min.y, bbox.max.y]) for (const z of [bbox.min.z, bbox.max.z]) pts.push(new THREE.Vector3(x, y, z).sub(sun.position).applyMatrix4(inv));
  const b = new THREE.Box3().setFromPoints(pts);
  const cam = sun.shadow.camera;
  cam.left = b.min.x; cam.right = b.max.x; cam.bottom = b.min.y; cam.top = b.max.y;
  cam.near = Math.max(1, -b.max.z - 10); cam.far = -b.min.z + 10;
  cam.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}

// ------------------------------------------------------------------ labels
const labelEls = [];
function makeLabels(meta) {
  const host = $('#labels');
  for (const l of meta.labels) {
    const el = document.createElement('div');
    el.className = 'label';
    el.innerHTML = `<b>${l.name}</b>${l.note ? `<span>${l.note}</span>` : ''}`;
    host.appendChild(el);
    labelEls.push({ el, p: new THREE.Vector3(l.x + 0.5, l.z + 3, l.y + 0.5) });
  }
}
function updateLabels() {
  if (!$('#t-labels').checked) { $('#labels').style.display = 'none'; return; }
  $('#labels').style.display = '';
  const v = new THREE.Vector3();
  const placed = [];
  // labels arrive in priority order; skip any that would overlap one already shown
  for (const L of labelEls) {
    v.copy(L.p).project(camera);
    let vis = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
    const x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
    if (vis) {
      if (!L.w) { L.w = L.el.offsetWidth || 160; L.h = L.el.offsetHeight || 20; }
      const r = { x0: x - 6, x1: x - 6 + L.w, y0: y - 26, y1: y - 26 + L.h };
      vis = r.x0 >= 4 && r.x1 <= innerWidth - 4 && r.y0 >= 4 && !placed.some((q) => r.x0 < q.x1 + 4 && r.x1 + 4 > q.x0 && r.y0 < q.y1 + 2 && r.y1 + 2 > q.y0);
      if (vis) placed.push(r);
    }
    L.el.style.visibility = vis ? 'visible' : 'hidden';
    if (vis) L.el.style.transform = `translate(${x}px, ${y}px)`;
  }
}

// ------------------------------------------------------------------ post
const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
composer.addPass(new RenderPass(scene, camera));
const n8 = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
n8.configuration.aoRadius = 6;
n8.configuration.distanceFalloff = 1.5;
n8.configuration.intensity = 2.2;
n8.configuration.halfRes = true;
n8.configuration.depthAwareUpsampling = true;
composer.addPass(n8);
bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.85, luminanceSmoothing: 0.2, mipmapBlur: true, radius: 0.7 });
const tilt = new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: 0.7, feather: 0.22, kernelSize: 2 });
const qsBoot = new URLSearchParams(location.search);
const tone = new ToneMappingEffect({ mode: ToneMappingMode[qsBoot.get('tm') || 'ACES_FILMIC'] });
const hueSat = new HueSaturationEffect({ saturation: +(qsBoot.get('sat') || 0.12) });
const bc = new BrightnessContrastEffect({ brightness: 0.0, contrast: +(qsBoot.get('con') || 0.06) });
const vignette = new VignetteEffect({ offset: 0.3, darkness: 0.45 });
const tiltPass = new EffectPass(camera, tilt);
composer.addPass(new EffectPass(camera, bloom));
composer.addPass(tiltPass);
composer.addPass(new EffectPass(camera, tone, hueSat, bc, vignette, new SMAAEffect()));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------ UI
const PRESETS = { golden: 17.7, midday: 13.0, night: 22.6 };
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-preset]').forEach((x) => x.classList.toggle('on', x === b));
  animateTo(PRESETS[b.dataset.preset]);
}));
$('#hour').addEventListener('input', (e) => { document.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on')); applyTime(+e.target.value); });
$('#t-tilt').addEventListener('change', (e) => { tiltPass.enabled = e.target.checked; });
let anim = null;
function animateTo(h) {
  const from = state.hour, t0 = performance.now();
  anim = (now) => {
    const t = Math.min(1, (now - t0) / 1400);
    applyTime(lerp(from, h, t * t * (3 - 2 * t)));
    if (t >= 1) anim = null;
  };
}
let VIEWS = {};
let fly = null;
function flyTo(v) {
  const p0 = camera.position.clone(), t0v = controls.target.clone(), t0 = performance.now();
  const p1 = new THREE.Vector3(...v.pos), t1 = new THREE.Vector3(...v.target);
  fly = (now) => {
    const t = Math.min(1, (now - t0) / 1600), e = t * t * (3 - 2 * t);
    camera.position.lerpVectors(p0, p1, e);
    controls.target.lerpVectors(t0v, t1, e);
    if (t >= 1) fly = null;
  };
}

// ------------------------------------------------------------------ boot
(async () => {
  const data = await loadData();
  const { meta } = data;
  const paletteTex = makePaletteTexture(meta.palette);
  const gf = new Float32Array(data.ground.length);
  for (let i = 0; i < gf.length; i++) gf[i] = data.ground[i];
  const groundTex = new THREE.DataTexture(gf, meta.W, meta.D, THREE.RedFormat, THREE.FloatType);
  groundTex.magFilter = groundTex.minFilter = THREE.NearestFilter;
  groundTex.needsUpdate = true;
  const material = makeVoxelMaterial({ paletteTex, groundTex, lampTex: makeLampMap(meta), W: meta.W, D: meta.D });
  uniforms = material.userData.uniforms;
  const { group, tris } = await buildMeshes(data, material);
  scene.add(group);
  bbox.setFromObject(group);
  bbox.getCenter(center);
  makeLabels(meta);
  VIEWS = meta.views;
  const vhost = $('#views');
  for (const [k, v] of Object.entries(VIEWS)) {
    const b = document.createElement('button');
    b.textContent = v.label;
    b.addEventListener('click', () => flyTo(v));
    vhost.appendChild(b);
  }
  trams = new Trams(scene, meta.trams || []);
  $('#t-trams').addEventListener('change', (e) => { trams.group.visible = e.target.checked; });
  $('#stats').textContent = `${meta.W}×${meta.D} m · 1 m voxels · ${(tris / 1e6).toFixed(1)} M tris`;
  $('#sources').textContent = `LiDAR + orthophoto: GUGiK 2025 · OSM ${meta.sources.osm.slice(0, 10)}`;
  const v = VIEWS[new URLSearchParams(location.search).get('view') || 'overview'] || VIEWS.overview;
  camera.position.set(...v.pos);
  controls.target.set(...v.target);
  camera.updateProjectionMatrix();
  const qh = new URLSearchParams(location.search).get('hour');
  applyTime(qh ? +qh : PRESETS.golden);
  const qs = new URLSearchParams(location.search);
  if (qs.get('tilt') === '0') { tiltPass.enabled = false; $('#t-tilt').checked = false; }
  if (qs.get('ui') === '0') document.body.classList.add('noui');
  if (qs.get('cam')) { const c = qs.get('cam').split(',').map(Number); camera.position.set(c[0], c[1], c[2]); controls.target.set(c[3], c[4], c[5]); }
  $('#loading').classList.add('hidden');
  window.__ready = true;
})();

const t0clock = performance.now();
renderer.setAnimationLoop((now) => {
  if (anim) anim(now);
  if (fly) fly(now);
  controls.update();
  // tilt-shift is a miniature-diorama effect; fade it out as the camera gets down to street level
  const camH = camera.position.y - 15;
  tiltPass.enabled = $('#t-tilt').checked && camH > 60;
  tilt.focusArea = 0.7 + 0.3 * (1 - Math.min(1, Math.max(0, (camH - 60) / 250)));
  const tsec = (performance.now() - t0clock) / 1000;
  if (uniforms) uniforms.uTime.value = tsec;
  if (trams) trams.update(tsec, state.night);
  sky.mesh.position.copy(camera.position);
  composer.render();
  updateLabels();
});
window.__three = { camera, controls, applyTime, flyTo, scene, renderer, sun, bbox, center };
