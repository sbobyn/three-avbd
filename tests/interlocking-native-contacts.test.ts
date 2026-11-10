import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  NATIVE_CONTACT_MAX_QUERIES_PER_SNAPSHOT, NATIVE_CONTACT_PREDICTION, observeNativeContacts, observeNativePair, type NativeBody, type NativeStudyBodies,
} from '../src/comparison/interlocking-native-contacts.ts';
import { createRapierInterlocking } from '../src/comparison/interlocking-rapier.ts';

const describe = (e: unknown) => String(e instanceof Error ? e.message : e);

/** Two unit cubes (half extent .5), centres `centreDistance` apart along x. */
async function cubes(centreDistance: number, fixed = false) {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  const make = (x: number) => {
    const body = world.createRigidBody((fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic()).setTranslation(x, 0, 0));
    world.createCollider(RAPIER.ColliderDesc.cuboid(.5, .5, .5), body);
    return body;
  };
  return { world, a: make(0), b: make(centreDistance) };
}

test('real Rapier 0.21: separated, touching and penetrating cubes; signed distance and pair-order invariance', async () => {
  const cases = [
    { at: 1.2, result: 'no-returned-contact', min: null, depth: null },
    { at: 1.0, result: 'contact-returned', min: 0, depth: null },
    { at: 0.9, result: 'contact-returned', min: -.1, depth: .1 },
  ] as const;
  for (const c of cases) {
    const { world, a, b } = await cubes(c.at);
    try {
      const ab = observeNativePair('ring-ring', a, b, [1], [1], NATIVE_CONTACT_PREDICTION, describe);
      const ba = observeNativePair('ring-ring', b, a, [1], [1], NATIVE_CONTACT_PREDICTION, describe);
      for (const o of [ab, ba]) {
        assert.equal(o.status, 'observed', `${c.at}`);
        assert.deepEqual([o.expectedQueries, o.queries, o.nonFiniteDistances], [1, 1, 0]);
        assert.equal(o.result, c.result, `${c.at}`);
        if (c.min === null) assert.equal(o.minReturnedDistance, null, 'separated beyond prediction 0: Rapier returns null');
        else assert.ok(Math.abs(o.minReturnedDistance! - c.min) < 1e-5, `${c.at}: ${o.minReturnedDistance}`);
        if (c.depth === null) { assert.equal(o.deepestPenetration, null); assert.equal(o.penetratingContacts, 0); }
        else { assert.ok(Math.abs(o.deepestPenetration! - c.depth) < 1e-5); assert.equal(o.penetratingContacts, 1); }
      }
      assert.ok(ab.minReturnedDistance === ba.minReturnedDistance || Math.abs(ab.minReturnedDistance! - ba.minReturnedDistance!) < 1e-6, 'pair order does not change the signed distance');
      // A documented positive prediction does return the separated gap, still from the actual shapes.
      if (c.at === 1.2) assert.ok(Math.abs(observeNativePair('ring-ring', a, b, [1], [1], .5, describe).minReturnedDistance! - .2) < 1e-5);
    } finally { world.free(); }
  }
});

test('same-body and fixed-fixed pairs are excluded without querying', async () => {
  const { world, a, b } = await cubes(.9, true);
  try {
    const fixed = observeNativePair('peg-floor', a, b, [1], [1], 0, describe);
    assert.deepEqual([fixed.status, fixed.exclusion, fixed.queries, fixed.result], ['excluded', 'fixed-fixed', 0, 'unknown']);
    const same = observeNativePair('ring-ring', a, a, [1], [1], 0, describe);
    assert.deepEqual([same.status, same.exclusion, same.queries, same.result], ['excluded', 'same-body', 0, 'unknown']);
  } finally { world.free(); }
});

test('actual authored study: full sector coverage, no mutation or stepping, unchanged step results', async () => {
  for (const pieces of [16, 32, 64] as const) {
    const [observed, control] = [await createRapierInterlocking(pieces), await createRapierInterlocking(pieces)];
    try {
      const study: NativeStudyBodies = { rings: [observed.bodies[0], observed.bodies[1]], peg: observed.peg, floor: observed.floor, pieces };
      const before = JSON.stringify([observed.poses(), observed.bodies.map(b => [b.linvel(), b.angvel(), b.mass()])]);
      const o = observeNativeContacts(study);
      assert.equal(JSON.stringify([observed.poses(), observed.bodies.map(b => [b.linvel(), b.angvel(), b.mass()])]), before, 'observation mutates nothing');
      assert.equal(o.prediction, 0); assert.equal(o.pieces, pieces);
      const byName = Object.fromEntries(o.pairs.map(p => [p.pair, p]));
      assert.deepEqual([byName['ring-ring'].collidersA, byName['ring-ring'].collidersB, byName['ring-ring'].queries], [pieces, pieces, pieces * pieces]);
      for (const name of ['upper-peg', 'lower-peg', 'upper-floor', 'lower-floor']) assert.deepEqual([byName[name].expectedQueries, byName[name].queries], [pieces, pieces]);
      assert.deepEqual([byName['peg-floor'].status, byName['peg-floor'].exclusion], ['excluded', 'fixed-fixed']);
      assert.equal(o.totalQueries, pieces * pieces + 4 * pieces);
      assert.ok(o.totalQueries <= NATIVE_CONTACT_MAX_QUERIES_PER_SNAPSHOT);
      // Authored pose: inscribed hulls of analytically separated solids (ring gap .08, peg .09, floor .54+).
      for (const p of o.pairs.filter(p => p.status !== 'excluded')) {
        assert.deepEqual([p.status, p.result, p.returnedContacts, p.minReturnedDistance], ['observed', 'no-returned-contact', 0, null], p.pair);
      }
      assert.match(o.note, /not a pass/);
      assert.deepEqual(JSON.parse(JSON.stringify(o)), o, 'JSON-serializable');
      for (let i = 0; i < 60; i++) { observed.step(); control.step(); if (i % 20 === 0) observeNativeContacts(study); }
      assert.deepEqual(observed.poses(), control.poses(), 'observing never alters the stepped trajectory');
      assert.deepEqual(observed.bodies.map(b => b.mass()), control.bodies.map(b => b.mass()));
    } finally { observed.dispose(); control.dispose(); }
  }
});

/** Structural fake body: `contact` decides each query result. */
const fake = (handle: number, colliders: number, contact: (i: number, j: number) => { distance: number } | null, fixed = false): NativeBody => ({
  handle, isFixed: () => fixed, numColliders: () => colliders,
  collider: (i: number) => ({ contactCollider: (other: never) => contact(i, (other as unknown as { j: number }).j) , j: i }) as never,
});

test('non-finite, throwing and out-of-bound enumeration are honest invalid/error, never a pass', () => {
  const ok = (n: number) => fake(9, n, () => null, true);
  const missing = observeNativePair('ring-ring', fake(1, 1, () => undefined as never), fake(2, 1, () => null), [1], [1], 0, describe);
  assert.deepEqual([missing.status, missing.result, missing.queries], ['error', 'unknown', 1]);
  assert.match(missing.error!, /returned undefined/);
  const nan = observeNativeContacts({ rings: [fake(1, 16, (i, j) => i === 3 && j === 0 ? { distance: NaN } : null), fake(2, 16, () => null)], peg: ok(1), floor: fake(10, 1, () => null, true), pieces: 16 });
  const rr = nan.pairs[0];
  assert.deepEqual([rr.status, rr.result, rr.nonFiniteDistances, rr.returnedContacts, rr.queries], ['invalid', 'unknown', 1, 1, 256]);

  const throwing = observeNativeContacts({ rings: [fake(1, 16, (i) => { if (i === 2) throw new Error('unsupported\nshape'); return { distance: -.01 }; }), fake(2, 16, () => null)],
    peg: ok(1), floor: fake(10, 1, () => null, true), pieces: 16 });
  const t = throwing.pairs[0];
  assert.deepEqual([t.status, t.result, t.error, t.queries], ['error', 'unknown', 'unsupported', 32], 'partial counts preserved; result unknown');
  assert.equal(t.deepestPenetration, .01, 'partial minima preserved but result stays unknown');
  assert.equal(throwing.pairs.filter(p => p.status === 'error').length, 3, 'only pairs using the throwing ring fail');

  let queried = 0, handle = 100;
  const count = (n: number) => fake(handle++, n, () => { queried++; return null; });
  for (const study of [
    { rings: [count(17), count(16)], peg: ok(1), floor: fake(10, 1, () => null, true), pieces: 16 },
    { rings: [count(8), count(8)], peg: ok(1), floor: fake(10, 1, () => null, true), pieces: 8 },
    { rings: [count(NaN), count(16)], peg: ok(1), floor: fake(10, 1, () => null, true), pieces: 16 },
  ] as NativeStudyBodies[]) {
    const o = observeNativeContacts(study);
    assert.equal(o.pairs[0].status, 'error'); assert.equal(o.pairs[0].queries, 0); assert.match(o.pairs[0].error!, /collider count/);
  }
  assert.equal(queried, 4 * 16, 'only the valid lower ring (cases 1 and 3) is queried against peg and floor');
  assert.throws(() => observeNativeContacts({ rings: [count(16), count(16)], peg: ok(1), floor: ok(1), pieces: 16 }, { prediction: -1 }), /prediction/);
  assert.throws(() => observeNativeContacts({ rings: [count(16), count(16)], peg: ok(1), floor: ok(1), pieces: 16 }, { prediction: Infinity }), /prediction/);
});
