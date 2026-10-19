/* Copyright (c) 2026 Chris Giles
 * Permission to use, copy, modify, distribute and sell this software and its
 * documentation for any purpose is hereby granted without fee, provided that
 * the above copyright notice appear in all copies. Chris Giles makes no
 * representations about the suitability of this software for any purpose.
 * It is provided "as is" without express or implied warranty.
 */
// Algorithm 1 and implementation additions from pinned sdf-dcd-demo collide.cpp.
import { f, add, sub, mul, div, plus, minus, scale, divide, dot, length, normalize, vmin, vmax, intersection, expand, size, contains, valid, Random, type Vec, type Aabb } from './math.ts';
import { AnalyticField } from './shapes.ts';
import { SdfBody } from './body.ts';
import { objective, objectiveGradient, softmax, nelderMead, ellipsoidMethod, gradientDescent, diagonal, blendEllipsoids, type Counters, type Mat3 } from './optimize.ts';
export interface CollisionParams {
  /** Opt-in signed projection against static boxes for mixed inside/outside samples. */
  signedSeparation?: boolean;
  /** GPU-only exact mesh vertex contacts: a support on a fully covering static box top face,
   * and for two dynamic meshes the deepest overlapping source vertex within the trigger distance
   * (at most MESH_WITNESS_MAX_VERTICES unique vertices per field). */
  meshVertexContacts?: boolean;
  /** Refresh sticking anchors when a relocated contact is deeper by more than tolerance. */
  refreshDeeperContacts?: boolean;
  /** Opt-in for optimizer 2: stop only on the gradient norm or the iteration limit, dropping the
   * released ‖Δx‖ < τ test. Matches the paper's Table 5 SGD cost in aggregate (see FINDINGS). */
  sgdGradientStopOnly?: boolean;
  /** 0 Nelder–Mead (default), 1 deep-cut ellipsoid [LM24], 2 stochastic gradient descent [RM51]. */
  optimizer: 0 | 1 | 2; cacheSize: number; randomSamples: number; warmStart: boolean; curvatureSampling: boolean;
  skipConvexSamples: boolean; epsilon: number; alpha: number; replacementThreshold: number;
  tolerance: number; maxIterations: number; stepSize: number; margin: number; allowedPenetration: number;
}
export const collisionParams = (): CollisionParams => ({ optimizer: 0, cacheSize: 4, randomSamples: 1, warmStart: true, curvatureSampling: true, skipConvexSamples: true, epsilon: f(0.1), alpha: f(0.01), replacementThreshold: f(0.01), tolerance: f(0.01), maxIterations: 50, stepSize: f(0.1), margin: f(0.02), allowedPenetration: f(0.01) });
/** Convert unit-scene parameters to a uniformly scaled world. Epsilon is length²
 * (it is under the softmax square root); alpha and sample counts are dimensionless.
 * Explicit opt-in: choose a common pair/scene scale, not separate scales per body.
 */
export function scaleCollisionParams(lengthScale: number, params: CollisionParams = collisionParams()): CollisionParams {
  if (!Number.isFinite(lengthScale) || lengthScale <= 0) throw new Error('Collision length scale must be positive and finite');
  const scaled = { ...params, epsilon: f(params.epsilon * lengthScale * lengthScale) };
  for (const key of ['replacementThreshold', 'tolerance', 'stepSize', 'margin', 'allowedPenetration'] as const) scaled[key] = f(params[key] * lengthScale);
  if (!(params.epsilon === 0 || scaled.epsilon > 0) || ![scaled.tolerance, scaled.stepSize].every(v => Number.isFinite(v) && v > 0)
    || ![scaled.epsilon, scaled.margin, scaled.allowedPenetration, scaled.replacementThreshold].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Collision scale or parameters exceed supported float32 range');
  return scaled;
}
export interface SdfContact {
  x: Vec; normal: Vec; depth: number; separation: number; softmax: number; rank: number; active: boolean; cached: boolean;
  normalImpulse: number; frictionImpulse: Vec; ellipsoid: Vec[];
  /** Optional consumer identity; retained through cache advection, independent of rank. */
  id?: number;
}
export const contact = (): SdfContact => ({ x: [0, 0, 0], normal: [0, 1, 0], depth: 0, separation: 0, softmax: 0, rank: 0, active: false, cached: false, normalImpulse: 0, frictionImpulse: [0, 0, 0], ellipsoid: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] });
export class SdfManifold {
  bodyA: SdfBody;
  bodyB: SdfBody;
  points: SdfContact[] = [];
  volume: Aabb = { min: [0, 0, 0], max: [0, 0, 0] };
  constructor(a: SdfBody, b: SdfBody) { this.bodyA = a; this.bodyB = b; }
  update(p: CollisionParams, dt: number, rng: Random, stats: Counters): void {
    if (p.meshVertexContacts) throw new Error('meshVertexContacts is a GPU-only collision extension');
    if (p.optimizer !== 0 && p.optimizer !== 1 && p.optimizer !== 2) throw new Error('SDF optimizer must be 0 (Nelder–Mead), 1 (ellipsoid) or 2 (gradient descent)');
    this.volume = intersection(expand(this.bodyA.bounds, mul(0.5, p.margin)), expand(this.bodyB.bounds, mul(0.5, p.margin)));
    // Upstream broadphase guarantees this. Direct callers may present a separated pair.
    if (!valid(this.volume)) { this.points = []; return; }
    stats.pairs++;
    const cache = this.points.slice(0, p.warmStart ? p.cacheSize : 0); this.points = [];
    for (const old of cache) {
      const point = { ...old, cached: true };
      const a = this.bodyA.pointVelocity(point.x), b = this.bodyB.pointVelocity(point.x);
      const v = this.bodyA.isStatic ? b : this.bodyB.isStatic ? a : scale(plus(a, b), 0.5);
      this.addPoint(point, plus(point.x, scale(v, dt)), p, stats, rng);
    }
    const contacts = cache.filter(c => c.active).length;
    // Gradient descent stalls too easily and keeps its samples (collide.cpp).
    const skip = p.skipConvexSamples && p.optimizer !== 2 && contacts > 0 && contacts === p.cacheSize && this.bodyA.field.convex && this.bodyB.field.convex;
    const samples = (skip ? 0 : p.randomSamples) + Math.max(0, p.cacheSize - cache.length);
    for (let i = 0; i < samples; i++) this.addPoint(contact(), this.stochasticSample(p, rng), p, stats, rng);
    const unique: SdfContact[] = [];
    for (const c of this.points) if (!unique.some(q => dot(minus(c.x, q.x), minus(c.x, q.x)) < mul(p.tolerance, p.tolerance))) unique.push(c);
    this.points = unique;
    for (const c of unique) {
      c.rank = add(c.softmax, c.cached ? 0 : p.replacementThreshold);
      for (const q of unique) c.rank = sub(c.rank, mul(p.alpha, length(minus(c.x, q.x))));
    }
    this.points.sort((a, b) => a.rank - b.rank);
    stats.contacts += this.points.filter(c => c.active).length;
  }
  private stochasticSample(p: CollisionParams, rng: Random): Vec {
    let sample = rng.inBox(this.volume), count = 0;
    if (!p.curvatureSampling) return sample;
    for (const b of [this.bodyA, this.bodyB]) {
      const local = b.localBounds(this.volume);
      for (const seed of b.field.seeds) {
        if (!contains(local, seed)) continue;
        const x = b.toWorld(seed);
        if (contains(this.volume, x) && rng.integer(++count) === 0) sample = x;
      }
    }
    return sample;
  }
  private addPoint(point: SdfContact, seed: Vec, p: CollisionParams, stats: Counters, rng: Random): void {
    let result: { x: Vec; iterations: number };
    if (p.optimizer === 1) {
      // collide.cpp: an ellipsoid centred at the seed enclosing V; cached points blend their
      // previous ellipsoid 0.75/0.25 with it (Sec. 3.7, [LM24]).
      const g = objectiveGradient(this.bodyA, this.bodyB, this.points, p.epsilon, p.alpha, stats);
      const center = scale(plus(this.volume.min, this.volume.max), 0.5);
      const extent = plus(scale(size(this.volume), 0.5), minus(seed, center).map(Math.abs) as Vec);
      let E = diagonal(extent.map(e => mul(mul(e, e), 3)) as Vec);
      if (point.cached) E = blendEllipsoids(point.ellipsoid as Mat3, E);
      const out = ellipsoidMethod(g, seed, this.volume, E, p.tolerance, p.maxIterations);
      point.ellipsoid = out.ellipsoid; result = out;
    } else if (p.optimizer === 2) {
      const g = objectiveGradient(this.bodyA, this.bodyB, this.points, p.epsilon, p.alpha, stats);
      result = gradientDescent(g, seed, this.volume, p.stepSize, p.tolerance, p.maxIterations, rng, !p.sgdGradientStopOnly);
    } else {
      const g = objective(this.bodyA, this.bodyB, this.points, p.epsilon, p.alpha, stats);
      let step = vmax(scale(size(this.volume), f(0.1)), [mul(0.5, p.tolerance), mul(0.5, p.tolerance), mul(0.5, p.tolerance)]);
      if (point.cached) { const extent = Math.max(length(minus(seed, point.x)), mul(5, p.tolerance)); step = vmin(step, [extent, extent, extent]); }
      result = nelderMead(g, seed, this.volume, step, p.tolerance, p.maxIterations);
    }
    stats.iterations += result.iterations;
    const a = this.bodyA.sample(result.x), b = this.bodyB.sample(result.x); stats.queries++;
    const na = normalize(a.gradient), nb = scale(normalize(b.gradient), -1), previous = point.normal;
    point.x = result.x; point.depth = Math.min(a.phi, b.phi); point.normal = a.phi < b.phi ? na : nb;
    point.separation = add(a.phi, b.phi); point.softmax = softmax(a.phi, b.phi, p.epsilon);
    if (point.cached) point.normal = dot(na, previous) > dot(nb, previous) ? na : nb;
    if (a.phi > 0 || b.phi > 0) {
      const gap = minus(scale(a.gradient, div(a.phi, Math.max(dot(a.gradient, a.gradient), f(1e-8)))), scale(b.gradient, div(b.phi, Math.max(dot(b.gradient, b.gradient), f(1e-8)))));
      point.separation = length(gap);
      const fixedA = this.bodyA.isStatic && this.bodyA.field instanceof AnalyticField && this.bodyA.field.spec.kind === 'box';
      const fixedB = this.bodyB.isStatic && this.bodyB.field instanceof AnalyticField && this.bodyB.field.spec.kind === 'box';
      if (p.signedSeparation && (a.phi <= 0 || b.phi <= 0)) {
        if (fixedA || fixedB) {
          point.normal = fixedA ? na : nb; point.separation = dot(gap, point.normal);
          // phi/|grad|^2 is unbounded where a voxel gradient vanishes; fall back to the bounded sum.
          const moving = fixedA ? b.gradient : a.gradient;
          if (dot(moving, moving) < 0.25) point.separation = add(a.phi, b.phi);
        }
      }
      if (a.phi > 0 && b.phi > 0 && point.separation > 1e-6 && !(point.cached && dot(gap, previous) < 0)) point.normal = divide(gap, point.separation);
    }
    point.active = point.separation < p.margin; this.points.push(point);
  }
}
