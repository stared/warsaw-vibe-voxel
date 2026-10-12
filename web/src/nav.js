import * as THREE from 'three';

// Queries on the column-run voxel data. Data coords: x east, row south, z up; three.js: (x, z, row).
export class VoxelWorld {
  constructor(meta, counts, runs, ground) {
    this.W = meta.W; this.D = meta.D; this.counts = counts; this.runs = runs; this.ground = ground;
    const n = this.W * this.D;
    this.off = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) this.off[i + 1] = this.off[i] + counts[i];
  }
  inside(x, r) { return x >= 0 && r >= 0 && x < this.W && r < this.D; }
  groundAt(x, r) { x = Math.floor(x); r = Math.floor(r); return this.inside(x, r) ? this.ground[r * this.W + x] : 0; }
  solid(x, r, z) {
    if (!this.inside(x, r)) return z < 0;
    const c = r * this.W + x;
    if (z < this.ground[c]) return true;
    const R = this.runs;
    for (let k = this.off[c], e = this.off[c + 1]; k < e; k++) {
      const z0 = R[k * 3];
      if (z < z0) return false;
      if (z < z0 + R[k * 3 + 1]) return true;
    }
    return false;
  }
  top(x, r) {
    if (!this.inside(x, r)) return 0;
    const c = r * this.W + x, n = this.counts[c];
    if (!n) return this.ground[c];
    const k = (this.off[c] + n - 1) * 3;
    return this.runs[k] + this.runs[k + 1];
  }
  // horizontal extent of the tall structure under (x, r): flood over neighbouring columns at least `minTop` high
  extent(x0, r0, minTop, cap = 40000) {
    x0 = Math.floor(x0); r0 = Math.floor(r0);
    const seen = new Set([r0 * this.W + x0]), q = [[x0, r0]];
    let R = 0;
    while (q.length && seen.size < cap) {
      const [x, r] = q.pop();
      R = Math.max(R, Math.hypot(x - x0, r - r0));
      for (const [dx, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nr = r + dr, k = nr * this.W + nx;
        if (!seen.has(k) && this.inside(nx, nr) && this.top(nx, nr) >= minTop) { seen.add(k); q.push([nx, nr]); }
      }
    }
    return R;
  }
  // highest surface at or below `top` in a column (where something standing at height <= top would rest)
  support(x, r, top) {
    x = Math.floor(x); r = Math.floor(r);
    if (!this.inside(x, r)) return 0;
    const c = r * this.W + x, R = this.runs;
    let s = this.ground[c];
    for (let k = this.off[c], e = this.off[c + 1]; k < e; k++) {
      const t = R[k * 3] + R[k * 3 + 1];
      if (t <= top && t > s) s = t;
    }
    return s;
  }
  // any solid voxel with level in [z0, z1)
  blocked(x, r, z0, z1) {
    x = Math.floor(x); r = Math.floor(r);
    for (let z = Math.floor(z0); z < z1; z++) if (this.solid(x, r, z)) return true;
    return false;
  }
  // voxel DDA; returns the distance to the first solid voxel, or Infinity
  raycast(o, d, maxDist = 4000) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = Math.sign(d.x), sy = Math.sign(d.y), sz = Math.sign(d.z);
    const tdx = sx ? Math.abs(1 / d.x) : Infinity, tdy = sy ? Math.abs(1 / d.y) : Infinity, tdz = sz ? Math.abs(1 / d.z) : Infinity;
    let tx = sx ? ((sx > 0 ? x + 1 - o.x : o.x - x) * tdx) : Infinity;
    let ty = sy ? ((sy > 0 ? y + 1 - o.y : o.y - y) * tdy) : Infinity;
    let tz = sz ? ((sz > 0 ? z + 1 - o.z : o.z - z) * tdz) : Infinity;
    let t = 0;
    for (let i = 0; i < 20000 && t < maxDist; i++) {
      if (y < 0) return t;
      if (y < 400 && this.solid(x, z, y)) return t;
      if (y > 400 && sy >= 0) return Infinity;
      if (tx < ty && tx < tz) { t = tx; x += sx; tx += tdx; }
      else if (ty < tz) { t = ty; y += sy; ty += tdy; }
      else { t = tz; z += sz; tz += tdz; }
    }
    return Infinity;
  }
}

// Camera navigation on top of OrbitControls.
//   orbit mode: left-drag orbit · right-drag look around (turn in place) · middle/shift-drag pan · wheel zoom
//               double-click fly there · WASD move · Q/E down/up · ←→ turn · ↑↓ look up/down · Shift+arrows orbit
//   walk mode (G): street level, mouse-look with pointer lock, WASD walk, Shift run, collides with buildings
const KEYMAP = {
  KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', KeyQ: 'down', KeyE: 'up', PageDown: 'down', PageUp: 'up',
  ArrowLeft: 'tl', ArrowRight: 'tr', ArrowUp: 'tu', ArrowDown: 'td',
};
const EYE = 1.7, STEP = 1.05, HEAD = 1.9;

export class Nav {
  constructor({ camera, controls, dom, flyTo, onMode }) {
    Object.assign(this, { camera, controls, dom, flyTo, onMode });
    this.world = null;
    this.mode = 'orbit';
    this.keys = new Set();
    this.shift = false;
    this.speed = 1;          // user multiplier
    this.lookSens = 1;
    this.walkFov = 65;
    this.yaw = 0; this.pitch = 0; this.feet = 0;
    this._v = new THREE.Vector3();
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null };
    controls.maxPolarAngle = Math.PI * 0.92; // allow looking up at the towers; the ground clamp keeps us above the street

    addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input[type=text], input[type=number], textarea, input:not([type])')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k);
      this.cancelFly?.();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.delete(k);
      if (k[0] === 't' && this._turned && !this.keys.size) { this._turned = false; this.retarget(); }
    });
    addEventListener('blur', () => this.keys.clear());

    // right-drag: look around in place
    let drag = null;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 2 || this.mode === 'walk') return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      dom.setPointerCapture(e.pointerId);
      this.cancelFly?.();
    });
    dom.addEventListener('pointermove', (e) => {
      if (this.mode === 'walk' && document.pointerLockElement === dom) {
        this.walkLook(-e.movementX * 0.0022 * this.lookSens, -e.movementY * 0.0022 * this.lookSens);
        return;
      }
      if (!drag || e.pointerId !== drag.id) return;
      const k = (camera.fov * Math.PI / 180) / innerHeight * this.lookSens;
      this.turn(-(e.clientX - drag.x) * k, -(e.clientY - drag.y) * k);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const end = (e) => { if (drag && e.pointerId === drag.id) { drag = null; this.retarget(); } };
    dom.addEventListener('pointerup', end);
    dom.addEventListener('pointercancel', end);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());

    // double-click: fly towards the clicked spot
    dom.addEventListener('dblclick', (e) => {
      if (this.mode === 'walk' || !this.world) return;
      const ray = this.rayFromScreen(e.clientX, e.clientY);
      const t = this.world.raycast(ray.origin, ray.direction);
      if (!isFinite(t)) return;
      const hit = ray.origin.clone().addScaledVector(ray.direction, t);
      const dist = camera.position.distanceTo(hit);
      const nd = Math.max(25, dist * 0.4);
      const pos = hit.clone().addScaledVector(ray.direction, -nd);
      pos.y = Math.max(pos.y, this.world.groundAt(pos.x, pos.z) + 2);
      this.flyTo({ pos: pos.toArray(), target: hit.toArray() });
    });
    dom.addEventListener('click', () => {
      if (this.mode === 'walk' && document.pointerLockElement !== dom) dom.requestPointerLock?.();
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.mode === 'walk' && document.pointerLockElement !== dom && this._locked) this.setMode('orbit');
      this._locked = document.pointerLockElement === dom;
    });
  }

  rayFromScreen(cx, cy) {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    return r.ray;
  }

  dir() { return this._v.subVectors(this.controls.target, this.camera.position); }

  // rotate the view direction about the camera (turn your head); keeps the focus distance
  turn(dyaw, dpitch) {
    const d = this.dir(), len = d.length() || 1;
    let yaw = Math.atan2(d.x, d.z), pitch = Math.asin(THREE.MathUtils.clamp(d.y / len, -1, 1));
    yaw += dyaw;
    pitch = THREE.MathUtils.clamp(pitch + dpitch, -1.5, 1.2);
    this.controls.target.set(
      this.camera.position.x + len * Math.sin(yaw) * Math.cos(pitch),
      this.camera.position.y + len * Math.sin(pitch),
      this.camera.position.z + len * Math.cos(yaw) * Math.cos(pitch));
  }

  // rotate the camera about the focus point (turntable)
  orbit(dyaw, dpitch) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t);
    const s = new THREE.Spherical().setFromVector3(off);
    s.theta += dyaw;
    s.phi = THREE.MathUtils.clamp(s.phi - dpitch, 0.05, this.controls.maxPolarAngle);
    off.setFromSpherical(s);
    this.camera.position.copy(t).add(off);
  }

  // after looking around, put the focus on whatever is in the middle of the screen, so orbiting pivots on it
  retarget() {
    if (!this.world || this.mode === 'walk') return;
    const d = this.dir().clone().normalize();
    const t = this.world.raycast(this.camera.position, d, 3000);
    const len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    this.controls.target.copy(this.camera.position).addScaledVector(d, len);
  }

  setMode(m) {
    if (m === this.mode) return;
    if (m === 'walk') {
      if (!this.world) return;
      const c = this.camera.position, t = this.controls.target;
      // land at the street spot nearest to where we look (the focus), not on a roof
      const spot = this.findStreet(t.x, t.z) || this.findStreet(c.x, c.z);
      if (!spot) return;
      const d = this.dir();
      this.yaw = Math.atan2(d.x, d.z);
      this.pitch = 0.05;
      this.feet = this.world.groundAt(spot[0], spot[1]);
      this.walkPos = new THREE.Vector3(spot[0] + 0.5, this.feet + EYE, spot[1] + 0.5);
      this.mode = 'walk';
      this.controls.enabled = false;
      this._fov0 = this.camera.fov;
      this._landing = { from: c.clone(), fromQ: this.camera.quaternion.clone(), t0: performance.now() };
      this.dom.requestPointerLock?.();
    } else {
      this.mode = 'orbit';
      this.controls.enabled = true;
      if (this._fov0) { this.camera.fov = this._fov0; this.camera.updateProjectionMatrix(); }
      if (document.pointerLockElement === this.dom) document.exitPointerLock();
      this.controls.target.copy(this.camera.position).add(this.lookDir().multiplyScalar(30));
      this.retarget();
    }
    this.onMode?.(this.mode);
  }

  findStreet(x0, r0) {
    const w = this.world;
    for (let rad = 0; rad < 60; rad++) {
      for (let i = -rad; i <= rad; i++) for (const [x, r] of [[x0 + i, r0 - rad], [x0 + i, r0 + rad], [x0 - rad, r0 + i], [x0 + rad, r0 + i]]) {
        const xi = Math.floor(x), ri = Math.floor(r);
        if (!w.inside(xi, ri)) continue;
        const g = w.groundAt(xi, ri);
        if (!w.blocked(xi, ri, g, g + 60) && !w.blocked(xi + 1, ri, g, g + 3) && !w.blocked(xi - 1, ri, g, g + 3)
          && !w.blocked(xi, ri + 1, g, g + 3) && !w.blocked(xi, ri - 1, g, g + 3)) return [xi, ri];
      }
    }
    return null;
  }

  lookDir() {
    return new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
  }
  walkLook(dyaw, dpitch) {
    this.yaw += dyaw;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dpitch, -1.4, 1.45);
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const K = this.keys;
    if (this.mode === 'walk') return this.updateWalk(dt);
    const cam = this.camera, ctl = this.controls;
    // arrows: turn in place; Shift+arrows: orbit around the focus
    const tr = (K.has('tr') ? 1 : 0) - (K.has('tl') ? 1 : 0), tp = (K.has('tu') ? 1 : 0) - (K.has('td') ? 1 : 0);
    if (tr || tp) {
      if (this.shift) this.orbit(tr * 1.2 * dt, -tp * 0.8 * dt);
      else { this.turn(-tr * 1.3 * dt, tp * 0.8 * dt); this._turned = true; }
    }
    // WASD: move over the ground relative to the view; speed scales with height above the ground
    const fwd = this.dir().clone().setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const gnd = this.world ? this.world.groundAt(cam.position.x, cam.position.z) : 15;
    const h = Math.max(3, cam.position.y - gnd);
    const speed = this.speed * (this.shift ? 3 : 1) * Math.min(400, 8 + h * 0.9) * dt;
    const d = new THREE.Vector3();
    if (K.has('f')) d.add(fwd);
    if (K.has('b')) d.sub(fwd);
    if (K.has('r')) d.add(right);
    if (K.has('l')) d.sub(right);
    if (d.lengthSq()) d.normalize().multiplyScalar(speed);
    if (K.has('up')) d.y += speed * 0.7;
    if (K.has('down')) d.y -= speed * 0.7;
    if (d.lengthSq()) { cam.position.add(d); ctl.target.add(d); }
  }

  // keep the orbit camera above the terrain (called after controls.update)
  clamp() {
    if (!this.world || this.mode === 'walk') return;
    const p = this.camera.position, g = this.world.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
  }

  updateWalk(dt) {
    const K = this.keys, w = this.world, cam = this.camera, P = this.walkPos;
    const tr = (K.has('tr') ? 1 : 0) - (K.has('tl') ? 1 : 0), tp = (K.has('tu') ? 1 : 0) - (K.has('td') ? 1 : 0);
    if (tr || tp) this.walkLook(-tr * 1.6 * dt, tp * 1.0 * dt);
    const fwd = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const m = new THREE.Vector3();
    if (K.has('f')) m.add(fwd);
    if (K.has('b')) m.sub(fwd);
    if (K.has('r')) m.add(right);
    if (K.has('l')) m.sub(right);
    if (m.lengthSq()) {
      m.normalize().multiplyScalar((this.shift ? 14 : 4.5) * this.speed * dt);
      // move with wall sliding: try the full step, then each axis
      for (const s of [m, new THREE.Vector3(m.x, 0, 0), new THREE.Vector3(0, 0, m.z)]) {
        if (!s.lengthSq()) continue;
        const nx = P.x + s.x, nz = P.z + s.z;
        const ax = nx + Math.sign(s.x) * 0.3, az = nz + Math.sign(s.z) * 0.3; // body radius
        const sup = w.support(ax, az, this.feet + STEP);
        if (!w.blocked(ax, az, Math.max(sup, this.feet + STEP), sup + HEAD) && !w.blocked(nx, nz, Math.max(w.support(nx, nz, this.feet + STEP), this.feet + STEP), this.feet + HEAD)) {
          P.x = nx; P.z = nz;
          break;
        }
      }
    }
    // stand on whatever is under us (steps up kerbs and stairs, falls off ledges)
    const sup = w.support(P.x, P.z, this.feet + STEP);
    this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : Math.max(sup, this.feet - 12 * dt);
    P.y = this.feet + EYE;
    const look = this.lookDir();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    if (this._landing) {
      const L = this._landing, t = Math.min(1, (performance.now() - L.t0) / 1300), e = t * t * (3 - 2 * t);
      cam.position.lerpVectors(L.from, P, e);
      cam.quaternion.slerpQuaternions(L.fromQ, q, e);
      cam.fov = this._fov0 + (this.walkFov - this._fov0) * e; // eye-level: a human field of view, not the diorama telephoto
      cam.updateProjectionMatrix();
      if (t >= 1) this._landing = null;
    } else {
      cam.position.copy(P);
      cam.quaternion.copy(q);
    }
    this.controls.target.copy(cam.position).addScaledVector(look, 10);
  }
}
