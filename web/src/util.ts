import * as THREE from 'three';

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
export const ease = (t: number) => t * t * (3 - 2 * t);
export const smooth = (a: number, b: number, x: number) => ease(clamp((x - a) / (b - a), 0, 1));
export const hash = (n: number) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
export const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export const coarsePointer = () => matchMedia('(pointer: coarse)').matches;

export function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export async function gunzip(data: ArrayBuffer | ReadableStream<Uint8Array<ArrayBuffer>>): Promise<ArrayBuffer> {
  const stream = data instanceof ArrayBuffer ? new Blob([data]).stream() : data;
  return new Response(stream.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export async function fetchGzip(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${res.status} ${url}`);
  return gunzip(res.body);
}

export const fetchJson = <T>(url: string): Promise<T> => fetch(url).then((r) => r.json() as Promise<T>);

export function dataTexture(data: Uint8Array | Uint16Array, w: number, h: number, format: THREE.PixelFormat,
  type: THREE.TextureDataType = THREE.UnsignedByteType) {
  const t = new THREE.DataTexture(data, w, h, format, type);
  t.unpackAlignment = data.BYTES_PER_ELEMENT;
  t.needsUpdate = true;
  return t;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, html = '', parent: HTMLElement = document.body) {
  const e = document.createElement(tag);
  e.className = className;
  e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const e = root.querySelector<T>(sel);
  if (!e) throw new Error(`missing ${sel}`);
  return e;
}
