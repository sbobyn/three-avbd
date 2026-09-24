// Scalable scenes for performance work (not in the upstream demo). Built with the reference
// builders like the demo scenes, so every backend can load them.

import { Rigid } from './ref/body.ts';
import { IgnoreCollision, Joint } from './ref/forces.ts';
import type { Solver } from './ref/solver.ts';
import type { SoaSolver2D } from './soa/solver.ts';

/**
 * A scene built either with the reference builders (`build`, loadable by every backend) or
 * straight into SoA arrays (`buildSoa`, for sizes too heavy for reference objects).
 */
export interface SceneDef {
  name: string;
  build?: (solver: Solver) => void;
  buildSoa?: (solver: SoaSolver2D) => void;
  /** Too large for the CPU backends to run interactively. */
  gpuOnly?: boolean;
}

/** Pyramid of `size` rows of 1 x 0.5 boxes (size = 20 is the demo's Pyramid). */
export function pyramid(solver: Solver, size: number): void {
  solver.clear();
  new Rigid(solver, [Math.max(100, size * 1.5), 0.5], 0, 0.5, [0, -2, 0]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size - y; x++) new Rigid(solver, [1, 0.5], 1, 0.5, [x * 1.1 + y * 0.5 - size / 2, y * 0.85, 0]);
  }
}

/** A W x H grid of boxes (slightly jittered sizes) dropped into a walled container. */
export function boxRain(solver: Solver, cols: number, rows: number): void {
  solver.clear();
  const width = cols * 1.2 + 4;
  new Rigid(solver, [width + 2, 1], 0, 0.5, [0, -0.5, 0]);
  new Rigid(solver, [1, rows * 1.4 + 10], 0, 0.5, [-width / 2, (rows * 1.4 + 10) / 2, 0]);
  new Rigid(solver, [1, rows * 1.4 + 10], 0, 0.5, [width / 2, (rows * 1.4 + 10) / 2, 0]);
  let seed = 1;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const w = 0.6 + rand() * 0.5;
      const h = 0.6 + rand() * 0.5;
      new Rigid(solver, [w, h], 1, 0.5, [x * 1.2 - (cols - 1) * 0.6, 2 + y * 1.4, rand() * 0.5]);
    }
  }
}

/** Hard-jointed W x H lattice pinned at its top corners (the demo's Joint Grid, scaled). */
export function jointLattice(solver: Solver, W: number, H: number): void {
  solver.clear();
  const grid: Rigid[][] = [];
  for (let x = 0; x < W; x++) {
    grid.push([]);
    for (let y = 0; y < H; y++) {
      const pinned = y === H - 1 && (x === 0 || x === W - 1);
      grid[x].push(new Rigid(solver, [1, 1], pinned ? 0 : 1, 0.5, [x, y, 0]));
    }
  }
  for (let x = 1; x < W; x++) for (let y = 0; y < H; y++) new Joint(solver, grid[x - 1][y], grid[x][y], [0.5, 0], [-0.5, 0]);
  for (let x = 0; x < W; x++) for (let y = 1; y < H; y++) new Joint(solver, grid[x][y - 1], grid[x][y], [0, 0.5], [0, -0.5]);
  for (let x = 1; x < W; x++) {
    for (let y = 1; y < H; y++) {
      new IgnoreCollision(solver, grid[x - 1][y - 1], grid[x][y]);
      new IgnoreCollision(solver, grid[x][y - 1], grid[x - 1][y]);
    }
  }
}

/** A wall of `cols` x `rows` bricks hit by a heavy fast block (2D analogue of paper Fig. 1). */
export function wreckingBall(solver: Solver, cols: number, rows: number): void {
  solver.clear();
  new Rigid(solver, [cols * 3 + 200, 1], 0, 0.6, [0, -0.5, 0]);
  for (let y = 0; y < rows; y++) {
    const offset = y % 2 === 0 ? 0 : 0.5;
    for (let x = 0; x < cols; x++) new Rigid(solver, [1, 0.5], 1, 0.6, [(x + offset - cols / 2) * 1.0, 0.25 + y * 0.5, 0]);
  }
  const size = Math.max(3, rows * 0.15);
  new Rigid(solver, [size, size], 20, 0.5, [-cols / 2 - size * 2 - 5, rows * 0.25, 0], [40, 0, 0]);
}

export const benchScenes: SceneDef[] = [
  { name: 'Pyramid 50 (1.3k)', build: (s) => pyramid(s, 50) },
  { name: 'Pyramid 100 (5k)', build: (s) => pyramid(s, 100) },
  { name: 'Box Rain 40x25 (1k)', build: (s) => boxRain(s, 40, 25) },
  { name: 'Box Rain 100x50 (5k)', build: (s) => boxRain(s, 100, 50) },
  { name: 'Joint Lattice 64x64 (4k)', build: (s) => jointLattice(s, 64, 64) },
  { name: 'Wrecking Ball 100x40 (4k)', build: (s) => wreckingBall(s, 100, 40) },
  { name: 'Pyramid 200 (20k)', build: (s) => pyramid(s, 200), gpuOnly: true },
  { name: 'Box Rain 900x100 (90k)', build: (s) => boxRain(s, 900, 100), gpuOnly: true },
  { name: 'Wrecking Ball 400x100 (40k)', build: (s) => wreckingBall(s, 400, 100), gpuOnly: true },
  { name: 'Joint Lattice 320x320 (100k)', buildSoa: (s) => jointLatticeSoa(s, 320, 320), gpuOnly: true },
  { name: 'Joint Lattice 512x512 (262k)', buildSoa: (s) => jointLatticeSoa(s, 512, 512), gpuOnly: true },
];

/**
 * `jointLattice` built straight into a SoA solver, for sizes where the reference objects
 * (hundreds of thousands of Joint instances) would be too heavy. Same layout and pins.
 */
export function jointLatticeSoa(s: SoaSolver2D, W: number, H: number): void {
  s.clear();
  const id = (x: number, y: number) => x * H + y;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      const pinned = y === H - 1 && (x === 0 || x === W - 1);
      s.addBody([1, 1], pinned ? 0 : 1, 0.5, [x, y, 0]);
    }
  }
  for (let x = 1; x < W; x++) for (let y = 0; y < H; y++) s.addJoint(id(x - 1, y), id(x, y), [0.5, 0], [-0.5, 0]);
  for (let x = 0; x < W; x++) for (let y = 1; y < H; y++) s.addJoint(id(x, y - 1), id(x, y), [0, 0.5], [0, -0.5]);
  for (let x = 1; x < W; x++) {
    for (let y = 1; y < H; y++) {
      s.addIgnoreCollision(id(x - 1, y - 1), id(x, y));
      s.addIgnoreCollision(id(x, y - 1), id(x - 1, y));
    }
  }
}

/** `boxRain` built straight into a SoA solver (same container, boxes and random sequence). */
export function boxRainSoa(s: SoaSolver2D, cols: number, rows: number): void {
  s.clear();
  const width = cols * 1.2 + 4;
  s.addBody([width + 2, 1], 0, 0.5, [0, -0.5, 0]);
  s.addBody([1, rows * 1.4 + 10], 0, 0.5, [-width / 2, (rows * 1.4 + 10) / 2, 0]);
  s.addBody([1, rows * 1.4 + 10], 0, 0.5, [width / 2, (rows * 1.4 + 10) / 2, 0]);
  let seed = 1;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const w = 0.6 + rand() * 0.5;
      const h = 0.6 + rand() * 0.5;
      s.addBody([w, h], 1, 0.5, [x * 1.2 - (cols - 1) * 0.6, 2 + y * 1.4, rand() * 0.5]);
    }
  }
}
