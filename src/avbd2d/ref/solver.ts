// AVBD solver, ported from avbd-demo2d solver.cpp. This is the CPU reference ("oracle") that
// every later solver (SoA CPU, WebGPU) is validated against, so it stays a faithful port:
// same iteration order, same parameters, same post-stabilization scheme.

import { Force, PENALTY_MAX, PENALTY_MIN, Rigid } from './body.ts';
import { Manifold } from './manifold.ts';
import { clamp, min, sign, solve3 } from './math.ts';

export interface SolverParams {
  dt: number;
  gravity: number;
  iterations: number;
  /** Stabilization: fraction of step-start constraint error left uncorrected (Eq. 18). */
  alpha: number;
  /** Penalty ramping rate (Eq. 12 / 16). */
  beta: number;
  /** Warm-start decay of penalty and lambda (Eq. 19). */
  gamma: number;
  /** Solve with alpha = 1 then one extra alpha = 0 iteration instead of Baumgarte-style alpha. */
  postStabilize: boolean;
  /**
   * Paper extension, not in the demo: build the Hessian of a clamped force with the rescaled
   * stiffness of Eq. 14 instead of the raw penalty. Fixes under-applied sliding friction, but
   * destabilizes delicate stacking (see docs/FINDINGS.md).
   */
  stiffnessRescale: boolean;
  /**
   * Comparison mode, not in the demo: plain VBD. No dual variables, no penalty ramping, no
   * error regularization; hard constraints become springs of stiffness `vbdStiffness`.
   */
  vbd: boolean;
  vbdStiffness: number;
  /**
   * Parallel solvers only (the reference always matches strictly): when a new contact's
   * (pair, feature) key has no match in the previous step, warm-start it from that pair's
   * previous contact nearest in body-local position (within 5% of the smaller box). Feature
   * ids flicker under round-off (a vertex exactly on a side plane gets clipped or not), and
   * losing the warm start on one of two symmetric contacts toppled the GPU stack.
   */
  matchNearest: boolean;
}

export const defaultParams = (): SolverParams => ({
  dt: 1 / 60,
  gravity: -10,
  iterations: 10,
  // The paper suggests beta in [1, 1000]; the best value depends on the units of length,
  // mass and constraint functions, and on the penalty strategy. The demo uses 1e5.
  beta: 100000,
  // Higher alpha = slower, smoother error correction.
  alpha: 0.99,
  // Must be < 1 so penalties can decrease over time.
  gamma: 0.99,
  // Post stabilization removes the need to tune alpha.
  postStabilize: true,
  stiffnessRescale: false,
  vbd: false,
  vbdStiffness: 1000000,
  matchNearest: false,
});

/**
 * Defaults for the parallel (coloured, f32) solvers, chosen by measurement in Stage 2
 * (docs/FINDINGS.md): Baumgarte-style alpha instead of post-stabilization gives 2-4x lower
 * joint error, holds static friction at 10 iterations, and skips one primal pass. Contacts
 * also fall back to nearest-anchor warm starts (see matchNearest).
 */
export const parallelParams = (): SolverParams => ({ ...defaultParams(), postStabilize: false, alpha: 0.95, matchNearest: true });

export class Solver implements SolverParams {
  dt = 1 / 60;
  gravity = -10;
  iterations = 10;
  alpha = 0.99;
  beta = 100000;
  gamma = 0.99;
  postStabilize = true;
  stiffnessRescale = false;
  vbd = false;
  vbdStiffness = 1000000;
  /** Unused here: the reference keeps the demo's strict feature matching. */
  matchNearest = false;

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

  /** Find the body under world point `at`; returns it with the body-local point. */
  pick(x: number, y: number): { body: Rigid; local: [number, number] } | null {
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      const body = this.bodies[i];
      const c = Math.cos(-body.position[2]);
      const s = Math.sin(-body.position[2]);
      const dx = x - body.position[0];
      const dy = y - body.position[1];
      const lx = c * dx - s * dy;
      const ly = s * dx + c * dy;
      if (Math.abs(lx) <= body.size[0] * 0.5 && Math.abs(ly) <= body.size[1] * 0.5) {
        return { body, local: [lx, ly] };
      }
    }
    return null;
  }

  // Scratch storage for the per-body linear system
  private readonly lhs = new Float64Array(9);
  private readonly dx = new Float64Array(3);

  step(): void {
    const { dt, gravity, bodies } = this;
    const postStabilize = this.postStabilize && !this.vbd;
    const alpha = this.vbd ? 0 : this.alpha;

    // Broadphase: naive O(n^2) bounding-circle test, sufficient for the demo scenes.
    for (let i = bodies.length - 1; i >= 0; i--) {
      const bodyA = bodies[i];
      for (let j = i - 1; j >= 0; j--) {
        const bodyB = bodies[j];
        const dpx = bodyA.position[0] - bodyB.position[0];
        const dpy = bodyA.position[1] - bodyB.position[1];
        const r = bodyA.radius + bodyB.radius;
        if (dpx * dpx + dpy * dpy <= r * r && !bodyA.constrainedTo(bodyB)) new Manifold(this, bodyA, bodyB);
      }
    }

    // Initialize and warm-start forces; drop the inactive ones
    const kept: Force[] = [];
    for (const force of this.forces) {
      if (!force.initialize()) {
        force.unlinkFromBodies();
        continue;
      }
      kept.push(force);
      for (let i = 0; i < force.rows(); i++) {
        if (this.vbd) {
          // Plain VBD: a fixed quadratic energy per row; lambda only tracks the force for
          // friction bounds and is recomputed every iteration.
          force.penalty[i] = min(force.stiffness[i], this.vbdStiffness);
          continue;
        }
        if (postStabilize) {
          // With post stabilization we can reuse the full lambda; only decay the penalty
          force.penalty[i] = clamp(force.penalty[i] * this.gamma, PENALTY_MIN, PENALTY_MAX);
        } else {
          // Warm-start the dual variables and penalty parameters (Eq. 19)
          force.lambda[i] = force.lambda[i] * alpha * this.gamma;
          force.penalty[i] = clamp(force.penalty[i] * this.gamma, PENALTY_MIN, PENALTY_MAX);
        }
        // Soft constraints never exceed their material stiffness
        force.penalty[i] = min(force.penalty[i], force.stiffness[i]);
      }
    }
    this.forces = kept;

    // Initialize and warm-start bodies (primal variables)
    for (let b = bodies.length - 1; b >= 0; b--) {
      const body = bodies[b];
      const p = body.position;
      const v = body.velocity;

      // Don't let bodies rotate too fast
      v[2] = clamp(v[2], -50, 50);

      // Inertial position (Eq. 2)
      body.inertial[0] = p[0] + v[0] * dt;
      body.inertial[1] = p[1] + v[1] * dt;
      body.inertial[2] = p[2] + v[2] * dt;
      if (body.mass > 0) body.inertial[1] += gravity * dt * dt;

      // Adaptive warm start (see the original VBD paper)
      const accelY = (v[1] - body.prevVelocity[1]) / dt;
      const accelExt = accelY * sign(gravity);
      let accelWeight = clamp(accelExt / Math.abs(gravity), 0, 1);
      if (!Number.isFinite(accelWeight)) accelWeight = 0;

      // Save x- and compute the warm-started position
      body.initial.set(p);
      p[0] = p[0] + v[0] * dt;
      p[1] = p[1] + v[1] * dt + gravity * accelWeight * dt * dt;
      p[2] = p[2] + v[2] * dt;
    }

    // Main solver loop; post stabilization adds one extra iteration
    const totalIterations = this.iterations + (postStabilize ? 1 : 0);
    const lhs = this.lhs;

    for (let it = 0; it < totalIterations; it++) {
      // With post stabilization, remove either all or none of the pre-existing error
      let currentAlpha = alpha;
      if (postStabilize) currentAlpha = it < this.iterations ? 1 : 0;

      // Primal update
      for (let b = bodies.length - 1; b >= 0; b--) {
        const body = bodies[b];
        if (body.mass <= 0) continue; // static / kinematic

        // Left and right hand sides of the linear system (Eqs. 5, 6)
        const mdt = body.mass / (dt * dt);
        const idt = body.moment / (dt * dt);
        lhs.fill(0);
        lhs[0] = mdt;
        lhs[4] = mdt;
        lhs[8] = idt;
        let rhs0 = mdt * (body.position[0] - body.inertial[0]);
        let rhs1 = mdt * (body.position[1] - body.inertial[1]);
        let rhs2 = idt * (body.position[2] - body.inertial[2]);

        const forces = body.forces;
        for (let fi = forces.length - 1; fi >= 0; fi--) {
          const force = forces[fi];
          force.computeConstraint(currentAlpha);
          force.computeDerivatives(body);

          const { J, H } = force;
          for (let i = 0; i < force.rows(); i++) {
            // Lambda is only used for hard constraints
            const lambda = !this.vbd && force.stiffness[i] === Infinity ? force.lambda[i] : 0;

            // Clamped force magnitude (Sec. 3.2)
            let pen = force.penalty[i];
            const C = force.C[i];
            const fRaw = pen * C + lambda;
            const f = clamp(fRaw, force.fmin[i], force.fmax[i]);
            const af = Math.abs(f);

            // Stiffness rescaling for clamped forces (Eq. 14), Hessian only
            if (this.stiffnessRescale && C !== 0) {
              if (fRaw < force.fmin[i]) pen = Math.abs((force.fmin[i] - lambda) / C);
              else if (fRaw > force.fmax[i]) pen = Math.abs((force.fmax[i] - lambda) / C);
            }

            const j0 = J[i * 3], j1 = J[i * 3 + 1], j2 = J[i * 3 + 2];
            const h = i * 9;

            // Accumulate force (Eq. 13) and hessian (Eq. 17) with the diagonally lumped
            // geometric stiffness (Sec. 3.5): column norms of H scaled by |f|.
            rhs0 += j0 * f;
            rhs1 += j1 * f;
            rhs2 += j2 * f;
            lhs[0] += j0 * j0 * pen + Math.hypot(H[h], H[h + 3], H[h + 6]) * af;
            lhs[1] += j0 * j1 * pen;
            lhs[2] += j0 * j2 * pen;
            lhs[3] += j1 * j0 * pen;
            lhs[4] += j1 * j1 * pen + Math.hypot(H[h + 1], H[h + 4], H[h + 7]) * af;
            lhs[5] += j1 * j2 * pen;
            lhs[6] += j2 * j0 * pen;
            lhs[7] += j2 * j1 * pen;
            lhs[8] += j2 * j2 * pen + Math.hypot(H[h + 2], H[h + 5], H[h + 8]) * af;
          }
        }

        // Solve the SPD system with LDLᵀ and apply the update (Eq. 4)
        solve3(lhs, rhs0, rhs1, rhs2, this.dx);
        body.position[0] -= this.dx[0];
        body.position[1] -= this.dx[1];
        body.position[2] -= this.dx[2];
      }

      // Dual update, skipped for the post-stabilization iteration
      if (it < this.iterations) {
        for (const force of this.forces) {
          force.computeConstraint(currentAlpha);
          for (let i = 0; i < force.rows(); i++) {
            const lambda = !this.vbd && force.stiffness[i] === Infinity ? force.lambda[i] : 0;

            // Update lambda (Eq. 11)
            force.lambda[i] = clamp(force.penalty[i] * force.C[i] + lambda, force.fmin[i], force.fmax[i]);

            // Disable the force if it exceeded its fracture threshold
            if (Math.abs(force.lambda[i]) >= force.fracture[i]) force.disable();

            // Ramp the penalty, clamped to material stiffness, if within force bounds (Eq. 16)
            if (!this.vbd && force.lambda[i] > force.fmin[i] && force.lambda[i] < force.fmax[i]) {
              force.penalty[i] = min(
                force.penalty[i] + this.beta * Math.abs(force.C[i]),
                min(PENALTY_MAX, force.stiffness[i]),
              );
            }
          }
        }
      }

      // After the last regular iteration, compute velocities (BDF1)
      if (it === this.iterations - 1) {
        for (const body of bodies) {
          body.prevVelocity.set(body.velocity);
          if (body.mass > 0) {
            body.velocity[0] = (body.position[0] - body.initial[0]) / dt;
            body.velocity[1] = (body.position[1] - body.initial[1]) / dt;
            body.velocity[2] = (body.position[2] - body.initial[2]) / dt;
          }
        }
      }
    }
  }
}
