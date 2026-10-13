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
      if (y < 0) { this.hitAxis = 1; return t; }
      if (y < 400 && this.solid(x, z, y)) return t;
      if (y > 400 && sy >= 0) return Infinity;
      if (tx < ty && tx < tz) { t = tx; x += sx; tx += tdx; this.hitAxis = 0; }
      else if (ty < tz) { t = ty; y += sy; ty += tdy; this.hitAxis = 1; }
      else { t = tz; z += sz; tz += tdz; this.hitAxis = 2; }
    }
    return Infinity;
  }
}

// Camera navigation, three modes, one gesture language (mouse, trackpad and touch alike):
//   orbit (fly-over): drag moves the map · right-drag (or Shift/Ctrl-drag, two fingers) rotates & tilts · wheel/pinch zooms
//                     at the cursor · double-click flies there · click a tram, car or person to ride along
//   walk (street):    drag looks around · click the street to walk there · wheel steps forward/back · pinch zooms the lens
//                     WASD/arrows walk, Shift runs, Space jumps · Esc flies back up
//   ride (possess):   see through the eyes of a pedestrian, a driver or a tram driver (or follow from behind) · drag looks around
const KEYMAP = {
  KeyW: 'f', KeyS: 'b', KeyA: 'l', KeyD: 'r', KeyQ: 'down', KeyE: 'up', PageDown: 'down', PageUp: 'up',
  ArrowLeft: 'tl', ArrowRight: 'tr', ArrowUp: 'tu', ArrowDown: 'td',
};
const EYE = 1.7, STEP = 1.05, HEAD = 1.9, GRAV = 16;
// where the camera sits on each kind of agent: eyes (first person) and behind (chase)
const RIG = {
  person: { eye: [0, 1.62, 0.2], back: 4.5, up: 2.2, fov: 65 },
  car: { eye: [0, 1.3, 2.45], back: 9, up: 3.6, fov: 62 },  // dashcam just past the bonnet (inside, you'd see the car's own boxes)
  tram: { eye: [0, 2.1, 5.4], back: 26, up: 9, fov: 60 },  // at the cab window, just ahead of the front
};

export class Nav {
  constructor({ camera, controls, dom, scene, flyTo, onMode, north }) {
    Object.assign(this, { camera, controls, dom, flyTo, onMode });
    this.world = null;
    this.life = null;        // StreetLife, for picking agents to ride
    this.mode = 'orbit';
    this.keys = new Set();
    this.shift = false;
    this.speed = 1;          // user multiplier
    this.lookSens = 1;
    this.gameLook = false; // false: drag moves the picture (Street View, what most visitors know); true: drag turns your head (games)
    this.walkFov = 65;
    this.yaw = 0; this.pitch = 0; this.feet = 0; this.vy = 0;
    this.goal = null;        // click-to-walk target
    this.ride = null;        // { kind, obj, view: 'eyes'|'behind', dyaw, dpitch, t0, from, fromQ }
    this.north = north || new THREE.Vector3(0, 0, -1);
    this._v = new THREE.Vector3();
    // map convention: drag pans the ground; right-drag / modifier-drag rotates (OrbitControls swaps PAN->ROTATE with Ctrl/Meta/Shift)
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.maxPolarAngle = Math.PI * 0.48; // from the air you look down or level; looking up at towers is what street level is for
    dom.style.cursor = 'grab';

    // street-level marker: where a click would take you
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.marker.renderOrder = 10; this.marker.visible = false;
    scene.add(this.marker);

    addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input[type=text], input[type=number], textarea, input:not([type])')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      this.shift = e.shiftKey;
      if (e.code === 'Escape') { this.back(); return; }
      if (e.code === 'Space' && this.mode === 'walk') { if (this.vy === 0) this.vy = 5.2; e.preventDefault(); return; }
      if (e.code === 'KeyV' && this.mode === 'ride') { this.toggleView(); return; }
      if (e.code === 'KeyN' && this.mode === 'ride') { this.nextRide(); return; }
      if ((e.code === 'KeyF' || e.code === 'KeyE') && this.mode === 'walk') { this.takeNearest(); return; } // GTA: get in
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k);
      this.goal = null;
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

    // pointers: taps vs drags, and our own look-drag / pinch when OrbitControls is off (walk, ride)
    const ptrs = new Map();
    let press = null, pinch0 = null;
    dom.addEventListener('pointerdown', (e) => {
      document.activeElement?.blur?.(); // keys belong to the map again (not to the last panel widget)
      this.onHover?.(null);
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // rotating pivots on what is in the middle of the screen, so the thing you look at stays put
      if (this.mode === 'orbit' && (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2)) {
        // pivot on the axis of view, at the depth of what is under the cursor: you orbit the building you grabbed, nothing jumps
        const hit = this.world && this.hitAt(e.clientX, e.clientY);
        if (hit) {
          const v = this.camera.getWorldDirection(new THREE.Vector3()), dd = hit.clone().sub(this.camera.position).dot(v);
          if (dd > 5) this.controls.target.copy(this.camera.position).addScaledVector(v, dd);
        } else this.retarget();
      }
      if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; this._twist = Math.atan2(b.y - a.y, b.x - a.x); }
      press = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false } : null;
      if (ptrs.size === 2 && this.mode !== 'orbit') { const [a, b] = [...ptrs.values()]; pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: this.camera.fov }; }
      if (this.mode !== 'orbit') dom.setPointerCapture(e.pointerId);
      else dom.style.cursor = 'grabbing';
      this.cancelFly?.();
    });
    dom.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { this.hover(e.clientX, e.clientY, e.pointerType); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      if (this.mode === 'orbit') {
        if (ptrs.size === 2) this._zoomT = performance.now(); // a pinch may be a dive
        if (ptrs.size === 2 && this._twist !== undefined) { // two-finger twist turns the map, like Google Maps
          const [a, b] = [...ptrs.values()], ang = Math.atan2(b.y - a.y, b.x - a.x);
          let d = ang - this._twist; d = Math.atan2(Math.sin(d), Math.cos(d));
          this._twist = ang;
          this.orbit(d, 0);
        }
        return;
      }
      if (ptrs.size === 2 && pinch0) { // pinch: zoom the lens
        const [a, b] = [...ptrs.values()];
        this.setFov(pinch0.fov * pinch0.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)));
        return;
      }
      if (press && !press.moved) return;
      // look like in a game: drag right turns right, drag down looks down (what every play-tester expected)
      // the picture follows the finger/mouse (Street View); game-style look is an option in Camera
      const k = (e.pointerType === 'touch' ? 2.4 : 1.2) * (this.camera.fov * Math.PI / 180) / innerHeight * this.lookSens * (this.gameLook ? -1 : 1);
      this.look(dx * k, dy * k * 0.7); // up/down a bit calmer than left/right: easy to keep the horizon
      this.marker.visible = false;
    });
    const up = (e) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) { pinch0 = null; this._twist = undefined; }
      this._quietT = performance.now(); // no hover tooltip right after a drag
      if (this.mode === 'orbit') dom.style.cursor = 'grab';
      if (press && !press.moved && e.type === 'pointerup' && performance.now() - press.t < 600 && press.button === 0) this.tap(e.clientX, e.clientY);
      if (!ptrs.size) press = null;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('pointerleave', () => { this.marker.visible = false; this.onHover?.(null); });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => {
      if (this.mode === 'orbit') { this._zoomT = performance.now(); return; } // OrbitControls zooms
      e.preventDefault();
      if (e.ctrlKey || this.mode === 'ride') { this.setFov(this.camera.fov * Math.exp(e.deltaY * 0.004)); return; } // pinch: lens
      // wheel at street level: step forward/back where you look; keep scrolling back and you rise to the bird's-eye view
      if (e.deltaY > 0) { const now = performance.now(); this._back = (now - (this._backT || 0) < 600 ? this._back || 0 : 0) + e.deltaY; this._backT = now; if (this._back > 900) { this._back = 0; this.flyUp(); return; } }
      const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const P = this.goal ? new THREE.Vector3(this.goal.x, 0, this.goal.z) : this.walkPos.clone();
      P.addScaledVector(f, -Math.sign(e.deltaY) * Math.min(4, Math.abs(e.deltaY) / 30));
      this.goal = { x: P.x, z: P.z, t: performance.now() };
    }, { passive: false });

    // double-click: fly towards the clicked spot
    dom.addEventListener('dblclick', (e) => {
      if (this.mode !== 'orbit' || !this.world) return;
      const hit = this.hitAt(e.clientX, e.clientY);
      if (!hit) return;
      const dist = camera.position.distanceTo(hit);
      const nd = Math.max(25, dist * 0.4);
      const dir = hit.clone().sub(camera.position).normalize();
      const pos = hit.clone().addScaledVector(dir, -nd);
      pos.y = Math.max(pos.y, this.world.groundAt(pos.x, pos.z) + 2);
      this.flyTo({ pos: pos.toArray(), target: hit.toArray() });
    });
  }

  rayFromScreen(cx, cy) {
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    return r.ray;
  }
  hitAt(cx, cy, maxDist = 4000) {
    const ray = this.rayFromScreen(cx, cy);
    const t = this.world.raycast(ray.origin, ray.direction, maxDist);
    if (!isFinite(t)) return null;
    const hit = ray.origin.clone().addScaledVector(ray.direction, t);
    hit.axis = this.world.hitAxis; hit.dir = ray.direction;
    return hit;
  }
  pickAgent(cx, cy, px, minPx = 0) {
    if (!this.life || !this.life.group.visible || !this.world) return null;
    return this.life.pick(this.camera, cx, cy, px, minPx, (o, d) => {
      const t = this.world.raycast(this.camera.position, d.clone().normalize(), d.length());
      return t >= d.length() - 2.5;
    }, this.ride && this.ride.obj);
  }

  // hover feedback: what a click would do here
  hover(cx, cy, type) {
    if (type === 'touch') return;
    const now = performance.now();
    if (now - (this._hoverT || 0) < 60 || now - (this._quietT || 0) < 350) return;
    this._hoverT = now;
    const ag = this.pickAgent(cx, cy, this.mode === 'orbit' ? 14 : 3, this.mode === 'orbit' ? 7 : 0);
    this.onHover?.(ag, cx, cy);
    this.dom.style.cursor = ag ? 'pointer' : this.mode === 'orbit' ? 'grab' : 'default';
    if (this.mode !== 'walk' || ag) { this.marker.visible = false; return; }
    const g = this.walkTarget(cx, cy);
    this.marker.visible = !!g;
    if (g) this.marker.position.set(g.x, g.y + 0.06, g.z);
  }
  // where clicking (cx, cy) at street level would walk to: the street spot, or the foot of the wall you clicked
  walkTarget(cx, cy) {
    const hit = this.hitAt(cx, cy, 250);
    if (!hit) return null;
    const p = hit.clone();
    if (hit.axis !== 1 || hit.y > this.feet + 3) { // a wall or a roof: stop in front of it, on the street
      const h = new THREE.Vector3(hit.dir.x, 0, hit.dir.z).normalize();
      p.addScaledVector(h, -0.8);
    }
    p.y = this.world.support(p.x, p.z, this.feet + 3);
    return p;
  }
  tap(cx, cy) {
    // generous from the air (people are a few pixels tall), tight on the street so a click on the road walks rather than boards
    const coarse = matchMedia('(pointer: coarse)').matches, air = this.mode === 'orbit';
    if (air) { // from the air a click on a vehicle/person rides it (only once it's a few px tall: no accidents)
      const ag = this.pickAgent(cx, cy, coarse ? 26 : 16, 5);
      if (ag) { this.startRide(ag); return; }
    } else { // on the street people and cars move under your finger: a tap near one offers the ride, but still walks
      const ag = this.pickAgent(cx, cy, coarse ? 30 : 20, 0);
      if (ag) this.onOffer?.(ag, cx, cy);
      if (this.mode === 'ride') return;
    }
    if (this.mode === 'walk') {
      const g = this.walkTarget(cx, cy);
      if (g) { this.goal = { x: g.x, z: g.z, t: performance.now() }; this.marker.position.set(g.x, g.y + 0.06, g.z); this.marker.visible = true; }
    }
  }

  dir() { return this._v.subVectors(this.controls.target, this.camera.position); }
  // compass heading of the view (0 = north, +90° = east), for the HUD compass
  heading() {
    const f = this.mode === 'orbit' ? this.dir().clone() : this.camera.getWorldDirection(new THREE.Vector3());
    const n = this.north, e = new THREE.Vector3(-n.z, 0, n.x); // east is north turned clockwise seen from above
    return Math.atan2(f.x * e.x + f.z * e.z, f.x * n.x + f.z * n.z);
  }
  setFov(f) { this.camera.fov = THREE.MathUtils.clamp(f, 20, 80); this.camera.updateProjectionMatrix(); }

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
    if (!this.world || this.mode !== 'orbit') return;
    const d = this.dir().clone().normalize();
    const t = this.world.raycast(this.camera.position, d, 3000);
    const len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    this.controls.target.copy(this.camera.position).addScaledVector(d, len);
  }
  // look around at street level / on a ride (drag)
  look(dyaw, dpitch) {
    if (this.mode === 'walk') this.walkLook(dyaw, dpitch);
    else if (this.mode === 'ride') { const R = this.ride; R.dyaw += dyaw; R.dpitch = THREE.MathUtils.clamp(R.dpitch + dpitch, -1.2, 1.2); R.idle = performance.now(); }
  }

  // Esc / "back": ride -> walk on the spot, walk -> fly up
  back() {
    if (this.mode === 'ride') this.hopOff();
    else if (this.mode === 'walk') this.flyUp();
  }
  // leave street level: rise to a bird's-eye view over where you were looking
  flyUp() {
    const from = this.camera.position.clone(), f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const S = this._sky; // the bird's-eye view you came down from
    if (S && Math.hypot(S.target.x - from.x, S.target.z - from.z) < 120) {
      this.setMode('orbit');
      this.flyTo({ pos: S.pos.toArray(), target: S.target.toArray() });
      return;
    }
    const tgt = from.clone().addScaledVector(f, 60); tgt.y = this.world ? this.world.groundAt(tgt.x, tgt.z) + 5 : from.y;
    const pos = tgt.clone().addScaledVector(f, -380); pos.y = tgt.y + 330; // above the towers, the district in view
    this.setMode('orbit');
    this.flyTo({ pos: pos.toArray(), target: tgt.toArray() });
  }

  setMode(m, opts = {}) {
    if (m === this.mode && !opts.at) return;
    const prev = this.mode;
    this.marker.visible = false;
    if (this.life && m !== 'ride') this.life.keep = null;
    if (m === 'walk') {
      if (!this.world) return;
      const c = this.camera.position, t = opts.at || this.controls.target;
      // land at the street spot nearest to where we look (the focus), not on a roof
      const spot = (opts.exact && [Math.floor(t.x), Math.floor(t.z)]) || this.openSpot(t.x, t.z) || this.findStreet(c.x, c.z);
      if (!spot) return;
      // face what was in focus (the building you were looking at), tilted up towards its top
      let f = opts.facing, pitch = opts.pitch ?? 0.05;
      if (!f) {
        const lm = this._landmark || t;
        const to = new THREE.Vector3(lm.x - spot[0] - 0.5, 0, lm.z - spot[1] - 0.5), L = to.length();
        if (L > 4) {
          f = to;
          const top = this._landmark ? this._landmark.y : this.world.top(Math.floor(t.x), Math.floor(t.z)), eye = this.world.groundAt(spot[0], spot[1]) + EYE;
          pitch = THREE.MathUtils.clamp(Math.atan2(top - eye, L) * 0.6, 0.05, 0.5); // looking up at it, the street still in view
        } else f = this.camera.getWorldDirection(new THREE.Vector3());
      }
      this.yaw = Math.atan2(f.x, f.z);
      this.pitch = pitch;
      this.feet = this.world.groundAt(spot[0], spot[1]); this.vy = 0;
      this.walkPos = new THREE.Vector3(opts.exact ? t.x : spot[0] + 0.5, this.feet + EYE, opts.exact ? t.z : spot[1] + 0.5);
      if (opts.exact) this.feet = this.world.support(t.x, t.z, t.y + 1.5);
      else this.backOff(spot, f);
      this.goal = null;
      this.mode = 'walk';
      this.controls.enabled = false;
      if (prev === 'orbit') { this._fov0 = this.camera.fov; this._sky = { pos: c.clone(), target: this.controls.target.clone() }; }
      this._landing = { from: c.clone(), fromQ: this.camera.quaternion.clone(), fromFov: this.camera.fov, t0: performance.now(), ms: opts.ms ?? 900 };
      this.ride = null;
      this.dom.style.cursor = 'default';
    } else if (m === 'orbit') {
      this.mode = 'orbit';
      this.ride = null;
      this.controls.enabled = true;
      if (this._fov0) { this.camera.fov = this._fov0; this.camera.updateProjectionMatrix(); }
      this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
      this.retarget();
      this.dom.style.cursor = 'grab';
    }
    this.onMode?.(this.mode, this.ride);
  }

  // ---- ride along (possess an agent)
  startRide(ag) {
    const prev = this.mode;
    if (prev === 'orbit') { this._fov0 = this.camera.fov; this._sky = { pos: this.camera.position.clone(), target: this.controls.target.clone() }; }
    this.ride = { ...ag, view: this.ride?.kind === ag.kind ? this.ride.view : ag.kind === 'person' ? 'eyes' : 'behind', dyaw: 0, dpitch: 0, idle: 0,
      t0: performance.now(), from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), fromFov: this.camera.fov };
    this.mode = 'ride';
    if (this.life) this.life.keep = ag.obj;
    this.controls.enabled = false;
    this.goal = null; this.marker.visible = false;
    this.dom.style.cursor = 'default';
    this.onMode?.(this.mode, this.ride);
  }
  // the nearest person or vehicle in front of you at street level
  takeNearest() {
    if (!this.life) return;
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), P = this.walkPos;
    let best = null, bd = 25;
    for (const [kind, list] of [['person', this.life.people], ['car', this.life.cars], ['tram', this.life.trams]]) for (const o of list) {
      if (!o.rp) continue;
      const dx = o.rp.x - P.x, dz = o.rp.z - P.z, d = Math.hypot(dx, dz);
      if (d < bd && (dx * f.x + dz * f.z) / (d || 1) > 0.5) { bd = d; best = { kind, obj: o }; }
    }
    if (!best) { this.onNotice?.('Nobody close enough in front of you'); return; }
    best.label = best.kind === 'tram' ? (this.life.tramPaths[best.obj.p].ref ? `tram ${this.life.tramPaths[best.obj.p].ref}` : 'tram') : best.kind === 'car' ? (best.obj.bus ? 'bus' : 'car') : 'person';
    this.startRide(best);
  }
  toggleView() {
    if (!this.ride) return;
    const R = this.ride;
    R.view = R.view === 'eyes' ? 'behind' : 'eyes';
    Object.assign(R, { t0: performance.now(), from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), fromFov: this.camera.fov });
    this.onMode?.(this.mode, R);
  }
  nextRide() {
    if (!this.ride || !this.life) return;
    const pose = this.life.pose(this.ride.kind, this.ride.obj);
    const ag = pose && this.life.nearest(this.ride.kind, pose, this.ride.obj);
    if (ag) this.startRide(ag);
  }
  hopOff() {
    const R = this.ride, pose = R && this.life.pose(R.kind, R.obj);
    const f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const p = pose ? new THREE.Vector3(pose.x, pose.y, pose.z) : this.camera.position.clone();
    if (R && R.kind !== 'person') p.addScaledVector(new THREE.Vector3(Math.cos(pose?.h || 0), 0, -Math.sin(pose?.h || 0)), R.kind === 'tram' ? 2.6 : 2.0); // step out to the side
    this.ride = null;
    this.mode = 'ride-off';
    this.setMode('walk', { at: p, facing: f, pitch: 0.05, ms: 500, exact: R && R.kind === 'person' });
  }
  rideCam(R, pose) {
    const rig = RIG[R.kind], h = pose.h;
    const fw = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), rt = new THREE.Vector3(-fw.z, 0, fw.x);
    const base = new THREE.Vector3(pose.x, pose.y, pose.z);
    // drag offsets spring back to straight ahead a few seconds after you let go (vehicles turn under you)
    if (R.kind !== 'person' && performance.now() - R.idle > 5000) { R.dyaw *= 0.98; R.dpitch *= 0.98; }
    const yaw = h + R.dyaw, pitch = (R.view === 'eyes' ? -0.04 : -0.22) + R.dpitch;
    const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    let pos;
    if (R.view === 'eyes') {
      const bus = R.kind === 'car' && R.obj.bus, fz = bus ? R.obj.len / 2 + 0.25 : rig.eye[2], ey = bus ? 2.3 : rig.eye[1];
      pos = base.clone().addScaledVector(rt, -rig.eye[0]).addScaledVector(fw, fz).setY(base.y + ey);
    }
    else {
      pos = base.clone().addScaledVector(new THREE.Vector3(look.x, 0, look.z).normalize(), -rig.back); pos.y = base.y + rig.up;
      // keep the chase camera out of walls: pull in along the line to the agent if a building is in the way
      if (this.world) {
        const eye = base.clone().setY(base.y + 1.5), d = pos.clone().sub(eye), L = d.length();
        const t = this.world.raycast(eye, d.divideScalar(L), L);
        if (t < L) pos = eye.addScaledVector(d, Math.max(1.5, t - 0.8));
      }
    }
    return { pos, look, fov: R.view === 'eyes' ? rig.fov : 55 };
  }
  updateRide() {
    const R = this.ride, pose = this.life && this.life.pose(R.kind, R.obj);
    if (!pose) { // it left the map: hop on the nearest one of the same kind, else continue on foot
      const last = { x: this.camera.position.x, z: this.camera.position.z };
      const ag = this.life && this.life.nearest(R.kind, last, R.obj);
      this.onRideEnd?.(R, !!ag);
      if (ag) { const v = R.view; this.startRide(ag); this.ride.view = v; } else this.hopOff();
      return;
    }
    const cam = this.camera, { pos, look, fov } = this.rideCam(R, pose);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(look), new THREE.Vector3(0, 1, 0)));
    const t = Math.min(1, (performance.now() - R.t0) / 1100), e = t * t * (3 - 2 * t);
    if (t < 1) {
      cam.position.lerpVectors(R.from, pos, e);
      cam.quaternion.slerpQuaternions(R.fromQ, q, e);
      cam.fov = R.fromFov + (fov - R.fromFov) * e;
    } else {
      cam.position.copy(pos); cam.quaternion.copy(q);
      if (Math.abs(cam.fov - fov) > 0.01 && !R.zoomed) cam.fov += (fov - cam.fov) * 0.1;
    }
    cam.updateProjectionMatrix();
    this.controls.target.copy(cam.position).addScaledVector(look, 10);
  }

  // where to stand to see (x0, r0): on open street (long sightlines, open sky, never a courtyard), at a distance that
  // fits the landmark (its top in view: ~0.7x its height, 30-160 m), with a clear line of sight to its upper part.
  // If the focus is open ground, as close to that spot as possible.
  openSpot(x0, r0) {
    const w = this.world, o = new THREE.Vector3(), dir = new THREE.Vector3(), to = new THREE.Vector3();
    // the landmark = the tallest column near the focus (PKiN's tower, not the roof of a wing you happened to look at)
    let lx = Math.floor(x0), lr = Math.floor(r0), top = w.top(lx, lr);
    for (let dr = -30; dr <= 30; dr += 3) for (let dx = -30; dx <= 30; dx += 3) {
      const t = w.top(Math.floor(x0 + dx), Math.floor(r0 + dr));
      if (t > top) { top = t; lx = Math.floor(x0 + dx); lr = Math.floor(r0 + dr); }
    }
    const H = top - w.groundAt(lx, lr), building = H > 8;
    const ideal = THREE.MathUtils.clamp(H * 0.7, 30, 160);
    for (const R of building ? [ideal + 60, ideal + 140] : [40, 90]) {
      const st = R > 60 ? 4 : 2;
      let best = null, bs = -Infinity;
      for (let dr = -R; dr <= R; dr += st) for (let dx = -R; dx <= R; dx += st) {
        const x = Math.floor((building ? lx : x0) + dx), r = Math.floor((building ? lr : r0) + dr), d = Math.hypot(dx, dr);
        if (d > R || !w.inside(x, r)) continue;
        const g = w.groundAt(x, r);
        if (w.blocked(x, r, g, g + 40) || w.blocked(x + 1, r, g, g + 3) || w.blocked(x - 1, r, g, g + 3) || w.blocked(x, r + 1, g, g + 3) || w.blocked(x, r - 1, g, g + 3)) continue;
        o.set(x + 0.5, g + EYE, r + 0.5);
        let open = 0, long = 0;
        for (let k = 0; k < 8; k++) { dir.set(Math.cos(k * Math.PI / 4), 0, Math.sin(k * Math.PI / 4)); const t = w.raycast(o, dir, 70); open += Math.min(40, t); if (t >= 60) long++; }
        open /= 8;
        if (open < 12 || long < 2) continue; // a courtyard (however big) has no long view out; a street or a square does
        let sc;
        if (building) {
          // the upper part (2/3 up) must be in sight: nothing in the way well before we reach the landmark
          to.set(lx + 0.5 - o.x, g + H * 0.66 - o.y, lr + 0.5 - o.z); const U = to.length();
          const seen = w.raycast(o, to.divideScalar(U), U) >= U - Math.max(12, H * 0.15);
          dir.set(lx + 0.5 - o.x, 0, lr + 0.5 - o.z); const Dl = dir.length();
          const face = Math.min(Dl, w.raycast(o, dir.divideScalar(Dl || 1), Dl + 2)); // to the facade, not the roof's high point
          sc = open * 0.5 - Math.abs(face - ideal) * 0.35 - (face < 12 ? 30 : 0) - (seen ? 0 : 40);
        } else sc = open - d * 0.6;
        if (sc > bs) { bs = sc; best = [x, r]; }
      }
      if (best) { this._landmark = building ? new THREE.Vector3(lx + 0.5, top, lr + 0.5) : null; return best; }
    }
    this._landmark = null;
    return this.findStreet(x0, r0);
  }
  // if a wall is right in front of the new spot, step back (keeping the view) so there is something to see
  backOff(spot, f) {
    const w = this.world, h = new THREE.Vector3(f.x, 0, f.z).normalize(), P = this.walkPos;
    const ahead = (x, z) => w.raycast(new THREE.Vector3(x, this.feet + EYE, z), h, 60);
    let bx = P.x, bz = P.z, bt = ahead(P.x, P.z);
    for (let k = 1; k <= 14 && bt < 12; k++) {
      const x = P.x - h.x * k, z = P.z - h.z * k, g = w.groundAt(x, z);
      if (w.blocked(x, z, g, g + 3)) continue; // a lamp post or a bollard: look past it
      const t = ahead(x, z);
      if (t > bt) { bt = t; bx = x; bz = z; }
    }
    P.x = bx; P.z = bz; this.feet = w.groundAt(bx, bz); P.y = this.feet + EYE;
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
    if (this.mode === 'ride') {
      const tr = (K.has('tr') ? 1 : 0) - (K.has('tl') ? 1 : 0), tp = (K.has('tu') ? 1 : 0) - (K.has('td') ? 1 : 0);
      if (tr || tp) this.look(-tr * 1.6 * dt, tp * 1.0 * dt);
      if ((K.has('f') || K.has('b') || K.has('l') || K.has('r')) && performance.now() - (this._keyNote || 0) > 4000) {
        this._keyNote = performance.now(); this.onNotice?.('You’re riding along — Esc or “Hop off” to walk on your own');
      }
      return this.updateRide();
    }
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
    if (cam.position.y > gnd + 1800) { const k = gnd + 1800 - cam.position.y; cam.position.y += k; ctl.target.y += k; } // no flying off into the fog
  }

  // keep the orbit camera above the terrain (called after controls.update)
  clamp() {
    if (!this.world || this.mode !== 'orbit') return;
    const p = this.camera.position, g = this.world.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
    // zoomed right down onto the street: become a pedestrian there instead of staring at asphalt
    const t = this.controls.target, tg = this.world.groundAt(t.x, t.z);
    const close = p.y - g < 3 || (p.distanceTo(t) < this.controls.minDistance * 2.5 && t.y - tg < 3); // zoomed onto the street
    if (close && performance.now() - (this._zoomT || 0) < 700 && performance.now() - (this._landT || 0) > 1500) {
      this._landT = performance.now();
      const at = new THREE.Vector3(t.x, tg, t.z), f = this.dir().clone().setY(0);
      if (!this.world.blocked(at.x, at.z, tg, tg + 2)) this.setMode('walk', { at, exact: true, facing: f.lengthSq() > 1e-6 ? f : undefined, pitch: 0.1, ms: 500 });
    }
  }

  // one collision-checked horizontal step (wall sliding); true if we moved
  stepBy(m) {
    const w = this.world, P = this.walkPos;
    for (const s of [m, new THREE.Vector3(m.x, 0, 0), new THREE.Vector3(0, 0, m.z)]) {
      if (!s.lengthSq()) continue;
      const nx = P.x + s.x, nz = P.z + s.z;
      const ax = nx + Math.sign(s.x) * 0.3, az = nz + Math.sign(s.z) * 0.3; // body radius
      const sup = w.support(ax, az, this.feet + STEP);
      if (!w.blocked(ax, az, Math.max(sup, this.feet + STEP), sup + HEAD) && !w.blocked(nx, nz, Math.max(w.support(nx, nz, this.feet + STEP), this.feet + STEP), this.feet + HEAD)) {
        P.x = nx; P.z = nz;
        return true;
      }
    }
    return false;
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
      this.stepBy(m.normalize().multiplyScalar((this.shift ? 20 : 6) * this.speed * dt)); // brisk walk; Shift: sprint
    } else if (this.goal) {
      // click-to-walk: glide to the target, quicker for far targets; give up if a wall stops us
      const G = this.goal, d = new THREE.Vector3(G.x - P.x, 0, G.z - P.z), L = d.length();
      if (L < 0.15) { this.goal = null; this.marker.visible = false; }
      else {
        const v = Math.min(L * 2.2, Math.max(4, Math.min(22, L * 0.9))) * this.speed;
        const step = d.multiplyScalar(Math.min(L, v * dt) / L);
        let moved = this.stepBy(step);
        for (const a of [0.6, -0.6, 1.2, -1.2]) { if (moved) break; moved = this.stepBy(step.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a)); } // around a post
        if (!moved) { G.stuck = (G.stuck || 0) + dt; if (G.stuck > 0.4) { this.goal = null; this.marker.visible = false; } }
      }
    }
    // stand on whatever is under us (steps up kerbs and stairs, falls off ledges); Space jumps
    const sup = w.support(P.x, P.z, this.feet + STEP);
    if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy -= GRAV * dt; this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; }
    } else this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : sup;
    P.y = this.feet + EYE;
    const look = this.lookDir();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    if (this._landing) {
      const L = this._landing, t = Math.min(1, (performance.now() - L.t0) / L.ms), e = t * t * (3 - 2 * t);
      cam.position.lerpVectors(L.from, P, e);
      cam.quaternion.slerpQuaternions(L.fromQ, q, e);
      cam.fov = L.fromFov + (this.walkFov - L.fromFov) * e; // eye-level: a human field of view, not the diorama telephoto
      cam.updateProjectionMatrix();
      if (t >= 1) this._landing = null;
    } else {
      cam.position.copy(P);
      cam.quaternion.copy(q);
    }
    this.controls.target.copy(cam.position).addScaledVector(look, 10);
  }
}
