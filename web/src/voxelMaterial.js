import * as THREE from 'three';

// material ids (must match scripts/voxelize.py)
export const MAT = { SOLID: 0, WALL: 1, GLASS: 2, LEAF: 3, WATER: 4, LAMP: 5, METAL: 6, PKIN: 7, GRASS: 8, MARK: 9, SOIL: 10, CAR: 11, ROOF: 12, CONCRETE: 13, CLOCK: 14, BRONZE: 15, SIGN: 16, JET: 17, SIGNBAND: 18 };

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

export function makeVoxelMaterial({ paletteTex, lampTex, W, D, ghost = null, shared = null }) {
  const uniforms = shared || {
    uPalette: { value: paletteTex },
    uLampMap: { value: lampTex },
    uSize: { value: new THREE.Vector2(W, D) },
    uNight: { value: 0 },
    uDeep: { value: 0 },
    uTime: { value: 0 },
    uHorizon: { value: new THREE.Color(0.7, 0.75, 0.8) },
    // PROTOTYPE (proto-ghost): treatment with distance from the look-at point (0 none, 1 fog of war, 2 haze)
    uFocus: { value: new THREE.Vector2(0, 0) }, uRad: { value: 1e9 }, uFow: { value: 0 },
  };
  // PROTOTYPE (proto-ghost): ?shape= -- which columns are real is decided per pixel (zones.js); both the real tiles
  // and the clay hide where the other one is drawn
  const ZONES = !shared && new URLSearchParams(location.search).get('shape');
  if (ZONES) {
    const one = (fmt, type, data) => { const t = new THREE.DataTexture(data, 1, 1, fmt, type); t.needsUpdate = true; return t; };
    Object.assign(uniforms, { uZBlk: { value: one(THREE.RedIntegerFormat, THREE.UnsignedShortType, new Uint16Array(1)) },
      uZBld: { value: one(THREE.RedIntegerFormat, THREE.UnsignedShortType, new Uint16Array(1)) },
      uZFBlk: { value: one(THREE.RedFormat, THREE.UnsignedByteType, new Uint8Array(1)) }, uZFBld: { value: one(THREE.RedFormat, THREE.UnsignedByteType, new Uint8Array(1)) },
      uZMode: { value: 0 }, uZFocus: { value: new THREE.Vector2() }, uZRad: { value: 1e9 } });
  }
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0.0 });
  // PROTOTYPE (proto-ghost): the ghost city outside the real square; uMask marks 128 m cells drawn for real
  const gu = ghost ? { uMask: { value: ghost.mask }, uGStyle: { value: ghost.style } } : {};
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, gu);
    if (ghost) shader.fragmentShader = '#define GHOST\nuniform sampler2D uMask; uniform int uGStyle;\n' + shader.fragmentShader;
    if ('uZMode' in uniforms) shader.fragmentShader = `#define ZONES
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
      }
    ` + shader.fragmentShader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 vattr;
        attribute float vpal;
        varying vec3 vVox;
        varying vec3 vN;
        varying float vAO;
        varying float vGz;
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
        vVox = position; vN = objectNormal; vAO = vattr.y / 3.0; vGz = vattr.z; vPal = int(vpal + 0.5);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uPalette; uniform sampler2D uLampMap;
        uniform vec2 uSize; uniform float uNight; uniform float uDeep; uniform float uTime; uniform vec3 uHorizon;
        uniform vec2 uFocus; uniform float uRad; uniform int uFow;
        varying vec3 vVox; varying vec3 vN; varying float vAO; varying float vGz; flat varying int vPal;
        float hash13(vec3 p){ p = fract(p*0.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
        float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*0.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
        vec3 gEmissive; float gRough; float gMetal;
        // interior light colours: warm homes (2700 K), neutral, and cool office LED
        vec3 roomLight(float r){
          if (r < 0.55) return vec3(1.0, 0.66, 0.34);
          if (r < 0.85) return vec3(1.0, 0.82, 0.58);
          return vec3(0.78, 0.88, 1.0);
        }
      `)
      .replace('#include <color_fragment>', `
        vec4 pe = texelFetch(uPalette, ivec2(vPal % 64, vPal / 64), 0);
        vec3 base = pow(pe.rgb, vec3(2.2));
        int m = int(pe.a * 255.0 + 0.5);
        vec3 cell = floor(vVox - vN * 0.5 + 1e-3);
        float gz = vGz; // ground level of this face's column (baked per vertex by the mesher; was a whole-map texture)
        float lvl = cell.y - gz;                 // voxel level above local ground
        bool vert = abs(vN.y) < 0.5;
        float u = abs(vN.x) > 0.5 ? cell.z : cell.x;      // along the facade
        float wpos = abs(vN.x) > 0.5 ? cell.x : cell.z;   // constant across one facade plane
        float h = hash13(cell);
        gEmissive = vec3(0.); gRough = 0.88; gMetal = 0.0;
        vec3 col = base * (0.97 + 0.06 * h);
        vec3 warm = vec3(1.0, 0.72, 0.42);
        // fraction of lit rooms falls through the night (blue hour ~32%, late night ~15%)
        float litFrac = mix(0.32, 0.15, uDeep);
        bool shopLvl = lvl > 0.5 && lvl < 3.5;
        if (m == ${MAT.WALL} || m == ${MAT.CONCRETE}) {
          if (vert) {
            float fl = mod(lvl, 3.0);
            bool shop = lvl < 4.0 && lvl >= 1.0;
            bool win = m == ${MAT.WALL} ? (fl > 0.5 && mod(u, 2.0) < 0.5) : false;
            if (m == ${MAT.CONCRETE}) win = shop && mod(u, 4.0) > 0.5;
            if (shop && m == ${MAT.WALL}) win = mod(u, 5.0) > 0.5 && lvl > 0.5;
            if (win) {
              // unlit glass picks up the sky; lit rooms are whole 2-window flats
              col = mix(base * 0.42, vec3(0.10, 0.13, 0.17), 0.55) + 0.025 * h;
              gRough = 0.12; gMetal = 0.6;
              vec2 room = vec2(floor(u / 4.0) + wpos * 17.31 + vN.x * 3.1, floor(lvl / 3.0) + vN.z * 5.7);
              float lit = hash12(room);
              if (shop) {
                if (hash12(vec2(floor(u / 6.0), wpos * 3.7)) < 0.8) gEmissive = vec3(1.0, 0.8, 0.55) * 1.5 * uNight;
              } else if (lit < litFrac) {
                gEmissive = roomLight(hash12(room + 7.1)) * (0.55 + 0.35 * hash12(room + 3.3)) * uNight;
              }
            }
          }
        } else if (m == ${MAT.GLASS}) {
          if (vert) {
            bool span = mod(lvl, 4.0) < 0.5;
            if (span) { col = base * 0.55 + 0.04; gRough = 0.5; }
            else {
              col = base * (0.8 + 0.12 * step(0.5, mod(u, 2.0)));
              gRough = 0.08; gMetal = mix(0.35, 0.6, uNight);
              // offices: whole floor stretches (~12 m) switch on together, mostly cool white
              vec2 zone = vec2(floor(u / 12.0) + wpos * 13.7 + vN.x * 2.3, floor(lvl / 4.0) + vN.z * 4.1);
              float lit = hash12(zone);
              if (shopLvl && lvl < 4.0) gEmissive = vec3(1.0, 0.86, 0.66) * 1.3 * uNight;
              else if (lit < litFrac * 0.9) gEmissive = mix(vec3(0.8, 0.9, 1.0), vec3(1.0, 0.88, 0.7), step(0.7, hash12(zone + 1.7))) * 0.7 * uNight;
            }
          } else { gRough = 0.3; gMetal = 0.4; }
        } else if (m == ${MAT.PKIN}) {
          // floodlit: warm gold washing up each tier from its base (photos: PKiN at dusk), plus lit rooms
          float tier = fract(lvl / 34.0);
          float wash = 0.55 + 0.45 * (1.0 - tier) ;
          if (vert) {
            bool win = mod(lvl, 4.0) > 0.5 && mod(lvl, 4.0) < 2.5 && mod(u, 3.0) < 0.5;
            if (win) {
              col = base * 0.35; gRough = 0.2;
              if (hash12(vec2(u, floor(lvl / 4.0))) < 0.45) gEmissive = vec3(1.0, 0.78, 0.48) * 0.9 * uNight;
            } else {
              gEmissive = base * vec3(1.0, 0.82, 0.55) * uNight * 0.85 * wash;
            }
          } else {
            gEmissive = base * vec3(1.0, 0.82, 0.55) * uNight * 0.35;
          }
        } else if (m == ${MAT.LEAF}) {
          col = base * (0.8 + 0.35 * h); gRough = 0.95;
        } else if (m == ${MAT.GRASS}) {
          col = base * (0.88 + 0.2 * h); gRough = 1.0;
        } else if (m == ${MAT.WATER}) {
          float r = sin(cell.x * 0.9 + uTime * 1.3) * sin(cell.z * 1.1 - uTime) * 0.5 + 0.5;
          col = base * (0.75 + 0.25 * r); gRough = 0.04; gMetal = 0.3;
          // a river mirrors the sky, more so at grazing angles (Fresnel): without it the Vistula read as grey concrete
          vec3 V = normalize(cameraPosition - vVox);
          float fres = pow(1.0 - max(dot(vN, V), 0.0), 4.0);
          col = mix(col, uHorizon, clamp(0.18 + 0.7 * fres, 0.0, 0.85));
        } else if (m == ${MAT.LAMP}) {
          col = base; gEmissive = vec3(1.0, 0.82, 0.55) * (0.15 + 3.2 * uNight);
        } else if (m == ${MAT.METAL}) {
          gRough = 0.4; gMetal = 0.5;
          // gilded spire / crown pieces catch the floodlights
          if (base.r > 0.3 && base.r > base.b * 2.0) gEmissive = base * 1.2 * uNight;
        } else if (m == ${MAT.SOIL}) {
          float band = mod(cell.y, 5.0) < 1.0 ? 0.82 : 1.0;
          col = base * band * (0.9 + 0.2 * h); gRough = 1.0;
        } else if (m == ${MAT.CAR}) {
          gRough = 0.25; gMetal = 0.3;
          // parked/frozen cars: tail lights and headlights
          if (uNight > 0.0 && vert && lvl < 1.0) gEmissive = mix(vec3(1.0, 0.12, 0.08), vec3(1.0, 0.95, 0.85), step(0.5, h)) * 1.4 * uNight * step(0.55, fract(h * 7.0));
        } else if (m == ${MAT.BRONZE}) {
          // curtain wall with champagne-bronze vertical mullion caps and dark floor bands (Astoria west half)
          if (vert) {
            if (mod(lvl, 4.0) < 0.5) { col = vec3(0.025, 0.024, 0.022); gRough = 0.5; }
            else if (mod(u, 3.0) < 0.5) {
              col = vec3(0.16, 0.12, 0.065); gRough = 0.55; gMetal = 0.25;
              gEmissive = vec3(1.0, 0.75, 0.4) * 0.35 * uNight; // mullion caps glow warm at night
            } else {
              col = base * 0.6; gRough = 0.06; gMetal = 0.5;
              if (hash12(vec2(floor(u / 2.0) + cell.x * 0.17, floor(lvl / 4.0))) > 0.6) gEmissive = vec3(1.0, 0.85, 0.6) * 0.5 * uNight;
            }
          }
        } else if (m == ${MAT.SIGNBAND}) {
          col = base; gRough = 0.35; gMetal = 0.7;
        } else if (m == ${MAT.SIGN}) {
          col = base; gRough = 0.3; gMetal = 0.6;
          gEmissive = base * (0.15 + 2.2 * uNight); // backlit gold lettering
        } else if (m == ${MAT.JET}) {
          // fountain jets: pulse in and out of the paving
          float ph = sin(uTime * 2.4 + h * 6.28);
          if (ph < -0.2 + (lvl - 0.0) * 0.6) discard;
          col = base; gRough = 0.05; gMetal = 0.2;
          gEmissive = vec3(0.7, 0.85, 1.0) * 0.8 * uNight;
        } else if (m == ${MAT.CLOCK}) {
          gRough = 0.3; gEmissive = vec3(1.0, 0.95, 0.8) * 1.4 * uNight;
        } else if (m == ${MAT.MARK}) {
          col = base * (0.95 + 0.05 * h);
        }
        // street-lamp glow on everything near the ground at night
        if (uNight > 0.0) {
          vec3 lm = texture2D(uLampMap, (vVox.xz) / uSize).rgb;
          float hgt = vVox.y - gz;
          float fall = clamp(1.0 - hgt / 16.0, 0.0, 1.0);
          float up = (m == ${MAT.LEAF}) ? (vN.y < -0.5 ? 2.6 : 1.7) : 1.0; // canopies glow from below
          // water doesn't take the light as a lit surface: it reflects it, a dimmer warm sheen (bridge and boulevard lamps)
          if (m == ${MAT.WATER}) gEmissive += lm * vec3(1.0, 0.72, 0.42) * fall * uNight * 0.45;
          else gEmissive += col * lm * fall * uNight * 2.2 * up;
        }
        diffuseColor.rgb = col * mix(0.62, 1.0, vAO);
        #ifdef ZONES
        #ifdef GHOST
        if (zreal(cell)) discard;
        #else
        if (!zreal(cell)) discard;
        #endif
        #endif
        #ifdef GHOST
        #ifndef ZONES
        if (texelFetch(uMask, ivec2(floor(vVox.x / 128.0), floor(vVox.z / 128.0)), 0).r > 0.5) discard;
        #endif
        float lumc = dot(col, vec3(0.3, 0.59, 0.11));
        if (uGStyle != 0) { gEmissive = vec3(0.0); gRough = 0.95; gMetal = 0.0; }
        if (uGStyle == 1) { diffuseColor.rgb = vec3(0.62, 0.61, 0.59) * mix(0.75, 1.0, vAO); }                  // clay model
        else if (uGStyle == 2) { diffuseColor.rgb = vec3(0.55, 0.65, 0.78); diffuseColor.a = 0.28; gEmissive = vec3(0.08, 0.1, 0.14); } // glass
        else if (uGStyle == 3) {                                                                                 // drawing: white with cell edges
          vec3 q = fract(vVox / 4.0); vec3 e = min(q, 1.0 - q) * 4.0; float w = vert ? min(abs(vN.x) > 0.5 ? e.z : e.x, e.y) : min(e.x, e.z);
          diffuseColor.rgb = mix(vec3(0.25, 0.28, 0.33), vec3(0.85, 0.85, 0.83), smoothstep(0.15, 0.45, w));
          gEmissive = diffuseColor.rgb * 0.25;
        }
        else if (uGStyle == 4) { diffuseColor.rgb = mix(vec3(lumc), pow(uHorizon, vec3(2.2)), 0.7); gEmissive = pow(uHorizon, vec3(2.2)) * 0.25; } // haze
        else if (uGStyle == 5) { diffuseColor.rgb = mix(col, vec3(lumc), 0.85) * 0.9; }                       // desaturated colour
        #endif
      `)
      .replace('#include <fog_fragment>', `#include <fog_fragment>
        if (uFow > 0) { // the change happens before the edge of the real area: the seam to the ghost is where nothing shows
          float k = smoothstep(uRad * 0.55, uRad * 0.97, length(vVox.xz - uFocus));
          if (uFow == 1) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.012, 0.014, 0.02), k);
          else gl_FragColor.rgb = mix(gl_FragColor.rgb, uHorizon, k);
        }`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = gRough;`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = gMetal;`)
      .replace('#include <emissivemap_fragment>', `totalEmissiveRadiance += gEmissive;`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        float aoF = mix(0.55, 1.0, vAO);
        reflectedLight.indirectDiffuse *= aoF; reflectedLight.indirectSpecular *= aoF;`);
  };
  mat.customProgramCacheKey = () => ghost ? 'voxel-ghost' : 'voxel-v1';
  if (ghost?.style === 2) { mat.transparent = true; mat.depthWrite = false; }
  mat.userData.uniforms = uniforms;
  mat.userData.ghost = gu;
  return mat;
}
