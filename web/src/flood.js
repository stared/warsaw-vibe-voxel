import * as THREE from 'three';

// The Vistula's level (scripts/flood.py). The voxels hold the river as it was on the LiDAR day; a level above that is
// one sheet of water over every cell the river reaches (its spill height: an embankment keeps the land behind it dry until
// the water tops it), sloping as the river falls northwards; a level below it turns the shallows of the (estimated)
// bed into sandbanks in the voxel shader (uDrop).
export class Flood {
  constructor(scene, uniforms, meta) {
    this.scene = scene; this.U = uniforms; this.meta = meta;
    this.level = 0; // m above the LiDAR-day surface
  }

  async load() {
    const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    const [info, buf] = await Promise.all([fetch('data/flood.json').then((r) => r.json()),
      fetch('data/flood.bin').then((r) => r.arrayBuffer()).then(gunzip)]);
    const { W, D } = this.meta, n = W * D, a = new Uint8Array(buf), rg = new Uint8Array(n * 2);
    for (let i = 0; i < n; i++) { rg[2 * i] = a[i]; rg[2 * i + 1] = a[n + i]; }
    const tex = new THREE.DataTexture(rg, W, D, THREE.RGFormat);
    tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.needsUpdate = true;
    this.info = info;
    this.U.uFlood.value = tex;
    // the sheet: its height at row r is surface0 + fall * r - base + level (scene y), so two rows of vertices do
    const g = new THREE.PlaneGeometry(W, D, 1, 1).rotateX(-Math.PI / 2).translate(W / 2, 0, D / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setY(i, info.surface0 + info.fall * p.getZ(i) - info.base);
    this.uLevel = { value: 0 };
    const mat = new THREE.MeshStandardMaterial({ color: 0x0b4a5c, roughness: 0.08, metalness: 0.3, transparent: true, opacity: 0.9 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, { uFlood: this.U.uFlood, uLevel: this.uLevel, uTime: this.U.uTime, uHorizon: this.U.uHorizon });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uLevel; varying vec3 vW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed.y += uLevel; vW = transformed;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uFlood; uniform float uTime; uniform vec3 uHorizon; varying vec3 vW;')
        .replace('#include <color_fragment>', `#include <color_fragment>
          ivec2 c = ivec2(floor(vW.xz));
          float spill = texelFetch(uFlood, c, 0).r * 255.0;
          if (spill >= vW.y) discard; // the river doesn't reach this cell at this level
          vec2 cl = floor(vW.xz);
          float r = sin(cl.x * 0.9 + uTime * 1.3) * sin(cl.y * 1.1 - uTime) * 0.5 + 0.5;
          // flood water carries silt: browner over the land the river doesn't usually cover
          float land = step(4.5, spill);
          diffuseColor.rgb = mix(mix(vec3(0.012, 0.085, 0.15), vec3(0.03, 0.2, 0.26), r * r), vec3(0.16, 0.13, 0.07), land * 0.3);
          vec3 V = normalize(cameraPosition - vW);
          diffuseColor.rgb = mix(diffuseColor.rgb, uHorizon * 0.8, clamp(0.08 + 0.55 * pow(1.0 - max(V.y, 0.0), 4.0), 0.0, 0.55));`);
    };
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    this.scene.add(this.mesh);
    this.set(this.level);
  }

  // level in m relative to the LiDAR-day surface (negative: drought)
  set(level) {
    this.level = level;
    if (!this.mesh) return;
    this.uLevel.value = level;
    this.mesh.visible = level > 0.02;
    this.U.uDrop.value = Math.max(0, -level);
  }
}
