import assert from 'node:assert/strict';
import { create } from 'webgpu';
import { World, deviceCapabilities, convexHull } from '../src/lib/index.ts';
import { gpuTest } from './device.ts';
import { B_ANGVEL, BODY_FLOATS, SHAPE_BOX, SHAPE_HULL } from '../src/avbd3d/gpu/layout.ts';

const shape = convexHull([-1,-1,-1, 1,-1,-1, 0,1,-1, 0,0,1])!;

gpuTest('capabilities: caller device native hull encoding and SDF snapshot transitions', async device => {
  const supported = deviceCapabilities(device).standardHullCollisions;
  const world = await World.create({ device, maxBodies: 4, requireHulls: supported });
  try {
    const before = world.capabilities;
    assert.equal(before.hullCollisions, supported ? 'native' : 'box-fallback');
    const body = world.addHull({ shape })!;
    world.step();
    await world.read();
    const records = await world.solver.readBodies();
    assert.equal(records[body.index * BODY_FLOATS + B_ANGVEL + 3] >= SHAPE_HULL, supported);
    // An explicit analytic field for a hull body is independent of native hull SAT.
    const { AnalyticField } = await import('../src/avbd3d/ref/sdf/shapes.ts');
    const installing = world.enableSdfCollisions([{ body, field: new AnalyticField({ kind: 'sphere', radius: 1 }) }]);
    assert.equal(world.capabilities.backend, 'standard', 'preparing retains installed backend');
    await installing;
    assert.equal(world.capabilities.backend, 'sdf');
    assert.equal(world.capabilities.hullCollisions, 'explicit-sdf-field');
    assert.equal(before.backend, 'standard');
    await assert.rejects(world.updateSdfCollisions([{ body, field: new AnalyticField({ kind: 'sphere', radius: 1 }) }], { maxPairs: 0 }));
    assert.equal(world.capabilities.backend, 'sdf', 'failed replacement retains installed backend');
    world.disableSdfCollisions();
    assert.deepEqual(world.capabilities, before);
  } finally { world.destroy(); }
  // World never owns the caller's device.
  const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST });
  buffer.destroy();
});

gpuTest('capabilities: real eight-buffer device rejects strict creation without allocations and retains legacy fallback', async () => {
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter);
  // Explicitly negotiate eight even when this adapter supports more.
  const device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: 8 } });
  const errors: string[] = [];
  device.onuncapturederror = e => errors.push(e.error.message);
  const original = device.createBuffer.bind(device);
  let allocations = 0;
  device.createBuffer = descriptor => { allocations++; return original(descriptor); };
  try {
    assert.equal(device.limits.maxStorageBuffersPerShaderStage, 8);
    await assert.rejects(World.create({ device, maxBodies: 4, requireHulls: true }), /requireHulls/);
    assert.equal(allocations, 0);
    let attributes = 0;
    const renderer = { init: async () => {}, backend: { device, createStorageAttribute: () => { attributes++; } } };
    await assert.rejects(World.create({ renderer: renderer as never, maxBodies: 4, requireHulls: true }), /requireHulls/);
    assert.equal(attributes, 0, 'renderer attribute allocation is after preflight');
    assert.equal(allocations, 0);
    const world = await World.create({ device, maxBodies: 4 });
    const warnings: unknown[][] = [];
    const warn = console.warn;
    try {
      console.warn = (...args) => { warnings.push(args); };
      assert.equal(world.capabilities.hullCollisions, 'box-fallback');
      world.addHull({ shape }); world.addHull({ shape });
      assert.equal(warnings.length, 1);
      assert.match(String(warnings[0]), /bounding-box/);
      world.step();
      await world.read();
      const records = await world.solver.readBodies();
      assert.equal(records[B_ANGVEL + 3], SHAPE_BOX);
      assert.equal(records[BODY_FLOATS + B_ANGVEL + 3], SHAPE_BOX);
    } finally { console.warn = warn; world.destroy(); }
    const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.COPY_DST });
    buffer.destroy();
    await device.queue.onSubmittedWorkDone();
    assert.deepEqual(errors, []);
  } finally { device.destroy(); }
});
