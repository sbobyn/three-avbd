// The avbd-demo2d scenes (scenes.h), ported one to one.

import { Rigid } from './body.ts';
import { IgnoreCollision, Joint, Motor, Spring } from './forces.ts';
import type { Solver } from './solver.ts';

const PI = 3.14159;

function ground(solver: Solver): void {
  new Rigid(solver, [100, 1], 0, 0.5, [0, 0, 0]);
}

const sceneEmpty = (solver: Solver): void => solver.clear();

function sceneGround(solver: Solver): void {
  solver.clear();
  ground(solver);
}

function sceneDynamicFriction(solver: Solver): void {
  solver.clear();
  ground(solver);
  for (let x = 0; x <= 10; x++) {
    new Rigid(solver, [1, 0.5], 1, 5 - (x / 10) * 5, [-30 + x * 2, 0.75, 0], [10, 0, 0]);
  }
}

function sceneStaticFriction(solver: Solver): void {
  solver.clear();
  new Rigid(solver, [100, 1], 0, 1, [0, 0, PI / 6]);
  for (let y = 0; y <= 10; y++) new Rigid(solver, [5, 0.5], 1, 1, [0, y * 1 + 1, PI / 6]);
}

function scenePyramid(solver: Solver, size = 20): void {
  solver.clear();
  new Rigid(solver, [100, 0.5], 0, 0.5, [0, -2, 0]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size - y; x++) {
      new Rigid(solver, [1, 0.5], 1, 0.5, [x * 1.1 + y * 0.5 - size / 2, y * 0.85, 0]);
    }
  }
}

function sceneRope(solver: Solver): void {
  solver.clear();
  let prev: Rigid | null = null;
  for (let i = 0; i < 20; i++) {
    const curr = new Rigid(solver, [1, 0.5], i === 0 ? 0 : 1, 0.5, [i, 10, 0]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0], [-0.5, 0], [Infinity, Infinity, 0]);
    prev = curr;
  }
}

function sceneHeavyRope(solver: Solver): void {
  const N = 20;
  const SIZE = 30;
  solver.clear();
  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const last = i === N - 1;
    const curr = new Rigid(solver, last ? [SIZE, SIZE] : [1, 0.5], i === 0 ? 0 : 1, 0.5, [i + (last ? SIZE / 2 : 0), 10, 0]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0], last ? [-SIZE / 2, 0] : [-0.5, 0], [Infinity, Infinity, 0]);
    prev = curr;
  }
}

function sceneHangingRope(solver: Solver): void {
  const N = 50;
  const SIZE = 10;
  solver.clear();
  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const last = i === N - 1;
    const curr = new Rigid(solver, last ? [SIZE, SIZE] : [0.5, 1], i === 0 ? 0 : 1, 0.5, [0, 10 - (i + (last ? SIZE / 2 : 0)), 0]);
    if (prev) new Joint(solver, prev, curr, [0, -0.5], last ? [0, SIZE / 2] : [0, 0.5], [Infinity, Infinity, 0]);
    prev = curr;
  }
}

function sceneSpring(solver: Solver): void {
  solver.clear();
  const anchor = new Rigid(solver, [1, 1], 0, 0.5, [0, 0, 0]);
  const block = new Rigid(solver, [4, 4], 1, 0.5, [0, -8, 0]);
  new Spring(solver, anchor, block, [0, 0], [0, 0], 100, 4);
}

function sceneSpringsRatio(solver: Solver): void {
  const N = 8;
  solver.clear();
  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const curr = new Rigid(solver, [1, 0.5], i === 0 || i === N - 1 ? 0 : 1, 0.5, [i * 4, 10, 0]);
    if (prev) new Spring(solver, prev, curr, [0.5, 0], [-0.5, 0], i % 2 === 0 ? 1000 : 1000000, 0.1);
    prev = curr;
  }
}

function sceneStack(solver: Solver): void {
  solver.clear();
  ground(solver);
  for (let i = 0; i < 20; i++) new Rigid(solver, [1, 1], 1, 0.5, [0, i * 2 + 1, 0]);
}

function sceneStackRatio(solver: Solver): void {
  solver.clear();
  ground(solver);
  for (let i = 0, y = 1, s = 1; i < 6; i++) {
    new Rigid(solver, [s, s], 1, 0.5, [0, y, 0]);
    y += Math.trunc((s * 3) / 2);
    s *= 2;
  }
}

function sceneRod(solver: Solver): void {
  solver.clear();
  let prev: Rigid | null = null;
  for (let i = 0; i < 20; i++) {
    const curr = new Rigid(solver, [1, 0.5], i === 0 ? 0 : 1, 0.5, [i, 10, 0]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0], [-0.5, 0], [Infinity, Infinity, Infinity]);
    prev = curr;
  }
}

function sceneSoftBody(solver: Solver): void {
  solver.clear();
  new Rigid(solver, [100, 0.5], 0, 0.5, [0, 0, 0]);

  const Klin = 1000;
  const Kang = 100;
  const W = 15;
  const H = 5;
  const N = 2;
  for (let i = 0; i < N; i++) {
    const grid: Rigid[][] = [];
    for (let x = 0; x < W; x++) {
      grid.push([]);
      for (let y = 0; y < H; y++) grid[x].push(new Rigid(solver, [1, 1], 1, 0.5, [x, y + H * i * 2 + 5, 0]));
    }
    for (let x = 1; x < W; x++) {
      for (let y = 0; y < H; y++) new Joint(solver, grid[x - 1][y], grid[x][y], [0.5, 0], [-0.5, 0], [Klin, Klin, Kang]);
    }
    for (let x = 0; x < W; x++) {
      for (let y = 1; y < H; y++) new Joint(solver, grid[x][y - 1], grid[x][y], [0, 0.5], [0, -0.5], [Klin, Klin, Kang]);
    }
    for (let x = 1; x < W; x++) {
      for (let y = 1; y < H; y++) {
        new IgnoreCollision(solver, grid[x - 1][y - 1], grid[x][y]);
        new IgnoreCollision(solver, grid[x][y - 1], grid[x - 1][y]);
      }
    }
  }
}

function sceneJointGrid(solver: Solver, W = 25, H = 25): void {
  solver.clear();
  const grid: Rigid[][] = [];
  for (let x = 0; x < W; x++) {
    grid.push([]);
    for (let y = 0; y < H; y++) {
      const pinned = y === H - 1 && (x === 0 || x === W - 1);
      grid[x].push(new Rigid(solver, [1, 1], pinned ? 0 : 1, 0.5, [x, y, 0]));
    }
  }
  for (let x = 1; x < W; x++) {
    for (let y = 0; y < H; y++) new Joint(solver, grid[x - 1][y], grid[x][y], [0.5, 0], [-0.5, 0]);
  }
  for (let x = 0; x < W; x++) {
    for (let y = 1; y < H; y++) new Joint(solver, grid[x][y - 1], grid[x][y], [0, 0.5], [0, -0.5]);
  }
  for (let x = 1; x < W; x++) {
    for (let y = 1; y < H; y++) {
      new IgnoreCollision(solver, grid[x - 1][y - 1], grid[x][y]);
      new IgnoreCollision(solver, grid[x][y - 1], grid[x - 1][y]);
    }
  }
}

function sceneNet(solver: Solver): void {
  const N = 40;
  solver.clear();
  new Rigid(solver, [100, 0.5], 0, 0.5, [0, 0, 0]);

  let prev: Rigid | null = null;
  for (let i = 0; i < N; i++) {
    const curr = new Rigid(solver, [1, 0.5], i === 0 || i === N - 1 ? 0 : 1, 0.5, [i - N / 2, 10, 0]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0], [-0.5, 0], [Infinity, Infinity, 0]);
    prev = curr;
  }
  for (let x = 0; x < N / 4; x++) {
    for (let y = 0; y < N / 8; y++) new Rigid(solver, [1, 1], 1, 0.5, [x - N / 8, y + 15, 0]);
  }
}

function sceneMotor(solver: Solver): void {
  solver.clear();
  new Rigid(solver, [100, 0.5], 0, 0.5, [0, -10, 0]);
  const a0 = new Rigid(solver, [5, 0.5], 1, 0.5, [0, 0, 0]);
  new Joint(solver, null, a0, [0, 0], [0, 0], [Infinity, Infinity, 0]);
  new Motor(solver, null, a0, 20, 50);
}

function sceneFracture(solver: Solver): void {
  const N = 10;
  const M = 15;
  solver.clear();
  new Rigid(solver, [100, 0.5], 0, 0.5, [0, 0, 0]);

  let prev: Rigid | null = null;
  for (let i = 0; i <= N; i++) {
    const curr = new Rigid(solver, [1, 0.5], 1, 0.5, [i - N / 2, 6, 0]);
    if (prev) new Joint(solver, prev, curr, [0.5, 0], [-0.5, 0], [Infinity, Infinity, Infinity], 500);
    prev = curr;
  }
  new Rigid(solver, [1, 5], 1, 0.5, [-N / 2, 2.5, 0]);
  new Rigid(solver, [1, 5], 1, 0.5, [N / 2, 2.5, 0]);
  for (let i = 0; i < M; i++) new Rigid(solver, [2, 1], 1, 0.5, [0, i * 2 + 8, 0]);
}

function sceneCards(solver: Solver): void {
  solver.clear();
  new Rigid(solver, [80, 4], 0, 0.7, [0, -2, 0]);

  const cardHeight = 0.2 * 2;
  const cardThickness = 0.001 * 2;
  const angle0 = (25 * PI) / 180;
  const angle1 = (-25 * PI) / 180;
  const angle2 = 0.5 * PI;

  let Nb = 5;
  let z0 = 0;
  let y = cardHeight * 0.5 - 0.02;
  while (Nb) {
    let z = z0;
    for (let i = 0; i < Nb; i++) {
      if (i !== Nb - 1) {
        new Rigid(solver, [cardThickness, cardHeight], 1, 0.7, [z + 0.25, y + cardHeight * 0.5 - 0.02, angle2]);
      }
      new Rigid(solver, [cardThickness, cardHeight], 1, 0.7, [z, y, angle1]);
      z += 0.175;
      new Rigid(solver, [cardThickness, cardHeight], 1, 0.7, [z, y, angle0]);
      z += 0.175;
    }
    y += cardHeight - 0.04;
    z0 += 0.175;
    Nb--;
  }
}

export interface Scene {
  name: string;
  build: (solver: Solver) => void;
}

export const scenes: Scene[] = [
  { name: 'Empty', build: sceneEmpty },
  { name: 'Ground', build: sceneGround },
  { name: 'Dynamic Friction', build: sceneDynamicFriction },
  { name: 'Static Friction', build: sceneStaticFriction },
  { name: 'Pyramid', build: (s) => scenePyramid(s) },
  { name: 'Cards', build: sceneCards },
  { name: 'Rope', build: sceneRope },
  { name: 'Heavy Rope', build: sceneHeavyRope },
  { name: 'Hanging Rope', build: sceneHangingRope },
  { name: 'Spring', build: sceneSpring },
  { name: 'Spring Ratio', build: sceneSpringsRatio },
  { name: 'Stack', build: sceneStack },
  { name: 'Stack Ratio', build: sceneStackRatio },
  { name: 'Rod', build: sceneRod },
  { name: 'Soft Body', build: sceneSoftBody },
  { name: 'Joint Grid', build: (s) => sceneJointGrid(s) },
  { name: 'Net', build: sceneNet },
  { name: 'Motor', build: sceneMotor },
  { name: 'Fracture', build: sceneFracture },
];

export const DEFAULT_SCENE = 'Pyramid';

export const sceneByName = (name: string): Scene => {
  const scene = scenes.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown scene ${name}`);
  return scene;
};
