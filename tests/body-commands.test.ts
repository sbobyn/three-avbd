import test from 'node:test';
import assert from 'node:assert/strict';
import { assignBodyPatch, bodyFields, copyBodyPatch, observedField, type BodyField } from '../src/lib/body-commands.ts';

const model = () => ({
  state: { position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
  revisions: Object.fromEntries(bodyFields.map(f => [f, 0])) as Record<BodyField, number>,
});

test('body commands copy, normalize, and validate every field before assignment', () => {
  const input = { position: [1, 2, 3], rotation: [0, 0, 0, 2] };
  const patch = copyBodyPatch(input);
  input.position[0] = 99;
  assert.deepEqual(patch.position, [1, 2, 3]);
  assert.deepEqual(patch.rotation, [0, 0, 0, 1]);
  for (const input of [{ position: [1, 2] }, { velocity: [0, Infinity, 0] }, { angularVelocity: [NaN, 0, 0] }, { rotation: [0, 0, 0, 0] }, { position: [1e100, 0, 0] }]) {
    const m = model();
    assert.throws(() => assignBodyPatch(m.state, m.revisions, copyBodyPatch(input), 1));
    assert.deepEqual(m, model());
  }
});

test('body commands compose partial fields, last assignment wins, empty set is inert', () => {
  const m = model();
  assignBodyPatch(m.state, m.revisions, copyBodyPatch({ velocity: [1, 2, 3] }), 1);
  assignBodyPatch(m.state, m.revisions, copyBodyPatch({ position: [4, 5, 6] }), 2);
  assignBodyPatch(m.state, m.revisions, copyBodyPatch({ velocity: [7, 8, 9] }), 3);
  const before = structuredClone(m);
  assignBodyPatch(m.state, m.revisions, copyBodyPatch({}), 4);
  assert.deepEqual(m, before);
  assert.deepEqual(m.state.position, [4, 5, 6]);
  assert.deepEqual(m.state.velocity, [7, 8, 9]);
  assert.equal(m.revisions.position, 2);
  assert.equal(m.revisions.velocity, 3);
  assert.equal(m.revisions.rotation, 0);
});

test('late observations update unassigned fields and retain newer field overrides', () => {
  const m = model();
  assignBodyPatch(m.state, m.revisions, { position: [1, 2, 3] }, 1);
  const readRevision = 1;
  assignBodyPatch(m.state, m.revisions, { velocity: [7, 8, 9] }, 2);
  assert.deepEqual(observedField(m.state.position, m.revisions.position, [4, 5, 6], readRevision), [4, 5, 6]);
  assert.deepEqual(observedField(m.state.velocity, m.revisions.velocity, [0, 0, 0], readRevision), [7, 8, 9]);
  assert.deepEqual(observedField(m.state.velocity, m.revisions.velocity, [3, 2, 1], 2), [3, 2, 1]);
});

test('a replacement lifetime starts with independent assignments at the same slot', () => {
  const old = model(), replacement = model();
  assignBodyPatch(old.state, old.revisions, { position: [8, 9, 10] }, 1);
  const pending = new Map([[old, copyBodyPatch({ velocity: [1, 0, 0] })]]);
  pending.delete(old);
  assignBodyPatch(replacement.state, replacement.revisions, { position: [2, 0, 0] }, 2);
  assert.equal(pending.has(replacement), false);
  assert.deepEqual(observedField(replacement.state.position, replacement.revisions.position, [8, 9, 10], 1), [2, 0, 0]);
});
