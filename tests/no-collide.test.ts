// The solver's no-collide list (src/avbd3d/gpu/no-collide.ts), on the CPU: joint slots released
// and reused between uploads must leave only the slot's current pair. The GPU side of the same
// cases is in tests-gpu/world-contracts.gpu.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IGNORE_SLOT, NoCollideTable } from '../src/avbd3d/gpu/no-collide.ts';

test('no-collide: entries are kept sorted by (hi, lo) with hi > lo', () => {
  const t = new NoCollideTable();
  t.add(1, 4, 0);
  t.add(3, 2, 1);
  t.add(0, 5, IGNORE_SLOT);
  assert.deepEqual(t.flush(), [[3, 2, 1], [4, 1, 0], [5, 0, IGNORE_SLOT]]);
  assert.equal(t.dirty, false);
  t.add(2, 0, 2);
  assert.deepEqual(t.flush(), [[2, 0, 2], [3, 2, 1], [4, 1, 0], [5, 0, IGNORE_SLOT]]);
});

test('no-collide: a slot released and reused before the next upload keeps only its new pair', () => {
  const t = new NoCollideTable();
  t.add(1, 0, 0); // joint (a, b) = (1, 0) in slot 0
  t.flush();
  t.release([0]);
  t.add(3, 2, 0); // the same frame, a joint on (3, 2) takes slot 0
  assert.deepEqual(t.flush(), [[3, 2, 0]], 'the old pair collides again; the new one does not');
});

test('no-collide: a slot added and released before any upload leaves nothing', () => {
  const t = new NoCollideTable();
  t.add(1, 0, 0);
  t.release([0]);
  assert.deepEqual(t.flush(), []);
});

test('no-collide: release and reuse twice before an upload keeps only the last pair', () => {
  const t = new NoCollideTable();
  t.add(1, 0, 4);
  t.flush();
  t.release([4]);
  t.add(3, 2, 4);
  t.release([4]);
  t.add(6, 5, 4);
  assert.deepEqual(t.flush(), [[6, 5, 4]]);
});

test('no-collide: releasing one slot leaves other joints, the same pair under another slot, and IgnoreCollision', () => {
  const t = new NoCollideTable();
  t.add(1, 0, 0);
  t.add(1, 0, 1); // a second joint between the same bodies
  t.add(1, 0, IGNORE_SLOT);
  t.add(2, 0, 2);
  t.flush();
  t.release([0]);
  t.add(7, 6, 0); // slot 0 reused
  assert.deepEqual(t.flush(), [[1, 0, 1], [1, 0, IGNORE_SLOT], [2, 0, 2], [7, 6, 0]]);
});

test('no-collide: springs and joints share the slot bookkeeping (a spring reusing a joint slot)', () => {
  // Springs go through the same appendConstraints path: the table is told only slot and pair
  const t = new NoCollideTable();
  t.add(9, 8, 3); // joint
  t.flush();
  t.release([3]); // broke (seen at a readback) or removed
  t.add(5, 4, 3); // a spring takes slot 3 in the same frame
  t.add(9, 8, 6); // and the old pair is joined again elsewhere
  assert.deepEqual(t.flush(), [[5, 4, 3], [9, 8, 6]]);
});

test('no-collide: an empty release and a flush with no change keep the list', () => {
  const t = new NoCollideTable();
  t.add(1, 0, 0);
  const first = t.flush();
  t.release([]);
  assert.equal(t.dirty, false);
  assert.strictEqual(t.flush(), first);
});
