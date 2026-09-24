// The avbd-demo3d scenes (scenes.h), ported one to one. Z is up.

import { Rigid } from './body.ts';
import { IgnoreCollision, Joint, Spring } from './forces.ts';
import { addScaled3, normalize3, rad, rotate, vec3 } from './math.ts';
import type { Solver } from './solver.ts';

function ground(solver: Solver, z = 0): Rigid {
  return new Rigid(solver, [100, 100, 1], 0, 0.5, [0, 0, z]);
}

const sceneEmpty = (solver: Solver): void => solver.clear();

function sceneGround(solver: Solver): void {
  solver.clear();
  ground(solver);
  new Rigid(solver, [1, 1, 1], 1, 0.5, [0, 0, 4]);
}

function sceneDynamicFriction(solver: Solver): void {
  solver.clear();
  ground(solver);
  for (let x = 0; x <= 10; x++) {
    new Rigid(solver, [1, 1, 0.5], 1, 5 - (x / 10) * 5, [0, -30 + x * 2, 0.75], [10, 0, 0]);
  }
}

function sceneStaticFriction(solver: Solver): void {
  solver.clear();
  ground(solver);

  const angle = rad(30);
  const ramp = new Rigid(solver, [40, 24, 1], 0, 1, [0, 0, 3]);
  ramp.positionAng.set([0, Math.sin(angle * 0.5), 0, Math.cos(angle * 0.5)]);

  const rampTangent = normalize3(vec3(), rotate(vec3(), ramp.positionAng, [1, 0, 0]));
  const rampNormal = normalize3(vec3(), rotate(vec3(), ramp.positionAng, [0, 0, 1]));

  for (let i = 0; i <= 10; i++) {
    const friction = (i / 10) * 0.25 + 0.25;
    const y = -10 + i * 2;
    const pos = addScaled3(vec3(), ramp.positionLin, rampTangent, -12);
    pos[1] += y;
    addScaled3(pos, pos, rampNormal, 1.05);
    new Rigid(solver, [1, 1, 1], 1, friction, pos);
  }
}

/** Brick pyramid `size` rows high (the demo uses 16). */
export function scenePyramid(solver: Solver, size = 16): void {
  solver.clear();
  ground(solver, -0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size - y; x++) {
      new Rigid(solver, [1, 0.5, 0.5], 1, 0.5, [x * 1.01 + y * 0.5 - size / 2, 0, y * 0.85 + 0.5]);
    }
  }
}

function sceneRope(solver: Solver): void {
  solver.clear();
  ground(solver, -20);
  let prev: Rigid | null = null;
  for (let i = 0; i < 20; i++) {
    const curr: Rigid = new Rigid(solver, [1, 0.5, 0.5], i === 0 ? 0 : 1, 0.5, [i, 0, 10]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0, 0], [-0.5, 0, 0]);
    prev = curr;
  }
}

function sceneHeavyRope(solver: Solver): void {
  const N = 20;
  const SIZE = 5;
  solver.clear();
  ground(solver, -20);
  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const last = i === N - 1;
    const curr: Rigid = new Rigid(solver, last ? [SIZE, SIZE, SIZE] : [1, 0.5, 0.5], i === 0 ? 0 : 1, 0.5, [i + (last ? SIZE / 2 : 0), 0, 10]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0, 0], last ? [-SIZE / 2, 0, 0] : [-0.5, 0, 0]);
    prev = curr;
  }
}

function sceneSpring(solver: Solver): void {
  solver.clear();
  ground(solver);
  const anchor = new Rigid(solver, [1, 1, 1], 0, 0.5, [0, 0, 14]);
  const block = new Rigid(solver, [2, 2, 2], 1, 0.5, [0, 0, 8]);
  new Spring(solver, anchor, block, [0, 0, 0], [0, 0, 0], 100, 4);
}

function sceneSpringsRatio(solver: Solver): void {
  const N = 8;
  solver.clear();
  ground(solver, -10);
  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const x = (i - (N - 1) * 0.5) * 3;
    const curr: Rigid = new Rigid(solver, [1, 0.75, 0.75], i === 0 || i === N - 1 ? 0 : 1, 0.5, [x, 0, 12]);
    if (prev) new Spring(solver, prev, curr, [0.5, 0, 0], [-0.5, 0, 0], i % 2 === 0 ? 10 : 10000, 3);
    prev = curr;
  }
}

function sceneStack(solver: Solver): void {
  solver.clear();
  ground(solver);
  for (let i = 0; i < 10; i++) new Rigid(solver, [1, 1, 1], 1, 0.5, [0, 0, i * 1.5 + 1]);
}

function sceneStackRatio(solver: Solver): void {
  solver.clear();
  const groundThickness = 1;
  new Rigid(solver, [100, 100, groundThickness], 0, 0.5, [0, 0, 0]);
  let topZ = groundThickness * 0.5;
  let s = 1;
  for (let i = 0; i < 4; i++) {
    const half = s * 0.5;
    const centerZ = topZ + half;
    new Rigid(solver, [s, s, s], 1, 0.5, [0, 0, centerZ]);
    topZ = centerZ + half;
    s *= 2;
  }
}

function sceneSoftBody(solver: Solver): void {
  solver.clear();
  ground(solver);

  const Klin = 1000;
  const Kang = 250;
  const W = 4;
  const D = 4;
  const H = 4;
  const N = 3;
  const size = 0.8;
  const half = size * 0.5;
  const baseZ = 8;
  const stackGap = 2;

  for (let i = 0; i < N; i++) {
    const stackZ = i * (H * size + stackGap);
    const grid: Rigid[][][] = [];
    for (let x = 0; x < W; x++) {
      grid.push([]);
      for (let y = 0; y < D; y++) {
        grid[x].push([]);
        for (let z = 0; z < H; z++) {
          const px = (x - (W - 1) * 0.5) * size;
          const py = (y - (D - 1) * 0.5) * size;
          const pz = baseZ + stackZ + z * size;
          grid[x][y].push(new Rigid(solver, [size, size, size], 1, 0.5, [px, py, pz]));
        }
      }
    }

    for (let x = 1; x < W; x++)
      for (let y = 0; y < D; y++)
        for (let z = 0; z < H; z++) new Joint(solver, grid[x - 1][y][z], grid[x][y][z], [half, 0, 0], [-half, 0, 0], Klin, Kang);
    for (let x = 0; x < W; x++)
      for (let y = 1; y < D; y++)
        for (let z = 0; z < H; z++) new Joint(solver, grid[x][y - 1][z], grid[x][y][z], [0, half, 0], [0, -half, 0], Klin, Kang);
    for (let x = 0; x < W; x++)
      for (let y = 0; y < D; y++)
        for (let z = 1; z < H; z++) new Joint(solver, grid[x][y][z - 1], grid[x][y][z], [0, 0, half], [0, 0, -half], Klin, Kang);

    // Diagonal neighbours overlap their bounding spheres; don't let them collide
    for (let x = 1; x < W; x++)
      for (let y = 0; y < D; y++)
        for (let z = 1; z < H; z++) {
          new IgnoreCollision(solver, grid[x - 1][y][z - 1], grid[x][y][z]);
          new IgnoreCollision(solver, grid[x][y][z - 1], grid[x - 1][y][z]);
        }
    for (let x = 0; x < W; x++)
      for (let y = 1; y < D; y++)
        for (let z = 1; z < H; z++) {
          new IgnoreCollision(solver, grid[x][y - 1][z - 1], grid[x][y][z]);
          new IgnoreCollision(solver, grid[x][y][z - 1], grid[x][y - 1][z]);
        }
    for (let x = 1; x < W; x++)
      for (let y = 1; y < D; y++)
        for (let z = 0; z < H; z++) {
          new IgnoreCollision(solver, grid[x - 1][y - 1][z], grid[x][y][z]);
          new IgnoreCollision(solver, grid[x][y - 1][z], grid[x - 1][y][z]);
        }
  }
}

function sceneBridge(solver: Solver): void {
  const N = 40;
  const plankLength = 1;
  const plankWidth = 4;
  const plankHeight = 0.5;
  const halfLength = plankLength * 0.5;
  const halfWidth = plankWidth * 0.5;

  solver.clear();
  ground(solver);

  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const curr: Rigid = new Rigid(solver, [plankLength, plankWidth, plankHeight], i === 0 || i === N - 1 ? 0 : 1, 0.5, [i - N / 2, 0, 10]);
    if (prev) {
      new Joint(solver, prev, curr, [halfLength, halfWidth, 0], [-halfLength, halfWidth, 0], Infinity, 0);
      new Joint(solver, prev, curr, [halfLength, -halfWidth, 0], [-halfLength, -halfWidth, 0], Infinity, 0);
    }
    prev = curr;
  }

  for (let x = 0; x < N / 4; x++) {
    for (let y = 0; y < N / 8; y++) new Rigid(solver, [1, 1, 1], 1, 0.5, [x - N / 8, 0, y + 12]);
  }
}

function sceneBreakable(solver: Solver): void {
  const N = 10;
  const M = 5;
  const breakForce = 90;

  solver.clear();
  ground(solver);

  let prev: Rigid | null = null;
  for (let i = 0; i <= N; i++) {
    const curr: Rigid = new Rigid(solver, [1, 1, 0.5], 1, 0.5, [i - N / 2, 0, 6]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, breakForce);
    prev = curr;
  }

  new Rigid(solver, [1, 1, 5], 0, 0.5, [-N / 2, 0, 2.5]);
  new Rigid(solver, [1, 1, 5], 0, 0.5, [N / 2, 0, 2.5]);

  for (let i = 0; i < M; i++) new Rigid(solver, [2, 1, 1], 1, 0.5, [0, 0, i * 2 + 8]);
}

export interface Scene {
  name: string;
  build: (solver: Solver) => void;
}

/** In the demo's order, so an index here is the C++ oracle's scene index. */
export const scenes: Scene[] = [
  { name: 'Empty', build: sceneEmpty },
  { name: 'Ground', build: sceneGround },
  { name: 'Dynamic Friction', build: sceneDynamicFriction },
  { name: 'Static Friction', build: sceneStaticFriction },
  { name: 'Pyramid', build: (s) => scenePyramid(s) },
  { name: 'Rope', build: sceneRope },
  { name: 'Heavy Rope', build: sceneHeavyRope },
  { name: 'Spring', build: sceneSpring },
  { name: 'Spring Ratio', build: sceneSpringsRatio },
  { name: 'Stack', build: sceneStack },
  { name: 'Stack Ratio', build: sceneStackRatio },
  { name: 'Soft Body', build: sceneSoftBody },
  { name: 'Bridge', build: sceneBridge },
  { name: 'Breakable', build: sceneBreakable },
];

export const DEFAULT_SCENE = 'Pyramid';

export const sceneByName = (name: string): Scene => {
  const scene = scenes.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown scene ${name}`);
  return scene;
};
