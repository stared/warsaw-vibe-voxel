import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { hash } from '../util';
import { at, prepPath, pt, type Path, type PathData } from './path';

// Trains on the open-air railway (scripts/traffic.py: the OSM route=train relations, one path per track, each route
// with the stations it stops at): every route sends a train every half hour, from the map edge or a tunnel portal;
// it brakes for its stations, waits, and keeps its distance behind the train ahead on the same track.

export interface TrainService { ref: string; op: string; stops: number[] }
export interface TrainPathData extends PathData { svc: TrainService[] }
interface TrainPath extends TrainPathData, Path { next: number[] }
interface Train { p: number; svc: TrainService; s: number; ds: number; v: number; n: number; wait: number; done: Set<number>; liv: number }

const CAR = 20, GAP = 1, V = 16, A = 0.7, B = 0.9, DWELL = 25, HEADWAY = 1800, SPACING = 70;
const MAX_CARS = 240;
// liveries: [body, lower band, stripe]; cars per train
const LIVERY: [RegExp, number, number, number, number][] = [
  [/Szybka Kolej Miejska|SKM/i, 0xf2c230, 0xc8322b, 0xc8322b, 4],
  [/Mazowieckie|\bKM\b/i, 0xeef0ec, 0x23824a, 0xf2c230, 5],
  [/Polregio/i, 0xeceae6, 0xb8202e, 0x8c1c26, 3],
  [/Intercity|PKPIC|PKP|DB|ČD|ÖBB|EC|IC/i, 0xdfe2e4, 0x1d3d6e, 0xd8892b, 8],
];
const OTHER: [number, number, number, number] = [0xe6e8ea, 0x3a4f63, 0x3a4f63, 4];
const livery = (op: string, ref: string) => { const l = LIVERY.find(([re]) => re.test(op) || re.test(ref)); return l ? LIVERY.indexOf(l) : LIVERY.length; };
const look = (k: number) => (k < LIVERY.length ? LIVERY[k].slice(1) : OTHER) as [number, number, number, number];

function box(w: number, h: number, l: number, y: number) { return new THREE.BoxGeometry(w, h, l).translate(0, y + h / 2, 0); }

export class Trains {
  readonly group = new THREE.Group();
  readonly list: Train[] = [];
  private readonly paths: TrainPath[];
  private readonly body: THREE.InstancedMesh;
  private readonly band: THREE.InstancedMesh;
  private readonly stripe: THREE.InstancedMesh;
  private readonly win: THREE.InstancedMesh;
  private readonly winMat = new THREE.MeshStandardMaterial({ color: 0x26323d, roughness: 0.15, metalness: 0.4, emissive: new THREE.Color(1.0, 0.85, 0.6), emissiveIntensity: 0 });
  private t = 0;

  constructor(data: TrainPathData[]) {
    this.paths = data.map((d, i) => Object.assign(prepPath(d), { next: d.svc.map((_, k) => hash(i * 31 + k + 5) * HEADWAY) }));
    const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.15, ...o });
    const inst = (g: THREE.BufferGeometry, m: THREE.Material, colour: boolean) => {
      const mesh = new THREE.InstancedMesh(g, m, MAX_CARS);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (colour) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CARS * 3), 3);
      mesh.count = 0;
      this.group.add(mesh);
      return mesh;
    };
    const L = CAR;
    this.body = inst(mergeGeometries([box(2.9, 2.75, L, 1.3), box(2.5, 0.3, L - 1.5, 4.05)]), std({ color: 0xffffff }), true);
    this.band = inst(box(2.92, 1.0, L, 0.3), std({ color: 0xffffff }), true);
    this.stripe = inst(box(2.94, 0.25, L - 0.6, 3.2), std({ color: 0xffffff }), true);
    this.win = inst(box(2.96, 0.95, L - 2.4, 2.05), this.winMat, false);
    this.win.castShadow = false;
    for (const p of this.paths)
      for (let s = 200 + hash(p.cum.length + 11) * 900; s < p.L - 50; s += 900 + hash(s) * 900) this.spawn(p, hash(s + 3) * p.svc.length | 0, s);
  }

  private spawn(p: TrainPath, k: number, s: number) {
    const svc = p.svc[k], liv = livery(svc.op, svc.ref), n = look(liv)[3];
    const done = new Set(svc.stops.filter((x) => x < s));
    this.list.push({ p: this.paths.indexOf(p), svc, s, ds: 0, v: V * 0.8, n, wait: 0, done, liv });
  }

  private len(tr: Train) { return tr.n * (CAR + GAP) - GAP; }

  update(dt: number, hour: number) {
    const run = !(hour > 0.25 && hour < 4.5);
    this.t += dt;
    if (run)
      for (const p of this.paths)
        p.next.forEach((tNext, k) => {
          if (this.t < tNext) return;
          const last = this.list.filter((tr) => this.paths[tr.p] === p).reduce((m, tr) => Math.min(m, tr.s - this.len(tr)), Infinity);
          if (last < SPACING + 40) { p.next[k] = this.t + 20; return; } // the track is occupied: try again in a while
          this.spawn(p, k, 0);
          p.next[k] = this.t + HEADWAY * (0.85 + 0.3 * hash(this.t + k));
        });
    for (const tr of this.list) {
      const p = this.paths[tr.p], L = this.len(tr);
      if (tr.wait > 0) { tr.wait -= dt; tr.ds = 0; continue; }
      // the nearest place to stop: its next station (the train centred on it, front past the stop node), or the
      // tail of the train ahead on this track less a gap
      let stop = Infinity, station = -1;
      for (const x of tr.svc.stops) if (!tr.done.has(x)) { const f = Math.min(x + L / 2, p.L); if (f >= tr.s - 1 && f < stop) { stop = f; station = x; } }
      for (const o of this.list) if (o !== tr && o.p === tr.p && o.s > tr.s) stop = Math.min(stop, o.s - this.len(o) - SPACING);
      const d = stop - tr.s;
      const vSafe = d === Infinity ? V : Math.sqrt(Math.max(0, 2 * B * Math.max(0, d)));
      const target = Math.min(V, vSafe);
      tr.v = tr.v < target ? Math.min(target, tr.v + A * dt) : Math.max(target, tr.v - B * 1.6 * dt);
      tr.ds = tr.v * dt;
      tr.s += tr.ds;
      if (station >= 0 && d < 1.5 && tr.v < 0.6 && stop !== Infinity && tr.s >= Math.min(station + L / 2, p.L) - 2) {
        tr.done.add(station); tr.wait = DWELL; tr.v = 0;
      }
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const tr = this.list[i];
      if (tr.s - this.len(tr) > this.paths[tr.p].L + 10) this.list.splice(i, 1);
    }
  }

  render(back: number, night: number) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
    const a = pt(), b = pt(), pos = new THREE.Vector3(), c = new THREE.Color();
    let n = 0;
    for (const tr of this.list) {
      const p = this.paths[tr.p], [body, band, stripe] = look(tr.liv);
      for (let k = 0; k < tr.n && n < MAX_CARS; k++) {
        const s0 = tr.s - tr.ds * back - k * (CAR + GAP);
        at(p, s0, 0, a); at(p, s0 - CAR, 0, b);
        pos.set((a.x + b.x) / 2, Math.max(a.z, b.z) + 0.05, (a.y + b.y) / 2);
        m.compose(pos, q.setFromAxisAngle(up, Math.atan2(a.x - b.x, a.y - b.y)), one);
        for (const mesh of [this.body, this.band, this.stripe, this.win]) mesh.setMatrixAt(n, m);
        this.body.setColorAt(n, c.setHex(body));
        this.band.setColorAt(n, c.setHex(band));
        this.stripe.setColorAt(n, c.setHex(stripe));
        n++;
      }
    }
    for (const mesh of [this.body, this.band, this.stripe, this.win]) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.winMat.emissiveIntensity = night * 1.6;
  }
}
