// Per-body velocity damping (STE-3328, second slice of the body-aux record; docs/BODY_AUX_DESIGN.md)
// on a real device: exponential decay of a free sphere's linear and angular speeds at two step
// sizes, the two rates independent, the default unchanged, fixed and kinematic bodies undamped,
// the setter, reset and disable, slot reuse, pool templates, fixed storage, SDF collisions, the
// default eight-storage-buffer device and custom solve modules. Behaviour only: no timing,
// rendering, stability or physical-accuracy claim. Damping is phenomenological, not a drag model.
//
// Tolerances, fixed before any run:
// - a free sphere (world gravity 0, nothing to touch), v0 = 2 m/s linear, w0 = 0.5 rad/s about a
//   principal axis, rate 1/s, 2 s at dt 1/60 and 1/240: each speed within 1 % of v0·exp(−rate·t)
//   at every 0.5 s sample, and the final speeds at the two step sizes within 2 % of each other;
// - the undamped component of a body damped on the other one: within 1e-4 relative of the
//   undamped control's same speed (not exact: a taken branch is different f32 arithmetic);
// - the undamped control: linear speed within 1e-4 of v0; angular speed within 1 % of w0
//   (rotation integration, normalize(q + ½ωq dt) then back, is not exactly speed-preserving);
// - setter/reset/reuse/pool cases: a damped speed within 1 % of its analytic decay over the
//   interval, an undamped one within 1e-4 relative of its start;
// - a body without the option vs an explicit {0, 0} with the same history: exactly equal (the
//   same record, no branch taken);
// - fixed and kinematic bodies with damping: exactly the motion of the same body without it.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu, gpuTest, skip } from './device.ts';
import { assessAdapter } from '../src/comparison/interlocking-trial.ts';
import { World, type Body, type BodyOptions } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;
const V0 = 2;
const W0 = 0.5;
const RATE = 1;
const DURATION = 2;
const SAMPLE = 0.5;

const speed = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
function within(actual: number, expected: number, relative: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * relative, `${what}: ${actual} vs ${expected} (relative tolerance ${relative})`);
}

/** Separated free spheres moving along x and spinning about y; `undefined` leaves the option out. */
function spinners(world: World, damping: (BodyOptions['damping'] | undefined)[], extra: BodyOptions = {}): Body[] {
  return damping.map((d, k) => world.addSphere({
    radius: 0.25, position: [0, k * 10, 0], velocity: [V0, 0, 0], angularVelocity: [0, W0, 0],
    ...extra, ...(d === undefined ? {} : { damping: d }),
  })!);
}

async function run(world: World, seconds: number): Promise<void> {
  const steps = Math.round(seconds / world.dt);
  for (let k = 0; k < steps; k++) world.step();
  await world.read();
}

/** Linear and angular speeds of each body at every sample time, from t = SAMPLE to DURATION. */
async function decay(world: World, bodies: Body[]): Promise<{ t: number; v: number[]; w: number[] }[]> {
  await world.read();
  const out: { t: number; v: number[]; w: number[] }[] = [];
  for (let t = SAMPLE; t <= DURATION + 1e-9; t += SAMPLE) {
    await run(world, SAMPLE);
    out.push({ t, v: bodies.map((b) => speed(b.velocity)), w: bodies.map((b) => speed(b.angularVelocity)) });
  }
  return out;
}

async function freeWorld(device: GPUDevice, dt: number, options: Partial<Parameters<typeof World.create>[0]> = {}): Promise<World> {
  const world = await World.create({ device, maxBodies: 8, ...options });
  world.gravity = [0, 0, 0];
  world.dt = dt;
  return world;
}

/** Damped (both), linear only, angular only, undamped control, unset: the acceptance checks. */
function checkDecay(samples: Awaited<ReturnType<typeof decay>>, what: string): void {
  for (const { t, v, w } of samples) {
    const e = Math.exp(-RATE * t);
    within(v[0], V0 * e, 0.01, `${what} t=${t}: damped linear speed`);
    within(w[0], W0 * e, 0.01, `${what} t=${t}: damped angular speed`);
    within(v[1], V0 * e, 0.01, `${what} t=${t}: linear-only linear speed`);
    within(w[2], W0 * e, 0.01, `${what} t=${t}: angular-only angular speed`);
    // Independence: the undamped component follows the undamped control
    within(w[1], w[3], 1e-4, `${what} t=${t}: linear-only keeps its angular speed`);
    within(v[2], v[3], 1e-4, `${what} t=${t}: angular-only keeps its linear speed`);
    within(v[3], V0, 1e-4, `${what} t=${t}: control linear speed`);
    within(w[3], W0, 1e-2, `${what} t=${t}: control angular speed (rotation integration drift)`);
  }
}

const CASES = [{ linear: RATE, angular: RATE }, { linear: RATE }, { angular: RATE }, { linear: 0, angular: 0 }, undefined];

gpuTest('free sphere: linear and angular speeds decay as exp(−rate·t) at dt 1/60 and 1/240; final speeds agree', async (device) => {
  const finals: { v: number; w: number }[] = [];
  for (const dt of [1 / 60, 1 / 240]) {
    const world = await freeWorld(device, dt);
    try {
      assert.equal(world.capabilities.damping, true);
      const bodies = spinners(world, CASES);
      const samples = await decay(world, bodies);
      checkDecay(samples, `dt ${dt}`);
      const last = samples.at(-1)!;
      // Unset is exactly explicit 0
      assert.deepEqual([bodies[4].velocity, bodies[4].angularVelocity], [bodies[3].velocity, bodies[3].angularVelocity], 'unset vs {0, 0}');
      assert.deepEqual(bodies[4].damping, { linear: 0, angular: 0 });
      finals.push({ v: last.v[0], w: last.w[0] });
    } finally {
      world.destroy();
    }
  }
  within(finals[1].v, finals[0].v, 0.02, 'final linear speed, dt 1/240 vs 1/60');
  within(finals[1].w, finals[0].w, 0.02, 'final angular speed, dt 1/240 vs 1/60');
});

gpuTest('fixed and kinematic bodies keep their rates and move exactly as without them', async (device) => {
  const world = await freeWorld(device, 1 / 60);
  try {
    const fixed = world.addBox({ size: [1, 1, 1], position: [0, 0, 0], fixed: true, damping: { linear: 5, angular: 5 } })!;
    const mover = world.addBox({ size: [1, 1, 1], position: [10, 0, 0], fixed: true, velocity: [1, 0, 0], angularVelocity: [0, 0.5, 0], damping: { linear: 5, angular: 5 } })!;
    const plain = world.addBox({ size: [1, 1, 1], position: [10, 10, 0], fixed: true, velocity: [1, 0, 0], angularVelocity: [0, 0.5, 0] })!;
    await world.read();
    const start = [fixed.position, mover.position, plain.position];
    await run(world, 1);
    assert.deepEqual(fixed.position, start[0], 'fixed body');
    const moved = (b: Body, i: number) => b.position.map((p, k) => p - start[i][k]);
    assert.deepEqual(moved(mover, 1), moved(plain, 2), 'kinematic body: the undamped motion');
    assert.deepEqual(mover.rotation, plain.rotation, 'kinematic body: the undamped rotation');
    assert.deepEqual(mover.velocity, [1, 0, 0]);
    assert.deepEqual([fixed.damping, mover.damping], [{ linear: 5, angular: 5 }, { linear: 5, angular: 5 }]);
  } finally {
    world.destroy();
  }
});

gpuTest('setter, reset and disable: rates apply from the next step and are kept as configuration', async (device) => {
  const world = await freeWorld(device, 1 / 60);
  try {
    const [a, control] = spinners(world, [undefined, undefined]);
    await run(world, 0.5);
    within(speed(a.velocity), V0, 1e-4, 'undamped before the setter');
    a.setDamping({ linear: RATE, angular: RATE });
    await run(world, 1);
    within(speed(a.velocity), V0 * Math.exp(-RATE * 1), 0.01, 'linear decay from the setter');
    within(speed(a.angularVelocity), speed(control.angularVelocity) * Math.exp(-RATE * 1), 0.01, 'angular decay from the setter');
    // Reset and a disable/enable cycle keep the rates
    a.reset({ velocity: [V0, 0, 0], angularVelocity: [0, W0, 0] });
    a.setEnabled(false);
    world.step();
    a.setEnabled(true);
    await world.read();
    assert.deepEqual(a.damping, { linear: RATE, angular: RATE });
    await run(world, 1);
    within(speed(a.velocity), V0 * Math.exp(-RATE * 1), 0.01, 'linear decay after reset and re-enable');
    within(speed(control.velocity), V0, 1e-4, 'the control is undamped throughout');
    // Back to 0: the speed stops changing
    a.setDamping({ linear: 0, angular: 0 });
    world.step();
    await world.read();
    const v = speed(a.velocity);
    await run(world, 0.5);
    within(speed(a.velocity), v, 1e-4, 'undamped after setting 0');
  } finally {
    world.destroy();
  }
});

gpuTest('slot reuse: a default body in a removed damped body’s slot is undamped', async (device) => {
  const world = await freeWorld(device, 1 / 60);
  try {
    const [damped] = spinners(world, [{ linear: 50, angular: 50 }]);
    await run(world, 0.1);
    const index = damped.index;
    damped.remove();
    world.step();
    const [reused] = spinners(world, [undefined]);
    assert.equal(reused.index, index, 'the same slot');
    await run(world, 1);
    within(speed(reused.velocity), V0, 1e-4, 'no old rate leaks');
  } finally {
    world.destroy();
  }
});

gpuTest('pool: each lease starts with the template’s rates, not the previous lease’s', async (device) => {
  const world = await freeWorld(device, 1 / 60, { storage: FIXED });
  try {
    const made = await BodyPool.create(world, { capacity: 1, template: { kind: 'sphere', options: { radius: 0.25, damping: { linear: RATE } } } });
    assert.ok(made.ok);
    const at = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number], velocity: [V0, 0, 0] as [number, number, number] };
    const first = (made.pool.tryAcquire(at) as { body: Body }).body;
    first.setDamping({ linear: 0, angular: 0 });
    await run(world, 0.5);
    within(speed(first.velocity), V0, 1e-4, 'the first lease, undamped by its setter');
    made.pool.release(first);
    const second = (made.pool.tryAcquire(at) as { body: Body }).body;
    assert.equal(second.index, first.index);
    assert.deepEqual(second.damping, { linear: RATE, angular: 0 });
    await world.read();
    await run(world, 1);
    within(speed(second.velocity), V0 * Math.exp(-RATE * 1), 0.01, 'the new lease decays at the template rate');
    made.pool.dispose();
  } finally {
    world.destroy();
  }
});

gpuTest('fixed storage: the free-sphere decay', async (device) => {
  const world = await freeWorld(device, 1 / 60, { storage: FIXED });
  try {
    assert.equal(world.capabilities.damping, true);
    checkDecay(await decay(world, spinners(world, CASES)), 'fixed storage');
  } finally {
    world.destroy();
  }
});

gpuTest('SDF collisions: the free-sphere decay', async (device) => {
  const world = await freeWorld(device, 1 / 60);
  try {
    const bodies = spinners(world, CASES);
    await world.enableSdfCollisions([], { cacheSize: 1, randomSamples: 0 });
    assert.equal(world.capabilities.backend, 'sdf');
    assert.equal(world.capabilities.damping, true);
    checkDecay(await decay(world, bodies), 'sdf');
  } finally {
    world.destroy();
  }
});

gpuTest('custom solve modules: default stepping works; damping writes are refused', async (device) => {
  for (const solve of [solveWGSL, solveWGSL + '\n// @group(0) @binding(9) var<storage, read> bodyAux: array<vec4f>;']) {
    const ref = new Solver();
    new Rigid(ref, [0.5, 0.5, 0.5], 1, 0.5, [0, 0, 0]);
    device.pushErrorScope('validation');
    const gpu = new GpuSolver3D(device, ref, { shaders: { solve } });
    try {
      for (let k = 0; k < 10; k++) gpu.step();
      const error = await device.popErrorScope();
      assert.equal(error, null, `no validation error: ${error?.message}`);
      assert.equal(gpu.supportsBodyAux, false);
      assert.throws(() => gpu.setBodyAux([0], [1], [1], [1]), /built-in solve shaders/);
    } finally {
      gpu.destroy();
    }
  }
});

// A device at the WebGPU default of eight storage buffers per stage (no hulls), on its own Dawn
// instance and adapter, destroyed at the end
test('default-limit device: the integrate pipeline validates and the free-sphere decay holds', { skip }, async () => {
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
    const world = await freeWorld(device, 1 / 60);
    try {
      assert.equal(world.hullsEnabled, false);
      const samples = await decay(world, spinners(world, CASES));
      const error = await device.popErrorScope();
      assert.equal(error, null, `no validation error: ${error?.message}`);
      checkDecay(samples, 'default limits');
    } finally {
      world.destroy();
    }
    await device.queue.onSubmittedWorkDone();
    assert.deepEqual(errors, [], 'uncaptured GPU errors');
  } finally {
    device.destroy();
  }
});
