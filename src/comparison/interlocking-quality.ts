// Device-free, engine-neutral pose-quality observables for the interlocking study (STE-3282).
// Inputs are pose snapshots only: no velocity, energy, contact force or engine contact data is
// read or inferred. Geometry comes from the shared authored scene; see docs/PAIRED_STUDIES.md
// "Quality contract" for the meaning and limits of every status.
import { INTERLOCKING, torusSectors, type RingPieces } from './interlocking-scene.ts';

/** Same shape as Rapier `poses()` and AVBD `readPoses().poses`. */
export interface StudyPose { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }
export type RingRepresentation = { kind: 'analytic-sdf' } | { kind: 'rapier-compound'; pieces: RingPieces };
type V = [number, number, number];
type Q = [number, number, number, number];

const S = Math.SQRT1_2;
/** Peg body rotation used by both engines: cylinder axis (local y) turned onto world z. */
export const PEG_ROTATION_CONVENTION: Q = [S, 0, 0, S];

/** Predeclared before any runtime trial; derived from the authored geometry, not from observed results. */
export const INTERLOCKING_QUALITY_CRITERIA = Object.freeze({
  /** Same unit-quaternion tolerance as contact-quality.ts. */
  quaternionNormTolerance: 1e-4,
  /** Allowed contact penetration: 10% of the tube radius (0.016 m). Applies to ring/ring, ring/peg, ring/floor. */
  penetrationLimit: .1 * INTERLOCKING.minorRadius,
  /** Existing supported-hanging endpoint guards from tests/interlocking-rapier.test.ts. Necessary only. */
  supportHeight: Object.freeze({ upperMinY: 2.5, lowerMinY: 1 }),
  /** Ring surface sampling (major × minor angle). Determines the Lipschitz covering radius. */
  surfaceSamples: Object.freeze({ major: 384, minor: 96 }),
});
export type InterlockingCriteria = typeof INTERLOCKING_QUALITY_CRITERIA;

// ---- small vector/quaternion helpers -------------------------------------------------------------
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V) => Math.hypot(a[0], a[1], a[2]);
function rotate(q: Q, v: V): V {
  const u: V = [q[0], q[1], q[2]], t = cross(u, v).map(c => 2 * c) as V, c = cross(u, t);
  return [v[0] + q[3] * t[0] + c[0], v[1] + q[3] * t[1] + c[1], v[2] + q[3] * t[2] + c[2]];
}
const conj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const unit = (q: Q): Q => { const n = Math.hypot(...q); return q.map(c => c / n) as Q; };

// ---- exact analytic fields (body/local frames) --------------------------------------------------
/** Analytic torus signed distance in the ring body frame (axis z, like THREE.TorusGeometry and the
 * Rapier sectors). AVBD's field is axis y and reaches this frame through FIELD_Y_TO_BODY_Z. */
export function torusBodyPhi(p: V, R = INTERLOCKING.majorRadius, r = INTERLOCKING.minorRadius) {
  return Math.hypot(Math.hypot(p[0], p[1]) - R, p[2]) - r;
}
/** Exact capped-cylinder signed distance in the peg local frame (axis y). */
export function cylinderLocalPhi(p: V, radius = INTERLOCKING.peg.radius, halfHeight = INTERLOCKING.peg.halfLength) {
  const dx = Math.hypot(p[0], p[2]) - radius, dy = Math.abs(p[1]) - halfHeight;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
function ringPhiWorld(p: V, ring: { c: V; q: Q }) { return torusBodyPhi(rotate(conj(ring.q), sub(p, ring.c))); }
function pegPhiWorld(p: V) {
  return cylinderLocalPhi(rotate(conj(PEG_ROTATION_CONVENTION), sub(p, [...INTERLOCKING.peg.position] as V)));
}

// ---- representation error -----------------------------------------------------------------------
export interface RepresentationError {
  kind: RingRepresentation['kind']; pieces?: RingPieces;
  /** False for compound estimates: no conservative whole-hull representation proof is available. */
  boundCertified: boolean;
  /** Sampled max analytic-torus distance of compound boundary points outside the analytic torus. */
  sampledOutward: number;
  /** Sampled max distance (lower-bound plane metric) of analytic surface points outside the compound. */
  sampledInward: number;
  /** Conservative derived chord/sag estimates (not a proof; not an exact SDF error). */
  derivedOutward: number; derivedInward: number;
  /** Band used to widen every pose verdict: max of the four values above. 0 for the analytic SDF. */
  band: number;
  note: string;
}
const representationCache = new Map<string, RepresentationError>();

/** Convex hull facet planes of a small point set by brute-force supporting triples. Exact enough for 24 points. */
function hullPlanes(points: V[]) {
  const planes: { n: V; d: number; tri: [V, V, V] }[] = [], eps = 1e-6;
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) for (let k = j + 1; k < points.length; k++) {
    let n = cross(sub(points[j], points[i]), sub(points[k], points[i]));
    const l = norm(n);
    if (l < 1e-9) continue;
    n = n.map(c => c / l) as V;
    let d = dot(n, points[i]), above = 0, below = 0;
    for (const p of points) { const s = dot(n, p) - d; if (s > eps) above++; else if (s < -eps) below++; }
    if (above && below) continue;
    if (above) { n = n.map(c => -c) as V; d = -d; }
    planes.push({ n, d, tri: [points[i], points[j], points[k]] });
  }
  return planes;
}

/** Geometric difference between a ring representation and the exact analytic torus. Sector 0 is
 * measured; other sectors are exact rotations of it (up to the float32 storage both share). */
export function ringRepresentationError(representation: RingRepresentation): RepresentationError {
  if (representation.kind === 'analytic-sdf') return { kind: 'analytic-sdf', boundCertified: true, sampledOutward: 0, sampledInward: 0,
    derivedOutward: 0, derivedInward: 0, band: 0, note: 'exact analytic torus: evaluator and AVBD field share one formula' };
  const { pieces } = representation, key = String(pieces);
  const cached = representationCache.get(key);
  if (cached) return cached;
  const raw = torusSectors(pieces)[0], points: V[] = [];
  for (let i = 0; i < raw.length; i += 3) points.push([raw[i], raw[i + 1], raw[i + 2]]);
  const planes = hullPlanes(points), { majorRadius: R, minorRadius: r } = INTERLOCKING, span = 2 * Math.PI / pieces;
  let sampledOutward = 0;
  const g = 8;
  for (const { tri: [a, b, c] } of planes) for (let i = 0; i <= g; i++) for (let j = 0; i + j <= g; j++) {
    const u = i / g, v = j / g, w = 1 - u - v;
    sampledOutward = Math.max(sampledOutward, torusBodyPhi([0, 1, 2].map(k => w * a[k] + u * b[k] + v * c[k]) as V));
  }
  let sampledInward = 0;
  for (let i = 0; i <= 32; i++) for (let j = 0; j < 64; j++) {
    const a = i / 32 * span, b = j / 64 * 2 * Math.PI, rho = R + r * Math.cos(b);
    const p: V = [rho * Math.cos(a), rho * Math.sin(a), r * Math.sin(b)];
    let outside = -Infinity;
    for (const plane of planes) outside = Math.max(outside, dot(plane.n, p) - plane.d);
    sampledInward = Math.max(sampledInward, outside);
  }
  const tubeSag = r * (1 - Math.cos(Math.PI / 8));
  const derivedOutward = (R - r) * (1 - Math.cos(span / 2));
  const derivedInward = tubeSag + (R + r) * (1 - Math.cos(span / 4));
  const result: RepresentationError = { kind: 'rapier-compound', boundCertified: false, pieces, sampledOutward, sampledInward, derivedOutward, derivedInward,
    band: Math.max(sampledOutward, sampledInward, derivedOutward, derivedInward),
    note: `${pieces} convex sectors × 3 rings × 8 tube samples vs analytic torus; sampled/derived representation error, not exact SDF error` };
  Object.freeze(result);
  representationCache.set(key, result);
  return result;
}

// ---- pose observations --------------------------------------------------------------------------
export type PairStatus = 'separated' | 'within-limit' | 'penetrating' | 'unknown';
export type LinkStatus = 'linked' | 'unlinked' | 'unknown';
export type ThreadStatus = 'threaded' | 'not-threaded' | 'unknown';
export interface PairObservation {
  status: PairStatus;
  /** Measured: minimum sampled signed distance (negative = a sampled surface point lies inside). */
  minSampledPhi: number;
  /** Interval estimates; conservative for the analytic surface only when boundsCertified is true. */
  boundsCertified: boolean;
  depthLowerBound: number; depthUpperBound: number;
}
export interface RingObservation {
  centre: V; axis: V; quaternionNormError: number;
  /** Exact analytic lowest point of the ring and its clearance above the floor top (y = 0). */
  lowestY: number; floorClearance: number;
  floor: PairStatus | 'off-floor' | 'escaped-below';
  peg: PairObservation;
  pegThread: ThreadStatus;
}
export interface InterlockingObservation {
  valid: boolean; invalidReasons: string[];
  representation: RepresentationError;
  /** Lipschitz covering radius of the ring surface sample grid (metres). */
  coveringRadius: number; samplesPerRing: number;
  rings: RingObservation[];
  ringPair?: PairObservation;
  /** Linking of the two analytic core circles (centrelines). */
  coreLink: LinkStatus;
  /** Lower bound on the minimum distance between the two core circles (sampled + Lipschitz). */
  coreDistanceLowerBound: number;
  /** Resolved analytic centre-circle linking only. This NEVER certifies solid/compound-body topology. */
  analyticCoreLinkResolved: boolean;
  limits: string[];
}

const LIMITS = [
  'Pose-only: no velocity, energy, contact force or impulse is read or inferred',
  'Pair depth is the deepest sampled surface point of one ring inside the other body, not a minimum translation distance',
  'A single pose cannot certify continuous non-penetration or unchanged topology between observations',
  'Compound representation bands are unproven estimates: pair/floor/thread verdicts stay unknown',
  'Resolved centre-circle linking never certifies topology of the solid rings',
  'Core-circle linking is a centreline statement; with deep penetration the solid rings have no meaningful topology',
  'Support-height and floor-clearance guards are necessary conditions; they never certify contact support or physical correctness',
];

function coveringRadius(samples: { major: number; minor: number }) {
  const { majorRadius: R, minorRadius: r } = INTERLOCKING;
  // Half-diagonal of a parameter cell, using arc lengths (≥ chord) at the outer equator.
  return .5 * Math.hypot((R + r) * 2 * Math.PI / samples.major, r * 2 * Math.PI / samples.minor);
}

function ringSurface(ring: { c: V; q: Q }, samples: { major: number; minor: number }) {
  const { majorRadius: R, minorRadius: r } = INTERLOCKING, out: V[] = [];
  for (let i = 0; i < samples.major; i++) for (let j = 0; j < samples.minor; j++) {
    const a = i * 2 * Math.PI / samples.major, b = j * 2 * Math.PI / samples.minor, rho = R + r * Math.cos(b);
    const local: V = [rho * Math.cos(a), rho * Math.sin(a), r * Math.sin(b)], w = rotate(ring.q, local);
    out.push([w[0] + ring.c[0], w[1] + ring.c[1], w[2] + ring.c[2]]);
  }
  return out;
}

function pairStatus(minSampledPhi: number, cover: number, band: number, limit: number, boundsCertified = true): PairObservation {
  // phi is 1-Lipschitz: true min over the surface ∈ [min - cover, min]; representation adds ±band.
  const depthLowerBound = Math.max(0, -minSampledPhi - band), depthUpperBound = Math.max(0, -minSampledPhi + cover + band);
  let status: PairStatus = 'unknown';
  if (minSampledPhi - cover - band > 0) status = 'separated';
  else if (depthLowerBound > limit) status = 'penetrating';
  else if (depthUpperBound <= limit) status = 'within-limit';
  return { status: boundsCertified ? status : 'unknown', minSampledPhi, depthLowerBound, depthUpperBound, boundsCertified };
}

/** Core-circle linking of two congruent circles (radius R) by the plane-crossing test. `margin`
 * widens the near-rim ambiguity band; tangent/coplanar/near-rim cases are unknown. */
export function coreCircleLink(a: { c: V; n: V }, b: { c: V; u: V; v: V }, R: number, margin: number): LinkStatus {
  const k = dot(a.n, sub(b.c, a.c)), cu = dot(a.n, b.u), cv = dot(a.n, b.v), m = Math.hypot(cu, cv);
  if (m < 1e-9) return Math.abs(k) < 1e-9 ? 'unknown' : 'unlinked';
  const ratio = -k / (R * m);
  if (Math.abs(ratio) > 1 + 1e-9) return 'unlinked';
  if (Math.abs(Math.abs(ratio) - 1) <= 1e-9) return 'unknown';
  const phase = Math.atan2(cv, cu), spread = Math.acos(ratio);
  const inside = [phase + spread, phase - spread].map(t => {
    const p: V = [0, 1, 2].map(i => b.c[i] + R * (Math.cos(t) * b.u[i] + Math.sin(t) * b.v[i])) as V;
    return norm(sub(p, a.c));
  });
  if (inside.some(d => Math.abs(d - R) <= margin)) return 'unknown';
  return inside.filter(d => d < R).length === 1 ? 'linked' : 'unlinked';
}

/** Observe one simultaneous pose snapshot of [upper, lower] rings. Never throws on bad pose data. */
export function observeInterlocking(poses: readonly StudyPose[], representation: RingRepresentation = { kind: 'analytic-sdf' },
  criteria: InterlockingCriteria = INTERLOCKING_QUALITY_CRITERIA): InterlockingObservation {
  const representationError = ringRepresentationError(representation), band = representationError.band;
  const cover = coveringRadius(criteria.surfaceSamples), invalidReasons: string[] = [];
  const base = { representation: representationError, coveringRadius: cover,
    samplesPerRing: criteria.surfaceSamples.major * criteria.surfaceSamples.minor, limits: LIMITS };
  if (!Array.isArray(poses)) poses = [];
  if (poses.length !== 2) invalidReasons.push(`expected 2 ring poses, got ${poses.length}`);
  const parsed = poses.map((pose, i) => {
    const c: V = [pose?.position?.x, pose?.position?.y, pose?.position?.z];
    const q: Q = [pose?.rotation?.x, pose?.rotation?.y, pose?.rotation?.z, pose?.rotation?.w];
    if (![...c, ...q].every(Number.isFinite)) invalidReasons.push(`ring ${i}: non-finite pose`);
    const error = Math.abs(Math.hypot(...q) - 1);
    if (Number.isFinite(error) && error > criteria.quaternionNormTolerance) invalidReasons.push(`ring ${i}: quaternion norm error ${error}`);
    return { c, q, error };
  });
  if (invalidReasons.length) return { ...base, valid: false, invalidReasons, rings: [], coreLink: 'unknown', coreDistanceLowerBound: 0, analyticCoreLinkResolved: false };
  const { majorRadius: R, minorRadius: r, floor, peg, } = INTERLOCKING, limit = criteria.penetrationLimit;
  const bodies = parsed.map(p => ({ ...p, q: unit(p.q) }));
  const surfaces = bodies.map(b => ringSurface(b, criteria.surfaceSamples));
  const floorTop = floor.position[1] + floor.halfExtents[1];
  const rings = bodies.map((body, i): RingObservation => {
    const axis = rotate(body.q, [0, 0, 1]);
    // Exact support of a torus in direction -y: R·sqrt(1 - axis_y²) + r.
    const lowestY = body.c[1] - (R * Math.sqrt(Math.max(0, 1 - axis[1] ** 2)) + r), floorClearance = lowestY - floorTop;
    const reach = R + r, [fx, , fz] = floor.halfExtents, [ox, , oz] = floor.position;
    let floorStatus: RingObservation['floor'];
    if (body.c[1] + reach < floor.position[1] - floor.halfExtents[1]) floorStatus = 'escaped-below';
    else if (Math.abs(body.c[0] - ox) > fx + reach || Math.abs(body.c[2] - oz) > fz + reach) floorStatus = 'off-floor';
    else if (Math.abs(body.c[0] - ox) > fx - reach || Math.abs(body.c[2] - oz) > fz - reach) floorStatus = 'unknown'; // edge overhang: half-space model not exact
    else floorStatus = pairStatus(floorClearance, 0, band, limit).status; // exact support: no sampling term
    if (!representationError.boundCertified && !['off-floor', 'escaped-below'].includes(floorStatus)) floorStatus = 'unknown';
    let pegMin = Infinity;
    for (const p of surfaces[i]) pegMin = Math.min(pegMin, pegPhiWorld(p));
    // Peg axis (world z through the peg centre) against the ring plane.
    const pc = [...peg.position] as V, d: V = rotate(PEG_ROTATION_CONVENTION, [0, 1, 0]), denom = dot(axis, d);
    let pegThread: ThreadStatus;
    if (Math.abs(denom) < 1e-9) pegThread = Math.abs(dot(axis, sub(body.c, pc))) < 1e-9 ? 'unknown' : 'not-threaded';
    else {
      const t = dot(axis, sub(body.c, pc)) / denom, hit = norm(sub([pc[0] + t * d[0], pc[1] + t * d[1], pc[2] + t * d[2]], body.c));
      if (Math.abs(t) > peg.halfLength + band || hit > R + r + band) pegThread = 'not-threaded';
      else if (Math.abs(t) < peg.halfLength - band && hit < R - r - band) pegThread = 'threaded';
      else pegThread = 'unknown';
    }
    if (!representationError.boundCertified) pegThread = 'unknown';
    return { centre: body.c, axis, quaternionNormError: body.error, lowestY, floorClearance, floor: floorStatus,
      peg: pairStatus(pegMin, cover, band, limit, representationError.boundCertified), pegThread };
  });
  let pairMin = Infinity;
  for (const p of surfaces[0]) pairMin = Math.min(pairMin, ringPhiWorld(p, bodies[1]));
  for (const p of surfaces[1]) pairMin = Math.min(pairMin, ringPhiWorld(p, bodies[0]));
  // Two analytic bands: each ring may deviate by `band`.
  const ringPair = pairStatus(pairMin, cover, 2 * band, limit, representationError.boundCertified);
  const b = bodies[1];
  const coreLink = coreCircleLink({ c: bodies[0].c, n: rings[0].axis },
    { c: b.c, u: rotate(b.q, [1, 0, 0]), v: rotate(b.q, [0, 1, 0]) }, R, 2 * band + 1e-9);
  // Distance to a core circle is exact: torus phi + r. Sample core 0 with a Lipschitz covering bound.
  const coreSamples = 2048;
  let coreMin = Infinity;
  for (let i = 0; i < coreSamples; i++) {
    const a = i * 2 * Math.PI / coreSamples, w = rotate(bodies[0].q, [R * Math.cos(a), R * Math.sin(a), 0]);
    coreMin = Math.min(coreMin, ringPhiWorld([w[0] + bodies[0].c[0], w[1] + bodies[0].c[1], w[2] + bodies[0].c[2]], b) + r);
  }
  const coreDistanceLowerBound = Math.max(0, coreMin - R * Math.PI / coreSamples);
  return { ...base, valid: true, invalidReasons, rings, ringPair, coreLink, coreDistanceLowerBound,
    analyticCoreLinkResolved: coreLink !== 'unknown' && coreDistanceLowerBound > 0 };
}

// ---- criterion evaluation -----------------------------------------------------------------------
export type CriterionResult = 'violation' | 'no-violation-observed' | 'unknown';
export interface InterlockingVerdict {
  criteria: Record<'validPose' | 'ringPairPenetration' | 'pegPenetration' | 'floorPenetration' | 'linked' | 'upperOnPeg' | 'supportHeight' | 'lowerOffFloor', CriterionResult>;
  /** Worst criterion. 'no-violation-observed' is never a physical-quality or contact-support pass. */
  overall: CriterionResult;
  /** Qualification of the hanging behaviour stays gated: these checks are necessary, not sufficient. */
  qualification: 'gated';
}
const worst = (results: CriterionResult[]): CriterionResult =>
  results.includes('violation') ? 'violation' : results.includes('unknown') ? 'unknown' : 'no-violation-observed';
const penetration = (s: PairStatus | RingObservation['floor']): CriterionResult =>
  s === 'penetrating' || s === 'escaped-below' ? 'violation' : s === 'separated' || s === 'within-limit' ? 'no-violation-observed' : 'unknown';

/** Evaluate a hanging-phase observation (before any push) against the predeclared criteria. */
export function evaluateHanging(observation: InterlockingObservation, criteria: InterlockingCriteria = INTERLOCKING_QUALITY_CRITERIA): InterlockingVerdict {
  if (!observation.valid) {
    const u: CriterionResult = 'unknown';
    return { criteria: { validPose: 'violation', ringPairPenetration: u, pegPenetration: u, floorPenetration: u, linked: u,
      upperOnPeg: u, supportHeight: u, lowerOffFloor: u }, overall: 'violation', qualification: 'gated' };
  }
  const [upper, lower] = observation.rings, band = observation.representation.band;
  const linked: CriterionResult = !observation.analyticCoreLinkResolved ? 'unknown'
    : observation.coreLink === 'linked' ? 'no-violation-observed' : 'violation';
  const thread = upper.pegThread === 'threaded' ? (upper.peg.status === 'separated' || upper.peg.status === 'within-limit' ? 'no-violation-observed' : 'unknown')
    : upper.pegThread === 'not-threaded' ? 'violation' : 'unknown';
  const heights = [upper.centre[1] - criteria.supportHeight.upperMinY, lower.centre[1] - criteria.supportHeight.lowerMinY];
  const supportHeight: CriterionResult = heights.some(h => h < -band) ? 'violation' : heights.every(h => h > band) ? 'no-violation-observed' : 'unknown';
  const lowerOffFloor: CriterionResult = lower.floorClearance > band ? 'no-violation-observed' : lower.floorClearance < -band ? 'violation' : 'unknown';
  const result = {
    validPose: 'no-violation-observed' as CriterionResult,
    ringPairPenetration: penetration(observation.ringPair!.status),
    pegPenetration: worst([penetration(upper.peg.status), penetration(lower.peg.status)]),
    floorPenetration: worst([penetration(upper.floor), penetration(lower.floor)]),
    linked, upperOnPeg: thread as CriterionResult, supportHeight, lowerOffFloor,
  };
  return { criteria: result, overall: worst(Object.values(result)), qualification: 'gated' };
}

/** Sequence summary: worst per criterion and any definite linking change between observations. */
export function summarizeTrial(observations: readonly InterlockingObservation[], phase: 'hanging' | 'after-push',
  criteria: InterlockingCriteria = INTERLOCKING_QUALITY_CRITERIA) {
  const verdicts = observations.map(o => evaluateHanging(o, criteria));
  const keys = Object.keys(verdicts[0]?.criteria ?? {}) as (keyof InterlockingVerdict['criteria'])[];
  // After a push the rings may leave the peg or touch the floor; those are observations, not violations.
  const scored = phase === 'hanging' ? keys : keys.filter(k => !['upperOnPeg', 'supportHeight', 'lowerOffFloor'].includes(k));
  const perCriterion = Object.fromEntries(scored.map(k => [k, worst(verdicts.map(v => v.criteria[k]))])) as Partial<InterlockingVerdict['criteria']>;
  const resolved = observations.filter(o => o.analyticCoreLinkResolved).map(o => o.coreLink);
  const linkChanged = resolved.some(l => l !== resolved[0]);
  return { phase, observations: observations.length, perCriterion, linkChanged, resolvedCoreLinkObservations: resolved.length,
    overall: linkChanged ? 'violation' as CriterionResult : observations.length ? worst(Object.values(perCriterion) as CriterionResult[]) : 'unknown' as CriterionResult,
    qualification: 'gated' as const };
}

// ---- PROPOSED compound sandwich bound (STE-3282; review pending) --------------------------------
// Separate helpers only: observeInterlocking, evaluateHanging, summarizeTrial and ringRepresentationError
// do not call them and keep their exact behavior. See docs/PAIRED_STUDIES.md "Proposed compound
// sandwich bound" for the derivation, assumptions and the remaining gate.

export interface ProposedCompoundSandwich {
  status: 'proposed'; pieces: RingPieces;
  boundCertified: false;
  /** Derived outward enclosure; floating-point arithmetic has not been formally bounded. */
  outwardUpper: number;
  /** Attained: a hull point (midpoint of two actual inner vertices) with torusBodyPhi = outwardWitness. */
  outwardWitness: number;
  /** Exact-real inward model plus a measured perturbation. NOT containment of the literal float32 union. */
  inwardUpper: number;
  /** Numerical supporting-plane witness from sampled analytic surface points. Not a containment proof. */
  inwardWitness: number;
  /** Max |float32 stored vertex − float64 authored vertex| over all sectors; included in inwardUpper. */
  float32Perturbation: number;
  /** Maximum offset between the last end octagon and the first start octagon: a nonzero wrap crack. */
  wrapSeamOffset: number;
  slabs: number;
  assumptions: readonly string[];
}

const SANDWICH_ASSUMPTIONS = Object.freeze([
  'Rapier hull = convex hull of the supplied float32 points (checked on selected sectors), identity collider pose, zero contact skin',
  'Inward containment is exact-real only: interior octagons are shared, but the float32 wrap seam is not closed; measured vertex perturbation does not prove union containment',
  'Outward floating-point error and the per-pose arithmetic allowance are not formally derived; boundCertified remains false',
  'A sandwich bound of geometry; it says nothing about solver behavior, contact forces or continuous motion',
]);
const sandwichCache = new Map<string, ProposedCompoundSandwich>();
const coreDistance = (p: V) => Math.hypot(Math.hypot(p[0], p[1]) - INTERLOCKING.majorRadius, p[2]);

/** Conditional exact-real sandwich model in the ring body frame, where T(c) = {torusBodyPhi ≤ c}.
 * The float32 wrap crack prevents literal inward containment; outputs are explicitly uncertified.
 * Outward: each sector hull is clipped into `slabs` angular wedges
 * Q; on Q, dist(p, core) ≤ dist(p, S_Q) + sag(S_Q) with S_Q the convex hull of the nearest core points of a
 * superset of Q's vertices (all sector points in the wedge plus all point-pair segment/wedge-plane crossings),
 * so max over Q ≤ max candidate core distance + R(1 − cos(half angular spread)). Inward: interpolating the
 * end and middle octagons gives, at every angle, the octagon scaled radially by λ ≥ cos(Δ/4); its inscribed
 * ellipse contains the disc of radius r − ε_in about the core with ε_in = (R + r)(1 − λ) + λ r (1 − cos π/8). */
export function proposedCompoundSandwich(pieces: RingPieces, slabs = 64): ProposedCompoundSandwich {
  if (!Number.isInteger(slabs) || slabs < 1 || slabs > 1024) throw new Error('slabs must be an integer in [1, 1024]');
  const key = `${pieces}:${slabs}`, cached = sandwichCache.get(key);
  if (cached) return cached;
  const { majorRadius: R, minorRadius: r } = INTERLOCKING, span = 2 * Math.PI / pieces;
  const sectors = torusSectors(pieces).map(raw => { const pts: V[] = []; for (let i = 0; i < raw.length; i += 3) pts.push([raw[i], raw[i + 1], raw[i + 2]]); return pts; });
  let float32Perturbation = 0, outwardWitness = -Infinity, outwardUpper = -Infinity;
  sectors.forEach((pts, k) => {
    pts.forEach((p, idx) => {
      const a = (k + Math.floor(idx / 8) / 2) * Math.PI * 2 / pieces, b = (idx % 8) * Math.PI / 4, rho = R + r * Math.cos(b);
      float32Perturbation = Math.max(float32Perturbation, norm(sub(p, [rho * Math.cos(a), rho * Math.sin(a), r * Math.sin(b)])));
    });
    // Inner-equator vertices (tube angle π) of the first and last octagon: their midpoint is a hull point.
    const [p, q] = [pts[4], pts[20]];
    outwardWitness = Math.max(outwardWitness, torusBodyPhi([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2]));
    for (let s = 0; s < slabs; s++) {
      const t0 = (k + s / slabs) * span, t1 = (k + (s + 1) / slabs) * span, mid = (t0 + t1) / 2, tol = 1e-12;
      const n0: V = [-Math.sin(t0), Math.cos(t0), 0], n1: V = [-Math.sin(t1), Math.cos(t1), 0];
      // End wedges extend past the nominal sector: float32 vertices can lie just outside it.
      const cand: V[] = pts.filter(p => (s === 0 || dot(n0, p) >= -tol) && (s === slabs - 1 || dot(n1, p) <= tol));
      for (const [n, other, sign] of [[n0, n1, -1], [n1, n0, 1]] as const) for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const sp = dot(n, pts[i]), sq = dot(n, pts[j]);
        if (sp === sq || sp * sq > 0) continue;
        const t = sp / (sp - sq), x: V = [0, 1, 2].map(c => pts[i][c] + t * (pts[j][c] - pts[i][c])) as V;
        if ((n === n0 && s === slabs - 1) || (n === n1 && s === 0) || sign * dot(other, x) >= -tol) cand.push(x);
      }
      if (!cand.length) continue;
      let half = 0, far = 0;
      for (const x of cand) {
        half = Math.max(half, Math.abs(Math.atan2(Math.cos(mid) * x[1] - Math.sin(mid) * x[0], Math.cos(mid) * x[0] + Math.sin(mid) * x[1])));
        far = Math.max(far, coreDistance(x));
      }
      outwardUpper = Math.max(outwardUpper, far - r + R * (1 - Math.cos(Math.min(half, Math.PI / 2))) + 1e-12);
    }
  });
  const lambda = Math.cos(span / 4);
  const inwardUpper = (R + r) * (1 - lambda) + lambda * r * (1 - Math.cos(Math.PI / 8)) + float32Perturbation + 1e-12;
  // Inward witness: surface points of sector 0's wedge; distance to every hull via exact supporting planes or bounding balls.
  const planeCache = new Map<number, { n: V; d: number }[]>();
  const planesOf = (k: number) => {
    let planes = planeCache.get(k);
    if (!planes) {
      planes = hullPlanes(sectors[k]).map(({ n }) => ({ n, d: Math.max(...sectors[k].map(p => dot(n, p))) }));
      planeCache.set(k, planes);
    }
    return planes;
  };
  const balls = sectors.map(pts => { const c = pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length] as V, [0, 0, 0] as V);
    return { c, radius: Math.max(...pts.map(p => norm(sub(p, c)))) }; });
  let inwardWitness = 0;
  for (let i = 0; i <= 16; i++) for (let j = 0; j < 64; j++) {
    const a = i / 16 * span, b = j * Math.PI / 32, rho = R + r * Math.cos(b);
    const y: V = [rho * Math.cos(a), rho * Math.sin(a), r * Math.sin(b)];
    let lower = Infinity;
    for (let k = 0; k < pieces; k++) {
      const ball = norm(sub(y, balls[k].c)) - balls[k].radius;
      if (ball >= lower) continue;
      let plane = -Infinity;
      for (const { n, d } of planesOf(k)) plane = Math.max(plane, dot(n, y) - d);
      lower = Math.min(lower, Math.max(ball, plane));
    }
    inwardWitness = Math.max(inwardWitness, lower);
  }
  let wrapSeamOffset = 0;
  for (let j = 0; j < 8; j++) wrapSeamOffset = Math.max(wrapSeamOffset, norm(sub(sectors[pieces - 1][16 + j], sectors[0][j])));
  const result: ProposedCompoundSandwich = { status: 'proposed', boundCertified: false, pieces, outwardUpper, outwardWitness, inwardUpper, inwardWitness,
    float32Perturbation, wrapSeamOffset, slabs, assumptions: SANDWICH_ASSUMPTIONS };
  Object.freeze(result);
  sandwichCache.set(key, result);
  return result;
}

/** Lipschitz bounds in real arithmetic, with a small numerical guard. The target is 1e-7 m when
 * converged; a bounded-budget result can be wider. This is not an interval-arithmetic certificate. */
function circleMinimum(f: (t: number) => number, radius: number, initial = 2048, tolerance = 1e-7, maxEvaluations = 200_000) {
  const arithmeticGuard = 1e-12;
  type Cell = { t0: number; t1: number; f0: number; f1: number; lower: number };
  const cell = (t0: number, t1: number, f0: number, f1: number): Cell => ({ t0, t1, f0, f1, lower: (f0 + f1 - radius * (t1 - t0)) / 2 - arithmeticGuard });
  const values = Array.from({ length: initial + 1 }, (_, i) => i === initial ? NaN : f(i * 2 * Math.PI / initial));
  values[initial] = values[0];
  let cells = values.slice(0, initial).map((v, i) => cell(i * 2 * Math.PI / initial, (i + 1) * 2 * Math.PI / initial, v, values[i + 1]));
  let upper = Infinity, evaluations = initial;
  for (let i = 0; i < initial; i++) upper = Math.min(upper, values[i] + arithmeticGuard);
  for (;;) {
    if (upper <= tolerance) { cells = []; break; } // distance is nonnegative
    cells = cells.filter(c => c.lower < upper - tolerance);
    if (!cells.length || evaluations >= maxEvaluations) break;
    const next: Cell[] = [];
    for (const c of cells) {
      if (evaluations >= maxEvaluations) { next.push(c); continue; }
      const tm = (c.t0 + c.t1) / 2, fm = f(tm);
      evaluations++;
      upper = Math.min(upper, fm + arithmeticGuard);
      next.push(cell(c.t0, tm, c.f0, fm), cell(tm, c.t1, fm, c.f1));
    }
    cells = next;
  }
  // Pruned cells still contribute the target-width lower bound. Never spread an unbounded array.
  let lower = upper - tolerance - arithmeticGuard;
  for (const c of cells) lower = Math.min(lower, c.lower);
  lower = Math.max(0, lower);
  return { lower, upper, evaluations, converged: upper - lower <= tolerance + 2 * arithmeticGuard };
}

export interface ProposedRingPairDepth {
  status: 'proposed'; valid: boolean; invalidReasons: string[];
  representation: RingRepresentation | null;
  boundCertified: false; qualification: 'gated';
  penetrationLimit: number | null;
  /** Numerical interval for ideal analytic core circles; wider than the target when budget-exhausted. */
  coreDistance: { lower: number; upper: number; evaluations: number; converged: boolean };
  /** Conditional deepest-point model (negative = −separation). The compound lower value is NOT
   * a bound for the literal float32 union, which has a wrap crack. Never a minimum translation distance. */
  depth: { lower: number; upper: number };
  /** Analytic classification only; compounds remain unknown because their containment is uncertified. */
  result: PairStatus;
  /** What the conditional model would classify if its containment/arithmetic assumptions held. */
  conditionalResult: PairStatus;
  limits: readonly string[];
}
const PROPOSED_LIMITS = Object.freeze([
  'Proposed and uncertified: production observer verdicts and qualification:gated are unchanged',
  'Deepest-point depth of one collision solid inside the other, not a minimum translation distance',
  'One pose only: no continuous non-penetration or topology claim',
  'Compound depth is conditional: inward containment fails at the literal float32 wrap crack; result remains unknown',
  'Centres must have every coordinate within ±8 m; the 1e-6 m pose allowance is assumed, not a derived engine error bound',
  'Core-distance precision targets 1e-7 m when converged, with a 1e-12 numerical guard; budget-exhausted intervals can be wider',
]);

/** Point depth of tube solids (tube radii ra, rb) whose core circles are d apart: max over both directions of
 * sup_{x∈A} −sd_B(x) = rb − max(0, d − ra). Monotone: smaller d or larger radii never decrease it. */
const tubeDepth = (ra: number, rb: number, d: number) => Math.max(rb - Math.max(0, d - ra), ra - Math.max(0, d - rb));

/** PROPOSED ring/ring contact-quality interval on each engine's own representation. Never throws on bad pose data. */
export function proposedRingPairDepth(poses: readonly StudyPose[], representation: RingRepresentation = { kind: 'analytic-sdf' },
  criteria: InterlockingCriteria = INTERLOCKING_QUALITY_CRITERIA): ProposedRingPairDepth {
  const invalidReasons: string[] = [], { majorRadius: R, minorRadius: r } = INTERLOCKING;
  const rep = representation as RingRepresentation | null | undefined;
  const supported = rep?.kind === 'analytic-sdf' || (rep?.kind === 'rapier-compound' && [16, 32, 64].includes(rep.pieces));
  if (!supported) invalidReasons.push('unsupported ring representation');
  const limit = criteria?.penetrationLimit, quatTolerance = criteria?.quaternionNormTolerance;
  if (!Number.isFinite(limit) || limit < 0) invalidReasons.push('penetration limit must be finite and nonnegative');
  if (!Number.isFinite(quatTolerance) || quatTolerance < 0 || quatTolerance > INTERLOCKING_QUALITY_CRITERIA.quaternionNormTolerance) invalidReasons.push('unsupported quaternion tolerance');
  const list = Array.isArray(poses) ? poses : [];
  if (list.length !== 2) invalidReasons.push(`expected 2 ring poses, got ${list.length}`);
  const parsed = list.map((pose, i) => {
    const c: V = [pose?.position?.x, pose?.position?.y, pose?.position?.z];
    const q: Q = [pose?.rotation?.x, pose?.rotation?.y, pose?.rotation?.z, pose?.rotation?.w];
    const error = Math.abs(Math.hypot(...q) - 1);
    if (![...c, ...q].every(Number.isFinite)) invalidReasons.push(`ring ${i}: non-finite pose`);
    else if (c.some(v => Math.abs(v) > 8)) invalidReasons.push(`ring ${i}: centre outside the ±8 m proposal domain`);
    else if (error > quatTolerance) invalidReasons.push(`ring ${i}: quaternion norm error ${error}`);
    return { c, q, error };
  });
  const base = { status: 'proposed' as const, representation: supported ? { ...rep! } as RingRepresentation : null,
    boundCertified: false as const, qualification: 'gated' as const, penetrationLimit: Number.isFinite(limit) ? limit : null, limits: PROPOSED_LIMITS };
  if (invalidReasons.length) return { ...base, valid: false, invalidReasons, coreDistance: { lower: NaN, upper: NaN, evaluations: 0, converged: false },
    depth: { lower: NaN, upper: NaN }, result: 'unknown', conditionalResult: 'unknown' };
  const [a, b] = parsed.map(p => ({ c: p.c, q: unit(p.q), error: p.error }));
  const relative = sub(a.c, b.c); // subtract centres before adding the small rotated local point
  const core = circleMinimum(t => {
    const w = rotate(a.q, [R * Math.cos(t), R * Math.sin(t), 0]);
    return coreDistance(rotate(conj(b.q), [w[0] + relative[0], w[1] + relative[1], w[2] + relative[2]]));
  }, R);
  let out = [0, 0], inn = [0, 0];
  if (representation.kind === 'rapier-compound') {
    const s = proposedCompoundSandwich(representation.pieces);
    // Quaternion model plus an ASSUMED 1e-6 m allowance inside the restricted domain, not engine certification.
    const slack = [a, b].map(p => (2 * p.error + p.error ** 2) * 2 * (R + r) + 1e-6);
    out = slack.map(x => s.outwardUpper + x); inn = slack.map(x => s.inwardUpper + x);
  }
  const depth = { lower: tubeDepth(r - inn[0], r - inn[1], core.upper), upper: tubeDepth(r + out[0], r + out[1], core.lower) };
  const conditionalResult: PairStatus = depth.upper < 0 ? 'separated' : depth.lower > limit ? 'penetrating' : depth.upper <= limit ? 'within-limit' : 'unknown';
  return { ...base, valid: true, invalidReasons, coreDistance: core, depth,
    result: representation.kind === 'rapier-compound' ? 'unknown' : conditionalResult, conditionalResult };
}
