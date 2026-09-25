// Spheres, a GPU-only extension: the upstream demo (and so the CPU reference) has boxes only.
// A sphere is a reference Rigid with a cubic bounding size (2r on each side) whose mass
// properties are overwritten with a solid sphere's and which is marked here; the GPU solver
// reads the mark and collides it as a sphere. The CPU reference would treat it as a box, so
// scenes with spheres are GPU-only.

import { Rigid } from './ref/body.ts';
import type { Solver } from './ref/solver.ts';

const spheres = new WeakSet<Rigid>();

export const isSphere = (body: Rigid): boolean => spheres.has(body);

const sails = new WeakSet<Rigid>();

/** Mark a (thin) box as a sail: the GPU solver's wind pushes on its local z faces. */
export function sail(body: Rigid): Rigid {
  sails.add(body);
  return body;
}

export const isSail = (body: Rigid): boolean => sails.has(body);

/** A solid sphere of radius r. */
export function sphere(solver: Solver, r: number, density: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number> = [0, 0, 0]): Rigid {
  const body = new Rigid(solver, [2 * r, 2 * r, 2 * r], density, friction, position, velocity);
  body.mass = density > 0 ? (4 / 3) * Math.PI * r * r * r * density : 0;
  const I = 0.4 * body.mass * r * r;
  body.moment.set([I, I, I]);
  body.radius = r;
  spheres.add(body);
  return body;
}
