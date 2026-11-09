import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Bar } from './bar';
import { Caption } from './caption';
import { installCity } from './city';
import { Daylight } from './daylight';
import { Flood } from './flood';
import { loadFoliage } from './foliage';
import { loadWindows } from './windows';
import { Fountains } from './fountains';
import { Hud } from './hud';
import { Labels } from './labels';
import { always, blank, gpu, remember, startStats, track, trackLater } from './stats';
import { Nav, type Mode, type Ride } from './nav/nav';
import { Perf } from './perf';
import { makePost } from './post';
import type { SearchItem } from './search';
import { StreetLife } from './sim/life';
import type { Kind, TrafficData } from './sim/types';
import { TileStreamer } from './stream';
import type { Facts, Label, Meta, Place, View } from './types';
import { dateOf, dayOfYear, hourAt, solarNoon } from './sun';
import { $, coarsePointer, ease, el, fetchJson, lerp } from './util';
import { pkinLight } from './sky';
import { type Climate, Precip, typical, type Weather, WEATHERS } from './weather';
import type { World } from './world';
import { makeUniforms, makeVoxelMaterial } from './voxelMaterial';
import './style.css';

declare global {
  interface Window { __ready?: boolean; __three?: object; __life?: StreetLife; __streamer?: TileStreamer }
}

// Warszawa-Bulwary gauge, cm (scale since 1 Nov 2025)
const RIVER = { 'tiny creek': -355, 'record low': 104, typical: 185, '2010 flood': 879, '1844 flood': 963 }; // below the record, the estimated bed (scripts/flood.py)

const TODAY = dayOfYear(new Date());
const DAYS = { midsummer: 172, midwinter: 355, today: TODAY };

startStats();
const qs = new URLSearchParams(location.search);
// Render size, one level from 0 to 1 (the slider; set by the frames, adapt): how much of the city is 1 m around the focus
// (city.ts; the rest is 8 m clay), from 0.2 M triangles of buildings to all of them, and in its lower part how many
// pixels, down to half of the screen's. Phones hold 0.75 M at most, as the 1 m tiles of the whole map need ~2 GB of GPU.
const phone = Math.min(screen.width, screen.height) < 600;
const ceiling = phone ? 0.75e6 : Infinity;
let level = 0.75;
const budget = () => (level >= 1 ? ceiling : Math.min(ceiling, 0.2e6 * ((city?.cityTris ?? 14e6) / 0.2e6) ** level));
const pixelsAt = (l: number) => Math.max(0.5, Math.min(1, 0.4 + 0.8 * l)) * Math.min(devicePixelRatio, 2);
const renderer = makeRenderer();
always({ gpu: gpu(renderer.getContext()), cores: navigator.hardwareConcurrency ?? null,
  memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null });
renderer.domElement.addEventListener('webglcontextlost', () => track('contextlost'));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, innerWidth / innerHeight, 0.5, 9000);
const controls = makeControls();
const post = makePost(renderer, scene, camera);
const daylight = new Daylight(renderer, scene, phone ? 2048 : 4096);
const nav = new Nav(camera, controls, renderer.domElement, scene, (v) => flyTo(v), onMode);
const bar = new Bar({ days: DAYS, weathers: ['typical', ...Object.keys(WEATHERS)], river: RIVER, onDay: (d) => { setDay(d); share(); trackLater('date', { day: d }); },
  onDayEnd: () => { if (weatherName === 'typical') setWeather('typical'); },
  onHour: (h) => { setHour(h); share(); trackLater('hour', { hour: +h.toFixed(1) }); },
  onWeather: (w) => { setWeather(w); share(); track('weather', { weather: w }); }, onRiver: (cm) => { flood?.setGauge(cm); trackLater('river', { cm }); } });
const precip = new Precip(scene);
const map = new THREE.Box3();
const tiltShift = qs.get('tilt') !== '0' && innerWidth >= 600 && !phone;
let world: World | null = null, labels: Labels | null = null, hud: Hud | null = null;
let life: StreetLife | null = null, flood: Flood | null = null, fountains: Fountains | null = null;
let city: Awaited<ReturnType<typeof installCity>> | null = null;
let uniforms: ReturnType<typeof makeUniforms> | null = null, streamer: TileStreamer | null = null, views: Record<string, View> = {};
let fly: ((now: number) => void) | null = null;
let barRect: DOMRect | null = null;
let climate: Climate | null = null;
let places: Label[] = [];
const caption = new Caption();
const perf = new Perf(setLevel);
perf.show(level);
let setWindows: ((hour: number, day: number) => void) | null = null;

nav.cancelFly = () => { fly = null; };
bar.setRiver(RIVER.typical);
bar.showRiver(false);
new ResizeObserver(() => { barRect = null; }).observe(bar.el);
el('div', '', `<div>by <a href="https://p.migdal.pl/" target="_blank" rel="noopener">Piotr Migdał</a> & <a href="https://quesma.com/blog/invisible-cities-one-shot/" target="_blank" rel="noopener">Opus 5.5</a>, <a href="https://github.com/stared/warsaw-vibe-voxel" target="_blank" rel="noopener">source code</a></div>
  <div>based on GUGiK 2025 and <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a></div>`).id = 'credits';
if (qs.get('ui') === '0') document.body.classList.add('noui');
addEventListener('resize', onResize);
addEventListener('keydown', (e) => {
  if (e.key === '/' && !(e.metaKey || e.ctrlKey || e.altKey) && !(e.target as Element).closest?.('input')) { bar.search.input.focus(); e.preventDefault(); }
});
tamePinch(renderer.domElement);
boot();

function makeRenderer() {
  const r = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
  r.info.autoReset = false;
  r.setPixelRatio(pixelsAt(level));
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
  track('mode', { mode: m, kind: ride?.kind ?? null });
}

const focus = () => (nav.mode === 'orbit' ? controls.target : camera.position);

function setHour(h: number) {
  daylight.apply(h);
  bar.setHour(h);
}

const timesOf = (d: number) => ({ morning: Math.max(7.5, hourAt(d, 6, false)), midday: solarNoon(d), 'golden hour': hourAt(d, 5, true),
  'blue hour': hourAt(d, -7, true), night: Math.min(23.5, Math.max(23, hourAt(d, -14, true))) });

function setDay(d: number) {
  const times = timesOf(daylight.day), was = Object.entries(times).find(([, h]) => Math.abs(h - daylight.hour) < 1 / 3)?.[0] as keyof typeof times | undefined;
  daylight.day = d;
  const now = timesOf(d);
  bar.setDay(d, now);
  offerWeathers(d);
  setHour(was ? now[was] : daylight.hour);
}

function offerWeathers(d: number) {
  const snow = climate?.snowy[d - 1] ?? true;
  bar.offer('snow', snow);
  if (!snow && weatherName === 'snow') setWeather('typical');
}

let weatherName = 'typical';
let fade: { from: Weather; to: Weather; t0: number } | null = null;
function setWeather(name: string, now = false) {
  weatherName = name;
  const t = name === 'typical' && climate ? typical(climate, daylight.day) : null;
  const to = t?.w ?? WEATHERS[name] ?? WEATHERS.clear;
  bar.setWeather(name, t?.said ?? '');
  fade = now ? null : { from: { ...daylight.weather }, to, t0: performance.now() };
  if (now) { daylight.weather = to; daylight.apply(daylight.hour); }
}

function stepWeather(now: number) {
  if (!fade) return;
  const k = Math.min(1, (now - fade.t0) / 1500), e = ease(k), { from, to } = fade;
  daylight.weather = { cloud: lerp(from.cloud, to.cloud, e), rain: lerp(from.rain, to.rain, e), snow: lerp(from.snow, to.snow, e), cover: lerp(from.cover, to.cover, e) };
  daylight.apply(daylight.hour);
  if (k >= 1) fade = null;
}

let shareT = 0;
function share() {
  clearTimeout(shareT);
  shareT = setTimeout(() => {
    const d = dateOf(daylight.day);
    qs.set('date', `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    qs.set('hour', daylight.hour.toFixed(2));
    if (weatherName !== 'typical') qs.set('weather', weatherName); else qs.delete('weather');
    history.replaceState(null, '', `?${qs}`);
  }, 400);
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
function goPlace(x: number, y: number, size: number, pin: Facts | null, name = pin?.name ?? '') {
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
  track('label', { name: l.name });
  const v = Object.values(views).find((w) => w.label === l.name);
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
    ...meta.labels.map((l) => ({ name: l.name, alt: [l.en, l.alt].join(' '), kind: l.kind, go: () => goPlace(l.x, l.y, Math.max(40, (l.R ?? 20) * 1.4), null, l.name) })),
    { name: 'Follow a tram', alt: 'tramwaj tram ride follow jedź', kind: 'action', go: () => followNearest('tram') },
    { name: 'Follow a car', alt: 'samochód car bus autobus ride follow jedź', kind: 'action', go: () => followNearest('car') },
    { name: 'Zouk at Kopernik', alt: 'dance taniec zouk Centrum Nauki Kopernik evening wieczór', kind: 'action',
      go: () => { if (daylight.hour < 19 || daylight.hour > 23) setHour(20.5); goPlace(2626, 2021, 30, { name: 'Zouk', kind: 'dancing in the evenings' }); } },
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
  let meta: Meta;
  [meta, climate] = await Promise.all([fetchJson<Meta>('data/meta.json'), fetchJson<Climate>('data/climate.json')]);
  views = meta.views;
  places = meta.labels;
  uniforms = makeUniforms(meta);
  loadFoliage(meta, uniforms).then((city) => bar.setDays({ 'leaves out': city.leaf, 'trees in colour': city.colour, 'leaves down': city.fall, ...DAYS }))
    .catch((e) => console.warn('foliage', e));
  loadWindows(meta, uniforms).then((set) => { setWindows = set; }).catch((e) => console.warn('windows', e));
  streamer = new TileStreamer(meta, makeVoxelMaterial(uniforms), scene);
  world = nav.world = streamer.world;
  daylight.casters(streamer.group, () => life?.group ?? null);
  nav.streamer = streamer;
  map.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(meta.W, meta.H, meta.D));
  const v0 = views[qs.get('view') ?? ''] ?? views.overview, cam = qs.get('cam')?.split(',').map(Number);
  camera.position.set(...(cam ? [cam[0], cam[1], cam[2]] as const : v0.pos));
  controls.target.set(...(cam ? [cam[3], cam[4], cam[5]] as const : v0.target));
  daylight.uniforms = uniforms;
  daylight.bloom = post.bloom;
  daylight.ao = post.n8.configuration;
  daylight.theta = (meta.theta_deg || 0) * Math.PI / 180;
  const md = qs.get('date')?.split('-').map(Number);
  setDay(md ? dayOfYear(new Date(new Date().getFullYear(), md[0] - 1, md[1])) : TODAY);
  setWeather((qs.get('weather') ?? '') in WEATHERS ? qs.get('weather')! : 'typical', true);
  setHour(qs.get('hour') ? +qs.get('hour')! : timesOf(daylight.day)['golden hour']);
  city = await installCity({ streamer, uniforms, meta, scene, focus, camera, caption, budget });
  labels = new Labels(meta.labels, onLabel);
  labels.gate = city.gate;
  hud = new Hud(renderer.domElement, nav.mode);
  bar.search.setItems(searchItems(meta));
  fetchJson<{ places: Place[] }>('data/places.json').then(({ places }) => bar.search.setItems([...searchItems(meta),
    ...places.map(([name, kind, x, y, size, alt]) => ({ name, alt, kind, go: () => goPlace(x, y, size, { name, kind }) }))]));
  fountains = new Fountains(scene, meta.jets ?? []);
  flood = new Flood(scene, uniforms, meta);
  flood.load().then(() => { bar.river.input.disabled = false; flood!.setGauge(RIVER.typical); }).catch((e) => console.warn('flood', e));
  fetchJson<TrafficData>('data/traffic.json').then((td) => {
    life = nav.life = new StreetLife(scene, td);
    life.world = world;
    window.__life = life;
  });
  $('#loading').classList.add('hidden');
  window.__streamer = streamer;
  window.__ready = true;
}

let lastT = performance.now(), riverT = 0, riverSeen = -1e9;
const frames: number[] = [];
const t0 = lastT;
renderer.setAnimationLoop((now) => {
  fly?.(now);
  stepWeather(now);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  adapt(dt, now);
  nav.update(dt);
  if (nav.mode === 'orbit') { controls.update(); nav.clamp(); keepInside(); }
  const above = camera.position.y - (world ? world.groundAt(camera.position.x, camera.position.z) : 18) + 3;
  post.setHeight(above, tiltShift, camera.position.distanceTo(controls.target));
  const viewDist = camera.position.distanceTo(controls.target);
  daylight.setFogFrom(viewDist);
  const t = (performance.now() - t0) / 1000;
  if (uniforms) { uniforms.uTime.value = t; pkinLight(daylight.day, t, uniforms.uPkinLight.value); }
  setWindows?.(daylight.hour, daylight.day);
  fountains?.update(t, daylight.night);
  precip.update(t, camera.position, daylight.weather, daylight.night);
  if (city?.complete) document.body.classList.remove('loading');
  if (life) {
    life.group.visible = !city || city.complete;
    if (life.group.visible) { life.day = daylight.day; life.update(dt, daylight.hour, daylight.night, focus()); }
  }
  daylight.sky.mesh.position.copy(camera.position);
  streamer?.update(camera);
  daylight.fitShadow(focus(), camera, viewDist, map);
  const redraws = daylight.redraws;
  if (stillChanged()) stillDue = true;
  if (stillDue && now - redrawnAt > 300) { stillDue = false; redrawnAt = now; daylight.redrawShadow(); }
  renderer.info.reset();
  post.composer.render();
  if (daylight.redraws !== redraws) busy = true;
  perf.frame(now, document.hidden, renderer.info.render.triangles);
  report(now);
  if (flood && now - riverT > 250) {
    riverT = now;
    if (flood.inView(camera, 2500) || Math.abs(bar.river.value - RIVER.typical) > 20) riverSeen = now;
    bar.showRiver(now - riverSeen < 2000);
  }
  barRect ??= bar.rect;
  labels?.update(camera, world, barRect, [...(hud?.rects ?? []), ...perf.rects]);
});

window.__three = { camera, controls, nav, bar, scene, renderer, flyTo, setHour, setDay, setWeather, map, daylight, post, budget, level: () => level, city: () => city };

// what the city's shadow map shows: which tiles are drawn, and what folds, hides or thins them in its depth pass
let stillKey = '';
function stillChanged() {
  if (!streamer || !uniforms) return false;
  let n = 0, ids = 0;
  for (const m of streamer.group.children) if (m.visible) { n++; ids += m.id; }
  const U = uniforms, key = `${n},${ids},${U.uStage.value},${U.uBldOn.value.version},${U.uZOn.value},${U.uZFBlk.value.version},${U.uFolOn.value},${U.uDay.value},${U.uFolMap.value.id}`;
  if (key === stillKey) return false;
  stillKey = key;
  return true;
}

// The level from steady frames: frames that redrew the city's shadow or changed the pixels are left out. In windows of
// 30 frames (or 1 s): slow twice running (median under 27 fps), a step down, bigger the slower, and no growing past it
// for a minute; smooth twice running (the slowest tenth over 30 fps) with all the city asked for in, a step up, bigger
// at the screen's own rate.
let busy = false, stillDue = false, redrawnAt = 0, slow = 0, calm = 0, cap = 1, capAt = 0, windowAt = 0;
function setLevel(l: number) {
  level = Math.max(0, Math.min(1, l));
  const px = pixelsAt(level);
  if (Math.abs(px - renderer.getPixelRatio()) > 0.01) { renderer.setPixelRatio(px); onResize(); busy = true; }
  perf.show(level);
}
function adapt(dt: number, now: number) {
  const skip = busy;
  busy = false;
  if (!city || document.hidden || dt > 0.5) { frames.length = 0; return; }
  if (skip) return;
  if (!frames.length) windowAt = now;
  frames.push(dt);
  if (frames.length < 30 && (frames.length < 6 || now - windowAt < 1000)) return;
  frames.sort((a, b) => a - b);
  const median = frames[frames.length >> 1], p90 = frames[Math.floor(frames.length * 0.9)];
  frames.length = 0;
  if (perf.manual) return;
  if (now - capAt > 60000) cap = 1;
  if (median > 1 / 27) {
    calm = 0;
    if (++slow < 2) return;
    slow = 0;
    setLevel(level - 0.08 * Math.min(3, median * 27));
    cap = level; capAt = now;
  } else if (p90 < 1 / 30 && city.settled && level < cap) {
    slow = 0;
    if (++calm < 2) return;
    calm = 0;
    setLevel(Math.min(cap, level + (p90 < 1 / 50 ? 0.1 : 0.04)));
  } else { slow = 0; calm = 0; }
}

// usage stats: pulses dense at first, then every minute
const PULSES = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120];
let lastNow = performance.now(), firstFrame = 0, loadedAt = 0, checked = false, pulses = 0, step = 0;
const times: number[] = [];
function report(now: number) {
  const ms = now - lastNow;
  lastNow = now;
  if (!document.hidden && ms < 5000) times.push(ms);
  firstFrame ||= now;
  if (document.body.classList.contains('loading')) return;
  if (!loadedAt) {
    loadedAt = now;
    track('loaded', { seconds: +(now / 1000).toFixed(2), first: +(firstFrame / 1000).toFixed(2) });
  }
  if (!checked && now - loadedAt > 2000) {
    checked = true;
    const c = blank(renderer.getContext());
    if (c) track('blank', { colour: c });
  }
}

const phase = () => (loadedAt ? 'ready' : 'loading');
const progress = () => (loadedAt ? 1 : caption.at.share);

function pulse(due: number) {
  const late = Math.max(0, performance.now() - due);
  if (!document.hidden) {
    const t = times.sort((a, b) => a - b), q = (k: number) => (t.length ? +t[Math.floor(k * (t.length - 1))].toFixed(1) : null);
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize;
    track('pulse', { n: ++pulses, phase: phase(), stage: loadedAt ? null : caption.at.stage, share: progress(), frames: t.length,
      median: q(0.5), p95: q(0.95), worst: q(1), slow: t.filter((x) => x > 50).length, late: Math.round(late),
      ratio: renderer.getPixelRatio(), budget: Number.isFinite(budget()) ? Math.round(budget() / 1e3) : null, level: +level.toFixed(2), mode: nav.mode, near: nearest(), heap: heap ? Math.round(heap / 1e6) : null });
    remember({ last_t: +(performance.now() / 1000).toFixed(1), last_phase: phase(), last_share: progress(), last_stage: caption.at.stage });
  }
  times.length = 0;
  const next = (PULSES[++step] ?? (Math.floor(performance.now() / 60000) + 1) * 60) * 1000;
  setTimeout(() => pulse(next), Math.max(0, next - performance.now()));
}
setTimeout(() => pulse(1000), Math.max(0, 1000 - performance.now()));
addEventListener('pagehide', () => track('leave', { phase: phase(), share: progress(), pulses }));

function nearest() {
  const f = focus();
  let best: Label | null = null, d = 400 ** 2;
  for (const l of places) { const e = (l.x - f.x) ** 2 + (l.y - f.z) ** 2; if (e < d) { d = e; best = l; } }
  return best?.name ?? null;
}
