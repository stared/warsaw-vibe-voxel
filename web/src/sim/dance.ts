import * as THREE from 'three';
import { hash, smooth } from '../util';
import type { LifeMeshes } from './meshes';

// Zouk evenings on the dark stone disc south-east of Centrum Nauki Kopernik (OSM way 603145360, ~11 x 14 m): couples in
// close hold rock on the beat and turn about their centre, the follower now and then spun out and back.
export const DANCE = { x: 2626.2, y: 741.0, rx: 3.6, ry: 5.0, couples: 7, from: 18.5, to: 23.5, bpm: 84 };
const SHIRTS = ['#b03a48', '#f0f0f0', '#2f2f33', '#d9a441', '#8b5fa8', '#3d6fa8', '#e07a9a', '#5a8fa3', '#c8553d', '#1f6f5c'];

// writes the dancers into the people meshes from instance i0 on; returns how many
export function drawDancers(M: LifeMeshes, i0: number, max: number, t: number, hour: number, ground: number) {
  if (hour < DANCE.from || hour > DANCE.to || !ground) return 0;
  const n = Math.round(DANCE.couples * Math.min(1, hour - DANCE.from, DANCE.to - hour));
  const beat = t * DANCE.bpm / 60 * Math.PI;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), tilt = new THREE.Quaternion(), pos = new THREE.Vector3(), sc = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3(), col = new THREE.Color();
  let i = i0;
  for (let k = 0; k < n && i + 1 < max; k++) {
    const a = (k / DANCE.couples) * 2 * Math.PI + t * 0.03, rr = 0.25 + 0.6 * hash(k + 41);
    const cx = DANCE.x + Math.cos(a) * DANCE.rx * rr, cy = DANCE.y + Math.sin(a) * DANCE.ry * rr;
    const turn = hash(k + 7) * 6.28 + t * (0.25 + 0.3 * hash(k + 3)) * (k % 2 ? 1 : -1);
    const sp = (t * 0.1 + hash(k + 13)) % 1, spin = sp < 0.15 ? smooth(0, 1, sp / 0.15) : 0;
    const open = Math.sin(Math.PI * spin);
    const rock = 0.12 * Math.sin(beat + k), sep = 0.27 + 0.45 * open;
    const dx = Math.sin(turn), dy = Math.cos(turn);
    for (const lead of [true, false]) {
      const d = lead ? -sep * 0.6 : sep;
      const h = turn + (lead ? 0 : Math.PI + spin * 2 * Math.PI);
      const lean = lead ? 0.04 * Math.sin(beat * 0.5 + k) : 0.16 * Math.sin(beat * 0.25 + k * 1.7) * (1 - open);
      q.setFromAxisAngle(up, h).premultiply(tilt.setFromAxisAngle(side.set(Math.cos(h), 0, -Math.sin(h)), lean));
      pos.set(cx + dx * (d + rock), ground + 0.03 * Math.abs(Math.sin(beat)), cy + dy * (d + rock));
      m.compose(pos, q, sc.set(1, lead ? 1.04 : 0.96, 1));
      M.legs.setMatrixAt(i, m); M.torso.setMatrixAt(i, m);
      col.set(SHIRTS[Math.floor(hash(k * 2 + (lead ? 0 : 1) + 101) * SHIRTS.length)]);
      M.torso.setColorAt(i, col);
      i++;
    }
  }
  return i - i0;
}
