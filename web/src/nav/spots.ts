import * as THREE from 'three';
import type { PedEdge } from '../sim/types';
import { clamp, pushTo } from '../util';
import type { World } from '../world';

export const EYE = 1.7;

type Net = (x: number, r: number, R: number) => [number, number][];

// points every ~3 m along the footpaths, by 64 m cells, off bridge decks and footbridges
export function walkNet(world: World, peds: PedEdge[]): Net {
  const grid = new Map<number, [number, number, number][]>(), key = (gx: number, gy: number) => gx * 100003 + gy;
  for (const e of peds) {
    for (let i = 1; i < e.p.length; i++) {
      const [ax, ay, az] = e.p[i - 1], [bx, by] = e.p[i], L = Math.hypot(bx - ax, by - ay);
      for (let t = 0; t < L; t += 3) {
        const x = ax + (bx - ax) * t / L, r = ay + (by - ay) * t / L;
        pushTo(grid, key((x / 64) | 0, (r / 64) | 0), [x, r, az]);
      }
    }
  }
  return (x0, r0, R) => {
    const out: [number, number][] = [];
    for (let gx = Math.floor((x0 - R) / 64); gx <= Math.floor((x0 + R) / 64); gx++)
      for (let gy = Math.floor((r0 - R) / 64); gy <= Math.floor((r0 + R) / 64); gy++)
        for (const p of grid.get(key(gx, gy)) ?? []) if (Math.abs(p[2] - world.groundAt(p[0], p[1])) <= 2) out.push([p[0], p[1]]);
    return out;
  };
}

function* gridAround(x0: number, r0: number, R: number, step: number): Generator<[number, number]> {
  for (let dr = -R; dr <= R; dr += step) for (let dx = -R; dx <= R; dx += step) yield [x0 + dx, r0 + dr];
}

export interface Spot { at: [number, number]; landmark: THREE.Vector3 | null }

// Where to stand to see (x0, r0): on open street (never a courtyard), at a distance that fits the landmark (its top
// in view: ~0.7 x its height, 30-160 m) with a clear line of sight to its upper part; or, on open ground, nearby.
export function openSpot(w: World, net: Net | null, x0: number, r0: number): Spot | null {
  const o = new THREE.Vector3(), dir = new THREE.Vector3(), to = new THREE.Vector3();
  let lx = Math.floor(x0), lr = Math.floor(r0), top = w.topSolid(lx, lr);
  for (let dr = -30; dr <= 30; dr += 3) for (let dx = -30; dx <= 30; dx += 3) { // the tallest structure near the focus
    const t = w.topSolid(Math.floor(x0 + dx), Math.floor(r0 + dr));
    if (t > top) { top = t; lx = Math.floor(x0 + dx); lr = Math.floor(r0 + dr); }
  }
  const H = top - w.groundAt(lx, lr), building = H > 8, ideal = clamp(H * 0.7, 30, 160);
  const cx0 = building ? lx : x0, cr0 = building ? lr : r0;
  for (const R of building ? [ideal + 60, ideal + 140] : [40, 90]) {
    let best: [number, number] | null = null, bs = -Infinity;
    for (const [px, pr] of net ? net(cx0, cr0, R) : gridAround(cx0, cr0, R, R > 60 ? 4 : 2)) {
      const x = Math.floor(px), r = Math.floor(pr), d = Math.hypot(px - cx0, pr - cr0);
      if (d > R || !w.inside(x, r)) continue;
      const g = w.groundAt(x, r);
      if (!w.clearAround(x, r, g, 40)) continue;
      o.set(x + 0.5, g + EYE, r + 0.5);
      let open = 0, long = 0;
      for (let k = 0; k < 8; k++) {
        const t = w.raycast(o, dir.set(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)), 130);
        open += Math.min(40, t);
        if (t >= 120) long++;
      }
      open /= 8;
      if (open < (net ? 8 : 12) || (!net && long < 2)) continue; // off the footpaths, only where there is a long view out
      let score = open - d * 0.6;
      if (building) {
        to.set(lx + 0.5 - o.x, g + H * 0.66 - o.y, lr + 0.5 - o.z);
        const U = to.length(), seen = w.raycast(o, to.divideScalar(U), U) >= U - Math.max(12, H * 0.15);
        dir.set(lx + 0.5 - o.x, 0, lr + 0.5 - o.z);
        const Dl = dir.length(), face = Math.min(Dl, w.raycast(o, dir.divideScalar(Dl || 1), Dl + 2));
        score = open * 0.5 - Math.abs(face - ideal) * 0.35 - (face < 12 ? 30 : 0) - (seen ? 0 : 40);
      }
      if (score > bs) { bs = score; best = [x, r]; }
    }
    if (best) return { at: best, landmark: building ? new THREE.Vector3(lx + 0.5, top, lr + 0.5) : null };
  }
  const street = findStreet(w, x0, r0);
  return street && { at: street, landmark: null };
}

// the nearest open street cell, in growing squares
export function findStreet(w: World, x0: number, r0: number): [number, number] | null {
  for (let rad = 0; rad < 60; rad++) {
    for (let i = -rad; i <= rad; i++) {
      for (const [x, r] of [[x0 + i, r0 - rad], [x0 + i, r0 + rad], [x0 - rad, r0 + i], [x0 + rad, r0 + i]]) {
        const xi = Math.floor(x), ri = Math.floor(r);
        if (w.inside(xi, ri) && w.clearAround(xi, ri, w.groundAt(xi, ri), 60)) return [xi, ri];
      }
    }
  }
  return null;
}

// with a wall right ahead, step back (past lamp posts and bollards) to where there is something to see
export function backOff(w: World, P: THREE.Vector3, feet: number, facing: THREE.Vector3) {
  const h = new THREE.Vector3(facing.x, 0, facing.z).normalize();
  const ahead = (x: number, z: number) => w.raycast(new THREE.Vector3(x, feet + EYE, z), h, 60);
  let bx = P.x, bz = P.z, bt = ahead(P.x, P.z);
  for (let k = 1; k <= 14 && bt < 12; k++) {
    const x = P.x - h.x * k, z = P.z - h.z * k, g = w.groundAt(x, z);
    if (w.blocked(x, z, g, g + 12)) continue;
    const t = ahead(x, z);
    if (t > bt) { bt = t; bx = x; bz = z; }
  }
  return { x: bx, z: bz, feet: w.groundAt(bx, bz) };
}
