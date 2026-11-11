// Isolated f64 CPU research adapter. The reference and public library stay unchanged.
import { PENALTY_MAX, Rigid } from '../ref/body.ts';
import { Manifold } from '../ref/manifold.ts';
import type { Contact } from '../ref/manifold.ts';
import type { Solver } from '../ref/solver.ts';

export type RestitutionCombine = 'average' | 'min' | 'multiply' | 'max';
export interface RestitutionOptions {
  restitution: (body: Rigid) => number;
  combine: RestitutionCombine;
  threshold: number;
  impactPenaltyFloor?: boolean;
  releaseImpactLambda?: boolean;
}

function coefficient(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Restitution must be finite and in [0, 1]');
}

function combineRule(rule: RestitutionCombine): void {
  if (!['average', 'min', 'multiply', 'max'].includes(rule)) throw new RangeError('Unknown restitution combine rule');
}

export function combineRestitution(a: number, b: number, rule: RestitutionCombine): number {
  coefficient(a);
  coefficient(b);
  combineRule(rule);
  switch (rule) {
    case 'average': return (a + b) / 2;
    case 'min': return Math.min(a, b);
    case 'multiply': return a * b;
    case 'max': return Math.max(a, b);
  }
}

function normalSpeed(c: Contact, a: Rigid, b: Rigid): number {
  return c.JAn[0] * a.velocity[0] + c.JAn[1] * a.velocity[1] + c.JAn[2] * a.velocity[2] +
    c.JBn[0] * b.velocity[0] + c.JBn[1] * b.velocity[1] + c.JBn[2] * b.velocity[2];
}

export interface NormalSample {
  bodyA: number;
  bodyB: number;
  feature: number;
  row: number;
  before: number;
  after: number;
  bias: number;
  c0: number;
  normalLambda: number;
  penaltyFloor: number;
  /** End-of-main-solve fixed-J row residual in metres, from BDF1 velocity. */
  rowResidual: number;
  /** Present only in the opt-in memory diagnostic; value is before warm-start decay. */
  releasedNormalLambda?: number;
  releasedCount?: number;
}

export class RestitutionManifold extends Manifold {
  readonly bias: number[] = [];
  readonly incoming: number[] = [];
  private releaseEnabled = false;
  private readonly released: number[] = [];
  private readonly releaseCounts: number[] = [];
  private pairCoefficient = 0;
  private threshold = 1;
  private floorEnabled = false;
  private floorPending = false;
  private floor = 0;

  /** The wrapper replaces this snapshot every step, including on persistent contacts. */
  prepare(pairCoefficient: number, threshold: number, floorEnabled: boolean, releaseImpactLambda = false): void {
    coefficient(pairCoefficient);
    if (!Number.isFinite(threshold) || threshold < 0.1) throw new RangeError('Threshold must be finite and >= 0.1 m/s');
    if (typeof floorEnabled !== 'boolean') throw new TypeError('Penalty floor must be boolean');
    if (typeof releaseImpactLambda !== 'boolean') throw new TypeError('Impact lambda release must be boolean');
    this.releaseEnabled = releaseImpactLambda;
    this.pairCoefficient = pairCoefficient;
    this.threshold = threshold;
    this.floorEnabled = floorEnabled;
  }

  override initialize(): boolean {
    // Read the preceding step by feature before super replaces/reorders contacts.
    const biasedFeatures = new Set(this.contacts.filter((_, i) => this.bias[i] > 0).map((c) => c.feature));
    const active = super.initialize();
    this.released.length = this.releaseCounts.length = 0;
    this.bias.length = this.incoming.length = 0;
    this.floorPending = this.floorEnabled;
    const masses = [this.bodyA!.mass, this.bodyB.mass].filter((mass) => mass > 0);
    this.floor = masses.length ? Math.min(PENALTY_MAX, Math.min(...masses) / (this.solver.dt * this.solver.dt)) : 0;
    for (const [i, c] of this.contacts.entries()) {
      const vn = normalSpeed(c, this.bodyA!, this.bodyB);
      const release = this.releaseEnabled && biasedFeatures.has(c.feature) && vn > 0;
      this.released.push(release ? this.lambda[i * 2] : 0);
      this.releaseCounts.push(release ? 1 : 0);
      if (release) this.lambda[i * 2] = 0;
      this.incoming.push(vn);
      this.bias.push(this.pairCoefficient > 0 && vn < -this.threshold ? this.pairCoefficient * -vn * this.solver.dt : 0);
    }
    return active;
  }

  override computeConstraint(alpha: number): void {
    super.computeConstraint(alpha);
    for (let i = 0; i < this.numContacts; i++) {
      if (this.bias[i] === 0) continue; // Preserve the reference's arithmetic exactly in zero mode.
      if (this.floorPending) this.penalty[i * 2] = Math.max(this.penalty[i * 2], this.floor);
      this.C[i * 2] += Math.min(0, -this.bias[i] - (1 - alpha) * this.contacts[i].C0[0]);
    }
    // This call is after reference warm-start decay and before the first primal force use.
    this.floorPending = false;
  }

  samples(): NormalSample[] {
    const alpha = this.solver.postStabilize ? 1 : this.solver.alpha;
    return this.contacts.map((c, i) => {
      const after = normalSpeed(c, this.bodyA!, this.bodyB);
      const initialTerm = (1 - alpha) * c.C0[0];
      return {
        bodyA: this.solver.bodies.indexOf(this.bodyA!), bodyB: this.solver.bodies.indexOf(this.bodyB),
        feature: c.feature, row: i * 2, before: this.incoming[i], after, bias: this.bias[i], c0: c.C0[0],
        normalLambda: this.lambda[i * 2], penaltyFloor: this.floorEnabled && this.bias[i] > 0 ? this.floor : 0,
        ...(this.releaseEnabled ? { releasedNormalLambda: this.released[i], releasedCount: this.releaseCounts[i] } : {}),
        rowResidual: after * this.solver.dt + (this.bias[i] > 0 ? Math.min(initialTerm, -this.bias[i]) : initialTerm),
      };
    });
  }
}

export interface RestitutionStep {
  fired: number;
  maxApproach: number;
  contacts: NormalSample[];
}

/** Preflight is observational: callbacks must not mutate the solver. No callbacks run in the solve. */
export function stepWithRestitution(solver: Solver, options: RestitutionOptions): RestitutionStep {
  const { restitution, combine, threshold, impactPenaltyFloor = false, releaseImpactLambda = false } = options;
  if (typeof restitution !== 'function') throw new TypeError('Restitution must be a body callback');
  combineRule(combine);
  if (!Number.isFinite(threshold) || threshold < 0.1) throw new RangeError('Threshold must be finite and >= 0.1 m/s');
  if (typeof impactPenaltyFloor !== 'boolean') throw new TypeError('Penalty floor must be boolean');
  if (typeof releaseImpactLambda !== 'boolean') throw new TypeError('Impact lambda release must be boolean');
  if (!Number.isFinite(solver.dt) || solver.dt <= 0 || !Number.isFinite(solver.dt * solver.dt) || solver.dt * solver.dt === 0 ||
      !Number.isInteger(solver.iterations) || solver.iterations < 1 ||
      !Number.isFinite(solver.gravity) || !Number.isFinite(solver.beta) || solver.beta < 0 ||
      !Number.isFinite(solver.alpha) || solver.alpha < 0 || solver.alpha > 1 ||
      !Number.isFinite(solver.gamma) || solver.gamma < 0 || solver.gamma > 1 ||
      typeof solver.postStabilize !== 'boolean' || typeof solver.stiffnessRescale !== 'boolean' || solver.vbd !== false) {
    throw new RangeError('Invalid or unsupported experiment solver parameters');
  }
  for (const force of solver.forces) {
    if (force instanceof Manifold && !(force instanceof RestitutionManifold)) {
      throw new Error('Existing ordinary Manifold: use a fresh experiment solver');
    }
    if (force.solver !== solver || !solver.bodies.includes(force.bodyB) ||
        (force.bodyA !== null && !solver.bodies.includes(force.bodyA))) {
      throw new Error('Force references a body outside this experiment solver');
    }
  }
  const values = new Map<Rigid, number>();
  for (const body of solver.bodies) {
    if (body.solver !== solver || values.has(body) ||
        ![...body.position, ...body.velocity, ...body.prevVelocity, ...body.size, body.radius, body.mass, body.moment, body.friction].every(Number.isFinite) ||
        body.size.some((size) => size <= 0) || body.radius <= 0 || body.mass < 0 || body.moment < 0 || body.friction < 0) {
      throw new RangeError('Invalid experiment body');
    }
    const value = restitution(body);
    coefficient(value);
    values.set(body, value);
  }

  // Same order, bounding circle and constrained-pair condition as the reference broadphase.
  const bodies = solver.bodies;
  for (let i = bodies.length - 1; i >= 0; i--) {
    const bodyA = bodies[i];
    for (let j = i - 1; j >= 0; j--) {
      const bodyB = bodies[j];
      const dpx = bodyA.position[0] - bodyB.position[0];
      const dpy = bodyA.position[1] - bodyB.position[1];
      const r = bodyA.radius + bodyB.radius;
      if (dpx * dpx + dpy * dpy <= r * r && !bodyA.constrainedTo(bodyB)) new RestitutionManifold(solver, bodyA, bodyB);
    }
  }
  for (const force of solver.forces) {
    if (force instanceof RestitutionManifold) {
      force.prepare(combineRestitution(values.get(force.bodyA!)!, values.get(force.bodyB)!, combine), threshold, impactPenaltyFloor, releaseImpactLambda);
    }
  }
  solver.step();
  const contacts = solver.forces.flatMap((force) => force instanceof RestitutionManifold ? force.samples() : []);
  return { contacts, fired: contacts.filter((c) => c.bias > 0).length,
    maxApproach: contacts.reduce((speed, c) => Math.max(speed, -c.before), 0) };
}
