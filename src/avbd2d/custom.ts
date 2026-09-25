// The 2D demo's Custom scene: any of the scaling scenes built at a chosen size (up to a million
// bodies on the GPU). The demo's panel sets `custom2D`; each kind scales its scene's layout to
// about that many bodies and frames the view (`zoom` in pixels per metre for a view `width` px
// wide). Box Rain grows wide past 200 rows: taller, boxes land fast enough to pass the ground.

import { boxRain, boxRainSoa, jointLattice, jointLatticeSoa, pyramid, type SceneDef, wreckingBall } from './bench-scenes.ts';
import { Solver } from './ref/solver.ts';
import type { SoaSolver2D } from './soa/solver.ts';

export interface CustomKind2D {
  name: string;
  build(solver: Solver, bodies: number): void;
  /** Straight into SoA arrays (for sizes too heavy for reference objects), if it has one. */
  buildSoa?(solver: SoaSolver2D, bodies: number): void;
  camera(bodies: number, width: number): { x: number; y: number; zoom: number };
}

export const CUSTOM_MAX_2D = 1_000_000;

/** The Custom scene's current kind (an index into CUSTOM_2D) and target body count. */
export const custom2D = { kind: 0, bodies: 20_000 };

const rain = (n: number) => {
  const rows = Math.min(200, Math.max(10, Math.round(Math.sqrt(n) / 5)));
  return { rows, cols: Math.max(10, Math.round(n / rows)) };
};
const side = (n: number) => Math.max(4, Math.round(Math.sqrt(n)));
const wall = (n: number) => {
  const rows = Math.max(4, Math.round(Math.sqrt(n / 4)));
  return { rows, cols: 4 * rows };
};

export const CUSTOM_2D: CustomKind2D[] = [
  {
    name: 'Box Rain',
    build: (s, n) => boxRain(s, rain(n).cols, rain(n).rows),
    buildSoa: (s, n) => boxRainSoa(s, rain(n).cols, rain(n).rows),
    camera: (n, width) => ({ x: 0, y: rain(n).rows * 0.45, zoom: width / (rain(n).cols * 1.2 * 1.1) }),
  },
  {
    name: 'Joint Lattice',
    build: (s, n) => jointLattice(s, side(n), side(n)),
    buildSoa: (s, n) => jointLatticeSoa(s, side(n), side(n)),
    camera: (n, width) => ({ x: side(n) / 2, y: side(n) * 0.35, zoom: width / (side(n) * 1.6) }),
  },
  {
    // n(n + 1) / 2 boxes in n rows
    name: 'Pyramid',
    build: (s, n) => pyramid(s, Math.max(4, Math.round(Math.sqrt(2 * n)))),
    camera: (n, width) => {
      const size = Math.max(4, Math.round(Math.sqrt(2 * n)));
      return { x: 0, y: size * 0.35, zoom: width / (size * 1.3) };
    },
  },
  {
    name: 'Wrecking Ball',
    build: (s, n) => wreckingBall(s, wall(n).cols, wall(n).rows),
    camera: (n, width) => ({ x: -wall(n).cols * 0.2, y: wall(n).rows * 0.3, zoom: width / (wall(n).cols * 1.8) }),
  },
];

/** The Custom scene, for the demo's scene list (GPU only: its sizes go far past the CPU's). */
export const customScene2D: SceneDef = {
  name: 'Custom',
  build: (s) => CUSTOM_2D[custom2D.kind].build(s, custom2D.bodies),
  buildSoa: (s) => {
    const kind = CUSTOM_2D[custom2D.kind];
    if (kind.buildSoa) return kind.buildSoa(s, custom2D.bodies);
    const ref = new Solver();
    kind.build(ref, custom2D.bodies);
    s.loadFromReference(ref);
  },
  gpuOnly: true,
};
