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
