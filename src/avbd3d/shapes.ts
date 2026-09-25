// Spheres, a GPU-only extension: the upstream demo (and so the CPU reference) has boxes only.
// A sphere is a reference Rigid with a cubic bounding size (2r on each side) whose mass
// properties are overwritten with a solid sphere's and which is marked here; the GPU solver
// reads the mark and collides it as a sphere. The CPU reference would treat it as a box, so
// scenes with spheres are GPU-only.

import { Rigid } from './ref/body.ts';
import type { Solver } from './ref/solver.ts';
import type { HullShape } from './hull.ts';

export { convexHull, type HullShape } from './hull.ts';

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

const hulls = new WeakMap<Rigid, HullShape>();

/** The convex hull a body collides as (GPU solver), if it is one. */
export const hullOf = (body: Rigid): HullShape | undefined => hulls.get(body);

/**
 * A convex hull (./hull.ts: \`convexHull(points)\`) of the given density, its principal frame at
 * \`position\` (the hull's centre of mass) turned by \`rotation\` (x, y, z, w). Place it where points
 * were with the hull's \`center\` and \`rotation\`. The GPU solver collides it as a hull when the device
 * can bind the hull buffer (GpuSolver3D.hulls), else as its bounding box; the CPU reference would
 * treat it as that box.
 */
export function hull(
  solver: Solver,
  shape: HullShape,
  density: number,
  friction: number,
  position: ArrayLike<number>,
  rotation: ArrayLike<number> = [0, 0, 0, 1],
  velocity: ArrayLike<number> = [0, 0, 0],
): Rigid {
  const body = new Rigid(solver, shape.size, density, friction, position, velocity);
  body.positionAng.set([rotation[0], rotation[1], rotation[2], rotation[3]]);
  body.mass = density > 0 ? shape.volume * density : 0;
  body.moment.set(shape.moments.map((m) => m * Math.max(density, 0)));
  body.radius = shape.radius;
  hulls.set(body, shape);
  return body;
}
