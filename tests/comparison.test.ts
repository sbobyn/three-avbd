import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeScene, referenceFromScene, sceneHash } from '../src/comparison/scenes.ts';
import { percentile, quality, STATE_SIZE } from '../src/comparison/quality.ts';
import { createAdapter } from '../src/comparison/adapters.ts';
import { DEFAULTS, validateOptions } from '../src/comparison/run.ts';

test('comparison manifests preserve existing scene mass, poses and sphere identity', () => {
  for (const name of ['pile-100', 'ring-9k']) {
    const scene = makeScene(name);
    assert.equal(sceneHash(scene), sceneHash(makeScene(name)));
    const ref = referenceFromScene(scene, 1 / 60, 4);
    ref.bodies.forEach((b, i) => {
      assert.equal(b.mass, scene.bodies[i].mass);
      assert.deepEqual([...b.moment], scene.bodies[i].inertia);
      assert.deepEqual([...b.positionAng], scene.bodies[i].rotation);
    });
    if (name === 'ring-9k') assert.equal(scene.bodies.filter((b) => b.shape === 'sphere').length, 1);
  }
  assert.equal(makeScene('pile-100').bodies.length, 101);
  assert.throws(() => makeScene('typo'));
});

test('floor quality uses rotated box extent and flags non-finite state', () => {
  const scene = makeScene('pile-100');
  scene.bodies = [scene.bodies[0], { ...scene.bodies[1], size: [2, 1, 1] }];
  const state = new Float64Array(2 * STATE_SIZE);
  // Turn the long x axis upright; bottom is 0.4 against a floor at 0.5.
  state.set([0, 0, 1.4, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 0, 0, 0, 0, 0, 0], STATE_SIZE);
  assert.ok(Math.abs(quality(scene, state).maxFloorPenetration - 0.1) < 1e-12);
  state[STATE_SIZE] = NaN;
  assert.equal(quality(scene, state).nonFiniteBodies, 1);
  assert.equal(percentile([10, 1, 3, 2], 0.5), 2);
  assert.throws(() => validateOptions({ ...DEFAULTS, steps: NaN }));
  assert.throws(() => validateOptions({ ...DEFAULTS, repeats: 0 }));
});

test('pinned Rapier adapter preserves poses and steps the shared scene', async () => {
  const scene = makeScene('pile-100');
  // Rapier does not access the GPU device argument.
  const adapter = await createAdapter('rapier', scene, DEFAULTS, null as unknown as GPUDevice);
  try {
    const initial = await adapter.snapshot();
    scene.bodies.forEach((b, i) => b.position.forEach((v, k) =>
      assert.ok(Math.abs(initial[i * STATE_SIZE + k] - v) < 1e-5)));
    for (let i = 0; i < 10; i++) adapter.step();
    const after = await adapter.snapshot();
    assert.equal(quality(scene, after).nonFiniteBodies, 0);
    assert.ok(after[STATE_SIZE + 2] < initial[STATE_SIZE + 2]);
  } finally { adapter.destroy(); }
});

test('floor diagnostics separate spheres, normalize depth and reject lost coverage', () => {
  const scene = makeScene('pile-100');
  scene.bodies = [scene.bodies[0], { ...scene.bodies[1], shape: 'sphere', size: [2, 2, 2] }];
  const state = new Float64Array(2 * STATE_SIZE);
  state.set([0, 0, 1.4, 0, 0, 0, 1], STATE_SIZE);
  const q = quality(scene, state);
  assert.ok(Math.abs(q.maxSphereFloorPenetration - 0.1) < 1e-12);
  assert.ok(Math.abs(q.maxRelativeFloorPenetration - 0.05) < 1e-12);
  assert.equal(q.maxBoxFloorPenetration, 0);
  assert.equal(q.worstBody, 1);
  state[STATE_SIZE] = 10000;
  assert.equal(quality(scene, state).outsideFloorBodies, 1);
  assert.equal(quality(scene, state).maxFloorPenetration, 0);
});

test('batched timing validates every replay step and rejects transient faults', async () => {
  const { runOne } = await import('../src/comparison/run.ts');
  const scene = makeScene('pile-100');
  const batches: number[][] = [];
  let inspections = 0;
  let fault = false;
  const factory: typeof createAdapter = async () => {
    const calls: number[] = []; batches.push(calls);
    let step = 0, pending = 0;
    return {
      settings: {},
      step() { step++; pending++; },
      async complete() { if (pending) calls.push(pending); pending = 0; },
      async inspect() { inspections++; if (fault && step === 2) throw new Error('transient overflow'); return {}; },
      async snapshot() {
        return Float64Array.from(scene.bodies.flatMap((b) =>
          [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
      },
      destroy() {},
    };
  };
  const opts = { ...DEFAULTS, lead: 3, steps: 5, batchSize: 2 };
  const result = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(batches[0], [2, 1, 2, 2, 1]);
  assert.deepEqual(result.sampleSteps, [2, 2, 1]);
  assert.equal(inspections, 8);
  assert.equal(result.qualitySamples.length, 8);
  assert.equal(result.replayMatches, true);
  assert.equal(result.meanMs, result.samplesMs.reduce((s, v, i) => s + v * result.sampleSteps[i], 0) / 5);
  fault = true;
  const failed = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /transient overflow/);
  assert.equal(failed.meanMs, undefined);
});

test('box floor depth agrees with independently transformed vertices', () => {
  const scene = makeScene('pile-100');
  scene.bodies = [scene.bodies[0], { ...scene.bodies[1], size: [2, 3, 4] }];
  for (const angle of [0.1, 0.8, 1.7, 2.9]) {
    const x = Math.sin(angle / 2) / Math.sqrt(14), y = 2 * x, z = 3 * x, w = Math.cos(angle / 2);
    let bottom = Infinity;
    for (const vx of [-1, 1]) for (const vy of [-1.5, 1.5]) for (const vz of [-2, 2]) {
      bottom = Math.min(bottom, 2 * (x * z - w * y) * vx + 2 * (y * z + w * x) * vy +
        (1 - 2 * (x * x + y * y)) * vz + 2);
    }
    const state = new Float64Array(2 * STATE_SIZE);
    state.set([0, 0, 2, x, y, z, w], STATE_SIZE);
    assert.ok(Math.abs(quality(scene, state).maxFloorPenetration - Math.max(0, scene.groundTop - bottom)) < 1e-12);
  }
});

test('independent OBB penetration covers separation, touching, rotation and containment', async () => {
  const { boxDepth, contactQuality } = await import('../src/comparison/contact-quality.ts');
  const q = [0, 0, 0, 1], origin = [0, 0, 0], size = [1, 1, 1];
  assert.equal(boxDepth(origin, q, size, [2, 0, 0], q, size), 0);
  assert.equal(boxDepth(origin, q, size, [1, 0, 0], q, size), 0);
  assert.equal(boxDepth(origin, q, size, [0.75, 0, 0], q, size), 0.25);
  assert.equal(boxDepth(origin, q, [4, 4, 4], origin, q, size), 2.5);
  const turn = [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)];
  assert.ok(Math.abs(boxDepth(origin, q, size, [1, 0, 0], turn, size) - (Math.SQRT1_2 - 0.5)) < 1e-12);
  const scene = makeScene('rest-stack');
  const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  assert.equal(contactQuality(scene, state)!.maxDepth, 0);
  state[2 * STATE_SIZE + 2] -= 0.2;
  assert.ok(Math.abs(contactQuality(scene, state)!.maxDepth - 0.2) < 1e-12);
  assert.deepEqual(contactQuality(scene, state)!.worstPair, [1, 2]);
  assert.equal(contactQuality(makeScene('pile-1k'), new Float64Array(1001 * STATE_SIZE)), null); // invalid rotations
});

test('resting target excludes lead-in transients but checks drift across the measured window', async () => {
  const { runOne } = await import('../src/comparison/run.ts');
  const scene = makeScene('rest-stack');
  let drift = 0.005;
  const factory: typeof createAdapter = async () => {
    let step = 0;
    return {
      settings: {}, step() { step++; }, async complete() {}, async inspect() { return {}; },
      async snapshot() {
        const state = Float64Array.from(scene.bodies.flatMap(b =>
          [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
        if (step === 1) state[STATE_SIZE + 2] -= 0.1;
        if (step > 2) state[10 * STATE_SIZE] += drift;
        return state;
      }, destroy() {},
    };
  };
  const opts = { ...DEFAULTS, lead: 2, steps: 10, dt: 1 };
  const r = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(r.status, 'completed');
  assert.equal(r.contactTargetMet, false);
  assert.equal(r.measuredContactTargetMet, true);
  assert.equal(r.restingTargetMet, true);
  assert.equal(r.measuredMaxRelativeDrift, drift);
  drift = 0.02;
  const failing = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(failing.measuredContactTargetMet, true);
  assert.equal(failing.restingTargetMet, false);
});

test('mixed-shape depths cover external, contained and rotated sphere contacts', async () => {
  const { sphereBoxDepth, contactQuality } = await import('../src/comparison/contact-quality.ts');
  const origin = [0, 0, 0], q = [0, 0, 0, 1];
  assert.equal(sphereBoxDepth([1.25, 0, 0], 0.5, origin, q, [2, 2, 2]), 0.25);
  assert.equal(sphereBoxDepth(origin, 0.5, origin, q, [2, 2, 2]), 1.5);
  assert.equal(sphereBoxDepth([2, 2, 0], 0.5, origin, q, [2, 2, 2]), 0);
  const turn = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  assert.ok(Math.abs(sphereBoxDepth([0, 2.25, 0], 0.5, origin, turn, [4, 2, 2]) - 0.25) < 1e-12);
  const scene = makeScene('rest-stack');
  scene.bodies = [scene.bodies[0], ...[0, 1.5].map(x => ({
    ...scene.bodies[1], shape: 'sphere' as const, size: [2, 2, 2], position: [x, 0, 3],
  }))];
  const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  assert.equal(contactQuality(scene, state)!.maxDepth, 0.5);
});

test('swept mixed-shape candidates agree with exhaustive pairs above the former size cap', async () => {
  const { sphereBoxDepth, boxDepth, contactQuality } = await import('../src/comparison/contact-quality.ts');
  const scene = makeScene('pile-1k');
  scene.bodies = scene.bodies.slice(0, 301);
  let seed = 321;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  scene.bodies.slice(1).forEach((b, i) => {
    b.position = [random() * 12, random() * 8, random() * 10];
    if (i % 3 === 0) { b.shape = 'sphere'; b.size = [0.8, 0.8, 0.8]; }
  });
  const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  let expected = 0, relative = 0;
  for (let i = 1; i < scene.bodies.length; i++) for (let j = i + 1; j < scene.bodies.length; j++) {
    const a = scene.bodies[i], b = scene.bodies[j];
    let depth;
    if (a.shape === 'sphere' && b.shape === 'sphere') depth = Math.max(0, (a.size[0] + b.size[0]) / 2 -
      Math.hypot(...a.position.map((v, k) => v - b.position[k])));
    else if (a.shape === 'sphere') depth = sphereBoxDepth(a.position, a.size[0] / 2, b.position, b.rotation, b.size);
    else if (b.shape === 'sphere') depth = sphereBoxDepth(b.position, b.size[0] / 2, a.position, a.rotation, a.size);
    else depth = boxDepth(a.position, a.rotation, a.size, b.position, b.rotation, b.size);
    expected = Math.max(expected, depth);
    relative = Math.max(relative, depth / Math.min(...a.size, ...b.size));
  }
  const actual = contactQuality(scene, state)!;
  assert.ok(Math.abs(actual.maxDepth - expected) < 1e-12);
  assert.ok(Math.abs(actual.maxRelativeDepth - relative) < 1e-12);
  assert.ok(actual.candidatePairs < 1000);
});

test('isolated impact scenes vary mass only and begin separated without external forces', async () => {
  const { contactQuality } = await import('../src/comparison/contact-quality.ts');
  for (const ratio of [1, 100, 1000]) {
    const scene = makeScene('impact-' + ratio);
    assert.equal(scene.bodies.length, 3);
    assert.equal(scene.gravity, 0);
    const [, brick, projectile] = scene.bodies;
    assert.ok(Math.abs(projectile.mass / brick.mass - ratio) < 1e-10);
    assert.ok(projectile.inertia.every(v => Math.abs(v - 0.4 * projectile.mass * 16) < 1e-10));
    assert.equal(projectile.shape, 'sphere');
    assert.deepEqual(projectile.velocity, [0, 30, 0]);
    assert.ok(scene.bodies.every(b => b.friction === 0));
    const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
    assert.equal(contactQuality(scene, state)!.maxDepth, 0);
    // Radius 4 and brick half-width 0.25: first geometric contact after 1.75/30 seconds.
    assert.equal(brick.position[1] - 0.25 - (projectile.position[1] + 4), 1.75);
  }
});

test('impact phase changes the recorded initial gap and invalid phase values are rejected', () => {
  const base = makeScene('impact-100');
  const shifted = makeScene('impact-100', 30 * (1 / 240) * 0.5);
  assert.equal(shifted.bodies[2].position[1] - base.bodies[2].position[1], -0.0625);
  assert.notEqual(sceneHash(base), sceneHash(shifted));
  assert.throws(() => validateOptions({ ...DEFAULTS, impactPhase: -0.1 }));
  assert.throws(() => validateOptions({ ...DEFAULTS, impactPhase: 1 }));
  assert.throws(() => validateOptions({ ...DEFAULTS, impactPhase: NaN }));
});

test('edge-case manifests isolate a clear grazing path and an angular-only impact', async () => {
  const { contactQuality } = await import('../src/comparison/contact-quality.ts');
  const graze = makeScene('impact-graze');
  const [, box, ball] = graze.bodies;
  // Constant x separates the entire trajectory from the box's rounded boundary.
  assert.ok(Math.abs(ball.position[0] - box.position[0]) - (box.size[0] + ball.size[0]) / 2 > 0.0099);
  assert.equal(ball.velocity[0], 0);
  assert.equal(box.mass, 0);
  const rotate = makeScene('impact-rotate');
  assert.ok(rotate.bodies.every(b => b.velocity.every(v => v === 0)));
  const state = Float64Array.from(rotate.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  assert.equal(contactQuality(rotate, state)!.maxDepth, 0);
  // At 45 degrees the blade passes through the sphere center; the intended
  // swept-contact challenge exists independently of either engine's integrator.
  state[STATE_SIZE + 5] = Math.sin(Math.PI / 8);
  state[STATE_SIZE + 6] = Math.cos(Math.PI / 8);
  assert.ok(Math.abs(contactQuality(rotate, state)!.maxDepth - 0.3) < 1e-10);
});

test('physical diagnostics recover analytic motion, joint error and spin energy', async () => {
  const { physicalQuality, invariants } = await import('../src/comparison/physical-quality.ts');
  const stateOf = (scene: ReturnType<typeof makeScene>) => Float64Array.from(scene.bodies.flatMap(b =>
    [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  const falling = makeScene('free-fall');
  const initial = stateOf(falling), end = initial.slice();
  end[STATE_SIZE + 2] -= 5; end[STATE_SIZE + 9] = -10;
  assert.equal(physicalQuality(falling, initial, end, 1).trajectoryError, 0);
  assert.equal(physicalQuality(falling, initial, end, 1).velocityError, 0);
  assert.equal(invariants(falling, initial).energy, invariants(falling, end).energy);
  const chain = makeScene('chain-heavy'), chainState = stateOf(chain);
  assert.ok(physicalQuality(chain, chainState, chainState, 0).maxJointError < 1e-12);
  chainState[2 * STATE_SIZE] += 0.1;
  assert.ok(Math.abs(physicalQuality(chain, chainState, chainState, 0).maxJointError - 0.1) < 1e-12);
  assert.equal(referenceFromScene(chain, 1 / 60, 4).forces.length, 40);
  const spinning = makeScene('spin'), spin = stateOf(spinning), rotated = spin.slice();
  rotated[STATE_SIZE + 5] = Math.sin(1); rotated[STATE_SIZE + 6] = Math.cos(1);
  assert.ok(physicalQuality(spinning, spin, rotated, 1).angularError! < 1e-7);
  assert.ok(Math.abs(invariants(spinning, spin).energy - 1 / 3) < 1e-12);
  const slide = makeScene('slide'), sliding = stateOf(slide), stopped = sliding.slice();
  stopped[STATE_SIZE] = 2.5; stopped[STATE_SIZE + 7] = 0;
  assert.equal(physicalQuality(slide, sliding, stopped, 2).trajectoryError, 0);
});

test('every rest/pile scene marked valid starts with zero overlapping pairs and nothing in the floor', async () => {
  const { contactQuality } = await import('../src/comparison/contact-quality.ts');
  const { CASES, SCENE_VALIDITY } = await import('../src/comparison/scenes.ts');
  const stateOf = (scene: ReturnType<typeof makeScene>) => Float64Array.from(scene.bodies.flatMap(b =>
    [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
  const valid = CASES.filter(name => SCENE_VALIDITY[name]?.status === 'valid');
  assert.deepEqual(valid, ['rest-grid-100', 'rest-grid-1k', 'rest-grid-10k', 'sphere-pile-hcp-100', 'rest-stack',
    'pile-1k-settled', 'pile-10k-settled']);
  for (const name of valid) {
    const scene = makeScene(name);
    const state = stateOf(scene);
    // Touching is allowed (exact lattice contacts round to ~1e-16 m); any overlap is not.
    assert.ok(contactQuality(scene, state)!.maxDepth <= 1e-9, `${name} starts with overlapping pairs`);
    assert.equal(quality(scene, state).maxFloorPenetration, 0, `${name} starts in the floor`);
    assert.equal(quality(scene, state).outsideFloorBodies, 0, name);
  }
  // The labels on the kept scenes describe what they are.
  assert.ok(contactQuality(makeScene('pile-1k'), stateOf(makeScene('pile-1k')))!.maxDepth > 0.05);
  const hcp = makeScene('sphere-pile-hcp-100');
  assert.equal(hcp.bodies.filter(b => b.shape === 'sphere').length, 100);
  assert.equal(hcp.bodies.filter(b => b.mass === 0).length, 4);
});

test('jitter moves dynamic bodies horizontally within the bound, reproducibly by seed', async () => {
  const { jitterScene } = await import('../src/comparison/scenes.ts');
  const base = makeScene('sphere-pile-100');
  const a = jitterScene(base, 0.001, 7), b = jitterScene(base, 0.001, 7), c = jitterScene(base, 0.001, 8);
  assert.equal(sceneHash(a), sceneHash(b));
  assert.notEqual(sceneHash(a), sceneHash(c));
  assert.equal(jitterScene(base, 0), base);
  a.bodies.forEach((body, i) => {
    const d = body.position.map((v, k) => v - base.bodies[i].position[k]);
    if (!body.mass) assert.deepEqual(d, [0, 0, 0]);
    else assert.ok(Math.abs(d[0]) <= 0.001 && Math.abs(d[1]) <= 0.001 && d[2] === 0 && Math.hypot(d[0], d[1]) > 0);
  });
  assert.throws(() => validateOptions({ ...DEFAULTS, jitter: -1 }));
  assert.throws(() => validateOptions({ ...DEFAULTS, avbdMargin: NaN }));
});
