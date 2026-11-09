import assert from 'node:assert/strict';
import { B_POS, BODY_FLOATS, REST_SPEED } from '../src/avbd3d/gpu/layout.ts';
import { GpuSolver3D, gpuParams3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { createAdapter } from '../src/comparison/adapters.ts';
import { STATE_SIZE } from '../src/comparison/quality.ts';
import { DEFAULTS } from '../src/comparison/run.ts';
import { makeScene } from '../src/comparison/scenes.ts';
import { gpuTest } from './device.ts';

gpuTest('startAtRest gates only slow dynamic initial guesses', async device => {
  assert.equal(gpuParams3D().startAtRest, true);
  for (const startAtRest of [false, true]) {
    const reference = new Solver();
    const slow = new Rigid(reference, [1, 1, 1], 1, 0.5, [0, 0, 5], [REST_SPEED / 2, 0, 0]);
    new Rigid(reference, [1, 1, 1], 1, 0.5, [3, 0, 5], [REST_SPEED * 2, 0, 0]);
    const spinning = new Rigid(reference, [1, 1, 1], 1, 0.5, [6, 0, 5], [REST_SPEED / 2, 0, 0]);
    spinning.velocityAng.set([0, 0, 1]);
    new Rigid(reference, [1, 1, 1], 0, 0.5, [9, 0, 5], [REST_SPEED / 2, 0, 0]);
    const solver = new GpuSolver3D(device, reference, { spatialSort: false });
    Object.assign(solver.params, { iterations: 0, gravity: 0, startAtRest });
    try {
      solver.step();
      const state = await solver.readBodies();
      const position = (index: number) => state[index * BODY_FLOATS + B_POS];
      const dx = slow.velocityLin[0] * solver.params.dt;
      assert.ok(Math.abs(position(0) - (startAtRest ? 0 : dx)) < 1e-6);
      assert.ok(Math.abs(position(1) - (3 + REST_SPEED * 2 * solver.params.dt)) < 1e-6);
      assert.ok(Math.abs(position(2) - (6 + dx)) < 1e-6, 'angular speed excludes a body from the rest heuristic');
      assert.ok(Math.abs(position(3) - (9 + dx)) < 1e-6, 'kinematic motion is not suppressed');
      solver.params.startAtRest = !startAtRest;
      solver.step();
      assert.ok((await solver.readBodies()).every(Number.isFinite));
      assert.equal((await solver.readCounters()).overflow, 0);
    } finally {
      solver.destroy();
    }
  }
});

for (const avbdIterations of [4, 10]) {
  gpuTest(`comparison startAtRest on/off reaches the GPU and report at ${avbdIterations} iterations`, async device => {
    for (const avbdStartAtRest of [false, true]) {
      const scene = makeScene('rest-stack');
      scene.bodies = scene.bodies.slice(0, 2);
      const adapter = await createAdapter('avbd', scene, { ...DEFAULTS, avbdIterations, avbdStartAtRest }, device);
      try {
        const settings = adapter.settings as { params: { startAtRest: boolean; iterations: number } };
        assert.equal(settings.params.startAtRest, avbdStartAtRest);
        assert.equal(settings.params.iterations, avbdIterations);
        for (let step = 0; step < 8; step++) {
          adapter.step();
          await adapter.inspect();
        }
        const state = await adapter.snapshot();
        assert.equal(state.length, scene.bodies.length * STATE_SIZE);
        assert.ok(state.every(Number.isFinite));
      } finally {
        adapter.destroy();
      }
    }
  });
}
