import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Picked, StreetLife } from '../sim/life';
import type { Pose } from '../sim/types';
import type { TileStreamer } from '../stream';
import type { View } from '../types';
import { clamp, coarsePointer, ease } from '../util';
import type { World } from '../world';
import { rideCamera } from './ride';
import { backOff, EYE, findStreet, openSpot, walkNet } from './spots';

// Three modes, one set of keys as in games (W/S forward and back, A/D turn, Q/E nose up and down, Shift faster;
// arrows alike) and one gesture language for mouse, trackpad and touch:
//   orbit: drag moves the map, right-drag turns and tilts, wheel zooms at the cursor, double-click flies there
//   walk:  drag looks, click walks there, wheel steps, Space jumps, Esc flies up
//   ride:  following a pedestrian, car or tram; move keys walk as that person, or get out of a vehicle
export type Mode = 'orbit' | 'walk' | 'ride';
export interface Ride extends Picked {
  view: 'eyes' | 'behind';
  dyaw: number;
  dpitch: number;
  idle: number;
}
interface WalkOpts { at?: THREE.Vector3; exact?: boolean; facing?: THREE.Vector3; pitch?: number; ms?: number; deckOK?: boolean }
interface Transition { from: THREE.Vector3; fromQ: THREE.Quaternion; fromFov: number; t0: number; ms: number }

type Action = 'f' | 'b' | 'tl' | 'tr' | 'tu' | 'td';
const KEYMAP: Record<string, Action> = {
  KeyW: 'f', KeyS: 'b', KeyA: 'tl', KeyD: 'tr', KeyQ: 'tu', KeyE: 'td',
  ArrowUp: 'f', ArrowDown: 'b', ArrowLeft: 'tl', ArrowRight: 'tr',
};
const STEP = 1.05, HEAD = 1.9, GRAV = 16, TILT = Math.PI * 0.48, WALK_FOV = 65;

export class Nav {
  mode: Mode = 'orbit';
  ride: Ride | null = null;
  world: World | null = null;
  streamer: TileStreamer | null = null;
  cancelFly: () => void = () => {};
  private lifeRef: StreetLife | null = null;
  private net: ReturnType<typeof walkNet> | null = null;
  private readonly keys = new Set<Action>();
  private shift = false;
  private turned = false;
  private yaw = 0;
  private pitch = 0;
  private feet = 0;
  private vy = 0;
  private walkPos = new THREE.Vector3();
  private goal: { x: number; z: number; stuck: number } | null = null;
  private landing: Transition | null = null;
  private landmark: THREE.Vector3 | null = null;
  private skyView: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  private orbitFov = 0;
  private possessed: unknown = null;
  private jumpAsked = false;
  private walkPending = false;
  private zoomT = 0;
  private landT = 0;
  private hoverT = 0;
  private quietT = 0;
  private wheelBack = 0;
  private wheelBackT = 0;
  private readonly marker: THREE.Mesh;

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly controls: OrbitControls, private readonly dom: HTMLElement,
    scene: THREE.Scene, private readonly flyTo: (v: Pick<View, 'pos' | 'target'>) => void, private readonly onMode: (m: Mode, r: Ride | null) => void) {
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
    controls.maxPolarAngle = TILT;
    dom.style.cursor = 'grab';
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthTest: false }));
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    scene.add(this.marker);
    this.bindKeys();
    this.bindPointer();
  }

  get life() { return this.lifeRef; }
  set life(l: StreetLife | null) { this.lifeRef = l; this.net = null; }
  // turning in place with the keys: the focus is off on its own, put back on release
  get turning() { return this.turned; }

  // ------------------------------------------------------------------ input
  private axis(pos: Action, neg: Action) { return (this.keys.has(pos) ? 1 : 0) - (this.keys.has(neg) ? 1 : 0); }

  private bindKeys() {
    addEventListener('keydown', (e) => {
      if ((e.target as Element).closest?.('input:not([type=range]), textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
      this.shift = e.shiftKey;
      if (e.code === 'Escape') { if (this.mode !== 'orbit') this.flyUp(); return; }
      if (e.code === 'Space' && (this.mode === 'walk' || this.ride?.kind === 'person')) { // following someone: become them, then jump
        if (this.mode === 'walk') { if (this.vy === 0) this.vy = 5.2; } else this.jumpAsked = true;
        e.preventDefault(); return;
      }
      const k = KEYMAP[e.code];
      if (!k) return;
      this.keys.add(k);
      if (this.ride && this.ride.kind !== 'person') this.hopOff();
      this.goal = null;
      this.cancelFly();
      e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.shift = e.shiftKey;
      const k = KEYMAP[e.code];
      if (k) this.keys.delete(k);
      if (this.turned && ![...this.keys].some((a) => a[0] === 't')) { this.turned = false; this.retarget(); }
    });
    addEventListener('blur', () => this.keys.clear());
  }

  private bindPointer() {
    const dom = this.dom, ptrs = new Map<number, { x: number; y: number }>();
    let press: { x: number; y: number; t: number; button: number; moved: boolean } | null = null;
    let pinch0: { d: number; fov: number } | null = null, twist: number | null = null;
    const two = () => [...ptrs.values()];
    dom.addEventListener('pointerdown', (e) => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.mode === 'orbit' && (e.button === 2 || (e.button === 0 && (e.shiftKey || e.ctrlKey || e.metaKey)) || ptrs.size === 2)) this.pivotAt(e.clientX, e.clientY);
      if (ptrs.size === 2) { const [a, b] = two(); twist = Math.atan2(b.y - a.y, b.x - a.x); }
      press = ptrs.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button, moved: false } : null;
      if (ptrs.size === 2 && this.mode !== 'orbit') { const [a, b] = two(); pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: this.camera.fov }; }
      if (this.mode !== 'orbit') dom.setPointerCapture(e.pointerId);
      else dom.style.cursor = 'grabbing';
      this.cancelFly();
    });
    dom.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) { this.hover(e.clientX, e.clientY, e.pointerType); return; }
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.moved = true;
      if (this.mode === 'orbit') {
        if (ptrs.size === 2 && twist !== null) { // two-finger twist turns the map
          this.zoomT = performance.now();
          const [a, b] = two(), ang = Math.atan2(b.y - a.y, b.x - a.x);
          this.orbitBy(Math.atan2(Math.sin(ang - twist), Math.cos(ang - twist)));
          twist = ang;
        }
        return;
      }
      if (ptrs.size === 2 && pinch0) { const [a, b] = two(); this.setFov(pinch0.fov * pinch0.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y))); return; }
      if (press && !press.moved) return;
      const k = (e.pointerType === 'touch' ? 2.4 : 1.2) * (this.camera.fov * Math.PI / 180) / innerHeight;
      this.look(dx * k, dy * k * 0.7);
      this.marker.visible = false;
    });
    const up = (e: PointerEvent) => {
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) { pinch0 = null; twist = null; }
      this.quietT = performance.now();
      if (this.mode === 'orbit') dom.style.cursor = 'grab';
      if (press && !press.moved && e.type === 'pointerup' && performance.now() - press.t < 600 && press.button === 0) this.tap(e.clientX, e.clientY);
      if (!ptrs.size) press = null;
    };
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('pointerleave', () => { this.marker.visible = false; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    dom.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    dom.addEventListener('dblclick', (e) => this.diveTo(e.clientX, e.clientY));
  }

  // rotating pivots on the axis of view at the depth of what is under the cursor, so nothing jumps
  private pivotAt(cx: number, cy: number) {
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const v = this.camera.getWorldDirection(new THREE.Vector3()), dd = hit.p.clone().sub(this.camera.position).dot(v);
    if (dd > 5 && dd < 2500) this.controls.target.copy(this.camera.position).addScaledVector(v, dd);
  }

  private wheel(e: WheelEvent) {
    if (this.mode === 'orbit') { this.zoomT = performance.now(); return; }
    e.preventDefault();
    if (e.ctrlKey || this.mode === 'ride') { this.setFov(this.camera.fov * Math.exp(e.deltaY * 0.004)); return; }
    if (e.deltaY > 0) { // keep scrolling back and you rise to the bird's-eye view
      const now = performance.now();
      this.wheelBack = (now - this.wheelBackT < 600 ? this.wheelBack : 0) + e.deltaY;
      this.wheelBackT = now;
      if (this.wheelBack > 900) { this.wheelBack = 0; this.flyUp(); return; }
    }
    const from = this.goal ? new THREE.Vector3(this.goal.x, 0, this.goal.z) : this.walkPos.clone();
    from.addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), -Math.sign(e.deltaY) * Math.min(4, Math.abs(e.deltaY) / 30));
    this.goal = { x: from.x, z: from.z, stuck: 0 };
  }

  private diveTo(cx: number, cy: number) {
    if (this.mode !== 'orbit' || !this.world) return;
    const hit = this.hitAt(cx, cy);
    if (!hit) return;
    const cam = this.camera.position, dist = cam.distanceTo(hit.p);
    const pos = hit.p.clone().addScaledVector(hit.dir, -Math.max(25, dist * 0.4));
    pos.y = Math.max(pos.y, this.world.groundAt(pos.x, pos.z) + 2);
    this.flyTo({ pos: pos.toArray(), target: hit.p.toArray() });
  }

  private hitAt(cx: number, cy: number, maxDist = 4000) {
    if (!this.world) return null;
    const r = new THREE.Raycaster();
    r.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), this.camera);
    const t = this.world.raycast(r.ray.origin, r.ray.direction, maxDist);
    if (!isFinite(t)) return null;
    return { p: r.ray.origin.clone().addScaledVector(r.ray.direction, t), axis: this.world.hitAxis, dir: r.ray.direction };
  }

  private pickAgent(cx: number, cy: number, px: number, minPx: number) {
    const life = this.life, world = this.world;
    if (!life?.group.visible || !world) return null;
    return life.pick(this.camera, cx, cy, px, minPx, (to) => { const L = to.length(); return world.raycast(this.camera.position, to.divideScalar(L), L) >= L - 2.5; }, this.ride?.obj ?? null);
  }

  // what a click would do here: a hand over people and vehicles, a ring on the street where you would walk
  private hover(cx: number, cy: number, type: string) {
    const now = performance.now();
    if (type === 'touch' || now - this.hoverT < 60 || now - this.quietT < 350) return;
    this.hoverT = now;
    const air = this.mode === 'orbit', ag = this.pickAgent(cx, cy, air ? 14 : 3, air ? 7 : 0);
    this.dom.style.cursor = ag ? 'pointer' : air ? 'grab' : 'default';
    const g = this.mode === 'walk' && !ag ? this.walkTarget(cx, cy) : null;
    this.marker.visible = !!g;
    if (g) this.marker.position.set(g.x, g.y + 0.06, g.z);
  }

  // where a click at street level walks to: that spot, or the foot of the wall clicked
  private walkTarget(cx: number, cy: number) {
    const hit = this.hitAt(cx, cy, 250);
    if (!hit || !this.world) return null;
    const p = hit.p.clone();
    if (hit.axis !== 1 || hit.p.y > this.feet + 3) p.addScaledVector(new THREE.Vector3(hit.dir.x, 0, hit.dir.z).normalize(), -0.8);
    p.y = this.world.support(p.x, p.z, this.feet + 3);
    return p;
  }

  // a person or vehicle under the click is followed (generous from the air, tight on the street); else walk there
  private tap(cx: number, cy: number) {
    const coarse = coarsePointer(), air = this.mode === 'orbit';
    const ag = this.pickAgent(cx, cy, air ? (coarse ? 26 : 16) : coarse ? 24 : 12, air ? 5 : 0);
    if (ag) { this.startRide(ag); return; }
    if (this.mode === 'ride') { this.hopOff(); return; }
    if (this.mode !== 'walk') return;
    const g = this.walkTarget(cx, cy);
    if (!g) return;
    this.goal = { x: g.x, z: g.z, stuck: 0 };
    this.marker.position.set(g.x, g.y + 0.06, g.z);
    this.marker.visible = true;
  }

  // ------------------------------------------------------------------ the view
  private dir() { return new THREE.Vector3().subVectors(this.controls.target, this.camera.position); }

  private setFov(f: number) { this.camera.fov = clamp(f, 20, 80); this.camera.updateProjectionMatrix(); }

  // the nose moves, the camera stays (A/D, Q/E). Above level too: OrbitControls' tilt limit follows the keys, so it
  // never swings the camera to get the focus back below it; clamp() restores it once you look down again.
  private turnInPlace(dyaw: number, dpitch: number) {
    const d = this.dir(), len = d.length() || 1;
    const yaw = Math.atan2(d.x, d.z) + dyaw, pitch = clamp(Math.asin(clamp(d.y / len, -1, 1)) + dpitch, -1.5, 1.2);
    this.controls.maxPolarAngle = Math.max(TILT, Math.PI / 2 + pitch + 0.02);
    const c = this.camera.position;
    this.controls.target.set(c.x + len * Math.sin(yaw) * Math.cos(pitch), c.y + len * Math.sin(pitch), c.z + len * Math.cos(yaw) * Math.cos(pitch));
  }

  private orbitBy(dyaw: number) {
    const t = this.controls.target, off = this.camera.position.clone().sub(t), s = new THREE.Spherical().setFromVector3(off);
    s.theta += dyaw;
    s.phi = clamp(s.phi, 0.05, this.controls.maxPolarAngle);
    this.camera.position.copy(t).add(off.setFromSpherical(s));
  }

  // the focus goes onto what is in the middle of the screen (kept on the map), so turning pivots on it
  private retarget() {
    const w = this.world;
    if (!w || this.mode !== 'orbit') return;
    const c = this.camera.position, d = this.dir().normalize(), t = w.raycast(c, d, 3000);
    let len = isFinite(t) ? Math.max(5, t) : Math.min(this.dir().length(), 800);
    const onMap = (L: number) => { const x = c.x + d.x * L, z = c.z + d.z * L; return w.inside(x - 61, z - 61) && w.inside(x + 61, z + 61); };
    while (len > 5 && !onMap(len)) len *= 0.85;
    this.controls.target.copy(c).addScaledVector(d, len);
  }

  private look(dyaw: number, dpitch: number) {
    if (this.mode === 'walk') { this.yaw += dyaw; this.pitch = clamp(this.pitch + dpitch, -1.4, 1.45); }
    else if (this.ride) { const R = this.ride; R.dyaw += dyaw; R.dpitch = clamp(R.dpitch + dpitch, -1.2, 1.2); R.idle = performance.now(); }
  }

  private rememberSky() {
    if (this.mode !== 'orbit') return;
    this.orbitFov = this.camera.fov;
    this.skyView = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
  }

  private transition(ms: number): Transition {
    return { from: this.camera.position.clone(), fromQ: this.camera.quaternion.clone(), fromFov: this.camera.fov, t0: performance.now(), ms };
  }

  // ------------------------------------------------------------------ modes
  // back up to a bird's-eye view: the one you came down from, or one over where you look
  flyUp() {
    const from = this.camera.position.clone(), f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const S = this.skyView;
    this.setOrbit();
    if (S && Math.hypot(S.target.x - from.x, S.target.z - from.z) < 120) { this.flyTo({ pos: S.pos.toArray(), target: S.target.toArray() }); return; }
    const tgt = from.clone().addScaledVector(f, 60);
    tgt.y = this.world ? this.world.groundAt(tgt.x, tgt.z) + 5 : from.y;
    const pos = tgt.clone().addScaledVector(f, -380);
    pos.y = tgt.y + 330;
    this.flyTo({ pos: pos.toArray(), target: tgt.toArray() });
  }

  setOrbit() {
    if (this.mode === 'orbit') return;
    this.mode = 'orbit';
    this.ride = null;
    this.marker.visible = false;
    if (this.life) this.life.keep = null;
    this.controls.enabled = true;
    if (this.orbitFov) this.setFov(this.orbitFov);
    this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(30));
    this.retarget();
    this.dom.style.cursor = 'grab';
    this.onMode(this.mode, null);
  }

  // down to street level at (or facing) a spot; waits for the full-detail tiles there
  async setWalk(opts: WalkOpts = {}) {
    const w = this.world;
    if (!w || this.walkPending) return;
    const t = opts.at ?? this.controls.target;
    if (this.streamer) {
      this.walkPending = true;
      await this.streamer.ensure(t.x, t.z, 200).finally(() => { this.walkPending = false; });
    }
    if (!opts.exact && opts.deckOK) { const deck = w.deckAt(t.x, t.z); if (deck != null) opts = { ...opts, exact: true, at: new THREE.Vector3(t.x, deck, t.z) }; }
    let spot: [number, number] | null;
    this.landmark = null;
    if (opts.exact) spot = [Math.floor(t.x), Math.floor(t.z)];
    else {
      if (this.life && !this.net) this.net = walkNet(w, this.life.peds);
      const s = openSpot(w, this.net, t.x, t.z);
      this.landmark = s?.landmark ?? null;
      spot = s?.at ?? findStreet(w, this.camera.position.x, this.camera.position.z);
    }
    if (!spot) return;
    let f = opts.facing, pitch = opts.pitch ?? 0.05;
    if (!f) { // face what was in focus, tilted up towards its top
      const lm = this.landmark ?? t, to = new THREE.Vector3(lm.x - spot[0] - 0.5, 0, lm.z - spot[1] - 0.5), L = to.length();
      if (L > 4) {
        f = to;
        const top = this.landmark ? this.landmark.y : w.top(Math.floor(t.x), Math.floor(t.z)), eye = w.groundAt(spot[0], spot[1]) + EYE;
        pitch = clamp(Math.atan2(top - eye, L) * 0.6, 0.05, 0.5);
      } else f = this.camera.getWorldDirection(new THREE.Vector3());
    }
    this.rememberSky();
    this.yaw = Math.atan2(f.x, f.z);
    this.pitch = pitch;
    this.vy = 0;
    if (opts.exact) {
      this.walkPos.set(t.x, 0, t.z);
      this.feet = w.support(t.x, t.z, t.y + 1.5);
    } else {
      this.feet = w.groundAt(spot[0], spot[1]);
      const b = backOff(w, this.walkPos.set(spot[0] + 0.5, 0, spot[1] + 0.5), this.feet, f);
      this.walkPos.set(b.x, 0, b.z);
      this.feet = b.feet;
    }
    this.walkPos.y = this.feet + EYE;
    this.goal = null;
    this.marker.visible = false;
    if (this.life) this.life.keep = null;
    this.landing = this.transition(opts.ms ?? 900);
    this.mode = 'walk';
    this.ride = null;
    this.controls.enabled = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, null);
  }

  startRide(ag: Picked) {
    this.rememberSky();
    this.ride = { ...ag, view: 'behind', dyaw: 0, dpitch: 0, idle: 0 };
    this.landing = this.transition(1100);
    this.mode = 'ride';
    if (this.life) this.life.keep = ag.obj;
    this.controls.enabled = false;
    this.goal = null;
    this.marker.visible = false;
    this.dom.style.cursor = 'default';
    this.onMode(this.mode, this.ride);
  }

  // out of the vehicle (a step to its side) or off the person, onto the street
  private hopOff() {
    const R = this.ride, pose = R && this.life?.pose(R.kind, R.obj);
    const f = this.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const p = pose ? new THREE.Vector3(pose.x, pose.y, pose.z) : this.camera.position.clone();
    if (R && pose && R.kind !== 'person') p.addScaledVector(new THREE.Vector3(Math.cos(pose.h), 0, -Math.sin(pose.h)), R.kind === 'tram' ? 2.6 : 2.0);
    this.setWalk({ at: p, facing: f, pitch: 0.05, ms: 500, exact: R?.kind === 'person' });
  }

  // ------------------------------------------------------------------ every frame
  update(dt: number) {
    dt = Math.min(dt, 0.1);
    if (this.mode === 'walk') this.updateWalk(dt);
    else if (this.mode === 'ride') this.updateRide(dt);
    else this.updateOrbit(dt);
  }

  // A/D/Q/E turn in place; W/S fly along the view, faster higher up; reaching the street lands you on it
  private updateOrbit(dt: number) {
    const tr = this.axis('tr', 'tl'), tp = this.axis('tu', 'td');
    if (tr || tp) { this.turnInPlace(-tr * (this.shift ? 2.4 : 1.2) * dt, tp * 0.8 * dt); this.turned = true; }
    const go = this.axis('f', 'b'), w = this.world;
    if (!go || !w) return;
    const cam = this.camera.position, len0 = this.dir().length(), look = this.dir().normalize();
    const h = Math.max(3, cam.y - w.groundAt(cam.x, cam.z));
    let step = go * (this.shift ? 3 : 1) * Math.min(400, 8 + h * 0.9) * dt;
    const ahead = w.raycast(cam, look, 4000);
    if (go > 0 && ahead < 8) { this.setWalk(); return; }
    if (go > 0) step = Math.min(step, ahead - 6);
    if (step * look.y > 0 && h + step * look.y > 3600) return;
    cam.addScaledVector(look, step);
    this.controls.target.copy(cam).addScaledVector(look, isFinite(ahead) ? Math.max(5, ahead - step) : len0);
    this.zoomT = performance.now();
  }

  // after OrbitControls: above the ground, the tilt limit back once you look down, and zoomed onto the street: land
  clamp() {
    const w = this.world;
    if (!w || this.mode !== 'orbit') return;
    if (this.controls.maxPolarAngle > TILT && !this.turned && this.controls.getPolarAngle() <= TILT) this.controls.maxPolarAngle = TILT;
    const p = this.camera.position, g = w.groundAt(p.x, p.z) + 1.2;
    if (p.y < g) { p.y = g; this.camera.lookAt(this.controls.target); }
    const t = this.controls.target, tg = w.groundAt(t.x, t.z);
    const close = p.y - g < 3 || (p.distanceTo(t) < this.controls.minDistance * 2.5 && t.y - tg < 3);
    const now = performance.now();
    if (close && now - this.zoomT < 700 && now - this.landT > 1500) {
      this.landT = now;
      const at = new THREE.Vector3(t.x, tg, t.z), f = this.dir().setY(0);
      if (!w.blocked(at.x, at.z, tg, tg + 2)) this.setWalk({ at, exact: true, facing: f.lengthSq() > 1e-6 ? f : undefined, pitch: 0.1, ms: 500 });
    }
  }

  // one collision-checked horizontal step, sliding along walls; true if it moved
  private stepBy(m: THREE.Vector3) {
    const w = this.world!, P = this.walkPos, feet = this.feet;
    const clear = (x: number, z: number, from: number) => !w.blocked(x, z, Math.max(w.support(x, z, feet + STEP), feet + STEP), from);
    for (const s of [m, new THREE.Vector3(m.x, 0, 0), new THREE.Vector3(0, 0, m.z)]) {
      if (!s.lengthSq()) continue;
      const nx = P.x + s.x, nz = P.z + s.z, ax = nx + Math.sign(s.x) * 0.3, az = nz + Math.sign(s.z) * 0.3;
      const sup = w.support(ax, az, feet + STEP);
      if (!w.blocked(ax, az, Math.max(sup, feet + STEP), sup + HEAD) && clear(nx, nz, feet + HEAD)
        && clear(nx + 0.4, nz, feet + HEAD) && clear(nx - 0.4, nz, feet + HEAD) && clear(nx, nz + 0.4, feet + HEAD) && clear(nx, nz - 0.4, feet + HEAD)) {
        P.x = nx; P.z = nz;
        return true;
      }
    }
    return false;
  }

  // on whatever is underfoot: up kerbs and stairs, off ledges, jumps
  private stand(dt: number) {
    const P = this.walkPos, sup = this.world!.support(P.x, P.z, this.feet + STEP);
    if (this.vy !== 0 || this.feet > sup + 0.01) {
      this.vy -= GRAV * dt;
      this.feet += this.vy * dt;
      if (this.feet <= sup) { this.feet = sup; this.vy = 0; }
    } else this.feet = sup > this.feet ? Math.min(sup, this.feet + 6 * dt) : sup;
    P.y = this.feet + EYE;
  }

  private updateWalk(dt: number) {
    const tr = this.axis('tr', 'tl'), tp = this.axis('tu', 'td'), go = this.axis('f', 'b');
    if (tr || tp) this.look(-tr * (this.shift ? 2.6 : 1.8) * dt, tp * dt);
    if (go) this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (this.shift ? 20 : 6) * dt));
    else if (this.goal) this.walkToGoal(dt);
    this.stand(dt);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw + Math.PI, 0, 'YXZ'));
    this.place(this.walkPos, q, WALK_FOV, false);
    const look = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  // click-to-walk: glide there, faster for far goals, around a post; give up when a wall stops us
  private walkToGoal(dt: number) {
    const G = this.goal!, P = this.walkPos, d = new THREE.Vector3(G.x - P.x, 0, G.z - P.z), L = d.length();
    if (L < 0.15) { this.goal = null; this.marker.visible = false; return; }
    const step = d.multiplyScalar(Math.min(L, Math.min(L * 2.2, Math.max(4, Math.min(22, L * 0.9))) * dt) / L), up = new THREE.Vector3(0, 1, 0);
    if ([0, 0.6, -0.6, 1.2, -1.2].some((a) => this.stepBy(step.clone().applyAxisAngle(up, a)))) return;
    G.stuck += dt;
    if (G.stuck > 0.4) { this.goal = null; this.marker.visible = false; }
  }

  // the camera to (pos, q, fov), gliding there over the landing transition; settle: then ease back to fov
  private place(pos: THREE.Vector3, q: THREE.Quaternion, fov: number, settle: boolean) {
    const cam = this.camera, L = this.landing;
    if (L) {
      const t = Math.min(1, (performance.now() - L.t0) / L.ms), e = ease(t);
      cam.position.lerpVectors(L.from, pos, e);
      cam.quaternion.slerpQuaternions(L.fromQ, q, e);
      cam.fov = L.fromFov + (fov - L.fromFov) * e;
      if (t >= 1) this.landing = null;
    } else {
      cam.position.copy(pos);
      cam.quaternion.copy(q);
      if (settle && Math.abs(cam.fov - fov) > 0.01) cam.fov += (fov - cam.fov) * 0.1;
    }
    cam.updateProjectionMatrix();
  }

  private updateRide(dt: number) {
    const R = this.ride!, life = this.life;
    if (R.kind === 'person' && (this.keys.size || this.jumpAsked || this.possessed === R.obj)) this.possess(dt);
    const pose = life?.pose(R.kind, R.obj);
    if (!pose) { // it left the map: the nearest one of the same kind, else on foot
      const next = life?.nearest(R.kind, { x: this.camera.position.x, z: this.camera.position.z }, R.obj);
      if (next) { const view = R.view; this.startRide(next); this.ride!.view = view; } else this.hopOff();
      return;
    }
    const { pos, look, fov } = rideCamera(R, pose, this.world);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(pos, pos.clone().add(look), new THREE.Vector3(0, 1, 0)));
    this.place(pos, q, fov, true);
    this.controls.target.copy(this.camera.position).addScaledVector(look, 10);
  }

  // walking as the person followed: W/S walk, A/D turn them, Q/E look, through their eyes; they stay where left
  private possess(dt: number) {
    const R = this.ride!, o = R.obj, life = this.life;
    if (o.kind !== 'person' || !life) return;
    if (this.possessed !== o) {
      const p: Pose | null = life.pose('person', o);
      if (!p) return;
      this.possessed = o;
      o.ctl = { x: p.x, y: p.y, z: p.z, h: p.h, moving: false };
      Object.assign(R, { label: 'you', view: 'eyes', dyaw: 0, dpitch: 0 });
      this.landing = this.transition(1100);
      this.onMode(this.mode, R);
      this.walkPos.set(p.x, p.y + EYE, p.z);
      this.feet = p.y; this.vy = 0; this.yaw = p.h;
    }
    if (this.jumpAsked) { if (this.vy === 0) this.vy = 5.2; this.jumpAsked = false; }
    const C = o.ctl!, P = this.walkPos, tp = this.axis('tu', 'td'), go = this.axis('f', 'b');
    this.yaw -= this.axis('tr', 'tl') * (this.shift ? 2.6 : 1.8) * dt;
    if (tp) R.dpitch = clamp(R.dpitch + tp * dt, -1.2, 1.2);
    this.yaw += R.dyaw;
    R.dyaw = 0;
    C.moving = !!go && this.stepBy(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(go * (this.shift ? 7 : 2.2) * dt));
    this.stand(dt);
    Object.assign(C, { x: P.x, y: this.feet, z: P.z, h: this.yaw });
  }
}
