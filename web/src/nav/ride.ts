import * as THREE from 'three';
import type { Pose } from '../sim/types';
import type { World } from '../world';
import type { Ride } from './nav';

// where the camera sits: at the eyes (first person) or behind and above (chase)
const RIG = {
  person: { eye: [1.62, 0.2], back: 4.5, up: 2.2, fov: 65 },
  car: { eye: [1.3, 2.45], back: 9, up: 3.6, fov: 62 }, // dashcam just past the bonnet
  tram: { eye: [2.1, 5.4], back: 26, up: 9, fov: 60 }, // at the cab window
};

export function rideCamera(R: Ride, pose: Pose, world: World | null) {
  const rig = RIG[R.kind], h = pose.h;
  const fw = new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), base = new THREE.Vector3(pose.x, pose.y, pose.z);
  // looking around springs back to straight ahead a few seconds after letting go (vehicles turn under you)
  if (R.kind !== 'person' && performance.now() - R.idle > 5000) { R.dyaw *= 0.98; R.dpitch *= 0.98; }
  const yaw = h + R.dyaw, pitch = (R.view === 'eyes' ? -0.04 : -0.22) + R.dpitch;
  const look = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  if (R.view === 'eyes') {
    const bus = R.obj.kind === 'car' && R.obj.bus ? R.obj : null;
    const ahead = bus ? bus.len / 2 + 0.25 : rig.eye[1], up = bus ? 2.3 : rig.eye[0];
    return { pos: base.clone().addScaledVector(fw, ahead).setY(base.y + up), look, fov: rig.fov };
  }
  const pos = base.clone().addScaledVector(new THREE.Vector3(look.x, 0, look.z).normalize(), -rig.back);
  pos.y = base.y + rig.up;
  return { pos: world ? clearOf(world, base, pos, rig.up, R.kind === 'person' ? 1.5 : 4.5) : pos, look, fov: 55 };
}

// keep the chase camera clear: under a deck or a tree drop lower first, only then pull in towards the agent
function clearOf(world: World, base: THREE.Vector3, pos: THREE.Vector3, up: number, minDist: number) {
  const eye = base.clone().setY(base.y + 1.5);
  const clear = (p: THREE.Vector3) => { const d = p.clone().sub(eye), L = d.length(); return world.raycast(eye, d.divideScalar(L), L) >= L - 0.3; };
  if (clear(pos)) return pos;
  for (const f of [0.6, 0.35]) {
    const p = pos.clone().setY(base.y + Math.max(2.2, up * f));
    if (clear(p)) return p;
  }
  const d = pos.clone().sub(eye), L = d.length(), t = world.raycast(eye, d.divideScalar(L), L);
  return eye.addScaledVector(d, Math.max(minDist, t - 0.8));
}
