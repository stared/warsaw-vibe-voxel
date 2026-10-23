import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Live street simulation on the real OSM networks (scripts/traffic.py).
//  signals  : per-junction controllers, two-axis fixed-time cycle (green / amber / all-red), random offsets
//  cars     : Intelligent Driver Model per lane; stop at red/amber; slow for turns; choose turn lanes early and
//             change lanes smoothly; obey OSM turn restrictions; junction "box" locks so conflicting movements
//             never share a junction; positions blend across the junction node into a smooth turning arc
//  trams    : run their real OSM route relations one way, articulated sections on the track, IDM behind any
//             tram ahead on the same track (spatial leader search, so shared track between lines works), obey signals
//  people   : random walk on the footpath graph, keep right, wait for their green at signalled crossings
//  density  : follows the time of day

const CYCLE = 64, GREEN = 26, AMBER = 3;
const PED_GREEN = 18;
const LANE_W = 3.0;
const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
const BLEND = 7; // m either side of a junction node over which lane offsets are blended into an arc
const BOX_IN = 7, BOX_OUT = 9; // junction lock zone: last/first metres of incoming/outgoing edges
const STEP = 1 / 30; // fixed sim tick; render() interpolates cars/trams between the last two ticks (and extrapolates people), so motion stays smooth at any fps
const TRAM = { sec: 10.5, gap: 0.6, n: 3, v: 11, a: 1.0, b: 1.6, headway: 300 };
// Zouk evenings on the dark stone disc in the garden south-east of Centrum Nauki Kopernik (OSM way 603145360, an
// oval ~11 x 14 m): couples in close hold, rocking on the beat, turning about their own centre, the follower now and
// then spun out and back; the couples drift slowly round the disc
const DANCE = { x: 2626.2, y: 741.0, rx: 3.6, ry: 5.0, couples: 7, from: 18.5, to: 23.5, bpm: 84 };

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function vcolor(g, hex) {
  const c = new THREE.Color(hex);
  const a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) a.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function box(w, h, l, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(x, y + h / 2, z);
  return hex === undefined ? g : vcolor(g, hex);
}

// ---------------------------------------------------------------------------------------- polyline helpers
function prepPath(e) {
  const n = e.p.length;
  e.cum = new Float32Array(n);
  for (let i = 1; i < n; i++) e.cum[i] = e.cum[i - 1] + Math.hypot(e.p[i][0] - e.p[i - 1][0], e.p[i][1] - e.p[i - 1][1]);
  e.L = e.cum[n - 1];
  e.startD = dirAt(e, 0);
  e.endD = dirAt(e, n - 2);
  // turn classification uses the direction over the last/first ~15 m (U-turns via short connector shapes)
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
  const d = Math.min(15, e.L);
  at(e, e.L - d, 0, a); at(e, e.L, 0, b);
  let l = Math.hypot(b.x - a.x, b.y - a.y) || 1; e.endD15 = [(b.x - a.x) / l, (b.y - a.y) / l];
  at(e, 0, 0, a); at(e, d, 0, b);
  l = Math.hypot(b.x - a.x, b.y - a.y) || 1; e.startD15 = [(b.x - a.x) / l, (b.y - a.y) / l];
}
function dirAt(e, i) {
  const a = e.p[i], b = e.p[i + 1];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}
// point at arc length s (extrapolated linearly beyond either end), optional right-hand offset
function at(e, s, off, out) {
  let x, y, z, dx, dy;
  if (s <= 0) {
    [dx, dy] = e.startD; const p = e.p[0];
    x = p[0] + dx * s; y = p[1] + dy * s; z = p[2];
  } else if (s >= e.L) {
    [dx, dy] = e.endD; const p = e.p[e.p.length - 1];
    x = p[0] + dx * (s - e.L); y = p[1] + dy * (s - e.L); z = p[2];
  } else {
    const c = e.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m; else hi = m; }
    const a = e.p[lo], b = e.p[hi], seg = c[hi] - c[lo] || 1e-6, f = (s - c[lo]) / seg;
    x = a[0] + (b[0] - a[0]) * f; y = a[1] + (b[1] - a[1]) * f; z = a[2] + (b[2] - a[2]) * f;
    dx = (b[0] - a[0]) / seg; dy = (b[1] - a[1]) / seg;
  }
  out.x = x - dy * off; out.y = y + dx * off; out.z = z;
  return out;
}
function turnOf(e, n) { // -1 left, 0 straight, 1 right, 2 U-turn-ish (grid y points "south": cross>0 = right)
  const A = e.endD15 || e.endD, B = n.startD15 || n.startD;
  const dot = A[0] * B[0] + A[1] * B[1];
  const cross = A[0] * B[1] - A[1] * B[0];
  if (dot < -0.5) return 2;
  if (dot > 0.75) return 0;
  return cross > 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------------------- signals
function phaseK(ctrl, t, axis) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  return ((u - (axis === 0 ? 0 : CYCLE / 2)) % CYCLE + CYCLE) % CYCLE;
}
function signalState(ctrl, t, axis) {
  const k = phaseK(ctrl, t, axis);
  return k < GREEN ? 'G' : k < GREEN + AMBER ? 'Y' : 'R';
}
const pedGreen = (ctrl, t, axis) => phaseK(ctrl, t, axis) < PED_GREEN;

// ---------------------------------------------------------------------------------------- simulation
export class StreetLife {
  constructor(scene, data) {
    this.t = 0;
    this.roads = data.roads;
    this.peds = data.peds;
    this.ctrls = data.ctrls.map((c, i) => ({ ...c, off: hash(i + 1) * CYCLE }));
    this.roads.forEach(prepPath);
    this.peds.forEach(prepPath);
    // road topology
    this.outs = new Map();
    this.ins = new Map();
    this.roads.forEach((e, i) => {
      e.i = i;
      e.lists = Array.from({ length: e.lanes }, () => []);
      (this.outs.get(e.a) || this.outs.set(e.a, []).get(e.a)).push(i);
      (this.ins.get(e.b) || this.ins.set(e.b, []).get(e.b)).push(i);
      e.off = (lane) => e.o0 + lane * LANE_W; // lane 0 = leftmost valid lane (validated against paving)
    });
    this.box = new Map(); // junction node -> Set(cars inside)
    this.restr = new Map(); // `${fromWay}:${via}` -> [{to, type}]
    for (const [fr, via, to, type] of data.restr || []) {
      const k = `${fr}:${via}`;
      (this.restr.get(k) || this.restr.set(k, []).get(k)).push({ to, type });
    }
    this.sources = this.roads.filter((e) => !this.ins.has(e.a) && e.L > 15).map((e) => e.i);
    this.roadW = this.roads.map((e) => e.L * e.lanes * e.c);
    this.roadWsum = this.roadW.reduce((a, b) => a + b, 0);
    this.laneKm = this.roads.reduce((a, e) => a + e.L * e.lanes, 0) / 1000;
    // pedestrian topology (undirected)
    this.padj = new Map();
    this.peds.forEach((e, i) => {
      e.i = i;
      for (const [n, end] of [[e.a, 0], [e.b, 1]]) (this.padj.get(n) || this.padj.set(n, []).get(n)).push([i, end]);
    });
    this.pedW = this.peds.map((e) => e.L * e.w);
    this.pedWsum = this.pedW.reduce((a, b) => a + b, 0);
    this.pedKm = this.peds.reduce((a, e) => a + e.L, 0) / 1000;
    // trams
    this.tramPaths = (data.trams || []).map((p, i) => {
      prepPath(p);
      p.i = i;
      p.stops = this.tramStops(p);
      p.nextSpawn = hash(i + 7) * TRAM.headway;
      return p;
    });
    this.buildCrossings();
    this.trams = [];
    for (const p of this.tramPaths) { // seed trams already running along each line, if the track is clear
      for (let s = hash(p.i + 3) * 500 + 60; s < p.L - 40; s += 450 + hash(s) * 300) {
        if (this.tramClear(p, s)) this.trams.push(this.newTram(p, s));
      }
    }

    this.cars = [];
    this.people = [];
    this.buildMeshes(scene, data);
    this.tmp2 = { x: 0, y: 0, z: 0 };
  }

  // level crossings: tram path x road edge, and tram path x tram path (diamonds), angle > 30 degrees
  buildCrossings() {
    const segs = (e) => { const out = []; for (let i = 1; i < e.p.length; i++) out.push([e.p[i - 1], e.p[i], e.cum[i - 1]]); return out; };
    const isect = (a, b, c, d) => {
      const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]];
      const den = r[0] * q[1] - r[1] * q[0];
      if (Math.abs(den) < 1e-9) return null;
      const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) return null;
      const lr = Math.hypot(...r), lq = Math.hypot(...q);
      const sin = Math.abs(den) / (lr * lq);
      return sin > 0.5 ? [t * lr, u * lq] : null;
    };
    // segments bucketed in 32 m cells: test each tram segment only against nearby ones (all-pairs took ~10 s on the
    // 4 x 3 km map)
    const G = 32, cells = (a, b) => { const out = [];
      for (let gx = Math.floor(Math.min(a[0], b[0]) / G); gx <= Math.floor(Math.max(a[0], b[0]) / G); gx++)
        for (let gy = Math.floor(Math.min(a[1], b[1]) / G); gy <= Math.floor(Math.max(a[1], b[1]) / G); gy++) out.push(gx * 100003 + gy);
      return out; };
    const bucket = (items) => { const m = new Map(); for (const it of items) for (const k of cells(it[0], it[1])) (m.get(k) || m.set(k, []).get(k)).push(it); return m; };
    const near = (m, a, b, f) => { const seen = new Set(); for (const k of cells(a, b)) for (const it of m.get(k) || []) if (!seen.has(it)) { seen.add(it); f(it); } };
    this.roadX = new Map(); // road edge -> [{sR, path, sT}]
    for (const tp of this.tramPaths) tp.xs = [];
    const roadSegs = bucket(this.roads.flatMap((e) => segs(e).map((sg) => [...sg, e])));
    for (const tp of this.tramPaths) {
      for (const [a, b, c0] of segs(tp)) near(roadSegs, a, b, ([c, d, c1, e]) => {
        const hit = isect(a, b, c, d);
        if (!hit) return;
        const x = { sR: c1 + hit[1], path: tp.i, sT: c0 + hit[0] };
        (this.roadX.get(e.i) || this.roadX.set(e.i, []).get(e.i)).push(x);
        tp.xs.push({ kind: 'road', e: e.i, sR: x.sR, sT: x.sT });
      });
    }
    // tram diamonds
    this.diamonds = [];
    const tramSegs = bucket(this.tramPaths.flatMap((tp) => segs(tp).map((sg) => [...sg, tp])));
    for (const A of this.tramPaths) {
      for (const [a, b, c0] of segs(A)) near(tramSegs, a, b, ([c, d, c1, B]) => {
        if (B.i <= A.i) return; // each pair once, as before
        const hit = isect(a, b, c, d);
        if (!hit) return;
        const id = this.diamonds.length;
        this.diamonds.push({ holder: null });
        A.xs.push({ kind: 'diamond', id, sT: c0 + hit[0] });
        B.xs.push({ kind: 'diamond', id, sT: c1 + hit[1] });
      });
    }
  }
  tramLen() { return TRAM.n * (TRAM.sec + TRAM.gap); }

  // tram stop lines: 14 m before each signalled junction the line passes through
  tramStops(p) {
    const stops = [];
    // the path sampled once every 2 m (not once per signal controller), and controllers off its box skipped
    const pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let s = 0; s < p.L; s += 2) { const q = at(p, s, 0, { x: 0, y: 0, z: 0 }); pts.push([s, q.x, q.y]); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    this.ctrls.forEach((c, ci) => {
      if (c.x < x0 - 18 || c.x > x1 + 18 || c.y < y0 - 18 || c.y > y1 + 18) return;
      let best = Infinity, bs = 0;
      for (const [s, qx, qy] of pts) {
        const d = Math.hypot(qx - c.x, qy - c.y);
        if (d < best) { best = d; bs = s; }
      }
      if (best < 18 && bs > 20) {
        const a = at(p, bs - 16, 0, { x: 0, y: 0, z: 0 }), b = at(p, bs - 12, 0, { x: 0, y: 0, z: 0 });
        stops.push({ s: bs - 14, ctrl: ci, axis: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 0 : 1 });
      }
    });
    return stops.sort((a, b) => a.s - b.s);
  }
  newTram(p, s) { return { p: p.i, s, v: TRAM.v * 0.8 }; }
  tramClear(p, s) {
    const q = at(p, s, 0, { x: 0, y: 0, z: 0 }), o = { x: 0, y: 0, z: 0 };
    for (const tr of this.trams) {
      const tp = this.tramPaths[tr.p];
      for (let k = 0; k <= TRAM.n; k++) {
        at(tp, tr.s - k * (TRAM.sec + TRAM.gap), 0, o);
        if (Math.hypot(o.x - q.x, o.y - q.y) < 45) return false;
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ meshes
  buildMeshes(scene, data) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const MAXC = 1400, MAXP = 4000, MAXT = 240;
    const bodyGeo = mergeGeometries([box(1.8, 0.75, 4.4, 0, 0.3, 0), box(1.62, 0.62, 2.3, 0, 1.05, -0.25)]);
    const darkGeo = mergeGeometries([
      box(1.66, 0.5, 2.2, 0, 1.1, -0.25, 0x1d2329),
      box(0.3, 0.6, 0.7, -0.8, 0, 1.3, 0x161616), box(0.3, 0.6, 0.7, 0.8, 0, 1.3, 0x161616),
      box(0.3, 0.6, 0.7, -0.8, 0, -1.35, 0x161616), box(0.3, 0.6, 0.7, 0.8, 0, -1.35, 0x161616),
    ]);
    const headGeo = mergeGeometries([box(0.4, 0.2, 0.1, -0.6, 0.65, 2.2), box(0.4, 0.2, 0.1, 0.6, 0.65, 2.2)]);
    const tailGeo = mergeGeometries([box(0.4, 0.2, 0.1, -0.6, 0.7, -2.2), box(0.4, 0.2, 0.1, 0.6, 0.7, -2.2)]);
    const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.35, metalness: 0.25, ...o });
    this.mBody = new THREE.InstancedMesh(bodyGeo, std({ color: 0xffffff }), MAXC);
    this.mDark = new THREE.InstancedMesh(darkGeo, std({ vertexColors: true, roughness: 0.15, metalness: 0.5 }), MAXC);
    this.headMat = new THREE.MeshBasicMaterial({ color: 0xfff3dd });
    this.mHead = new THREE.InstancedMesh(headGeo, this.headMat, MAXC);
    this.mTail = new THREE.InstancedMesh(tailGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }), MAXC);
    for (const m of [this.mBody, this.mDark]) { m.castShadow = true; m.receiveShadow = true; }
    // tram section (Warsaw livery: yellow body, red skirt, light roof gear), windows separate for night glow
    const L = TRAM.sec;
    const tramGeo = mergeGeometries([box(2.4, 0.9, L, 0, 0.15, 0, 0xc8322b), box(2.4, 1.9, L, 0, 1.05, 0, 0xf2c230),
      box(2.0, 0.35, L - 0.8, 0, 2.95, 0, 0xd9d6cf)]);
    this.tramWinMat = std({ color: 0x26323d, roughness: 0.15, metalness: 0.4, emissive: new THREE.Color(1.0, 0.82, 0.55), emissiveIntensity: 0 });
    this.mTram = new THREE.InstancedMesh(tramGeo, std({ vertexColors: true, roughness: 0.45, metalness: 0.1 }), MAXT);
    this.mTramWin = new THREE.InstancedMesh(box(2.46, 0.85, L - 1.2, 0, 1.6, 0), this.tramWinMat, MAXT);
    this.mTram.castShadow = this.mTram.receiveShadow = true;
    // people
    const legGeo = mergeGeometries([box(0.18, 0.85, 0.22, -0.1, 0, 0, 0x2b3240), box(0.18, 0.85, 0.22, 0.1, 0, 0, 0x2b3240),
      box(0.3, 0.3, 0.3, 0, 1.45, 0, 0xe0b48f), box(0.32, 0.1, 0.32, 0, 1.72, 0, 0x3a2a20)]);
    this.mLegs = new THREE.InstancedMesh(legGeo, std({ vertexColors: true, roughness: 0.9, metalness: 0 }), MAXP);
    this.mTorso = new THREE.InstancedMesh(box(0.46, 0.62, 0.3, 0, 0.85, 0), std({ color: 0xffffff, roughness: 0.9, metalness: 0 }), MAXP);
    this.mLegs.castShadow = this.mTorso.castShadow = true;
    // signal heads
    const heads = data.heads || [];
    this.heads = heads;
    const poleGeo = mergeGeometries([box(0.18, 3.3, 0.18, 0, 0, 0, 0x3a3e42), box(0.42, 1.25, 0.36, 0, 3.0, 0, 0x202225)]);
    this.mPole = new THREE.InstancedMesh(poleGeo, std({ vertexColors: true, roughness: 0.6 }), Math.max(1, heads.length));
    this.mLamp = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff }), Math.max(1, heads.length));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
    heads.forEach(([x, y, z, rot], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot + Math.PI);
      m.compose(new THREE.Vector3(x, z, y), q, one);
      this.mPole.setMatrixAt(i, m);
    });
    this.mPole.count = heads.length;
    this.mPole.castShadow = true;
    for (const mesh of [this.mBody, this.mDark, this.mHead, this.mTail, this.mLegs, this.mTorso, this.mPole, this.mLamp, this.mTram, this.mTramWin]) {
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.mBody.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 3), 3);
    this.mTail.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 3), 3);
    this.mTorso.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3);
    this.mLamp.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, heads.length) * 3), 3);
    this.MAXC = MAXC; this.MAXP = MAXP; this.MAXT = MAXT;
  }

  // ------------------------------------------------------------------ cars: routing
  pickWeighted(w, sum) {
    let r = Math.random() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }
  allowedOuts(e) {
    let outs = (this.outs.get(e.b) || []).filter((j) => {
      const o = this.roads[j];
      return turnOf(e, o) !== 2 && !(o.b === e.a && o.w === e.w);
    });
    const rs = this.restr.get(`${e.w}:${e.b}`);
    if (rs) {
      for (const r of rs) {
        if (r.type.startsWith('only_')) outs = outs.filter((j) => this.roads[j].w === r.to);
        else if (r.type.startsWith('no_')) outs = outs.filter((j) => this.roads[j].w !== r.to);
      }
    }
    return outs;
  }
  // Only the part of the city around the camera is simulated (the map is 4 x 3 km; the old 1.5 km map had about
  // as many agents as this circle). Roads leaving it are exits, roads entering it are sources; agents left outside
  // when the camera moves on are removed. Trams are few and run everywhere.
  setActive(x, z, R) {
    const near = (e) => { const P = e.p, n = P.length; for (const q of [P[0], P[n >> 1], P[n - 1]]) if ((q[0] - x) ** 2 + (q[1] - z) ** 2 < R * R) return true; return false; };
    this.roadOn = this.roads.map(near);
    this.pedOn = this.peds.map(near);
    this.roadW = this.roads.map((e, i) => (this.roadOn[i] ? e.L * e.lanes * e.c : 0));
    this.roadWsum = this.roadW.reduce((a, b) => a + b, 0) || 1;
    this.laneKm = this.roads.reduce((a, e, i) => a + (this.roadOn[i] ? e.L * e.lanes : 0), 0) / 1000;
    this.sources = this.roads.filter((e, i) => this.roadOn[i] && e.L > 15 && !(this.ins.get(e.a) || []).some((j) => this.roadOn[j])).map((e) => e.i);
    this.pedW = this.peds.map((e, i) => (this.pedOn[i] ? e.L * e.w : 0));
    this.pedWsum = this.pedW.reduce((a, b) => a + b, 0) || 1;
    this.pedKm = this.peds.reduce((a, e, i) => a + (this.pedOn[i] ? e.L : 0), 0) / 1000;
    const out = this.cars.filter((c) => !this.roadOn[c.e] && c !== this.keep);
    for (const c of out) { const l = this.roads[c.e].lists[c.lane]; l.splice(l.indexOf(c), 1); this.boxLeave(c); }
    if (out.length) { const o = new Set(out); this.cars = this.cars.filter((c) => !o.has(c)); }
    this.people = this.people.filter((p) => this.pedOn[p.e] || p === this.keep || p.ctl);
    this.active = { x, z, R };
  }
  chooseNext(e) {
    const outs = this.allowedOuts(e).filter((j) => !this.roadOn || this.roadOn[j]); // none left: an exit
    if (!outs.length) return -1;
    const w = outs.map((j) => { const o = this.roads[j], t = turnOf(e, o); return (t === 0 ? 4 : 1) * o.c * (o.L > 6 ? 1 : 0.3); });
    return outs[this.pickWeighted(w, w.reduce((a, b) => a + b, 0))];
  }
  desiredLane(car, e) {
    if (car.next < 0 || e.lanes === 1) return car.lane;
    const t = turnOf(e, this.roads[car.next]);
    if (t === -1) return 0; // lane 0 = leftmost
    if (t === 1) return e.lanes - 1;
    return car.lane;
  }
  laneGapOK(e, lane, s, car) {
    const myLen = car ? car.len : 4.6; // my own body extends myLen behind s
    for (const o of e.lists[lane]) if (o !== car && o.s > s - myLen - 5 && o.s - o.len < s + 7) return false;
    for (let l = 0; l < e.lanes; l++) for (const o of e.lists[l]) if (o !== car && o.lcTo === lane && Math.abs(o.s - s) < 12) return false;
    return true;
  }

  spawnCar(fromSource) {
    const ei = fromSource && this.sources.length ? this.sources[(Math.random() * this.sources.length) | 0] : this.pickWeighted(this.roadW, this.roadWsum);
    const e = this.roads[ei];
    const lane = (Math.random() * e.lanes) | 0;
    const s = fromSource ? 0 : 10 + Math.random() * Math.max(0, e.L - 20 - BOX_IN - 12);
    if (s > e.L - BOX_IN - 12 || !this.laneGapOK(e, lane, s, null)) return;
    const bus = e.c >= 2 && Math.random() < 0.06;
    const PAL = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
    const car = {
      e: ei, lane, s, v: e.v * 0.6, len: bus ? 12 : 4.6, bus, prev: -1, prevOff: 0,
      v0f: 0.85 + Math.random() * 0.25, col: new THREE.Color(bus ? '#f2c230' : PAL[(Math.random() * PAL.length) | 0]),
      off: e.off(lane), brake: 0, wait: 0, boxNode: -1,
    };
    car.next = this.chooseNext(e);
    e.lists[lane].push(car);
    this.cars.push(car);
  }

  // junction box: may this car enter node n now? compatible holders = same approach, parallel approaches,
  // opposite straight/right flows, or right turns into different roads
  boxFree(car, e, n) {
    const holders = this.box.get(n);
    if (!holders || !holders.size) return true;
    const myTurn = car.next >= 0 ? turnOf(e, this.roads[car.next]) : 0;
    for (const h of holders) {
      if (h === car) continue;
      this.boxBlocker = h;
      if (h.boxFrom === e.i) { // same approach: fine if lanes are ordered like the turns (no crossing paths)
        const dl = car.lane - h.boxLane, dt = myTurn - h.boxTurn;
        if (dl === 0) continue; // same lane: plain car-following
        if (dl * dt < 0) return false; // turn paths would cross
        if (h.boxTo === car.next && car.next >= 0) { // same exit: fine unless both land in the same lane
          const n = this.roads[car.next];
          const tl = (l, t) => (t === -1 ? 0 : t === 1 ? n.lanes - 1 : Math.min(l, n.lanes - 1));
          if (tl(car.lane, myTurn) === tl(h.boxLane, h.boxTurn)) return false;
        }
        continue;
      }
      if (h.boxTo === car.next && car.next >= 0) return false; // merging into the same road: one at a time
      const he = this.roads[h.boxFrom];
      const dot = he.endD[0] * e.endD[0] + he.endD[1] * e.endD[1];
      if (dot > 0.75) continue;
      if (dot < -0.75 && myTurn !== -1 && h.boxTurn !== -1) continue;
      return false;
    }
    return true;
  }
  boxEnter(car, e, n) {
    car.boxNode = n; car.boxFrom = e.i; car.boxTo = car.next; car.boxLane = car.lane; car.boxT = this.t;
    car.boxTurn = car.next >= 0 ? turnOf(e, this.roads[car.next]) : 0;
    (this.box.get(n) || this.box.set(n, new Set()).get(n)).add(car);
  }
  boxLeave(car) {
    if (car.boxNode >= 0) { this.box.get(car.boxNode)?.delete(car); car.boxNode = -1; }
  }

  carObstacle(car, e) {
    let gap = Infinity, lv = 0, why = 'free', by = null;
    const assertive = car.ghost > 0; // after a long deadlock-type wait: ignore box locks and cross traffic only
    const ig = car.ignore && car.ignoreT > this.t ? car.ignore : null; // waived blocker (deadlock breaker)
    const lead = (o, g) => { if (o === ig && o.e !== car.e) return; if (g < gap) { gap = g; lv = o.v; why = o.e === car.e ? 'leader' : 'next-edge-car'; by = o; } };
    for (const o of e.lists[car.lane]) if (o !== car && o.s > car.s) lead(o, o.s - o.len - car.s);
    // cars changing into my lane, and (if I am changing) cars in my target lane
    for (let l = 0; l < e.lanes; l++) {
      if (l === car.lane) continue;
      for (const o of e.lists[l]) {
        if (o.s <= car.s) continue;
        if (o.lcTo === car.lane || (car.lcTo === l)) lead(o, o.s - o.len - car.s);
      }
    }
    if (car.next >= 0) { // cars just past the junction in the lane I will take (or changing into it)
      const n = this.roads[car.next], t = turnOf(e, n);
      const tl = t === -1 ? 0 : t === 1 ? n.lanes - 1 : Math.min(car.lane, n.lanes - 1);
      for (let l = 0; l < n.lanes; l++) for (const o of n.lists[l]) {
        if ((l === tl || o.lcTo === tl) && o.s < 30) lead(o, e.L - car.s + o.s - o.len);
      }
    }
    const sg = e.sig;
    if (sg && car.s < sg.s + 0.3) {
      const st = signalState(this.ctrls[sg.ctrl], this.t, sg.axis);
      const d = sg.s - car.s;
      const canStop = d > (car.v * car.v) / (2 * IDM.b) + 1;
      if ((st === 'R' || (st === 'Y' && canStop)) && d < gap) { gap = d; lv = 0; why = 'signal'; by = null; }
    }
    // don't block the box: only enter the junction if there is room to clear it on the exit road
    if (!assertive && car.next >= 0 && car.boxNode !== e.b && e.L - car.s < BOX_IN + 15) {
      const n = this.roads[car.next], t = turnOf(e, n);
      const nl = t === -1 ? 0 : t === 1 ? n.lanes - 1 : Math.min(car.lane, n.lanes - 1);
      let room = Infinity;
      let rb = null;
      for (const o of n.lists[nl]) if (o.v < 2 && o.s - o.len < room) { room = o.s - o.len; rb = o; }
      if (room < car.len + 2 && n.L > car.len + 4) {
        const d = e.L - BOX_IN - car.s;
        if (d < gap && rb !== ig) { gap = Math.max(d, 0.01); lv = 0; why = 'no-room-exit'; by = rb; }
      }
    }
    // physical blocker in my path; circular waits are broken after 6 s when the blocker is itself stuck
    const sameDir = car.block && (car.block.o.geo.fx * car.geo.fx + car.block.o.geo.fy * car.geo.fy) > 0.7;
    if (car.block && car.block.o !== ig && (sameDir || !assertive) && !(car.wait > 6 && car.block.o.wait > 3 && !sameDir) && car.block.gap < gap) { gap = Math.max(car.block.gap, 0.01); lv = car.block.o.v * Math.max(0, car.block.o.geo.fx * car.geo.fx + car.block.o.geo.fy * car.geo.fy); why = 'spatial'; by = car.block.o; }
    const xs = this.roadX.get(e.i);
    // already over the tracks: clear them; never stop on a level crossing because of the tram that is waiting for me
    const onX = xs && xs.some((x) => car.s > x.sR - 2.5 && car.s - car.len < x.sR + 2.5);
    if (xs) for (const x of xs) { // level crossing ahead: stop if a tram is on it or due within ~4 s
      const d = x.sR - car.s;
      if (d < 2.5 || d > 40) continue; // front already at the tracks: committed, clear them
      const busy = this.trams.find((tr) => tr.p === x.path && tr.s - this.tramLen() < x.sT + 3 &&
        (tr.s > x.sT - 2 || (tr.v > 1 && tr.s > x.sT - tr.v * 4)));
      if (busy && busy !== ig && d - 3.5 < gap) { gap = Math.max(d - 3.5, 0.01); lv = 0; why = 'tram-crossing'; by = busy; }
      // keep the crossing clear: don't start across unless there is room for my whole car beyond the tracks
      if (d > 0.5) {
        let room = Infinity;
        let rb = null;
        for (const o of e.lists[car.lane]) if (o !== car && o.s > x.sR && o.v < 2 && o.s - o.len - (x.sR + 2.5) < room) { room = o.s - o.len - (x.sR + 2.5); rb = o; }
        if (room < car.len + 1 && rb !== ig && d - 3.5 < gap) { gap = Math.max(d - 3.5, 0.01); lv = 0; why = 'keep-crossing-clear'; by = rb; }
      }
    }
    if (!onX && this.tramObs.length) { // yield to any tram body in the next 25 m of my path
      const P = this.carPoint(car, car.s, { x: 0, y: 0, z: 0 }), F = this.carPoint(car, car.s + 1, { x: 0, y: 0, z: 0 });
      const fx = F.x - P.x, fy = F.y - P.y;
      const gx = (P.x / 32) | 0, gy = (P.y / 32) | 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [x, y, tro] of this.tramGrid.get((gx + i) * 100003 + (gy + j)) || []) {
        const rx = x - P.x, ry = y - P.y;
        if (Math.abs(rx) > 30 || Math.abs(ry) > 30) continue;
        const along = rx * fx + ry * fy, lat = Math.abs(rx * fy - ry * fx);
        if (tro !== ig && along > 0 && along < 25 && lat < 2.4 && along - 2 < gap) { gap = Math.max(along - 2, 0.01); lv = 0; why = 'tram'; by = tro; }
      }
    }
    if (!assertive && car.boxNode !== e.b && car.next >= 0 && e.L - car.s < BOX_IN + 15) {
      const free = this.boxFree(car, e, e.b) || car.wait > 10 || (ig && this.boxBlocker === ig); // nudge through after 10 s (prevents deadlock)
      if (!free) { const d = e.L - BOX_IN - car.s; if (d < gap) { gap = Math.max(d, 0.01); lv = 0; why = 'box-busy'; by = this.boxBlocker; } }
    }
    car.why = assertive && why === 'free' ? 'assertive' : why;
    car.by = by;
    return [gap, lv];
  }

  // ------------------------------------------------------------------ step
  // Circular waits: every stopped agent waits for at most one other (`by`), so cycles are cheap to find.
  // In each cycle the member with the softest reason may ignore its blocker for a few seconds.
  breakDeadlocks() {
    const SOFT = ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line', 'keep-crossing-clear', 'next-edge-car', 'tram-crossing', 'tram'];
    const rank = (a) => { const i = SOFT.indexOf(a.why); return a.isTram ? 20 + ['road-occupied', 'car-on-track', 'tram'].indexOf(a.why) : i < 0 ? 99 : i; };
    const state = new Map(); // 1 = on current path, 2 = done
    for (const tr of this.trams) tr.isTram = true;
    for (const a0 of [...this.cars, ...this.trams]) {
      if (state.has(a0)) continue;
      const path = [];
      let a = a0;
      while (a && !state.has(a) && a.v < 0.3 && a.by) { state.set(a, 1); path.push(a); a = a.by; }
      if (a && state.get(a) === 1) {
        const cyc = path.slice(path.indexOf(a));
        let best = null;
        for (const m of cyc) if (rank(m) < 99 && (!best || rank(m) < rank(best))) best = m;
        if (best) { best.ignore = best.by; best.ignoreT = this.t + 4; }
      }
      for (const p of path) state.set(p, 2);
    }
  }

  step(dt, density) {
    this.t += dt;
    if (((this.t / 0.5) | 0) !== ((this.t - dt) / 0.5 | 0)) this.breakDeadlocks();
    const targetCars = Math.min(this.MAXC, Math.round(this.laneKm * 9 * density.cars));
    const targetPeds = Math.min(this.MAXP, Math.round(this.pedKm * 24 * density.peds));
    for (let k = 0; k < 6 && this.cars.length < targetCars; k++) this.spawnCar(this.cars.length > targetCars * 0.5);
    for (let k = 0; k < 40 && this.people.length < targetPeds; k++) this.spawnPed();
    if (this.people.length > targetPeds) {
      const i = this.people.indexOf(this.keep); // the person someone is riding along with stays in the crowd
      if (i >= targetPeds) [this.people[0], this.people[i]] = [this.people[i], this.people[0]];
      this.people = [...this.people.filter((p) => p.ctl), ...this.people.filter((p) => !p.ctl)]; // and those you walked
      this.people.length = targetPeds;
    }

    // tram bodies as obstacles for cars (positions from the previous step)
    // trams far from the active area just run along their track (no signals, no cars to yield to): cheap, and the
    // city still has moving trams when you look across it
    const A = this.active;
    { const q0 = { x: 0, y: 0, z: 0 };
      for (const tr of this.trams) { at(this.tramPaths[tr.p], tr.s, 0, q0); tr.near = !A || (q0.x - A.x) ** 2 + (q0.y - A.z) ** 2 < (A.R + 200) ** 2; } }
    this.tramObs = [];
    { const q1 = { x: 0, y: 0, z: 0 };
      for (const tr of this.trams) { if (!tr.near) continue; const tp = this.tramPaths[tr.p];
        for (let s0 = 0; s0 <= TRAM.n * (TRAM.sec + TRAM.gap); s0 += 3) { at(tp, tr.s - s0, 0, q1); this.tramObs.push([q1.x, q1.y, tr]); } } }
    // bucket the tram body points in 32 m cells: each car looks only at the cells around it
    this.tramGrid = new Map();
    for (const o of this.tramObs) { const k = ((o[0] / 32) | 0) * 100003 + ((o[1] / 32) | 0); (this.tramGrid.get(k) || this.tramGrid.set(k, []).get(k)).push(o); }
    // ---- spatial snapshot of all cars (front point, direction, centre) for physical conflict checks
    const grid = new Map();
    const G = 8, key = (x, y) => ((x / G) | 0) * 100003 + ((y / G) | 0);
    for (const c of this.cars) {
      const P = this.carPoint(c, c.s, { x: 0, y: 0, z: 0 }), F = this.carPoint(c, c.s + 1, { x: 0, y: 0, z: 0 });
      const C = this.carPoint(c, c.s - c.len / 2, { x: 0, y: 0, z: 0 });
      let fx = F.x - P.x, fy = F.y - P.y; const l = Math.hypot(fx, fy) || 1; fx /= l; fy /= l;
      c.geo = { px: P.x, py: P.y, cx: C.x, cy: C.y, z: P.z, fx, fy };
      const k = key(C.x, C.y);
      (grid.get(k) || grid.set(k, []).get(k)).push(c);
    }
    this.carGrid = grid; this.gridKey = key; this.G = G;
    // who physically blocks whom (cone ahead); mutual conflicts resolved by a stable priority
    this.idSeq = this.idSeq || 1;
    for (const c of this.cars) { if (!c.id) c.id = this.idSeq++; c.block = null; }
    for (const c of this.cars) {
      const g0 = c.geo;
      let best = Infinity, who = null;
      const gx = (g0.px / G) | 0, gy = (g0.py / G) | 0;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const o of grid.get((gx + i) * 100003 + (gy + j)) || []) {
        if (o === c || Math.abs(o.geo.z - g0.z) > 2) continue;
        const rx = o.geo.cx - g0.px, ry = o.geo.cy - g0.py;
        const along = rx * g0.fx + ry * g0.fy, lat = Math.abs(rx * g0.fy - ry * g0.fx);
        const cosd = Math.abs(o.geo.fx * g0.fx + o.geo.fy * g0.fy), sind = Math.sqrt(Math.max(0, 1 - cosd * cosd));
        const he = (o.len / 2) * cosd + 0.9 * sind, hl = (o.len / 2) * sind + 0.9 * cosd;
        if (lat < 0.95 + hl && along + he > 0.3 && along - he < 12) {
          const gap = along - he - 0.6;
          if (gap < best) { best = gap; who = o; }
        }
      }
      if (who) c.block = { o: who, gap: best };
    }
    for (const c of this.cars) { // mutual: both see each other -> the one with the lower id goes first
      const b = c.block;
      if (b && b.o.block && b.o.block.o === c) { // mutual: whoever entered the junction first (else lower id) goes
        const pc = c.boxNode >= 0 ? c.boxT : Infinity, po = b.o.boxNode >= 0 ? b.o.boxT : Infinity;
        if (pc < po || (pc === po && c.id < b.o.id)) c.block = null;
      }
    }
    // ---- cars
    const removed = new Set();
    for (const car of this.cars) {
      const e = this.roads[car.e];
      const s0 = car.s, off0 = car.off, e0 = car.e;
      car.ds = car.dOff = 0;
      const want = this.desiredLane(car, e);
      if (want !== car.lane && car.lcTo === undefined && car.s > 4 && e.L - car.s > 15) {
        const step = want > car.lane ? 1 : -1;
        if (this.laneGapOK(e, car.lane + step, car.s, car)) car.lcTo = car.lane + step;
      }
      if (car.lcTo !== undefined) {
        const tgt = e.off(car.lcTo);
        car.off += Math.sign(tgt - car.off) * Math.min(Math.abs(tgt - car.off), 1.4 * dt * Math.max(0.4, Math.min(1, car.v / 5)));
        if (Math.abs(tgt - car.off) < 0.05) {
          const lst = e.lists[car.lane]; lst.splice(lst.indexOf(car), 1);
          car.lane = car.lcTo; car.lcTo = undefined; e.lists[car.lane].push(car);
        }
      } else car.off += (e.off(car.lane) - car.off) * Math.min(1, dt * 3);

      let v0 = e.v * car.v0f;
      if (car.next >= 0 && e.L - car.s < 30) {
        const t = turnOf(e, this.roads[car.next]);
        if (t !== 0) v0 = Math.min(v0, t === 1 ? 4.5 : 6);
      }
      const [gap, lv] = this.carObstacle(car, e);
      const ss = IDM.s0 + Math.max(0, car.v * IDM.T + (car.v * (car.v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      let acc = IDM.a * (1 - Math.pow(car.v / Math.max(v0, 0.1), 4) - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2));
      acc = Math.max(acc, -9);
      car.brake = acc < -0.8 || car.v < 0.3 ? 1 : 0;
      car.v = Math.max(0, car.v + acc * dt);
      car.wait = car.v < 0.3 ? car.wait + dt : 0;
      if (!(car.ghost > 0) && ((car.wait > 15 && ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line'].includes(car.why)) ||
          (car.wait > 25 && ['next-edge-car', 'tram-crossing', 'keep-crossing-clear', 'tram'].includes(car.why)))) { car.ghost = 8; car.wait = 0; }
      if (car.ghost > 0) { car.ghost -= car.v * dt; if (car.v < 1.5 && gap > 3) car.v = 1.5; }
      car.s += car.v * dt;
      if (car.next >= 0 && car.boxNode !== e.b && e.L - car.s < BOX_IN) { this.boxLeave(car); this.boxEnter(car, e, e.b); }
      if (car.s > e.L) {
        const lst = e.lists[car.lane];
        lst.splice(lst.indexOf(car), 1);
        car.lcTo = undefined;
        if (car.next < 0 || this.cars.length > targetCars + 4) { this.boxLeave(car); removed.add(car); continue; }
        {
          const n0 = this.roads[car.next], t0 = turnOf(e, n0);
          const l0 = t0 === -1 ? 0 : t0 === 1 ? n0.lanes - 1 : Math.min(car.lane, n0.lanes - 1);
          const hb = n0.lists[l0].find((o) => o.s < car.len + 1.5);
          if (hb && !(car.ignore === hb && car.ignoreT > this.t)) { // target lane start occupied: hold at the line
            e.lists[car.lane].push(car); car.s = e.L - 0.01; car.v = 0; car.why = 'hold-at-line'; car.by = n0.lists[l0].find((o) => o.s < car.len + 1.5); car.ds = car.s - s0; continue;
          }
        }
        car.prev = car.e; car.prevOff = car.off;
        car.s -= e.L;
        car.e = car.next;
        const n = this.roads[car.e];
        const t = turnOf(e, n);
        car.lane = t === -1 ? 0 : t === 1 ? n.lanes - 1 : Math.min(car.lane, n.lanes - 1);
        car.off = n.off(car.lane);
        n.lists[car.lane].push(car);
        car.next = this.chooseNext(n);
        if (n.L < 25 && car.next >= 0) { // too short to change lanes later: take the next turn's lane now if free
          const wl = this.desiredLane(car, n);
          if (wl !== car.lane && this.laneGapOK(n, wl, car.s, car)) {
            n.lists[car.lane].splice(n.lists[car.lane].indexOf(car), 1); car.lane = wl; car.off = n.off(wl); n.lists[wl].push(car);
          }
        }
      }
      if (car.boxNode >= 0 && car.e !== car.boxFrom && car.s > BOX_OUT) this.boxLeave(car);
      // this tick's motion in the current edge's coordinates, for render-time interpolation
      car.ds = car.e === e0 ? car.s - s0 : car.s + e.L - s0;
      car.dOff = car.e === e0 ? car.off - off0 : 0;
    }
    if (removed.size) this.cars = this.cars.filter((c) => !removed.has(c));

    // ---- trams
    for (const p of this.tramPaths) {
      p.nextSpawn -= dt * density.trams;
      if (p.nextSpawn <= 0) {
        const head = TRAM.n * (TRAM.sec + TRAM.gap) + 1;
        if (this.tramClear(p, head)) { this.trams.push(this.newTram(p, head)); p.nextSpawn = TRAM.headway * (0.7 + 0.6 * Math.random()); }
        else p.nextSpawn = 5;
      }
    }
    const tq = { x: 0, y: 0, z: 0 }, tq2 = { x: 0, y: 0, z: 0 };
    const tramPts = [];
    this.trams.forEach((tr, ti) => {
      if (!tr.near) return;
      const p = this.tramPaths[tr.p];
      for (let k = 0; k <= TRAM.n; k++) { at(p, tr.s - k * (TRAM.sec + TRAM.gap), 0, tq); tramPts.push([ti, tq.x, tq.y]); }
    });
    this.trams.forEach((tr, ti) => {
      if (!tr.near) { tr.v += (TRAM.v * 0.8 - tr.v) * Math.min(1, dt * 0.5); tr.ds = tr.v * dt; tr.s += tr.ds; tr.why = 'free'; return; }
      const p = this.tramPaths[tr.p];
      at(p, tr.s, 0, tq); at(p, tr.s + 1, 0, tq2);
      const fdx = tq2.x - tq.x, fdy = tq2.y - tq.y;
      let gap = Infinity, tw = 'free', tb = null;
      const G2 = (g, w, b) => { if (g < gap) { gap = g; tw = w; tb = b; } };
      for (const [oj, x, y] of tramPts) { // any tram body ahead on my track (shared track between lines)
        if (oj === ti) continue;
        const rx = x - tq.x, ry = y - tq.y;
        const along = rx * fdx + ry * fdy, lat = Math.abs(rx * fdy - ry * fdx);
        // cone widens ahead so a tram converging from a branch is seen before the tracks join
        if (along > -0.5 && along < 70 && lat < 2.2 + Math.min(along, 40) * 0.12) {
          if (lat > 2.2 && oj < ti && this.trams[oj].yieldTo === ti) continue; // mutual at a merge: lower index goes
          if (lat > 2.2) tr.yieldTo = oj;
          if (!(tr.ignore === this.trams[oj] && tr.ignoreT > this.t)) G2(along - 1.5, 'tram', this.trams[oj]);
        }
      }
      if (this.carGrid) { // cars standing on my track ahead
        const gx = (tq.x / this.G) | 0, gy = (tq.y / this.G) | 0;
        for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) for (const c of this.carGrid.get((gx + i) * 100003 + (gy + j)) || []) {
          const rx = c.geo.cx - tq.x, ry = c.geo.cy - tq.y;
          const along = rx * fdx + ry * fdy, lat = Math.abs(rx * fdy - ry * fdx);
          if (along > -1 && along < 30 && lat < 2.4) { if (!(tr.ignore === c && tr.ignoreT > this.t)) G2(along - 2.5, 'car-on-track', c); }
        }
      }
      for (const x of p.xs) {
        const d = x.sT - tr.s;
        if (x.kind === 'road') {
          if (d < 0 || d > 25) continue;
          const lst = this.roads[x.e].lists;
          let occ = null;
          for (const l of lst) for (const c of l) if (c.s > x.sR - 1.5 && c.s - c.len < x.sR + 1.5) occ = c;
          if (occ && !(tr.ignore === occ && tr.ignoreT > this.t)) G2(d - 4, 'road-occupied', occ);
        } else {
          const D = this.diamonds[x.id];
          if (D.holder === tr && tr.s - this.tramLen() > x.sT + 2) { D.holder = null; continue; }
          if (d < 0 || d > 30) continue;
          if (!D.holder || !this.trams.includes(D.holder)) D.holder = tr;
          else if (D.holder !== tr) G2(d - 6, 'diamond', D.holder);
        }
      }
      for (const st of p.stops) {
        if (tr.s > st.s + 0.3 || st.s - tr.s > 80) continue;
        const sgl = signalState(this.ctrls[st.ctrl], this.t, st.axis);
        const d = st.s - tr.s;
        if (sgl === 'R' || (sgl === 'Y' && d > (tr.v * tr.v) / (2 * TRAM.b) + 1)) G2(d, 'signal', null);
      }
      if (gap === Infinity) tr.yieldTo = -1;
      tr.why = tw; tr.by = tb;
      const ss = 3 + Math.max(0, tr.v * 1.5);
      let acc = TRAM.a * (1 - (tr.v / TRAM.v) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2));
      acc = Math.max(acc, -5);
      tr.v = Math.max(0, tr.v + acc * dt);
      tr.ds = tr.v * dt;
      tr.s += tr.ds;
    });
    this.trams = this.trams.filter((tr) => tr.s - TRAM.n * (TRAM.sec + TRAM.gap) < this.tramPaths[tr.p].L);

    // ---- pedestrians
    for (const pe of this.people) {
      if (pe.ctl) continue; // possessed: the player walks them (nav.js), off the footpath graph
      const e = this.peds[pe.e];
      if (pe.wait) {
        if (pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) pe.wait = false;
        else continue;
      }
      pe.s += pe.v * dt * pe.dir;
      pe.ph += pe.v * dt * 4.2;
      if (pe.s < 0 || pe.s > e.L) {
        const node = pe.s < 0 ? e.a : e.b;
        const opts = (this.padj.get(node) || []).filter(([j]) => j !== pe.e && (!this.pedOn || this.pedOn[j]));
        if (!opts.length) { pe.dir *= -1; pe.s = Math.min(Math.max(pe.s, 0), e.L); continue; }
        const w = opts.map(([j]) => this.peds[j].w);
        const [j, end] = opts[this.pickWeighted(w, w.reduce((a, b) => a + b, 0))];
        pe.e = j;
        const n = this.peds[j];
        pe.dir = end === 0 ? 1 : -1;
        pe.s = end === 0 ? 0 : n.L;
        if (n.x && !pedGreen(this.ctrls[n.x.ctrl], this.t, n.x.axis)) pe.wait = true;
      }
    }
  }
  spawnPed() {
    const ei = this.pickWeighted(this.pedW, this.pedWsum);
    const e = this.peds[ei];
    const SH = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
    this.people.push({
      e: ei, dir: Math.random() < 0.5 ? 1 : -1, s: Math.random() * e.L, v: 1.05 + Math.random() * 0.55,
      lat: 0.35 + Math.random() * 1.0, ph: Math.random() * 6.28, wait: false, col: new THREE.Color(SH[(Math.random() * SH.length) | 0]),
    });
  }

  // ------------------------------------------------------------------ positions
  // point on the car's path at arc length s, blended across the junction node into a smooth arc
  carPoint(car, s, out, off = car.off) {
    const e = this.roads[car.e];
    const P = at(e, s, off, out);
    if (s < BLEND && car.prev >= 0) {
      const pe = this.roads[car.prev];
      const Q = at(pe, pe.L + s, car.prevOff, this.tmp2);
      const w = sstep(-BLEND, BLEND, s);
      P.x = Q.x + (P.x - Q.x) * w; P.y = Q.y + (P.y - Q.y) * w; P.z = Q.z + (P.z - Q.z) * w;
    } else if (s > e.L - BLEND && car.next >= 0) {
      const n = this.roads[car.next];
      const t = turnOf(e, n);
      const nl = t === -1 ? 0 : t === 1 ? n.lanes - 1 : Math.min(car.lane, n.lanes - 1);
      const Q = at(n, s - e.L, n.off(nl), this.tmp2);
      const w = sstep(-BLEND, BLEND, s - e.L);
      P.x += (Q.x - P.x) * w; P.y += (Q.y - P.y) * w; P.z += (Q.z - P.z) * w;
    }
    return P;
  }

  render(dt, night, lead = 0) {
    const back = 1 - lead / STEP; // how far to step back from the latest tick towards the previous one
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const A = { x: 0, y: 0, z: 0 }, B = { x: 0, y: 0, z: 0 };
    const tailOff = new THREE.Color(0.55, 0.06, 0.05), tailOn = new THREE.Color(2.2, 0.15, 0.1);
    this.cars.forEach((c, i) => {
      // front and rear axle points both on the blended path -> body follows the curve like a real car
      const wb = c.len - 1.2;
      const s = c.s - (c.ds || 0) * back, off = c.off - (c.dOff || 0) * back;
      this.carPoint(c, s, A, off);
      const fx = A.x, fy = A.y, fz = A.z;
      this.carPoint(c, s - wb, B, off);
      const h = Math.atan2(fx - B.x, fy - B.y);
      c.rp = c.rp || new THREE.Vector3();
      c.rp.set((fx + B.x) / 2, Math.min(fz, B.z), (fy + B.y) / 2);
      c.rh = h;
      q.setFromAxisAngle(Y, h);
      sc.set(1, c.bus ? 1.75 : 1, c.bus ? c.len / 4.4 : 1);
      m.compose(c.rp, q, sc);
      this.mBody.setMatrixAt(i, m); this.mDark.setMatrixAt(i, m); this.mHead.setMatrixAt(i, m); this.mTail.setMatrixAt(i, m);
      this.mBody.instanceColor.setXYZ(i, c.col.r, c.col.g, c.col.b);
      const tc = c.brake ? tailOn : tailOff;
      const f = c.brake ? 1 : 0.4 + 1.2 * night;
      this.mTail.instanceColor.setXYZ(i, tc.r * f, tc.g * f, tc.b * f);
    });
    for (const mm of [this.mBody, this.mDark, this.mHead, this.mTail]) { mm.count = this.cars.length; mm.instanceMatrix.needsUpdate = true; }
    this.mBody.instanceColor.needsUpdate = this.mTail.instanceColor.needsUpdate = true;
    this.headMat.color.setRGB(0.85 + 2.2 * night, 0.82 + 2.0 * night, 0.72 + 1.6 * night);

    // trams: both ends of each section lie on the track, so articulation follows curves
    let ti = 0;
    this.tramSections = [];
    for (const tr of this.trams) {
      const p = this.tramPaths[tr.p];
      for (let k = 0; k < TRAM.n; k++) {
        const s0 = tr.s - (tr.ds || 0) * back - k * (TRAM.sec + TRAM.gap);
        at(p, s0, 0, A); at(p, s0 - TRAM.sec, 0, B);
        q.setFromAxisAngle(Y, Math.atan2(A.x - B.x, A.y - B.y));
        m.compose(pos.set((A.x + B.x) / 2, (A.z + B.z) / 2 + 0.05, (A.y + B.y) / 2), q, sc.set(1, 1, 1));
        this.tramSections.push([tr, pos.x, pos.z, Math.atan2(A.x - B.x, A.y - B.y), pos.y]);
        if (k === 0) { tr.rp = (tr.rp || new THREE.Vector3()).copy(pos); tr.rh = Math.atan2(A.x - B.x, A.y - B.y); }
        if (ti < this.MAXT) { this.mTram.setMatrixAt(ti, m); this.mTramWin.setMatrixAt(ti, m); ti++; }
      }
    }
    this.mTram.count = this.mTramWin.count = ti;
    this.mTram.instanceMatrix.needsUpdate = this.mTramWin.instanceMatrix.needsUpdate = true;
    this.tramWinMat.emissiveIntensity = night * 1.6;

    const k = 1 - Math.exp(-dt * 10);
    this.people.forEach((p, i) => {
      if (p.ctl) { // possessed (nav.js): where the player put them, legs going while they walk
        const C = p.ctl;
        p.rp = (p.rp || new THREE.Vector3()).set(C.x, C.y, C.z); p.rh = C.h;
        if (C.moving) p.ph += dt * 9;
        q.setFromAxisAngle(Y, p.rh);
        pos.copy(p.rp); if (C.moving) pos.y += 0.05 * Math.abs(Math.sin(p.ph));
        m.compose(pos, q, sc.set(1, 1, 1));
        this.mLegs.setMatrixAt(i, m); this.mTorso.setMatrixAt(i, m);
        this.mTorso.instanceColor.setXYZ(i, p.col.r, p.col.g, p.col.b);
        return;
      }
      const e = this.peds[p.e];
      const ds = p.wait ? 0 : p.v * lead;
      at(e, p.s + ds * p.dir, 0, A);
      at(e, p.s + (ds + 0.5) * p.dir, 0, B);
      let dx = B.x - A.x, dy = B.y - A.y; const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const x = A.x - dy * p.lat, y = A.y + dx * p.lat;
      const h = Math.atan2(dx, dy);
      if (!p.rp || Math.hypot(p.rp.x - x, p.rp.z - y) > 6) { p.rp = new THREE.Vector3(x, A.z, y); p.rh = h; }
      p.rp.lerp(pos.set(x, A.z, y), k);
      let dh = h - p.rh; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      p.rh += dh * k;
      q.setFromAxisAngle(Y, p.rh);
      pos.copy(p.rp);
      if (!p.wait) pos.y += 0.05 * Math.abs(Math.sin(p.ph + ds * 4.2));
      m.compose(pos, q, sc.set(1, 1, 1));
      this.mLegs.setMatrixAt(i, m); this.mTorso.setMatrixAt(i, m);
      this.mTorso.instanceColor.setXYZ(i, p.col.r, p.col.g, p.col.b);
    });
    const nd = this.renderDancers(this.people.length, m, q, pos, sc);
    this.mLegs.count = this.mTorso.count = this.people.length + nd;
    this.mLegs.instanceMatrix.needsUpdate = this.mTorso.instanceMatrix.needsUpdate = this.mTorso.instanceColor.needsUpdate = true;

    const LAMP = { R: [2.2, 0.12, 0.08, 3.95], Y: [2.2, 1.3, 0.1, 3.6], G: [0.1, 2.0, 0.6, 3.25] };
    this.heads.forEach(([x, row, gz, rot, ctrl, axis], i) => {
      const [r, g, b, hy] = LAMP[signalState(this.ctrls[ctrl], this.t, axis)];
      q.setFromAxisAngle(Y, rot + Math.PI);
      m.compose(pos.set(x + Math.sin(rot + Math.PI) * 0.19, gz + hy, row + Math.cos(rot + Math.PI) * 0.19), q, sc.set(1, 1, 1));
      this.mLamp.setMatrixAt(i, m);
      this.mLamp.instanceColor.setXYZ(i, r, g, b);
    });
    this.mLamp.count = this.heads.length;
    this.mLamp.instanceMatrix.needsUpdate = this.mLamp.instanceColor.needsUpdate = true;
  }

  // the zouk couples (DANCE), drawn after the walkers from instance i0; returns how many people that is
  renderDancers(i0, m, q, pos, sc) {
    const hh = this.hh ?? 12, gz = this.world?.groundAt(DANCE.x, DANCE.y);
    if (hh < DANCE.from || hh > DANCE.to || !gz) return 0;
    // they arrive over the first hour and leave over the last
    const n = Math.round(DANCE.couples * Math.min(1, (hh - DANCE.from) / 1, (DANCE.to - hh) / 1));
    const beat = this.t * DANCE.bpm / 60 * Math.PI; // one radian-pi per beat: sin(beat) swings once every 2 beats
    const SH = ['#b03a48', '#f0f0f0', '#2f2f33', '#d9a441', '#8b5fa8', '#3d6fa8', '#e07a9a', '#5a8fa3', '#c8553d', '#1f6f5c'];
    const Y = new THREE.Vector3(0, 1, 0), tilt = new THREE.Quaternion(), ax = new THREE.Vector3();
    const col = new THREE.Color();
    let i = i0;
    for (let k = 0; k < n && i + 1 < this.MAXP; k++) {
      const a = (k / DANCE.couples) * 2 * Math.PI + this.t * 0.03, rr = 0.25 + 0.6 * hash(k + 41);
      const cx = DANCE.x + Math.cos(a) * DANCE.rx * rr, cy = DANCE.y + Math.sin(a) * DANCE.ry * rr;
      const turn = hash(k + 7) * 6.28 + this.t * (0.25 + 0.3 * hash(k + 3)) * (k % 2 ? 1 : -1);
      // a spin every ~10 s (staggered): the follower steps out to arm's length and turns once on the spot
      const sp = (this.t * 0.1 + hash(k + 13)) % 1, spin = sp < 0.15 ? sstep(0, 1, sp / 0.15) : 0;
      const open = Math.sin(Math.PI * spin);
      const rock = 0.12 * Math.sin(beat + k), sep = 0.27 + 0.45 * open;
      const dx = Math.sin(turn), dy = Math.cos(turn); // leader -> follower
      for (const lead of [true, false]) {
        const s = lead ? -1 : 1, d = lead ? sep * 0.6 : sep;
        const x = cx + dx * (s * d + rock), y = cy + dy * (s * d + rock);
        let h = turn + (lead ? 0 : Math.PI); // face each other
        if (!lead) h += spin * 2 * Math.PI;
        q.setFromAxisAngle(Y, h);
        // the follower's body lean (zouk's head movement, as a swaying torso), the leader's small counter-lean
        const lean = lead ? 0.04 * Math.sin(beat * 0.5 + k) : 0.16 * Math.sin(beat * 0.25 + k * 1.7) * (1 - open);
        ax.set(Math.cos(h), 0, -Math.sin(h)); // the body's own side axis: lean back and forth
        tilt.setFromAxisAngle(ax, lean);
        q.premultiply(tilt);
        pos.set(x, gz + 0.03 * Math.abs(Math.sin(beat)), y);
        m.compose(pos, q, sc.set(1, lead ? 1.04 : 0.96, 1));
        this.mLegs.setMatrixAt(i, m); this.mTorso.setMatrixAt(i, m);
        col.set(SH[Math.floor(hash(k * 2 + (lead ? 0 : 1) + 101) * SH.length)]);
        this.mTorso.instanceColor.setXYZ(i, col.r, col.g, col.b);
        i++;
      }
    }
    return i - i0;
  }

  // ------------------------------------------------------------------ riding along
  // nearest agent to screen point (cx, cy): forgiving radius (people are a few pixels tall), skips hidden ones
  pick(camera, cx, cy, px, minPx, visible, skip) {
    const v = new THREE.Vector3(), cand = [];
    const f = (innerHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
    const scr = (x, y, z) => { v.set(x, y, z).project(camera); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
    // tap distance to the agent's body: a segment from its back to its front (a tram is 11 m long, a car 4 m), not its centre
    const test = (kind, obj, x, y, z, size, label, h, len = 0) => {
      if (obj === skip) return;
      const c = scr(x, y, z);
      if (!c) return;
      const dist = camera.position.distanceTo(v.set(x, y, z));
      const onScreen = size * f / dist; // projected size in px
      if (onScreen < minPx) return; // too small to mean it (a click on the map near a dot of a person)
      let d = Math.hypot(c[0] - cx, c[1] - cy);
      if (len) {
        const back = len / 2 + (obj.v || 0) * 0.5; // plus half a second behind: you tap where you saw it
        const hx = Math.sin(h), hz = Math.cos(h), a = scr(x - hx * back, y, z - hz * back), b = scr(x + hx * len / 2, y, z + hz * len / 2);
        if (a && b) { const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey || 1, t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cy - a[1]) * ey) / L2));
          d = Math.hypot(a[0] + ex * t - cx, a[1] + ey * t - cy); }
      }
      const r = Math.max(px, onScreen * 0.55);
      // visibility is tested towards the top of the agent: a kerb or a bench must not hide a person
      if (d < r) cand.push({ kind, obj, score: d / r + dist / 3000, at: new THREE.Vector3(x, y + size * 0.3, z), dist, label });
    };
    for (const c of this.cars) if (c.rp) test('car', c, c.rp.x, c.rp.y + 0.8, c.rp.z, c.bus ? 6 : 3.5, c.bus ? 'bus' : 'car', c.rh, c.len);
    for (const p of this.people) if (p.rp) test('person', p, p.rp.x, p.rp.y + 0.9, p.rp.z, 1.6, 'person');
    for (const [tr, x, z, h, y] of this.tramSections || []) test('tram', tr, x, (y ?? 0) + 1.6, z, 9, this.tramPaths[tr.p].ref ? `tram ${this.tramPaths[tr.p].ref}` : 'tram', h, TRAM.sec);
    cand.sort((a, b) => a.score - b.score);
    for (const c of cand.slice(0, 6)) if (visible(c.obj, c.at.clone().sub(camera.position))) return c;
    return null;
  }
  // current position (ground level) and heading of an agent, or null once it has left the simulation
  pose(kind, obj) {
    const list = kind === 'car' ? this.cars : kind === 'tram' ? this.trams : this.people;
    if (!obj.rp || !list.includes(obj)) return null;
    return { x: obj.rp.x, y: obj.rp.y, z: obj.rp.z, h: obj.rh };
  }
  nearest(kind, at, skip) {
    const list = kind === 'car' ? this.cars : kind === 'tram' ? this.trams : this.people;
    let best = null, bd = Infinity;
    for (const o of list) {
      if (o === skip || !o.rp) continue;
      const d = Math.hypot(o.rp.x - at.x, o.rp.z - at.z);
      const moving = kind === 'person' || o.v > 1.5; // a ride stuck in a jam is boring: prefer one that is moving
      const dd = d + (moving ? 0 : 400);
      if (dd < bd && d > (kind === 'person' ? 3 : 8)) { bd = dd; best = o; }
    }
    if (!best) return null;
    const label = kind === 'tram' ? (this.tramPaths[best.p].ref ? `tram ${this.tramPaths[best.p].ref}` : 'tram') : kind === 'car' ? (best.bus ? 'bus' : 'car') : 'person';
    return { kind, obj: best, label };
  }

  update(dt, hour, night, focus) {
    dt = Math.min(dt, 0.1);
    if (focus) {
      const A = this.active, R = 900;
      if (!A || (A.x - focus.x) ** 2 + (A.z - focus.z) ** 2 > 120 * 120) this.setActive(focus.x, focus.z, R);
    }
    const hh = this.hh = ((hour % 24) + 24) % 24;
    const bell = (c, w) => Math.exp(-(((hh - c) / w) ** 2));
    const cars = Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5));
    const peds = Math.min(1, 0.08 + 0.4 * bell(8.5, 1.8) + 0.85 * bell(16, 4.5) + 0.25 * bell(21, 2));
    const trams = hh > 0.5 && hh < 5 ? 0 : 1; // night break in tram service
    this.acc = (this.acc || 0) + dt;
    while (this.acc >= STEP) { this.step(STEP, { cars, peds, trams }); this.acc -= STEP; }
    this.render(dt, night, this.acc);
  }
}
