// Joint, Spring, Motor and IgnoreCollision, ported from avbd-demo2d (joint.cpp, spring.cpp,
// motor.cpp, solver.h).

import { Force, Rigid } from './body.ts';
import { rotate, transform, type Vec3 } from './math.ts';
import type { Solver } from './solver.ts';

function setRow(out: Float64Array, row: number, x: number, y: number, z: number): void {
  out[row * 3] = x;
  out[row * 3 + 1] = y;
  out[row * 3 + 2] = z;
}

/**
 * Revolute joint + angle constraint between two bodies, with optional fracture. When bodyA is
 * null the joint attaches bodyB to the world-space point rA.
 */
export class Joint extends Force {
  rA: [number, number];
  rB: [number, number];
  readonly C0 = new Float64Array(3);
  torqueArm: number;
  restAngle: number;

  constructor(
    solver: Solver,
    bodyA: Rigid | null,
    bodyB: Rigid,
    rA: [number, number],
    rB: [number, number],
    stiffness: Vec3 = [Infinity, Infinity, Infinity],
    fracture = Infinity,
  ) {
    super(solver, bodyA, bodyB);
    this.rA = [rA[0], rA[1]];
    this.rB = [rB[0], rB[1]];
    this.stiffness[0] = stiffness[0];
    this.stiffness[1] = stiffness[1];
    this.stiffness[2] = stiffness[2];
    this.fmax[2] = fracture;
    this.fmin[2] = -fracture;
    this.fracture[2] = fracture;
    this.restAngle = (bodyA ? bodyA.position[2] : 0) - bodyB.position[2];
    const sx = (bodyA ? bodyA.size[0] : 0) + bodyB.size[0];
    const sy = (bodyA ? bodyA.size[1] : 0) + bodyB.size[1];
    this.torqueArm = sx * sx + sy * sy;
  }

  rows(): number {
    return 3;
  }

  private evaluate(out: Float64Array): void {
    const a = this.bodyA ? transform(this.bodyA.position, this.rA[0], this.rA[1]) : this.rA;
    const b = transform(this.bodyB.position, this.rB[0], this.rB[1]);
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = ((this.bodyA ? this.bodyA.position[2] : 0) - this.bodyB.position[2] - this.restAngle) * this.torqueArm;
  }

  initialize(): boolean {
    // Store constraint function at the beginning of the timestep C(x-)
    this.evaluate(this.C0);
    return this.stiffness[0] !== 0 || this.stiffness[1] !== 0 || this.stiffness[2] !== 0;
  }

  private readonly Cn = new Float64Array(3);

  computeConstraint(alpha: number): void {
    this.evaluate(this.Cn);
    for (let i = 0; i < 3; i++) {
      // Stabilized constraint function for hard constraints (Eq. 18)
      this.C[i] = this.stiffness[i] === Infinity ? this.Cn[i] - this.C0[i] * alpha : this.Cn[i];
    }
  }

  computeDerivatives(body: Rigid): void {
    const { J, H } = this;
    H.fill(0, 0, 27);
    if (body === this.bodyA) {
      const r = rotate(body.position[2], this.rA[0], this.rA[1]);
      setRow(J, 0, 1, 0, -r[1]);
      setRow(J, 1, 0, 1, r[0]);
      setRow(J, 2, 0, 0, this.torqueArm);
      H[0 * 9 + 8] = -r[0];
      H[1 * 9 + 8] = -r[1];
    } else {
      const r = rotate(body.position[2], this.rB[0], this.rB[1]);
      setRow(J, 0, -1, 0, r[1]);
      setRow(J, 1, 0, -1, -r[0]);
      setRow(J, 2, 0, 0, -this.torqueArm);
      H[0 * 9 + 8] = r[0];
      H[1 * 9 + 8] = r[1];
    }
  }
}

/** Standard spring force. A negative rest length means "use the current distance". */
export class Spring extends Force {
  rA: [number, number];
  rB: [number, number];
  rest: number;

  constructor(
    solver: Solver,
    bodyA: Rigid,
    bodyB: Rigid,
    rA: [number, number],
    rB: [number, number],
    stiffness: number,
    rest = -1,
  ) {
    super(solver, bodyA, bodyB);
    this.rA = [rA[0], rA[1]];
    this.rB = [rB[0], rB[1]];
    this.stiffness[0] = stiffness;
    this.rest = rest;
    if (this.rest < 0) {
      const a = transform(bodyA.position, rA[0], rA[1]);
      const b = transform(bodyB.position, rB[0], rB[1]);
      this.rest = Math.hypot(a[0] - b[0], a[1] - b[1]);
    }
  }

  rows(): number {
    return 1;
  }

  initialize(): boolean {
    return true;
  }

  private delta(): [number, number] {
    const a = transform(this.bodyA!.position, this.rA[0], this.rA[1]);
    const b = transform(this.bodyB.position, this.rB[0], this.rB[1]);
    return [a[0] - b[0], a[1] - b[1]];
  }

  computeConstraint(): void {
    const d = this.delta();
    this.C[0] = Math.hypot(d[0], d[1]) - this.rest;
  }

  computeDerivatives(body: Rigid): void {
    const d = this.delta();
    const dlen2 = d[0] * d[0] + d[1] * d[1];
    if (dlen2 === 0) return;

    const dlen = Math.sqrt(dlen2);
    const nx = d[0] / dlen;
    const ny = d[1] / dlen;
    // dxx = (I - n nᵀ) / |d|
    const d00 = (1 - nx * nx) / dlen;
    const d01 = (0 - nx * ny) / dlen;
    const d10 = (0 - ny * nx) / dlen;
    const d11 = (1 - ny * ny) / dlen;

    const isA = body === this.bodyA;
    const local = isA ? this.rA : this.rB;
    // S = [[0, -1], [1, 0]] (90° rotation), applied in local space then rotated to world
    const Sr = rotate(body.position[2], -local[1], local[0]);
    const r = rotate(body.position[2], local[0], local[1]);
    const dxr0 = d00 * Sr[0] + d01 * Sr[1];
    const dxr1 = d10 * Sr[0] + d11 * Sr[1];
    const nr = nx * r[0] + ny * r[1];
    const nSr = nx * Sr[0] + ny * Sr[1];

    if (isA) setRow(this.J, 0, nx, ny, nSr);
    else setRow(this.J, 0, -nx, -ny, -nSr);
    const drr = isA ? -nr - nr : nr + nr;

    const H = this.H;
    H[0] = d00; H[1] = d01; H[2] = dxr0;
    H[3] = d10; H[4] = d11; H[5] = dxr1;
    H[6] = dxr0; H[7] = dxr1; H[8] = drr;
  }
}

/** Force with no physical effect, used to disable collision between two bodies. */
export class IgnoreCollision extends Force {
  rows(): number {
    return 0;
  }
  initialize(): boolean {
    return true;
  }
  computeConstraint(): void {}
  computeDerivatives(): void {}
}

/** Applies torque between two bodies (or body and world) to reach a target angular speed. */
export class Motor extends Force {
  speed: number;

  constructor(solver: Solver, bodyA: Rigid | null, bodyB: Rigid, speed: number, maxTorque: number) {
    super(solver, bodyA, bodyB);
    this.speed = speed;
    this.fmax[0] = maxTorque;
    this.fmin[0] = -maxTorque;
  }

  rows(): number {
    return 1;
  }

  initialize(): boolean {
    return true;
  }

  computeConstraint(): void {
    const dAngleA = this.bodyA ? this.bodyA.position[2] - this.bodyA.initial[2] : 0;
    const dAngleB = this.bodyB.position[2] - this.bodyB.initial[2];
    this.C[0] = dAngleA - dAngleB - this.speed * this.solver.dt;
  }

  computeDerivatives(body: Rigid): void {
    setRow(this.J, 0, 0, 0, body === this.bodyA ? 1 : -1);
    this.H.fill(0, 0, 9);
  }
}
