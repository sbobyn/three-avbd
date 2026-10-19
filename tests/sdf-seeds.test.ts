import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { VoxelField, finalizeSdf } from '../src/lib/sdf.ts';
import { meshSurfaceSampler } from '../src/avbd3d/ref/sdf/surface.ts';
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/oracle-sdf/${name}.json`, import.meta.url), 'utf8'));
const near = (a: number, b: number, tolerance = 2e-6) => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const manifest = JSON.parse(readFileSync(new URL('./fixtures/oracle-sdf-surfaces/manifest.json', import.meta.url), 'utf8'));
function floats(folder: string, name: string): Float32Array {
  const raw = gunzipSync(readFileSync(new URL(`./fixtures/${folder}/${name}.bin.gz`, import.meta.url)));
  if (folder.endsWith('surfaces')) {
    assert.equal(raw.length, manifest.surfaces[name].bytes);
    assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.surfaces[name].sha256);
  }
  const result = new Float32Array(raw.length / 4);
  for (let i = 0; i < result.length; i++) result[i] = raw.readFloatLE(i * 4);
  return result;
}
for (const name of ['bunny', 'gear', 'cow', 'chair']) test(`voxel ${name} mass and ordered curvature seeds match pinned C++`, () => {
  const fixture = load(name), expected = load(`seeds-${name}`);
  const field = new VoxelField(fixture.grid.dimensions, fixture.grid.origin, fixture.grid.cell,
    floats('oracle-sdf-grids', name), fixture.bounds, floats('oracle-sdf-surfaces', name));
  const properties = finalizeSdf(field);
  near(properties.volume, expected.volume);
  properties.centerOfMass.forEach((v, i) => near(v, expected.centerOfMass[i]));
  properties.inertia.forEach((v, i) => near(v, expected.inertia[Math.floor(i / 3)][i % 3]));
  assert.equal(field.seeds.length, expected.seeds.length);
  field.seeds.forEach((p, i) => p.forEach((v, j) => near(v, expected.seeds[i].p[j])));
});

test('area-weighted sampling is deterministic, favors larger triangles and rejects empty surfaces', () => {
  const triangles = new Float32Array([0,0,0, 1,0,0, 0,1,0, 10,0,0, 13,0,0, 10,3,0]);
  const a = meshSurfaceSampler(triangles), b = meshSurfaceSampler(triangles); let large = 0;
  for (let i = 0; i < 2000; i++) { const p = a(); assert.deepEqual(p, b()); if (p[0] >= 10) large++; assert.equal(p[2], 0); }
  assert.ok(large > 1750 && large < 1850, String(large));
  assert.throws(() => meshSurfaceSampler(new Float32Array(9)), /area/);
  assert.throws(() => meshSurfaceSampler(new Float32Array(8)), /triangles/);
});

test('seed-only API is pure, cancellable and respects uniform geometry scale', async () => {
  const { AnalyticField, curvatureSeeds } = await import('../src/lib/sdf.ts');
  const field = new AnalyticField({ kind: 'box', halfExtents: [.5, .5, .5] });
  const baseline = curvatureSeeds(field);
  assert.deepEqual(field.seeds, []); assert.deepEqual(field.centerOfMass, [0, 0, 0]);
  for (const s of [.125, 8]) {
    const scaled = new AnalyticField({ kind: 'box', halfExtents: [.5 * s, .5 * s, .5 * s] });
    const seeds = curvatureSeeds(scaled);
    assert.equal(seeds.length, baseline.length);
    seeds.forEach((p, i) => p.forEach((v, j) => near(v / s, baseline[i][j])));
  }
  assert.throws(() => curvatureSeeds(field, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.throws(() => finalizeSdf(field, { candidateCount: -1 }), /candidateCount/);
  assert.deepEqual(field.seeds, []); assert.deepEqual(field.centerOfMass, [0, 0, 0]);
});

test('world-unit parameters preserve scaled objective and contact geometry', async () => {
  const { AnalyticField, collisionParams, scaleCollisionParams } = await import('../src/lib/sdf.ts');
  const { SdfBody } = await import('../src/avbd3d/ref/sdf/body.ts');
  const { SdfManifold } = await import('../src/avbd3d/ref/sdf/manifold.ts');
  const { counters, objective } = await import('../src/avbd3d/ref/sdf/optimize.ts');
  const { Random } = await import('../src/avbd3d/ref/sdf/math.ts');
  const shape = new AnalyticField({ kind: 'box', halfExtents: [.5, .5, .5] }), params = collisionParams();
  const reference = new SdfManifold(new SdfBody(shape), new SdfBody(shape, [.8, 0, 0]));
  reference.update(params, 1 / 60, new Random(), counters());
  const original = objective(reference.bodyA, reference.bodyB, [{ x: [0, 0, 0] }], params.epsilon, params.alpha, counters())([.3, .2, .1]);
  for (const scale of [.125, 8]) {
    const p = scaleCollisionParams(scale);
    near(p.epsilon, params.epsilon * scale * scale); near(p.alpha, params.alpha);
    const m = new SdfManifold(new SdfBody(shape, [0,0,0], [0,0,0,1], scale), new SdfBody(shape, [.8 * scale,0,0], [0,0,0,1], scale));
    m.update(p, 1 / 60, new Random(), counters());
    assert.equal(m.points.length, reference.points.length);
    m.points.forEach((point, i) => {
      assert.equal(point.active, reference.points[i].active);
      point.x.forEach((v, j) => near(v / scale, reference.points[i].x[j], params.tolerance));
    });
    const value = objective(m.bodyA, m.bodyB, [{ x: [0,0,0] }], p.epsilon, p.alpha, counters())([.3 * scale,.2 * scale,.1 * scale]);
    near(value / scale, original);
  }
  assert.equal(scaleCollisionParams(2,{...collisionParams(),epsilon:0}).epsilon,0);
  for (const bad of [0, -1, Infinity, NaN, 1e-40, 1e40]) assert.throws(() => scaleCollisionParams(bad));
});
