import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkEnabled, resetBodyPatch, BodyLifecycleError } from '../src/lib/lifecycle.ts';
import { assignBodyPatch, bodyFields, type BodyField } from '../src/lib/body-commands.ts';
import { deviceCapabilities, worldCapabilities } from '../src/lib/capabilities.ts';
import { BodyIds, MAX_BODY_ID } from '../src/lib/identity.ts';

test('reset validates copied fields, zeros omitted velocities and preserves omission of pose', () => {
  const position = [1, 2, 3];
  const patch = resetBodyPatch({ position, velocity: undefined, rotation: [0, 0, 0, 2] });
  position[0] = 99;
  assert.deepEqual(patch, { position: [1, 2, 3], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
  assert.equal(resetBodyPatch({}).position, undefined);
  assert.throws(() => resetBodyPatch({ position: [1, Infinity, 3] }));
});

test('reset and ordinary patches retain the last explicit field assignment', () => {
  const state = { position: [0, 0, 0], rotation: [0, 0, 0, 1], velocity: [2, 2, 2], angularVelocity: [3, 3, 3] };
  const revisions = Object.fromEntries(bodyFields.map(field => [field, 0])) as Record<BodyField, number>;
  assignBodyPatch(state, revisions, { position: [1, 2, 3] }, 1);
  assignBodyPatch(state, revisions, resetBodyPatch({ velocity: [4, 5, 6] }), 2);
  assignBodyPatch(state, revisions, { angularVelocity: [7, 8, 9] }, 3);
  assert.deepEqual(state.position, [1, 2, 3]);
  assert.deepEqual(state.velocity, [4, 5, 6]);
  assert.deepEqual(state.angularVelocity, [7, 8, 9]);
  assert.deepEqual(revisions, { position: 1, rotation: 0, velocity: 2, angularVelocity: 3 });
});

test('activation options require booleans and capabilities fail closed for custom shaders/backends', () => {
  for (const bad of [null, undefined, 0, 1, '', 'false', {}]) assert.throws(() => checkEnabled(bad as boolean), BodyLifecycleError);
  for (const value of [false, true]) assert.doesNotThrow(() => checkEnabled(value));
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 8 } });
  for (const backend of ['standard', 'sdf', 'custom'] as const) for (const customShaders of [false, true]) {
    const caps = worldCapabilities(device, backend, false, customShaders);
    assert.equal(caps.bodyActivation, backend === 'standard' && !customShaders);
    assert.equal(caps.bodyReset, caps.bodyActivation);
    assert.equal(caps.bodyPooling, false); assert.equal(caps.nativeSleeping, false);
    assert.equal(caps.lifecycleAbi, 1); assert.ok(Object.isFrozen(caps));
  }
});

test('remaining lifetime IDs reaches zero without wrapping or spending an ID on failure', () => {
  const ids = new BodyIds();
  assert.equal(ids.remaining, MAX_BODY_ID);
  (ids as unknown as { next: number }).next = MAX_BODY_ID;
  assert.equal(ids.allocate(), MAX_BODY_ID);
  assert.equal(ids.remaining, 0);
  assert.throws(() => ids.allocate(), /exhausted/);
  assert.equal(ids.remaining, 0);
});
