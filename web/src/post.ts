import * as THREE from 'three';
import { N8AOPostPass } from 'n8ao';
import { BloomEffect, BrightnessContrastEffect, Effect, EffectAttribute, EffectComposer, EffectPass, HueSaturationEffect, RenderPass,
  SMAAEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { clamp } from './util';

// The miniature look by depth, not by screen band: each pixel blurs by how far its distance is from the focus (what
// the camera looks at), in ratio, so the whole plane of the subject stays sharp -- a tower's clock as much as its base.
// A gather over a disc; a sample counts only if it is itself as blurred as its offset, so sharp edges don't smear out.
const DOF = `uniform float focus; uniform float strength; uniform float maxPx;
float coc(float depth) {
  float d = -getViewZ(depth);
  return strength * maxPx * smoothstep(0.12, 0.9, abs(log(d / focus)));
}
void mainImage(const in vec4 inputColor, const in vec2 uv, const in float depth, out vec4 outputColor) {
  float r = coc(depth);
  if (r < 0.5) { outputColor = inputColor; return; }
  vec3 sum = inputColor.rgb; float n = 1.0;
  for (int i = 1; i < 24; i++) {
    float t = float(i) / 24.0, a = float(i) * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * sqrt(t) * r;
    vec2 q = uv + o * texelSize;
    float w = smoothstep(length(o) - 1.0, length(o), coc(readDepth(q)));
    sum += texture2D(inputBuffer, q).rgb * w; n += w;
  }
  outputColor = vec4(sum / n, inputColor.a);
}`;

class DepthBlur extends Effect {
  constructor() {
    super('DepthBlur', DOF, { attributes: EffectAttribute.DEPTH | EffectAttribute.CONVOLUTION,
      uniforms: new Map([['focus', new THREE.Uniform(500)], ['strength', new THREE.Uniform(0)], ['maxPx', new THREE.Uniform(5)]]) });
  }
  set(focus: number, strength: number, height: number) {
    this.uniforms.get('focus')!.value = focus;
    this.uniforms.get('strength')!.value = strength;
    this.uniforms.get('maxPx')!.value = 5 * height / 1000;
  }
}

export function makePost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  const n8 = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  Object.assign(n8.configuration, { aoRadius: 6, distanceFalloff: 1.5, intensity: 2.2, halfRes: true, depthAwareUpsampling: true });
  composer.addPass(n8);
  const bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.92, luminanceSmoothing: 0.15, mipmapBlur: true, radius: 0.55 });
  const tilt = new DepthBlur();
  const tiltPass = new EffectPass(camera, tilt);
  composer.addPass(new EffectPass(camera, bloom));
  composer.addPass(tiltPass);
  composer.addPass(new EffectPass(camera,
    tone,
    new HueSaturationEffect({ saturation: 0.12 }),
    new BrightnessContrastEffect({ brightness: 0, contrast: 0.06 }),
    new VignetteEffect({ offset: 0.3, darkness: 0.45 }),
    new SMAAEffect()));
  // focused on what the camera looks at; the blur fades out towards the street, and eases over the whole map
  const setHeight = (h: number, enabled: boolean, focus = 500) => {
    tiltPass.enabled = enabled && h > 60;
    tilt.set(focus, clamp((h - 60) / 250, 0, 1) * (1 - 0.5 * clamp((h - 1200) / 1500, 0, 1)), renderer.domElement.height);
  };
  return { composer, n8, bloom, tone, setHeight };
}
