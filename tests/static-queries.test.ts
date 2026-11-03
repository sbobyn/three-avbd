import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StaticQueryScene, boxMesh, type SweepResult } from '../src/lib/queries.ts';
import { rayTriangle, sweepTriangle, contact, type Vec3, type Triangle } from '../src/queries/geometry.ts';
const near = (a: number, b: number, e = 1e-8) => assert.ok(Math.abs(a - b) <= e, `${a} != ${b}`);
const plane = [0, 0, 0, 4, 0, 0, 0, 4, 0];
function hit(r: SweepResult) { assert.equal(r.status, 'hit'); if (r.status !== 'hit') throw new Error('miss'); return r.hit; }
function scene() { const s = new StaticQueryScene(); s.addMesh({ positions: plane }); return s; }

test('sphere face, edge and vertex sweeps have independent analytic times and witnesses', () => {
  const s = scene();
  const face = hit(s.sweepSphere({ center: [1, 1, 2], radius: .5, translation: [0, 0, -4] }));
  near(face.fraction, .375); assert.deepEqual(face.point, [1, 1, 0]); assert.deepEqual(face.normal, [0, 0, 1]);
  const edge = hit(s.sweepSphere({ center: [2, -2, .3], radius: .5, translation: [0, 4, 0] }));
  near(edge.fraction, .4); near(edge.point[0], 2); near(edge.point[1], 0); near(edge.normal[1], -.8); near(edge.normal[2], .6);
  const vertex = hit(s.sweepSphere({ center: [-2, -.3, .0], radius: .5, translation: [4, 0, 0] }));
  near(vertex.fraction, .4); assert.deepEqual(vertex.point, [0, 0, 0]); near(vertex.normal[0], -.8); near(vertex.normal[1], -.6);
  const back = hit(s.sweepSphere({ center: [1, 1, -2], radius: .5, translation: [0, 0, 4] }));
  near(back.fraction, .375); near(back.normal[2], -1);
});

test('tangent, endpoint, parallel miss and initial contact including zero motion', () => {
  const s = scene();
  near(hit(s.sweepSphere({ center: [-2, -.5, 0], radius: .5, translation: [4, 0, 0] })).fraction, .5);
  near(hit(s.sweepSphere({ center: [1, 1, 1.5], radius: .5, translation: [0, 0, -1] })).fraction, 1);
  assert.equal(s.sweepSphere({ center: [-2, -.501, 0], radius: .5, translation: [4, 0, 0] }).status, 'miss');
  for (const translation of [[0, 0, 0], [0, 0, 10]] as Vec3[]) {
    const initial = hit(s.sweepSphere({ center: [1, 1, .25], radius: .5, translation }));
    assert.equal(initial.startedOverlapping, true); assert.equal(initial.fraction, 0); near(initial.normal[2], 1);
  }
  assert.equal(s.sweepSphere({ center: [1, 1, 2], radius: .5, translation: [0, 0, 0] }).status, 'miss');
  const on = hit(s.sweepSphere({ center: [1, 1, 0], radius: 0, translation: [0, 0, 0] }));
  assert.equal(on.startedOverlapping, true); near(on.normal[2], 1);
  near(hit(s.sweepSphere({ center: [1, 1, 2], radius: 0, translation: [0, 0, -4] })).fraction, .5);
});

test('scale-aware contacts and oblique face motion', () => {
  for (const scale of [1e-4, 1, 1e4]) {
    const s = new StaticQueryScene(); s.addMesh({ positions: plane.map(v => v * scale) });
    const r = hit(s.sweepSphere({ center: [scale, scale, 2 * scale], radius: .5 * scale, translation: [.2 * scale, .1 * scale, -4 * scale] }));
    near(r.fraction, .375); near(r.point[0], 1.075 * scale, 1e-7); near(r.point[1], 1.0375 * scale, 1e-7);
    assert.equal(s.overlapSphere([scale, scale, .5 * scale + 1e-11], .5 * scale).hits.length, 1);
  }
  const s = scene();
  const initial = hit(s.sweepSphere({ center: [2, -.3, .3], radius: .5, translation: [0, -1, 0] }));
  assert.equal(initial.startedOverlapping, true); near(initial.normal[1], -Math.SQRT1_2); near(initial.normal[2], Math.SQRT1_2);
});

test('thin wall at two metres per tick and origin inside a closed surface', () => {
  const s = new StaticQueryScene(); s.addMesh(boxMesh([.02, 4, 4]));
  near(hit(s.sweepSphere({ center: [-1, 0, 0], radius: .025, translation: [2, 0, 0] })).fraction, .4825);
  // Triangles are surfaces, not a solid-volume containment test.
  assert.equal(s.overlapSphere([0, 0, 0], .001).hits.length, 0);
  near(s.raycast([0, 0, 0], [2, 0, 0])!.distance, .01);
  assert.equal(hit(s.sweepSphere({ center: [0, 0, 0], radius: .02, translation: [1, 0, 0] })).startedOverlapping, true);
});

test('normalized rays, nearest ties, coplanar rays, transformed geometry and copied input', () => {
  const s = new StaticQueryScene(), positions = [...plane], indices = [0, 1, 2];
  const a = s.addMesh({ positions, indices, rotation: [0, 0, 0, 2] });
  s.addMesh({ positions: plane }); positions.fill(100); indices.fill(0);
  const r = s.raycast([1, 1, 3], [0, 0, -10])!;
  assert.equal(r.meshId, a.id); near(r.distance, 3); near(r.normal[2], 1);
  assert.equal(s.raycast([1, 1, 3], [0, 0, -1], { maxDistance: 2.9 }), null);
  near(s.raycast([-1, 1, 0], [1, 0, 0])!.distance, 1);
  near(s.raycast([1, 1, 0], [1, 0, 0])!.distance, 0);
  const rotated = new StaticQueryScene(), q = [0, Math.SQRT1_2, 0, Math.SQRT1_2], position = [2, 0, 0];
  rotated.addMesh({ positions: plane, rotation: q, position }); q.fill(0); position.fill(50);
  near(rotated.raycast([5, 1, -1], [-1, 0, 0])!.distance, 3);
  near(hit(rotated.sweepSphere({ center: [5, 1, -1], radius: .5, translation: [-4, 0, 0] })).fraction, .625);
  const duplicate = new StaticQueryScene(); duplicate.addMesh({ positions: [...plane, ...plane] });
  assert.equal(duplicate.raycast([1, 1, 1], [0, 0, -1])!.triangle, 0);
  assert.equal(hit(duplicate.sweepSphere({ center: [1, 1, 1], radius: .5, translation: [0, 0, -2] })).triangle, 0);
});

test('one-way group masks, ignore handles and bounded sorted overlap completeness', () => {
  const s = new StaticQueryScene(), a = s.addMesh({ positions: plane, group: 1, collidesWith: 0 }), b = s.addMesh({ positions: plane, group: 2 });
  assert.equal(s.raycast([1, 1, 1], [0, 0, -1], { collidesWith: 1 })!.meshId, a.id);
  assert.equal(s.raycast([1, 1, 1], [0, 0, -1], { ignore: [a] })!.meshId, b.id);
  assert.equal(s.raycast([1, 1, 1], [0, 0, -1], { collidesWith: 0 }), null);
  const query = { center: [1, 1, 1], radius: .5, translation: [0, 0, -2] };
  assert.equal(hit(s.sweepSphere(query, { collidesWith: 2 })).meshId, b.id);
  assert.equal(s.sweepSphere(query, { ignore: [a, b] }).status, 'miss');
  const bounded = s.overlapSphere([1, 1, .1], .2, { maxResults: 1 });
  assert.equal(bounded.complete, false); assert.equal(bounded.hits.length, 1); assert.equal(bounded.hits[0].meshId, a.id);
  assert.equal(s.overlapSphere([1, 1, .1], .2, { maxResults: 2 }).complete, true);
  assert.deepEqual(s.overlapSphere([1, 1, .1], .2, { maxResults: 0 }), { hits: [], complete: false });
  assert.deepEqual(s.overlapSphere([1, 1, 2], .2, { maxResults: 0 }), { hits: [], complete: true });
  const stats = { nodesVisited: 0, trianglesTested: 0 };
  s.overlapSphere([1, 1, 0], 1, { collidesWith: 0, stats }); assert.deepEqual(stats, { nodesVisited: 0, trianglesTested: 0 });
});

test('atomic validation, degenerate source indices, revisions, foreign/removed handles and destruction', () => {
  const s = new StaticQueryScene(); assert.equal(s.revision, 0);
  for (const input of [{ positions: [0] }, { positions: [NaN, 0, 0] }, { positions: plane, indices: [0, 1] }, { positions: plane, indices: [0, 1, 3] }, { positions: plane, rotation: [0, 0, 0, 0] }, { positions: plane, group: -1 }]) assert.throws(() => s.addMesh(input));
  assert.equal(s.revision, 0);
  const h = s.addMesh({ positions: [0, 0, 0, 0, 0, 0, 0, 0, 0, ...plane] });
  assert.equal(h.discardedTriangles, 1); assert.equal(s.revision, 1);
  assert.equal(s.raycast([1, 1, 1], [0, 0, -1])!.triangle, 1);
  for (const run of [() => s.raycast([0, 0, 0], [0, 0, 0]), () => s.raycast([0, 0, 0], [0, 0, 1], { maxDistance: NaN }), () => s.overlapSphere([0, 0, 0], -1), () => s.overlapSphere([0, 0, 0], 1, { maxResults: .5 }), () => s.sweepSphere({ center: [Infinity, 0, 0], radius: 1, translation: [0, 0, 0] }), () => s.raycast([0, 0, 0], [1, 0, 0], { collidesWith: 2 ** 32 })]) assert.throws(run);
  const foreign = new StaticQueryScene().addMesh({ positions: plane }); assert.throws(() => s.remove(foreign));
  assert.throws(() => s.overlapSphere([0, 0, 0], 1, { ignore: [foreign] }));
  assert.equal(s.remove(h), true); assert.equal(s.revision, 2); assert.equal(s.remove(h), false); assert.equal(s.revision, 2);
  const next = s.addMesh({ positions: [] }); assert.ok(next.id > h.id); assert.equal(s.raycast([0, 0, 0], [1, 0, 0]), null);
  s.destroy(); s.destroy();
  for (const run of [() => s.revision, () => s.addMesh({ positions: plane }), () => s.remove(next), () => s.raycast([0, 0, 0], [1, 0, 0]), () => s.overlapSphere([0, 0, 0], 1), () => s.sweepSphere({ center: [0, 0, 0], radius: 1, translation: [0, 0, 0] })]) assert.throws(run, /destroyed/);
});

test('1024 seeded triangles: accelerated results equal brute-force leaf iteration; rays prune over 90%', () => {
  let state = 123456789;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const triangles: Triangle[] = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const z = random() * .3;
    triangles.push([[x * 2, y * 2, z], [x * 2 + .7 + random() * .2, y * 2, z + random() * .1], [x * 2, y * 2 + .7 + random() * .2, z + random() * .1]]);
  }
  const s = new StaticQueryScene(); s.addMesh({ positions: triangles.flat(2) });
  // Oracle loops the fixture directly; it never calls a scene or BVH traversal.
  for (let k = 0; k < 80; k++) {
    const tri = triangles[Math.floor(random() * triangles.length)];
    const c: Vec3 = [tri[0][0] + (random() < .8 ? .2 : 1.2), tri[0][1] + .2, 2];
    const d: Vec3 = [0, 0, -1], translation: Vec3 = [.1, -.1, -3], radius = .15;
    let ray: { triangle: number; distance: number } | null = null;
    let sweep: { triangle: number; fraction: number } | null = null;
    const overlaps: number[] = [], overlapCenter: Vec3 = [c[0], c[1], .3];
    triangles.forEach((t, i) => {
      const distance = rayTriangle(c, d, t, 10);
      if (distance !== null && (!ray || distance < ray.distance)) ray = { triangle: i, distance };
      const h = sweepTriangle(c, radius, translation, t);
      if (h && (!sweep || h.fraction < sweep.fraction)) sweep = { triangle: i, fraction: h.fraction };
      if (contact(overlapCenter, t).distance <= radius + 1e-10) overlaps.push(i);
    });
    const stats = { nodesVisited: 0, trianglesTested: 0 }, actual = s.raycast(c, d, { maxDistance: 10, stats });
    assert.deepEqual(actual ? { triangle: actual.triangle, distance: actual.distance } : null, ray);
    assert.ok(stats.trianglesTested < triangles.length / 10); assert.ok(stats.nodesVisited > 0);
    const before = stats.trianglesTested; s.raycast(c, d, { stats }); assert.equal(stats.trianglesTested, before * 2);
    assert.deepEqual(s.overlapSphere(overlapCenter, radius).hits.map(h => h.triangle), overlaps);
    const result = s.sweepSphere({ center: c, radius, translation });
    assert.deepEqual(result.status === 'hit' ? { triangle: result.hit.triangle, fraction: result.hit.fraction } : null, sweep);
  }
});
