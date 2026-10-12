import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Warsaw trams (Tramwaje Warszawskie livery: yellow body, red skirt) running on the real OSM tram tracks.
const SECTION = 10.5, GAP = 0.6, SPEED = 7.5; // m, m, m/s

function box(w, h, l, y, color) {
  const g = new THREE.BoxGeometry(w, h, l);
  g.translate(0, y + h / 2, 0);
  const c = new THREE.Color(color);
  const col = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < col.length; i += 3) col.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function sectionGeometry() {
  return mergeGeometries([
    box(2.4, 0.9, SECTION, 0.15, 0xc8322b), // red skirt
    box(2.4, 1.9, SECTION, 1.05, 0xf2c230), // yellow body
    box(2.0, 0.35, SECTION - 0.8, 2.95, 0xd9d6cf), // roof equipment
  ]);
}

function windowGeometry() {
  return box(2.46, 0.85, SECTION - 1.2, 1.6, 0x26323d);
}

export class Trams {
  constructor(scene, paths) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
    this.winMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.15, metalness: 0.4, emissive: new THREE.Color(1.0, 0.82, 0.55), emissiveIntensity: 0 });
    const body = sectionGeometry(), win = windowGeometry();
    this.trams = [];
    for (const path of paths) {
      // cumulative distances
      const pts = path.map(([x, y, z]) => new THREE.Vector3(x, z, y));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      const L = cum[cum.length - 1];
      const n = Math.max(1, Math.round(L / 420));
      for (let k = 0; k < n; k++) {
        const sections = [];
        for (let s = 0; s < 3; s++) {
          const m = new THREE.Group();
          const b = new THREE.Mesh(body, this.bodyMat), w = new THREE.Mesh(win, this.winMat);
          b.castShadow = b.receiveShadow = true;
          m.add(b, w);
          this.group.add(m);
          sections.push(m);
        }
        this.trams.push({ pts, cum, L, sections, phase: (k / n) * 2 * L + Math.random() * 60 });
      }
    }
  }

  sample(t, d, out, dir) {
    d = Math.min(Math.max(d, 0), t.L);
    let lo = 0, hi = t.cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t.cum[mid] < d) lo = mid; else hi = mid; }
    const a = t.pts[lo], b = t.pts[hi];
    const f = (d - t.cum[lo]) / Math.max(1e-6, t.cum[hi] - t.cum[lo]);
    out.lerpVectors(a, b, f);
    dir.subVectors(b, a).setY(0).normalize();
  }

  update(time, night) {
    this.winMat.emissiveIntensity = night * 1.6;
    const p = new THREE.Vector3(), d = new THREE.Vector3();
    for (const t of this.trams) {
      // ping-pong along the track, pausing briefly at the ends
      const span = t.L - 3 * (SECTION + GAP);
      const u = ((time * SPEED + t.phase) % (2 * span + 40)) - 20;
      const fwd = u < span + 20;
      let head = fwd ? Math.min(Math.max(u, 0), span) : Math.min(Math.max(2 * span + 20 - u, 0), span);
      head += 3 * (SECTION + GAP);
      for (let s = 0; s < 3; s++) {
        const c = fwd ? head - (s + 0.5) * (SECTION + GAP) : head - (2.5 - s) * (SECTION + GAP);
        this.sample(t, c, p, d);
        const m = t.sections[s];
        m.position.set(p.x, p.y + 0.05, p.z);
        m.rotation.y = Math.atan2(d.x, d.z);
      }
    }
  }
}
