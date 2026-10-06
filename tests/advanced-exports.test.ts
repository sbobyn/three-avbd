// three-avbd/advanced: what readbacks of the raw buffers and hull bodies need is exported
// (three-destruction reads contacts and counters itself and builds hull bodies through it).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as advanced from '../src/lib/advanced.ts';

test('advanced exports the contact and counter layout and hull shapes', () => {
  // Record layouts: field offsets inside their stride, 4-word aligned (vec4 fields)
  for (const k of [advanced.K_RA, advanced.K_RB, advanced.K_PEN, advanced.K_LAM]) assert.ok(k % 4 === 0 && k + 4 <= advanced.CONTACT_WORDS);
  assert.equal(new Set([advanced.K_RA, advanced.K_RB, advanced.K_PEN, advanced.K_LAM]).size, 4);
  for (const m of [advanced.M_IDS, advanced.M_GEO]) assert.ok(m % 4 === 0 && m + 4 <= advanced.MANIFOLD_WORDS);
  assert.equal(advanced.STICK_BIT >>> 0, 0x80000000);
  // Counters are distinct words within the counter block
  const counters = [advanced.C_PAIRS, advanced.C_CONTACTS, advanced.C_PREV_CONTACTS, advanced.C_OVERFLOW, advanced.C_CLASHES, advanced.C_NUM_COLORS, advanced.C_MANIFOLDS, advanced.C_PREV_MANIFOLDS];
  assert.equal(new Set(counters).size, counters.length);
  for (const c of counters) assert.ok(c >= 0 && c < advanced.COUNTER_WORDS);
  // A unit cube's hull, from points and from triangles
  const cube = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
  const h = advanced.convexHull(cube);
  assert.ok(h);
  assert.ok(Math.abs(h.volume - 1) < 1e-9);
  // The same cube from its 12 triangles (outward winding)
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const t = advanced.hullFromTriangles(cube, quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  assert.ok(t);
  assert.ok(Math.abs(t.volume - 1) < 1e-9);
  // A hull body of density 2 weighs twice the volume
  const body = advanced.hull(new advanced.Solver(), h, 2, 0.5, [0, 0, 5]);
  assert.ok(Math.abs(body.mass - 2) < 1e-9);
  assert.equal(advanced.NO_COLOR, 255);
});

test('advanced exports the joint record layout (36 floats since 0.3) and decodes a joint read back', () => {
  // Field offsets inside the record, 4-word aligned (vec4 fields), the rest quaternion last
  const fields = [advanced.J_PEN_LIN, advanced.J_PEN_ANG, advanced.J_LAM_LIN, advanced.J_LAM_ANG, advanced.J_RA, advanced.J_RB, advanced.J_REST];
  for (const f of fields) assert.ok(f % 4 === 0 && f + 4 <= advanced.JOINT_FLOATS, `field at ${f}`);
  assert.equal(new Set(fields).size, fields.length);
  assert.equal(advanced.J_REST + 4, advanced.JOINT_FLOATS);
  assert.equal(advanced.JOINT_FLOATS, 36);
  // The yield threshold is a word of its own, the last of C0's angular vec4: inside no field above
  assert.ok(advanced.J_YIELD < advanced.JOINT_FLOATS && advanced.J_YIELD % 4 === 3);
  assert.ok(!fields.some((f) => advanced.J_YIELD >= f && advanced.J_YIELD < f + 4), 'J_YIELD is in no listed field');
  const raw = new Float32Array(advanced.JOINT_FLOATS);
  raw.set([0, 0, 0, 1], advanced.J_REST);
  raw[advanced.J_PEN_LIN + 3] = 3e38;
  assert.deepEqual(advanced.decodeJoint(raw, 0), { linear: 0, angular: 0, broken: false, rest: [0, 0, 0, 1] });
});
