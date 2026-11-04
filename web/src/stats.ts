type Props = Record<string, string | number | boolean | null>;
interface Sender { on: boolean; key: string; common: Props; send(event: string, props?: Props): void }

const S = (window as unknown as { __stats?: Sender }).__stats;

export function track(event: string, props: Props = {}) {
  S?.send(event, props);
}

export function always(props: Props) {
  if (S) Object.assign(S.common, props);
}

const timers: Record<string, number> = {};
export function trackLater(event: string, props: Props) {
  clearTimeout(timers[event]);
  timers[event] = setTimeout(() => track(event, props), 1500);
}

export function remember(last: Props) {
  try { sessionStorage.setItem('wv-last', JSON.stringify(last)); } catch {}
}

export function startStats() {
  if (!S?.on) return;
  track('start');
  try {
    const last = sessionStorage.getItem('wv-last');
    if (last) track('crashed', JSON.parse(last));
    sessionStorage.setItem('wv-last', '{}');
    addEventListener('pagehide', () => { try { sessionStorage.removeItem('wv-last'); } catch {} });
  } catch {}
  import('posthog-js/dist/module.slim').then(({ default: posthog }) => {
    posthog.init(S.key, {
      api_host: 'https://eu.i.posthog.com',
      defaults: '2026-08-30',
      cookieless_mode: 'always',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      advanced_disable_flags: true,
    });
    posthog.register({ pid: S.common.pid, build: S.common.build });
    posthog.capture('$pageview');
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
