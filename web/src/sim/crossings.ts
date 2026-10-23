import type { Path } from './path';
import type { Road, Tram, TramPath } from './types';
import { pushTo } from '../util';

type P2 = [number, number, number];
type Seg<T> = [P2, P2, number, T];

const segments = <T extends Path>(e: T): Seg<T>[] => e.p.slice(1).map((b, i) => [e.p[i], b, e.cum[i], e]);

// where two segments cross at more than 30°: the distance along each
function intersect(a: P2, b: P2, c: P2, d: P2): [number, number] | null {
  const r = [b[0] - a[0], b[1] - a[1]], q = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * q[1] - r[1] * q[0];
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * q[1] - (c[1] - a[1]) * q[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const lr = Math.hypot(r[0], r[1]), lq = Math.hypot(q[0], q[1]);
  return Math.abs(den) / (lr * lq) > 0.5 ? [t * lr, u * lq] : null;
}

const G = 32;
function cells(a: P2, b: P2) {
  const out = [];
  for (let gx = Math.floor(Math.min(a[0], b[0]) / G); gx <= Math.floor(Math.max(a[0], b[0]) / G); gx++)
    for (let gy = Math.floor(Math.min(a[1], b[1]) / G); gy <= Math.floor(Math.max(a[1], b[1]) / G); gy++) out.push(gx * 100003 + gy);
  return out;
}

// every pair of nearby segments from the two sets that cross, each pair once
function crossings<A extends Path, B extends Path>(as: A[], bs: B[], f: (sa: number, sb: number, a: A, b: B) => void) {
  const grid = new Map<number, Seg<B>[]>();
  for (const e of bs) for (const s of segments(e)) for (const k of cells(s[0], s[1])) pushTo(grid, k, s);
  for (const A of as) for (const [a, b, ca] of segments(A)) {
    const seen = new Set<Seg<B>>();
    for (const k of cells(a, b)) for (const s of grid.get(k) ?? []) {
      if (seen.has(s)) continue;
      seen.add(s);
      const hit = intersect(a, b, s[0], s[1]);
      if (hit) f(ca + hit[0], s[2] + hit[1], A, s[3]);
    }
  }
}

// level crossings (tram track x road) and diamonds (tram track x tram track); each tram path gets its list
export function findCrossings(roads: Road[], trams: TramPath[]) {
  const roadX = new Map<number, { sR: number; path: number; sT: number }[]>();
  for (const tp of trams) tp.xs = [];
  crossings(trams, roads, (sT, sR, tp, e) => {
    pushTo(roadX, e.i, { sR, path: tp.i, sT });
    tp.xs.push({ kind: 'road', e: e.i, sR, sT });
  });
  const diamonds: { holder: Tram | null }[] = [];
  crossings(trams, trams, (sA, sB, A, B) => {
    if (B.i <= A.i) return;
    const id = diamonds.length;
    diamonds.push({ holder: null });
    A.xs.push({ kind: 'diamond', id, sT: sA });
    B.xs.push({ kind: 'diamond', id, sT: sB });
  });
  return { roadX, diamonds };
}
