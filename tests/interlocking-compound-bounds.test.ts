// Falsifiable fixtures for the PROPOSED compound sandwich bound (STE-3282). Actual authored float32 sectors,
// actual Rapier 0.21 hulls and per-sector-pair queries as an independent oracle; no stepping, GPU or browser.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { LOWER_RING_ROTATION } from '../src/comparison/interlocking-avbd.ts';
import {
  INTERLOCKING_QUALITY_CRITERIA, observeInterlocking, proposedCompoundSandwich, proposedRingPairDepth, ringRepresentationError, torusBodyPhi, type StudyPose,
} from '../src/comparison/interlocking-quality.ts';
import { INTERLOCKING, torusSectors, type RingPieces } from '../src/comparison/interlocking-scene.ts';

type V = [number, number, number];
type Q = [number, number, number, number];
const { majorRadius: R, minorRadius: r } = INTERLOCKING;
const sizes = [16, 32, 64] as const;
const points = (raw: Float32Array): V[] => Array.from({ length: raw.length / 3 }, (_, i) => [raw[3 * i], raw[3 * i + 1], raw[3 * i + 2]]);
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Exact supporting planes (offset = max over points) of every candidate facet. */
function planes(pts: V[]) {
  const out: { n: V; d: number }[] = [];
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++) {
    const c = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i])), l = Math.hypot(...c);
    if (l < 1e-9) continue;
    const n = c.map(x => x / l) as V, s = pts.map(p => dot(n, p) - dot(n, pts[i]));
    if (s.every(x => x <= 1e-6)) out.push({ n, d: Math.max(...pts.map(p => dot(n, p))) });
    else if (s.every(x => x >= -1e-6)) out.push({ n: n.map(x => -x) as V, d: Math.max(...pts.map(p => -dot(n, p))) });
  }
  return out;
}
const quat = (axis: V, angle: number): Q => [axis[0] * Math.sin(angle / 2), axis[1] * Math.sin(angle / 2), axis[2] * Math.sin(angle / 2), Math.cos(angle / 2)];
const mul = (a: Q, b: Q): Q => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const pose = (p: V, q: Q): StudyPose => ({ position: { x: p[0], y: p[1], z: p[2] }, rotation: { x: q[0], y: q[1], z: q[2], w: q[3] } });
/** Authored linked pair with core distance d (closest core points: upper bottom, lower top; both inner equators face),
 * each ring spun about its own axis (core circles unchanged as sets, facing sector geometry changes). */
const linked = (d: number, spinUpper = 0, spinLower = 0): StudyPose[] => [
  pose([0, 3, 0], quat([0, 0, 1], spinUpper)), pose([0, 1.2 + d, 0], mul(LOWER_RING_ROTATION as unknown as Q, quat([0, 0, 1], spinLower)))];

/** Minimum signed distance over all actual Rapier sector pairs (exact compound distance when separated). */
async function rapierCompound(poses: StudyPose[], pieces: RingPieces, prediction = .2) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    const rings = poses.map(p => {
      const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(p.position.x, p.position.y, p.position.z).setRotation(p.rotation));
      return torusSectors(pieces).map(s => world.createCollider(RAPIER.ColliderDesc.convexHull(s)!, body));
    });
    let min = Infinity, penetrating = 0;
    for (const a of rings[0]) for (const b of rings[1]) {
      const c = a.contactCollider(b, prediction);
      if (!c) continue;
      min = Math.min(min, c.distance);
      if (c.distance < 0) penetrating++;
    }
    return { min, penetrating };
  } finally { world.free(); }
}

test('Rapier hull is the convex hull of the authored float32 points; interior adjacent sectors share exact end octagons', async () => {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  try {
    for (const pieces of sizes) {
      const sectors = torusSectors(pieces);
      for (let k = 0; k < pieces; k++) {
        const next = sectors[(k + 1) % pieces];
        if (k + 1 < pieces) assert.deepEqual(Array.from(sectors[k].slice(48)), Array.from(next.slice(0, 24)), 'bitwise shared octagon');
      }
      for (const k of [0, pieces / 2 - 1, pieces - 1]) {
        const input = points(sectors[k]), collider = world.createCollider(RAPIER.ColliderDesc.convexHull(sectors[k])!);
        assert.equal(collider.contactSkin(), 0);
        assert.deepEqual([{ ...collider.translation() }, { ...collider.rotation() }], [{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }]);
        const kept = points(collider.vertices());
        const index = kept.map(v => input.findIndex(p => p[0] === v[0] && p[1] === v[1] && p[2] === v[2]));
        assert.ok(index.every(i => i >= 0), 'every retained vertex is a bitwise input point');
        const hull = planes(kept);
        for (const [i, p] of input.entries()) if (!index.includes(i)) {
          assert.ok(hull.every(({ n, d }) => dot(n, p) - d < -1e-4), `dropped point ${i} is strictly interior`);
        }
        // Only the middle-octagon inner points (tube angles 3π/4, π, 5π/4) are interior.
        assert.deepEqual(input.map((_, i) => i).filter(i => !index.includes(i)), [11, 12, 13]);
      }
    }
  } finally { world.free(); }
});

test('conditional model envelopes bracket sampled witnesses without certifying the literal float32 union', () => {
  for (const pieces of sizes) {
    const s = proposedCompoundSandwich(pieces), band = ringRepresentationError({ kind: 'rapier-compound', pieces }).band;
    const half = Math.PI / pieces;
    assert.equal(s.status, 'proposed');
    assert.equal(Object.isFrozen(s), true);
    assert.ok(s.outwardWitness <= s.outwardUpper && s.outwardUpper - s.outwardWitness < 1e-5, `outward tight (${pieces})`);
    assert.ok(Math.abs(s.outwardWitness - (R - r) * (1 - Math.cos(half))) < 1e-6, 'inner chord sag is attained');
    assert.ok(s.outwardUpper <= R * (1 - Math.cos(half)), 'refinement never exceeds the one-triangle bound');
    assert.ok(s.inwardWitness <= s.inwardUpper, `inward bracket (${pieces})`);
    assert.ok(s.inwardWitness > r * (1 - Math.cos(Math.PI / 8)), '8-sample tube sag alone underestimates the inward error');
    assert.ok(s.float32Perturbation < 1e-7);
    // Existing bands cover these numerical model envelopes; the wrap fixture refutes literal inward containment.
    assert.ok(band >= s.outwardUpper && band >= s.inwardUpper + 1e-6, `${pieces}: band ${band}`);
    // ...but no band below the witnesses can be valid, and the inward side never drops below about 12 mm.
    assert.ok(s.inwardWitness > .0124 && Math.max(s.outwardWitness, s.inwardWitness) > .0124);
  }
});

test('empirical samples fit conditional envelopes; the deterministic wrap-crack fixture remains separate', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (const pieces of sizes) {
    const s = proposedCompoundSandwich(pieces), sectors = torusSectors(pieces).map(points), span = 2 * Math.PI / pieces;
    const hulls = new Map<number, { n: V; d: number }[]>(), hullOf = (k: number) => hulls.get(k) ?? hulls.set(k, planes(sectors[k])).get(k)!;
    for (let i = 0; i < 3000; i++) {
      const pts = sectors[Math.floor(rand() * pieces)], picks = Array.from({ length: 1 + Math.floor(rand() * 4) }, () => pts[Math.floor(rand() * 24)]);
      const w = picks.map(() => rand() ** 4), total = w.reduce((a, b) => a + b, 0);
      const p = [0, 1, 2].map(c => picks.reduce((acc, q, j) => acc + w[j] / total * q[c], 0)) as V;
      assert.ok(torusBodyPhi(p) <= s.outwardUpper, `hull point beyond outward bound (${pieces})`);
    }
    for (let i = 0; i < 1500; i++) {
      const a = rand() * 2 * Math.PI, b = rand() * 2 * Math.PI, t = (r - s.inwardUpper) * Math.sqrt(rand()), rho = R + t * Math.cos(b);
      const p: V = [rho * Math.cos(a), rho * Math.sin(a), t * Math.sin(b)], k = Math.floor(a / span);
      const inside = [k - 1, k, k + 1].map(j => (j + pieces) % pieces).some(j => hullOf(j).every(({ n, d }) => dot(n, p) - d <= 1e-9));
      assert.ok(inside, `eroded torus point outside every sector (${pieces})`);
    }
  }
});

test('actual Rapier compound distance stays inside the proposed interval; sector placement realizes the outward bound', async () => {
  for (const pieces of sizes) {
    const span = 2 * Math.PI / pieces, s = proposedCompoundSandwich(pieces);
    for (const gap of [.08, .03]) for (const [su, sl] of [[0, 0], [span / 2, 0], [0, span / 2], [span / 2, span / 2], [span / 4, .37]]) {
      const poses = linked(2 * r + gap, su, sl), o = proposedRingPairDepth(poses, { kind: 'rapier-compound', pieces });
      const actual = await rapierCompound(poses, pieces);
      assert.ok(o.coreDistance.lower <= 2 * r + gap && o.coreDistance.upper >= 2 * r + gap, 'interval contains the known core distance');
      assert.ok(actual.penetrating === 0 && -o.depth.upper <= actual.min + 1e-6 && actual.min <= -o.depth.lower + 1e-6,
        `${pieces}/${gap}/${su},${sl}: Rapier ${actual.min} vs [${-o.depth.upper}, ${-o.depth.lower}]`);
      if (gap === .08) assert.equal(o.conditionalResult, 'separated', 'authored clearance is a definite compound separation at all sizes');
      if (su === span / 2 && sl === span / 2) {
        // Both inner-chord protrusions face each other: the actual distance approaches the conditional lower end.
        assert.ok(actual.min < gap - 2 * s.outwardWitness + 1e-4, `${pieces}: ${actual.min}`);
      }
    }
  }
});

test('conditional penetrating, coincident, near-tangent and within-limit model fixtures', async () => {
  const limit = .1 * r;
  // Coincident centres (cores cross): definite gross penetration everywhere; Rapier sees overlapping sector pairs.
  for (const pieces of sizes) {
    const crossed = [pose([0, 3, 0], [0, 0, 0, 1]), pose([0, 3, 0], LOWER_RING_ROTATION as unknown as Q)];
    assert.equal(proposedRingPairDepth(crossed, { kind: 'rapier-compound', pieces }).conditionalResult, 'penetrating');
    assert.ok((await rapierCompound(crossed, pieces)).penetrating > 0);
    const deep = linked(2 * r - .06);
    assert.equal(proposedRingPairDepth(deep, { kind: 'rapier-compound', pieces }).conditionalResult, 'penetrating', `60 mm analytic overlap (${pieces})`);
    assert.ok((await rapierCompound(deep, pieces)).penetrating > 0);
  }
  // 6 mm analytic overlap: within limit for analytic, 32 and 64; unknown for 16 (2·outward 28 mm).
  const shallow = linked(2 * r - .006);
  assert.deepEqual(['analytic-sdf', 16, 32, 64].map(k => proposedRingPairDepth(shallow, k === 'analytic-sdf' ? { kind: k } : { kind: 'rapier-compound', pieces: k as RingPieces }).conditionalResult),
    ['within-limit', 'unknown', 'within-limit', 'within-limit']);
  const exact = proposedRingPairDepth(shallow);
  assert.ok(Math.abs(exact.depth.lower - .006) < 1e-6 && Math.abs(exact.depth.upper - .006) < 1e-6, 'analytic tube depth uses the numerical core interval');
  // Near-tangent analytic: decided by the exact tube formula, not by the 10 mm surface-grid covering radius.
  assert.equal(proposedRingPairDepth(linked(2 * r + 1e-4)).conditionalResult, 'separated');
  assert.equal(proposedRingPairDepth(linked(2 * r - 1e-4)).conditionalResult, 'within-limit');
  assert.equal(proposedRingPairDepth(linked(2 * r - limit - 1e-4)).conditionalResult, 'penetrating');
  // Compound contact (touching to ~6 mm) is never certified at 16 pieces.
  for (const gap of [0, -.002, -.006]) assert.equal(proposedRingPairDepth(linked(2 * r + gap), { kind: 'rapier-compound', pieces: 16 }).conditionalResult, 'unknown');
});

test('rigid motions leave the interval unchanged; invalid poses are unknown; production observer is untouched', () => {
  const base = linked(.33, .2, -.1), q = quat([.48, .6, .64], 1.1), t: V = [2, -.5, 3];
  const rot = (v: V): V => { const u: V = [q[0], q[1], q[2]], c = cross(u, v).map(x => 2 * x) as V, e = cross(u, c);
    return [v[0] + q[3] * c[0] + e[0] + t[0], v[1] + q[3] * c[1] + e[1] + t[1], v[2] + q[3] * c[2] + e[2] + t[2]]; };
  const moved = base.map(p => pose(rot([p.position.x, p.position.y, p.position.z]), mul(q, [p.rotation.x, p.rotation.y, p.rotation.z, p.rotation.w])));
  for (const representation of [{ kind: 'analytic-sdf' } as const, { kind: 'rapier-compound', pieces: 32 } as const]) {
    const [a, b] = [proposedRingPairDepth(base, representation), proposedRingPairDepth(moved, representation)];
    assert.ok(a.valid && b.valid, 'both rigidly moved fixtures stay inside the declared proposal domain');
    assert.ok(Math.abs(a.depth.upper - b.depth.upper) < 1e-6 && Math.abs(a.depth.lower - b.depth.lower) < 1e-6);
    assert.equal(a.conditionalResult, b.conditionalResult);
  }
  for (const bad of [[base[0]], [base[0], pose([NaN, 0, 0], [0, 0, 0, 1])], [base[0], pose([0, 0, 0], [0, 0, 0, 1.01])], null as unknown as StudyPose[]]) {
    const o = proposedRingPairDepth(bad, { kind: 'rapier-compound', pieces: 64 });
    assert.deepEqual([o.valid, o.conditionalResult], [false, 'unknown']);
  }
  const before = sizes.map(pieces => JSON.stringify(observeInterlocking(linked(.3), { kind: 'rapier-compound', pieces })));
  sizes.forEach(pieces => { proposedCompoundSandwich(pieces); proposedRingPairDepth(linked(.3), { kind: 'rapier-compound', pieces }); });
  assert.deepEqual(sizes.map(pieces => JSON.stringify(observeInterlocking(linked(.3), { kind: 'rapier-compound', pieces }))), before);
  for (const pieces of sizes) {
    const o = observeInterlocking(linked(.3), { kind: 'rapier-compound', pieces });
    assert.deepEqual([o.representation.boundCertified, o.ringPair!.status], [false, 'unknown'], 'production compound verdict stays unknown');
  }
});

test('review regression: flat core minima stay bounded and expose convergence', () => {
  for (const z of [0, .5, .33]) {
    const o = proposedRingPairDepth([pose([0, 0, 0], [0, 0, 0, 1]), pose([0, 0, z], [0, 0, 0, 1])]);
    assert.equal(o.valid, true);
    assert.ok(o.coreDistance.lower <= z && o.coreDistance.upper >= z, `${z}: ${JSON.stringify(o.coreDistance)}`);
    assert.ok(o.coreDistance.evaluations <= 200_000);
    if (z > 0) assert.equal(o.coreDistance.converged, false, 'flat nonzero minimum reaches the bounded budget');
  }
});

test('review regression: crossing core circles retain the zero lower bound', () => {
  const q = quat([Math.cos(.3), Math.sin(.3), 0], 1);
  const o = proposedRingPairDepth([pose([0, 0, 0], [0, 0, 0, 1]), pose([0, 0, 0], q)]);
  assert.equal(o.coreDistance.lower, 0);
});

test('review regression: unsupported representations and large poses stay unknown', () => {
  const a = linked(.32);
  for (const rep of [null, {}, { kind: 'something-else' }, { kind: 'rapier-compound' }, { kind: 'rapier-compound', pieces: 8 }]) {
    const o = proposedRingPairDepth(a, rep as never);
    assert.deepEqual([o.valid, o.result], [false, 'unknown']);
  }
  for (const x of [1e11, 1e17, 1e308]) {
    const o = proposedRingPairDepth([pose([x, 0, 0], [0, 0, 0, 1]), pose([x, 0, 0], quat([1, 0, 0], 1))]);
    assert.deepEqual([o.valid, o.result], [false, 'unknown']);
  }
});

test('review regression: shared arrays are frozen and the used limit is recorded', () => {
  const o = proposedRingPairDepth(linked(.32), { kind: 'analytic-sdf' }, { ...INTERLOCKING_QUALITY_CRITERIA, penetrationLimit: 1 });
  assert.equal(o.penetrationLimit, 1);
  assert.ok(Object.isFrozen(o.limits));
  assert.ok(Object.isFrozen(proposedCompoundSandwich(32).assumptions));
});

test('review regression: wrap seam leaves a literal float32 gap, so compounds remain uncertified', () => {
  const p: V = [.9, -9.06e-17, 0];
  assert.equal(torusBodyPhi(p), -r);
  for (const pieces of sizes) {
    const sectors = torusSectors(pieces).map(points);
    assert.notDeepEqual(sectors[pieces - 1].slice(16), sectors[0].slice(0, 8));
    // A point outside every component's bounding box cannot be in any convex hull of those points.
    assert.ok(sectors.every(s => [0, 1, 2].some(c => p[c] < Math.min(...s.map(v => v[c])) || p[c] > Math.max(...s.map(v => v[c])))));
    const b = proposedCompoundSandwich(pieces);
    assert.ok(b.wrapSeamOffset > 0);
    assert.equal(b.boundCertified, false);
    const o = proposedRingPairDepth(linked(.26), { kind: 'rapier-compound', pieces });
    assert.deepEqual([o.result, o.boundCertified, o.qualification], ['unknown', false, 'gated']);
  }
});
