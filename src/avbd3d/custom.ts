// The 3D viewer's Custom scene: any of the showcase scenes built at a chosen size. Each kind
// scales the showcase scene's proportions to about `bodies` bodies (the exact count is what the
// geometry allows) and frames a camera and iteration count to match.

import { boxColumns, boxPile, brickGables, brickRing, type CameraView, chainMail, ragdollCloth } from './bench-scenes.ts';
import type { GpuParams3D } from './gpu/solver.ts';
import type { Solver } from './ref/solver.ts';

export interface CustomKind {
  name: string;
  build(solver: Solver, bodies: number): void;
  camera(bodies: number): CameraView;
  params?: Partial<GpuParams3D>;
}

/** The largest Custom scene (the 506k brick field fits a 4 GB-class GPU's buffers). */
export const CUSTOM_MAX_3D = 500_000;

export const CUSTOM_3D: CustomKind[] = [
  {
    // The 110k ring (radius 80, 40 courses) scaled in both directions: bricks ∝ radius × courses
    name: 'Brick Ring',
    build: (s, n) => {
      const k = Math.sqrt(n / 110_332);
      brickRing(s, 80 * k, Math.max(4, Math.round(40 * k)), Math.max(1, Math.round(4 * k)), 10);
    },
    camera: (n) => {
      const k = Math.sqrt(n / 110_332);
      return { distance: Math.max(20, 215 * k), target: [0, -15 * k, 0], azimuth: -100, elevation: 0.3 };
    },
    params: { iterations: 4 },
  },
  {
    // Walls of 210 bricks (a 20-brick base) on a grid twice as deep as it is wide
    name: 'Brick Walls',
    build: (s, n) => {
      const walls = Math.max(2, n / 210);
      const columns = Math.max(2, Math.round(Math.sqrt(walls / 2)));
      const rows = Math.max(1, Math.round(walls / columns));
      brickGables(s, columns, rows, 20, [Math.floor(columns / 4), Math.floor((3 * columns) / 4)]);
    },
    camera: (n) => {
      const columns = Math.max(2, Math.round(Math.sqrt(Math.max(2, n / 210) / 2)));
      const width = columns * 22;
      return { distance: Math.max(40, 1.3 * width), target: [0, 0, 4], azimuth: -110, elevation: 0.35 };
    },
    params: { iterations: 3 },
  },
  {
    name: 'Box Pile',
    build: (s, n) => boxPile(s, Math.max(2, Math.round(Math.sqrt(n / 20))), 20),
    camera: (n) => ({ distance: Math.max(30, 2.2 * Math.sqrt(n / 20) * 1.6), target: [0, 0, 5], elevation: 0.45 }),
  },
  {
    name: 'Box Columns',
    build: (s, n) => boxColumns(s, Math.max(2, Math.round(Math.sqrt(n / 10))), 10),
    camera: (n) => ({ distance: Math.max(25, 1.9 * Math.sqrt(n / 10)), target: [0, 0, 5], elevation: 0.5 }),
  },
  {
    // About 62% of the bodies in ragdolls (ten layers of side × side), the rest the cloth
    name: 'Ragdolls on Cloth',
    build: (s, n) => {
      const side = Math.max(2, Math.round(Math.sqrt((0.062 * n) / 10)));
      ragdollCloth(s, side, 10, side * 8);
    },
    camera: (n) => {
      const side = Math.max(2, Math.round(Math.sqrt((0.062 * n) / 10)));
      return { distance: Math.max(25, 4.4 * side), target: [0, 0, 6], azimuth: -115, elevation: 0.3 };
    },
    params: { iterations: 10 },
  },
  {
    name: 'Chain Mail',
    build: (s, n) => chainMail(s, Math.max(4, Math.round(Math.sqrt(n)))),
    camera: (n) => ({ distance: Math.max(20, 0.9 * Math.sqrt(n)), target: [0, 0, 9], azimuth: -120, elevation: 0.45 }),
  },
];
