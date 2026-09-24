// Rigid body and constraint base, ported from avbd-demo2d (solver.h, rigid.cpp, force.cpp).
// The C++ keeps intrusive linked lists with head insertion, so iteration visits the newest
// object first. We store arrays in creation order and iterate them in reverse wherever the
// visiting order affects the result (Gauss-Seidel order), so behaviour matches the demo.

import type { Solver } from './solver.ts';

export const MAX_ROWS = 4; // Most rows an individual constraint can have
export const PENALTY_MIN = 1.0; // Minimum penalty parameter
export const PENALTY_MAX = 1000000000.0; // Maximum penalty parameter
export const COLLISION_MARGIN = 0.0005; // Margin to avoid flickering contacts
export const STICK_THRESH = 0.01; // Position threshold for sticking contacts (static friction)

export class Rigid {
  readonly solver: Solver;
  readonly forces: Force[] = [];
  /** Pose (x, y, angle). */
  readonly position = new Float64Array(3);
  readonly initial = new Float64Array(3);
  readonly inertial = new Float64Array(3);
  readonly velocity = new Float64Array(3);
  readonly prevVelocity = new Float64Array(3);
  readonly size: [number, number];
  mass: number;
  moment: number;
  friction: number;
  radius: number;

  constructor(
    solver: Solver,
    size: [number, number],
    density: number,
    friction: number,
    position: ArrayLike<number>,
    velocity: ArrayLike<number> = [0, 0, 0],
  ) {
    this.solver = solver;
    this.size = [size[0], size[1]];
    this.friction = friction;
    this.position.set([position[0], position[1], position[2] ?? 0]);
    this.velocity.set([velocity[0], velocity[1], velocity[2] ?? 0]);
    this.prevVelocity.set(this.velocity);

    // Mass properties and bounding radius
    this.mass = size[0] * size[1] * density;
    this.moment = (this.mass * (size[0] * size[0] + size[1] * size[1])) / 12;
    this.radius = Math.hypot(size[0] * 0.5, size[1] * 0.5);

    solver.bodies.push(this);
  }

  constrainedTo(other: Rigid): boolean {
    for (const f of this.forces) {
      if ((f.bodyA === this && f.bodyB === other) || (f.bodyA === other && f.bodyB === this)) return true;
    }
    return false;
  }
}

/**
 * Holds all user-defined and derived constraint parameters and a common interface for all
 * forces. Row i has Jacobian J[i*3..i*3+3] and (row-major 3x3) Hessian H[i*9..i*9+9] with
 * respect to whichever body `computeDerivatives` was last called for.
 */
export abstract class Force {
  readonly solver: Solver;
  readonly bodyA: Rigid | null;
  readonly bodyB: Rigid;

  readonly J = new Float64Array(MAX_ROWS * 3);
  readonly H = new Float64Array(MAX_ROWS * 9);
  readonly C = new Float64Array(MAX_ROWS);
  readonly fmin = new Float64Array(MAX_ROWS).fill(-Infinity);
  readonly fmax = new Float64Array(MAX_ROWS).fill(Infinity);
  readonly stiffness = new Float64Array(MAX_ROWS).fill(Infinity);
  readonly fracture = new Float64Array(MAX_ROWS).fill(Infinity);
  readonly penalty = new Float64Array(MAX_ROWS);
  readonly lambda = new Float64Array(MAX_ROWS);

  constructor(solver: Solver, bodyA: Rigid | null, bodyB: Rigid) {
    this.solver = solver;
    this.bodyA = bodyA;
    this.bodyB = bodyB;
    solver.forces.push(this);
    bodyA?.forces.push(this);
    bodyB.forces.push(this);
  }

  /** Unlink from the solver and both bodies (the C++ destructor). */
  destroy(): void {
    const list = this.solver.forces;
    const i = list.indexOf(this);
    if (i >= 0) list.splice(i, 1);
    this.unlinkFromBodies();
  }

  /** Unlink from the bodies only; used when the solver rebuilds its own list in bulk. */
  unlinkFromBodies(): void {
    for (const body of [this.bodyA, this.bodyB]) {
      if (!body) continue;
      const i = body.forces.indexOf(this);
      if (i >= 0) body.forces.splice(i, 1);
    }
  }

  /** Disable by zeroing stiffness, penalty and lambda; `initialize` then drops it. */
  disable(): void {
    this.stiffness.fill(0);
    this.penalty.fill(0);
    this.lambda.fill(0);
  }

  abstract rows(): number;
  /** Cache anything constant over the step. Returning false removes the force. */
  abstract initialize(): boolean;
  abstract computeConstraint(alpha: number): void;
  abstract computeDerivatives(body: Rigid): void;
}
