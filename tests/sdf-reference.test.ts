import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { VoxelField } from '../src/avbd3d/ref/sdf/voxel.ts';
import type { Field } from '../src/avbd3d/ref/sdf/shapes.ts';
import { AnalyticField, type AnalyticSpec } from '../src/avbd3d/ref/sdf/shapes.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { SdfCollisionAdapter } from '../src/avbd3d/ref/sdf/adapter.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { Random, f, vec, intersection, length, minus, type Vec, type Rotation } from '../src/avbd3d/ref/sdf/math.ts';
import { objective, objectiveGradient, counters, nelderMead, ellipsoidMethod, gradientDescent, type Mat3 } from '../src/avbd3d/ref/sdf/optimize.ts';
import { SdfManifold, collisionParams, type SdfContact } from '../src/avbd3d/ref/sdf/manifold.ts';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/oracle-sdf/${name}.json`, import.meta.url), 'utf8'));
const specs: Record<string, AnalyticSpec> = {
  box: { kind: 'box', halfExtents: [.5, .5, .5] }, sphere: { kind: 'sphere', radius: .5 },
  capsule: { kind: 'capsule', radius: .3, halfLength: .4 }, cylinder: { kind: 'cylinder', radius: .4, halfHeight: .4 },
  cone: { kind: 'cone', radius: .5, halfHeight: .5 }, torus: { kind: 'torus', majorRadius: .5, minorRadius: .2 },
  'spike-plate': { kind: 'spike-plate', halfExtents: [.7, .08, .7], count: 10, spikeRadius: .045, minHeight: .12, maxHeight: .26 },
  'spiky-wheel': { kind: 'spiky-wheel', hubRadius: .35, hubHalfWidth: .48, spikeRadius: .08, spikeHalfHeight: .7, spikes: 16 },
};
for (const [name, type, values] of [['bend', 0, [.95, .15, .55, .95]], ['twist', 1, [1.25, .5, 2.5, 5]], ['displace', 2, [.1, .05, .1, .2]]] as const) {
  values.forEach((k, i) => { specs[i ? `${name}-${k.toFixed(2)}` : name] = { kind: 'warp', type, k, halfExtents: type === 1 ? [1.15, .55, .28] : [1.15, .28, .55] }; });
}
const close = (a: number, b: number, tolerance = 2e-6, label = '') => assert.ok(Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(b)), `${label}: ${a} != ${b}`);
const grids = new Map<string, VoxelField>();
function voxel(name: string): VoxelField {
  const cached = grids.get(name); if (cached) return cached;
  const metadata = load(name), raw = gunzipSync(readFileSync(new URL(`./fixtures/oracle-sdf-grids/${name}.bin.gz`, import.meta.url)));
  const data = new Float32Array(raw.length / 4);
  for (let i = 0; i < data.length; i++) data[i] = raw.readFloatLE(i * 4);
  const result = new VoxelField(metadata.grid.dimensions, metadata.grid.origin, metadata.grid.cell, data, metadata.bounds);
  grids.set(name, result); return result;
}
function field(name: string): Field {
  const s = specs[name] ? new AnalyticField(specs[name]) : voxel(name), seeds = load(`seeds-${name}`);
  s.centerOfMass = vec(seeds.centerOfMass); s.seeds = seeds.seeds.map((s: { p: Vec }) => vec(s.p)); return s;
}

test('SDF CPU analytic phi and gradients match all 3,500 upstream samples', () => {
  assert.equal(Object.keys(specs).length, 20);
  for (const [name, spec] of Object.entries(specs)) {
    const shape = new AnalyticField(spec), fixture = load(name);
    for (const sample of fixture.samples) {
      const actual = shape.sample(vec(sample.p)); close(actual.phi, sample.phi, 2e-6, `${name} phi ${sample.p}`);
      actual.gradient.forEach((x, i) => close(x, sample.gradient[i], 2e-6, `${name} gradient ${sample.p} axis ${i}`));
    }
  }
});

test('SDF CPU Nelder–Mead matches the 16 oracle optimizations within tau', () => {
  for (const c of load('optimizer').cases) {
    // The level-2 fixture intentionally did not finalize shapes: center of mass = zero.
    const a = new SdfBody(new AnalyticField(specs[c.shapeA]));
    const b = new SdfBody(new AnalyticField(specs[c.shapeB]), vec(c.originB), c.rotationB.map(f) as Rotation);
    const stats = counters(), g = objective(a, b, c.repulsionPoints.map((x: Vec) => ({ x: vec(x) })), f(c.epsilon), f(c.alpha), stats);
    const result = nelderMead(g, vec(c.seed), intersection(a.bounds, b.bounds), vec(c.initialStep), f(c.tolerance), c.maxIterations);
    assert.ok(length(minus(result.x, vec(c.x))) <= c.tolerance, `${c.shapeA}: ${result.x} vs ${c.x}`);
    close(g(result.x), c.objective, 1e-5, c.shapeA);
    assert.equal(result.iterations, c.iterations); assert.equal(stats.queries - 1, c.queries);
  }
});

test('SDF CPU objective gradient, Ellipsoid and gradient descent match the 16 oracle optimizations', () => {
  const mat = (m: number[][]) => m.map(r => vec(r)) as Mat3;
  for (const c of load('optimizers').cases) {
    const a = new SdfBody(new AnalyticField(specs[c.shapeA]));
    const b = new SdfBody(new AnalyticField(specs[c.shapeB]), vec(c.originB), c.rotationB.map(f) as Rotation);
    const domain = intersection(a.bounds, b.bounds), repel = c.repulsionPoints.map((x: Vec) => ({ x: vec(x) }));
    const label = `${c.shapeA} seed ${c.seed}`;
    const g = (stats = counters()) => objectiveGradient(a, b, repel, f(c.epsilon), f(c.alpha), stats);
    const atSeed = g()(vec(c.seed));
    close(atSeed.value, c.seedValue, 2e-6, `${label} value`);
    atSeed.gradient.forEach((x, i) => close(x, c.seedGradient[i], 2e-5, `${label} gradient ${i}`));
    for (const [run, initial, seed] of [['ellipsoid', c.ellipsoid.initial, c.seed], ['warmEllipsoid', c.warmEllipsoid.initial, c.warmEllipsoid.seed]] as const) {
      const expected = c[run], stats = counters();
      const result = ellipsoidMethod(g(stats), vec(seed), domain, mat(initial), f(c.tolerance), c.maxIterations);
      assert.ok(length(minus(result.x, vec(expected.x))) <= c.tolerance, `${label} ${run}: ${result.x} vs ${expected.x}`);
      assert.equal(result.iterations, expected.iterations, `${label} ${run} iterations`);
      assert.equal(stats.queries, expected.queries, `${label} ${run} queries`);
      result.ellipsoid.forEach((row, i) => row.forEach((x, j) => close(x, expected.final[i][j], 1e-4, `${label} ${run} E[${i}][${j}]`)));
    }
    const stats = counters(), descent = gradientDescent(g(stats), vec(c.seed), domain, f(c.stepSize), f(c.tolerance), c.maxIterations, new Random());
    assert.ok(length(minus(descent.x, vec(c.gradientDescent.x))) <= c.tolerance, `${label} SGD: ${descent.x} vs ${c.gradientDescent.x}`);
    assert.equal(descent.iterations, c.gradientDescent.iterations, `${label} SGD iterations`);
    assert.equal(stats.queries, c.gradientDescent.queries, `${label} SGD queries`);
  }
});

test('SDF CPU opt-in gradient-descent stop extends the released path to the gradient or iteration limit', () => {
  let extended = 0;
  for (const c of load('optimizers').cases) {
    const a = new SdfBody(new AnalyticField(specs[c.shapeA]));
    const b = new SdfBody(new AnalyticField(specs[c.shapeB]), vec(c.originB), c.rotationB.map(f) as Rotation);
    const domain = intersection(a.bounds, b.bounds), repel = c.repulsionPoints.map((x: Vec) => ({ x: vec(x) }));
    // Record every queried iterate and its gradient.
    const traced = () => { const g = objectiveGradient(a, b, repel, f(c.epsilon), f(c.alpha), counters()), log: { x: Vec; gradient: Vec }[] = [];
      return { log, g: (x: Vec) => { const r = g(x); log.push({ x, gradient: r.gradient }); return r; } }; };
    const released = traced(), optIn = traced(), label = `${c.shapeA} seed ${c.seed}`;
    const r = gradientDescent(released.g, vec(c.seed), domain, f(c.stepSize), f(c.tolerance), c.maxIterations, new Random());
    const o = gradientDescent(optIn.g, vec(c.seed), domain, f(c.stepSize), f(c.tolerance), c.maxIterations, new Random(), false);
    assert.equal(r.iterations, c.gradientDescent.iterations, `${label} released path unchanged`);
    // Same stream, so the opt-in replays the released iterates, then continues.
    assert.deepEqual(optIn.log.slice(0, released.log.length).map(q => q.x), released.log.map(q => q.x), `${label} prefix`);
    assert.ok(o.iterations >= r.iterations, label);
    const last = optIn.log[optIn.log.length - 1];
    assert.ok(o.iterations === c.maxIterations || length(last.gradient) < f(c.tolerance), `${label}: stopped only on the gradient or the limit`);
    if (o.iterations > r.iterations) extended++;
  }
  assert.ok(extended > 0, 'some released runs stop on the step test');
  // Manifold level: the flag reaches the optimizer, and its absence keeps the released behaviour.
  const run = (extra: Partial<ReturnType<typeof collisionParams>>) => {
    const m = new SdfManifold(new SdfBody(new AnalyticField(specs.box)), new SdfBody(new AnalyticField(specs.box), [.35, .1, 0], [0, 0, f(.258819045), f(.965925826)]));
    const stats = counters(); m.update({ ...collisionParams(), optimizer: 2, ...extra }, 0, new Random(), stats); return stats;
  };
  assert.deepEqual(run({ sgdGradientStopOnly: false }), run({}));
  assert.ok(run({ sgdGradientStopOnly: true }).iterations > run({}).iterations);
});

test('SDF CPU Ellipsoid and gradient-descent manifolds match the oracle across chained warm steps', () => {
  // Fixture points omit each cached ellipsoid, so multi-step cases chain this manifold's own state.
  let m: SdfManifold | undefined, rng = new Random();
  for (const c of load('manifolds-optimizers').cases) {
    const make = (name: string, b: typeof c.bodyA) => {
      const result = new SdfBody(field(name), vec(b.position), b.orientation.map(f) as Rotation, b.scale, b.static);
      result.velocity = vec(b.velocity); result.angularVelocity = vec(b.angularVelocity); return result;
    };
    if (c.step === 0) {
      m = new SdfManifold(make(c.shapeA, c.bodyA), make(c.shapeB, c.bodyB)); rng = new Random();
      rng.state = BigInt(c.rng.before); m.points = c.initialCache.map((p: SdfContact) => ({ ...p, x: vec(p.x), normal: vec(p.normal) }));
    }
    assert.equal(rng.state.toString(), c.rng.before, `${c.name} step ${c.step} RNG before`);
    const params = { ...collisionParams(), ...c.params }, stats = counters();
    for (const key of ['epsilon', 'alpha', 'replacementThreshold', 'tolerance', 'stepSize', 'margin', 'allowedPenetration']) params[key] = f(params[key]);
    m!.update(params, f(c.dt), rng, stats);
    const label = `${c.name} step ${c.step}`;
    assert.equal(rng.state.toString(), c.rng.after, `${label} RNG`);
    assert.equal(m!.points.length, c.points.length, `${label} count`);
    m!.points.forEach((p, i) => {
      const q = c.points[i];
      assert.ok(length(minus(p.x, vec(q.x))) <= c.params.tolerance, `${label} ${i}: ${p.x} vs ${q.x}`);
      assert.equal(p.active, q.active, label); assert.equal(p.cached, q.cached, label);
      p.normal.forEach((x, j) => close(x, q.normal[j], 2e-5, `${label} normal`));
      close(p.depth, q.depth, 2e-5, label); close(p.separation, q.separation, 2e-5, label); close(p.rank, q.rank, 2e-5, label);
    });
    assert.deepEqual(stats, c.stats, label);
  }
});

test('SDF CPU cache updates match oracle contacts, ranking, flags and consumed RNG', () => {
  for (const c of load('manifolds').cases) {
    const make = (name: string, b: typeof c.bodyA) => {
      const result = new SdfBody(field(name), vec(b.position), b.orientation.map(f) as Rotation, b.scale, b.static);
      result.velocity = vec(b.velocity); result.angularVelocity = vec(b.angularVelocity); return result;
    };
    const m = new SdfManifold(make(c.shapeA, c.bodyA), make(c.shapeB, c.bodyB)), rng = new Random(), stats = counters();
    rng.state = BigInt(c.rng.before); m.points = c.initialCache.map((p: SdfContact) => ({ ...p, x: vec(p.x), normal: vec(p.normal) }));
    const params = { ...collisionParams(), ...c.params };
    for (const key of ['epsilon', 'alpha', 'replacementThreshold', 'tolerance', 'stepSize', 'margin', 'allowedPenetration']) params[key] = f(params[key]);
    m.update(params, f(c.dt), rng, stats);
    assert.equal(rng.state.toString(), c.rng.after, `${c.name} RNG`);
    assert.equal(m.points.length, c.points.length, `${c.name} count`);
    m.points.forEach((p, i) => {
      const q = c.points[i];
      assert.ok(length(minus(p.x, vec(q.x))) <= c.params.tolerance, `${c.name} ${i}: ${p.x} vs ${q.x}`);
      assert.equal(p.active, q.active, c.name); assert.equal(p.cached, q.cached, c.name);
      p.normal.forEach((x, j) => close(x, q.normal[j], 2e-5, `${c.name} normal`));
      close(p.depth, q.depth, 2e-5, c.name); close(p.separation, q.separation, 2e-5, c.name); close(p.rank, q.rank, 2e-5, c.name);
    });
    assert.deepEqual(stats, c.stats, c.name);
  }
});


test('SDF CPU voxel interpolation matches all 700 upstream samples and grid hashes', () => {
  const manifest = JSON.parse(readFileSync(new URL('./fixtures/oracle-sdf-grids/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.revision, '1dcdf1e7fa07d16fda15826ad8c2e6697075a76e');
  assert.equal(createHash('sha256').update(readFileSync(new URL('../tools/cpp-oracle-sdf/export-grid.cpp', import.meta.url))).digest('hex'), manifest.driverSha256);
  for (const name of ['bunny', 'gear', 'cow', 'chair']) {
    const raw = gunzipSync(readFileSync(new URL(`./fixtures/oracle-sdf-grids/${name}.bin.gz`, import.meta.url)));
    assert.equal(raw.length, manifest.grids[name].bytes);
    assert.equal(createHash('sha256').update(raw).digest('hex'), manifest.grids[name].sha256);
    const shape = voxel(name);
    for (const sample of load(name).samples) {
      const actual = shape.sample(vec(sample.p)); close(actual.phi, sample.phi, 2e-6, name);
      actual.gradient.forEach((x, i) => close(x, sample.gradient[i], 2e-6, `${name} voxel gradient`));
    }
  }
});

test('SDF voxel sampling handles exact grid boundaries, outside extension and invalid layouts', () => {
  const data = new Float32Array(32);
  for (let i = 0; i < 8; i++) { data[i * 4] = i & 1; data[i * 4 + 1] = 1; }
  const bounds = { min: [0, 0, 0] as Vec, max: [1, 1, 1] as Vec };
  const v = new VoxelField([2, 2, 2], [0, 0, 0], 1, data, bounds);
  for (const x of [0, .25, 1, 2]) close(v.sample([x, .5, .5]).phi, x);
  close(v.sample([-1, .5, .5]).phi, 1);
  assert.throws(() => new VoxelField([1, 2, 2], [0, 0, 0], 1, data, bounds));
  assert.throws(() => new VoxelField([2, 2, 2], [0, 0, 0], 0, data, bounds));
  assert.throws(() => new VoxelField([2, 2, 2], [0, 0, 0], 1, data.subarray(0, 4), bounds));
});

test('SDF direct manifold call culls disjoint bounds without consuming RNG', () => {
  const m = new SdfManifold(new SdfBody(field('box')), new SdfBody(field('box'), [10, 0, 0]));
  const rng = new Random(), before = rng.state, stats = counters();
  m.update(collisionParams(), f(1 / 60), rng, stats);
  assert.equal(m.points.length, 0); assert.equal(rng.state, before); assert.deepEqual(stats, counters());
});


test('SDF CPU AVBD settles voxel gears and a bunny using supplied mass properties', () => {
  for (const name of ['gear', 'bunny']) {
    const solver = new Solver(); solver.iterations = 20; solver.alpha = .95;
    const adapter = new SdfCollisionAdapter(solver), shape = field(name), properties = load(`seeds-${name}`);
    new Rigid(solver, [12, 12, 1], 0, .5, [0, 0, -.5]);
    const bodies = Array.from({ length: name === 'gear' ? 3 : 1 }, (_, i) => {
      const widths = shape.bounds.max.map((x, j) => x - shape.bounds.min[j]);
      const b = new Rigid(solver, widths, 1, .5, [0, 0, .6 + i * .45]);
      b.mass = properties.volume;
      // Rotate local y-up voxel assets into the reference solver's z-up frame.
      b.positionAng.set([Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
      b.moment.set([properties.inertia[0][0], properties.inertia[2][2], properties.inertia[1][1]]);
      adapter.attach(b, shape); return b;
    });
    let peakContacts = 0;
    for (let i = 0; i < 360; i++) { solver.step(); peakContacts = Math.max(peakContacts, adapter.stats.contacts); }
    assert.ok(peakContacts > 0, name);
    for (const body of bodies) {
      assert.ok(Array.from(body.positionLin).every(Number.isFinite), name);
      assert.ok(body.positionLin[2] > 0, `${name} fell through ground`);
      assert.ok(length(vec(body.velocityLin)) < .2, `${name} not settled: ${body.velocityLin}`);
    }
    // Surface seed probe after integration: a lower bound, not Fig. 6's exact experiment.
    let penetration = 0;
    for (const body of bodies) {
      const sdf = new SdfBody(shape, vec(body.positionLin), Array.from(body.positionAng) as Rotation);
      for (const seed of shape.seeds) penetration = Math.max(penetration, -sdf.toWorld(seed)[2]);
    }
    assert.ok(penetration < .05, `${name} sampled floor penetration ${penetration}`);
    adapter.dispose();
  }
});

test('signed static-box projection distinguishes an embedded surface from an unsigned gap', () => {
  const sphere=new AnalyticField({kind:'sphere',radius:.5}); sphere.seeds=[[0,-.51,0]];
  const floor=new AnalyticField({kind:'box',halfExtents:[4,.2,4]}); floor.seeds=[];
  const a=new SdfBody(sphere,[0,.4,0]), b=new SdfBody(floor,[0,-.2,0],[0,0,0,1],1,true);
  const run=(signedSeparation:boolean)=>{
    const manifold=new SdfManifold(a,b);
    manifold.update({...collisionParams(),signedSeparation,maxIterations:1,cacheSize:0,randomSamples:1},0,new Random(),counters());
    return manifold.points[0];
  };
  const legacy=run(false), signed=run(true);
  assert.deepEqual(signed.x,legacy.x,'same optimizer sample');
  assert.ok(a.sample(signed.x).phi>0 && b.sample(signed.x).phi<0,'mixed inside/outside sample');
  assert.ok(legacy.separation>0 && !legacy.active,'unsigned distance misses this contact');
  assert.ok(signed.separation<0 && signed.active,'signed projection detects overlap');
});

/** Constant phi with a tiny downward gradient: real overlap is at most 35 mm, the unguarded projection ~-25 cm. */
const degenerateField=()=>{
  const grid=new Float32Array(3*3*3*4);
  for(let i=0;i<27;i++)grid.set([-.005,0,-.02,0],i*4);
  const field=new VoxelField([3,3,3],[-.05,-.05,-.05],.05,grid,{min:[-.05,-.05,-.05],max:[.05,.05,.05]}); field.seeds=[];
  return field;
};

test('signed static-box projection stays bounded where the moving gradient vanishes', () => {
  const floor=new AnalyticField({kind:'box',halfExtents:[4,.2,4]}); floor.seeds=[];
  const a=new SdfBody(degenerateField(),[0,.02,0]), b=new SdfBody(floor,[0,-.2,0],[0,0,0,1],1,true);
  const rng=new Random(); let mixed=0;
  for(let step=0;step<16;step++){
    const manifold=new SdfManifold(a,b);
    manifold.update({...collisionParams(),signedSeparation:true,maxIterations:1,cacheSize:0,randomSamples:1},0,rng,counters());
    for(const p of manifold.points){
      if(a.sample(p.x).phi<=0&&b.sample(p.x).phi>0)mixed++;
      assert.ok(Number.isFinite(p.separation)&&p.separation>-.05,`bounded separation ${p.separation}`);
    }
  }
  assert.ok(mixed>0,'exercise mixed samples');
});


test('hardmax ablation has a finite midpoint subgradient at equal field values', () => {
  const a=new SdfBody(new AnalyticField({kind:'sphere',radius:1}),[-.5,0,0]);
  const b=new SdfBody(new AnalyticField({kind:'sphere',radius:1}),[.5,0,0]);
  const g=objectiveGradient(a,b,[],0,0,counters());
  assert.equal(g([0,0,0]).value,-.5);
  assert.deepEqual(g([0,0,0]).gradient,[0,0,0]);
  assert.deepEqual(g([.1,0,0]).gradient,[1,0,0]);
  assert.deepEqual(g([-.1,0,0]).gradient,[-1,0,0]);
});
