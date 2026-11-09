import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { avbdInterlockingPlan, FIELD_Y_TO_BODY_Z, LOWER_RING_ROTATION, PEG_ROTATION } from '../src/comparison/interlocking-avbd.ts';
import {
  coreCircleLink, cylinderLocalPhi, evaluateHanging, INTERLOCKING_QUALITY_CRITERIA as C, observeInterlocking,
  PEG_ROTATION_CONVENTION, ringRepresentationError, summarizeTrial, torusBodyPhi, type StudyPose,
} from '../src/comparison/interlocking-quality.ts';
import { INTERLOCKING, torusSectors } from '../src/comparison/interlocking-scene.ts';

type V = [number, number, number];
const { majorRadius: R, minorRadius: r } = INTERLOCKING;
const pose = (p: V, q: readonly number[] = [0, 0, 0, 1]): StudyPose =>
  ({ position: { x: p[0], y: p[1], z: p[2] }, rotation: { x: q[0], y: q[1], z: q[2], w: q[3] } });
const upper = (p: V = [0, 3, 0], q: readonly number[] = [0, 0, 0, 1]) => pose(p, q);
const lower = (p: V = [0, 1.6, 0]) => pose(p, LOWER_RING_ROTATION);
const authored = () => [upper(), lower()];
const compounds = [16, 32, 64] as const;
const sag = r * (1 - Math.cos(Math.PI / 8));

test('evaluator fields match the AVBD analytic fields through the source binding convention', () => {
  const plan = avbdInterlockingPlan(), inv = new THREE.Quaternion(...FIELD_Y_TO_BODY_Z).invert();
  for (let i = 0; i < 400; i++) {
    const p = [Math.sin(i * 1.3) * 1.4, Math.cos(i * .7) * 1.4, Math.sin(i * .37) * .5] as V;
    const field = plan.ringField.sample(new THREE.Vector3(...p).applyQuaternion(inv).toArray() as V).phi;
    // AnalyticField evaluates in float32 precision.
    assert.ok(Math.abs(torusBodyPhi(p) - field) < 1e-6, 'torus body frame (axis z) = field (axis y) via binding');
    assert.ok(Math.abs(cylinderLocalPhi(p) - plan.peg.field.sample(p).phi) < 1e-6, 'cylinder local frame');
  }
  assert.deepEqual(PEG_ROTATION_CONVENTION, PEG_ROTATION);
});

test('compound representation error is measured and disclosed, never called exact', () => {
  assert.equal(ringRepresentationError({ kind: 'analytic-sdf' }).band, 0);
  for (const pieces of compounds) {
    const e = ringRepresentationError({ kind: 'rapier-compound', pieces });
    assert.match(e.note, /not exact SDF error/);
    assert.equal(Object.isFrozen(e), true, 'cached estimates cannot be mutated into certified bounds');
    // Every hull vertex is on the analytic surface; error lives between the samples.
    const pts = torusSectors(pieces)[0];
    for (let i = 0; i < pts.length; i += 3) assert.ok(Math.abs(torusBodyPhi([pts[i], pts[i + 1], pts[i + 2]])) < 1e-6);
    assert.ok(Math.abs(e.sampledOutward - e.derivedOutward) < 1e-6, `inner chord into the opening (${pieces})`);
    assert.ok(e.sampledInward <= e.derivedInward + 1e-9 && e.sampledInward >= sag - 1e-6, `tube octagon sag (${pieces})`);
    assert.equal(e.band, Math.max(e.sampledOutward, e.sampledInward, e.derivedOutward, e.derivedInward));
  }
  // More sectors shrink the chord error but not the 8-sample tube cross-section error.
  const bands = compounds.map(pieces => ringRepresentationError({ kind: 'rapier-compound', pieces }).band);
  assert.ok(bands[0] > bands[1] && bands[1] > bands[2] && bands[2] > sag);
});

test('authored pose: analytic separation/core linking, compound uncertainty; bbox overlap is irrelevant', () => {
  // Axis-aligned bounds of the two rings overlap, yet the analytic solids are separated.
  const [a, b] = [[[-1.06, 1.94, -.16], [1.06, 4.06, .16]], [[-.16, .54, -1.06], [.16, 2.66, 1.06]]];
  assert.ok([0, 1, 2].every(k => a[0][k] < b[1][k] && b[0][k] < a[1][k]));
  for (const representation of [{ kind: 'analytic-sdf' } as const, ...compounds.map(pieces => ({ kind: 'rapier-compound', pieces }) as const)]) {
    const o = observeInterlocking(authored(), representation), v = evaluateHanging(o);
    assert.equal(o.valid, true);
    assert.equal(o.ringPair!.status, representation.kind === 'analytic-sdf' ? 'separated' : 'unknown');
    assert.equal(o.ringPair!.boundsCertified, representation.kind === 'analytic-sdf');
    assert.ok(Math.abs(o.ringPair!.minSampledPhi - .08) < 1e-9, 'closest tube approach 0.4 − 2r');
    assert.ok(Math.abs(o.rings[0].peg.minSampledPhi - .09) < 1e-9, 'peg top 3.65 vs inner rim 3.74');
    assert.equal(o.coreLink, 'linked');
    assert.equal(o.analyticCoreLinkResolved, true);
    assert.equal(o.rings[0].pegThread, representation.kind === 'analytic-sdf' ? 'threaded' : 'unknown');
    assert.deepEqual(o.rings.map(ring => ring.floorClearance.toFixed(9)), ['1.940000000', '0.540000000']);
    assert.equal(v.overall, representation.kind === 'analytic-sdf' ? 'no-violation-observed' : 'unknown');
    assert.equal(v.qualification, 'gated');
  }
});

test('known ring/ring penetration: definite witness for analytic, honest unknown inside the compound band', () => {
  const at = (depth: number) => [upper(), lower([0, 1.6 - .08 - depth, 0])];
  const deep = observeInterlocking(at(.05));
  assert.ok(-deep.ringPair!.minSampledPhi <= .05 + 1e-9 && -deep.ringPair!.minSampledPhi >= .05 - deep.coveringRadius);
  assert.equal(deep.ringPair!.status, 'penetrating');
  assert.ok(deep.ringPair!.depthLowerBound <= .05 + 1e-12 && deep.ringPair!.depthUpperBound >= .05);
  assert.equal(evaluateHanging(deep).criteria.ringPairPenetration, 'violation');
  assert.equal(deep.analyticCoreLinkResolved, true, 'cores still disjoint: topology claim stays separate from depth');
  const coarse = observeInterlocking(at(.05), { kind: 'rapier-compound', pieces: 16 });
  assert.equal(coarse.ringPair!.status, 'unknown');
  assert.equal(observeInterlocking(at(.002)).ringPair!.status, 'within-limit');
  assert.equal(observeInterlocking(at(-.005)).ringPair!.status, 'within-limit', '5 mm gap: below covering radius, not certified separated');
  assert.equal(observeInterlocking(at(-.02)).ringPair!.status, 'separated');
  // Coincident centres: cores intersect, so topology is unknown and penetration is gross.
  const crossed = observeInterlocking([upper(), lower([0, 3, 0])]), cv = evaluateHanging(crossed);
  assert.equal(crossed.coreLink, 'unknown');
  assert.equal(crossed.analyticCoreLinkResolved, false);
  assert.equal(cv.criteria.linked, 'unknown');
  assert.equal(cv.criteria.ringPairPenetration, 'violation');
  assert.equal(cv.overall, 'violation');
});

test('separated but unlinked rings are a definite linkage violation', () => {
  const o = observeInterlocking([upper(), lower([3, 1.6, 0])]), v = evaluateHanging(o);
  assert.equal(o.ringPair!.status, 'separated');
  assert.equal(o.coreLink, 'unlinked');
  assert.equal(o.analyticCoreLinkResolved, true);
  assert.equal(v.criteria.linked, 'violation');
  // Plane-crossing edge cases.
  const n: V = [0, 0, 1], c: V = [0, 0, 0];
  assert.equal(coreCircleLink({ c, n }, { c: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, R, 0), 'unlinked', 'parallel planes');
  assert.equal(coreCircleLink({ c, n }, { c: [.1, 0, 0], u: [1, 0, 0], v: [0, 1, 0] }, R, 0), 'unknown', 'coplanar');
  assert.equal(coreCircleLink({ c, n }, { c: [0, 0, R], u: [0, 0, 1], v: [1, 0, 0] }, R, 0), 'unknown', 'tangent crossing');
  assert.equal(coreCircleLink({ c, n }, { c: [2 * R, 0, 0], u: [1, 0, 0], v: [0, 0, 1] }, R, .01), 'unknown', 'crossing on the rim');
});

test('floor: exact analytic support, overhang/escape statuses and the representation band', () => {
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(.7, .3, -.4)).toArray();
  const o = observeInterlocking([upper([0, 1, 0], tilt), lower()]);
  let sampled = Infinity;
  for (let i = 0; i < 720; i++) for (let j = 0; j < 90; j++) {
    const a = i * Math.PI / 360, b = j * Math.PI / 45, rho = R + r * Math.cos(b);
    sampled = Math.min(sampled, new THREE.Vector3(rho * Math.cos(a), rho * Math.sin(a), r * Math.sin(b))
      .applyQuaternion(new THREE.Quaternion(...tilt)).y + 1);
  }
  assert.ok(o.rings[0].lowestY <= sampled + 1e-12 && sampled - o.rings[0].lowestY < 1e-4, 'support formula vs dense samples');
  const sunk = observeInterlocking([upper([0, R + r - .03, 0], LOWER_RING_ROTATION), lower()]);
  assert.ok(Math.abs(sunk.rings[0].floorClearance + .03) < 1e-12);
  assert.equal(sunk.rings[0].floor, 'penetrating');
  assert.equal(evaluateHanging(sunk).criteria.floorPenetration, 'violation');
  assert.equal(observeInterlocking([upper([0, R + r - .01, 0], LOWER_RING_ROTATION), lower()]).rings[0].floor, 'within-limit');
  assert.equal(observeInterlocking([upper([0, R + r - .01, 0], LOWER_RING_ROTATION), lower()], { kind: 'rapier-compound', pieces: 16 })
    .rings[0].floor, 'unknown', 'band 0.017 + 0.01 > limit is not a pass');
  assert.equal(observeInterlocking([upper([0, -3, 0]), lower()]).rings[0].floor, 'escaped-below');
  assert.equal(observeInterlocking([upper([9, 1, 0]), lower()]).rings[0].floor, 'off-floor');
  assert.equal(observeInterlocking([upper([3.5, 1, 0]), lower()]).rings[0].floor, 'unknown', 'edge overhang');
});

test('peg threading, peg penetration and the existing support-height guards', () => {
  const sideways = evaluateHanging(observeInterlocking([upper([.5, 3, 0], LOWER_RING_ROTATION), lower()]));
  assert.equal(sideways.criteria.upperOnPeg, 'violation', 'peg axis parallel to, and off, the ring plane');
  const inPlane = observeInterlocking([upper([0, 3, 0], LOWER_RING_ROTATION), lower()]);
  assert.equal(inPlane.rings[0].pegThread, 'unknown', 'peg axis inside the ring plane is degenerate');
  assert.equal(inPlane.rings[0].peg.status, 'penetrating');
  const offEnd = observeInterlocking([upper([0, 3, 2]), lower([0, 1.6, 2])]);
  assert.equal(offEnd.rings[0].pegThread, 'not-threaded');
  // Ring centred on the peg axis: peg passes through the tube near its top.
  const impaled = observeInterlocking([upper([0, 3.5 - R, 0]), lower([0, 2.1 - R, 0])]);
  assert.equal(impaled.rings[0].peg.status, 'penetrating');
  assert.equal(evaluateHanging(impaled).criteria.pegPenetration, 'violation');
  const low = evaluateHanging(observeInterlocking([upper([0, 2.45, 0]), lower([0, 1.05, 0])]));
  assert.equal(low.criteria.supportHeight, 'violation');
  assert.equal(C.supportHeight.upperMinY, 2.5);
});

test('non-finite, non-unit and miscounted poses are invalid observations, not passes', () => {
  for (const bad of [
    [upper([NaN, 3, 0]), lower()], [upper(), lower([0, Infinity, 0])],
    [upper([0, 3, 0], [0, 0, 0, 1.01]), lower()], [upper([0, 3, 0], [0, 0, 0, NaN]), lower()], [upper()], [null, lower()] as unknown as StudyPose[], [{}, lower()] as unknown as StudyPose[],
    null as unknown as StudyPose[],
  ]) {
    const o = observeInterlocking(bad), v = evaluateHanging(o);
    assert.equal(o.valid, false);
    assert.ok(o.invalidReasons.length > 0);
    assert.equal(v.criteria.validPose, 'violation');
    assert.equal(v.overall, 'violation');
    assert.ok(Object.entries(v.criteria).every(([k, s]) => k === 'validPose' || s === 'unknown'));
  }
  assert.equal(observeInterlocking([upper([0, 3, 0], [0, 0, 0, 1 + 5e-5]), lower()]).valid, true, 'within tolerance');
});

test('trial summary: definite linking change is a violation; push phase drops hanging-only guards', () => {
  const linked = observeInterlocking(authored()), unlinked = observeInterlocking([upper(), lower([3, 1.6, 0])]);
  const s = summarizeTrial([linked, linked, unlinked], 'after-push');
  assert.equal(s.linkChanged, true);
  assert.equal(s.overall, 'violation');
  assert.equal(s.perCriterion.upperOnPeg, undefined);
  const offPeg = observeInterlocking([upper([.5, 3, 0], LOWER_RING_ROTATION), lower([0, 1.6, 2])]);
  assert.equal(summarizeTrial([offPeg], 'hanging').perCriterion.upperOnPeg, 'violation');
  const h = summarizeTrial([linked, linked], 'hanging');
  assert.equal(h.overall, 'no-violation-observed');
  assert.equal(h.qualification, 'gated');
  assert.equal(summarizeTrial([], 'hanging').overall, 'unknown', 'no observations is not a pass');
  assert.deepEqual(JSON.parse(JSON.stringify(linked)).coreLink, 'linked', 'observation is JSON-serialisable for reports');
});


test('unproven compound bands never certify even very clear proxy separation or deep penetration', () => {
  for (const pieces of compounds) {
    for (const poses of [[upper(), lower([6, 1.6, 0])], [upper(), lower([0, 3, 0])]]) {
      const o = observeInterlocking(poses, { kind: 'rapier-compound', pieces });
      assert.equal(o.representation.boundCertified, false);
      assert.equal(o.ringPair!.boundsCertified, false);
      assert.equal(o.ringPair!.status, 'unknown');
      assert.equal(evaluateHanging(o).criteria.ringPairPenetration, 'unknown');
      assert.equal(evaluateHanging(o).qualification, 'gated');
    }
  }
});
