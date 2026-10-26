import * as THREE from 'three';
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';

export interface Weather {
  cloud: number;
  fog: number;
  rain: number;
  snow: number;
  cover: number;
}

export const WEATHERS: Record<string, Weather> = {
  clear: { cloud: 0, fog: 0, rain: 0, snow: 0, cover: 0 },
  overcast: { cloud: 1, fog: 0, rain: 0, snow: 0, cover: 0 },
  fog: { cloud: 0, fog: 1, rain: 0, snow: 0, cover: 0 },
  rain: { cloud: 1, fog: 0, rain: 1, snow: 0, cover: 0 },
  snow: { cloud: 1, fog: 0, rain: 0, snow: 1, cover: 1 },
};

// the weather in a word or two
export function describe(w: Weather) {
  if (w.fog >= 0.5) return 'Fog';
  if (w.snow >= 0.3) return 'Snow';
  if (w.rain >= 0.3) return 'Rain';
  if (w.rain > 0 || w.snow > 0) return 'Drizzle';
  if (w.cloud >= 0.7) return 'Overcast';
  return w.cloud >= 0.3 ? 'Some cloud' : 'Clear sky';
}

// how far one sees, as a share of a clear day's haze distance
export const visibility = (w: Weather) => 1 - 0.1 * w.cloud - 0.4 * w.rain - 0.55 * w.snow - 0.15 * w.fog;

// Ground fog over the Vistula valley, from the depth buffer: dense below a top, thinning fast above it, integrated
// along each view ray, so towers stand out of it and it lies flat over the river; lit warm towards a low sun.
const FOG = `
uniform mat4 uCamWorld; uniform mat4 uProjInv; uniform vec3 uCamPos;
uniform float uTop; uniform float uDensity; uniform float uFalloff; uniform vec3 uFogCol; uniform vec3 uSunCol; uniform vec3 uSunDir; uniform float uTime;
float F(float y) { return y < uTop ? uDensity * (y - uTop) : uDensity * (1.0 - exp(-(y - uTop) * uFalloff)) / uFalloff; }
float h2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  if (uDensity <= 0.0) { outputColor = inputColor; return; }
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirV = v.xyz / v.w;
  float dist = depth >= 0.9999 ? 2500.0 : -getViewZ(depth) * length(dirV) / -dirV.z;
  vec3 rd = normalize((uCamWorld * vec4(dirV, 0.0)).xyz);
  vec3 end = uCamPos + rd * dist;
  float y0 = uCamPos.y, y1 = end.y;
  // the top is not a flat cut: slow swells over a few hundred metres
  float sw = (noise(end.xz * 0.006 + uTime * 0.01) - 0.5) * 14.0;
  y1 -= sw;
  float od = abs(rd.y) < 1e-3 ? (y0 < uTop ? uDensity : uDensity * exp(-(y0 - uTop) * uFalloff)) * dist : (F(y1) - F(y0 - sw)) / rd.y;
  float a = 1.0 - exp(-max(od, 0.0));
  float toSun = pow(max(dot(rd, uSunDir), 0.0), 5.0);
  float lift = smoothstep(uTop - 40.0, uTop + 5.0, min(y0, max(y1, uTop - 40.0)));
  vec3 col = uFogCol * mix(0.8, 1.0, lift) + uSunCol * (0.4 * lift + 0.55 * toSun);
  outputColor = vec4(mix(inputColor.rgb, col, a), inputColor.a);
}`;

export class FogEffect extends Effect {
  constructor(private readonly camera: THREE.PerspectiveCamera) {
    super('GroundFog', FOG, {
      attributes: EffectAttribute.DEPTH,
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, THREE.Uniform>([
        ['uCamWorld', new THREE.Uniform(new THREE.Matrix4())], ['uProjInv', new THREE.Uniform(new THREE.Matrix4())],
        ['uCamPos', new THREE.Uniform(new THREE.Vector3())], ['uTop', new THREE.Uniform(45)], ['uDensity', new THREE.Uniform(0)],
        ['uFalloff', new THREE.Uniform(0.1)], ['uFogCol', new THREE.Uniform(new THREE.Color())], ['uSunCol', new THREE.Uniform(new THREE.Color())],
        ['uSunDir', new THREE.Uniform(new THREE.Vector3(0, 1, 0))], ['uTime', new THREE.Uniform(0)],
      ]),
    });
  }

  u(name: string) { return this.uniforms.get(name)!; }

  update(_r: THREE.WebGLRenderer, _b: THREE.WebGLRenderTarget, dt: number) {
    const c = this.camera;
    this.u('uCamWorld').value.copy(c.matrixWorld);
    this.u('uProjInv').value.copy(c.projectionMatrixInverse);
    this.u('uCamPos').value.copy(c.position);
    this.u('uTime').value += dt;
  }
}

// rain streaks or snowflakes in a box that travels with the camera
const DROPS = 9000;
const PRECIP_V = `
uniform float uTime; uniform vec3 uCam; uniform float uBox; uniform float uSnow; uniform float uSize;
attribute float aEnd;
varying float vA;
void main() {
  vec3 p = position;
  float fall = mix(9.0, 1.1, uSnow), t = uTime * fall;
  p.y -= t;
  p.x += uTime * mix(1.5, 0.5, uSnow) + uSnow * sin(uTime * 0.9 + p.z * 0.7) * 0.6;
  p.z += uSnow * cos(uTime * 0.7 + p.x * 0.5) * 0.6;
  p = uCam + mod(p - uCam + uBox * 0.5, uBox) - uBox * 0.5;
  if (aEnd > 0.5) p += vec3(-0.015, 0.9, 0.0) * (1.0 - uSnow);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(uSize / -mv.z, 5.0);
  vA = smoothstep(uBox * 0.5, uBox * 0.2, length(p - uCam)) * smoothstep(1.5, 4.0, -mv.z);
}`;
const PRECIP_F = `
uniform float uSnow; uniform vec3 uCol; varying float vA;
void main() {
  float a = vA;
  if (uSnow > 0.5) { vec2 q = gl_PointCoord - 0.5; a *= smoothstep(0.5, 0.2, length(q)); }
  gl_FragColor = vec4(uCol, a * mix(0.28, 0.85, uSnow));
}`;

export class Precip {
  private readonly rain: THREE.LineSegments;
  private readonly snow: THREE.Points;
  private readonly uniforms = {
    uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uBox: { value: 60 }, uSnow: { value: 0 }, uSize: { value: 0 },
    uCol: { value: new THREE.Color(0xc8d2dc) },
  };

  constructor(scene: THREE.Scene) {
    const N = DROPS, box = this.uniforms.uBox.value, rnd = () => (Math.random() - 0.5) * box;
    const lines = new Float32Array(N * 6), ends = new Float32Array(N * 2), pts = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const x = rnd(), y = rnd(), z = rnd();
      lines.set([x, y, z, x, y, z], i * 6);
      ends[i * 2 + 1] = 1;
      pts.set([rnd(), rnd(), rnd()], i * 3);
    }
    const mat = (snow: boolean) => new THREE.ShaderMaterial({ vertexShader: PRECIP_V, fragmentShader: PRECIP_F, transparent: true, depthWrite: false,
      uniforms: { ...this.uniforms, uSnow: { value: snow ? 1 : 0 }, uSize: { value: snow ? 40 : 0 } } });
    const lg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(lines, 3)).setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
    const pg = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(pts, 3)).setAttribute('aEnd', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.rain = new THREE.LineSegments(lg, mat(false));
    this.snow = new THREE.Points(pg, mat(true));
    for (const o of [this.rain, this.snow]) { o.frustumCulled = false; o.visible = false; scene.add(o); }
  }

  update(t: number, cam: THREE.Vector3, w: Weather, night: number) {
    this.uniforms.uTime.value = t;
    this.uniforms.uCam.value.copy(cam);
    this.uniforms.uCol.value.setRGB(1, 1, 1).multiplyScalar(1 - 0.75 * night);
    this.rain.visible = w.rain > 0.01;
    this.snow.visible = w.snow > 0.01;
    this.rain.geometry.setDrawRange(0, Math.round(w.rain * DROPS) * 2);
    this.snow.geometry.setDrawRange(0, Math.round(w.snow * DROPS));
  }
}
