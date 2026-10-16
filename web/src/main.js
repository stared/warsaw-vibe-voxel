import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer, RenderPass, EffectPass, BloomEffect, ToneMappingEffect, ToneMappingMode, SMAAEffect, VignetteEffect, TiltShiftEffect, HueSaturationEffect, BrightnessContrastEffect } from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { makePaletteTexture, makeVoxelMaterial } from './voxelMaterial.js';
import { Sky } from './sky.js';
import { Fountains } from './fountains.js';
import { StreetLife } from './sim.js';
import { Nav } from './nav.js';
import { TileStreamer } from './stream.js';
import { PlaceSearch } from './search.js';
import { Hud } from './hud.js';
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
controls.dampingFactor = 0.16; // short glide after letting go, not a drift
controls.rotateSpeed = 0.3;    // calm: a long drag turns a quarter round and tilts gently (play-testers found it twitchy)
controls.minDistance = 4;
controls.maxDistance = 7000; // the whole 4 x 3 km map in view even on a portrait phone, but no flinging into the void
controls.screenSpacePanning = false;
controls.zoomToCursor = true; // zoom where you point, so you can dive into a street
controls.zoomSpeed = 2.0; // a scroll notch moves noticeably; trackpad pinch is tamed separately below
if (matchMedia('(pointer: coarse)').matches) { controls.panSpeed = 1.6; controls.zoomSpeed = 1; } // fingers: the map moves and scales with them (zoomSpeed 2 squared every pinch: 2.5x fingers -> 6.5x zoom)

const nav = new Nav({ camera, controls, scene, dom: renderer.domElement, flyTo: (v) => flyTo(v), onMode: (m, r) => onMode(m, r) });
nav.cancelFly = () => { fly = null; };

async function loadData() {
  status('Loading the city…');
  return { meta: await fetch('data/meta.json').then((r) => r.json()) };
}

function makeLampMap(meta) {
  const s = 0.5; // px per metre: lamp pools are ~40 m wide; 2 m texels look the same and the 4 x 3 km map fits in 12 MB
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
  // floodlit pitches (stadium infields): an even cool-white wash, fading out over the lower stands
  for (const [x, y, r0] of meta.floods || []) {
    const r = r0 * 1.35 * s;
    const gr = ctx.createRadialGradient(x * s, y * s, 0, x * s, y * s, r);
    gr.addColorStop(0, 'rgba(225,235,255,0.6)');
    gr.addColorStop(0.7, 'rgba(225,235,255,0.52)');
    gr.addColorStop(1, 'rgba(225,235,255,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(x * s - r, y * s - r, 2 * r, 2 * r);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false; // canvas row 0 = grid row 0 (with the default flip every pool was mirrored across the map)
  return tex;
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
let theta = 0; // the grid is rotated (scripts/aoi.py): compass bearings turn by theta in scene coordinates
// unit vector toward azimuth az (from north, clockwise) at elevation el, in scene axes (x east-ish, z south-ish)
const sky3 = (az, el) => { const a = az + theta; return new THREE.Vector3(Math.sin(a) * Math.cos(el), Math.sin(el), -Math.cos(a) * Math.cos(el)); };
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
let uniforms, bloom, center = new THREE.Vector3(), bbox = new THREE.Box3(), streamer = null;

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
    dir.copy(sky3(az, e));
  } else dir.set(0.45, 0.75, 0.5).normalize();
  const sunCol = new THREE.Color().setRGB(1, lerp(0.97, 0.66, golden), lerp(0.92, 0.42, golden));
  const moonCol = new THREE.Color(0x9fb4ff);
  sun.color.copy(sunCol).lerp(moonCol, night);
  sun.intensity = lerp(lerp(4.4, 4.8, golden), 0.5, night) * (elDeg > -2 ? smooth(-2, 3, elDeg) * day + night : night);
  // night fill: cool sky light keeps facades readable (photos: walls stay blue, never black)
  hemi.color.set(0xbfd6ff).lerp(new THREE.Color(0xffc49a), golden * 0.5).lerp(new THREE.Color(0x4a64b0), night);
  hemi.groundColor.set(0x6b5a48).lerp(new THREE.Color(0x3a2a30), night);
  hemi.intensity = lerp(0.3, lerp(0.95, 0.6, deep), night);
  const trueSun = sky3(az, el);
  sky.set(elDeg, dir, golden, night, trueSun, deep);
  sun.shadow.normalBias = Math.min(3, Math.max(0.5, 0.3 / Math.max(dir.y, 0.05)));
  updateShadowCam(dir);
  if (uniforms) { uniforms.uNight.value = night; uniforms.uDeep.value = deep; }
  if (bloom) bloom.intensity = lerp(0.15, 0.9, night) * P.bloom;
  renderer.toneMappingExposure = 1;
  scene.fog = new THREE.Fog(sky.horizon.clone(), 2500, 7000);
  if (uniforms) uniforms.uHorizon.value.copy(sky.horizon).convertSRGBToLinear();
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

// The shadow map covers the part of the city in view, not all 4 x 3 km: a square around the focus that grows with
// camera distance (600 m at street level -> sharper than before; the whole map from far away, where a texel
// is still smaller than a pixel). Snapped to whole texels in light space so shadows don't shimmer as you move.
let lightDir = new THREE.Vector3(0, 1, 0), shadowKey = '';
function updateShadowCam(dir) { lightDir.copy(dir); shadowKey = ''; }
function fitShadow() {
  if (bbox.isEmpty()) return;
  const f = nav.mode === 'orbit' ? controls.target : camera.position;
  const dist = camera.position.distanceTo(controls.target) + Math.max(0, camera.position.y - (bbox.min.y + 80));
  const R = THREE.MathUtils.clamp(dist * 1.15, 300, Math.max(bbox.max.x, bbox.max.z) * 0.75);
  const cam = sun.shadow.camera, texel = (2 * R) / sun.shadow.mapSize.x;
  const key = `${Math.round(f.x / (texel * 8))},${Math.round(f.z / (texel * 8))},${R.toFixed(0)},${lightDir.x.toFixed(4)},${lightDir.y.toFixed(4)}`;
  if (key === shadowKey) return;
  shadowKey = key;
  const c = new THREE.Vector3(f.x, 0, f.z);
  sun.target.position.copy(c);
  sun.position.copy(c).addScaledVector(lightDir, 2500);
  sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
  const view = new THREE.Matrix4().lookAt(sun.position, c, new THREE.Vector3(0, 1, 0)), inv = view.clone().invert();
  const pts = [];
  for (const x of [f.x - R, f.x + R]) for (const z of [f.z - R, f.z + R]) for (const y of [0, bbox.max.y]) pts.push(new THREE.Vector3(x, y, z).sub(sun.position).applyMatrix4(inv));
  const b = new THREE.Box3().setFromPoints(pts);
  const sn = (v) => Math.floor(v / texel) * texel; // whole-texel snapping
  cam.left = sn(b.min.x); cam.right = sn(b.min.x) + Math.ceil((b.max.x - b.min.x) / texel) * texel;
  cam.bottom = sn(b.min.y); cam.top = sn(b.min.y) + Math.ceil((b.max.y - b.min.y) / texel) * texel;
  cam.near = Math.max(1, -b.max.z - 700); cam.far = -b.min.z + 10; // 700 m toward the sun: towers outside still cast in
  cam.updateProjectionMatrix();
  sun.shadow.needsUpdate = true;
}

// ------------------------------------------------------------------ labels
// Map-style pins: a dot on the building top, a hairline stem, the name above with a halo (no boxes).
// Hidden when another building is in the way (voxel ray test) or when it would collide with a more important label.
const labelEls = [];
const STEM = 20;
document.fonts?.ready.then(() => { for (const L of labelEls) L.w = L.ew = 0; });
function makeLabels(meta) {
  const host = $('#labels');
  meta.labels.forEach((l, i) => {
    const el = document.createElement('div');
    el.className = 'label' + (l.highlight ? ' hl' : '') + (i < 6 ? ' major' : '');
    el.innerHTML = `<i class="dot"></i><i class="stem"></i><div class="txt"><b>${l.name}</b>${l.note ? `<span>${l.note}</span>` : ''}</div>`;
    host.appendChild(el);
    // a label is a link: click it to fly to the building (or, at street level, walk to it)
    el.querySelector('.txt').addEventListener('click', () => {
      const v = Object.values(VIEWS).find((w) => w.label === l.name.split(' ·')[0]);
      if (v && nav.mode === 'orbit') { pinPlace(null); flyTo(v); } else goPlace(l.x, l.y, 60, null, l.name);
    });
    // footprint radius of the labelled building, so a ray hitting the building itself doesn't count as occlusion
    const g = l.g ?? 0, R = (l.R ?? 30) + 6; // footprint radius, computed offline (scripts/voxelize.py)
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
// panel rect is cached (reading it every frame forces a layout); refreshed whenever the panel or window changes size
let panelRect = null;
const measurePanel = () => { panelRect = gui.domElement.getBoundingClientRect(); };
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
  if (!panelRect) measurePanel();
  const pr = panelRect;
  const placed = gui._hidden ? [] : [{ x0: pr.left - 8, x1: pr.right, y0: pr.top, y1: pr.bottom + 8 }];
  if (hud) placed.push(...hud.rects); // and so are the on-screen buttons
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
        const dm = Math.hypot(L.p.x - camera.position.x, L.p.z - camera.position.z);
        const dist = dm > 950 ? `${(dm / 1000).toFixed(1)} km` : `${Math.round(dm / 10) * 10} m`;
        if (dist !== L.dist) { L.edge.querySelector('small').textContent = L.dist = dist; L.ew = 0; }
        if (!L.ew) L.ew = L.edge.offsetWidth; // re-measured only when its text changed (0 while still hidden -> retry)
        const ew = L.ew || 90, ax = innerWidth / 2 - 14, ay = innerHeight / 2 - 18;
        const k = Math.min(ax / Math.max(Math.abs(dx), 1e-3), ay / Math.max(Math.abs(dy), 1e-3));
        let ex = innerWidth / 2 + dx * k, ey = innerHeight / 2 + dy * k;
        if (inFront && x > 0 && x < innerWidth && y > 0 && y < innerHeight) { ex = x; ey = y; } // on screen but crowded out
        ex = Math.min(Math.max(ex, 14), innerWidth - ew - 4); ey = Math.min(Math.max(ey, 14), innerHeight - 14);
        if (!gui._hidden && ex + ew > pr.left - 8 && ey < pr.bottom + 20) { if (ex > innerWidth / 2) ex = pr.left - ew - 8; else ey = pr.bottom + 24; } // keep clear of the panel
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

// trackpad pinch arrives as Ctrl+wheel, which OrbitControls amplifies 10x (a small pinch flew kilometres);
// re-send it as a plain wheel at ~3x so a pinch and a two-finger scroll zoom at a steady, similar pace
renderer.domElement.addEventListener('wheel', (e) => {
  if (!e.ctrlKey || !e.isTrusted || nav.mode !== 'orbit') return;
  e.stopImmediatePropagation(); e.preventDefault();
  renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY * 3, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }));
}, { capture: true, passive: false });

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
  panelRect = null;
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
const gui = new GUI({ title: 'Warszawa', width: 290 });
gui.domElement.classList.add('panel');
new ResizeObserver(() => { panelRect = null; }).observe(gui.domElement);
const fTime = gui.addFolder('Time');
const hourCtl = fTime.add(P, 'hour', 4.5, 23.5, 0.01).name('time').onChange((h) => { anim = null; P.preset = 'custom'; presetCtl.updateDisplay(); applyTime(h); });
hourCtl.updateDisplay = function () { if (document.activeElement !== this.$input) this.$input.value = hhmm(this.getValue()); const t = (this.getValue() - 4.5) / 19; this.$fill.style.setProperty('width', `${t * 100}%`); return this; };
hourCtl.$input.type = 'text'; // lil-gui makes it type=number on touch devices, which refuses "17:42" (blank readout)
hourCtl.domElement.classList.add('time'); // wider slider: a whole day in ~95 px was too twitchy to find dusk
// typed times ("18:05", "18.5", "18") are read when you press Enter or leave the field; lil-gui parsed every keystroke and snapped to 04:30
const commitTime = () => {
  const m = hourCtl.$input.value.trim().match(/^(\d{1,2})(?:\s*[:h]\s*(\d{1,2})|[.,](\d+))?$/);
  if (m) hourCtl.setValue(Math.min(23.5, Math.max(4.5, +m[1] + (m[2] ? +m[2] / 60 : m[3] ? +('0.' + m[3]) : 0))));
  hourCtl.updateDisplay();
};
for (const ev of ['input', 'change', 'blur']) hourCtl.$input.addEventListener(ev, (e) => { e.stopImmediatePropagation(); if (ev !== 'input') commitTime(); }, true);
hourCtl.$input.addEventListener('keydown', (e) => { e.stopImmediatePropagation(); e.stopPropagation(); if (e.key === 'Enter') hourCtl.$input.blur(); }, true);
const presetCtl = fTime.add(P, 'preset', [...Object.keys(PRESETS), 'custom']).name('light').onChange((k) => { if (k in PRESETS) animateTo(PRESETS[k]); });
fTime.add(P, 'rate', RATES).name('animate day');
const fGo = gui.addFolder('Go to');
const search = new PlaceSearch(fGo.$children);
search.onPick = () => { if (innerWidth < 600) gui.close(); }; // phone: get the panel out of the way of where we fly
renderer.domElement.addEventListener('pointerdown', () => { if (innerWidth < 600 && !gui._closed) gui.close(); }); // phone: tapping the map puts the panel away
const streetCtl = fGo.add(P, 'street').name('street level').onChange((v) => { if (v) nav.setMode('walk'); else nav.flyUp(); });
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
fCam.add(nav, 'gameLook').name('game-style look'); // drag turns your head (as in games) instead of moving the picture
const fLook = gui.addFolder('Render').close();
fLook.add(P, 'bloom', 0, 3, 0.05);
fLook.add(P, 'ao', 0, 5, 0.1).name('occlusion').onChange((v) => { n8.configuration.intensity = v; });
fLook.add(P, 'saturation', -0.5, 0.6, 0.01).onChange((v) => { hueSat.saturation = v; });
fLook.add(P, 'contrast', -0.3, 0.4, 0.01).onChange((v) => { bc.contrast = v; });
const fKeys = gui.addFolder('Mouse & keys').close(); // the HUD bar carries the essentials
kbd(fKeys.$title, 'H');
const HELP = [
  ['drag', 'move the map'], ['right / shift drag', 'rotate & tilt'], ['scroll · pinch', 'zoom to cursor'], ['double-click', 'fly there'],
  ['click a tram, car, person', 'ride along'], ['🚶 button', 'street view (drag it onto a street)'],
  ['street: drag', 'look around'], ['street: click', 'walk there'], ['W A S D', 'move  (shift: faster) · Space jump'],
  ['G · Esc', 'street level · back up'], ['/', 'search'], ['1 – 7', 'views'], ['[  ]', 'time −/+ 15 min'], ['L', 'labels'],
];
const help = document.createElement('div');
help.className = 'help';
help.innerHTML = HELP.map(([k, v]) => `<span class="k">${k}</span><span>${v}</span>`).join('');
fKeys.$children.appendChild(help);
const fAbout = gui.addFolder('About').close();
const foot = document.createElement('div');
foot.className = 'foot';
foot.innerHTML = '<div id="sources"></div><div id="stats">loading…</div><div><a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">source code on GitHub</a></div>';
fAbout.$children.appendChild(foot);
// one plain sentence for first-time visitors, first thing in the panel
if (innerWidth < 600) gui.close();
function toggleHelp(show) {
  fKeys.openAnimated(show === undefined ? fKeys._closed : show);
}
function onMode(m, ride) {
  document.body.classList.toggle('walking', m !== 'orbit');
  P.street = m !== 'orbit'; streetCtl.updateDisplay();
  hud?.set(m, ride);
  if (m !== 'orbit' && innerWidth < 1200) gui.close(); // the street and the ride need the whole screen
}
// keep the focus over the city: zooming out at a grazing angle must not slide the view off the edge of the map
function keepInside() {
  if (bbox.isEmpty()) return;
  const t = controls.target, m = 60;
  const cx = Math.min(Math.max(t.x, bbox.min.x + m), bbox.max.x - m), cz = Math.min(Math.max(t.z, bbox.min.z + m), bbox.max.z - m);
  if (cx !== t.x || cz !== t.z) { const d = new THREE.Vector3(cx - t.x, 0, cz - t.z); t.add(d); camera.position.add(d); }
  // and the camera itself within 1.5 km of the map (a twist with the long zoom-out flung it 9 km away)
  const p = camera.position, M = 1500;
  const px = Math.min(Math.max(p.x, bbox.min.x - M), bbox.max.x + M), pz = Math.min(Math.max(p.z, bbox.min.z - M), bbox.max.z + M);
  if (px !== p.x || pz !== p.z) { p.x = px; p.z = pz; }
}
// the whole map framed for this screen (a portrait phone needs a different distance than a laptop): from the south,
// steep, far enough that the key landmarks all project inside the frame
function fitHome() {
  const L = (n) => VIEWS && meta0.labels.find((l) => l.name === n);
  const pts = ['Pałac Kultury i Nauki', 'PGE Narodowy', 'Warszawa Centralna', 'Centrum Nauki Kopernik', 'Ogród Saski', 'Politechnika Warszawska']
    .map(L).filter(Boolean).map((l) => new THREE.Vector3(l.x, l.z || 40, l.y));
  if (pts.length < 2) return VIEWS.city || VIEWS.overview;
  const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length); c.y = 40;
  // portrait screens look from the west, so the long PKiN-to-stadium axis runs up the screen instead of across it
  const dir = (camera.aspect < 1 ? new THREE.Vector3(-2100, 3500, 0) : new THREE.Vector3(0, 3500, 2100)).normalize(), cam = camera.clone();
  // an open settings panel covers the right of the screen: fit into the strip left of it
  const r = gui.domElement.getBoundingClientRect();
  const x1 = !gui._closed && r.height > 150 && r.left > innerWidth * 0.5 ? (r.left - 8) / innerWidth * 2 - 1 : 1;
  let d = 1500, m = 0;
  for (let k = 0; k < 40; k++, d *= 1.08) {
    cam.position.copy(c).addScaledVector(dir, d); cam.lookAt(c); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const v = pts.map((p) => p.clone().project(cam)), xs = v.map((q) => q.x);
    m = (Math.min(...xs) + Math.max(...xs)) / 2;
    if (Math.max(...xs) - Math.min(...xs) < x1 + 1 - 0.36 && v.every((q) => Math.abs(q.y) < 0.8)) break;
  }
  // slide sideways so the landmarks sit in the middle of the free strip
  const half = c.distanceTo(cam.position) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.aspect;
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  c.addScaledVector(right, (m - (x1 - 1) / 2) * half);
  return { pos: c.clone().addScaledVector(dir, d).toArray(), target: c.toArray() };
}
// ride the nearest vehicle of a kind to what you look at (moving trams are hard to click from the air)
function rideNearest(kind) {
  if (!life) return;
  const f = nav.mode === 'orbit' ? controls.target : camera.position;
  const ag = life.nearest(kind, { x: f.x, z: f.z }, null);
  if (ag) { if (kind === 'tram') ag.label = ag.label || 'tram'; nav.startRide(ag); }
}
function zoomBy(f) {
  const off = camera.position.clone().sub(controls.target);
  const L = THREE.MathUtils.clamp(off.length() * f, controls.minDistance, controls.maxDistance);
  flyTo({ pos: controls.target.clone().add(off.setLength(L)).toArray(), target: controls.target.toArray(), ms: 600 });
}
// turn the bird's-eye view so north is up (orbit about the focus)
function northUp() {
  if (nav.mode !== 'orbit') { nav.walkLook(nav.heading(), 0); return; }
  const off = camera.position.clone().sub(controls.target), a = nav.heading();
  const t0 = performance.now(), p0 = off.clone();
  fly = (now) => {
    const t = Math.min(1, (now - t0) / 700), e = t * t * (3 - 2 * t);
    camera.position.copy(controls.target).add(p0.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a * e));
    if (t >= 1) fly = null;
  };
}
let hud = null, meta0 = null;
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || (e.target.closest && e.target.closest('.lil-gui input'))) return;
  if (e.code === 'KeyG') { if (nav.mode === 'orbit') nav.setMode('walk'); else nav.flyUp(); }
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
function goPlace(x, y, size, pin, placeName) {
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y));
  const h = Math.max(0, top - g);
  if (nav.mode !== 'orbit') { // at street level: walk over there, facing it
    pinPlace(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
    nav.setMode('walk', { at: new THREE.Vector3(x + 0.5, g, y + 0.5), deckOK: /^(Most|Kładka|Wiadukt)\b/.test(pin?.name || placeName || '') });
    return;
  }
  const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
  const dist = Math.min(800, Math.max(170, size * 1.6 + h * 1.8)); // far enough to see what and where it is
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
  streamer?.prefetch(p1, t1, camera); // fetch the destination's tiles while we fly (no coarse blocks on arrival)
  fly = (now) => {
    const t = Math.min(1, (now - t0) / (v.ms || 1600)), e = t * t * (3 - 2 * t);
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
  const material = makeVoxelMaterial({ paletteTex, lampTex: makeLampMap(meta), W: meta.W, D: meta.D });
  uniforms = material.userData.uniforms;
  // the city streams in as a quadtree of tiles (stream.js): coarse everywhere at once, finer near the camera
  streamer = new TileStreamer({ meta, material, scene });
  window.__streamer = streamer;
  bbox.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  bbox.getCenter(center);
  VIEWS = meta.views;
  meta0 = meta;
  world = nav.world = streamer.world;
  nav.streamer = streamer;
  status('Loading the city…');
  await streamer.preload();
  const qsp = new URLSearchParams(location.search);
  const zones = qsp.get('shape') ? await (await import('./zones.js')).installZones({ streamer, material, meta, paletteTex, controls, nav, qs: qsp, composer, n8, camera }) : null;
  // PROTOTYPE: the experiments from the menu. Switching engine reloads the page (same view and time);
  // the real-area shape, radius and budget change live.
  const ENGINES = { 'today (levels)': '', 'real area + clay': 'shape=budget&budget=2&blur=8', 'whole city at 1 m': 'all1m=1' };
  const engineOf = () => Object.keys(ENGINES).find((k) => ENGINES[k] && qsp.get(ENGINES[k].split('=')[0]) !== null) || 'today (levels)';
  const reloadWith = (q) => { const c = camera.position, t = controls.target, u = new URLSearchParams(q);
    u.set('cam', [c.x, c.y, c.z, t.x, t.y, t.z].map((v) => v.toFixed(0)).join(',')); u.set('hour', state.hour.toFixed(2));
    location.search = u.toString(); };
  const fExp = gui.addFolder('Experimental').close();
  gui.$children.insertBefore(fExp.domElement, fKeys.domElement);
  fExp.add({ engine: engineOf() }, 'engine', Object.keys(ENGINES)).name('engine').onChange((k) => reloadWith(ENGINES[k]));
  if (zones) {
    const sync = () => { const u = new URLSearchParams(location.search); u.set('shape', zones.shape); u.set('r', zones.r); u.set('budget', zones.budget); u.set('outside', zones.outside); u.set('blur', zones.blur);
      history.replaceState(null, '', '?' + u); };
    const SHAPES = { 'blocks, triangle budget': 'budget', 'blocks within radius': 'block', 'whole buildings': 'building', 'circle': 'circle', 'square': 'square', 'ragged': 'ragged' };
    const show = () => { budgetCtl.show(zones.shape === 'budget'); rCtl.show(zones.shape !== 'budget'); };
    fExp.add(zones, 'shape', SHAPES).name('real area').onChange(() => { show(); sync(); });
    const budgetCtl = fExp.add(zones, 'budget', 0.5, 8, 0.25).name('budget (M tris)').onChange(sync);
    const rCtl = fExp.add(zones, 'r', 100, 800, 10).name('radius (m)').onChange(sync);
    fExp.add(zones, 'outside', ['clay', 'colour']).name('outside').onChange(sync);
    fExp.add(zones, 'blur', 0, 24, 1).name('blur outside (m)').onChange(sync);
    show();
  }
  fExp.open(engineOf() !== 'today (levels)');
  if (qsp.get('all1m')) await (await import('./all1m.js')).installAll1m({ streamer, status });
  if (qsp.get('lens')) (await import('./lens.js')).installLens({ streamer, composer, n8, camera, renderer, controls, qs: qsp, tiltPass, P });
  if (qsp.get('ghost')) await (await import('./proto.js')).installProto({ streamer, material, composer, n8, camera, renderer, meta, paletteTex, lampTex: material.userData.uniforms.uLampMap.value, controls, nav, qs: qsp });
  const th = theta = (meta.theta_deg || 0) * Math.PI / 180; // grid is rotated: map north in scene coordinates
  nav.north.set(Math.sin(th), 0, -Math.cos(th));
  hud = new Hud({ nav, dom: renderer.domElement, onZoom: zoomBy, onNorth: northUp,
    // the search button starts a fresh query (people's taps appended to the last one)
    onSearch: () => { gui.open(); fGo.open(); search.input.value = ''; search.render(); search.input.focus(); },
    onHome: () => { if (nav.mode !== 'orbit') nav.setMode('orbit'); pinPlace(null); flyTo(fitHome()); },
    onRideTram: () => rideNearest('tram') });
  makeLabels(meta);
  const items = [];
  Object.values(VIEWS).forEach((v, i) => {
    const go = () => { if (nav.mode !== 'orbit') nav.setMode('orbit'); pinPlace(null); flyTo(v); };
    viewCtls.push(go);
    items.push({ name: v.label, kind: `viewpoint · ${i + 1}`, featured: true, go });
  });
  for (const l of meta.labels) items.push({ name: l.name, alt: `${l.alt || ''} ${l.note}`, kind: 'landmark', go: () => goPlace(l.x, l.y, Math.max(40, (l.R || 20) * 1.4), null, l.name) });
  // things to do, found by search too ("tram" found a school and a dentist)
  items.push({ name: 'Ride a tram', alt: 'tramwaj tram ride jedź', kind: 'action', go: () => rideNearest('tram') });
  items.push({ name: 'Ride a car', alt: 'samochód car bus autobus ride jedź', kind: 'action', go: () => rideNearest('car') });
  items.push({ name: 'Walk with someone', alt: 'person people pieszy przechodzień idź walk', kind: 'action', go: () => rideNearest('person') });
  fetch('data/places.json').then((r) => r.json()).then(({ places }) => {
    for (const [name, kind, x, y, size, alt] of places) items.push({ name, alt, kind, go: () => goPlace(x, y, size, { name, note: kind }) });
    search.setItems(items);
  });
  search.setItems(items);
  fountains = new Fountains(scene, meta.jets || []);
  fetch('data/traffic.json').then((r) => r.json()).then((td) => {
    life = nav.life = new StreetLife(scene, td);
    window.__life = life;
    life.group.visible = P.life;
  });
  const statsEl = $('#stats');
  setInterval(() => { statsEl.textContent = `${(meta.W / 1000).toFixed(2)} × ${(meta.D / 1000).toFixed(2)} km · 1 m voxels · ${(streamer.tris / 1e6).toFixed(1)} M tris on screen`; }, 1000);
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
  if (nav.mode === 'orbit') { controls.update(); nav.clamp(); keepInside(); }
  hud?.update();
  // tilt-shift is a miniature-diorama effect; fade it out as the camera gets down to street level
  const camH = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3; // height above the street (was absolute: the map's base moved with the Vistula)
  tiltPass.enabled = P.tilt && camH > 60 && !window.__lens;
  // ...and over the whole map (3+ km up) it would blur most of the city: widen the band again up there
  tilt.focusArea = 0.8 + 0.2 * (1 - Math.min(1, Math.max(0, (camH - 60) / 250))) + 0.2 * Math.min(1, Math.max(0, (camH - 1200) / 1500));
  if (scene.fog) { const d = camera.position.distanceTo(controls.target); scene.fog.near = Math.max(2500, d * 1.05); scene.fog.far = scene.fog.near + 4500; } // haze beyond what you look at
  const tsec = (performance.now() - t0clock) / 1000;
  if (uniforms) uniforms.uTime.value = tsec;
  if (fountains) fountains.update(tsec, state.night);
  if (life && life.group.visible) life.update(dtf, state.hour, state.night, nav.mode === 'orbit' ? controls.target : camera.position);
  sky.mesh.position.copy(camera.position);
  if (streamer) { streamer.focus = nav.focusPoints(); streamer.update(camera); }
  fitShadow();
  composer.render();
  updateLabels();
});
window.__three = { camera, controls, applyTime, flyTo, nav, gui, P, labelEls, scene, renderer, sun, bbox, center };
