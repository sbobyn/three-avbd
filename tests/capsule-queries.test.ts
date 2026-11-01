import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StaticQueryScene, boxMesh, type CapsuleSweepResult } from '../src/lib/queries.ts';
import { capsuleContact } from '../src/queries/capsule.ts';
import type { Triangle, Vec3 } from '../src/queries/geometry.ts';
const near = (a: number, b: number, e = 1e-7) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const tri: Triangle = [[0, 0, 0], [4, 0, 0], [0, 4, 0]];
const sceneFor = (t: Triangle) => { const s = new StaticQueryScene(); s.addMesh({ positions: t.flat() }); return s; };
function hit(r: CapsuleSweepResult, fraction: number) {
  assert.equal(r.status, 'hit');
  if (r.status !== 'hit') throw new Error('expected hit');
  near(r.hit.fraction, fraction);
  assert.ok([...r.hit.point, ...r.hit.normal, r.hit.fraction].every(Number.isFinite));
  return r.hit;
}

test('analytic segment/triangle closest features: plane piercing, parallel face, edge, vertex', () => {
  near(capsuleContact([1, 1, -3], [1, 1, 3], tri).distance, 0);
  near(capsuleContact([.5, .5, 2], [2, .5, 2], tri).distance, 2);
  // Neither cap is closest: segment interior against edge interior.
  const edge = capsuleContact([2, -2, -3], [2, -2, 3], tri);
  near(edge.distance, 2); assert.deepEqual(edge.point, [2, 0, 0]);
  near(capsuleContact([-2, -3, -5], [-2, -3, 5], tri).distance, Math.sqrt(13));
  near(capsuleContact([.5, .5, 2], [2, .5, 2 + 1e-12], tri).distance, 2);
  near(capsuleContact([-1, 1, 1], [5, 1 + 1e-12, 1], tri).distance, 1);
});

test('zero segment exactly preserves sphere overlap and sweep APIs', () => {
  const s = sceneFor(tri);
  for (const center of [[1, 1, 2], [1, 1, 0], [-2, 0, 0]] as Vec3[]) for (const radius of [0, .3, 2]) {
    assert.deepEqual(s.overlapCapsule({ start: center, end: center, radius }), s.overlapSphere(center, radius));
    for (const translation of [[0, 0, -10], [0, 0, 0]] as Vec3[]) assert.deepEqual(
      s.sweepCapsule({ start: center, end: center, radius, translation }), s.sweepSphere({ center, radius, translation }));
  }
});

test('capsule cylinder, thin wall, initial overlap, zero motion, miss and explicit bounded exhaustion', () => {
  const wall: Triangle = [[0, -10, -10], [0, 10, -10], [0, 0, 10]], s = sceneFor(wall);
  const c = { start: [-2, -2, 0], end: [-2, 2, 0], radius: .3 };
  hit(s.sweepCapsule({ ...c, translation: [10000, 0, 0] }), 1.7 / 10000);
  assert.equal(s.sweepCapsule({ ...c, translation: [0, 3, 0] }).status, 'miss');
  assert.equal(s.sweepCapsule({ ...c, translation: [0, 0, 0] }).status, 'miss');
  const overlap = { start: [-.2, -2, 0], end: [-.2, 2, 0], radius: .3 };
  assert.equal(hit(s.sweepCapsule({ ...overlap, translation: [-10, 0, 0] }), 0).startedOverlapping, true);
  hit(s.sweepCapsule({ ...overlap, translation: [0, 0, 0] }), 0);
  const exhausted = s.sweepCapsule({ ...c, translation: [4, 0, 0] }, { maxIterations: 1 });
  assert.equal(exhausted.status, 'indeterminate');
  if (exhausted.status === 'indeterminate') assert.ok(exhausted.fraction >= 0 && exhausted.fraction <= .425);
});

test('edge and vertex sweeps with segment interior, grazing and near parallel', () => {
  const s = sceneFor(tri);
  hit(s.sweepCapsule({ start: [2, -2, -3], end: [2, -2, 3], radius: .5, translation: [0, 4, 0] }), .375);
  hit(s.sweepCapsule({ start: [-2, -2, -3], end: [-2, -2, 3], radius: Math.SQRT2, translation: [2, 2, 0] }), .5);
  // Tangent vertex encounter may need the explicit larger bounded budget.
  const grazing = s.sweepCapsule({ start: [-2, -.5, -1], end: [-2, -.5, 1], radius: .5, translation: [4, 0, 0] }, { maxIterations: 4096 });
  assert.notEqual(grazing.status, 'miss');
  assert.equal(s.sweepCapsule({ start: [.5, .5, .3], end: [2, .5, .3 + 1e-12], radius: .2, translation: [1, 0, -1e-12] }).status, 'miss');
});

test('stairs nose, low ceiling, concave corner and rotated meshes', () => {
  const s = new StaticQueryScene();
  s.addMesh({ ...boxMesh([2, .2, 2]), position: [1, .1, 0] });
  hit(s.sweepCapsule({ start: [-1, .4, 0], end: [-1, 1.4, 0], radius: .3, translation: [2, 0, 0] }), (1 - Math.sqrt(.09 - .04)) / 2);
  const ceiling = new StaticQueryScene(); ceiling.addMesh({ ...boxMesh([10, .1, 10]), position: [0, 2, 0] });
  hit(ceiling.sweepCapsule({ start: [0, .3, 0], end: [0, 1.5, 0], radius: .3, translation: [0, 1, 0] }), .15);
  const corner = new StaticQueryScene();
  corner.addMesh({ ...boxMesh([.1, 10, 10]), position: [2, 0, 0] });
  corner.addMesh({ ...boxMesh([10, 10, .1]), position: [0, 0, 2] });
  const cornerHit = hit(corner.sweepCapsule({ start: [0, -1, 0], end: [0, 1, 0], radius: .3, translation: [3, 0, 3] }), 1.65 / 3);
  assert.equal(cornerHit.meshId, 1);
  const rotated = new StaticQueryScene();
  rotated.addMesh({ ...boxMesh([.02, 10, 10]), rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] });
  const a = Math.SQRT1_2;
  hit(rotated.sweepCapsule({ start: [-2 * a, -1, 2 * a], end: [-2 * a, 1, 2 * a], radius: .3, translation: [4 * a, 0, -4 * a] }), 1.69 / 4);
});

test('caps, filters, ignored removed handles, lifetime and invalid input', () => {
  const s = new StaticQueryScene(), h = s.addMesh({ ...boxMesh([2, 2, 2]), group: 2 });
  const c = { start: [-3, 0, 0], end: [3, 0, 0], radius: 0 };
  assert.equal(s.overlapCapsule(c).hits.length, 4);
  assert.deepEqual(s.overlapCapsule(c, { maxResults: 0 }), { hits: [], complete: false });
  assert.equal(s.overlapCapsule(c, { maxResults: 1 }).complete, false);
  assert.equal(s.overlapCapsule(c, { collidesWith: 1 }).hits.length, 0);
  assert.equal(s.sweepCapsule({ ...c, translation: [0, 0, 0] }, { ignore: [h] }).status, 'miss');
  for (const bad of [{ ...c, start: [0, 1] }, { ...c, end: [NaN, 0, 0] }, { ...c, radius: -1 }, { ...c, radius: Infinity }]) {
    assert.throws(() => s.overlapCapsule(bad)); assert.throws(() => s.sweepCapsule({ ...bad, translation: [0, 0, 0] }));
  }
  for (const budget of [0, 4097, NaN, 1.5]) assert.throws(() => s.sweepCapsule({ ...c, translation: [0, 0, 0] }, { maxIterations: budget }));
  assert.throws(() => s.sweepCapsule({ ...c, translation: [Infinity, 0, 0] }));
  assert.throws(() => s.overlapCapsule(c, { maxResults: -1 }));
  assert.throws(() => s.overlapCapsule(c, { ignore: [{ id: h.id, discardedTriangles: 0 }] }));
  s.remove(h); assert.equal(s.overlapCapsule(c, { ignore: [h] }).hits.length, 0);
  s.destroy(); assert.throws(() => s.overlapCapsule(c));
});

test('seeded BVH vs independent one-triangle scenes checks traversal, deterministic nearest and finite outputs', () => {
  let seed = 917;
  const rand = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  const positions: number[] = [], brute: StaticQueryScene[] = [];
  for (let i = 0; i < 45; i++) {
    const x = rand() * 12 - 6, y = rand() * 12 - 6, z = rand() * 12 - 6;
    const t: Triangle = [[x, y, z], [x + .2 + rand(), y, z], [x, y + .2 + rand(), z + rand()]];
    positions.push(...t.flat()); brute.push(sceneFor(t));
  }
  const s = new StaticQueryScene(); s.addMesh({ positions });
  for (let j = 0; j < 80; j++) {
    const start: Vec3 = [rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5];
    const end: Vec3 = [start[0] + rand() * 3, start[1] + rand() * 3, start[2] + rand() * 3];
    const c = { start, end, radius: rand() }, translation: Vec3 = [rand() * 8 - 4, rand() * 8 - 4, rand() * 8 - 4];
    const expected = brute.flatMap((b, i) => b.overlapCapsule(c).hits.map(h => ({ ...h, triangle: i })));
    assert.deepEqual(s.overlapCapsule(c), { hits: expected, complete: true });
    const results = brute.map(b => b.sweepCapsule({ ...c, translation }));
    let nearest = Infinity, unresolved = Infinity;
    results.forEach(r => { if (r.status === 'hit') nearest = Math.min(nearest, r.hit.fraction); else if (r.status === 'indeterminate') unresolved = Math.min(unresolved, r.fraction); });
    const actual = s.sweepCapsule({ ...c, translation });
    assert.equal(actual.status, unresolved <= Math.min(nearest, 1) ? 'indeterminate' : nearest < Infinity ? 'hit' : 'miss');
    if (actual.status === 'hit') hit(actual, nearest);
    assert.deepEqual(s.sweepCapsule({ ...c, translation }), actual);
  }
});

test('unresolved candidates cannot be hidden by known later hits; extreme arithmetic is explicit', () => {
  const s = new StaticQueryScene();
  s.addMesh({ positions: [0, -10, -10, 0, 10, -10, 0, 0, 10] });
  // At fraction zero this second mesh is known to overlap. Its hit resolves the
  // query despite a later unresolved candidate in the first mesh.
  s.addMesh({ positions: [-2, -10, -10, -2, 10, -10, -2, 0, 10] });
  hit(s.sweepCapsule({ start: [-2, -1, 0], end: [-2, 1, 0], radius: .3, translation: [4, 0, 0] }, { maxIterations: 1 }), 0);
  const grazingScene = sceneFor(tri);
  grazingScene.addMesh({ positions: [1, -10, -10, 1, 10, -10, 1, 0, 10] });
  const uncertain = grazingScene.sweepCapsule({ start: [-2, -.5, -1], end: [-2, -.5, 1], radius: .5, translation: [4, 0, 0] }, { maxIterations: 32 });
  assert.equal(uncertain.status, 'indeterminate');
  if (uncertain.status === 'indeterminate') assert.ok(uncertain.fraction < .625);
  const huge = sceneFor(tri), c = { start: [-1e160, 1, 0], end: [1e160, 1, 0], radius: 0 };
  assert.throws(() => huge.overlapCapsule(c), /numeric range/);
  assert.equal(huge.sweepCapsule({ ...c, translation: [0, 0, 1] }).status, 'indeterminate');
});
