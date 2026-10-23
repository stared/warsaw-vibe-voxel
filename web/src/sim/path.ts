export type Pt = { x: number; y: number; z: number };
export type Dir = [number, number];

export interface PathData { p: [number, number, number][] }

export interface Path extends PathData {
  cum: Float32Array;
  L: number;
  startD: Dir;
  endD: Dir;
  startD15: Dir;
  endD15: Dir;
}

export const pt = (): Pt => ({ x: 0, y: 0, z: 0 });

function dirAt(e: PathData, i: number): Dir {
  const a = e.p[i], b = e.p[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// arc lengths and end directions (also over the first and last ~15 m, for classifying turns)
export function prepPath<T extends PathData>(e: T): T & Path {
  const P = e as T & Path, n = e.p.length;
  P.cum = new Float32Array(n);
  for (let i = 1; i < n; i++) P.cum[i] = P.cum[i - 1] + Math.hypot(e.p[i][0] - e.p[i - 1][0], e.p[i][1] - e.p[i - 1][1]);
  P.L = P.cum[n - 1];
  P.startD = dirAt(e, 0);
  P.endD = dirAt(e, n - 2);
  const d = Math.min(15, P.L), a = pt(), b = pt();
  const unit = (): Dir => { const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return [(b.x - a.x) / l, (b.y - a.y) / l]; };
  at(P, P.L - d, 0, a); at(P, P.L, 0, b); P.endD15 = unit();
  at(P, 0, 0, a); at(P, d, 0, b); P.startD15 = unit();
  return P;
}

// the point at arc length s (extended straight beyond either end), off metres to the right
export function at(e: Path, s: number, off: number, out: Pt): Pt {
  let x, y, z, dx, dy;
  if (s <= 0) {
    [dx, dy] = e.startD; const p = e.p[0];
    x = p[0] + dx * s; y = p[1] + dy * s; z = p[2];
  } else if (s >= e.L) {
    [dx, dy] = e.endD; const p = e.p[e.p.length - 1];
    x = p[0] + dx * (s - e.L); y = p[1] + dy * (s - e.L); z = p[2];
  } else {
    const c = e.cum;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] < s) lo = m; else hi = m; }
    const a = e.p[lo], b = e.p[hi], seg = c[hi] - c[lo] || 1e-6, f = (s - c[lo]) / seg;
    x = a[0] + (b[0] - a[0]) * f; y = a[1] + (b[1] - a[1]) * f; z = a[2] + (b[2] - a[2]) * f;
    dx = (b[0] - a[0]) / seg; dy = (b[1] - a[1]) / seg;
  }
  out.x = x - dy * off; out.y = y + dx * off; out.z = z;
  return out;
}

export const Turn = { Left: -1, Straight: 0, Right: 1, Back: 2 } as const;
export type Turn = (typeof Turn)[keyof typeof Turn];

// grid y points south, so a positive cross product is a right turn
export function turnOf(e: Path, n: Path): Turn {
  const A = e.endD15, B = n.startD15;
  const dot = A[0] * B[0] + A[1] * B[1], cross = A[0] * B[1] - A[1] * B[0];
  if (dot < -0.5) return Turn.Back;
  if (dot > 0.75) return Turn.Straight;
  return cross > 0 ? Turn.Right : Turn.Left;
}

// the lane a turn lands in on the next road (lane 0 is the leftmost)
export const landingLane = (t: Turn, lane: number, lanes: number) => (t === Turn.Left ? 0 : t === Turn.Right ? lanes - 1 : Math.min(lane, lanes - 1));

export const cellKey = (x: number, y: number, size: number) => ((x / size) | 0) * 100003 + ((y / size) | 0);
