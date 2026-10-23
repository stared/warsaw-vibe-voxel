export type Vec3Tuple = [number, number, number];

export interface View {
  label: string;
  pos: Vec3Tuple;
  target: Vec3Tuple;
  ms?: number;
}

export interface Label {
  name: string;
  note: string;
  alt?: string;
  x: number;
  y: number;
  z: number;
  g?: number;
  R?: number;
  highlight?: boolean;
}

export interface TileLevel {
  s: number;
  nx: number;
  ny: number;
}

export interface Meta {
  W: number;
  D: number;
  H: number;
  base: number;
  theta_deg: number;
  tiles: { N: number; levels: TileLevel[] };
  palette: [number, number, number, number][];
  lamps: [number, number, number][];
  floods?: [number, number, number][];
  jets?: [number, number, number][];
  labels: Label[];
  views: Record<string, View>;
  sources: { osm: string };
}

export interface FloodInfo {
  lidar_cm: number;
  base: number;
  surface0: number;
  fall: number;
}

export interface Zones {
  blocks: number[][];
  buildings: number[][];
}

export type Place = [name: string, kind: string, x: number, y: number, size: number, alt: string];

export interface ColumnData {
  s: number;
  x0: number;
  y0: number;
  S: number;
  counts: Uint16Array;
  ground: Uint8Array;
  runs: Uint16Array;
  off: Uint32Array;
}
