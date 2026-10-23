import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Bar } from './bar';
import { Caption } from './caption';
import { installCity } from './city';
import { Daylight } from './daylight';
import { Flood } from './flood';
import { Fountains } from './fountains';
import { Hud } from './hud';
import { Labels } from './labels';
import { Nav, type Mode, type Ride } from './nav/nav';
import { makePost } from './post';
import type { SearchItem } from './search';
import { StreetLife } from './sim/life';
import type { Kind, TrafficData } from './sim/types';
import { TileStreamer } from './stream';
import type { Label, Meta, Place, View } from './types';
import { $, coarsePointer, ease, el, fetchJson, lerp } from './util';
import type { World } from './world';
import { makeUniforms, makeVoxelMaterial, type BuildUniforms, type Engine, type ZoneUniforms } from './voxelMaterial';
import './style.css';

declare global {
  interface Window { __ready?: boolean; __three?: object; __life?: StreetLife; __streamer?: TileStreamer }
}

const TIMES = { morning: 7.5, midday: 13.0, 'golden hour': 17.7, 'blue hour': 20.95, night: 23.0 };
// the Warszawa-Bulwary gauge in cm (the scale since 1 Nov 2025)
const RIVER = { 'record low, Sep 2025': 104, 'as mapped': 185, 'long-term mean': 330, 'warning': 700, 'alarm': 750,
  'flood of 2010': 879, 'flood of 1844 (~)': 963, 'over the embankments': 1120 };

const qs = new URLSearchParams(location.search);
const engine = pickEngine();
const renderer = makeRenderer();
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000);
const controls = makeControls();
const post = makePost(renderer, scene, camera);
const daylight = new Daylight(renderer, scene);
const nav = new Nav(camera, controls, renderer.domElement, scene, (v) => flyTo(v), onMode);
const bar = new Bar({ times: TIMES, river: RIVER, onHour: (h, jump) => (jump ? animateTo(h) : setHour(h)), onRiver: (cm) => flood?.setGauge(cm) });
const map = new THREE.Box3();
const tiltShift = qs.get('tilt') !== '0' && innerWidth >= 600 && (engine === 'city' || qs.get('tilt') === '1');
let world: World | null = null, labels: Labels | null = null, hud: Hud | null = null;
let life: StreetLife | null = null, flood: Flood | null = null, fountains: Fountains | null = null;
let city: Awaited<ReturnType<typeof installCity>> | null = null;
let uniforms: ReturnType<typeof makeUniforms> | null = null, streamer: TileStreamer | null = null, views: Record<string, View> = {};
let anim: ((now: number) => void) | null = null, fly: ((now: number) => void) | null = null;
let barRect: DOMRect | null = null;

nav.cancelFly = () => { fly = null; };
bar.setRiver(RIVER['as mapped']);
new ResizeObserver(() => { barRect = null; }).observe(bar.el);
el('div', '', `<div>by <a href="https://p.migdal.pl/" target="_blank" rel="noopener">Piotr Migdał</a> & Opus 5.5</div>
  <div class="links"><span>GUGiK 2025</span><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a><a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">source code</a></div>`).id = 'credits';
if (qs.get('ui') === '0') document.body.classList.add('noui');
addEventListener('resize', onResize);
addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.metaKey || e.ctrlKey || e.altKey) && !(e.target as Element).closest?.('input')) { bar.search.input.focus(); e.preventDefault(); }
});
tamePinch(renderer.domElement);
boot();

// phones get the real area over clay (zones.ts); ?engine=full insists on the whole city
function pickEngine(): Engine {
  if (Math.min(screen.width, screen.height) < 600 && !qs.get('shape') && qs.get('engine') !== 'full') {
    qs.set('shape', 'budget'); qs.set('budget', '2');
    history.replaceState(null, '', `?${qs}`);
  }
  return qs.get('shape') ? 'zones' : 'city';
}

function makeRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.setSize(innerWidth, innerHeight);
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFShadowMap;
  r.toneMapping = THREE.NoToneMapping;
  r.outputColorSpace = THREE.SRGBColorSpace;
  $('#app').appendChild(r.domElement);
  return r;
}

function makeControls() {
  const c = new OrbitControls(camera, renderer.domElement);
  Object.assign(c, { enableDamping: true, dampingFactor: 0.16, rotateSpeed: 0.3, minDistance: 4, maxDistance: 7000, screenSpacePanning: false, zoomToCursor: true, zoomSpeed: 2.0 });
  if (coarsePointer()) Object.assign(c, { panSpeed: 1.6, zoomSpeed: 1 }); // the map moves and scales with the fingers
  return c;
}

// a trackpad pinch arrives as Ctrl+wheel, which OrbitControls amplifies 10x: re-sent as a plain wheel at ~3x
function tamePinch(dom: HTMLElement) {
  dom.addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !e.isTrusted || nav.mode !== 'orbit') return;
    e.stopImmediatePropagation(); e.preventDefault();
    dom.dispatchEvent(new WheelEvent('wheel', { deltaY: e.deltaY * 3, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, bubbles: true, cancelable: true }));
  }, { capture: true, passive: false });
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  post.composer.setSize(innerWidth, innerHeight);
  barRect = null;
}

function onMode(m: Mode, ride: Ride | null) {
  document.body.classList.toggle('walking', m !== 'orbit');
  hud?.set(m, ride);
}

const focus = () => (nav.mode === 'orbit' ? controls.target : camera.position);

function setHour(h: number) {
  anim = null;
  daylight.apply(h);
  bar.setHour(h);
}

function animateTo(h: number) {
  const from = daylight.hour, t0 = performance.now();
  anim = (now) => {
    const t = Math.min(1, (now - t0) / 1400);
    daylight.apply(lerp(from, h, ease(t)));
    bar.setHour(daylight.hour);
    if (t >= 1) anim = null;
  };
}

function flyTo(v: Pick<View, 'pos' | 'target' | 'ms'>) {
  const p0 = camera.position.clone(), q0 = controls.target.clone(), t0 = performance.now();
  const p1 = new THREE.Vector3(...v.pos), q1 = new THREE.Vector3(...v.target);
  fly = (now) => {
    const t = Math.min(1, (now - t0) / (v.ms ?? 1600)), e = ease(t);
    camera.position.lerpVectors(p0, p1, e);
    controls.target.lerpVectors(q0, q1, e);
    if (t >= 1) fly = null;
  };
}

// frame a place from the current compass direction, ~30° down, with a label on it; at street level, walk there
function goPlace(x: number, y: number, size: number, pin: { name: string; note: string } | null, name = pin?.name ?? '') {
  if (!world) return;
  const g = world.groundAt(x, y), top = world.top(Math.floor(x), Math.floor(y)), h = Math.max(0, top - g);
  labels?.pin(pin && { ...pin, x, y, z: Math.max(top, g + 2) });
  if (nav.mode !== 'orbit') {
    nav.setWalk({ at: new THREE.Vector3(x + 0.5, g, y + 0.5), deckOK: /^(Most|Kładka|Wiadukt)\b/.test(name) });
    return;
  }
  const t = new THREE.Vector3(x + 0.5, g + Math.min(h * 0.5, 60), y + 0.5);
  const dist = Math.min(800, Math.max(170, size * 1.6 + h * 1.8));
  const az = Math.atan2(camera.position.x - controls.target.x, camera.position.z - controls.target.z), el = 0.52;
  const pos = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist));
  flyTo({ pos: pos.toArray(), target: t.toArray() });
}

function goView(v: View) {
  nav.setOrbit();
  labels?.pin(null);
  flyTo(v);
}

function onLabel(l: Label) {
  const v = Object.values(views).find((w) => w.label === l.name.split(' ·')[0]);
  if (v && nav.mode === 'orbit') goView(v);
  else goPlace(l.x, l.y, 60, null, l.name);
}

// moving trams are hard to click from the air: the nearest one to what you look at
function followNearest(kind: Kind) {
  const ag = life?.nearest(kind, focus(), null);
  if (ag) nav.startRide(ag);
}

function searchItems(meta: Meta): SearchItem[] {
  return [
    ...Object.values(meta.views).map((v) => ({ name: v.label, kind: 'viewpoint', featured: true, go: () => goView(v) })),
    ...meta.labels.map((l) => ({ name: l.name, alt: `${l.alt ?? ''} ${l.note}`, kind: 'landmark', go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null, l.name) })),
    { name: 'Follow a tram', alt: 'tramwaj tram ride follow jedź', kind: 'action', go: () => followNearest('tram') },
    { name: 'Follow a car', alt: 'samochód car bus autobus ride follow jedź', kind: 'action', go: () => followNearest('car') },
    { name: 'Zouk at Kopernik', alt: 'dance taniec zouk Centrum Nauki Kopernik evening wieczór', kind: 'action',
      go: () => { if (daylight.hour < 19 || daylight.hour > 23) setHour(20.5); goPlace(2626, 741, 30, { name: 'Zouk', note: 'evenings' }); } },
    { name: 'Follow someone', alt: 'person people pieszy przechodzień idź walk with follow', kind: 'action', go: () => followNearest('person') },
  ];
}

// keep the focus over the city and the camera within 1.5 km of it
function keepInside() {
  if (map.isEmpty() || nav.turning) return;
  const t = controls.target, p = camera.position, m = 60, M = 1500;
  const cx = THREE.MathUtils.clamp(t.x, map.min.x + m, map.max.x - m), cz = THREE.MathUtils.clamp(t.z, map.min.z + m, map.max.z - m);
  if (cx !== t.x || cz !== t.z) { const d = new THREE.Vector3(cx - t.x, 0, cz - t.z); t.add(d); p.add(d); }
  p.x = THREE.MathUtils.clamp(p.x, map.min.x - M, map.max.x + M);
  p.z = THREE.MathUtils.clamp(p.z, map.min.z - M, map.max.z + M);
}

async function boot() {
  const meta = await fetchJson<Meta>('data/meta.json');
  views = meta.views;
  uniforms = makeUniforms(meta, engine);
  streamer = new TileStreamer(meta, makeVoxelMaterial(uniforms), scene);
  world = nav.world = streamer.world;
  nav.streamer = streamer;
  map.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  const v0 = views[qs.get('view') ?? ''] ?? views.overview, cam = qs.get('cam')?.split(',').map(Number);
  camera.position.set(...(cam ? [cam[0], cam[1], cam[2]] as const : v0.pos));
  controls.target.set(...(cam ? [cam[3], cam[4], cam[5]] as const : v0.target));
  daylight.uniforms = uniforms;
  daylight.bloom = post.bloom;
  daylight.theta = (meta.theta_deg || 0) * Math.PI / 180;
  setHour(qs.get('hour') ? +qs.get('hour')! : TIMES['golden hour']);
  if (engine === 'zones') {
    await (await import('./zones')).installZones({ streamer, uniforms: uniforms as typeof uniforms & ZoneUniforms, meta, focus, qs, composer: post.composer, n8: post.n8, camera });
  } else {
    city = await installCity({ streamer, uniforms: uniforms as typeof uniforms & BuildUniforms, meta, scene, focus, camera, caption: new Caption() });
  }
  labels = new Labels(meta.labels, onLabel);
  if (city) labels.gate = city.gate;
  hud = new Hud(renderer.domElement, nav.mode);
  bar.search.setItems(searchItems(meta));
  fetchJson<{ places: Place[] }>('data/places.json').then(({ places }) => bar.search.setItems([...searchItems(meta),
    ...places.map(([name, kind, x, y, size, alt]) => ({ name, alt, kind, go: () => goPlace(x, y, size, { name, note: kind }) }))]));
  fountains = new Fountains(scene, meta.jets ?? []);
  flood = new Flood(scene, uniforms, meta);
  flood.load().then(() => { bar.river.input.disabled = false; flood!.setGauge(RIVER['as mapped']); }).catch((e) => console.warn('flood', e));
  fetchJson<TrafficData>('data/traffic.json').then((td) => {
    life = nav.life = new StreetLife(scene, td);
    life.world = world;
    window.__life = life;
  });
  $('#loading').classList.add('hidden');
  window.__streamer = streamer;
  window.__ready = true;
}

let lastT = performance.now();
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  anim?.(now);
  fly?.(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  nav.update(dt);
  if (nav.mode === 'orbit') { controls.update(); nav.clamp(); keepInside(); }
  const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
  post.setHeight(above, tiltShift);
  const viewDist = camera.position.distanceTo(controls.target);
  daylight.setFogFrom(viewDist);
  const t = (performance.now() - t0) / 1000;
  if (uniforms) uniforms.uTime.value = t;
  fountains?.update(t, daylight.night);
  if (life) {
    life.group.visible = !city || city.complete;
    if (life.group.visible) life.update(dt, daylight.hour, daylight.night, focus());
  }
  daylight.sky.mesh.position.copy(camera.position);
  streamer?.update(camera);
  daylight.fitShadow(focus(), camera, viewDist, map);
  post.composer.render();
  barRect ??= bar.rect;
  labels?.update(camera, world, barRect, hud?.rects ?? []);
});

window.__three = { camera, controls, nav, bar, scene, renderer, flyTo, setHour, map };
