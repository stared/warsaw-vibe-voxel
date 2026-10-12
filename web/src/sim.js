import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Live street simulation on the real OSM networks (scripts/traffic.py):
//  - signal controllers: two-axis fixed-time cycle (green / amber / all-red), per-junction offset
//  - cars: Intelligent Driver Model car-following per lane, stop at red/amber, slow for turns,
//          pick the next edge at junctions (prefer straight & bigger roads, no U-turns)
//  - pedestrians: random walk on the footpath graph, keep right, wait for green at signalled crossings
//  - density follows the time of day

const CYCLE = 64, GREEN = 26, AMBER = 3, ALLRED = 3; // s; axis 0 then axis 1
const PED_GREEN = 18; // pedestrians cross during the first part of the parallel car green
const LANE_W = 3.0;
const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };

const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };

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

// ---------------------------------------------------------------------------------------- geometry helpers
function prepEdge(e) {
  const n = e.p.length;
  e.cum = new Float32Array(n);
  for (let i = 1; i < n; i++) e.cum[i] = e.cum[i - 1] + Math.hypot(e.p[i][0] - e.p[i - 1][0], e.p[i][1] - e.p[i - 1][1]);
  e.L = e.cum[n - 1];
}
function sample(e, s, out) {
  s = Math.min(Math.max(s, 0), e.L);
  const c = e.cum;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m; else hi = m; }
  const a = e.p[lo], b = e.p[hi];
  const seg = c[hi] - c[lo] || 1e-6, f = (s - c[lo]) / seg;
  out.x = a[0] + (b[0] - a[0]) * f;
  out.y = a[1] + (b[1] - a[1]) * f;
  out.z = a[2] + (b[2] - a[2]) * f;
  out.dx = (b[0] - a[0]) / seg;
  out.dy = (b[1] - a[1]) / seg;
  return out;
}
function endDir(e, atEnd) {
  const p = e.p, n = p.length;
  const [a, b] = atEnd ? [p[n - 2], p[n - 1]] : [p[0], p[1]];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// ---------------------------------------------------------------------------------------- signals
export function signalState(ctrl, t, axis) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  const start = axis === 0 ? 0 : CYCLE / 2;
  const k = ((u - start) % CYCLE + CYCLE) % CYCLE;
  if (k < GREEN) return 'G';
  if (k < GREEN + AMBER) return 'Y';
  return 'R';
}
function pedGreen(ctrl, t, axis) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  const start = axis === 0 ? 0 : CYCLE / 2;
  const k = ((u - start) % CYCLE + CYCLE) % CYCLE;
  return k < PED_GREEN;
}

// ---------------------------------------------------------------------------------------- simulation
export class StreetLife {
  constructor(scene, data) {
    this.t = 0;
    this.roads = data.roads;
    this.peds = data.peds;
    this.ctrls = data.ctrls.map((c, i) => ({ ...c, off: hash(i + 1) * CYCLE }));
    this.roads.forEach(prepEdge);
    this.peds.forEach(prepEdge);
    // road topology
    this.outs = new Map();
    this.hasIn = new Set();
    this.roads.forEach((e, i) => {
      e.i = i;
      e.lists = Array.from({ length: e.lanes }, () => []);
      if (!this.outs.has(e.a)) this.outs.set(e.a, []);
      this.outs.get(e.a).push(i);
      this.hasIn.add(e.b);
      e.endD = endDir(e, true);
      e.startD = endDir(e, false);
    });
    this.sources = this.roads.filter((e) => !this.hasIn.has(e.a) && e.L > 15).map((e) => e.i);
    this.roadW = this.roads.map((e) => e.L * e.lanes * e.c);
    this.roadWsum = this.roadW.reduce((a, b) => a + b, 0);
    this.laneKm = this.roads.reduce((a, e) => a + e.L * e.lanes, 0) / 1000;
    // pedestrian topology (undirected)
    this.padj = new Map();
    this.peds.forEach((e, i) => {
      e.i = i;
      for (const [n, end] of [[e.a, 0], [e.b, 1]]) {
        if (!this.padj.has(n)) this.padj.set(n, []);
        this.padj.get(n).push([i, end]);
      }
    });
    this.pedW = this.peds.map((e) => e.L * e.w);
    this.pedWsum = this.pedW.reduce((a, b) => a + b, 0);
    this.pedKm = this.peds.reduce((a, e) => a + e.L, 0) / 1000;

    this.cars = [];
    this.people = [];
    this.buildMeshes(scene, data);
    this.tmp = { x: 0, y: 0, z: 0, dx: 0, dy: 0 };
  }

  // ------------------------------------------------------------------ meshes
  buildMeshes(scene, data) {
    this.group = new THREE.Group();
    scene.add(this.group);
    const MAXC = 1400, MAXP = 4000;
    const bodyGeo = mergeGeometries([box(1.8, 0.75, 4.4, 0, 0.3, 0), box(1.62, 0.62, 2.3, 0, 1.05, -0.25)]);
    const darkGeo = mergeGeometries([
      box(1.66, 0.5, 2.2, 0, 1.1, -0.25, 0x1d2329), // glass band
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
    // people: legs+head (vertex colours) and torso (instance colour)
    const legGeo = mergeGeometries([box(0.18, 0.85, 0.22, -0.1, 0, 0, 0x2b3240), box(0.18, 0.85, 0.22, 0.1, 0, 0, 0x2b3240),
      box(0.3, 0.3, 0.3, 0, 1.45, 0, 0xe0b48f), box(0.32, 0.1, 0.32, 0, 1.72, 0, 0x3a2a20)]);
    const torsoGeo = box(0.46, 0.62, 0.3, 0, 0.85, 0);
    this.mLegs = new THREE.InstancedMesh(legGeo, std({ vertexColors: true, roughness: 0.9, metalness: 0 }), MAXP);
    this.mTorso = new THREE.InstancedMesh(torsoGeo, std({ color: 0xffffff, roughness: 0.9, metalness: 0 }), MAXP);
    this.mLegs.castShadow = this.mTorso.castShadow = true;
    // traffic lights: graphite pole + housing, plus one lit lamp whose colour/height follow the phase
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
    for (const mesh of [this.mBody, this.mDark, this.mHead, this.mTail, this.mLegs, this.mTorso, this.mPole, this.mLamp]) {
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.mBody.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 3), 3);
    this.mTail.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXC * 3), 3);
    this.mTorso.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAXP * 3), 3);
    this.mLamp.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, heads.length) * 3), 3);
    this.MAXC = MAXC; this.MAXP = MAXP;
  }

  // ------------------------------------------------------------------ spawning
  pickWeighted(w, sum) {
    let r = Math.random() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }
  laneFree(e, lane, s, gap) {
    return e.lists[lane].every((c) => Math.abs(c.s - s) > gap);
  }
  spawnCar(fromSource) {
    const ei = fromSource && this.sources.length ? this.sources[(Math.random() * this.sources.length) | 0] : this.pickWeighted(this.roadW, this.roadWsum);
    const e = this.roads[ei];
    const lane = (Math.random() * e.lanes) | 0;
    const s = fromSource ? 0 : Math.random() * e.L;
    if (!this.laneFree(e, lane, s, 12)) return;
    const bus = e.c >= 2 && Math.random() < 0.06;
    const PAL = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
    const car = {
      e: ei, lane, s, v: e.v * 0.6, len: bus ? 12 : 4.6, bus,
      v0f: 0.85 + Math.random() * 0.25, col: new THREE.Color(bus ? '#f2c230' : PAL[(Math.random() * PAL.length) | 0]),
      rp: null, rh: 0, brake: 0,
    };
    car.next = this.chooseNext(e);
    e.lists[lane].push(car);
    this.cars.push(car);
  }
  chooseNext(e) {
    const outs = (this.outs.get(e.b) || []).filter((j) => {
      const o = this.roads[j];
      return !(o.b === e.a && Math.abs(o.L - e.L) < 0.5); // no U-turn onto the reverse edge
    });
    if (!outs.length) return -1;
    const w = outs.map((j) => {
      const o = this.roads[j];
      const dot = e.endD[0] * o.startD[0] + e.endD[1] * o.startD[1];
      return (dot > 0.7 ? 4 : dot > -0.3 ? 1 : 0.15) * o.c;
    });
    return outs[this.pickWeighted(w, w.reduce((a, b) => a + b, 0))];
  }
  spawnPed() {
    const ei = this.pickWeighted(this.pedW, this.pedWsum);
    const e = this.peds[ei];
    const SH = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
    this.people.push({
      e: ei, dir: Math.random() < 0.5 ? 1 : -1, s: Math.random() * e.L, v: 1.05 + Math.random() * 0.55,
      lat: 0.35 + Math.random() * 1.0, ph: Math.random() * 6.28, wait: false,
      col: new THREE.Color(SH[(Math.random() * SH.length) | 0]), rp: null, rh: 0,
    });
  }

  // ------------------------------------------------------------------ step
  carGapAhead(car, e) {
    // nearest obstacle ahead: car in lane, then first car on the next edge, then a red light
    const list = e.lists[car.lane];
    let gap = Infinity, lv = 0;
    for (const o of list) {
      if (o !== car && o.s > car.s) {
        const g = o.s - o.len - car.s;
        if (g < gap) { gap = g; lv = o.v; }
      }
    }
    if (gap === Infinity && car.next >= 0) {
      const n = this.roads[car.next];
      const nl = Math.min(car.lane, n.lanes - 1);
      let minS = Infinity, mv = 0, ml = 0;
      for (const o of n.lists[nl]) if (o.s < minS) { minS = o.s; mv = o.v; ml = o.len; }
      if (minS < Infinity) { gap = e.L - car.s + minS - ml; lv = mv; }
    }
    const sg = e.sig;
    if (sg && car.s < sg.s + 0.3) {
      const st = signalState(this.ctrls[sg.ctrl], this.t, sg.axis);
      const d = sg.s - car.s;
      const canStop = d > (car.v * car.v) / (2 * IDM.b) + 1;
      if (st === 'R' || (st === 'Y' && canStop)) {
        if (d < gap) { gap = d; lv = 0; }
      }
    }
    return [gap, lv];
  }

  step(dt, density) {
    this.t += dt;
    // population control
    const targetCars = Math.min(this.MAXC, Math.round(this.laneKm * 12 * density.cars));
    const targetPeds = Math.min(this.MAXP, Math.round(this.pedKm * 24 * density.peds));
    for (let k = 0; k < 6 && this.cars.length < targetCars; k++) this.spawnCar(this.cars.length > targetCars * 0.5);
    for (let k = 0; k < 40 && this.people.length < targetPeds; k++) this.spawnPed();
    if (this.people.length > targetPeds) this.people.length = targetPeds;

    // cars
    const removed = new Set();
    for (const car of this.cars) {
      const e = this.roads[car.e];
      let v0 = e.v * car.v0f;
      if (car.next >= 0 && e.L - car.s < 25) {
        const n = this.roads[car.next];
        const dot = e.endD[0] * n.startD[0] + e.endD[1] * n.startD[1];
        if (dot < 0.7) v0 = Math.min(v0, dot < 0 ? 4.5 : 7); // slow down for turns
      }
      const [gap, lv] = this.carGapAhead(car, e);
      const ss = IDM.s0 + Math.max(0, car.v * IDM.T + (car.v * (car.v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      let acc = IDM.a * (1 - Math.pow(car.v / Math.max(v0, 0.1), 4) - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2));
      acc = Math.max(acc, -8);
      car.brake = acc < -0.8 || car.v < 0.3 ? 1 : 0;
      car.v = Math.max(0, car.v + acc * dt);
      car.s += car.v * dt;
      if (car.s > e.L) {
        const lst = e.lists[car.lane];
        lst.splice(lst.indexOf(car), 1);
        if (car.next < 0 || this.cars.length > targetCars + 4) { removed.add(car); continue; }
        car.s -= e.L;
        car.e = car.next;
        const n = this.roads[car.e];
        car.lane = Math.min(car.lane, n.lanes - 1);
        if (n.lanes > 1 && Math.random() < 0.3) car.lane = (Math.random() * n.lanes) | 0;
        n.lists[car.lane].push(car);
        car.next = this.chooseNext(n);
      }
    }
    if (removed.size) this.cars = this.cars.filter((c) => !removed.has(c));

    // pedestrians
    for (const p of this.people) {
      const e = this.peds[p.e];
      if (p.wait) {
        if (pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) p.wait = false;
        else continue;
      }
      p.s += p.v * dt * p.dir;
      p.ph += p.v * dt * 4.2;
      if (p.s < 0 || p.s > e.L) {
        const node = p.s < 0 ? e.a : e.b;
        const opts = (this.padj.get(node) || []).filter(([j]) => j !== p.e);
        if (!opts.length) { p.dir *= -1; p.s = Math.min(Math.max(p.s, 0), e.L); continue; }
        const w = opts.map(([j]) => this.peds[j].w * (this.peds[j].x ? 1.2 : 1));
        const [j, end] = opts[this.pickWeighted(w, w.reduce((a, b) => a + b, 0))];
        p.e = j;
        const n = this.peds[j];
        p.dir = end === 0 ? 1 : -1;
        p.s = end === 0 ? 0 : n.L;
        if (n.x && !pedGreen(this.ctrls[n.x.ctrl], this.t, n.x.axis)) p.wait = true; // wait at the kerb
      }
    }
  }

  // ------------------------------------------------------------------ render
  render(dt, night) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const Y = new THREE.Vector3(0, 1, 0);
    const t = this.tmp;
    const k = 1 - Math.exp(-dt * 10);
    const tailOff = new THREE.Color(0.55, 0.06, 0.05), tailOn = new THREE.Color(2.2, 0.15, 0.1);
    this.cars.forEach((c, i) => {
      const e = this.roads[c.e];
      sample(e, c.s - c.len / 2, t);
      const off = e.two ? (c.lane + 0.5) * LANE_W : (c.lane + 0.5 - e.lanes / 2) * LANE_W;
      const x = t.x - t.dy * off, y = t.y + t.dx * off;
      const h = Math.atan2(t.dx, t.dy);
      if (!c.rp || Math.hypot(c.rp.x - x, c.rp.z - y) > 15) { c.rp = new THREE.Vector3(x, t.z, y); c.rh = h; }
      c.rp.lerp(pos.set(x, t.z, y), k);
      let dh = h - c.rh; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      c.rh += dh * k;
      q.setFromAxisAngle(Y, c.rh);
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

    this.people.forEach((p, i) => {
      const e = this.peds[p.e];
      sample(e, p.s, t);
      const dx = t.dx * p.dir, dy = t.dy * p.dir;
      const x = t.x - dy * p.lat, y = t.y + dx * p.lat;
      const h = Math.atan2(dx, dy);
      if (!p.rp || Math.hypot(p.rp.x - x, p.rp.z - y) > 6) { p.rp = new THREE.Vector3(x, t.z, y); p.rh = h; }
      p.rp.lerp(pos.set(x, t.z, y), k);
      let dh = h - p.rh; dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      p.rh += dh * k;
      q.setFromAxisAngle(Y, p.rh);
      pos.copy(p.rp);
      if (!p.wait) pos.y += 0.05 * Math.abs(Math.sin(p.ph));
      m.compose(pos, q, sc.set(1, 1, 1));
      this.mLegs.setMatrixAt(i, m); this.mTorso.setMatrixAt(i, m);
      this.mTorso.instanceColor.setXYZ(i, p.col.r, p.col.g, p.col.b);
    });
    this.mLegs.count = this.mTorso.count = this.people.length;
    this.mLegs.instanceMatrix.needsUpdate = this.mTorso.instanceMatrix.needsUpdate = this.mTorso.instanceColor.needsUpdate = true;

    // signal lamps: red top, amber middle, green bottom
    const LAMP = { R: [2.2, 0.12, 0.08, 3.95], Y: [2.2, 1.3, 0.1, 3.6], G: [0.1, 2.0, 0.6, 3.25] };
    this.heads.forEach(([x, z0, y0, rot, ctrl, axis], i) => {
      const st = signalState(this.ctrls[ctrl], this.t, axis);
      const [r, g, b, hy] = LAMP[st];
      q.setFromAxisAngle(Y, rot + Math.PI);
      const fx = Math.sin(rot + Math.PI) * 0.19, fz = Math.cos(rot + Math.PI) * 0.19;
      m.compose(pos.set(x + fx, y0 + hy, z0 + fz), q, sc.set(1, 1, 1));
      this.mLamp.setMatrixAt(i, m);
      this.mLamp.instanceColor.setXYZ(i, r, g, b);
    });
    this.mLamp.count = this.heads.length;
    this.mLamp.instanceMatrix.needsUpdate = this.mLamp.instanceColor.needsUpdate = true;
  }

  update(dt, hour, night) {
    dt = Math.min(dt, 0.1);
    // time-of-day density: night trough ~03:00, rush hours; people peak in the afternoon/evening
    const hh = ((hour % 24) + 24) % 24;
    const bell = (c, w) => Math.exp(-(((hh - c) / w) ** 2));
    const cars = Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5));
    const peds = Math.min(1, 0.08 + 0.4 * bell(8.5, 1.8) + 0.85 * bell(16, 4.5) + 0.25 * bell(21, 2));
    const sub = dt > 0.05 ? 2 : 1;
    for (let i = 0; i < sub; i++) this.step(dt / sub, { cars, peds });
    this.render(dt, night);
  }
}
