import * as THREE from 'three';

// steel cables (Most Świętokrzyski's stays): thin cylinders between their two ends, too thin for the 1 m voxels
export function addCables(scene: THREE.Scene, cables: number[][]) {
  if (!cables.length) return;
  const mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0xd4d8db, roughness: 0.45, metalness: 0.5 }), cables.length);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion(), m = new THREE.Matrix4(), s = new THREE.Vector3();
  cables.forEach(([x0, y0, z0, x1, y1, z1, r], i) => {
    a.set(x0, y0, z0); b.set(x1, y1, z1);
    const d = b.clone().sub(a), len = d.length();
    q.setFromUnitVectors(up, d.normalize());
    m.compose(a.clone().add(b).multiplyScalar(0.5), q, s.set(r, len, r));
    mesh.setMatrixAt(i, m);
  });
  mesh.castShadow = true;
  scene.add(mesh);
}
