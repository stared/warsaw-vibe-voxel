import * as THREE from 'three';
import type { ColumnData, Meta, TileLevel } from './types';
import type { MeshRequest, MeshReply, RawColumns } from './mesher.worker';
import { World, type ColumnSource } from './world';

export interface TileNode {
  key: string;
  s: number;
  tx: number;
  ty: number;
  foliage: boolean;
  state: 'queued' | 'loading' | 'ready';
  keep: boolean;
  used: number;
  pinned: number;
  mesh?: THREE.Mesh;
  data?: ColumnData;
  empty?: boolean;
  dataJob?: Job;
  ready: Promise<void>;
  job: Job;
}

interface Job {
  node: TileNode;
  dataOnly: boolean;
  state: 'queued' | 'loading';
  prio: number;
  done: Promise<void>;
  resolve: () => void;
}

interface Pooled { worker: Worker; busy: number; idle: number }

const releaseArray = function (this: THREE.BufferAttribute) { (this as { array: unknown }).array = null; };

function makeJob(node: TileNode, dataOnly: boolean, prio: number): Job {
  let resolve = () => {};
  const done = new Promise<void>((r) => { resolve = r; });
  return { node, dataOnly, state: 'queued', prio, done, resolve };
}

// Loads voxel tiles (scripts/tiles.py: N x N cells of s metres) and meshes them in a pool of workers. What to load and
// show is up to the engine on top (city.ts, or zones.ts on phones), which sets update().
export class TileStreamer implements ColumnSource {
  readonly N: number;
  readonly levels: number[];
  readonly dims: Record<number, TileLevel>;
  readonly nodes = new Map<string, TileNode>();
  readonly group = new THREE.Group();
  readonly world: World;
  version = 0;
  bldMap: { data: Uint16Array; W: number } | null = null;
  update: (camera: THREE.Camera) => void = () => {};
  private queue: Job[] = [];
  private inflight = 0;
  private readonly maxWorkers = Math.min(Math.max(2, (navigator.hardwareConcurrency || 4) - 2), 10);
  private readonly pool: Pooled[] = [];
  private quadIdx: THREE.BufferAttribute | null = null;

  constructor(private readonly meta: Meta, private readonly material: THREE.Material, scene: THREE.Scene) {
    this.N = meta.tiles.N;
    this.levels = meta.tiles.levels.map((l) => l.s).sort((a, b) => b - a);
    this.dims = Object.fromEntries(meta.tiles.levels.map((l) => [l.s, l]));
    scene.add(this.group);
    this.spawn();
    this.world = new World(this, meta);
  }

  columns(key: string) { return this.nodes.get(key)?.data; }

  key(s: number, tx: number, ty: number) { return `${s}/${tx}_${ty}`; }

  bounds(s: number, tx: number, ty: number) {
    const L = this.N * s;
    return [tx * L, ty * L, Math.min((tx + 1) * L, this.meta.W), Math.min((ty + 1) * L, this.meta.D)];
  }

  // keep: its column data stays here too, for collisions and ray casts
  request(s: number, tx: number, ty: number, prio: number, keep = false): Promise<void> {
    const key = this.key(s, tx, ty);
    let n = this.nodes.get(key);
    if (n && keep && n.state === 'ready' && !n.data && !n.empty) {
      n.keep = true;
      if (!n.dataJob) { n.dataJob = makeJob(n, true, prio); this.queue.push(n.dataJob); }
      n.dataJob.prio = prio;
      return n.dataJob.done;
    }
    n ??= this.addNode(key, s, tx, ty, false, keep);
    n.job.prio = prio;
    if (prio >= 1e8) n.pinned = performance.now() + 15000;
    return n.ready;
  }

  // trees and grass of a 1 m tile (tiles/1f), meshed over its base tile
  requestFoliage(tx: number, ty: number, prio: number): Promise<void> {
    const key = `f/${tx}_${ty}`;
    const n = this.nodes.get(key) ?? this.addNode(key, 1, tx, ty, true, false);
    n.job.prio = prio;
    return n.ready;
  }

  private addNode(key: string, s: number, tx: number, ty: number, foliage: boolean, keep: boolean) {
    const n = { key, s, tx, ty, foliage, keep, state: 'queued', used: performance.now(), pinned: 0 } as TileNode;
    n.job = makeJob(n, false, 0);
    n.ready = n.job.done;
    this.nodes.set(key, n);
    this.queue.push(n.job);
    return n;
  }

  reprioritize(prio: (n: TileNode) => number) {
    for (const j of this.queue) if (!j.dataOnly) j.prio = prio(j.node);
  }

  dropQueued(keep: (n: TileNode) => boolean) {
    this.queue = this.queue.filter((j) => {
      if (j.state !== 'queued' || keep(j.node)) return true;
      if (j.dataOnly) { j.node.dataJob = undefined; j.resolve(); } else this.nodes.delete(j.node.key);
      return false;
    });
  }

  private spawn() {
    const worker = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
    const p: Pooled = { worker, busy: 0, idle: performance.now() };
    worker.onmessage = (e: MessageEvent<MeshReply>) => this.onReply(e.data, p);
    this.pool.push(p);
  }

  // workers past the first one leave after 4 s idle (each holds ~35 MB)
  retire() {
    const now = performance.now();
    for (const p of [...this.pool]) {
      if (this.pool.length > 1 && p.busy === 0 && now - p.idle > 4000) {
        p.worker.terminate();
        this.pool.splice(this.pool.indexOf(p), 1);
      }
    }
  }

  pump() {
    this.queue.sort((a, b) => b.prio - a.prio);
    while (this.queue.length > this.pool.length * 2 && this.pool.length < this.maxWorkers) this.spawn();
    while (this.queue.length && this.inflight < this.pool.length * 2) {
      const job = this.queue.shift()!;
      if (job.state !== 'queued') continue;
      const p = this.pool.reduce((a, b) => (a.busy <= b.busy ? a : b));
      p.busy++; this.inflight++;
      job.state = 'loading';
      const { msg, transfer } = this.requestFor(job);
      p.worker.postMessage(msg, transfer);
    }
  }

  private requestFor({ node: n, dataOnly }: Job): { msg: MeshRequest; transfer: Transferable[] } {
    const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
    const file = (k: string) => new URL(`data/tiles/${k}.bin`, location.href).href;
    const base = { key: n.key, N: this.N, s: n.s, x0, y0 };
    if (n.foliage) {
      // the base tile's column data is still here: hand over a copy instead of fetching it again
      const b = this.nodes.get(this.key(1, n.tx, n.ty))?.data;
      const under: RawColumns | string = b ? { counts: b.counts.slice(), runs: b.runs.slice() } : file(`1/${n.tx}_${n.ty}`);
      return { msg: { ...base, url: file(`1f/${n.tx}_${n.ty}`), under, keep: false, dataOnly: false, bld: null },
        transfer: typeof under === 'string' ? [] : [under.counts.buffer, under.runs.buffer] };
    }
    const bld = !dataOnly && n.s === 1 ? this.buildingIds(x0, y0) : null;
    return { msg: { ...base, url: file(n.key), keep: n.keep || n.s > 1, dataOnly, bld }, transfer: bld ? [bld.buffer] : [] };
  }

  private buildingIds(x0: number, y0: number) {
    if (!this.bldMap) return null;
    const { data, W } = this.bldMap, N = this.N, out = new Uint16Array(N * N);
    for (let r = 0; r < N && y0 + r < this.meta.D; r++) out.set(data.subarray((y0 + r) * W + x0, (y0 + r) * W + Math.min(x0 + N, W)), r * N);
    return out;
  }

  private onReply(m: MeshReply, p: Pooled) {
    p.busy--; this.inflight--; p.idle = performance.now();
    const n = this.nodes.get(m.key);
    if (n && m.dataOnly) {
      const job = n.dataJob;
      n.dataJob = undefined;
      if (m.type === 'error') console.warn(m.error);
      else if (m.data && !n.data) this.setData(n, m.data);
      job?.resolve();
    } else if (n && m.type === 'error') {
      console.warn(m.error);
      n.state = 'ready'; n.empty = true;
      n.job.resolve();
    } else if (n && m.type === 'node') {
      if (m.quads) n.mesh = this.makeMesh(m.pos, m.attr, m.pal, m.bld, m.quads);
      if (m.data) this.setData(n, m.data);
      n.state = 'ready';
      n.job.resolve();
    }
    this.pump();
  }

  private makeMesh(pos: Int16Array, attr: Uint8Array, pal: Uint16Array, bld: Uint16Array | null, quads: number) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('vattr', new THREE.BufferAttribute(attr, 4));
    geo.setAttribute('vpal', new THREE.BufferAttribute(pal, 1));
    if (bld) geo.setAttribute('vbld', new THREE.BufferAttribute(bld, 1));
    geo.setIndex(this.quadIndex(quads));
    geo.setDrawRange(0, quads * 6);
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    for (const a of Object.values(geo.attributes)) (a as THREE.BufferAttribute).onUpload(releaseArray); // culling only needs the bounding sphere
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  // one index buffer for every tile: 0 1 2, 0 2 3 quad after quad (the mesher orders each quad's corners to fit it)
  private quadIndex(quads: number) {
    if (this.quadIdx && this.quadIdx.count >= quads * 6) return this.quadIdx;
    const n = Math.max(quads, 2 * (this.quadIdx ? this.quadIdx.count / 6 : 65536)), a = new Uint32Array(n * 6);
    for (let q = 0, b = 0; q < n; q++, b += 4) a.set([b, b + 1, b + 2, b, b + 2, b + 3], q * 6);
    const old = this.quadIdx;
    this.quadIdx = new THREE.BufferAttribute(a, 1);
    if (old) for (const v of this.nodes.values()) if (v.mesh?.geometry.index === old) v.mesh.geometry.setIndex(this.quadIdx);
    return this.quadIdx;
  }

  private setData(n: TileNode, { counts, ground, runs }: { counts: Uint16Array; ground: Uint8Array; runs: Uint16Array }) {
    const S = this.N + 2, off = new Uint32Array(S * S + 1);
    for (let i = 0; i < S * S; i++) off[i + 1] = off[i] + counts[i];
    const [x0, y0] = this.bounds(n.s, n.tx, n.ty);
    n.data = { s: n.s, x0, y0, S, counts, ground, runs, off };
    this.version++;
  }

  free(n: TileNode) {
    n.dataJob?.resolve();
    n.dataJob = undefined;
    if (n.mesh) { n.mesh.geometry.dispose(); this.group.remove(n.mesh); }
    this.nodes.delete(n.key);
    if (n.data) this.version++;
  }

  // full detail around (x, z) with its column data, e.g. before landing there
  ensure(x: number, z: number, r = 120) {
    const fine = this.levels[this.levels.length - 1], L = this.N * fine, d = this.dims[fine], ps = [];
    for (let ty = Math.max(0, Math.floor((z - r) / L)); ty <= Math.min(d.ny - 1, Math.floor((z + r) / L)); ty++)
      for (let tx = Math.max(0, Math.floor((x - r) / L)); tx <= Math.min(d.nx - 1, Math.floor((x + r) / L)); tx++)
        ps.push(this.request(fine, tx, ty, 1e8, true));
    this.pump();
    return Promise.all(ps);
  }
}
