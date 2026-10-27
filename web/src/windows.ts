import * as THREE from 'three';
import type { Meta } from './types';
import { dataTexture, fetchGzip, fetchJson } from './util';
import type { VoxelUniforms } from './voxelMaterial';

interface WinType { med: { weekday: number[]; weekend: number[] }; shape: number[]; floors: number; colour: [number, number, number] }
interface WinStats { bins: [number, number][]; types: Record<string, WinType> }

// building kinds in windows.bin (scripts/windows.py) and the measured type each one follows (scripts/window_stats.py)
const KIND_MODEL = ['residential', 'residential', 'office', 'hotel', 'office', 'public', 'religious', 'public'];
const CENTRES = [16.5, 18.5, 20.5, 22.5, 27];

export async function loadWindows(meta: Meta, U: VoxelUniforms) {
  const [stats, buf] = await Promise.all([fetchJson<WinStats>('data/windows.json'), fetchGzip('data/windows.bin')]);
  const tex = dataTexture(new Uint8Array(buf), meta.W, meta.D, THREE.RedFormat);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  U.uWinMap.value = tex;
  KIND_MODEL.forEach((m, k) => {
    const t = stats.types[m];
    t.shape.forEach((q, i) => { U.uWinShape.value[k * 9 + i] = q; });
    U.uWinFloors.value[k] = t.floors;
    U.uWinCol.value[k].set(...t.colour);
  });
  return (hour: number, day: number) => setWindows(U, stats, hour, day);
}

function setWindows(U: VoxelUniforms, stats: WinStats, hour: number, day: number) {
  const weekday = new Date(Date.UTC(2026, 0, day)).getUTCDay(), weekend = weekday === 0 || weekday === 6;
  const t = hour < 12 ? hour + 24 : hour;
  const i = CENTRES.findIndex((c) => c > t), a = i < 0 ? CENTRES.length - 1 : Math.max(i - 1, 0), b = i < 0 ? a : i;
  const f = a === b ? 0 : (t - CENTRES[a]) / (CENTRES[b] - CENTRES[a]);
  KIND_MODEL.forEach((m, k) => {
    const med = stats.types[m].med[weekend ? 'weekend' : 'weekday'];
    U.uWinMed.value[k] = med[a] + (med[b] - med[a]) * Math.min(Math.max(f, 0), 1);
  });
}
