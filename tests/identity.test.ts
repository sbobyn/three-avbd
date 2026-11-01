import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyIds, MAX_BODY_ID, RetiredBodies, assertOwner, sameReadStep, orderedEvents } from '../src/lib/identity.ts';

test('lifetime IDs are monotonic and refuse the report-bit boundary without wrapping', () => {
  const ids = new BodyIds();
  assert.equal(ids.allocate(), 1);
  assert.equal(ids.allocate(), 2);
  // Reach the boundary without allocating billions of handles.
  (ids as unknown as { next: number }).next = MAX_BODY_ID;
  assert.equal(ids.allocate(), MAX_BODY_ID);
  assert.throws(() => ids.allocate(), /exhausted/);
  assert.throws(() => ids.allocate(), /exhausted/);
});

test('retired identities survive reads before their end pass, and drain after it', () => {
  const retired = new RetiredBodies<{ id: number; index: number }>();
  const old = { id: 1, index: 0 }, fresh = { id: 2, index: 0 };
  retired.retire(old, 4);
  retired.drain(4);
  assert.equal(retired.snapshot([fresh]).get(1), old);
  const captured = retired.snapshot([fresh]);
  retired.drain(5);
  assert.equal(retired.snapshot([fresh]).has(1), false);
  assert.equal(captured.get(1), old, 'in-flight delivery keeps captured identity');
  assert.equal(captured.get(2), fresh);
});

test('retirement is bounded per slot; missing events can be counted without substitution', () => {
  const retired = new RetiredBodies<{ id: number; index: number }>();
  for (let id = 1; id <= 12; id++) retired.retire({ id, index: 0 }, id);
  const identities = retired.snapshot([{ id: 13, index: 0 }]);
  assert.equal(identities.size, 9);
  let dropped = 0;
  const delivered: number[] = [];
  for (const id of [1, 4, 5, 12]) {
    const body = identities.get(id);
    if (!body) dropped++;
    else delivered.push(body.id);
  }
  assert.equal(dropped, 2);
  assert.deepEqual(delivered, [5, 12]);
});

test('read coalescing requires the same submitted step and handles require their owner', () => {
  assert.equal(sameReadStep(4, 4), true);
  assert.equal(sameReadStep(5, 4), false);
  const world = {}, foreign = {};
  assert.doesNotThrow(() => assertOwner(world, { world }));
  assert.throws(() => assertOwner(world, { world: foreign }), /another world/);
});

test('event ordering is stable, end before begin, and captured delivery tolerates mutation', () => {
  const input = [{ step: 2, kind: 1, id: 1 }, { step: 1, kind: 1, id: 2 }, { step: 2, kind: 2, id: 3 }, { step: 2, kind: 1, id: 4 }];
  const events = orderedEvents(input);
  const received: number[] = [];
  const listeners = new Set([(e: typeof input[number]) => { received.push(e.id); input.length = 0; listeners.clear(); }]);
  const captured = [...listeners];
  for (const e of events) for (const listener of captured) listener(e);
  assert.deepEqual(received, [2, 3, 1, 4]);
});
