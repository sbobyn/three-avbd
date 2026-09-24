// Contact manifold between two boxes with up to two frictional contacts, ported from
// avbd-demo2d manifold.cpp. Rows are [normal0, tangent0, normal1, tangent1].

import { COLLISION_MARGIN, Force, Rigid, STICK_THRESH } from './body.ts';
import { collide } from './collide.ts';
import { rotate } from './math.ts';
import type { Solver } from './solver.ts';

export interface Contact {
  feature: number;
  rA: [number, number];
  rB: [number, number];
  normal: [number, number];
  /** Precomputed Jacobians at x- (normal/tangent, body A/B). */
  JAn: [number, number, number];
  JBn: [number, number, number];
  JAt: [number, number, number];
  JBt: [number, number, number];
  /** Constraint value at x-: (normal, tangent). */
  C0: [number, number];
  stick: boolean;
}

export class Manifold extends Force {
  contacts: Contact[] = [];
  numContacts = 0;
  friction = 0;

  constructor(solver: Solver, bodyA: Rigid, bodyB: Rigid) {
    super(solver, bodyA, bodyB);
    this.fmax[0] = this.fmax[2] = 0;
    this.fmin[0] = this.fmin[2] = -Infinity;
  }

  rows(): number {
    return this.numContacts * 2;
  }

  initialize(): boolean {
    const bodyA = this.bodyA!;
    const bodyB = this.bodyB;
    this.friction = Math.sqrt(bodyA.friction * bodyB.friction);

    // Previous contact state
    const oldContacts = this.contacts;
    const oldPenalty = Float64Array.from(this.penalty);
    const oldLambda = Float64Array.from(this.lambda);

    // New contacts
    const raw = collide(bodyA, bodyB);
    this.numContacts = raw.length;
    this.contacts = raw.map((c) => ({
      feature: c.feature,
      rA: c.rA,
      rB: c.rB,
      normal: c.normal,
      JAn: [0, 0, 0],
      JBn: [0, 0, 0],
      JAt: [0, 0, 0],
      JBt: [0, 0, 0],
      C0: [0, 0],
      stick: false,
    }));

    // Merge old contact data into matching new contacts
    for (let i = 0; i < this.numContacts; i++) {
      const c = this.contacts[i];
      this.penalty[i * 2] = this.penalty[i * 2 + 1] = 0;
      this.lambda[i * 2] = this.lambda[i * 2 + 1] = 0;

      for (let j = 0; j < oldContacts.length; j++) {
        const old = oldContacts[j];
        if (c.feature !== old.feature) continue;
        this.penalty[i * 2] = oldPenalty[j * 2];
        this.penalty[i * 2 + 1] = oldPenalty[j * 2 + 1];
        this.lambda[i * 2] = oldLambda[j * 2];
        this.lambda[i * 2 + 1] = oldLambda[j * 2 + 1];
        c.stick = old.stick;

        // If static friction last frame, keep the old contact points
        if (old.stick) {
          c.rA = [old.rA[0], old.rA[1]];
          c.rB = [old.rB[0], old.rB[1]];
        }
      }
    }

    for (const c of this.contacts) {
      // Contact basis (Eq. 15): rows are normal and tangent
      const [nx, ny] = c.normal;
      const tx = ny;
      const ty = -nx;

      const rAW = rotate(bodyA.position[2], c.rA[0], c.rA[1]);
      const rBW = rotate(bodyB.position[2], c.rB[0], c.rB[1]);

      // Constraint and derivatives at C(x-): contacts use a truncated Taylor series (Sec. 4),
      // dropping the second-order term which is insignificant for contacts.
      c.JAn = [nx, ny, rAW[0] * ny - rAW[1] * nx];
      c.JBn = [-nx, -ny, -(rBW[0] * ny - rBW[1] * nx)];
      c.JAt = [tx, ty, rAW[0] * ty - rAW[1] * tx];
      c.JBt = [-tx, -ty, -(rBW[0] * ty - rBW[1] * tx)];

      const dx = bodyA.position[0] + rAW[0] - bodyB.position[0] - rBW[0];
      const dy = bodyA.position[1] + rAW[1] - bodyB.position[1] - rBW[1];
      c.C0 = [nx * dx + ny * dy + COLLISION_MARGIN, tx * dx + ty * dy];
    }

    return this.numContacts > 0;
  }

  computeConstraint(alpha: number): void {
    const pA = this.bodyA!.position;
    const iA = this.bodyA!.initial;
    const pB = this.bodyB.position;
    const iB = this.bodyB.initial;
    const a0 = pA[0] - iA[0], a1 = pA[1] - iA[1], a2 = pA[2] - iA[2];
    const b0 = pB[0] - iB[0], b1 = pB[1] - iB[1], b2 = pB[2] - iB[2];

    for (let i = 0; i < this.numContacts; i++) {
      const c = this.contacts[i];
      // Taylor series approximation of C(x) (Sec. 4)
      this.C[i * 2] =
        c.C0[0] * (1 - alpha) +
        c.JAn[0] * a0 + c.JAn[1] * a1 + c.JAn[2] * a2 +
        c.JBn[0] * b0 + c.JBn[1] * b1 + c.JBn[2] * b2;
      this.C[i * 2 + 1] =
        c.C0[1] * (1 - alpha) +
        c.JAt[0] * a0 + c.JAt[1] * a1 + c.JAt[2] * a2 +
        c.JBt[0] * b0 + c.JBt[1] * b1 + c.JBt[2] * b2;

      // Friction bounds from the latest normal lambda
      const frictionBound = Math.abs(this.lambda[i * 2]) * this.friction;
      this.fmax[i * 2 + 1] = frictionBound;
      this.fmin[i * 2 + 1] = -frictionBound;

      // Sticking contacts reuse their anchor points next frame (static friction)
      c.stick = Math.abs(this.lambda[i * 2 + 1]) < frictionBound && Math.abs(c.C0[1]) < STICK_THRESH;
    }
  }

  computeDerivatives(body: Rigid): void {
    const isA = body === this.bodyA;
    for (let i = 0; i < this.numContacts; i++) {
      const c = this.contacts[i];
      this.J.set(isA ? c.JAn : c.JBn, i * 6);
      this.J.set(isA ? c.JAt : c.JBt, i * 6 + 3);
    }
  }
}
