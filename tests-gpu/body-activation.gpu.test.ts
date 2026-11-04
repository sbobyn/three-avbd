import assert from 'node:assert/strict';
import { World, BodyDisabledError, BodyLifecycleError, UnsupportedLifecycleError } from '../src/lib/index.ts';
import { B_POS, B_ROT, B_INITIAL_POS, B_INERTIAL_POS, B_INITIAL_ROT, B_INERTIAL_ROT, B_VEL, B_ANGVEL, BODY_FLOATS, BODY_DISABLED, J_REST, J_PEN_LIN, J_PEN_ANG } from '../src/avbd3d/gpu/layout.ts';
import { gpuTest } from './device.ts';
import { create } from 'webgpu';

const record = async (world: World, index = 0) => (await world.solver.readBodies()).slice(index * BODY_FLOATS, (index + 1) * BODY_FLOATS);
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 2e-5, `${actual} != ${expected}`);

gpuTest('activation retains GPU state, excludes rays and colliders, and re-enables the same life', async device => {
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
  try {
    const body = world.addSphere({ radius: .5, position: [0, 2, 0], velocity: [1, 0, 0], angularVelocity: [0, 1, 0] })!;
    world.step();
    body.setEnabled(false); world.flushCommands();
    const before = await record(world);
    assert.ok(before[B_POS] > 0, 'actual GPU pose moved without a World read');
    for (let i = 0; i < 3; i++) world.step();
    assert.deepEqual(await record(world), before, 'every disabled GPU record lane retained');
    assert.equal(await world.raycast([0, 5, 0], [0, -1, 0]), null);
    assert.deepEqual([world.bodyStats.enabled, world.bodyStats.disabled, world.bodyStats.available], [0, 1, 3]);
    const id = body.id;
    body.setEnabled(true); world.flushCommands();
    assert.equal((await world.raycast([0, 5, 0], [0, -1, 0]))!.body, body);
    world.step();
    assert.ok((await record(world))[B_POS] > before[B_POS]);
    assert.equal(body.id, id);
  } finally { world.destroy(); }
});

gpuTest('initially disabled adds, masked writes and fixed transitions preserve participation flags', async device => {
  const world = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  try {
    const body = world.addBox({ size: [1, 1, 1], enabled: false, velocity: [2, 3, 4] })!;
    world.flushCommands();
    body.set({ position: [4, 5, 6] });
    for (let i = 0; i < 2; i++) world.step();
    const state = await record(world);
    assert.deepEqual(Array.from(state.slice(B_POS, B_POS + 3)), [4, 5, 6]);
    assert.deepEqual(Array.from(state.slice(B_VEL, B_VEL + 3)), [2, 3, 4]);
    assert.ok(state[B_INITIAL_POS + 3] & BODY_DISABLED);
    body.setFixed(true); world.flushCommands();
    assert.ok((await record(world))[B_INITIAL_POS + 3] & BODY_DISABLED);
    assert.throws(() => body.moveTo([1, 0, 0]), BodyDisabledError);
    body.setFixed(false); body.moveTo([7, 8, 9]); world.flushCommands();
    assert.deepEqual(Array.from((await record(world)).slice(B_POS, B_POS + 3)), [7, 8, 9]);
    assert.equal(body.enabled, false);
  } finally { world.destroy(); }
});

gpuTest('reset keeps GPU pose, resets history, and composes explicit fields in either call order', async device => {
  const world = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  try {
    const body = world.addBox({ size: [1, 2, 3], velocity: [1, 2, 3], angularVelocity: [.2, .3, .4] })!;
    for (let i = 0; i < 3; i++) world.step();
    const before = await record(world);
    body.reset(); world.flushCommands();
    const reset = await record(world);
    for (const offset of [B_POS, B_INITIAL_POS, B_INERTIAL_POS]) assert.deepEqual(reset.slice(offset, offset + 3), before.slice(B_POS, B_POS + 3));
    for (const offset of [B_ROT, B_INITIAL_ROT, B_INERTIAL_ROT]) assert.deepEqual(reset.slice(offset, offset + 4), before.slice(B_ROT, B_ROT + 4));
    assert.deepEqual(Array.from(reset.slice(B_VEL, B_VEL + 4)), [0, 0, 0, 0]);
    assert.deepEqual(Array.from(reset.slice(B_ANGVEL, B_ANGVEL + 3)), [0, 0, 0]);
    assert.deepEqual(reset.slice(16, 24), before.slice(16, 24), 'mass/inertia/shape dimensions retained');
    assert.equal(reset[B_ANGVEL + 3], before[B_ANGVEL + 3], 'shape encoding retained');
    body.set({ position: [5, 6, 7] }); body.reset({ velocity: [4, 3, 2] });
    world.flushCommands();
    const explicit = await record(world);
    assert.deepEqual(Array.from(explicit.slice(B_POS, B_POS + 3)), [5, 6, 7]);
    assert.deepEqual(explicit.slice(B_POS, B_POS + 3), explicit.slice(B_INITIAL_POS, B_INITIAL_POS + 3));
    assert.deepEqual(Array.from(explicit.slice(B_VEL, B_VEL + 3)), [4, 3, 2]);
    body.reset({ velocity: [9, 9, 9] }); body.set({ velocity: [8, 7, 6] }); world.flushCommands();
    assert.deepEqual(Array.from((await record(world)).slice(B_VEL, B_VEL + 3)), [8, 7, 6]);
    body.setEnabled(false); body.reset({ position: [1, 2, 3], velocity: [6, 5, 4] });
    world.step();
    const paused = await record(world);
    assert.deepEqual(Array.from(paused.slice(B_POS, B_POS + 3)), [1, 2, 3]);
    assert.deepEqual(Array.from(paused.slice(B_VEL, B_VEL + 3)), [6, 5, 4]);
    assert.ok(paused[B_INITIAL_POS + 3] & BODY_DISABLED);
  } finally { world.destroy(); }
});

gpuTest('disable invalidates reused manifolds and contact ends wait for a simulation step', async device => {
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0], iterations: 0 });
  try {
    const a = world.addBox({ size: [1, 1, 1], reportContacts: true })!;
    world.addBox({ size: [1, 1, 1], position: [.8, 0, 0] });
    const events: string[] = []; world.onContact(e => events.push(e.type));
    world.step(); await world.read(); assert.deepEqual(events, ['begin']);
    a.setEnabled(false); world.flushCommands(); await world.read();
    assert.deepEqual(events, ['begin'], 'flush/read does not synthesize an end');
    world.step({ reuseManifolds: true }); await world.read();
    assert.deepEqual(events, ['begin', 'end']);
    assert.equal((await world.solver.readContactList()).length, 0, 'no ghost manifold');
    a.setEnabled(true); world.step(); await world.read();
    assert.deepEqual(events, ['begin', 'end', 'begin']);
    a.setEnabled(false); world.flushCommands(); a.setEnabled(true); world.step(); await world.read();
    assert.deepEqual(events, ['begin', 'end', 'begin'], 'same-step toggle keeps event membership');
  } finally { world.destroy(); }
});

gpuTest('disabled endpoints suspend whole joints and springs without pinning the enabled partner', async device => {
  for (const spring of [false, true]) {
    const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
    try {
      const a = world.addBox({ size: [1, 1, 1] })!;
      const b = world.addBox({ size: [1, 1, 1], position: [3, 0, 0], velocity: [2, 0, 0] })!;
      const joint = spring ? world.addSpring(a, b, { stiffness: 100 }) : world.addJoint(a, b, { anchorA: [3, 0, 0] });
      a.setEnabled(false); world.step(); await world.read();
      assert.equal(joint.holding, true); assert.equal(joint.suspended, true);
      close(b.velocity[0], 2); assert.deepEqual(a.position, [0, 0, 0]);
      b.setEnabled(false); a.setEnabled(true); world.step(); assert.equal(joint.suspended, true);
      b.setEnabled(true); world.step(); assert.equal(joint.suspended, false);
    } finally { world.destroy(); }
  }
});

gpuTest('resume preserves GPU-owned plastic rest and does not revive an unobserved broken joint', async device => {
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0], iterations: 0 });
  try {
    const a = world.addBox({ size: [1, 1, 1], fixed: true })!;
    const b = world.addBox({ size: [1, 1, 1], position: [3, 0, 0] })!;
    const joint = world.addJoint(a, b, { anchorA: [3, 0, 0], yieldForce: 1, breakForce: 5, breakOnPull: true });
    world.flushCommands();
    const rest = new Float32Array([0, 0, Math.sin(.2), Math.cos(.2)]);
    device.queue.writeBuffer((world.solver as unknown as { jointBuffer: GPUBuffer }).jointBuffer, J_REST * 4, rest);
    world.solver.disableConstraint(joint.slot);
    b.setEnabled(false); world.step(); b.setEnabled(true); world.step();
    const state = await world.solver.readJoints();
    assert.deepEqual(state.slice(J_REST, J_REST + 4), rest);
    assert.equal(state[J_PEN_LIN + 3], 0); assert.equal(state[J_PEN_ANG + 3], 0);
    await world.readJoints(); assert.equal(joint.broken, true);
  } finally { world.destroy(); }
});

gpuTest('impulses, forces and prescribed motion pause; reset clears old pushes', async device => {
  const world = await World.create({ device, maxBodies: 4, dt: .1, gravity: [0, 0, 0] });
  try {
    const body = world.addBox({ size: [1, 1, 1] })!;
    body.applyImpulse([2, 0, 0]); body.applyForce([10, 0, 0]); body.setEnabled(false);
    assert.throws(() => body.applyImpulse([1, 0, 0]), BodyDisabledError);
    assert.throws(() => body.applyForce([1, 0, 0]), BodyDisabledError);
    for (let i = 0; i < 3; i++) world.step();
    body.setEnabled(true); world.step(); await world.read(); close(body.velocity[0], 3);
    body.clearForces(); world.step(); await world.read(); close(body.velocity[0], 3);
    body.applyImpulse([4, 0, 0]); body.applyTorque([2, 0, 0]); body.reset(); world.step(); await world.read();
    close(body.velocity[0], 0); close(body.angularVelocity[0], 0);
    const platform = world.addBox({ size: [1, 1, 1], position: [0, 10, 0], fixed: true })!;
    platform.moveTo([10, 10, 0]); world.maxSubsteps = 2;
    const step = world.step.bind(world); let interrupted = false;
    world.step = options => { step(options); if (!interrupted) { interrupted = true; platform.setEnabled(false); } };
    world.update(.2); await world.read(); close(platform.position[0], 5);
    world.step = step; world.step(); platform.setEnabled(true); world.update(.1); await world.read();
    close(platform.position[0], 10); close(platform.velocity[0], 0);
  } finally { world.destroy(); }
});

gpuTest('removed getters freeze own observations across outstanding reads and same-slot replacement', async device => {
  const world = await World.create({ device, maxBodies: 1, gravity: [0, 0, 0] });
  try {
    const old = world.addBox({ size: [1, 1, 1], position: [1, 2, 3], velocity: [1, 0, 0] })!;
    world.step(); await world.read();
    const frozen = { position: old.position, rotation: old.rotation, velocity: old.velocity, angular: old.angularVelocity };
    const pending = world.read([old]); old.remove();
    const fresh = world.addSphere({ radius: .5, position: [20, 30, 40] })!;
    await pending; world.step(); await world.read();
    assert.equal(fresh.index, old.index); assert.notEqual(fresh.id, old.id);
    assert.deepEqual(old.position, frozen.position); assert.deepEqual(old.rotation, frozen.rotation);
    assert.deepEqual(old.velocity, frozen.velocity); assert.deepEqual(old.angularVelocity, frozen.angular);
    assert.throws(() => old.reset(), BodyLifecycleError); assert.throws(() => old.setEnabled(true), BodyLifecycleError);
    assert.equal(old.enabled, false); assert.equal(world.bodyStats.live, 1);
    old.position[0] = 999; assert.deepEqual(old.position, frozen.position);
  } finally { world.destroy(); }
});

gpuTest('lifecycle preflight rejects SDF/custom installation and invalid options without mutation', async device => {
  const world = await World.create({ device, maxBodies: 2 });
  try {
    assert.throws(() => world.addBox({ size: [1, 1, 1], enabled: null as unknown as boolean }), BodyLifecycleError);
    assert.equal(world.bodyStats.remainingBodyIds, 0x7fffffff);
    const body = world.addBox({ size: [1, 1, 1] })!;
    assert.throws(() => body.setEnabled(1 as unknown as boolean), BodyLifecycleError);
    body.setEnabled(false);
    const backend = { prepare: () => { throw new Error('must not prepare'); } };
    assert.throws(() => world.solver.setCollisionBackend(backend as never), /pending body lifecycle/);
    await assert.rejects(world.enableSdfCollisions(), /pending body lifecycle/);
    body.setEnabled(true); world.step();
    body.reset(); world.flushCommands();
    await assert.rejects(world.enableSdfCollisions(), /pending body lifecycle/);
    world.step();
    await world.enableSdfCollisions([], { cacheSize: 1, randomSamples: 0, alpha: 0 });
    assert.equal(world.capabilities.bodyActivation, false);
    assert.throws(() => body.reset(), UnsupportedLifecycleError);
    assert.throws(() => body.setEnabled(false), UnsupportedLifecycleError);
    assert.throws(() => world.addBox({ size: [1, 1, 1], enabled: false }), UnsupportedLifecycleError);
    assert.equal(world.bodyStats.live, 1);
    world.disableSdfCollisions(); body.reset(); world.step();
  } finally { world.destroy(); }
});

gpuTest('activation and reset fit an eight-storage-binding device', async () => {
  const gpu = create([]); const adapter = await gpu.requestAdapter(); assert.ok(adapter);
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
  const errors: string[] = []; device.onuncapturederror = event => errors.push(event.error.message);
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
  try {
    assert.equal(world.capabilities.maxStorageBuffersPerShaderStage, 8);
    const body = world.addSphere({ radius: .5, enabled: false, position: [0, 2, 0] })!;
    world.step(); body.reset({ velocity: [2, 0, 0] }); body.setEnabled(true);
    world.step(); await world.read();
    close(body.velocity[0], 2);
    assert.equal((await world.raycast([0, 5, 0], [0, -1, 0]))!.body, body);
    await device.queue.onSubmittedWorkDone(); assert.deepEqual(errors, []);
  } finally { world.destroy(); device.destroy(); }
});

gpuTest('disabled coarse, large and hull colliders are excluded on either side of a pair', async device => {
  for (const fixed of [false, true]) {
    const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0], iterations: 0 });
    try {
      const large = world.addBox({ size: [100, 1, 100], position: [0, -.5, 0], fixed })!;
      const small = world.addBox({ size: [1, 1, 1], position: [0, .4, 0] })!;
      world.step(); assert.ok((await world.solver.readCounters()).pairs > 0);
      large.setEnabled(false); world.step(); assert.equal((await world.solver.readCounters()).pairs, 0);
      large.setEnabled(true); small.setEnabled(false); world.step(); assert.equal((await world.solver.readCounters()).pairs, 0);
      small.setEnabled(true); world.step(); assert.ok((await world.solver.readCounters()).pairs > 0);
      const hull = world.addHull({ points: [-.5,-.5,-.5, .5,-.5,-.5, 0,.5,-.5, 0,0,.5], position: [4, .1, 0], enabled: false })!;
      world.flushCommands();
      assert.equal((await world.raycast([4, 5, 0], [0, -1, 0]))!.body, large);
      hull.setEnabled(true); world.flushCommands();
      assert.equal((await world.raycast([4, 5, 0], [0, -1, 0]))!.body, hull);
    } finally { world.destroy(); }
  }
});

gpuTest('disabled dynamic records stay unchanged under sequential and fixed color modes', async device => {
  for (const sequential of [false, true]) {
    const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
    try {
      const a = world.addBox({ size: [1, 1, 1], velocity: [2, 0, 0] })!;
      world.addBox({ size: [1, 1, 1], position: [3, 0, 0] }); world.flushCommands();
      world.solver.fixedColors = sequential ? world.solver.sequentialColors() : new Uint32Array([0, 0]);
      a.setEnabled(false); world.flushCommands(); const before = await record(world);
      world.step(); assert.deepEqual(await record(world), before);
      assert.equal((await world.solver.readCounters()).clashes, 0);
    } finally { world.destroy(); }
  }
});
