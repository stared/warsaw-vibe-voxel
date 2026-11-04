import type { PostHog } from 'posthog-js/dist/module.slim';

type Props = Record<string, string | number | boolean | null>;

const KEY: string | undefined = import.meta.env.VITE_POSTHOG_PROJECT_TOKEN;
const ON = !!KEY && (location.hostname === 'p.migdal.pl' || new URLSearchParams(location.search).has('stats'));
const queue: [string, Props][] = [];
let ph: PostHog | null = null;
let errors = 0;

export function track(event: string, props: Props = {}) {
  if (!ON) return;
  if (ph) ph.capture(event, props);
  else queue.push([event, props]);
}

const timers: Record<string, number> = {};
export function trackLater(event: string, props: Props) {
  clearTimeout(timers[event]);
  timers[event] = setTimeout(() => track(event, props), 1500);
}

export function startStats(canvas: HTMLCanvasElement) {
  if (!ON) return;
  try {
    if (sessionStorage.getItem('wv-alive')) track('crashed');
    sessionStorage.setItem('wv-alive', '1');
    addEventListener('pagehide', () => { try { sessionStorage.removeItem('wv-alive'); } catch {} });
  } catch {}
  canvas.addEventListener('webglcontextlost', () => track('contextlost'));
  addEventListener('error', (e) => { if (errors++ < 3) track('error', { message: String(e.message).slice(0, 200) }); });
  addEventListener('unhandledrejection', (e) => { if (errors++ < 3) track('error', { message: String(e.reason).slice(0, 200) }); });
  import('posthog-js/dist/module.slim').then(({ default: posthog }) => {
    posthog.init(KEY!, {
      api_host: 'https://eu.i.posthog.com',
      defaults: '2026-08-30',
      cookieless_mode: 'always',
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
      capture_pageview: true,
      capture_pageleave: true,
    });
    ph = posthog;
    for (const [e, p] of queue.splice(0)) posthog.capture(e, p);
  }).catch(() => {});
}

export function gpu(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const plain = String(gl.getParameter(gl.RENDERER));
  if (plain !== 'WebKit WebGL') return plain;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : plain;
}

export function blank(gl: WebGLRenderingContext | WebGL2RenderingContext) {
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(4), seen = new Set<string>();
  for (let i = 1; i < 8; i++)
    for (let j = 1; j < 8; j++) {
      gl.readPixels(Math.floor(w * i / 8), Math.floor(h * j / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      seen.add(`${px[0] >> 3},${px[1] >> 3},${px[2] >> 3}`);
    }
  return seen.size === 1 ? [...seen][0] : null;
}
