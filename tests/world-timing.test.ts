// World.droppedTime (STE-3328, timing diagnostic): the cumulative seconds World.update discarded
// because more than maxSubsteps steps were owed. CPU accounting only: World.create on a minimal
// fake device (no GPU, no shader compilation) and the real World.update. Most cases replace
// `step` with a counting stub (clearly marked, instance-level) so the expected ledger is pure
// arithmetic on binary-exact times; one case runs the real step on the fake device.

import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { World } from '../src/lib/world.ts';

type Any = any;

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

const LIMITS = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };

/** A device that accepts everything and records nothing. */
function fakeDevice(): GPUDevice {
  const noop = () => undefined;
  const pass = { setPipeline: noop, setBindGroup: noop, dispatchWorkgroups: noop, dispatchWorkgroupsIndirect: noop, end: noop };
  const device: Any = {
    limits: { maxStorageBuffersPerShaderStage: 8, ...LIMITS },
    features: new Set<string>(),
    lost: new Promise(() => undefined),
    queue: { writeBuffer: noop, submit: noop, onSubmittedWorkDone: () => Promise.resolve() },
    createBuffer(desc: GPUBufferDescriptor) {
      return { label: desc.label ?? '', size: desc.size, usage: desc.usage, destroy: noop, getMappedRange: () => new ArrayBuffer(desc.size), unmap: noop, mapAsync: () => new Promise(() => undefined) };
    },
    createBindGroupLayout: (desc: Any) => ({ label: desc.label, entries: [...desc.entries] }),
    createPipelineLayout: (desc: Any) => ({ bindGroupLayouts: [...desc.bindGroupLayouts] }),
    createShaderModule: (desc: Any) => ({ code: desc.code }),
    createComputePipeline: (desc: Any) => ({ label: desc.label, layout: desc.layout, getBindGroupLayout: () => ({ auto: true }) }),
    createBindGroup: (desc: Any) => ({ label: desc.label, layout: desc.layout, entries: desc.entries }),
    createQuerySet: () => ({ destroy: noop }),
    createCommandEncoder: () => ({ clearBuffer: noop, copyBufferToBuffer: noop, resolveQuerySet: noop, finish: () => ({}), beginComputePass: () => pass }),
    pushErrorScope: noop,
    popErrorScope: () => Promise.resolve(null),
  };
  return device as GPUDevice;
}

const created: World[] = [];
async function createWorld(): Promise<World> {
  const world = await World.create({ device: fakeDevice(), maxBodies: 4 });
  created.push(world);
  return world;
}
after(() => { for (const world of created) world.destroy(); });

/** A world whose `step` is a TEST STUB counting calls (optionally throwing on chosen calls); update and droppedTime are real. */
async function stubbed(dt: number, maxSubsteps: number, failOn: number[] = []) {
  const w = await createWorld();
  w.dt = dt;
  w.maxSubsteps = maxSubsteps;
  const stub = { calls: 0 };
  (w as Any).step = () => {
    stub.calls++;
    if (failOn.includes(stub.calls)) throw new Error('stub step failed');
  };
  return { w, stub };
}

test('droppedTime starts at 0 on every new world, with the real (unstubbed) fields', async () => {
  const a = await createWorld();
  const b = await createWorld();
  assert.equal(a.droppedTime, 0);
  a.maxSubsteps = 1;
  a.dt = 1 / 8;
  // Real step on the fake device: 1 s owed, one step allowed: 7/8 left, 1/8 carried, 3/4 dropped
  assert.equal(a.update(1), 1);
  assert.equal(a.stepCount, 1);
  assert.equal(a.droppedTime, 0.75);
  assert.equal(b.droppedTime, 0, 'not shared between worlds');
});

test('binary-exact ledger: dt 1/8, max 2, 1 s -> 2 steps, 5/8 dropped, 1/8 carried; update(0) spends the carry without a new drop', async () => {
  const { w, stub } = await stubbed(1 / 8, 2);
  assert.equal(w.update(1), 2);
  assert.equal(stub.calls, 2);
  assert.equal(w.droppedTime, 5 / 8);
  assert.equal(w.update(0), 1, 'the carried dt runs');
  assert.equal(stub.calls, 3);
  assert.equal(w.droppedTime, 5 / 8);
  assert.equal(w.update(0), 0, 'nothing left');
  assert.equal(w.droppedTime, 5 / 8);
});

test('under the cap or at it, nothing is dropped; fractional remainders are carried, not counted', async () => {
  const { w } = await stubbed(1 / 8, 4);
  assert.equal(w.update(3 / 16), 1); // owed 3/16 -> 1 step, 1/16 carried
  assert.equal(w.update(3 / 16), 2); // 1/16 + 3/16 = 1/4 -> 2 steps
  assert.equal(w.update(1 / 2), 4); // exactly the cap
  assert.equal(w.update(1 / 32), 0);
  assert.equal(w.droppedTime, 0);
});

test('repeated caps accumulate: each update drops its own excess, and time is conserved', async () => {
  const { w, stub } = await stubbed(1 / 4, 1);
  // Each update owes carry(1/4 after the first) + 1: 1 step, then 1/4 carried
  assert.equal(w.update(1), 1);
  assert.equal(w.droppedTime, 1 / 2); // 1 - 1/4 step - 1/4 carry
  assert.equal(w.update(1), 1);
  assert.equal(w.droppedTime, 1 / 2 + 3 / 4); // 5/4 - 1/4 - 1/4
  assert.equal(w.update(1), 1);
  assert.equal(w.droppedTime, 2);
  // Independent conservation: input 3 = simulated (steps * dt) + dropped + carried (1/4)
  assert.equal(3, stub.calls / 4 + w.droppedTime + 1 / 4);
});

test('changing maxSubsteps and dt between updates changes what is dropped from then on', async () => {
  const { w } = await stubbed(1 / 4, 3);
  assert.equal(w.update(2), 3); // 2 - 3/4 = 5/4 -> carry 1/4, drop 1
  assert.equal(w.droppedTime, 1);
  w.maxSubsteps = 1;
  w.dt = 1 / 2;
  assert.equal(w.update(1), 1); // owed 5/4 -> step -> 3/4 -> carry 1/2, drop 1/4
  assert.equal(w.droppedTime, 5 / 4);
  w.maxSubsteps = 8;
  assert.equal(w.update(0), 1); // the 1/2 carry is exactly one dt, cap not reached
  assert.equal(w.droppedTime, 5 / 4);
});

test('negative time counts as 0; zero adds nothing', async () => {
  const { w, stub } = await stubbed(1 / 8, 1);
  assert.equal(w.update(1), 1); // 3/4 dropped
  assert.equal(w.update(-5), 1, 'only the carried dt runs; the negative time is 0');
  assert.equal(w.update(-0.001), 0);
  assert.equal(w.update(0), 0);
  assert.equal(w.droppedTime, 0.75);
  assert.equal(stub.calls, 2);
});

test('non-finite or non-number time throws before the accumulator, steps or droppedTime move', async () => {
  const { w, stub } = await stubbed(1 / 8, 1);
  assert.equal(w.update(1), 1); // 3/4 dropped, 1/8 carried
  for (const bad of [NaN, Infinity, -Infinity, '1', null, undefined, 1n]) {
    assert.throws(() => w.update(bad as Any), RangeError, String(bad));
  }
  assert.equal(w.droppedTime, 0.75);
  assert.equal(stub.calls, 1);
  assert.equal(w.update(0), 1, 'the carry is exactly as the first update left it');
  assert.equal(w.droppedTime, 0.75);
});

test('a step that throws records no discard it did not reach; the existing owed time then runs', async () => {
  const { w, stub } = await stubbed(1 / 8, 2, [2]);
  assert.throws(() => w.update(1), /stub step failed/); // step 1 ran, step 2 threw: the clamp was never reached
  assert.equal(stub.calls, 2);
  assert.equal(w.droppedTime, 0);
  // Unchanged behaviour: the owed time (1 - 1/8) stays. A retry runs 2 steps, then 5/8 -> 1/8 carried, 1/2 dropped
  assert.equal(w.update(0), 2);
  assert.equal(w.droppedTime, 1 / 2);
});

test('the cumulative total overflows to Infinity, never NaN, and stays there', async () => {
  const { w } = await stubbed(1 / 8, 1);
  assert.equal(w.update(1.7e308), 1);
  assert.ok(Number.isFinite(w.droppedTime) && w.droppedTime > 1.6e308);
  assert.equal(w.update(1.7e308), 1); // the cumulative diagnostic exceeds the number range
  assert.equal(w.droppedTime, Infinity);
  assert.equal(w.update(1), 1);
  assert.equal(w.droppedTime, Infinity);
});

test('direct step() and destroy() leave the diagnostic alone; update after destroy throws', async () => {
  const { w } = await stubbed(1 / 8, 1);
  w.update(1);
  w.step();
  assert.equal(w.droppedTime, 0.75);
  w.destroy();
  assert.equal(w.droppedTime, 0.75, 'last value retained, like stepCount');
  assert.throws(() => w.update(1), /destroyed/);
  assert.equal(w.droppedTime, 0.75);
});
