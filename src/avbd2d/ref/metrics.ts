// Diagnostics used by the tests and the HUD: energy and constraint error of a solver state.

import { Joint } from './forces.ts';
import { Manifold } from './manifold.ts';
import type { Solver } from './solver.ts';

export function kineticEnergy(solver: Solver): number {
  let e = 0;
  for (const b of solver.bodies) {
    if (b.mass <= 0) continue;
    const v = b.velocity;
    e += 0.5 * b.mass * (v[0] * v[0] + v[1] * v[1]) + 0.5 * b.moment * v[2] * v[2];
  }
  return e;
}

/** Largest positional error of any hard (infinitely stiff) joint anchor, in world units. */
export function maxJointError(solver: Solver): number {
  let m = 0;
  for (const f of solver.forces) {
    if (!(f instanceof Joint)) continue;
    f.computeConstraint(0);
    for (let i = 0; i < 2; i++) if (f.stiffness[i] === Infinity) m = Math.max(m, Math.abs(f.C[i]));
  }
  return m;
}

export interface ForceCounts {
  joints: number;
  manifolds: number;
  contacts: number;
  other: number;
}

export function countForces(solver: Solver): ForceCounts {
  const counts: ForceCounts = { joints: 0, manifolds: 0, contacts: 0, other: 0 };
  for (const f of solver.forces) {
    if (f instanceof Joint) counts.joints++;
    else if (f instanceof Manifold) {
      counts.manifolds++;
      counts.contacts += f.numContacts;
    } else counts.other++;
  }
  return counts;
}
