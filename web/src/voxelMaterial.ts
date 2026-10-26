import * as THREE from 'three';
import type { Meta } from './types';
import { FOLIAGE_CLASSES } from './foliage';
import { dataTexture } from './util';

// material ids, as in scripts/voxelize.py
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, PKIN: 7, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11,
  ROOF: 12, CONCRETE: 13, CLOCK: 14, BRONZE: 15, SIGN: 16, JET: 17, SIGNBAND: 18, RIBBON: 19, CLASSIC: 20, WINDOW: 21 } as const;

type U<T> = { value: T };
export interface VoxelUniforms {
  [name: string]: THREE.IUniform;
  uPalette: U<THREE.Texture>;
  uLampMap: U<THREE.Texture>;
  uSize: U<THREE.Vector2>;
  uNight: U<number>;
  uDeep: U<number>;
  uTime: U<number>;
  uHorizon: U<THREE.Color>;
  uDrop: U<number>;
  uFlood: U<THREE.Texture>;
  uWet: U<number>;
  uSnow: U<number>;
  uDay: U<number>;
  uFolOn: U<number>;
  uFolMap: U<THREE.Texture>;
  uFolDate: U<THREE.Vector4[]>;
  uFolCol: U<THREE.Color[]>;
  uGrass: U<THREE.Color[]>;
  uLeaf: U<THREE.Color>;
  uAlbedo: U<number>;
  uPkinLight: U<THREE.Color>;
}
export interface BuildUniforms { uStage: U<number>; uBldOn: U<THREE.Texture> }
export interface ZoneUniforms {
  uZBlk: U<THREE.Texture>; uZBld: U<THREE.Texture>; uZFBlk: U<THREE.Texture>; uZFBld: U<THREE.Texture>;
  uZMode: U<number>; uZFocus: U<THREE.Vector2>; uZRad: U<number>;
}
export type Engine = 'city' | 'zones';

const tiny = (format: THREE.PixelFormat, data: Uint8Array | Uint16Array, type?: THREE.TextureDataType) => dataTexture(data, 1, 1, format, type);

export function makeUniforms(meta: Meta, engine: Engine): VoxelUniforms & Partial<BuildUniforms & ZoneUniforms> {
  const base: VoxelUniforms = {
    uPalette: { value: makePaletteTexture(meta.palette) },
    uLampMap: { value: makeLampTexture(meta) },
    uSize: { value: new THREE.Vector2(meta.W, meta.D) },
    uNight: { value: 0 },
    uDeep: { value: 0 },
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color(0.7, 0.75, 0.8) },
    uDrop: { value: 0 },
    uFlood: { value: tiny(THREE.RGFormat, new Uint8Array(2)) },
    uWet: { value: 0 },
    uSnow: { value: 0 },
    uDay: { value: 200 },
    uFolOn: { value: 0 },
    uFolMap: { value: tiny(THREE.RGFormat, new Uint8Array(2)) },
    uFolDate: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Vector4(-1, 0, 0, 0)) },
    uFolCol: { value: Array.from({ length: FOLIAGE_CLASSES }, () => new THREE.Color(0.3, 0.2, 0.05)) },
    uGrass: { value: Array.from({ length: 12 }, () => new THREE.Color(1, 1, 1)) },
    uLeaf: { value: new THREE.Color(1, 1, 1) },
    uAlbedo: { value: 0.7 },
    uPkinLight: { value: new THREE.Color(0.95, 0.74, 0.4) },
  };
  if (engine === 'city') return { ...base, uStage: { value: 0 }, uBldOn: { value: tiny(THREE.RedFormat, new Uint8Array(1)) } };
  const ids = () => tiny(THREE.RedIntegerFormat, new Uint16Array(1), THREE.UnsignedShortType);
  return { ...base, uZBlk: { value: ids() }, uZBld: { value: ids() }, uZFBlk: { value: tiny(THREE.RedFormat, new Uint8Array(1)) },
    uZFBld: { value: tiny(THREE.RedFormat, new Uint8Array(1)) }, uZMode: { value: 0 }, uZFocus: { value: new THREE.Vector2() }, uZRad: { value: 1e9 } };
}

function makePaletteTexture(palette: Meta['palette']) {
  const size = 64, data = new Uint8Array(size * size * 4);
  palette.forEach((p, i) => data.set(p, i * 4));
  const tex = dataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  return tex;
}

// warm pools of street light on the ground (2 m texels), and an even wash over floodlit pitches
function makeLampTexture(meta: Meta) {
  const s = 0.5, cv = document.createElement('canvas');
  cv.width = meta.W * s; cv.height = meta.D * s;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.globalCompositeOperation = 'lighter';
  const pool = (x: number, y: number, r: number, stops: [number, string][]) => {
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r);
    for (const [t, c] of stops) gr.addColorStop(t, c);
    ctx.fillStyle = gr;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  for (const [x, y] of meta.lamps) pool((x + 0.5) * s, (y + 0.5) * s, 20 * s,
    [[0, 'rgba(255,226,180,0.65)'], [0.3, 'rgba(255,216,170,0.28)'], [0.65, 'rgba(255,210,160,0.08)'], [1, 'rgba(255,205,150,0)']]);
  for (const [x, y, r] of meta.floods ?? []) pool(x * s, y * s, r * 1.35 * s,
    [[0, 'rgba(225,235,255,0.6)'], [0.7, 'rgba(225,235,255,0.52)'], [1, 'rgba(225,235,255,0)']]);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.flipY = false;
  return tex;
}

// A leaf voxel through the year (foliage.ts): x = in leaf (0 bare .. 1), y = turned (0 green .. 1 autumn colour), z = class.
const FOLIAGE = `
  uniform sampler2D uFolMap; uniform vec4 uFolDate[${FOLIAGE_CLASSES}]; uniform vec3 uFolCol[${FOLIAGE_CLASSES}]; uniform float uDay; uniform float uFolOn; uniform vec3 uGrass[12]; uniform vec3 uLeaf;
  vec3 foliageAt(vec3 cell) {
    vec2 f = texelFetch(uFolMap, ivec2(cell.xz * 0.5), 0).rg;
    int cls = int(f.r * 255.0 + 0.5);
    if (cls == 0) cls = 13;
    vec4 d = uFolDate[cls];
    if (d.x < 0.0) return vec3(1.0, 0.0, float(cls));
    float k = f.g * 255.0;
    float off = (fract(k * 0.618034) + fract(k * 0.414214 + 0.3) - 1.0) * 2.45 * d.w;
    float t = uDay - off;
    float leaf = t < 200.0 ? smoothstep(d.x, d.x + 14.0, t) : 1.0 - smoothstep(d.z - 8.0, d.z + 8.0, t);
    return vec3(leaf, smoothstep(d.y - 10.0, d.y + 10.0, t), float(cls));
  }
  vec3 grassTint() {
    float m = mod(uDay / 30.42 - 0.5, 12.0);
    int a = int(m);
    return mix(uGrass[a], uGrass[(a + 1) % 12], fract(m));
  }
  float litter(vec3 cell) {
    vec2 f = texelFetch(uFolMap, ivec2(cell.xz * 0.5), 0).rg;
    int cls = int(f.r * 255.0 + 0.5);
    if (cls == 0 || uFolDate[cls].x < 0.0) return 0.0;
    vec3 fo = foliageAt(cell);
    return (1.0 - fo.x) * fo.y * (1.0 - smoothstep(uFolDate[cls].z + 15.0, uFolDate[cls].z + 50.0, uDay));
  }
  bool leafGone(vec3 cell, vec3 fo) { return hash13(cell * 1.7 + 3.1) > fo.x && hash13(cell * 2.3 + 7.7) > 0.3; }`;

const NORMAL_FROM_IDX = `
  vec3 normalFromIdx(float i) {
    if (i < 0.5) return vec3(-1., 0., 0.);
    if (i < 1.5) return vec3(1., 0., 0.);
    if (i < 2.5) return vec3(0., 0., -1.);
    if (i < 3.5) return vec3(0., 0., 1.);
    if (i < 4.5) return vec3(0., -1., 0.);
    return vec3(0., 1., 0.);
  }`;

// While the city loads (city.ts): a building shows once uBldOn says so; until stage 2 the rest is folded under the
// terrain, after it a hidden building lies flat as a ground-coloured footprint.
const BUILD_PARS = `uniform float uStage; uniform sampler2D uBldOn; attribute float vbld;`;
const BUILD_VERTEX = `
  float hideB = 0.0;
  {
    int bid = int(vbld + 0.5);
    bool on = bid > 0 ? texelFetch(uBldOn, ivec2(bid % 128, bid / 128), 0).r > 0.5 : uStage > 1.5;
    if (!on) {
      if (uStage < 1.5) transformed.y = vattr.z - 3.0;
      else { hideB = 1.0; transformed.y = vattr.z; }
    }
  }`;

const ZONES_PARS = `
  uniform highp usampler2D uZBlk; uniform highp usampler2D uZBld; uniform sampler2D uZFBlk; uniform sampler2D uZFBld;
  uniform int uZMode; uniform vec2 uZFocus; uniform float uZRad;
  bool zflag(sampler2D t, uint id) { int w = textureSize(t, 0).x; return texelFetch(t, ivec2(int(id) % w, int(id) / w), 0).r > 0.5; }
  bool zreal(vec3 c) {
    ivec2 p = clamp(ivec2(c.x, c.z), ivec2(0), textureSize(uZBlk, 0) - 1);
    vec2 d = c.xz + 0.5 - uZFocus;
    if (uZMode == 1) return max(abs(d.x), abs(d.y)) < uZRad;
    if (uZMode == 2) return length(d) < uZRad;
    uint b = texelFetch(uZBld, p, 0).r;
    if ((uZMode == 3 || uZMode == 6) && b > 0u) return zflag(uZFBld, b);
    if (uZMode == 3) return length(d) < uZRad;
    return zflag(uZFBlk, texelFetch(uZBlk, p, 0).r);
  }`;

const FRAG_PARS = `
  uniform sampler2D uPalette; uniform sampler2D uLampMap;
  uniform vec2 uSize; uniform float uNight; uniform float uDeep; uniform float uTime; uniform vec3 uHorizon;
  uniform float uDrop; uniform sampler2D uFlood; uniform float uWet; uniform float uSnow; uniform float uAlbedo; uniform vec3 uPkinLight;
  varying vec3 vVox; varying vec3 vN; varying float vAO; varying float vGz; flat varying int vPal; varying float vHide;
  float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
  float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  vec3 gEmissive; float gRough; float gMetal;
  ${FOLIAGE}
  vec3 roomLight(float r) {
    if (r < 0.55) return vec3(1.0, 0.66, 0.34);
    if (r < 0.85) return vec3(1.0, 0.82, 0.58);
    return vec3(0.95, 0.96, 0.92);
  }`;

const SURFACE = `
  vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
  vec3 base = pow(pe.rgb, vec3(2.2));
  int m = int(pe.a * 255.0 + 0.5);
  vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
  float gz = vGz;
  float lvl = cell.y - gz;
  bool vert = abs(vN.y) < 0.5;
  float u = abs(vN.x) > 0.5 ? cell.z : cell.x;
  float wpos = abs(vN.x) > 0.5 ? cell.x : cell.z;
  float h = hash13(cell);
  gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0;
  vec3 col = base * (0.97 + 0.06 * h);
  float litFrac = mix(0.2, 0.09, uDeep);
  bool shopLvl = lvl > 0.5 && lvl < 3.5;
  if (m == ${MAT.WALL} || m == ${MAT.CONCRETE}) {
    if (vert) {
      float fl = mod(lvl, 3.0);
      bool shop = lvl < 4.0 && lvl >= 1.0;
      bool win = m == ${MAT.WALL} ? (fl > 0.5 && mod(u, 2.0) < 0.5) : false;
      if (m == ${MAT.CONCRETE}) win = shop && mod(u, 4.0) > 0.5;
      if (shop && m == ${MAT.WALL}) win = mod(u, 5.0) > 0.5 && lvl > 0.5;
      if (win) {
        col = mix(base * 0.42, vec3(0.10, 0.13, 0.17), 0.55) + 0.025 * h;
        gRough = 0.12; gMetal = 0.6;
        vec2 room = vec2(floor(u / 4.0) + wpos * 17.31 + vN.x * 3.1, floor(lvl / 3.0) + vN.z * 5.7);
        if (shop) {
          if (hash12(vec2(floor(u / 6.0), wpos * 3.7)) < 0.8) gEmissive = vec3(1.0, 0.8, 0.55) * 1.5 * uNight;
        } else if (hash12(room) < litFrac) {
          gEmissive = roomLight(hash12(room + 7.1)) * (0.55 + 0.35 * hash12(room + 3.3)) * uNight;
        }
      }
    }
  } else if (m == ${MAT.GLASS}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = base * 0.55 + 0.04; gRough = 0.5; }
      else {
        col = base * (0.8 + 0.12 * step(0.5, mod(u, 2.0)));
        gRough = 0.08; gMetal = mix(0.35, 0.6, uNight);
        vec2 zone = vec2(floor(u / 40.0) + wpos * 13.7 + vN.x * 2.3, floor(lvl / 4.0) + vN.z * 4.1);
        if (shopLvl && lvl < 4.0) gEmissive = vec3(1.0, 0.86, 0.66) * 1.3 * uNight;
        else if (hash12(zone) < litFrac * 1.2) gEmissive = mix(vec3(0.86, 0.94, 0.92), vec3(1.0, 0.92, 0.8), step(0.7, hash12(zone + 1.7))) * 0.75 * uNight;
      }
    } else { gRough = 0.3; gMetal = 0.4; }
  } else if (m == ${MAT.CLASSIC}) {
    gRough = 0.8;
    if (vert && lvl < 7.5) col *= mod(lvl, 2.0) < 1.0 ? 0.9 : 1.0;
  } else if (m == ${MAT.RIBBON}) {
    if (vert && mod(lvl, 4.0) > 1.5) {
      col = mix(base * 0.4, vec3(0.12, 0.16, 0.2), 0.6) + 0.02 * h; gRough = 0.08; gMetal = 0.55;
      vec2 zone = vec2(floor(u / 12.0) + wpos * 13.7 + vN.x * 2.3, floor(lvl / 4.0) + vN.z * 4.1);
      if (hash12(zone) < litFrac * 0.9) gEmissive = vec3(0.86, 0.94, 0.92) * 0.7 * uNight;
    } else { gRough = 0.4; gMetal = 0.3; }
  } else if (m == ${MAT.PKIN}) {
    float wash = 0.45 + 0.55 * (1.0 - fract(lvl / 34.0));
    gEmissive = uPkinLight * uNight * (vert ? 0.55 * wash : 0.45);
  } else if (m == ${MAT.WINDOW}) {
    gRough = 0.15; gMetal = 0.35;
    col *= 0.6;
    if (hash13(floor(cell / 2.0)) < litFrac * 0.4) gEmissive = vec3(1.0, 0.82, 0.55) * 0.9 * uNight;
  } else if (m == ${MAT.LEAF}) {
    col = base * uLeaf * (0.8 + 0.35 * h); gRough = 0.95;
    if (uFolOn > 0.5) {
      vec3 fo = foliageAt(cell);
      if (hash13(cell * 1.7 + 3.1) > fo.x) {
        if (leafGone(cell, fo)) discard;
        col = vec3(0.2, 0.17, 0.14) * (0.8 + 0.4 * h);
      } else {
        col = mix(col, uFolCol[int(fo.z)] * (0.75 + 0.45 * h), smoothstep(0.0, 0.3, fo.y - 0.85 * hash13(cell * 0.9 + 1.3)));
      }
    }
  } else if (m == ${MAT.GRASS}) {
    col = base * mix(vec3(1.0), grassTint(), smoothstep(0.02, 0.08, base.g - max(base.r, base.b))) * (0.88 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.WATER}) {
    float r = sin(cell.x * 0.9 + uTime * 1.3) * sin(cell.z * 1.1 - uTime) * 0.5 + 0.5;
    col = mix(vec3(0.012, 0.085, 0.15), vec3(0.03, 0.2, 0.26), r * r) * (0.94 + 0.12 * h); gRough = 0.04; gMetal = 0.3;
    vec3 V = normalize(cameraPosition - vVox);
    float fres = pow(1.0 - max(dot(vN, V), 0.0), 4.0);
    col = mix(col, uHorizon * 0.8, clamp(0.08 + 0.55 * fres, 0.0, 0.55));
    if (vN.y > 0.5 && hash12(cell.xz * 0.37 + floor(uTime * 1.7 + h * 9.0)) < 0.006) col += vec3(0.35, 0.4, 0.38) * (1.0 - uNight) * (1.0 - uNight);
    if (uDrop > 0.0) { // low water: where the estimated bed is shallower than the drop, a sandbank
      float bed = texelFetch(uFlood, ivec2(cell.x, cell.z), 0).g * 25.5;
      if (bed < uDrop) {
        col = mix(vec3(0.3, 0.24, 0.15), vec3(0.62, 0.52, 0.36), smoothstep(0.05, 0.35, uDrop - bed)) * (0.92 + 0.12 * h);
        gRough = 0.95; gMetal = 0.0;
      }
    }
  } else if (m == ${MAT.LAMP}) {
    col = base; gEmissive = vec3(1.0, 0.82, 0.55) * (0.15 + 3.2 * uNight);
  } else if (m == ${MAT.METAL}) {
    gRough = 0.4; gMetal = 0.5;
    if (base.r > 0.3 && base.r > base.b * 2.0) gEmissive = base * 1.2 * uNight;
  } else if (m == ${MAT.SOIL}) {
    col = base * (mod(cell.y, 5.0) < 1.0 ? 0.82 : 1.0) * (0.9 + 0.2 * h); gRough = 1.0;
  } else if (m == ${MAT.CAR}) {
    gRough = 0.25; gMetal = 0.3;
    if (uNight > 0.0 && vert && lvl < 1.0) gEmissive = mix(vec3(1.0, 0.12, 0.08), vec3(1.0, 0.95, 0.85), step(0.5, h)) * 1.4 * uNight * step(0.55, fract(h * 7.0));
  } else if (m == ${MAT.BRONZE}) {
    if (vert) {
      if (mod(lvl, 4.0) < 0.5) { col = vec3(0.025, 0.024, 0.022); gRough = 0.5; }
      else if (mod(u, 3.0) < 0.5) {
        col = vec3(0.16, 0.12, 0.065); gRough = 0.55; gMetal = 0.25;
        gEmissive = vec3(1.0, 0.75, 0.4) * 0.35 * uNight;
      } else {
        col = base * 0.6; gRough = 0.06; gMetal = 0.5;
        if (hash12(vec2(floor(u / 2.0) + cell.x * 0.17, floor(lvl / 4.0))) > 0.6) gEmissive = vec3(1.0, 0.85, 0.6) * 0.5 * uNight;
      }
    }
  } else if (m == ${MAT.SIGNBAND}) {
    col = base; gRough = 0.35; gMetal = 0.7;
  } else if (m == ${MAT.SIGN}) {
    col = base; gRough = 0.3; gMetal = 0.6;
    gEmissive = base * (0.15 + 2.2 * uNight);
  } else if (m == ${MAT.JET}) {
    if (sin(uTime * 2.4 + h * 6.28) < -0.2 + lvl * 0.6) discard;
    col = base; gRough = 0.05; gMetal = 0.2;
    gEmissive = vec3(0.7, 0.85, 1.0) * 0.8 * uNight;
  } else if (m == ${MAT.CLOCK}) {
    gRough = 0.3; gEmissive = vec3(1.0, 0.95, 0.8) * 1.4 * uNight;
  } else if (m == ${MAT.MARK}) {
    col = base * (0.95 + 0.05 * h);
  }
  if (uFolOn > 0.5 && vN.y > 0.5 && lvl < 0.5 && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.MARK}) {
    float lit = litter(cell) * (m == ${MAT.GRASS} || m == ${MAT.SOIL} ? 0.9 : 0.35);
    if (hash13(cell * 3.1 + 0.7) < lit) {
      int cls = int(texelFetch(uFolMap, ivec2(cell.xz * 0.5), 0).r * 255.0 + 0.5);
      col = mix(uFolCol[cls], vec3(0.32, 0.22, 0.12), 0.45 * hash13(cell * 1.3)) * (0.7 + 0.3 * h);
      gRough = 1.0; gMetal = 0.0;
    }
  }
  if (uSnow > 0.0 && vN.y > 0.5 && m != ${MAT.WATER} && m != ${MAT.LAMP} && m != ${MAT.JET} && m != ${MAT.SIGN}) {
    float lum = dot(base, vec3(0.3, 0.59, 0.11));
    float street = lvl < 0.5 && m != ${MAT.GRASS} && m != ${MAT.SOIL} && m != ${MAT.LEAF} ? 1.0 : 0.0;
    float cover = smoothstep(0.0, 0.6, uSnow - 0.35 * hash13(cell + 0.5)) * mix(1.0, 0.35 + 0.4 * step(0.5, hash12(floor(cell.xz / 3.0))), street);
    vec3 snowCol = mix(vec3(0.86, 0.88, 0.92), vec3(0.42, 0.42, 0.43), street * smoothstep(0.25, 0.05, lum)) * (0.96 + 0.06 * h);
    col = mix(col, snowCol, cover);
    gRough = mix(gRough, 0.8, cover); gMetal *= 1.0 - cover; gEmissive *= 1.0 - cover;
  } else if (uWet > 0.0 && m != ${MAT.WATER} && m != ${MAT.LEAF} && m != ${MAT.GLASS}) {
    float flat_ = vN.y > 0.5 ? 1.0 : 0.0;
    float pud = flat_ * smoothstep(0.6, 0.7, hash12(floor(cell.xz / 2.0)) * 0.5 + hash12(floor(cell.xz / 7.0)) * 0.5);
    col *= mix(1.0, mix(0.82, mix(0.5, 0.3, pud), flat_), uWet);
    gRough = mix(gRough, mix(0.5, 0.03, pud), uWet * mix(0.5, 1.0, flat_));
  }
  if (uNight > 0.0) { // street lamps light what is near the ground; water reflects them instead
    vec3 lm = texture2D(uLampMap, vVox.xz / uSize).rgb;
    float fall = clamp(1.0 - (vVox.y - gz) / 16.0, 0.0, 1.0);
    float up = m == ${MAT.LEAF} ? (vN.y < -0.5 ? 2.6 : 1.7) : 1.0;
    if (m == ${MAT.WATER}) gEmissive += lm * vec3(1.0, 0.72, 0.42) * fall * uNight * 0.45;
    else gEmissive += col * lm * fall * uNight * 2.2 * up;
  }
  if (m != ${MAT.LAMP} && m != ${MAT.JET} && m != ${MAT.SIGN}) col *= mix(1.0, uAlbedo, smoothstep(0.2, 0.6, dot(col, vec3(0.2126, 0.7152, 0.0722))));
  diffuseColor.rgb = col * mix(0.62, 1.0, vAO);
  if (vHide > 0.5) { diffuseColor.rgb = vec3(0.42, 0.41, 0.39); gEmissive = vec3(0.0); }
  #ifdef ZONES
  #ifdef CLAY
  if (zreal(cell)) discard;
  #else
  if (!zreal(cell)) discard;
  #endif
  #endif
  #ifdef CLAY
  if (uClay != 0) { gEmissive = vec3(0.0); gRough = 0.95; gMetal = 0.0; diffuseColor.rgb = vec3(0.62, 0.61, 0.59) * mix(0.75, 1.0, vAO); }
  #endif`;

export function makeBuildDepthMaterial(uniforms: VoxelUniforms & BuildUniforms) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 vattr; attribute float vpal; ${BUILD_PARS}
        varying vec3 vVox; varying vec3 vN; flat varying int vPal; ${NORMAL_FROM_IDX}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>${BUILD_VERTEX}
        vVox = position; vN = normalFromIdx(mod(vattr.x, 8.0)); vPal = int(vpal + 0.5);`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; varying vec3 vVox; varying vec3 vN; flat varying int vPal;
        float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
        ${FOLIAGE}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (uFolOn > 0.5 && int(texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0).a * 255.0 + 0.5) == ${MAT.LEAF}) {
          vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
          vec3 fo = foliageAt(cell);
          if (hash13(cell * 1.7 + 3.1) > fo.x && leafGone(cell, fo)) discard;
        }`);
  };
  m.customProgramCacheKey = () => 'voxel-build-depth';
  return m;
}

// clay: the stand-in city outside the real area (zones.ts); uClay 0 keeps its colours
export function makeVoxelMaterial(uniforms: VoxelUniforms, { clay = false } = {}) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  const clayU = { uClay: { value: 1 } };
  const building = 'uStage' in uniforms, zones = 'uZMode' in uniforms;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, clay ? clayU : {});
    const defs = (zones ? `#define ZONES\n${ZONES_PARS}\n` : '') + (clay ? '#define CLAY\nuniform int uClay;\n' : '');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 vattr; attribute float vpal; ${building ? BUILD_PARS : ''}
        varying vec3 vVox; varying vec3 vN; varying float vAO; varying float vGz; flat varying int vPal; varying float vHide;
        ${NORMAL_FROM_IDX}`)
      // vattr.x = face axis (0-5) + 8 x the wall's direction in plan (mesher.worker.ts): a staircase wall is lit as its plane
      .replace('#include <beginnormal_vertex>', `float nAx = mod(vattr.x, 8.0), nAng = floor(vattr.x / 8.0 + 0.01);
        vec3 objectNormal = nAng > 0.5 ? vec3(cos((nAng - 1.0) * 0.261799), 0., sin((nAng - 1.0) * 0.261799)) : normalFromIdx(nAx);`)
      // and its 1 m steps don't shade each other: shadow lookups step out further along the wall's true direction
      .replace('#include <shadowmap_vertex>', THREE.ShaderChunk.shadowmap_vertex.replace(
        'directionalLightShadows[ i ].shadowNormalBias', '(directionalLightShadows[ i ].shadowNormalBias + (nAng > 0.5 ? 1.2 : 0.0))'))
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vVox = position; vN = normalFromIdx(nAx); vAO = vattr.y / 3.0; vGz = vattr.z; vPal = int(vpal + 0.5); vHide = 0.0;
        ${building ? `${BUILD_VERTEX} vHide = hideB;` : ''}`);
    shader.fragmentShader = defs + shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', SURFACE)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = gMetal;')
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance += gEmissive;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => `voxel-${building ? 'b' : ''}${zones ? 'z' : ''}${clay ? 'c' : ''}`;
  return Object.assign(mat, { clay: clayU.uClay });
}

export type VoxelMaterial = ReturnType<typeof makeVoxelMaterial>;
