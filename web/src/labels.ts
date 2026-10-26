import * as THREE from 'three';
import type { Rect } from './hud';
import type { Facts, Label } from './types';
import { $, el } from './util';
import type { World } from './world';

interface Pin {
  el: HTMLElement;
  txt: HTMLElement;
  p: THREE.Vector3;
  base: THREE.Vector3;
  R: number;
  occluded: boolean;
  w: number;
  h: number;
  shift: number;
}
export interface Placed extends Facts { x: number; y: number; z: number }

const details = (f: Facts) => [f.height && `${f.height} m`, f.year, f.rebuilt && `rebuilt ${f.rebuilt}`, f.by, f.building && 'under construction'].filter(Boolean);

const STEM = 20, TOP = 8;
const overlap = (r: Rect, q: Rect) => r.x0 < q.x1 + 6 && r.x1 + 6 > q.x0 && r.y0 < q.y1 + 2 && r.y1 + 2 > q.y0;

// Map pins: a dot on the roof, a hairline stem, the name above. Hidden when something else is in the way (a voxel
// ray) or when a more important label is there.
export class Labels {
  gate: (x: number, z: number) => boolean = () => true;
  private readonly host = $('#labels');
  private readonly pins: Pin[] = [];
  private picked: Pin | null = null;
  private frame = 0;

  constructor(labels: Label[], onClick: (l: Label) => void) {
    labels.forEach((l, i) => {
      const pin = this.add(`label${i < 6 ? ' major' : ''}`, l,
        new THREE.Vector3(l.x + 0.5, l.z + 1, l.y + 0.5), new THREE.Vector3(l.x + 0.5, (l.g ?? 0) + 2, l.y + 0.5), (l.R ?? 30) + 6);
      pin.txt.addEventListener('click', () => onClick(l));
      this.pins.push(pin);
    });
    document.fonts?.ready.then(() => { for (const p of this.pins) p.w = 0; });
  }

  private add(cls: string, f: Facts, p: THREE.Vector3, base: THREE.Vector3, R: number): Pin {
    const facts = details(f).map((d) => `<span>${d}</span>`).join('');
    const e = el('div', cls, `<i class="dot"></i><i class="stem"></i><div class="txt"><b>${f.name}</b><span>${f.en ?? f.kind}</span>${facts ? `<p>${facts}</p>` : ''}</div>`, this.host);
    return { el: e, txt: $('.txt', e), p, base, R, occluded: false, w: 0, h: 0, shift: 0 };
  }

  // a temporary label on a searched place
  pin(p: Placed | null) {
    if (this.picked) { this.picked.el.remove(); this.pins.splice(this.pins.indexOf(this.picked), 1); this.picked = null; }
    if (!p) return;
    this.picked = this.add('label pick', p, new THREE.Vector3(p.x + 0.5, p.z + 1, p.y + 0.5), new THREE.Vector3(p.x + 0.5, p.z, p.y + 0.5), 40);
    this.pins.unshift(this.picked);
  }

  update(camera: THREE.Camera, world: World | null, bar: DOMRect, obstacles: Rect[]) {
    if (world) this.checkOcclusion(camera, world);
    const placed: Rect[] = bar.width ? [{ x0: bar.left - 8, x1: bar.right, y0: bar.top, y1: bar.bottom + 8 }, ...obstacles] : [...obstacles];
    const free = (r: Rect) => r.x0 >= 4 && r.x1 <= innerWidth - 4 && r.y0 >= 4 && r.y1 <= innerHeight - 4 && !placed.some((q) => overlap(r, q));
    const under = (x: number) => bar.width > 0 && x > bar.left - 8 && x - 4 < bar.right;
    const v = new THREE.Vector3();
    for (const L of this.pins) {
      v.copy(L.p).project(camera);
      const inFront = v.z < 1;
      let x = (v.x * 0.5 + 0.5) * innerWidth, y = (-v.y * 0.5 + 0.5) * innerHeight;
      if (!L.w) { L.w = L.txt.offsetWidth || 160; L.h = L.txt.offsetHeight || 30; }
      let vis = false, side: 'r' | 'l' | 's' = 'r', pinned = false;
      if (!L.occluded && inFront && x > -20 && x < innerWidth + 20 && this.gate(L.p.x, L.p.z)) {
        // the roof above the screen but the building in view: the label pinned to the top edge
        if (y < TOP + STEM + L.h && y > -innerHeight * 0.8) {
          v.copy(L.base).project(camera);
          if (v.z < 1 && (-v.y * 0.5 + 0.5) * innerHeight > TOP + STEM + L.h + 30) {
            y = TOP + L.h + 4; pinned = true;
            if (under(x)) y = Math.max(y, bar.bottom + 20 + L.h);
          }
        }
        if (under(x) && y - STEM - L.h < bar.bottom + 8 && y > bar.top) { y = Math.max(y, bar.bottom + 20 + L.h); pinned = true; }
        if (y <= innerHeight + 4) {
          const st = pinned ? 4 : STEM, y0 = y - st - L.h, y1 = y + 4;
          const right = { x0: x - 4, x1: x + L.w, y0, y1 }, left = { x0: x - L.w, x1: x + 4, y0, y1 };
          const sx = Math.min(Math.max(x - L.w / 2, 4), innerWidth - L.w - 4), shifted = { x0: sx, x1: sx + L.w, y0, y1 };
          if (free(right)) { vis = true; placed.push(right); }
          else if (free(left)) { vis = true; side = 'l'; placed.push(left); }
          else if (L.w < innerWidth - 8 && free(shifted)) { vis = true; side = 's'; placed.push(shifted); L.shift = sx - x; }
        }
      }
      L.el.classList.toggle('off', !vis);
      L.el.classList.toggle('left', side === 'l');
      L.el.classList.toggle('pinned', pinned);
      L.txt.style.left = side === 's' ? `${L.shift.toFixed(0)}px` : '';
      if (vis) L.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
  }

  // a few labels per frame: hidden by something other than the labelled building itself
  private checkOcclusion(camera: THREE.Camera, world: World) {
    const dir = new THREE.Vector3();
    for (let k = 0; k < 4 && this.pins.length; k++) {
      const L = this.pins[this.frame++ % this.pins.length];
      dir.subVectors(L.p, camera.position);
      const dist = dir.length();
      dir.divideScalar(dist);
      const t = world.raycast(camera.position, dir, dist);
      const hx = camera.position.x + dir.x * t - L.p.x, hz = camera.position.z + dir.z * t - L.p.z;
      L.occluded = t < dist - 3 && hx * hx + hz * hz > L.R * L.R;
    }
  }
}
