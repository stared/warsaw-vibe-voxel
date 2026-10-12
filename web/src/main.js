import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, VignetteEffect, TiltShiftEffect, HueSaturationEffect, BrightnessContrastEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { makePaletteTexture, makeVoxelMaterial } from './voxelMaterial.js';
import { Sky } from './sky.js';
import { Fountains } from './fountains.js';
import { StreetLife } from './sim.js';
import { Nav, VoxelWorld } from './nav.js';
import { PlaceSearch } from './search.js';
import GUI from 'lil-gui';
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
controls.zoomSpeed = 1.4;

const nav = new Nav({ camera, controls, dom: renderer.domElement, flyTo: (v) => flyTo(v), onMode: (m) => onMode(m) });
nav.cancelFly = () => { fly = null; };

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
    const r = 20 * s;
    const gr = ctx.createRadialGradient((x + 0.5) * s, (y + 0.5) * s, 0, (x + 0.5) * s, (y + 0.5) * s, r);
    gr.addColorStop(0, 'rgba(255,196,120,0.65)');
    gr.addColorStop(0.3, 'rgba(255,176,96,0.28)');
    gr.addColorStop(0.65, 'rgba(255,160,90,0.08)');
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
let fountains = null, life = null, lastT = performance.now();
let world = null;
let uniforms, bloom, center = new THREE.Vector3(), bbox = new THREE.Box3();

function applyTime(hour) {
  state.hour = hour;
  const { el, az } = sunAt(hour);
  const elDeg = el * 180 / Math.PI;
  const night = 1 - smooth(-7, 1, elDeg);
  const deep = smooth(-9, -17, elDeg); // 0 = blue hour, 1 = full night
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
  sun.intensity = lerp(lerp(4.4, 4.8, golden), 0.5, night) * (elDeg > -2 ? smooth(-2, 3, elDeg) * day + night : night);
  // night fill: cool sky light keeps facades readable (photos: walls stay blue, never black)
  hemi.color.set(0xbfd6ff).lerp(new THREE.Color(0xffc49a), golden * 0.5).lerp(new THREE.Color(0x4a64b0), night);
  hemi.groundColor.set(0x6b5a48).lerp(new THREE.Color(0x3a2a30), night);
  hemi.intensity = lerp(0.3, lerp(0.95, 0.6, deep), night);
  const trueSun = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  sky.set(elDeg, dir, golden, night, trueSun, deep);
  sun.shadow.normalBias = Math.min(3, Math.max(0.5, 0.3 / Math.max(dir.y, 0.05)));
  updateShadowCam(dir);
  if (uniforms) { uniforms.uNight.value = night; uniforms.uDeep.value = deep; }
  if (bloom) bloom.intensity = lerp(0.15, 0.9, night) * P.bloom;
  renderer.toneMappingExposure = 1;
  scene.fog = new THREE.Fog(sky.horizon.clone(), 2500, 7000);
  // environment for reflections (regenerated only when the sky has visibly changed, so time-lapse stays cheap)
  if (!envRT || Math.abs(hour - (state.envHour ?? -99)) > 0.08) {
    if (envRT) envRT.dispose();
    envRT = pmrem.fromScene(sky.envScene(), 0, 1, 10000);
    scene.environment = envRT.texture;
    state.envHour = hour;
  }
  scene.environmentIntensity = lerp(0.38, lerp(0.55, 0.3, deep), night); // glass reflects the blue sky
  P.hour = hour;
  hourCtl?.updateDisplay();
}
const hhmm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60) % 60).padStart(2, '0')}`;

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
// Map-style pins: a dot on the building top, a hairline stem, the name above with a halo (no boxes).
// Hidden when another building is in the way (voxel ray test) or when it would collide with a more important label.
const labelEls = [];
const STEM = 20;
document.fonts?.ready.then(() => { for (const L of labelEls) L.w = 0; });
function makeLabels(meta) {
  const host = $('#labels');
  meta.labels.forEach((l, i) => {
    const el = document.createElement('div');
    el.className = 'label' + (l.highlight ? ' hl' : '') + (i < 6 ? ' major' : '');
    el.innerHTML = `<i class="dot"></i><i class="stem"></i><div class="txt"><b>${l.name}</b>${l.note ? `<span>${l.note}</span>` : ''}</div>`;
    host.appendChild(el);
    // footprint radius of the labelled building, so a ray hitting the building itself doesn't count as occlusion
    const g = world.groundAt(l.x, l.y), R = world.extent(l.x, l.y, g + Math.max(6, (l.z - g) * 0.4)) + 6;
    let edge = null;
    if (l.highlight) {
      edge = document.createElement('div');
      edge.className = 'edge off';
      edge.innerHTML = `<i>➜</i><b>${l.name}</b><small></small>`;
      edge.addEventListener('click', () => { const v = Object.values(VIEWS).find((w) => w.label === l.name.split(' ·')[0]); if (v) flyTo(v); });
      host.appendChild(edge);
    }
    labelEls.push({ el, edge, txt: el.querySelector('.txt'), p: new THREE.Vector3(l.x + 0.5, l.z + 1, l.y + 0.5), base: new THREE.Vector3(l.x + 0.5, g + 2, l.y + 0.5), R, occluded: false });
  });
}
let labelFrame = 0;
function updateLabels() {
  const host = $('#labels');
  host.style.display = P.labels ? '' : 'none';
  if (!P.labels) return;
  const v = new THREE.Vector3(), dir = new THREE.Vector3();
  // occlusion is checked a few labels per frame (voxel DDA from the camera)
  if (world) for (let k = 0; k < 4 && labelEls.length; k++) {
    const L = labelEls[labelFrame++ % labelEls.length];
    dir.subVectors(L.p, camera.position);
    const dist = dir.length();
    dir.divideScalar(dist);
    // hidden only by something else: a hit on the labelled building itself (e.g. its wall seen from below) doesn't count
    const t = world.raycast(camera.position, dir, dist);
    const hx = camera.position.x + dir.x * t - L.p.x, hz = camera.position.z + dir.z * t - L.p.z;
    L.occluded = t < dist - 3 && hx * hx + hz * hz > L.R * L.R;
  }
  // the panel is an obstacle like any placed label
  const pr = gui.domElement.getBoundingClientRect();
  const placed = gui._hidden ? [] : [{ x0: pr.left - 8, x1: pr.right, y0: pr.top, y1: pr.bottom + 8 }];
  const free = (r) => r.x0 >= 4 && r.x1 <= innerWidth - 4 && r.y0 >= 4 && r.y1 <= innerHeight - 4 &&
    !placed.some((q) => r.x0 < q.x1 + 6 && r.x1 + 6 > q.x0 && r.y0 < q.y1 + 2 && r.y1 + 2 > q.y0);
  const TOP = 8;
  for (const L of labelEls) {
    v.copy(L.p).project(camera);
    const inFront = v.z < 1;
    let x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
    if (!L.w) { L.w = L.txt.offsetWidth || 160; L.h = L.txt.offsetHeight || 30; }
    let vis = false, side = 'r', pinned = false;
    if (!L.occluded && inFront && x > -20 && x < innerWidth + 20) {
      // roof above the screen but the building itself in view: pin the label to the top edge
      if (y < TOP + STEM + L.h && y > -innerHeight * 0.8) {
        v.copy(L.base).project(camera);
        if (v.z < 1 && (-v.y * 0.5 + 0.5) * innerHeight > TOP + STEM + L.h + 30) {
          y = TOP + L.h + 4; pinned = true;
          // below the panel when the panel spans this column (phone: a full-width bar)
          if (!gui._hidden && x > pr.left - 8 && x - 4 < pr.right) y = Math.max(y, pr.bottom + 12 + L.h + 8);
        }
      }
      // no room above the anchor because of the panel bar: tuck the label just below the panel instead
      const tuck = !gui._hidden && x > pr.left - 8 && x < pr.right && y - STEM - L.h < pr.bottom + 8 && y > pr.top;
      if (tuck) { y = Math.max(y, pr.bottom + 12 + L.h + 8); pinned = true; }
      if (y <= innerHeight + 4) {
        const st = pinned ? 4 : STEM;
        const right = { x0: x - 4, x1: x + L.w, y0: y - st - L.h, y1: y + 4 };
        const left = { x0: x - L.w, x1: x + 4, y0: right.y0, y1: right.y1 };
        // slide the text along so it fits (narrow screens): stem stays on the building, text centred where it fits
        const sx = Math.min(Math.max(x - L.w / 2, 4), innerWidth - L.w - 4);
        const shifted = { x0: sx, x1: sx + L.w, y0: right.y0, y1: right.y1 };
        if (free(right)) { vis = true; placed.push(right); }
        else if (free(left)) { vis = true; side = 'l'; placed.push(left); }
        else if (L.w < innerWidth - 8 && free(shifted)) { vis = true; side = 's'; placed.push(shifted); L.shift = sx - x; }
      }
    }
    L.el.classList.toggle('off', !vis);
    L.el.classList.toggle('left', side === 'l');
    L.txt.style.left = side === 's' ? `${L.shift.toFixed(0)}px` : '';
    L.el.classList.toggle('pinned', pinned);
    if (vis) L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    // the highlighted building is always findable: an arrow on the screen edge while it is out of view
    if (L.edge) {
      const show = !vis && !L.occluded || (!vis && !(inFront && x > 0 && x < innerWidth && y > 0 && y < innerHeight));
      L.edge.classList.toggle('off', !show);
      if (show) {
        let dx = x - innerWidth / 2, dy = y - innerHeight / 2;
        if (!inFront) { dx = -dx; dy = -dy; }
        const ew = L.edge.offsetWidth || 90, ax = innerWidth / 2 - 14, ay = innerHeight / 2 - 18;
        const k = Math.min(ax / Math.max(Math.abs(dx), 1e-3), ay / Math.max(Math.abs(dy), 1e-3));
        let ex = innerWidth / 2 + dx * k, ey = innerHeight / 2 + dy * k;
        if (inFront && x > 0 && x < innerWidth && y > 0 && y < innerHeight) { ex = x; ey = y; } // on screen but crowded out
        ex = Math.min(Math.max(ex, 14), innerWidth - ew - 4); ey = Math.min(Math.max(ey, 14), innerHeight - 14);
        if (!gui._hidden && ex + ew > pr.left - 8 && ey < pr.bottom + 20) { if (ex > innerWidth / 2) ex = pr.left - ew - 8; else ey = pr.bottom + 24; } // keep clear of the panel
        const dm = Math.hypot(L.p.x - camera.position.x, L.p.z - camera.position.z);
        L.edge.querySelector('small').textContent = dm > 950 ? `${(dm / 1000).toFixed(1)} km` : `${Math.round(dm / 10) * 10} m`;
        L.edge.style.transform = `translate(${ex.toFixed(0)}px, ${ey.toFixed(0)}px)`;
        L.edge.querySelector('i').style.transform = `rotate(${Math.atan2(dy, dx).toFixed(3)}rad)`;
      }
    }
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
bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.92, luminanceSmoothing: 0.15, mipmapBlur: true, radius: 0.55 });
const tilt = new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: 0.8, feather: 0.22, kernelSize: 2 });
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

// ------------------------------------------------------------------ UI: one dat.gui-style panel holds everything
// (title, controls, key help, stats, attribution); nothing else floats over the map except the labels.
const PRESETS = { morning: 7.5, midday: 13.0, 'golden hour': 17.7, 'blue hour': 20.95, night: 23.0 };
const RATES = { off: 0, '1 min / s': 1 / 60, '10 min / s': 1 / 6, '1 h / s': 1 };
const P = {
  hour: 18.9, preset: 'golden hour', rate: 0, street: false,
  labels: true, life: true, fountains: true, tilt: true,
  fov: 28, bloom: 1, ao: 2.2, saturation: 0.12, contrast: 0.06,
  speed: 1, look: 1,
};
const gui = new GUI({ title: 'Warszawa · Śródmieście', width: 290 });
gui.domElement.classList.add('panel');
const fTime = gui.addFolder('Time');
const hourCtl = fTime.add(P, 'hour', 4.5, 23.5, 0.01).name('time').onChange((h) => { anim = null; P.preset = 'custom'; presetCtl.updateDisplay(); applyTime(h); });
hourCtl.updateDisplay = function () { this.$input.value = hhmm(this.getValue()); const t = (this.getValue() - 4.5) / 19; this.$fill.style.setProperty('width', `${t * 100}%`); return this; };
const presetCtl = fTime.add(P, 'preset', [...Object.keys(PRESETS), 'custom']).name('light').onChange((k) => { if (k in PRESETS) animateTo(PRESETS[k]); });
fTime.add(P, 'rate', RATES).name('animate day');
const fGo = gui.addFolder('Go to');
const search = new PlaceSearch(fGo.$children);
const streetCtl = fGo.add(P, 'street').name('street level').onChange((v) => nav.setMode(v ? 'walk' : 'orbit'));
const kbd = (el, k) => { el.querySelector(':scope > kbd')?.remove(); const b = document.createElement('kbd'); b.textContent = k; el.appendChild(b); };
const fShow = gui.addFolder('Show').close();
fShow.add(P, 'labels').name('labels');
fShow.add(P, 'life').name('traffic & trams').onChange((v) => { if (life) life.group.visible = v; });
fShow.add(P, 'fountains').onChange((v) => { if (fountains) fountains.mesh.visible = v; });
fShow.add(P, 'tilt').name('miniature blur');
const fCam = gui.addFolder('Camera').close();
fCam.add(P, 'fov', 15, 75, 1).name('field of view').onChange((f) => { camera.fov = f; camera.updateProjectionMatrix(); });
fCam.add(P, 'speed', 0.25, 4, 0.05).name('move speed');
fCam.add(P, 'look', 0.3, 3, 0.05).name('look speed').onChange((s) => { nav.lookSens = s; });
const fLook = gui.addFolder('Render').close();
fLook.add(P, 'bloom', 0, 3, 0.05);
fLook.add(P, 'ao', 0, 5, 0.1).name('occlusion').onChange((v) => { n8.configuration.intensity = v; });
fLook.add(P, 'saturation', -0.5, 0.6, 0.01).onChange((v) => { hueSat.saturation = v; });
fLook.add(P, 'contrast', -0.3, 0.4, 0.01).onChange((v) => { bc.contrast = v; });
const fKeys = gui.addFolder('Mouse & keys');
kbd(fKeys.$title, 'H');
const HELP = [
  ['drag', 'turn around the centre'], ['right drag', 'look around'], ['shift drag', 'slide'], ['scroll', 'zoom to cursor'], ['double-click', 'fly there'],
  ['W A S D', 'move  (shift: faster)'], ['←  →', 'turn'], ['↑  ↓', 'look up · down'], ['Q  E', 'lower · higher'],
  ['G', 'street level · Esc leaves'], ['/', 'search'], ['1 – 7', 'views (listed in search)'], ['[  ]', 'time −/+ 15 min'], ['L', 'labels'],
];
const help = document.createElement('div');
help.className = 'help';
help.innerHTML = HELP.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('');
fKeys.$children.appendChild(help);
const fAbout = gui.addFolder('About').close();
const foot = document.createElement('div');
foot.className = 'foot';
foot.innerHTML = '<div id="sources"></div><div id="stats">loading…</div>';
fAbout.$children.appendChild(foot);
// one plain sentence for first-time visitors, first thing in the panel
if (innerWidth < 600) gui.close();
function toggleHelp(show) {
  fKeys.openAnimated(show === undefined ? fKeys._closed : show);
}
function onMode(m) {
  document.body.classList.toggle('walking', m === 'walk');
  P.street = m === 'walk'; streetCtl.updateDisplay();
}
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('.lil-gui input'))) return;
  if (e.code === 'KeyG') nav.setMode(nav.mode === 'walk' ? 'orbit' : 'walk');
  else if (e.key === '/') { search.input.focus(); e.preventDefault(); }
  else if (e.code === 'KeyH' || e.key === '?') toggleHelp();
  else if (e.code === 'KeyL') { P.labels = !P.labels; gui.controllersRecursive().forEach((c) => c.updateDisplay()); }
  else if (e.code === 'BracketLeft' || e.code === 'BracketRight') { anim = null; applyTime(Math.min(23.5, Math.max(4.5, state.hour + (e.code === 'BracketLeft' ? -0.25 : 0.25)))); }
  else if (/^Digit[1-9]$/.test(e.code) && viewCtls[+e.code.slice(5) - 1]) viewCtls[+e.code.slice(5) - 1]();
});
const viewCtls = [];
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
// frame a searched place from the current compass direction, ~30° down; pin it with a temporary label
function goPlace(x, y, size, pin) {
  if (nav.mode === 'walk') nav.setMode('orbit');
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y));
  const h = Math.max(0, top - g);
  const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
  const dist = Math.min(700, Math.max(70, size * 1.4 + h * 1.6));
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z), el = 0.52;
  const pos = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  pinPlace(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
  flyTo({ pos: pos.toArray(), target: t.toArray() });
}
let pinL = null;
function pinPlace(p) {
  if (pinL) { pinL.el.remove(); labelEls.splice(labelEls.indexOf(pinL), 1); pinL = null; }
  if (!p) return;
  const el = document.createElement('div');
  el.className = 'label pick';
  el.innerHTML = `<i class="dot"></i><i class="stem"></i><div class="txt"><b>${p.name}</b><span>${p.note}</span></div>`;
  $('#labels').appendChild(el);
  pinL = { el, txt: el.querySelector('.txt'), p: new THREE.Vector3(p.x + 0.5, p.z + 1, p.y + 0.5), base: new THREE.Vector3(p.x + 0.5, p.z, p.y + 0.5), R: 40, occluded: false };
  labelEls.unshift(pinL);
}
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
  VIEWS = meta.views;
  world = nav.world = new VoxelWorld(meta, data.counts, data.runs, data.ground);
  makeLabels(meta);
  const items = [];
  Object.values(VIEWS).forEach((v, i) => {
    const go = () => { if (nav.mode === 'walk') nav.setMode('orbit'); pinPlace(null); flyTo(v); };
    viewCtls.push(go);
    items.push({ name: v.label, kind: `view ${i + 1}`, featured: true, go });
  });
  for (const l of meta.labels) items.push({ name: l.name, alt: l.note, kind: 'landmark', go: () => goPlace(l.x, l.y, 40, null) });
  fetch('data/places.json').then((r) => r.json()).then(({ places }) => {
    for (const [name, kind, x, y, size, alt] of places) items.push({ name, alt, kind, go: () => goPlace(x, y, size, { name, note: kind }) });
    search.setItems(items);
  });
  search.setItems(items);
  fountains = new Fountains(scene, meta.jets || []);
  fetch('data/traffic.json').then((r) => r.json()).then((td) => {
    life = new StreetLife(scene, td);
    window.__life = life;
    life.group.visible = P.life;
  });
  $('#stats').textContent = `${meta.W}×${meta.D} m · 1 m voxels · ${(tris / 1e6).toFixed(1)} M tris`;
  $('#sources').innerHTML = `LiDAR, orthophoto: GUGiK 2025<br>map data © OpenStreetMap contributors, ${meta.sources.osm.slice(0, 10)}`;
  const v = VIEWS[new URLSearchParams(location.search).get('view') || 'overview'] || VIEWS.overview;
  camera.position.set(...v.pos);
  controls.target.set(...v.target);
  camera.updateProjectionMatrix();
  const qh = new URLSearchParams(location.search).get('hour');
  applyTime(qh ? +qh : PRESETS['golden hour']);
  P.preset = Object.keys(PRESETS).find((k) => PRESETS[k] === state.hour) || 'custom';
  const qs = new URLSearchParams(location.search);
  if (qs.get('tilt') === '0' || innerWidth < 600) P.tilt = false;
  if (qs.get('ui') === '0') { document.body.classList.add('noui'); gui.hide(); }
  gui.controllersRecursive().forEach((c) => c.updateDisplay());
  if (qs.get('cam')) { const c = qs.get('cam').split(',').map(Number); camera.position.set(c[0], c[1], c[2]); controls.target.set(c[3], c[4], c[5]); }
  $('#loading').classList.add('hidden');
  window.__ready = true;
})();

const t0clock = performance.now();
renderer.setAnimationLoop((now) => {
  if (anim) anim(now);
  if (fly) fly(now);
  const dtf = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  if (P.rate && !anim) applyTime(state.hour + P.rate * dtf > 23.5 ? 4.5 : state.hour + P.rate * dtf);
  nav.update(dtf);
  if (nav.mode !== 'walk') { controls.update(); nav.clamp(); }
  // tilt-shift is a miniature-diorama effect; fade it out as the camera gets down to street level
  const camH = camera.position.y - 15;
  tiltPass.enabled = P.tilt && camH > 60;
  tilt.focusArea = 0.8 + 0.2 * (1 - Math.min(1, Math.max(0, (camH - 60) / 250)));
  const tsec = (performance.now() - t0clock) / 1000;
  if (uniforms) uniforms.uTime.value = tsec;
  if (fountains) fountains.update(tsec, state.night);
  if (life && life.group.visible) life.update(dtf, state.hour, state.night);
  sky.mesh.position.copy(camera.position);
  composer.render();
  updateLabels();
});
window.__three = { camera, controls, applyTime, flyTo, nav, gui, P, labelEls, scene, renderer, sun, bbox, center };
