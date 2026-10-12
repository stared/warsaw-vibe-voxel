import * as THREE from 'three';

// Jets of the flat walk-on fountain on Złota: thin translucent water columns rising out of the paving,
// pulsing in waves across the 2 m nozzle grid (photos: Złota, Aug 2026).
export class Fountains {
  constructor(scene, jets) {
    this.jets = jets;
    const geo = new THREE.CylinderGeometry(0.07, 0.11, 1, 6, 1, true);
    geo.translate(0, 0.5, 0);
    this.mat = new THREE.MeshStandardMaterial({
      color: 0xe8f6fb, transparent: true, opacity: 0.7, roughness: 0.05, metalness: 0.1,
      emissive: new THREE.Color(0.6, 0.8, 1.0), emissiveIntensity: 0,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, jets.length);
    this.mesh.frustumCulled = false;
    this.m = new THREE.Matrix4();
    scene.add(this.mesh);
  }

  update(t, night) {
    this.mat.emissiveIntensity = night * 0.9;
    const s = new THREE.Vector3(), q = new THREE.Quaternion(), p = new THREE.Vector3();
    this.jets.forEach(([x, z, y], i) => {
      // a wave travelling along the fountain, plus per-jet jitter
      const phase = t * 1.8 - x * 0.35 - y * 0.2 + (i % 5) * 0.4;
      const h = Math.max(0.05, 0.4 + 1.8 * Math.max(0, Math.sin(phase)));
      p.set(x, z, y);
      s.set(1, h, 1);
      this.m.compose(p, q, s);
      this.mesh.setMatrixAt(i, this.m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
