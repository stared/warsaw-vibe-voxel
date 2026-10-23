import type * as THREE from 'three';
import type { Path, PathData } from './path';

export interface SignalRef { ctrl: number; axis: number }
export interface Controller { x: number; y: number; off: number }

export interface RoadData extends PathData {
  a: number; b: number; w: number;
  lanes: number;
  v: number;
  c: number;
  o0: number;
  sig?: SignalRef & { s: number };
}
export interface Road extends RoadData, Path { i: number; lists: Car[][] }

export interface PedData extends PathData { a: number; b: number; w: number; x?: SignalRef }
export interface PedEdge extends PedData, Path { i: number }

export interface TramStop extends SignalRef { s: number }
export type TramCrossing = { kind: 'road'; e: number; sR: number; sT: number } | { kind: 'diamond'; id: number; sT: number };
export interface TramPathData extends PathData { ref?: string }
export interface TramPath extends TramPathData, Path { i: number; stops: TramStop[]; nextSpawn: number; xs: TramCrossing[] }

export interface TrafficData {
  roads: RoadData[];
  peds: PedData[];
  ctrls: { x: number; y: number }[];
  heads?: [number, number, number, number, number, number][];
  trams?: TramPathData[];
  restr?: [number, number, number, string][];
}

// why an agent waits, and for whom: the chains these form are where deadlocks are found and broken
interface Blocked {
  v: number;
  why: string;
  by: Agent | null;
  ignore?: Agent | null;
  ignoreT?: number;
  rp?: THREE.Vector3;
  rh?: number;
}

export interface Car extends Blocked {
  kind: 'car';
  id: number;
  e: number;
  lane: number;
  lcTo?: number;
  s: number;
  off: number;
  len: number;
  bus: boolean;
  col: THREE.Color;
  v0f: number;
  prev: number;
  prevOff: number;
  next: number;
  brake: number;
  wait: number;
  ghost: number;
  ds: number;
  dOff: number;
  boxNode: number;
  boxFrom: number;
  boxTo: number;
  boxLane: number;
  boxT: number;
  boxTurn: number;
  geo: { px: number; py: number; cx: number; cy: number; z: number; fx: number; fy: number };
  block: { o: Car; gap: number } | null;
}

export interface Tram extends Blocked {
  kind: 'tram';
  p: number;
  s: number;
  ds: number;
  near: boolean;
  yieldTo: number;
}

export interface Person {
  kind: 'person';
  e: number;
  dir: number;
  s: number;
  v: number;
  lat: number;
  ph: number;
  wait: boolean;
  col: THREE.Color;
  rp?: THREE.Vector3;
  rh?: number;
  ctl?: { x: number; y: number; z: number; h: number; moving: boolean };
}

export type Agent = Car | Tram;
export type Rideable = Car | Tram | Person;
export type Kind = 'car' | 'tram' | 'person';
export interface Pose { x: number; y: number; z: number; h: number }
