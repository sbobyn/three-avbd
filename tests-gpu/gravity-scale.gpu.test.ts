// Per-body gravity scale (STE-3328 first slice; docs/BODY_AUX_DESIGN.md section 8) on a real device:
// free fall in proportion to the scale, the default unchanged, the setter, fixed and kinematic
// bodies, slot reuse, reset and disable, pool templates, fixed storage, SDF collisions, and older
// custom solve modules. Behaviour only: no timing, rendering or physical-accuracy claim.
//
// Tolerances, fixed before any run:
// - free-fall displacement of a scale-s body vs s × the scale-1 body's in the same World:
//   |d_s − s·d_1| <= max(1e-6 m, |s·d_1| × 1e-4);
// - a scale-0 body at rest and a fixed body: no vertical motion at all; a body created without
//   the option vs a scale-1 body with the same history: exactly equal (the same f32 arithmetic on
//   the same inputs); bodies with different histories use the proportional tolerance;
// - velocity along up after a scale goes to 0: within 1e-3 m/s of its value when set.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu, gpuTest, skip } from './device.ts';
import { assessAdapter } from '../src/comparison/interlocking-trial.ts';
import { World, type Body } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { B_POS } from '../src/avbd3d/gpu/layout.ts';
import { solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;
const SCALES = [1, 2, 0, -1];
const STEPS = 60;

const tolerance = (expected: number) => Math.max(1e-6, Math.abs(expected) * 1e-4);
function proportional(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance(expected), `${what}: ${actual} vs ${expected} (tolerance ${tolerance(expected)})`);
}

/** Separated free spheres (no ground, nothing to touch), one per scale; `undefined` leaves the option out. */
function spheres(world: World, scales: (number | undefined)[]): Body[] {
  return scales.map((s, k) => world.addSphere({ radius: 0.25, position: [k * 10, 0, 0], ...(s === undefined ? {} : { gravityScale: s }) })!);
}

async function fall(world: World, bodies: Body[], steps = STEPS): Promise<number[]> {
  await world.read();
  const start = bodies.map((b) => b.position[1]);
  for (let k = 0; k < steps; k++) world.step();
  await world.read();
  return bodies.map((b, i) => b.position[1] - start[i]);
}

function checkFreeFall(d: number[], scales: number[], what: string): void {
  const base = d[scales.indexOf(1)];
  assert.ok(base < -1, `${what}: the scale-1 body falls (${base} m)`);
  scales.forEach((s, i) => {
    if (s === 0) assert.equal(d[i], 0, `${what}: the scale-0 body does not move`);
    else proportional(d[i], s * base, `${what}: scale ${s}`);
  });
}

gpuTest('free fall: displacement in proportion to the scale (1, 2, 0, −1); no option is exactly scale 1', async (device) => {
  const world = await World.create({ device, maxBodies: 8 });
  try {
    assert.equal(world.capabilities.gravityScale, true);
    const bodies = spheres(world, [...SCALES, undefined]);
    const d = await fall(world, bodies);
    checkFreeFall(d.slice(0, 4), SCALES, 'adaptive');
    assert.equal(d[4], d[0], 'a body without the option falls exactly as scale 1');
    assert.equal(bodies[4].gravityScale, 1);
  } finally {
    world.destroy();
  }
});

gpuTest('tiny effective gravity: finite and (nearly) still; numerical exposure, not a guarantee', async (device) => {
  const world = await World.create({ device, maxBodies: 8 });
  try {
    // 1e-6: a normal f32 product; 1e-39: subnormal operand and product (may flush to zero on a GPU)
    const bodies = spheres(world, [1, 1e-6, 1e-39]);
    const d = await fall(world, bodies);
    assert.ok(d.every(Number.isFinite), `finite: ${d}`);
    proportional(d[1], 1e-6 * d[0], 'scale 1e-6');
    assert.ok(Math.abs(d[2]) <= 1e-6, `scale 1e-39: ${d[2]}`);
    assert.ok(bodies.every((b) => b.velocity.every(Number.isFinite) && b.position.every(Number.isFinite)));
  } finally {
    world.destroy();
  }
});

gpuTest('setter 1 → 0: velocity along up stops changing from the next step; the control keeps falling', async (device) => {
  const world = await World.create({ device, maxBodies: 4 });
  try {
    const [a, control] = spheres(world, [1, 1]);
    for (let k = 0; k < 30; k++) world.step();
    await world.read();
    const v0 = a.velocity[1];
    const c0 = control.velocity[1];
    assert.ok(v0 < -1, `it was falling: ${v0}`);
    a.setGravityScale(0);
    assert.equal(a.gravityScale, 0);
    for (let k = 0; k < 30; k++) world.step();
    await world.read();
    assert.ok(Math.abs(a.velocity[1] - v0) <= 1e-3, `velocity ${a.velocity[1]} vs ${v0} when set`);
    assert.ok(control.velocity[1] < c0 - 4, `the control kept accelerating: ${control.velocity[1]}`);
  } finally {
    world.destroy();
  }
});

gpuTest('fixed and kinematic bodies keep their scale and do not fall', async (device) => {
  const world = await World.create({ device, maxBodies: 4 });
  try {
    const fixed = world.addBox({ size: [1, 1, 1], position: [0, 0, 0], fixed: true, gravityScale: 2 })!;
    const mover = world.addBox({ size: [1, 1, 1], position: [10, 0, 0], fixed: true, gravityScale: -5, velocity: [1, 0, 0] })!;
    const control = world.addSphere({ radius: 0.25, position: [20, 0, 0] })!;
    const d = await fall(world, [fixed, mover, control], 30);
    assert.equal(d[0], 0, 'fixed body');
    assert.equal(d[1], 0, 'kinematic body: no vertical motion');
    assert.ok(d[2] < -1, 'the control falls');
    assert.deepEqual([fixed.gravityScale, mover.gravityScale, fixed.fixed, mover.fixed], [2, -5, true, true]);
  } finally {
    world.destroy();
  }
});

gpuTest('slot reuse: a default body in a removed scale-0 body’s slot falls as scale 1', async (device) => {
  const world = await World.create({ device, maxBodies: 4 });
  try {
    const [still, control] = spheres(world, [0, 1]);
    for (let k = 0; k < 5; k++) world.step();
    const index = still.index;
    still.remove();
    world.step();
    const reused = world.addSphere({ radius: 0.25, position: [30, 0, 0] })!;
    assert.equal(reused.index, index, 'the same slot');
    control.set({ position: [40, 0, 0], velocity: [0, 0, 0] });
    const d = await fall(world, [reused, control], 30);
    // (Their histories differ, so the proportional tolerance, not exact equality)
    proportional(d[0], d[1], 'falls as the scale-1 control');
    assert.ok(d[1] < -1);
  } finally {
    world.destroy();
  }
});

gpuTest('reset and disable keep the scale', async (device) => {
  const world = await World.create({ device, maxBodies: 4 });
  try {
    const [still, control] = spheres(world, [0, 1]);
    for (let k = 0; k < 5; k++) world.step();
    still.reset({ position: [0, 0, 0], velocity: [0, 0, 0] });
    control.reset({ position: [10, 0, 0], velocity: [0, 0, 0] });
    still.setEnabled(false);
    world.step();
    still.setEnabled(true);
    world.step();
    await world.read();
    assert.equal(still.gravityScale, 0);
    const d = await fall(world, [still, control], 30);
    assert.equal(d[0], 0, 'the scale-0 body stays put after reset and re-enable');
    assert.ok(d[1] < -1);
  } finally {
    world.destroy();
  }
});

gpuTest('pool: each lease starts with the template’s scale, not the previous lease’s', async (device) => {
  const world = await World.create({ device, maxBodies: 4, storage: FIXED });
  try {
    const made = await BodyPool.create(world, { capacity: 1, template: { kind: 'sphere', options: { radius: 0.25, gravityScale: 0 } } });
    assert.ok(made.ok);
    const at = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] };
    const first = (made.pool.tryAcquire(at) as { body: Body }).body;
    first.setGravityScale(1);
    for (let k = 0; k < 10; k++) world.step();
    await world.read();
    assert.ok(first.position[1] < -0.1, 'the first lease fell after its setter');
    made.pool.release(first);
    const second = (made.pool.tryAcquire(at) as { body: Body }).body;
    assert.equal(second.index, first.index);
    assert.equal(second.gravityScale, 0);
    const d = await fall(world, [second], 30);
    assert.equal(d[0], 0, 'the new lease does not fall');
    made.pool.dispose();
  } finally {
    world.destroy();
  }
});

gpuTest('fixed storage: free fall in proportion to the scale', async (device) => {
  const world = await World.create({ device, maxBodies: 8, storage: FIXED });
  try {
    assert.equal(world.capabilities.gravityScale, true);
    checkFreeFall(await fall(world, spheres(world, SCALES)), SCALES, 'fixed');
  } finally {
    world.destroy();
  }
});

gpuTest('SDF collisions: free fall in proportion to the scale', async (device) => {
  const world = await World.create({ device, maxBodies: 8 });
  try {
    const bodies = spheres(world, SCALES);
    await world.enableSdfCollisions([], { cacheSize: 1, randomSamples: 0 });
    assert.equal(world.capabilities.backend, 'sdf');
    assert.equal(world.capabilities.gravityScale, true);
    checkFreeFall(await fall(world, bodies), SCALES, 'sdf');
    // The setter under SDF: velocity along up stops changing
    await world.read();
    const v = bodies[0].velocity[1];
    bodies[0].setGravityScale(0);
    for (let k = 0; k < 10; k++) world.step();
    await world.read();
    assert.ok(Math.abs(bodies[0].velocity[1] - v) <= 1e-3, `setter under SDF: ${bodies[0].velocity[1]} vs ${v}`);
  } finally {
    world.destroy();
  }
});

/** solveWGSL before the aux record (an older custom module). */
const oldSolve = solveWGSL.replace(/@group\(0\) @binding\(9\) var<storage, read> bodyAux: array<vec4f>;\n/, '').replace(' * bodyAux[i].x;', ';');

gpuTest('custom solve modules: older and current-derived modules construct and fall by default; aux writes are refused', async (device) => {
  assert.ok(!oldSolve.includes('bodyAux'));
  for (const solve of [oldSolve, solveWGSL + '\n// var<storage, read> bodyAux: array<vec4f>;']) {
    const ref = new Solver();
    new Rigid(ref, [0.5, 0.5, 0.5], 1, 0.5, [0, 0, 0]);
    device.pushErrorScope('validation');
    const gpu = new GpuSolver3D(device, ref, { shaders: { solve } });
    try {
      for (let k = 0; k < STEPS; k++) gpu.step();
      const error = await device.popErrorScope();
      assert.equal(error, null, `no validation error: ${error?.message}`);
      const position = (await gpu.readBodies()).slice(B_POS, B_POS + 3);
      const alongUp = position.reduce((sum, v, i) => sum + v * gpu.params.up[i], 0);
      assert.ok(alongUp < -1, `default gravity applies along reference up ${gpu.params.up}: ${position}`);
      assert.equal(gpu.supportsBodyAux, false);
      assert.throws(() => gpu.setBodyAux([0], [0]), /built-in solve shaders/);
    } finally {
      gpu.destroy();
    }
  }
});

// A device at the WebGPU default of eight storage buffers per stage (no hulls), on its own Dawn
// instance and adapter, destroyed at the end
test('default-limit device: the integrate pipeline validates and free fall is proportional', { skip }, async () => {
  const adapter = await createGpu().requestAdapter();
  assert.ok(adapter);
  const assessment = assessAdapter(adapter.info, (adapter as GPUAdapter & { readonly isFallbackAdapter?: boolean }).isFallbackAdapter);
  assert.equal(assessment.ok, true, 'the separate default-limit adapter must be hardware-qualified');
  const device = await adapter.requestDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  try {
    assert.equal(device.limits.maxStorageBuffersPerShaderStage, 8);
    device.pushErrorScope('validation');
    const world = await World.create({ device, maxBodies: 8 });
    try {
      assert.equal(world.hullsEnabled, false);
      const d = await fall(world, spheres(world, SCALES));
      const error = await device.popErrorScope();
      assert.equal(error, null, `no validation error: ${error?.message}`);
      checkFreeFall(d, SCALES, 'default limits');
    } finally {
      world.destroy();
    }
    await device.queue.onSubmittedWorkDone();
    assert.deepEqual(errors, [], 'uncaptured GPU errors');
  } finally {
    device.destroy();
  }
});

gpuTest('gravity-scale capability follows the built-in integrator with a custom collision backend', async (device) => {
  const world = await World.create({ device, maxBodies: 8 });
  try {
    const bodies = spheres(world, SCALES);
    world.solver.setCollisionBackend({ prepare() {}, encode() {}, destroy() {} });
    assert.equal(world.capabilities.backend, 'custom');
    assert.equal(world.capabilities.gravityScale, true);
    assert.equal(world.capabilities.hullCollisions, 'unknown');
    checkFreeFall(await fall(world, bodies), SCALES, 'custom collision backend');
  } finally { world.destroy(); }
});
