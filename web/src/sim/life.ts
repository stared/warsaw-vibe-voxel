import * as THREE from 'three';
import { hash, pushTo, smooth } from '../util';
import type { World } from '../world';
import { findCrossings } from './crossings';
import { drawDancers, DANCE } from './dance';
import { LifeMeshes, MAX_CARS, MAX_PEOPLE, MAX_TRAM_SECTIONS, setCount } from './meshes';
import { at, cellKey, landingLane, prepPath, pt, Turn, turnOf, type Pt } from './path';
import type { Agent, Car, Controller, Kind, PedEdge, Person, Pose, Rideable, Road, TrafficData, Tram, TramPath, TramStop } from './types';

// Live streets on the real OSM networks (scripts/traffic.py): fixed-time signals; cars with the Intelligent Driver
// Model per lane, turn lanes, OSM turn restrictions and junction "box" locks; trams along their routes; people on
// footpaths, waiting for green at signalled crossings. Density follows the hour.

const CYCLE = 64, GREEN = 26, AMBER = 3, PED_GREEN = 18;
const LANE_W = 3.0;
const IDM = { a: 1.4, b: 2.2, s0: 2.2, T: 1.2 };
const BLEND = 7;
const BOX_IN = 7, BOX_OUT = 9;
const STEP = 1 / 30;
const TRAM = { sec: 10.5, gap: 0.6, n: 3, v: 11, a: 1.0, b: 1.6, headway: 300 };
const TRAM_LEN = TRAM.n * (TRAM.sec + TRAM.gap);
const ACTIVE_R = 900;
const CAR_COLOURS = ['#f0f0ee', '#e9e9e7', '#1c1c1e', '#2a2c30', '#8e9399', '#b9bcc0', '#5d6670', '#9b2a24', '#24467a', '#3d5a3a', '#c9b48e', '#6e1f2a'];
const SHIRTS = ['#c8553d', '#3d6fa8', '#e8e3d6', '#2f2f33', '#7a9a5b', '#d9a441', '#8b5fa8', '#5a8fa3', '#b03a48', '#f0f0f0', '#45505c', '#c97f5d'];
const SOFT = ['spatial', 'box-busy', 'no-room-exit', 'hold-at-line', 'keep-crossing-clear', 'next-edge-car', 'tram-crossing', 'tram'];
const TRAM_HARD = ['road-occupied', 'car-on-track', 'tram'];

function phase(ctrl: Controller, t: number, axis: number) {
  const u = ((t + ctrl.off) % CYCLE + CYCLE) % CYCLE;
  return ((u - (axis === 0 ? 0 : CYCLE / 2)) % CYCLE + CYCLE) % CYCLE;
}
const signal = (ctrl: Controller, t: number, axis: number) => { const k = phase(ctrl, t, axis); return k < GREEN ? 'G' : k < GREEN + AMBER ? 'Y' : 'R'; };
const pedGreen = (ctrl: Controller, t: number, axis: number) => phase(ctrl, t, axis) < PED_GREEN;

function pickWeighted(w: number[], sum = w.reduce((a, b) => a + b, 0)) {
  let r = Math.random() * sum;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}
const anyOf = <T>(a: T[]) => a[(Math.random() * a.length) | 0];

export interface Picked { kind: Kind; obj: Rideable; label: string }

export class StreetLife {
  world: World | null = null;
  keep: Rideable | null = null;
  readonly peds: PedEdge[];
  readonly cars: Car[] = [];
  readonly trams: Tram[] = [];
  people: Person[] = [];
  private t = 0;
  private hour = 12;
  private acc = 0;
  private readonly M: LifeMeshes;
  private readonly roads: Road[];
  private readonly ctrls: Controller[];
  private readonly heads: [number, number, number, number, number, number][];
  private readonly tramPaths: TramPath[];
  private readonly outs = new Map<number, number[]>();
  private readonly ins = new Map<number, number[]>();
  private readonly padj = new Map<number, [number, number][]>();
  private readonly restr = new Map<string, { to: number; type: string }[]>();
  private readonly box = new Map<number, Set<Car>>();
  private readonly roadX: Map<number, { sR: number; path: number; sT: number }[]>;
  private readonly diamonds: { holder: Tram | null }[];
  private active: { x: number; z: number } | null = null;
  private roadOn: boolean[] = [];
  private pedOn: boolean[] = [];
  private roadW: number[] = [];
  private pedW: number[] = [];
  private sources: number[] = [];
  private laneKm = 0;
  private pedKm = 0;
  private tramGrid = new Map<number, [number, number, Tram][]>();
  private carGrid = new Map<number, Car[]>();
  private tramSections: [Tram, number, number, number, number][] = [];
  private idSeq = 1;
  private readonly tmp = pt();

  constructor(scene: THREE.Scene, data: TrafficData) {
    this.roads = data.roads.map((r, i) => Object.assign(prepPath(r), { i, lists: Array.from({ length: r.lanes }, () => []) }));
    this.peds = data.peds.map((e, i) => Object.assign(prepPath(e), { i }));
    this.ctrls = data.ctrls.map((c, i) => ({ ...c, off: hash(i + 1) * CYCLE }));
    this.heads = data.heads ?? [];
    this.roads.forEach((e, i) => { pushTo(this.outs, e.a, i); pushTo(this.ins, e.b, i); });
    this.peds.forEach((e, i) => { pushTo(this.padj, e.a, [i, 0]); pushTo(this.padj, e.b, [i, 1]); });
    for (const [fr, via, to, type] of data.restr ?? []) pushTo(this.restr, `${fr}:${via}`, { to, type });
    this.tramPaths = (data.trams ?? []).map((p, i) => {
      const tp = Object.assign(prepPath(p), { i, stops: [] as TramStop[], nextSpawn: hash(i + 7) * TRAM.headway, xs: [] });
      tp.stops = this.tramStops(tp);
      return tp;
    });
    ({ roadX: this.roadX, diamonds: this.diamonds } = findCrossings(this.roads, this.tramPaths));
    for (const p of this.tramPaths)
      for (let s = hash(p.i + 3) * 500 + 60; s < p.L - 40; s += 450 + hash(s) * 300) if (this.tramClear(p, s)) this.trams.push(this.newTram(p, s));
    this.M = new LifeMeshes(scene, this.heads, TRAM.sec);
  }

  get group() { return this.M.group; }

  update(dt: number, hour: number, night: number, focus: { x: number; z: number }) {
    dt = Math.min(dt, 0.1);
    const A = this.active;
    if (!A || (A.x - focus.x) ** 2 + (A.z - focus.z) ** 2 > 120 * 120) this.setActive(focus.x, focus.z);
    const hh = this.hour = ((hour % 24) + 24) % 24;
    const bell = (c: number, w: number) => Math.exp(-(((hh - c) / w) ** 2));
    const density = {
      cars: Math.min(1, 0.18 + 0.55 * bell(8, 2.2) + 0.5 * bell(17, 2.6) + 0.45 * bell(13, 5)),
      peds: Math.min(1, 0.08 + 0.4 * bell(8.5, 1.8) + 0.85 * bell(16, 4.5) + 0.25 * bell(21, 2)),
      trams: hh > 0.5 && hh < 5 ? 0 : 1,
    };
    this.acc += dt;
    while (this.acc >= STEP) { this.step(STEP, density); this.acc -= STEP; }
    this.render(dt, night, this.acc);
  }

  // ------------------------------------------------------------------ the area around the camera
  // Only a circle around the focus is simulated: roads leaving it are exits, roads entering it are sources, and
  // agents left outside are removed. Trams run everywhere.
  private setActive(x: number, z: number) {
    const R = ACTIVE_R, near = (e: { p: number[][] }) => [e.p[0], e.p[e.p.length >> 1], e.p[e.p.length - 1]].some((q) => (q[0] - x) ** 2 + (q[1] - z) ** 2 < R * R);
    this.roadOn = this.roads.map(near);
    this.pedOn = this.peds.map(near);
    this.roadW = this.roads.map((e, i) => (this.roadOn[i] ? e.L * e.lanes * e.c : 0));
    this.laneKm = this.roads.reduce((a, e, i) => a + (this.roadOn[i] ? e.L * e.lanes : 0), 0) / 1000;
    this.sources = this.roads.filter((e, i) => this.roadOn[i] && e.L > 15 && !(this.ins.get(e.a) ?? []).some((j) => this.roadOn[j])).map((e) => e.i);
    this.pedW = this.peds.map((e, i) => (this.pedOn[i] ? e.L * e.w : 0));
    this.pedKm = this.peds.reduce((a, e, i) => a + (this.pedOn[i] ? e.L : 0), 0) / 1000;
    const out = new Set(this.cars.filter((c) => !this.roadOn[c.e] && c !== this.keep));
    for (const c of out) this.removeCar(c);
    if (out.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !out.has(c)));
    this.people = this.people.filter((p) => this.pedOn[p.e] || p === this.keep || p.ctl);
    this.active = { x, z };
  }

  // ------------------------------------------------------------------ spawning
  private spawnCar(fromSource: boolean) {
    const ei = fromSource && this.sources.length ? anyOf(this.sources) : pickWeighted(this.roadW);
    const e = this.roads[ei], lane = (Math.random() * e.lanes) | 0;
    const s = fromSource ? 0 : 10 + Math.random() * Math.max(0, e.L - 20 - BOX_IN - 12);
    if (s > e.L - BOX_IN - 12 || !this.laneGapOK(e, lane, s, null)) return;
    const bus = e.c >= 2 && Math.random() < 0.06;
    const car: Car = {
      kind: 'car', id: this.idSeq++, e: ei, lane, s, v: e.v * 0.6, len: bus ? 12 : 4.6, bus, prev: -1, prevOff: 0, next: -1,
      v0f: 0.85 + Math.random() * 0.25, col: new THREE.Color(bus ? '#f2c230' : anyOf(CAR_COLOURS)),
      off: this.laneOffset(e, lane), brake: 0, wait: 0, ghost: 0, ds: 0, dOff: 0, why: 'free', by: null,
      boxNode: -1, boxFrom: -1, boxTo: -1, boxLane: 0, boxT: 0, boxTurn: 0, block: null,
      geo: { px: 0, py: 0, cx: 0, cy: 0, z: 0, fx: 0, fy: 0 },
    };
    car.next = this.chooseNext(e);
    e.lists[lane].push(car);
    this.cars.push(car);
  }

  private spawnPed() {
    const ei = pickWeighted(this.pedW), e = this.peds[ei];
    this.people.push({ kind: 'person', e: ei, dir: Math.random() < 0.5 ? 1 : -1, s: Math.random() * e.L, v: 1.05 + Math.random() * 0.55,
      lat: 0.35 + Math.random() * 1.0, ph: Math.random() * 6.28, wait: false, col: new THREE.Color(anyOf(SHIRTS)) });
  }

  private newTram(p: TramPath, s: number): Tram {
    return { kind: 'tram', p: p.i, s, v: TRAM.v * 0.8, ds: 0, near: true, yieldTo: -1, why: 'free', by: null };
  }

  private tramClear(p: TramPath, s: number) {
    const q = at(p, s, 0, pt()), o = pt();
    return !this.trams.some((tr) => {
      for (let k = 0; k <= TRAM.n; k++) {
        at(this.tramPaths[tr.p], tr.s - k * (TRAM.sec + TRAM.gap), 0, o);
        if (Math.hypot(o.x - q.x, o.y - q.y) < 45) return true;
      }
      return false;
    });
  }

  // stop lines 14 m before each signalled junction on the line
  private tramStops(p: TramPath) {
    const pts: [number, number, number][] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let s = 0; s < p.L; s += 2) {
      const q = at(p, s, 0, pt());
      pts.push([s, q.x, q.y]);
      x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y);
    }
    const stops: TramStop[] = [];
    this.ctrls.forEach((c, ci) => {
      if (c.x < x0 - 18 || c.x > x1 + 18 || c.y < y0 - 18 || c.y > y1 + 18) return;
      let best = Infinity, bs = 0;
      for (const [s, qx, qy] of pts) { const d = Math.hypot(qx - c.x, qy - c.y); if (d < best) { best = d; bs = s; } }
      if (best < 18 && bs > 20) {
        const a = at(p, bs - 16, 0, pt()), b = at(p, bs - 12, 0, pt());
        stops.push({ s: bs - 14, ctrl: ci, axis: Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 0 : 1 });
      }
    });
    return stops.sort((a, b) => a.s - b.s);
  }

  // ------------------------------------------------------------------ routing
  private laneOffset(e: Road, lane: number) { return e.o0 + lane * LANE_W; }

  private chooseNext(e: Road) {
    let outs = (this.outs.get(e.b) ?? []).filter((j) => { const o = this.roads[j]; return turnOf(e, o) !== Turn.Back && !(o.b === e.a && o.w === e.w); });
    for (const r of this.restr.get(`${e.w}:${e.b}`) ?? []) {
      if (r.type.startsWith('only_')) outs = outs.filter((j) => this.roads[j].w === r.to);
      else if (r.type.startsWith('no_')) outs = outs.filter((j) => this.roads[j].w !== r.to);
    }
    outs = outs.filter((j) => this.roadOn[j]);
    if (!outs.length) return -1;
    return outs[pickWeighted(outs.map((j) => { const o = this.roads[j]; return (turnOf(e, o) === Turn.Straight ? 4 : 1) * o.c * (o.L > 6 ? 1 : 0.3); }))];
  }

  private nextTurn(car: Car, e: Road) { return car.next >= 0 ? turnOf(e, this.roads[car.next]) : Turn.Straight; }

  private desiredLane(car: Car, e: Road) {
    if (car.next < 0 || e.lanes === 1) return car.lane;
    const t = this.nextTurn(car, e);
    return t === Turn.Left ? 0 : t === Turn.Right ? e.lanes - 1 : car.lane;
  }

  private laneGapOK(e: Road, lane: number, s: number, car: Car | null) {
    const myLen = car ? car.len : 4.6;
    if (e.lists[lane].some((o) => o !== car && o.s > s - myLen - 5 && o.s - o.len < s + 7)) return false;
    return !e.lists.some((l) => l.some((o) => o !== car && o.lcTo === lane && Math.abs(o.s - s) < 12));
  }

  private removeCar(c: Car) {
    const l = this.roads[c.e].lists[c.lane];
    l.splice(l.indexOf(c), 1);
    this.boxLeave(c);
  }

  // ------------------------------------------------------------------ junction box
  // May this car enter junction n now? Fine alongside: the same approach in lanes ordered like their turns, parallel
  // approaches, opposite flows that don't turn left; never two into the same road at once.
  private boxBlocker(car: Car, e: Road, n: number): Car | null {
    const myTurn = this.nextTurn(car, e);
    for (const h of this.box.get(n) ?? []) {
      if (h === car) continue;
      if (h.boxFrom === e.i) {
        const dl = car.lane - h.boxLane, dt = myTurn - h.boxTurn;
        if (dl === 0) continue;
        if (dl * dt < 0) return h;
        if (h.boxTo === car.next && car.next >= 0) {
          const lanes = this.roads[car.next].lanes;
          if (landingLane(myTurn, car.lane, lanes) === landingLane(h.boxTurn as Turn, h.boxLane, lanes)) return h;
        }
        continue;
      }
      if (h.boxTo === car.next && car.next >= 0) return h;
      const he = this.roads[h.boxFrom], dot = he.endD[0] * e.endD[0] + he.endD[1] * e.endD[1];
      if (dot > 0.75) continue;
      if (dot < -0.75 && myTurn !== Turn.Left && h.boxTurn !== Turn.Left) continue;
      return h;
    }
    return null;
  }

  private boxEnter(car: Car, e: Road, n: number) {
    Object.assign(car, { boxNode: n, boxFrom: e.i, boxTo: car.next, boxLane: car.lane, boxT: this.t, boxTurn: this.nextTurn(car, e) });
    const set = this.box.get(n) ?? new Set<Car>();
    this.box.set(n, set.add(car));
  }

  private boxLeave(car: Car) {
    if (car.boxNode >= 0) { this.box.get(car.boxNode)?.delete(car); car.boxNode = -1; }
  }

  // ------------------------------------------------------------------ what a car must keep its distance to
  private carObstacle(car: Car, e: Road): [number, number] {
    let gap = Infinity, lv = 0, why = 'free', by: Agent | null = null;
    const stop = (d: number, reason: string, who: Agent | null, speed = 0) => { if (d < gap) { gap = Math.max(d, 0.01); lv = speed; why = reason; by = who; } };
    const assertive = car.ghost > 0;
    const ig = car.ignore && (car.ignoreT ?? 0) > this.t ? car.ignore : null;
    const lead = (o: Car, g: number) => { if (!(o === ig && o.e !== car.e) && g < gap) { gap = g; lv = o.v; why = o.e === car.e ? 'leader' : 'next-edge-car'; by = o; } };
    for (const o of e.lists[car.lane]) if (o !== car && o.s > car.s) lead(o, o.s - o.len - car.s);
    for (let l = 0; l < e.lanes; l++) {
      if (l === car.lane) continue;
      for (const o of e.lists[l]) if (o.s > car.s && (o.lcTo === car.lane || car.lcTo === l)) lead(o, o.s - o.len - car.s);
    }
    const turn = this.nextTurn(car, e), nextRoad = car.next >= 0 ? this.roads[car.next] : null;
    const nextLane = nextRoad ? landingLane(turn, car.lane, nextRoad.lanes) : 0;
    if (nextRoad) for (let l = 0; l < nextRoad.lanes; l++) for (const o of nextRoad.lists[l]) {
      if ((l === nextLane || o.lcTo === nextLane) && o.s < 30) lead(o, e.L - car.s + o.s - o.len);
    }
    const sg = e.sig;
    if (sg && car.s < sg.s + 0.3) {
      const st = signal(this.ctrls[sg.ctrl], this.t, sg.axis), d = sg.s - car.s;
      if (st === 'R' || (st === 'Y' && d > (car.v * car.v) / (2 * IDM.b) + 1)) stop(d, 'signal', null);
    }
    const nearJunction = nextRoad && car.boxNode !== e.b && e.L - car.s < BOX_IN + 15;
    if (nearJunction && !assertive) { // only into the junction with room to clear it on the exit road
      let room = Infinity, rb: Car | null = null;
      for (const o of nextRoad.lists[nextLane]) if (o.v < 2 && o.s - o.len < room) { room = o.s - o.len; rb = o; }
      if (room < car.len + 2 && nextRoad.L > car.len + 4 && rb !== ig) stop(e.L - BOX_IN - car.s, 'no-room-exit', rb);
    }
    const b = car.block;
    if (b && b.o !== ig) { // physical blocker; circular waits are broken after 6 s when the blocker is stuck too
      const align = b.o.geo.fx * car.geo.fx + b.o.geo.fy * car.geo.fy, sameDir = align > 0.7;
      if ((sameDir || !assertive) && !(car.wait > 6 && b.o.wait > 3 && !sameDir)) stop(b.gap, 'spatial', b.o, b.o.v * Math.max(0, align));
    }
    const xs = this.roadX.get(e.i);
    const onCrossing = xs?.some((x) => car.s > x.sR - 2.5 && car.s - car.len < x.sR + 2.5);
    for (const x of xs ?? []) {
      const d = x.sR - car.s;
      if (d < 2.5 || d > 40) continue;
      const busy = this.trams.find((tr) => tr.p === x.path && tr.s - TRAM_LEN < x.sT + 3 && (tr.s > x.sT - 2 || (tr.v > 1 && tr.s > x.sT - tr.v * 4)));
      if (busy && busy !== ig) stop(d - 3.5, 'tram-crossing', busy);
      if (d > 0.5) { // not across the tracks without room for the whole car beyond them
        let room = Infinity, rb: Car | null = null;
        for (const o of e.lists[car.lane]) if (o !== car && o.s > x.sR && o.v < 2 && o.s - o.len - (x.sR + 2.5) < room) { room = o.s - o.len - (x.sR + 2.5); rb = o; }
        if (room < car.len + 1 && rb !== ig) stop(d - 3.5, 'keep-crossing-clear', rb);
      }
    }
    if (!onCrossing && this.tramGrid.size) { // any tram body in the next 25 m of my path
      const P = this.carPoint(car, car.s, pt()), F = this.carPoint(car, car.s + 1, pt());
      const fx = F.x - P.x, fy = F.y - P.y, gx = (P.x / 32) | 0, gy = (P.y / 32) | 0;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const [x, y, tro] of this.tramGrid.get((gx + i) * 100003 + (gy + j)) ?? []) {
        const rx = x - P.x, ry = y - P.y;
        if (Math.abs(rx) > 30 || Math.abs(ry) > 30) continue;
        const along = rx * fx + ry * fy, lat = Math.abs(rx * fy - ry * fx);
        if (tro !== ig && along > 0 && along < 25 && lat < 2.4) stop(along - 2, 'tram', tro);
      }
    }
    if (nearJunction && !assertive) {
      const blocker = this.boxBlocker(car, e, e.b);
      if (blocker && car.wait <= 10 && !(ig && blocker === ig)) stop(e.L - BOX_IN - car.s, 'box-busy', blocker);
    }
    car.why = assertive && why === 'free' ? 'assertive' : why;
    car.by = by;
    return [gap, lv];
  }

  // Every waiting agent waits for one other (by), so cycles are cheap to find; in each, the one with the softest
  // reason ignores its blocker for a few seconds.
  private breakDeadlocks() {
    const rank = (a: Agent) => { const i = SOFT.indexOf(a.why); return a.kind === 'tram' ? 20 + TRAM_HARD.indexOf(a.why) : i < 0 ? 99 : i; };
    const state = new Map<Agent, 1 | 2>();
    for (const a0 of [...this.cars, ...this.trams]) {
      if (state.has(a0)) continue;
      const path: Agent[] = [];
      let a: Agent | null = a0;
      while (a && !state.has(a) && a.v < 0.3 && a.by) { state.set(a, 1); path.push(a); a = a.by; }
      if (a && state.get(a) === 1) {
        let best: Agent | null = null;
        for (const m of path.slice(path.indexOf(a))) if (rank(m) < 99 && (!best || rank(m) < rank(best))) best = m;
        if (best) { best.ignore = best.by; best.ignoreT = this.t + 4; }
      }
      for (const p of path) state.set(p, 2);
    }
  }

  // ------------------------------------------------------------------ one tick
  private step(dt: number, density: { cars: number; peds: number; trams: number }) {
    this.t += dt;
    if (((this.t / 0.5) | 0) !== (((this.t - dt) / 0.5) | 0)) this.breakDeadlocks();
    const targetCars = Math.min(MAX_CARS, Math.round(this.laneKm * 9 * density.cars));
    const targetPeds = Math.min(MAX_PEOPLE, Math.round(this.pedKm * 24 * density.peds));
    for (let k = 0; k < 6 && this.cars.length < targetCars; k++) this.spawnCar(this.cars.length > targetCars * 0.5);
    for (let k = 0; k < 40 && this.people.length < targetPeds; k++) this.spawnPed();
    if (this.people.length > targetPeds) { // the person followed or walked stays in the crowd
      this.people = [...this.people.filter((p) => p.ctl || p === this.keep), ...this.people.filter((p) => !p.ctl && p !== this.keep)];
      this.people.length = targetPeds;
    }
    this.snapshot();
    this.stepCars(dt, targetCars);
    this.stepTrams(dt, density.trams);
    this.stepPeople(dt);
  }

  // where everything is at the start of the tick: tram bodies and cars in grids, and who physically blocks whom
  private snapshot() {
    const A = this.active, q = pt();
    for (const tr of this.trams) { at(this.tramPaths[tr.p], tr.s, 0, q); tr.near = !A || (q.x - A.x) ** 2 + (q.y - A.z) ** 2 < (ACTIVE_R + 200) ** 2; }
    this.tramGrid = new Map();
    for (const tr of this.trams) {
      if (!tr.near) continue;
      for (let s0 = 0; s0 <= TRAM_LEN; s0 += 3) { at(this.tramPaths[tr.p], tr.s - s0, 0, q); pushTo(this.tramGrid, cellKey(q.x, q.y, 32), [q.x, q.y, tr]); }
    }
    const G = 8;
    this.carGrid = new Map();
    for (const c of this.cars) {
      const P = this.carPoint(c, c.s, pt()), F = this.carPoint(c, c.s + 1, pt()), C = this.carPoint(c, c.s - c.len / 2, pt());
      const l = Math.hypot(F.x - P.x, F.y - P.y) || 1;
      c.geo = { px: P.x, py: P.y, cx: C.x, cy: C.y, z: P.z, fx: (F.x - P.x) / l, fy: (F.y - P.y) / l };
      c.block = null;
      pushTo(this.carGrid, cellKey(C.x, C.y, G), c);
    }
    for (const c of this.cars) {
      const g0 = c.geo, gx = (g0.px / G) | 0, gy = (g0.py / G) | 0;
      let best = Infinity, who: Car | null = null;
      for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) for (const o of this.carGrid.get((gx + i) * 100003 + (gy + j)) ?? []) {
        if (o === c || Math.abs(o.geo.z - g0.z) > 2) continue;
        const rx = o.geo.cx - g0.px, ry = o.geo.cy - g0.py;
        const along = rx * g0.fx + ry * g0.fy, lat = Math.abs(rx * g0.fy - ry * g0.fx);
        const cosd = Math.abs(o.geo.fx * g0.fx + o.geo.fy * g0.fy), sind = Math.sqrt(Math.max(0, 1 - cosd * cosd));
        const he = (o.len / 2) * cosd + 0.9 * sind, hl = (o.len / 2) * sind + 0.9 * cosd;
        if (lat < 0.95 + hl && along + he > 0.3 && along - he < 12 && along - he - 0.6 < best) { best = along - he - 0.6; who = o; }
      }
      if (who) c.block = { o: who, gap: best };
    }
    for (const c of this.cars) { // both block each other: whoever entered the junction first (else the lower id) goes
      const b = c.block;
      if (b && b.o.block?.o === c) {
        const pc = c.boxNode >= 0 ? c.boxT : Infinity, po = b.o.boxNode >= 0 ? b.o.boxT : Infinity;
        if (pc < po || (pc === po && c.id < b.o.id)) c.block = null;
      }
    }
  }

  private stepCars(dt: number, targetCars: number) {
    const removed = new Set<Car>();
    for (const car of this.cars) {
      const e = this.roads[car.e], s0 = car.s, off0 = car.off, e0 = car.e;
      this.changeLane(car, e, dt);
      let v0 = e.v * car.v0f;
      if (car.next >= 0 && e.L - car.s < 30 && this.nextTurn(car, e) !== Turn.Straight) v0 = Math.min(v0, this.nextTurn(car, e) === Turn.Right ? 4.5 : 6);
      const [gap, lv] = this.carObstacle(car, e);
      const ss = IDM.s0 + Math.max(0, car.v * IDM.T + (car.v * (car.v - lv)) / (2 * Math.sqrt(IDM.a * IDM.b)));
      const acc = Math.max(-9, IDM.a * (1 - (car.v / Math.max(v0, 0.1)) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2)));
      car.brake = acc < -0.8 || car.v < 0.3 ? 1 : 0;
      car.v = Math.max(0, car.v + acc * dt);
      car.wait = car.v < 0.3 ? car.wait + dt : 0;
      // stuck too long for a soft reason: push through for a few metres
      if (car.ghost <= 0 && ((car.wait > 15 && SOFT.slice(0, 4).includes(car.why)) || (car.wait > 25 && SOFT.slice(4).includes(car.why)))) { car.ghost = 8; car.wait = 0; }
      if (car.ghost > 0) { car.ghost -= car.v * dt; if (car.v < 1.5 && gap > 3) car.v = 1.5; }
      car.s += car.v * dt;
      if (car.next >= 0 && car.boxNode !== e.b && e.L - car.s < BOX_IN) { this.boxLeave(car); this.boxEnter(car, e, e.b); }
      if (car.s > e.L && !this.enterNext(car, e, s0, targetCars)) { removed.add(car); continue; }
      if (car.boxNode >= 0 && car.e !== car.boxFrom && car.s > BOX_OUT) this.boxLeave(car);
      car.ds = car.e === e0 ? car.s - s0 : car.s + e.L - s0;
      car.dOff = car.e === e0 ? car.off - off0 : 0;
    }
    if (removed.size) this.cars.splice(0, this.cars.length, ...this.cars.filter((c) => !removed.has(c)));
  }

  private changeLane(car: Car, e: Road, dt: number) {
    const want = this.desiredLane(car, e);
    if (want !== car.lane && car.lcTo === undefined && car.s > 4 && e.L - car.s > 15) {
      const step = want > car.lane ? 1 : -1;
      if (this.laneGapOK(e, car.lane + step, car.s, car)) car.lcTo = car.lane + step;
    }
    if (car.lcTo === undefined) { car.off += (this.laneOffset(e, car.lane) - car.off) * Math.min(1, dt * 3); return; }
    const tgt = this.laneOffset(e, car.lcTo);
    car.off += Math.sign(tgt - car.off) * Math.min(Math.abs(tgt - car.off), 1.4 * dt * Math.max(0.4, Math.min(1, car.v / 5)));
    if (Math.abs(tgt - car.off) < 0.05) {
      const lst = e.lists[car.lane];
      lst.splice(lst.indexOf(car), 1);
      car.lane = car.lcTo; car.lcTo = undefined;
      e.lists[car.lane].push(car);
    }
  }

  // past the end of its road: onto the next one (false: it leaves), or hold at the line if the lane there is full
  private enterNext(car: Car, e: Road, s0: number, targetCars: number) {
    const lst = e.lists[car.lane];
    lst.splice(lst.indexOf(car), 1);
    car.lcTo = undefined;
    if (car.next < 0 || this.cars.length > targetCars + 4) { this.boxLeave(car); return false; }
    const n = this.roads[car.next], lane = landingLane(turnOf(e, n), car.lane, n.lanes);
    const hold = n.lists[lane].find((o) => o.s < car.len + 1.5);
    if (hold && !(car.ignore === hold && (car.ignoreT ?? 0) > this.t)) {
      lst.push(car);
      Object.assign(car, { s: e.L - 0.01, v: 0, why: 'hold-at-line', by: hold });
      car.ds = car.s - s0;
      return true;
    }
    Object.assign(car, { prev: car.e, prevOff: car.off, s: car.s - e.L, e: car.next, lane, off: this.laneOffset(n, lane) });
    n.lists[lane].push(car);
    car.next = this.chooseNext(n);
    if (n.L < 25 && car.next >= 0) { // too short to change lanes later: take the next turn's lane now if it is free
      const wl = this.desiredLane(car, n);
      if (wl !== car.lane && this.laneGapOK(n, wl, car.s, car)) {
        n.lists[car.lane].splice(n.lists[car.lane].indexOf(car), 1);
        car.lane = wl; car.off = this.laneOffset(n, wl);
        n.lists[wl].push(car);
      }
    }
    return true;
  }

  private stepTrams(dt: number, density: number) {
    for (const p of this.tramPaths) {
      p.nextSpawn -= dt * density;
      if (p.nextSpawn > 0) continue;
      if (this.tramClear(p, TRAM_LEN + 1)) { this.trams.push(this.newTram(p, TRAM_LEN + 1)); p.nextSpawn = TRAM.headway * (0.7 + 0.6 * Math.random()); }
      else p.nextSpawn = 5;
    }
    const q = pt(), q2 = pt(), bodies: [number, number, number][] = [];
    this.trams.forEach((tr, ti) => {
      if (tr.near) for (let k = 0; k <= TRAM.n; k++) { at(this.tramPaths[tr.p], tr.s - k * (TRAM.sec + TRAM.gap), 0, q); bodies.push([ti, q.x, q.y]); }
    });
    this.trams.forEach((tr, ti) => {
      if (!tr.near) { // far away: just runs along its track
        tr.v += (TRAM.v * 0.8 - tr.v) * Math.min(1, dt * 0.5);
        tr.ds = tr.v * dt; tr.s += tr.ds; tr.why = 'free';
        return;
      }
      const p = this.tramPaths[tr.p];
      at(p, tr.s, 0, q); at(p, tr.s + 1, 0, q2);
      const fdx = q2.x - q.x, fdy = q2.y - q.y;
      let gap = Infinity;
      tr.why = 'free'; tr.by = null;
      const ignored = (o: Agent) => tr.ignore === o && (tr.ignoreT ?? 0) > this.t;
      const stop = (g: number, why: string, by: Agent | null) => { if (g < gap) { gap = g; tr.why = why; tr.by = by; } };
      for (const [oj, x, y] of bodies) { // any tram ahead on the track, also converging from a branch
        if (oj === ti) continue;
        const rx = x - q.x, ry = y - q.y, along = rx * fdx + ry * fdy, lat = Math.abs(rx * fdy - ry * fdx);
        if (along > -0.5 && along < 70 && lat < 2.2 + Math.min(along, 40) * 0.12) {
          if (lat > 2.2 && oj < ti && this.trams[oj].yieldTo === ti) continue;
          if (lat > 2.2) tr.yieldTo = oj;
          if (!ignored(this.trams[oj])) stop(along - 1.5, 'tram', this.trams[oj]);
        }
      }
      const gx = (q.x / 8) | 0, gy = (q.y / 8) | 0;
      for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) for (const c of this.carGrid.get((gx + i) * 100003 + (gy + j)) ?? []) {
        const rx = c.geo.cx - q.x, ry = c.geo.cy - q.y, along = rx * fdx + ry * fdy, lat = Math.abs(rx * fdy - ry * fdx);
        if (along > -1 && along < 30 && lat < 2.4 && !ignored(c)) stop(along - 2.5, 'car-on-track', c);
      }
      for (const x of p.xs) {
        const d = x.sT - tr.s;
        if (x.kind === 'road') {
          if (d < 0 || d > 25) continue;
          let occ: Car | null = null;
          for (const l of this.roads[x.e].lists) for (const c of l) if (c.s > x.sR - 1.5 && c.s - c.len < x.sR + 1.5) occ = c;
          if (occ && !ignored(occ)) stop(d - 4, 'road-occupied', occ);
        } else {
          const D = this.diamonds[x.id];
          if (D.holder === tr && tr.s - TRAM_LEN > x.sT + 2) { D.holder = null; continue; }
          if (d < 0 || d > 30) continue;
          if (!D.holder || !this.trams.includes(D.holder)) D.holder = tr;
          else if (D.holder !== tr) stop(d - 6, 'diamond', D.holder);
        }
      }
      for (const st of p.stops) {
        if (tr.s > st.s + 0.3 || st.s - tr.s > 80) continue;
        const sgl = signal(this.ctrls[st.ctrl], this.t, st.axis), d = st.s - tr.s;
        if (sgl === 'R' || (sgl === 'Y' && d > (tr.v * tr.v) / (2 * TRAM.b) + 1)) stop(d, 'signal', null);
      }
      if (gap === Infinity) tr.yieldTo = -1;
      const ss = 3 + Math.max(0, tr.v * 1.5);
      const acc = Math.max(-5, TRAM.a * (1 - (tr.v / TRAM.v) ** 4 - (gap === Infinity ? 0 : (ss / Math.max(gap, 0.1)) ** 2)));
      tr.v = Math.max(0, tr.v + acc * dt);
      tr.ds = tr.v * dt;
      tr.s += tr.ds;
    });
    const gone = this.trams.filter((tr) => tr.s - TRAM_LEN >= this.tramPaths[tr.p].L);
    for (const tr of gone) this.trams.splice(this.trams.indexOf(tr), 1);
  }

  private stepPeople(dt: number) {
    for (const pe of this.people) {
      if (pe.ctl) continue;
      const e = this.peds[pe.e];
      if (pe.wait) {
        if (!e.x || !pedGreen(this.ctrls[e.x.ctrl], this.t, e.x.axis)) continue;
        pe.wait = false;
      }
      pe.s += pe.v * dt * pe.dir;
      pe.ph += pe.v * dt * 4.2;
      if (pe.s >= 0 && pe.s <= e.L) continue;
      const opts = (this.padj.get(pe.s < 0 ? e.a : e.b) ?? []).filter(([j]) => j !== pe.e && this.pedOn[j]);
      if (!opts.length) { pe.dir *= -1; pe.s = Math.min(Math.max(pe.s, 0), e.L); continue; }
      const [j, end] = opts[pickWeighted(opts.map(([k]) => this.peds[k].w))];
      const n = this.peds[j];
      pe.e = j;
      pe.dir = end === 0 ? 1 : -1;
      pe.s = end === 0 ? 0 : n.L;
      if (n.x && !pedGreen(this.ctrls[n.x.ctrl], this.t, n.x.axis)) pe.wait = true;
    }
  }

  // ------------------------------------------------------------------ drawing
  // a car's path at arc length s, blended across the junction node into a smooth arc
  private carPoint(car: Car, s: number, out: Pt, off = car.off) {
    const e = this.roads[car.e], P = at(e, s, off, out);
    if (s < BLEND && car.prev >= 0) {
      const pe = this.roads[car.prev], Q = at(pe, pe.L + s, car.prevOff, this.tmp), w = smooth(-BLEND, BLEND, s);
      P.x = Q.x + (P.x - Q.x) * w; P.y = Q.y + (P.y - Q.y) * w; P.z = Q.z + (P.z - Q.z) * w;
    } else if (s > e.L - BLEND && car.next >= 0) {
      const n = this.roads[car.next], lane = landingLane(turnOf(e, n), car.lane, n.lanes);
      const Q = at(n, s - e.L, this.laneOffset(n, lane), this.tmp), w = smooth(-BLEND, BLEND, s - e.L);
      P.x += (Q.x - P.x) * w; P.y += (Q.y - P.y) * w; P.z += (Q.z - P.z) * w;
    }
    return P;
  }

  // positions between the last two ticks (lead: time since the last one), so motion is smooth at any frame rate
  private render(dt: number, night: number, lead: number) {
    const back = 1 - lead / STEP;
    this.drawCars(back, night);
    this.drawTrams(back, night);
    const n = this.drawPeople(dt, lead);
    const nd = drawDancers(this.M, n, MAX_PEOPLE, this.t, this.hour, this.world?.groundAt(DANCE.x, DANCE.y) ?? 0);
    setCount(n + nd, this.M.legs, this.M.torso);
    this.drawSignals();
  }

  private drawCars(back: number, night: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), tailOff = new THREE.Color(0.55, 0.06, 0.05), tailOn = new THREE.Color(2.2, 0.15, 0.1), tail = new THREE.Color();
    this.cars.forEach((c, i) => {
      // both axles on the blended path: the body follows the curve
      const s = c.s - c.ds * back, off = c.off - c.dOff * back;
      this.carPoint(c, s, A, off);
      this.carPoint(c, s - (c.len - 1.2), B, off);
      c.rh = Math.atan2(A.x - B.x, A.y - B.y);
      c.rp = (c.rp ?? new THREE.Vector3()).set((A.x + B.x) / 2, Math.max(A.z, B.z), (A.y + B.y) / 2);
      m.compose(c.rp, q.setFromAxisAngle(up, c.rh), sc.set(1, c.bus ? 1.75 : 1, c.bus ? c.len / 4.4 : 1));
      for (const mesh of [M.body, M.dark, M.head, M.tail]) mesh.setMatrixAt(i, m);
      M.body.setColorAt(i, c.col);
      M.tail.setColorAt(i, tail.copy(c.brake ? tailOn : tailOff).multiplyScalar(c.brake ? 1 : 0.4 + 1.2 * night));
    });
    setCount(this.cars.length, M.body, M.dark, M.head, M.tail);
    M.headMat.color.setRGB(0.85 + 2.2 * night, 0.82 + 2.0 * night, 0.72 + 1.6 * night);
  }

  // both ends of each section on the track, so the articulation follows curves
  private drawTrams(back: number, night: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3();
    let n = 0;
    this.tramSections = [];
    for (const tr of this.trams) {
      const p = this.tramPaths[tr.p];
      for (let k = 0; k < TRAM.n; k++) {
        const s0 = tr.s - tr.ds * back - k * (TRAM.sec + TRAM.gap);
        at(p, s0, 0, A); at(p, s0 - TRAM.sec, 0, B);
        const h = Math.atan2(A.x - B.x, A.y - B.y);
        pos.set((A.x + B.x) / 2, Math.max(A.z, B.z) + 0.05, (A.y + B.y) / 2);
        this.tramSections.push([tr, pos.x, pos.z, h, pos.y]);
        if (k === 0) { tr.rp = (tr.rp ?? new THREE.Vector3()).copy(pos); tr.rh = h; }
        if (n < MAX_TRAM_SECTIONS) { m.compose(pos, q.setFromAxisAngle(up, h), one); M.tram.setMatrixAt(n, m); M.tramWin.setMatrixAt(n, m); n++; }
      }
    }
    setCount(n, M.tram, M.tramWin);
    M.tramWinMat.emissiveIntensity = night * 1.6;
  }

  private drawPeople(dt: number, lead: number) {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const A = pt(), B = pt(), pos = new THREE.Vector3(), k = 1 - Math.exp(-dt * 10);
    this.people.forEach((p, i) => {
      let bob = 0;
      if (p.ctl) { // walked by the player (nav): where they put them
        const C = p.ctl;
        p.rp = (p.rp ?? new THREE.Vector3()).set(C.x, C.y, C.z); p.rh = C.h;
        if (C.moving) { p.ph += dt * 9; bob = Math.sin(p.ph); }
      } else {
        const e = this.peds[p.e], ds = p.wait ? 0 : p.v * lead;
        at(e, p.s + ds * p.dir, 0, A);
        at(e, p.s + (ds + 0.5) * p.dir, 0, B);
        const l = Math.hypot(B.x - A.x, B.y - A.y) || 1, dx = (B.x - A.x) / l, dy = (B.y - A.y) / l;
        const lat = e.side === undefined ? p.lat : p.lat * e.side * p.dir;
        const x = A.x - dy * lat, y = A.y + dx * lat, h = Math.atan2(dx, dy);
        if (!p.rp || Math.hypot(p.rp.x - x, p.rp.z - y) > 6) { p.rp = new THREE.Vector3(x, A.z, y); p.rh = h; }
        p.rp.lerp(pos.set(x, A.z, y), k);
        p.rh = (p.rh ?? h) + Math.atan2(Math.sin(h - (p.rh ?? h)), Math.cos(h - (p.rh ?? h))) * k;
        if (!p.wait) bob = Math.sin(p.ph + ds * 4.2);
      }
      pos.copy(p.rp);
      pos.y += 0.05 * Math.abs(bob);
      m.compose(pos, q.setFromAxisAngle(up, p.rh!), one);
      M.legs.setMatrixAt(i, m); M.torso.setMatrixAt(i, m);
      M.torso.setColorAt(i, p.col);
    });
    return this.people.length;
  }

  private drawSignals() {
    const M = this.M, m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const pos = new THREE.Vector3(), col = new THREE.Color();
    const LAMP = { R: [2.2, 0.12, 0.08, 3.95], Y: [2.2, 1.3, 0.1, 3.6], G: [0.1, 2.0, 0.6, 3.25] };
    this.heads.forEach(([x, row, gz, rot, ctrl, axis], i) => {
      const [r, g, b, hy] = LAMP[signal(this.ctrls[ctrl], this.t, axis)], a = rot + Math.PI;
      m.compose(pos.set(x + Math.sin(a) * 0.19, gz + hy, row + Math.cos(a) * 0.19), q.setFromAxisAngle(up, a), one);
      M.lamp.setMatrixAt(i, m);
      M.lamp.setColorAt(i, col.setRGB(r, g, b));
    });
    setCount(this.heads.length, M.lamp);
  }

  // ------------------------------------------------------------------ following
  private tramLabel(tr: Tram) { const ref = this.tramPaths[tr.p].ref; return ref ? `tram ${ref}` : 'tram'; }
  private listOf(kind: Kind): Rideable[] { return kind === 'car' ? this.cars : kind === 'tram' ? this.trams : this.people; }

  // the agent nearest to screen point (cx, cy) within px, at least minPx tall on screen, and visible
  pick(camera: THREE.PerspectiveCamera, cx: number, cy: number, px: number, minPx: number, visible: (to: THREE.Vector3) => boolean, skip: Rideable | null): Picked | null {
    const v = new THREE.Vector3(), cand: (Picked & { score: number; at: THREE.Vector3 })[] = [];
    const f = (innerHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
    const scr = (x: number, y: number, z: number) => { v.set(x, y, z).project(camera); return v.z > 1 || v.z < -1 ? null : [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; };
    const test = (kind: Kind, obj: Rideable, x: number, y: number, z: number, size: number, label: string, h = 0, len = 0) => {
      if (obj === skip) return;
      const c = scr(x, y, z);
      if (!c) return;
      const dist = camera.position.distanceTo(v.set(x, y, z)), onScreen = size * f / dist;
      if (onScreen < minPx) return;
      let d = Math.hypot(c[0] - cx, c[1] - cy);
      if (len) { // the distance to its body, back to front, plus half a second behind: you tap where you saw it
        const back = len / 2 + ('v' in obj ? obj.v : 0) * 0.5, hx = Math.sin(h), hz = Math.cos(h);
        const a = scr(x - hx * back, y, z - hz * back), b = scr(x + hx * len / 2, y, z + hz * len / 2);
        if (a && b) {
          const ex = b[0] - a[0], ey = b[1] - a[1], t = Math.max(0, Math.min(1, ((cx - a[0]) * ex + (cy - a[1]) * ey) / (ex * ex + ey * ey || 1)));
          d = Math.hypot(a[0] + ex * t - cx, a[1] + ey * t - cy);
        }
      }
      const r = Math.max(px, onScreen * 0.55);
      if (d < r) cand.push({ kind, obj, label, score: d / r + dist / 3000, at: new THREE.Vector3(x, y + size * 0.3, z) });
    };
    for (const c of this.cars) if (c.rp) test('car', c, c.rp.x, c.rp.y + 0.8, c.rp.z, c.bus ? 6 : 3.5, c.bus ? 'bus' : 'car', c.rh, c.len);
    for (const p of this.people) if (p.rp) test('person', p, p.rp.x, p.rp.y + 0.9, p.rp.z, 1.6, 'person');
    for (const [tr, x, z, h, y] of this.tramSections) test('tram', tr, x, y + 1.6, z, 9, this.tramLabel(tr), h, TRAM.sec);
    cand.sort((a, b) => a.score - b.score);
    return cand.slice(0, 6).find((c) => visible(c.at.clone().sub(camera.position))) ?? null;
  }

  // where an agent is now, or null once it has left
  pose(kind: Kind, obj: Rideable): Pose | null {
    if (!obj.rp || !this.listOf(kind).includes(obj)) return null;
    return { x: obj.rp.x, y: obj.rp.y, z: obj.rp.z, h: obj.rh ?? 0 };
  }

  // the nearest one of a kind, preferring one that moves
  nearest(kind: Kind, from: { x: number; z: number }, skip: Rideable | null): Picked | null {
    let best: Rideable | null = null, bd = Infinity;
    for (const o of this.listOf(kind)) {
      if (o === skip || !o.rp) continue;
      const d = Math.hypot(o.rp.x - from.x, o.rp.z - from.z), dd = d + (kind === 'person' || o.v > 1.5 ? 0 : 400);
      if (dd < bd && d > (kind === 'person' ? 3 : 8)) { bd = dd; best = o; }
    }
    if (!best) return null;
    const label = best.kind === 'tram' ? this.tramLabel(best) : best.kind === 'car' ? (best.bus ? 'bus' : 'car') : 'person';
    return { kind, obj: best, label };
  }
}
