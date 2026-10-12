import * as THREE from 'three';

// material ids (must match scripts/voxelize.py)
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, PKIN: 7, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11, ROOF: 12, CONCRETE: 13, CLOCK: 14 };

export function makePaletteTexture(palette) {
  const n = palette.length;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < n; i++) {
    const [r, g, b, m] = palette[i];
    data.set([r, g, b, m], i * 4);
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

export function makeVoxelMaterial({ paletteTex, groundTex, lampTex, W, D }) {
  const uniforms = {
    uPalette: { value: paletteTex },
    uGround: { value: groundTex },
    uLampMap: { value: lampTex },
    uSize: { value: new THREE.Vector2(W, D) },
    uNight: { value: 0 },
    uTime: { value: 0 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 vattr;
        attribute float vpal;
        varying vec3 vVox;
        varying vec3 vN;
        varying float vAO;
        flat varying int vPal;
        vec3 normalFromIdx(float i){
          // data axes: 0=x(east),1=y(south),2=z(up) -> three: x, z, y
          if (i < 0.5) return vec3(-1.,0.,0.);
          if (i < 1.5) return vec3(1.,0.,0.);
          if (i < 2.5) return vec3(0.,0.,-1.);
          if (i < 3.5) return vec3(0.,0.,1.);
          if (i < 4.5) return vec3(0.,-1.,0.);
          return vec3(0.,1.,0.);
        }`)
      .replace('#include <beginnormal_vertex>', `vec3 objectNormal = normalFromIdx(vattr.x);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vVox = position; vN = objectNormal; vAO = vattr.y / 3.0; vPal = int(vpal + 0.5);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; uniform sampler2D uGround; uniform sampler2D uLampMap;
        uniform vec2 uSize; uniform float uNight; uniform float uTime;
        varying vec3 vVox; varying vec3 vN; varying float vAO; flat varying int vPal;
        float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
        vec3 gEmissive; float gRough; float gMetal;
      `)
      .replace('#include <color_fragment>', `
        vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
        vec3 base = pow(pe.rgb, vec3(2.2));
        int m = int(pe.a * 255.0 + 0.5);
        vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
        float gz = texture2D(uGround, (cell.xz + 0.5) / uSize).r;
        float lvl = cell.y - gz;                 // voxel level above local ground
        bool vert = abs(vN.y) < 0.5;
        float u = abs(vN.x) > 0.5 ? cell.z : cell.x;
        float h = hash13(cell);
        gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0;
        vec3 col = base * (0.97 + 0.06 * h);
        vec3 warm = vec3(1.0, 0.72, 0.42);
        if (m == ${MAT.WALL} || m == ${MAT.CONCRETE}) {
          if (vert) {
            float fl = mod(lvl, 3.0);
            bool shop = lvl < 4.0 && lvl >= 0.0;
            bool win = m == ${MAT.WALL} ? (fl > 0.5 && mod(u, 2.0) < 0.5) : false;
            if (m == ${MAT.CONCRETE}) win = shop && mod(u, 4.0) > 0.5;
            if (shop && m == ${MAT.WALL}) win = mod(u, 5.0) > 0.5 && lvl > 0.5;
            if (win) {
              col = mix(base * 0.42, vec3(0.10, 0.13, 0.17), 0.55) + 0.025 * h;
              gRough = 0.15; gMetal = 0.5;
              float lit = hash12(vec2(floor(u / 2.0) + cell.x * 0.13 + cell.z * 0.7, floor(lvl / 3.0)));
              if (shop) lit = 0.9;
              if (lit > 0.72) gEmissive = warm * (0.45 + 0.5 * h) * uNight;
            }
          }
        } else if (m == ${MAT.GLASS}) {
          if (vert) {
            bool span = mod(lvl, 4.0) < 0.5;
            if (span) { col = base * 0.55 + 0.04; gRough = 0.5; }
            else {
              col = base * (0.8 + 0.12 * step(0.5, mod(u, 2.0)));
              gRough = 0.1; gMetal = 0.35;
              float lit = hash12(vec2(floor(u / 3.0) + cell.x * 0.11 + cell.z * 0.53, floor(lvl / 4.0)));
              if (lit > 0.68) gEmissive = mix(warm, vec3(0.85, 0.92, 1.0), step(0.9, lit)) * 0.55 * uNight;
            }
          } else { gRough = 0.3; gMetal = 0.4; }
        } else if (m == ${MAT.PKIN}) {
          if (vert) {
            bool win = mod(lvl, 4.0) > 0.5 && mod(lvl, 4.0) < 2.5 && mod(u, 3.0) < 0.5;
            if (win) {
              col = base * 0.28; gRough = 0.2;
              if (hash12(vec2(u, floor(lvl / 4.0))) > 0.5) gEmissive = warm * 0.6 * uNight;
            }
            // floodlight from below at night
            gEmissive += base * vec3(1.0, 0.85, 0.7) * uNight * 0.22 * (0.6 + 0.4 * clamp(1.0 - lvl / 240.0, 0.0, 1.0));
          }
        } else if (m == ${MAT.LEAF}) {
          col = base * (0.8 + 0.35 * h); gRough = 0.95;
        } else if (m == ${MAT.GRASS}) {
          col = base * (0.88 + 0.2 * h); gRough = 1.0;
        } else if (m == ${MAT.WATER}) {
          float r = sin(cell.x * 0.9 + uTime * 1.3) * sin(cell.z * 1.1 - uTime) * 0.5 + 0.5;
          col = base * (0.75 + 0.25 * r); gRough = 0.04; gMetal = 0.3;
        } else if (m == ${MAT.LAMP}) {
          col = base; gEmissive = vec3(1.0, 0.82, 0.55) * (0.15 + 6.0 * uNight);
        } else if (m == ${MAT.METAL}) {
          gRough = 0.4; gMetal = 0.5;
        } else if (m == ${MAT.SOIL}) {
          float band = mod(cell.y, 5.0) < 1.0 ? 0.82 : 1.0;
          col = base * band * (0.9 + 0.2 * h); gRough = 1.0;
        } else if (m == ${MAT.CAR}) {
          gRough = 0.25; gMetal = 0.3;
          if (uNight > 0.0 && vert) gEmissive = vec3(1.0, 0.3, 0.2) * 0.2 * uNight * step(0.7, h);
        } else if (m == ${MAT.CLOCK}) {
          gRough = 0.3; gEmissive = vec3(1.0, 0.95, 0.8) * 1.4 * uNight;
        } else if (m == ${MAT.MARK}) {
          col = base * (0.95 + 0.05 * h);
        }
        // street-lamp glow on everything near the ground at night
        if (uNight > 0.0) {
          vec3 lm = texture2D(uLampMap, (vVox.xz) / uSize).rgb;
          float fall = clamp(1.0 - (vVox.y - gz) / 14.0, 0.0, 1.0);
          gEmissive += col * lm * fall * uNight * 1.6;
        }
        diffuseColor.rgb = col * mix(0.62, 1.0, vAO);
      `)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = gMetal;`)
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance += gEmissive;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => 'voxel-v1';
  mat.userData.uniforms = uniforms;
  return mat;
}
