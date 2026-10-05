// three-avbd/advanced: what readbacks of the raw buffers and hull bodies need is exported
// (three-destruction reads contacts and counters itself and builds hull bodies through it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as advanced from '../src/lib/advanced.ts';

test('advanced exports the contact and counter layout and hull shapes', () => {
  for (const name of ['CONTACT_WORDS', 'C_MANIFOLDS', 'C_PAIRS', 'C_CONTACTS', 'C_PREV_CONTACTS', 'C_OVERFLOW', 'C_CLASHES', 'C_NUM_COLORS', 'COUNTER_WORDS', 'NO_COLOR', 'MAX_HULL_VERTICES'] as const) {
    assert.equal(typeof advanced[name], 'number', name);
  }
  // Counters are distinct words within the counter block
  const counters = [advanced.C_PAIRS, advanced.C_CONTACTS, advanced.C_PREV_CONTACTS, advanced.C_OVERFLOW, advanced.C_CLASHES, advanced.C_NUM_COLORS, advanced.C_MANIFOLDS];
  assert.equal(new Set(counters).size, counters.length);
  for (const c of counters) assert.ok(c >= 0 && c < advanced.COUNTER_WORDS);
  // A unit cube's hull, from points and from triangles
  const cube = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
  const h = advanced.convexHull(cube);
  assert.ok(h);
  assert.ok(Math.abs(h.volume - 1) < 1e-9);
  assert.equal(typeof advanced.hull, 'function');
  assert.equal(typeof advanced.hullFromTriangles, 'function');
});
