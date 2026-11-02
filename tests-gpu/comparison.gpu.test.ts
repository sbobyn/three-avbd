import assert from 'node:assert/strict';
import { gpuTest } from './device.ts';
import { createAdapter } from '../src/comparison/adapters.ts';
import { makeScene } from '../src/comparison/scenes.ts';
import { DEFAULTS } from '../src/comparison/run.ts';
import { quality, STATE_SIZE } from '../src/comparison/quality.ts';

gpuTest('comparison GPU adapter maps spatially sorted bodies back to manifest order', async (device) => {
  const scene = makeScene('pile-100');
  const adapter = await createAdapter('avbd', scene, DEFAULTS, device);
  try {
    const state = await adapter.snapshot();
    for (let i = 0; i < scene.bodies.length; i++) {
      const b = scene.bodies[i];
      const expected = [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity];
      expected.forEach((v, k) => assert.ok(Math.abs(state[i * STATE_SIZE + k] - v) < 1e-5));
    }
    for (let i = 0; i < 5; i++) {
      adapter.step();
      await adapter.complete();
      await adapter.inspect();
    }
    assert.equal(quality(scene, await adapter.snapshot()).nonFiniteBodies, 0);
  } finally { adapter.destroy(); }
});

gpuTest('batched comparison reproduces the per-step validation replay', async (device) => {
  const { runOne } = await import('../src/comparison/run.ts');
  const result = await runOne('avbd', makeScene('pile-100'), 0,
    { ...DEFAULTS, lead: 3, steps: 7, batchSize: 3 }, device);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.replayMatches, true);
  assert.equal(result.qualitySamples.length, 10);
  assert.deepEqual(result.sampleSteps, [3, 3, 1]);
});

gpuTest('comparison adapters preserve initial joint anchors and agree on nearest ray distance', async (device) => {
  for (const engine of ['rapier', 'avbd'] as const) {
    const scene = makeScene('rest-stack');
    scene.gravity = 0;
    const adapter = await createAdapter(engine, scene, DEFAULTS, device);
    try {
      adapter.step(); await adapter.complete();
      const hits = await adapter.raycasts!([{ origin: [0, 0, 20], direction: [0, 0, -1], maxDistance: 30 }]);
      assert.ok(Math.abs(hits[0]! - 9.5) < 0.01, `${engine}: ${hits[0]}`);
    } finally { adapter.destroy(); }
    const chain = makeScene('chain-20');
    const jointed = await createAdapter(engine, chain, DEFAULTS, device);
    try {
      for (let i = 0; i < 5; i++) jointed.step();
      await jointed.complete(); await jointed.inspect();
      const { physicalQuality } = await import('../src/comparison/physical-quality.ts');
      const state = await jointed.snapshot();
      assert.ok(physicalQuality(chain, state, state, 0).maxJointError < 0.05);
    } finally { jointed.destroy(); }
  }
});
