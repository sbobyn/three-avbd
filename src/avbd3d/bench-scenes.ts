// Large 3D scenes for the GPU solver: benchmarks and the viewer's GPU-only showcase scenes
// (after the paper's figures). Built with the reference's Rigid/Joint so mass properties and
// joint conventions match the demo's; spheres come from ./shapes.ts.

import { Rigid } from './ref/body.ts';
import { Joint } from './ref/forces.ts';
import type { Solver, SolverParams } from './ref/solver.ts';
import { sphere } from './shapes.ts';

/**
 * A ground slab sized to hold `extent` metres of content with room for debris to scatter (the
 * viewer draws the floor on to the horizon, so bodies must not slide off an unseen edge), top
 * face at z = 0.5.
 */
function ground(solver: Solver, extent: number): Rigid {
  const size = Math.max(200, 4 * extent);
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

/** A brick (1 × 0.5 × 0.5, as in the demo's pyramid) turned `angle` about z. */
function brick(solver: Solver, x: number, y: number, z: number, angle = 0): Rigid {
  const b = new Rigid(solver, [1, 0.5, 0.5], 1, 0.5, [x, y, z]);
  b.positionAng.set([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
  return b;
}

/** A sphere resting on the ground (top face z = 0.5) at (x, y), rolling along +y at `speed`. */
function rollingBall(solver: Solver, r: number, density: number, x: number, y: number, speed: number): Rigid {
  const ball = sphere(solver, r, density, 0.5, [x, y, 0.5 + r], [0, speed, 0]);
  ball.velocityAng.set([-speed / r, 0, 0]);
  return ball;
}

/**
 * Paper Fig. 1: a ring wall of bricks smashed by a sphere rolling in from outside, through the
 * near wall, across the arena and out through the far wall. `courses` courses of bricks laid
 * tangentially in running bond on rings from `radius` outwards, `rows` bricks deep at the
 * bottom and one fewer every `tier` courses, so the outside is stepped and the inside sheer.
 * Bricks rest exactly on each other, so it stands from the first frame and a benchmark can time
 * the smash without a settle. The ball is 0.8 of the wall's height across, as in the paper's
 * renders. Defaults: 110,332 bricks, 20 m high, 160 m across.
 */
export function brickRing(solver: Solver, radius = 80, courses = 40, tier = 4, rows = 10): void {
  solver.clear();
  ground(solver, radius + rows);
  for (let c = 0; c < courses; c++) {
    const depth = Math.max(1, rows - Math.floor(c / tier));
    for (let j = 0; j < depth; j++) {
      // Rings 2 cm apart: a straight brick's corners reach past its ring's outer radius
      const r = radius + 0.25 + 0.52 * j;
      // As many bricks as fit on the ring's inner edge with 2% gaps; odd courses offset by half
      const n = Math.floor((2 * Math.PI * (r - 0.25)) / 1.02);
      for (let i = 0; i < n; i++) {
        const a = ((i + (c % 2) * 0.5) / n) * 2 * Math.PI;
        brick(solver, r * Math.cos(a), r * Math.sin(a), 0.75 + 0.5 * c, a + Math.PI / 2);
      }
    }
  }
  // Just outside the stepped face, on its way in
  const r = courses / 5;
  rollingBall(solver, r, 10, 0, -(radius + 0.52 * rows + r + 2), 30);
}

/**
 * Paper Fig. 3: a field of triangular brick walls, one brick thick, smashed by two heavy spheres
 * rolling through it. Each wall is a brick pyramid `base` bricks wide (course k: base − k
 * bricks, offset by half a brick), facing ±y; `columns` × `rows` of them stand on a grid.
 * Defaults: 1,088 walls of 465 bricks, 505,920 bricks.
 */
export function brickGables(solver: Solver, columns = 16, rows = 68, base = 30, ballColumns = [columns / 2 - 2, columns / 2 + 1]): void {
  solver.clear();
  const [pitchX, pitchY] = [base + 2, 5];
  ground(solver, Math.max(columns * pitchX, rows * pitchY) / 2);
  for (let cx = 0; cx < columns; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const x0 = (cx - (columns - 1) / 2) * pitchX;
      const y = (cy - (rows - 1) / 2) * pitchY;
      for (let k = 0; k < base; k++) {
        const m = base - k;
        for (let i = 0; i < m; i++) brick(solver, x0 + (i - (m - 1) / 2) * 1.01, y, 0.75 + 0.5 * k);
      }
    }
  }
  // Down two columns (by default either side of the middle) after a 12 m run-up, dense enough
  // to carry on through the rubble they push ahead of them
  const r = base / 7;
  for (const cx of ballColumns) {
    rollingBall(solver, r, 50, (cx - (columns - 1) / 2) * pitchX, -((rows - 1) / 2) * pitchY - r - 12, 30);
  }
}

/**
 * A stand-in for paper Fig. 14 (35,000 bodies joined by 72,000 joints falling onto a cloth; no
 * cloth here). Plates of 5 × 5 × 2 small cubes ball-jointed at their shared face centres (50
 * bodies, 105 joints each), `grid` × `grid` per layer, drop in `layers` staggered layers onto a
 * chain-mail net of `net` × `net` links pinned along its border. Defaults: 34,096 bodies and
 * 71,064 joints.
 */
export function jointedDrop(solver: Solver, grid = 10, layers = 6, net = 64): void {
  solver.clear();
  ground(solver, net * 0.5);
  const s = 0.5;
  const zNet = 4;
  const links: Rigid[][] = [];
  for (let x = 0; x < net; x++) {
    links.push([]);
    for (let y = 0; y < net; y++) {
      const edge = x === 0 || y === 0 || x === net - 1 || y === net - 1;
      links[x].push(new Rigid(solver, [s * 0.9, s * 0.9, 0.1], edge ? 0 : 1, 0.5, [(x - (net - 1) / 2) * s, (y - (net - 1) / 2) * s, zNet]));
    }
  }
  for (let x = 0; x < net; x++) {
    for (let y = 0; y < net; y++) {
      if (x > 0) new Joint(solver, links[x - 1][y], links[x][y], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (y > 0) new Joint(solver, links[x][y - 1], links[x][y], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  const c = 0.4;
  const [nx, ny, nz] = [5, 5, 2];
  const pitch = 3;
  for (let layer = 0; layer < layers; layer++) {
    const offset = layer % 2 === 0 ? 0 : pitch / 2;
    for (let gx = 0; gx < grid; gx++) {
      for (let gy = 0; gy < grid; gy++) {
        const origin = [(gx - (grid - 1) / 2) * pitch + offset - 0.75, (gy - (grid - 1) / 2) * pitch + offset - 0.75, zNet + 3 + layer * 2.5];
        const cells: Rigid[] = [];
        const at = (x: number, y: number, z: number) => cells[(x * ny + y) * nz + z];
        for (let x = 0; x < nx; x++) {
          for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
              cells.push(new Rigid(solver, [c, c, c], 1, 0.5, [origin[0] + (x - (nx - 1) / 2) * c, origin[1] + (y - (ny - 1) / 2) * c, origin[2] + z * c]));
            }
          }
        }
        for (let x = 0; x < nx; x++) {
          for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
              if (x > 0) new Joint(solver, at(x - 1, y, z), at(x, y, z), [c / 2, 0, 0], [-c / 2, 0, 0]);
              if (y > 0) new Joint(solver, at(x, y - 1, z), at(x, y, z), [0, c / 2, 0], [0, -c / 2, 0]);
              if (z > 0) new Joint(solver, at(x, y, z - 1), at(x, y, z), [0, 0, c / 2], [0, 0, -c / 2]);
            }
          }
        }
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
  /** Solver settings the scene is shown with (the paper's iteration counts). */
  params?: Partial<SolverParams>;
}

/** The viewer's GPU showcase scenes, after the paper's figures, plus scale tests. */
export const gpuScenes3D: Scene3D[] = [
  {
    // Paper Fig. 1 at a quarter of the bricks (same proportions): smooth on modest GPUs. At the
    // paper's 4 iterations what's left of the wall creeps and falls after ~20 s; 6 hold it
    name: 'Brick Ring (28k)',
    build: (s) => brickRing(s, 40, 20, 2, 10),
    gpuOnly: true,
    params: { iterations: 6 },
    camera: { distance: 110, target: [0, -8, 0], azimuth: -100, elevation: 0.3 },
  },
  {
    name: 'Brick Ring (110k)',
    build: (s) => brickRing(s),
    gpuOnly: true,
    params: { iterations: 4 },
    camera: { distance: 215, target: [0, -15, 0], azimuth: -100, elevation: 0.3 },
  },
  {
    // Paper Fig. 3 at a twentieth of the bricks
    name: 'Brick Walls (27k)',
    build: (s) => brickGables(s, 8, 16, 20, [2, 5]),
    gpuOnly: true,
    params: { iterations: 3 },
    camera: { distance: 86, target: [15, 0, 2], azimuth: -69, elevation: 0.12 },
  },
  { name: 'Wall Smash (2k)', build: (s) => wallSmash(s), gpuOnly: true, camera: { distance: 55, target: [0, 0, 5], azimuth: -120, elevation: 0.3 } },
  { name: 'Breakable Wall (600)', build: (s) => breakableWall(s), gpuOnly: true, camera: { distance: 45, target: [0, 0, 5], azimuth: -120, elevation: 0.3 } },
  { name: 'Chain Mail (1.6k)', build: (s) => chainMail(s), gpuOnly: true, camera: { distance: 35, target: [0, 0, 9], azimuth: -120, elevation: 0.45 } },
  { name: 'Heavy Pendulum 50000:1', build: (s) => heavyPendulum(s), gpuOnly: true, camera: { distance: 70, target: [0, 0, 16], azimuth: 90, elevation: 0.15 } },
  { name: 'Box Pile (4k)', build: (s) => boxPile(s, 20, 10), gpuOnly: true, camera: { distance: 55, target: [0, 0, 4], elevation: 0.45 } },
  { name: 'Box Pile (32k)', build: (s) => boxPile(s, 40, 20), gpuOnly: true, camera: { distance: 110, target: [0, 0, 6], elevation: 0.45 } },
  { name: 'Jointed Drop (34k)', build: (s) => jointedDrop(s), gpuOnly: true, camera: { distance: 55, target: [0, 0, 4], azimuth: -120, elevation: 0.5 } },
  { name: 'Box Columns (100k)', build: (s) => boxColumns(s, 100, 10), gpuOnly: true, camera: { distance: 190, target: [0, 0, 5], elevation: 0.5 } },
];
