// Large 3D scenes for the GPU solver: benchmarks and the viewer's GPU-only showcase scenes
// (after the paper's figures). Built with the reference's Rigid/Joint so mass properties and
// joint conventions match the demo's; spheres come from ./shapes.ts.

import { Rigid } from './ref/body.ts';
import { Joint } from './ref/forces.ts';
import type { Solver } from './ref/solver.ts';
import { sphere } from './shapes.ts';

/** A ground slab sized to hold `extent` metres of content, top face at z = 0.5. */
function ground(solver: Solver, extent: number): Rigid {
  const size = Math.max(100, 2 * extent + 20);
  return new Rigid(solver, [size, size, 1], 0, 0.5, [0, 0, 0]);
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
}

/** n × n columns of h unit boxes, each resting on the one below (settled stacks). */
export function boxColumns(solver: Solver, n: number, h: number): void {
  solver.clear();
  ground(solver, n * 1.5);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      for (let z = 0; z < h; z++) new Rigid(solver, [1, 1, 1], 1, 0.5, [(x - n / 2) * 1.5, (y - n / 2) * 1.5, 1 + z]);
    }
  }
}

/** An n × n × h block of randomly sized and turned boxes dropped into a pile. */
export function boxPile(solver: Solver, n: number, h: number): void {
  solver.clear();
  ground(solver, n * 1.6);
  const rand = random(12345);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const size = [0.5 + rand() * 0.7, 0.5 + rand() * 0.7, 0.5 + rand() * 0.7];
        const b = new Rigid(solver, size, 1, 0.5, [(x - n / 2) * 1.6, (y - n / 2) * 1.6, 2 + z * 1.6]);
        const q = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
        const l = Math.hypot(...q);
        b.positionAng.set(q.map((c) => c / l));
      }
    }
  }
}

/**
 * Paper Fig. 1/3: a wall of bricks (w wide, h high, two deep) smashed by a heavy ball.
 * Bricks rest exactly on each other; the ball is launched along +y.
 */
export function wallSmash(solver: Solver, w = 40, h = 25): void {
  solver.clear();
  ground(solver, 4 * w);
  for (let z = 0; z < h; z++) {
    // Running bond: every other course is offset by half a brick
    const offset = z % 2 === 0 ? 0 : 0.5;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < 2; y++) new Rigid(solver, [1, 0.5, 0.5], 1, 0.6, [(x - w / 2) * 1.0 + offset, y * 0.5, 0.75 + z * 0.5]);
    }
  }
  sphere(solver, 2, 20, 0.5, [0, -25, 5], [0, 30, 4]);
}

/**
 * Paper Fig. 13: a breakable wall. Bricks are welded to their neighbours with hard joints
 * (position and angle) that fracture when the angular force exceeds `strength`, and a ball
 * is thrown through it.
 */
export function breakableWall(solver: Solver, w = 30, h = 20, strength = 50): void {
  solver.clear();
  ground(solver, 4 * w);
  const bricks: Rigid[][] = [];
  for (let z = 0; z < h; z++) {
    bricks.push([]);
    for (let x = 0; x < w; x++) bricks[z].push(new Rigid(solver, [1, 0.5, 0.5], 1, 0.6, [x - w / 2 + 0.5, 0, 0.75 + z * 0.5]));
  }
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (x > 0) new Joint(solver, bricks[z][x - 1], bricks[z][x], [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, strength);
      if (z > 0) new Joint(solver, bricks[z - 1][x], bricks[z][x], [0, 0, 0.25], [0, 0, -0.25], Infinity, Infinity, strength);
    }
  }
  sphere(solver, 1.5, 20, 0.5, [0, -20, 4], [0, 25, 3]);
}

/**
 * Paper Fig. 12: chain mail. An n × n net of thin links, each joined to its neighbours by a
 * ball joint at the shared edge, hung from its four corners, catches a heavy ball.
 */
export function chainMail(solver: Solver, n = 40, ballDensity = 10): void {
  solver.clear();
  ground(solver, n * 0.5);
  const s = 0.5;
  const links: Rigid[][] = [];
  const z = 12;
  for (let x = 0; x < n; x++) {
    links.push([]);
    for (let y = 0; y < n; y++) {
      const corner = (x === 0 || x === n - 1) && (y === 0 || y === n - 1);
      links[x].push(new Rigid(solver, [s * 0.9, s * 0.9, 0.1], corner ? 0 : 1, 0.5, [(x - (n - 1) / 2) * s, (y - (n - 1) / 2) * s, z]));
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (x > 0) new Joint(solver, links[x - 1][y], links[x][y], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (y > 0) new Joint(solver, links[x][y - 1], links[x][y], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  sphere(solver, 2, ballDensity, 0.5, [0, 0, z + 6]);
}

/**
 * Paper Fig. 7: a pendulum of `links` light links carrying a block `ratio` times heavier
 * than one link, released horizontally from a fixed anchor.
 */
export function heavyPendulum(solver: Solver, links = 50, ratio = 50000): void {
  solver.clear();
  ground(solver, links * 0.5);
  const len = 0.5;
  const top = links * len + 5;
  const anchor = new Rigid(solver, [0.5, 0.5, 0.5], 0, 0.5, [0, 0, top]);
  let prev = anchor;
  let prevOffset = 0.25;
  for (let i = 0; i < links; i++) {
    const link = new Rigid(solver, [len, 0.1, 0.1], 1, 0.5, [0.25 + len * (i + 0.5), 0, top]);
    new Joint(solver, prev, link, [prevOffset, 0, 0], [-len / 2, 0, 0]);
    prev = link;
    prevOffset = len / 2;
  }
  // Block of mass ratio × link mass (link mass = len · 0.1 · 0.1)
  const block = 1.5;
  const density = (ratio * len * 0.01) / block ** 3;
  const weight = new Rigid(solver, [block, block, block], density, 0.5, [0.25 + len * links + block / 2, 0, top]);
  new Joint(solver, prev, weight, [len / 2, 0, 0], [-block / 2, 0, 0]);
}

/** Orbit camera framing for a scene (z up; azimuth in degrees, 90 = looking along -y). */
export interface CameraView {
  distance: number;
  target: [number, number, number];
  azimuth?: number;
  elevation?: number;
}

export interface Scene3D {
  name: string;
  build: (solver: Solver) => void;
  /** Uses GPU-only features (spheres) or is too large for the CPU reference. */
  gpuOnly?: boolean;
  camera?: CameraView;
}

/** The viewer's GPU showcase scenes, after the paper's figures, plus scale tests. */
export const gpuScenes3D: Scene3D[] = [
  { name: 'Wall Smash (2k)', build: (s) => wallSmash(s), gpuOnly: true, camera: { distance: 55, target: [0, 0, 5], azimuth: -120, elevation: 0.3 } },
  { name: 'Breakable Wall (600)', build: (s) => breakableWall(s), gpuOnly: true, camera: { distance: 45, target: [0, 0, 5], azimuth: -120, elevation: 0.3 } },
  { name: 'Chain Mail (1.6k)', build: (s) => chainMail(s), gpuOnly: true, camera: { distance: 35, target: [0, 0, 9], azimuth: -120, elevation: 0.45 } },
  { name: 'Heavy Pendulum 50000:1', build: (s) => heavyPendulum(s), gpuOnly: true, camera: { distance: 70, target: [0, 0, 16], azimuth: 90, elevation: 0.15 } },
  { name: 'Box Pile (4k)', build: (s) => boxPile(s, 20, 10), gpuOnly: true, camera: { distance: 55, target: [0, 0, 4], elevation: 0.45 } },
  { name: 'Box Pile (32k)', build: (s) => boxPile(s, 40, 20), gpuOnly: true, camera: { distance: 110, target: [0, 0, 6], elevation: 0.45 } },
  { name: 'Box Columns (100k)', build: (s) => boxColumns(s, 100, 10), gpuOnly: true, camera: { distance: 190, target: [0, 0, 5], elevation: 0.5 } },
];
