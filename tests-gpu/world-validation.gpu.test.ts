// World input and listener robustness (maturity round 2, M-01 to M-03): a throwing onContact /
// onBreak listener is the application's error, not a GPU failure; invalid body inputs throw
// before any slot, ID or hull pin is taken; invalid step parameters and update deltas throw
// before any state changes. Public API, except a pin spy where the pin is the evidence.

import assert from 'node:assert/strict';
import { World, convexHull, type ContactEvent, type Joint } from '../src/lib/index.ts';
import { createGpu, gpuTest } from './device.ts';

const create = (device: GPUDevice) => World.create({ device, maxBodies: 16, gravity: [0, 0, 0], iterations: 0 });
const box = (world: World, x: number, reportContacts = false) => world.addBox({ size: [1, 1, 1], position: [x, 0, 0], reportContacts })!;

/** Wait (bounded) for an automatic readback's effects. */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(done(), `timed out waiting for ${what}`);
}

/** console.error captured while `fn` runs. */
async function capturingErrors<T>(fn: (logged: unknown[][]) => Promise<T>): Promise<T> {
  const logged: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    return await fn(logged);
  } finally {
    console.error = saved;
  }
}

// --- M-01: listener errors ----------------------------------------------------------------------

gpuTest('world validation: a contact listener that throws under readbackEvery leaves world.error null; the batch and later batches arrive', async device => {
  const world = await create(device);
  try {
    await capturingErrors(async logged => {
      world.readbackEvery = 1;
      const a = box(world, 0, true), b = box(world, 0.9);
      const boom = new Error('listener boom');
      let calls = 0;
      const seen: ContactEvent[] = [];
      world.onContact(() => { if (calls++ === 0) throw boom; });
      world.onContact(event => seen.push(event));
      world.step();
      await until(() => logged.length > 0, 'the listener error report');
      assert.equal(world.error, null, 'a listener error is not a GPU error');
      assert.equal(logged.length, 1, 'reported once');
      assert.ok(logged[0].includes(boom), 'the original error is reported');
      assert.deepEqual(seen.map(e => e.type), ['begin'], 'the second listener still got the first event');
      // The world goes on: steps, writes, later automatic and explicit reads
      b.set({ position: [5, 0, 0] });
      assert.equal(world.update(world.dt), 1);
      await until(() => seen.length === 2, 'the end event');
      assert.equal(seen[1].type, 'end');
      assert.ok(seen[1].a === a || seen[1].b === a);
      assert.equal(calls, 2, 'the throwing listener stays subscribed');
      world.readbackEvery = 0;
      const { step } = await world.read();
      assert.equal(step, world.stepCount);
      assert.ok(Math.abs(b.position[0] - 5) < 1e-5, 'the later read applied');
      assert.equal(world.error, null);
      assert.equal(logged.length, 1);
    });
  } finally { world.destroy(); }
});

gpuTest('world validation: an explicit read rejects with the first listener error after delivering the whole batch', async device => {
  const world = await create(device);
  try {
    await capturingErrors(async logged => {
      box(world, 0, true); box(world, 0.9); box(world, 10, true); box(world, 10.9);
      const first = new Error('first'), second = new Error('second');
      const seen: ContactEvent[] = [];
      let unsubscribeLate: () => unknown = () => undefined;
      world.onContact(() => { throw first; });
      world.onContact(() => {
        // Subscribing or unsubscribing in a callback changes the next batch, not this one
        unsubscribeLate();
        world.onContact(() => assert.fail('subscribed during the batch'));
        throw second;
      });
      unsubscribeLate = world.onContact(event => seen.push(event));
      world.step();
      await assert.rejects(world.read(), error => error === first);
      assert.equal(seen.length, 2, 'both begins reached the last listener');
      assert.equal(world.error, null);
      assert.ok(logged.some(args => args.includes(second)), 'later listener errors of the batch are reported');
      // Nothing left over: the next read has no events and resolves
      world.step();
      assert.deepEqual(await world.read(), { step: world.stepCount });
    });
  } finally { world.destroy(); }
});

gpuTest('world validation: a throwing onBreak listener still lets the joint break, every listener hear it, and the world go on', async device => {
  const world = await World.create({ device, maxBodies: 16 });
  try {
    const hook = world.addBox({ size: [1, 1, 1], position: [0, 5, 0], fixed: true })!;
    const hanging = world.addBox({ size: [1, 1, 1], position: [0, 4, 0] })!;
    const joint = world.addJoint(hook, hanging, { anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0], breakForce: 2, breakOnPull: true });
    const boom = new Error('break listener');
    const heard: Joint[] = [];
    world.onBreak(() => { throw boom; });
    world.onBreak(j => heard.push(j));
    for (let i = 0; i < 30; i++) world.step();
    await assert.rejects(world.read(), error => error === boom);
    assert.ok(joint.broken);
    assert.deepEqual(heard, [joint]);
    assert.equal(world.error, null);
    for (let i = 0; i < 30; i++) world.step();
    await world.read();
    assert.ok(hanging.position[1] < 3.5, `fell after the break: ${hanging.position[1]}`);
    assert.deepEqual(heard, [joint], 'reported once');
  } finally { world.destroy(); }
});

gpuTest('world validation: real device loss after a listener error is still retained as world.error', async () => {
  const adapter = await createGpu().requestAdapter();
  assert.ok(adapter);
  const device = await adapter.requestDevice();
  const world = await World.create({ device, maxBodies: 8, gravity: [0, 0, 0], iterations: 0 });
  await capturingErrors(async logged => {
    box(world, 0, true); box(world, 0.9);
    const boom = new Error('listener boom');
    world.onContact(() => { throw boom; });
    world.readbackEvery = 1;
    world.step();
    await until(() => logged.length > 0, 'the listener error report');
    assert.equal(world.error, null);
    world.step();
    device.destroy();
    await device.lost;
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(world.error, 'device loss recorded');
    assert.notEqual(world.error, boom, 'not classified as the listener error');
    assert.throws(() => world.step(), /lost|map|destroy|abort/i);
    await assert.rejects(world.read(), /lost|map|destroy|abort/i);
  });
  world.destroy();
});

// --- M-02: body creation inputs -----------------------------------------------------------------

gpuTest('world validation: invalid body inputs throw before a slot, an ID or a hull pin is taken', async device => {
  const world = await World.create({ device, maxBodies: 8, storage: { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } });
  try {
    const first = box(world, 0);
    const stats = world.bodyStats, version = world.version;
    const cube = convexHull([-1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1].map(v => v * 0.25))!;
    let pins = 0;
    const pinHull = world.solver.pinHull.bind(world.solver), unpinHull = world.solver.unpinHull.bind(world.solver);
    world.solver.pinHull = shape => { pins++; pinHull(shape); };
    world.solver.unpinHull = shape => { pins--; unpinHull(shape); };
    const bad: [string, () => unknown][] = [
      ['NaN position', () => world.addBox({ size: [1, 1, 1], position: [0, NaN, 0] })],
      ['null position', () => world.addBox({ size: [1, 1, 1], position: null as never })],
      ['short velocity', () => world.addBox({ size: [1, 1, 1], velocity: [1, 0] as never })],
      ['zero rotation', () => world.addBox({ size: [1, 1, 1], rotation: [0, 0, 0, 0] })],
      ['f32-overflowing angular velocity', () => world.addBox({ size: [1, 1, 1], angularVelocity: [0, 1e39, 0] })],
      ['two-component size', () => world.addBox({ size: [1, 1] as never })],
      ['zero size', () => world.addBox({ size: [1, 0, 1] })],
      ['underflowing size', () => world.addBox({ size: [1, 1e-50, 1] })],
      ['zero radius', () => world.addSphere({ radius: 0 })],
      ['infinite radius', () => world.addSphere({ radius: Infinity })],
      ['negative density', () => world.addBox({ size: [1, 1, 1], density: -1 })],
      ['NaN friction', () => world.addSphere({ radius: 1, friction: NaN })],
      ['fractional group', () => world.addBox({ size: [1, 1, 1], group: 1.5 })],
      ['33-bit mask', () => world.addBox({ size: [1, 1, 1], collidesWith: 2 ** 32 })],
      ['hull with infinite position', () => world.addHull({ shape: cube, position: [Infinity, 0, 0] })],
      ['hull with zero rotation', () => world.addHull({ shape: cube, rotation: [0, 0, 0, 0] })],
    ];
    for (const [what, add] of bad) {
      assert.throws(add, what);
      assert.deepEqual(world.bodyStats, stats, `${what}: stats unchanged`);
      assert.equal(world.version, version, `${what}: version unchanged`);
      assert.equal(pins, 0, `${what}: no hull pin left`);
    }
    if (world.solver.hulls) {
      // Invalid mass properties are refused after the pin, which is released again
      assert.throws(() => world.addHull({ shape: cube, massProperties: { mass: -1, moments: [1, 1, 1] } }));
      assert.equal(pins, 0);
      assert.deepEqual(world.bodyStats, stats);
    }
    // Valid inputs as before: a fixed ground of density 0, an unnormalised rotation (normalised)
    const ground = world.addBox({ size: [10, 1, 10], position: [0, -2, 0], fixed: true, density: 0 })!;
    assert.equal(ground.id, first.id + 1, 'no ID was spent on a refused body');
    assert.equal(ground.index, first.index + 1, 'no slot was spent on a refused body');
    const turned = world.addBox({ size: [1, 1, 1], position: [3, 0, 0], rotation: [0, 0, 0, 2] })!;
    assert.deepEqual(turned.rotation, [0, 0, 0, 1]);
    world.step();
    await world.read();
    assert.ok(turned.position.every(Number.isFinite));
  } finally { world.destroy(); }
});

// --- M-03: step parameters and update deltas ----------------------------------------------------

gpuTest('world validation: a non-finite update delta throws without stopping time; valid updates recover', async device => {
  const world = await create(device);
  try {
    box(world, 0);
    for (const bad of [NaN, undefined, Infinity, -Infinity]) {
      assert.throws(() => world.update(bad as number), /World\.update/, String(bad));
      assert.equal(world.stepCount, 0);
    }
    assert.equal(world.update(-1), 0, 'a negative finite delta still counts as no time');
    assert.equal(world.update(world.dt), 1, 'the next valid update steps');
    assert.equal(world.update(world.dt * 2.5), 2);
    assert.equal(world.update(world.dt * 0.6), 1, 'the remainder was kept');
    assert.equal(world.stepCount, 4);
  } finally { world.destroy(); }
});

gpuTest('world validation: rejected dt, iterations, maxSubsteps and gravity leave the previous values', async device => {
  for (const options of [{ dt: 0 }, { dt: NaN }, { iterations: -1 }, { iterations: 2.5 }, { gravity: [0, NaN, 0] as [number, number, number] }, { gravity: [0, 1e39, 0] as [number, number, number] }]) {
    await assert.rejects(World.create({ device, maxBodies: 4, ...options }), /World\.create/, JSON.stringify(options));
  }
  const world = await World.create({ device, maxBodies: 4, dt: 1 / 120, iterations: 0, gravity: [0, -5, 0] });
  try {
    for (const bad of [0, -1, NaN, Infinity, 1e39]) assert.throws(() => { world.dt = bad; }, /World\.dt/);
    assert.equal(world.dt, 1 / 120);
    for (const bad of [-1, 1.5, NaN]) assert.throws(() => { world.iterations = bad; }, /World\.iterations/);
    assert.equal(world.iterations, 0);
    for (const bad of [0, 2.5, NaN, Infinity]) assert.throws(() => { world.maxSubsteps = bad; }, /World\.maxSubsteps/);
    assert.equal(world.maxSubsteps, 4);
    for (const bad of [[0, NaN, 0], [Infinity, 0, 0], [0, -9.81]]) assert.throws(() => { world.gravity = bad as [number, number, number]; }, /World\.gravity/);
    assert.deepEqual(world.gravity, [0, -5, 0]);
    world.maxSubsteps = 8;
    world.iterations = 4;
    world.gravity = [0, 0, 0];
    assert.equal(world.maxSubsteps, 8);
    assert.equal(world.iterations, 4);
    assert.deepEqual(world.gravity.map(Math.abs), [0, 0, 0]);
    world.addBox({ size: [1, 1, 1] });
    assert.equal(world.update(1), 8);
  } finally { world.destroy(); }
});
