import * as THREE from 'three';

// the walk-on fountain on Złota: thin water columns out of the paving, pulsing in waves across the nozzle grid
export class Fountains {
  private readonly mesh: THREE.InstancedMesh;
  private readonly mat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene, private readonly jets: [number, number, number][]) {
    const geo = new THREE.CylinderGeometry(0.07, 0.11, 1, 6, 1, true).translate(0, 0.5, 0);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xe8f6fb, transparent: true, opacity: 0.7, roughness: 0.05, metalness: 0.1,
      emissive: new THREE.Color(0.6, 0.8, 1.0), emissiveIntensity: 0 });
    this.mesh = new THREE.InstancedMesh(geo, this.mat, jets.length);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(t: number, night: number) {
    this.mat.emissiveIntensity = night * 0.9;
    const m = new THREE.Matrix4(), s = new THREE.Vector3(), q = new THREE.Quaternion(), p = new THREE.Vector3();
    this.jets.forEach(([x, z, y], i) => {
      const phase = t * 1.8 - x * 0.35 - y * 0.2 + (i % 5) * 0.4;
      m.compose(p.set(x, z, y), q, s.set(1, Math.max(0.05, 0.4 + 1.8 * Math.max(0, Math.sin(phase))), 1));
      this.mesh.setMatrixAt(i, m);
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
