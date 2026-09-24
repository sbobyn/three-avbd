// AVBD solver, ported from avbd-demo3d solver.cpp. The 3D CPU reference ("oracle") that the
// 3D GPU solver is validated against, so it stays a faithful port: same iteration order and
// parameters. Unlike the 2D demo, the 3D demo has no post-stabilization and warm-starts
// inside each force's initialize.

import { bodySystem, type Force, type Rigid } from './body.ts';
import { Manifold } from './manifold.ts';
import {
  addScaled3,
  clamp,
  diagonal,
  div3,
  dot,
  mulv,
  neg3,
  qaddv,
  qsub,
  rotateInv,
  scale3,
  sign,
  sub3,
  vec3,
  solve6,
  type V3,
} from './math.ts';

export interface SolverParams {
  dt: number;
  gravity: number;
  iterations: number;
  /** Stabilization: fraction of step-start constraint error left uncorrected (Eq. 18). */
  alpha: number;
  /** Penalty ramping rate for linear rows (Eq. 16); the demo splits beta by units. */
  betaLin: number;
  /** Penalty ramping rate for angular rows. */
  betaAng: number;
  /** Warm-start decay of penalty and lambda (Eq. 19). */
  gamma: number;
}

export const defaultParams = (): SolverParams => ({
  dt: 1 / 60,
  gravity: -10,
  iterations: 10,
  // The paper suggests beta in [1, 1000]; the right range depends on the units of the
  // constraint. The demo uses separate values for linear and angular rows.
  betaLin: 10000,
  betaAng: 100,
  // Higher alpha = slower, smoother error correction.
  alpha: 0.99,
  // Must be < 1 so penalties can decrease over time.
  gamma: 0.999,
});

export interface PickHit {
  body: Rigid;
  /** Hit point in the body's local frame. */
  local: V3;
  /** Ray parameter of the hit. */
  t: number;
}

export class Solver implements SolverParams {
  dt = 1 / 60;
  gravity = -10;
  iterations = 10;
  alpha = 0.99;
  betaLin = 10000;
  betaAng = 100;
  gamma = 0.999;

  /** In creation order; iterated newest-first to match the C++ linked lists. */
  bodies: Rigid[] = [];
  forces: Force[] = [];

  constructor() {
    this.defaultParams();
  }

  defaultParams(): void {
    Object.assign(this, defaultParams());
  }

  clear(): void {
    this.forces = [];
    this.bodies = [];
  }

  /** Ray-cast the dynamic bodies (slab test in each box's local frame); nearest hit wins. */
  pick(origin: ArrayLike<number>, dir: ArrayLike<number>): PickHit | null {
    const epsilon = 1.0e-6;
    let best: PickHit | null = null;
    const o = vec3();
    const d = vec3();
    for (let b = this.bodies.length - 1; b >= 0; b--) {
      const body = this.bodies[b];
      if (body.mass <= 0) continue;

      rotateInv(o, body.positionAng, sub3(o, origin, body.positionLin));
      rotateInv(d, body.positionAng, dir);
      let tEnter = 0;
      let tExit = Infinity;
      let hit = true;
      for (let i = 0; i < 3 && hit; i++) {
        const half = body.size[i] * 0.5;
        if (Math.abs(d[i]) < epsilon) {
          if (o[i] < -half || o[i] > half) hit = false;
          continue;
        }
        const invD = 1 / d[i];
        let t0 = (-half - o[i]) * invD;
        let t1 = (half - o[i]) * invD;
        if (t0 > t1) [t0, t1] = [t1, t0];
        tEnter = Math.max(tEnter, t0);
        tExit = Math.min(tExit, t1);
        if (tEnter > tExit) hit = false;
      }
      if (!hit) continue;

      const tHit = tEnter >= 0 ? tEnter : tExit;
      if (tHit < 0) continue;
      if (!best || tHit < best.t) best = { body, local: addScaled3(vec3(), o, d, tHit), t: tHit };
    }
    return best;
  }

  // Scratch storage for the per-body linear system
  private readonly sys = bodySystem();
  private readonly dxLin = vec3();
  private readonly dxAng = vec3();
  private readonly dp = vec3();
  private readonly accel = vec3();

  step(): void {
    const { dt, gravity, bodies, sys, dp } = this;

    // Broadphase: naive O(n^2) bounding-sphere test, sufficient for the demo scenes
    for (let i = bodies.length - 1; i >= 0; i--) {
      const bodyA = bodies[i];
      for (let j = i - 1; j >= 0; j--) {
        const bodyB = bodies[j];
        sub3(dp, bodyA.positionLin, bodyB.positionLin);
        const r = bodyA.radius + bodyB.radius;
        if (dot(dp, dp) <= r * r && !bodyA.constrainedTo(bodyB)) new Manifold(this, bodyA, bodyB);
      }
    }

    // Initialize and warm-start forces; drop the inactive ones
    const kept: Force[] = [];
    for (const force of this.forces) {
      if (force.initialize()) kept.push(force);
      else force.unlinkFromBodies();
    }
    this.forces = kept;

    // Initialize and warm-start bodies (primal variables)
    for (let b = bodies.length - 1; b >= 0; b--) {
      const body = bodies[b];

      // Inertial position (Eq. 2)
      addScaled3(body.inertialLin, body.positionLin, body.velocityLin, dt);
      if (body.mass > 0) body.inertialLin[2] += gravity * (dt * dt);
      qaddv(body.inertialAng, body.positionAng, scaleTmp(body.velocityAng, dt));

      // Adaptive warm start (see the original VBD paper)
      div3(this.accel, sub3(this.accel, body.velocityLin, body.prevVelocityLin), dt);
      const accelExt = this.accel[2] * sign(gravity);
      let accelWeight = clamp(accelExt / Math.abs(gravity), 0, 1);
      if (!Number.isFinite(accelWeight)) accelWeight = 0;

      // Save x- and compute the warm-started position
      body.initialLin.set(body.positionLin);
      body.initialAng.set(body.positionAng);
      if (body.mass > 0) {
        addScaled3(body.positionLin, body.positionLin, body.velocityLin, dt);
        body.positionLin[2] += gravity * (accelWeight * dt * dt);
        qaddv(body.positionAng, body.positionAng, scaleTmp(body.velocityAng, dt));
      }
    }

    // Main solver loop
    for (let it = 0; it < this.iterations; it++) {
      // Primal update
      for (let b = bodies.length - 1; b >= 0; b--) {
        const body = bodies[b];
        if (body.mass <= 0) continue; // static / kinematic

        // Left and right hand sides of the linear system (Eqs. 5, 6)
        const m = body.mass;
        const I = body.moment;
        diagonal(sys.lhsLin, m / (dt * dt), m / (dt * dt), m / (dt * dt));
        diagonal(sys.lhsAng, I[0] / (dt * dt), I[1] / (dt * dt), I[2] / (dt * dt));
        sys.lhsCross.fill(0);
        mulv(sys.rhsLin, sys.lhsLin, sub3(dp, body.positionLin, body.inertialLin));
        mulv(sys.rhsAng, sys.lhsAng, qsub(dp, body.positionAng, body.inertialAng));

        // Stamp every force acting on the body
        const forces = body.forces;
        for (let f = forces.length - 1; f >= 0; f--) forces[f].updatePrimal(body, this.alpha, sys);

        // Solve the SPD system with LDLᵀ and apply the update (Eq. 4)
        solve6(sys.lhsLin, sys.lhsAng, sys.lhsCross, neg3(sys.rhsLin, sys.rhsLin), neg3(sys.rhsAng, sys.rhsAng), this.dxLin, this.dxAng);
        addScaled3(body.positionLin, body.positionLin, this.dxLin, 1);
        qaddv(body.positionAng, body.positionAng, this.dxAng);
      }

      // Dual update
      for (const force of this.forces) force.updateDual(this.alpha);
    }

    // Velocities (BDF1) after the final iteration
    for (const body of bodies) {
      body.prevVelocityLin.set(body.velocityLin);
      if (body.mass > 0) {
        div3(body.velocityLin, sub3(body.velocityLin, body.positionLin, body.initialLin), dt);
        div3(body.velocityAng, qsub(body.velocityAng, body.positionAng, body.initialAng), dt);
      }
    }
  }
}

const st = vec3();
const scaleTmp = (v: V3, s: number): V3 => scale3(st, v, s);
