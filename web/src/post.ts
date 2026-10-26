import * as THREE from 'three';
import { N8AOPostPass } from 'n8ao';
import { BloomEffect, BrightnessContrastEffect, EffectComposer, EffectPass, HueSaturationEffect, RenderPass, SMAAEffect,
  TiltShiftEffect, ToneMappingEffect, ToneMappingMode, VignetteEffect } from 'postprocessing';
import { clamp } from './util';

export function makePost(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
  const tone = new ToneMappingEffect({ mode: ToneMappingMode.NEUTRAL });
  const composer = new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType, multisampling: 0 });
  composer.addPass(new RenderPass(scene, camera));
  const n8 = new N8AOPostPass(scene, camera, innerWidth, innerHeight);
  Object.assign(n8.configuration, { aoRadius: 6, distanceFalloff: 1.5, intensity: 2.2, halfRes: true, depthAwareUpsampling: true });
  composer.addPass(n8);
  const bloom = new BloomEffect({ intensity: 0.2, luminanceThreshold: 0.92, luminanceSmoothing: 0.15, mipmapBlur: true, radius: 0.55 });
  const tilt = new TiltShiftEffect({ offset: 0.0, rotation: 0, focusArea: 0.8, feather: 0.22, kernelSize: 2 });
  const tiltPass = new EffectPass(camera, tilt);
  composer.addPass(new EffectPass(camera, bloom));
  composer.addPass(tiltPass);
  composer.addPass(new EffectPass(camera,
    tone,
    new HueSaturationEffect({ saturation: 0.12 }),
    new BrightnessContrastEffect({ brightness: 0, contrast: 0.06 }),
    new VignetteEffect({ offset: 0.3, darkness: 0.45 }),
    new SMAAEffect()));
  // the blur fades out towards the street, and widens again over the whole map
  const setHeight = (h: number, enabled: boolean) => {
    tiltPass.enabled = enabled && h > 60;
    tilt.focusArea = 0.8 + 0.2 * (1 - clamp((h - 60) / 250, 0, 1)) + 0.2 * clamp((h - 1200) / 1500, 0, 1);
  };
  return { composer, n8, bloom, tone, setHeight };
}
