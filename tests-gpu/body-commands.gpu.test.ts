import assert from 'node:assert/strict';
import { World, type Body, type Quat, type Vec3 } from '../src/lib/world.ts';
import { B_ANGVEL, B_INITIAL_POS, B_INITIAL_ROT, B_INERTIAL_POS, B_INERTIAL_ROT, B_MOMENT, B_POS, B_ROT, B_SIZE, B_VEL, BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { gpuTest } from './device.ts';

const near = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 3e-4) => {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tolerance, `${i}: ${a[i]} vs ${b[i]}`);
};
const field = (data: Float32Array, body: Body, offset: number, n = 3) => Array.from(data.subarray(body.index * BODY_FLOATS + offset, body.index * BODY_FLOATS + offset + n));
const turnNear = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance = 3e-4) => {
  const sign = Array.from(a).reduce((sum, v, i) => sum + v * b[i], 0) < 0 ? -1 : 1;
  near(a, Array.from(b, v => v * sign), tolerance);
};
const steps = (w: World, n: number) => { for (let i = 0; i < n; i++) w.step(); };
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);
const slerp = (a: number[], b: number[], t: number) => {
  let dot = a.reduce((s, v, i) => s + v * b[i], 0);
  if (dot < 0) { b = b.map(v => -v); dot = -dot; }
  const angle = Math.acos(Math.min(1, dot));
  if (angle < 1e-5) return a;
  return a.map((v, i) => (v * Math.sin((1 - t) * angle) + b[i] * Math.sin(t * angle)) / Math.sin(angle));
};

// Read copies are queued at each boundary; no waits or hidden World observations during update.
function captureUpdate(w: World, count: number, after?: (step: number) => void) {
  const original = w.step.bind(w);
  const copies: Promise<Float32Array>[] = [];
  w.step = options => { original(options); copies.push(w.solver.readBodies()); after?.(copies.length); };
  try { assert.equal(w.update(count * w.dt), count); }
  finally { w.step = original; }
  return Promise.all(copies);
}

gpuTest('body commands: partial velocity and position keep unobserved GPU fields and fourth lanes', async device => {
  const w = await World.create({ device, maxBodies: 4 });
  try {
    const a = w.addBox({ size: [1, 2, 1], position: [0, 8, 0], angularVelocity: [0.3, 0.5, 0.2], friction: 0.7 })!;
    const b = w.addBox({ size: [1, 2, 1], position: [10, 8, 0], angularVelocity: [0.3, 0.5, 0.2], friction: 0.7 })!;
    steps(w, 20);
    const before = await w.solver.readBodies(); // Deliberately leaves Body observations stale.
    a.set({ velocity: field(before, a, B_VEL) as Vec3 });
    w.step();
    const data = await w.solver.readBodies();
    near(field(data, a, B_POS), field(data, b, B_POS).map((v, i) => v - (i === 0 ? 10 : 0)));
    turnNear(field(data, a, B_ROT, 4), field(data, b, B_ROT, 4));
    near(field(data, a, B_VEL), field(data, b, B_VEL));
    a.set({ position: [3, 7, 0] });
    await w.read([]); // Flush only, no simulation.
    const patched = await w.solver.readBodies();
    near(field(patched, a, B_VEL), field(data, a, B_VEL));
    near(field(patched, a, B_ANGVEL), field(data, a, B_ANGVEL));
    for (const o of [B_POS + 3, B_SIZE + 3, B_MOMENT + 3, B_ANGVEL + 3, B_VEL + 3, B_INERTIAL_POS + 3]) {
      assert.equal(patched[a.index * BODY_FLOATS + o], data[a.index * BODY_FLOATS + o], `lane ${o}`);
    }
    assert.equal(patched[a.index * BODY_FLOATS + B_INITIAL_POS + 3], 1);
    a.set({ rotation: [0, 0, 0, 2] });
    await w.read([]);
    const turned = await w.solver.readBodies();
    for (const offset of [B_ROT, B_INITIAL_ROT, B_INERTIAL_ROT]) near(field(turned, a, offset, 4), [0, 0, 0, 1]);
    near(field(turned, a, B_POS), field(patched, a, B_POS));
    near(field(turned, a, B_VEL), field(patched, a, B_VEL));
    near(field(turned, a, B_ANGVEL), field(patched, a, B_ANGVEL));
  } finally { w.destroy(); }
});

gpuTest('body commands: fixed transitions preserve GPU pose, geometry lanes and explicit mass', async device => {
  const w = await World.create({ device, maxBodies: 4 });
  try {
    const b = w.addBox({ size: [1, 2, 3], position: [0, 8, 0], angularVelocity: [1, 0.5, 0], friction: 0.8, massProperties: { mass: 7, moments: [3, 4, 5] } })!;
    steps(w, 20);
    const before = await w.solver.readBodies();
    b.setFixed(true);
    await w.read([]);
    const fixed = await w.solver.readBodies();
    near(field(fixed, b, B_POS), field(before, b, B_POS));
    turnNear(field(fixed, b, B_ROT, 4), field(before, b, B_ROT, 4));
    near(field(fixed, b, B_VEL), [0, 0, 0]);
    near(field(fixed, b, B_ANGVEL), [0, 0, 0]);
    assert.equal(fixed[B_SIZE + 3], 0);
    for (const o of [B_POS + 3, B_MOMENT + 3, B_ANGVEL + 3, B_VEL + 3]) assert.equal(fixed[o], before[o]);
    b.setFixed(false);
    await w.read([]);
    const dynamic = await w.solver.readBodies();
    assert.equal(dynamic[B_SIZE + 3], 7);
    near(field(dynamic, b, B_MOMENT), [3, 4, 5]);
    near(field(dynamic, b, B_POS), field(before, b, B_POS));
    w.step();
    await w.read();
    assert.ok(b.position[1] < before[B_POS + 1]);
  } finally { w.destroy(); }
});

gpuTest('body commands: freeze after unobserved contact rotation starts a multi-step move at the actual GPU pose', async device => {
  const w = await World.create({ device, maxBodies: 4 });
  try {
    w.addBox({ size: [20, 1, 20], position: [0, -0.5, 0], fixed: true });
    const b = w.addBox({ size: [2, 0.7, 1], position: [0, 1.2, 0], rotation: [0, 0, Math.sin(0.3), Math.cos(0.3)] })!;
    steps(w, 20);
    const initial = await w.solver.readBodies();
    const p = field(initial, b, B_POS), q = field(initial, b, B_ROT, 4);
    assert.ok(Math.abs(q[2] - Math.sin(0.3)) > 0.01, 'contact changed orientation without a World read');
    b.setFixed(true);
    const target: Vec3 = [2, 3, 0], rotation: Quat = [0, Math.sin(0.6), 0, Math.cos(0.6)];
    b.moveTo(target, rotation);
    const reading = w.read();
    const ray = w.raycast([p[0], p[1] + 5, p[2]], [0, -1, 0]);
    await Promise.all([reading, ray]);
    near(b.position, p);
    turnNear(b.rotation, q);
    const beforeSteps: Promise<Float32Array>[] = [];
    const solve = w.solver.step.bind(w.solver);
    w.solver.step = options => { beforeSteps.push(w.solver.readBodies()); solve(options); };
    let copies: Float32Array[];
    try { copies = await captureUpdate(w, 4); }
    finally { w.solver.step = solve; }
    const starts = await Promise.all(beforeSteps);
    starts.forEach((data, i) => {
      near(field(data, b, B_POS), mix(p, target, i / 4));
      turnNear(field(data, b, B_ROT, 4), slerp(q, rotation, i / 4));
      assert.ok(Math.hypot(...field(data, b, B_VEL)) > 0.1, 'including the final step: velocity is not cleared before solving');
    });
    copies.forEach((data, i) => {
      near(field(data, b, B_POS), mix(p, target, (i + 1) / 4));
      turnNear(field(data, b, B_ROT, 4), slerp(q, rotation, (i + 1) / 4));
      if (i < 3) assert.ok(Math.hypot(...field(data, b, B_VEL)) > 0.1, 'still moving before arrival');
    });
    near(field(copies[3], b, B_VEL), [0, 0, 0]);
    near(field(copies[3], b, B_ANGVEL), [0, 0, 0]);
    w.step();
    await w.read();
    near(b.position, target);
    turnNear(b.rotation, rotation);
  } finally { w.destroy(); }
});

gpuTest('body commands: mid-slide retarget uses the current GPU pose and arrival occurs after the final step', async device => {
  const w = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  try {
    const b = w.addBox({ size: [1, 1, 1], fixed: true })!;
    await w.read([]);
    const first: Quat = [0, 0, Math.sin(0.4), Math.cos(0.4)];
    const second: Quat = [0, Math.sin(0.5), 0, Math.cos(0.5)];
    b.moveTo([4, 0, 0], first);
    const copies = await captureUpdate(w, 4, i => { if (i === 1) b.moveTo([1, 4, 0], second); });
    const start = field(copies[0], b, B_POS), rotation = field(copies[0], b, B_ROT, 4);
    near(start, [1, 0, 0]);
    for (let i = 1; i < 4; i++) {
      near(field(copies[i], b, B_POS), mix(start, [1, 4, 0], i / 4));
      turnNear(field(copies[i], b, B_ROT, 4), slerp(rotation, second, i / 4));
    }
    w.step();
    await w.read();
    near(b.position, [1, 4, 0]);
    turnNear(b.rotation, second);
    near(b.velocity, [0, 0, 0]);
    near(b.angularVelocity, [0, 0, 0]);
  } finally { w.destroy(); }
});

gpuTest('body commands: pending reads preserve later overrides per field, empty set does not cancel a target', async device => {
  const w = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  try {
    const b = w.addBox({ size: [1, 1, 1], position: [0, 2, 0], velocity: [1, 0, 0] })!;
    steps(w, 3);
    const pending = w.read();
    b.set({ angularVelocity: [0, 0, 2] });
    b.set({ velocity: [3, 0, 0] });
    await pending;
    near(b.position, [3 * w.dt, 2, 0]);
    near(b.velocity, [3, 0, 0]);
    near(b.angularVelocity, [0, 0, 2]);
    b.setFixed(true);
    b.moveTo([2, 3, 0]);
    b.set({});
    await w.read();
    near(b.position, [3 * w.dt, 2, 0]);
    w.step();
    await w.read();
    near(b.position, [2, 3, 0]);
  } finally { w.destroy(); }
});

gpuTest('body commands: removed targets and patches never reach a replacement, toggles cancel movement', async device => {
  const w = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  try {
    const old = w.addBox({ size: [1, 1, 1], fixed: true })!;
    w.step();
    old.moveTo([10, 0, 0]);
    old.set({ velocity: [2, 0, 0] });
    old.moveTo([20, 0, 0]);
    old.remove();
    const b = w.addBox({ size: [1, 1, 1], position: [3, 0, 0], fixed: true })!;
    assert.equal(b.index, old.index);
    old.set({ position: [99, 0, 0] });
    w.step();
    await w.read();
    near(b.position, [3, 0, 0]);
    b.moveTo([9, 0, 0]);
    b.setFixed(false);
    w.step();
    await w.read();
    near(b.position, [3, 0, 0]);
  } finally { w.destroy(); }
});

gpuTest('body commands: a partial set invalidates manifold reuse', async device => {
  const w = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0], iterations: 0 });
  try {
    w.addBox({ size: [1, 1, 1], fixed: true });
    const b = w.addBox({ size: [1, 1, 1], position: [0.8, 0, 0] })!;
    w.step();
    assert.ok((await w.solver.readCounters()).pairs > 0);
    b.set({ position: [5, 0, 0] });
    w.step({ reuseManifolds: true });
    assert.equal((await w.solver.readCounters()).pairs, 0);
  } finally { w.destroy(); }
});

gpuTest('body commands: no-command steps add no command dispatch or body write; resources are reused and disposed', async device => {
  const w = await World.create({ device, maxBodies: 2, gravity: [0, 0, 0] });
  const queue = device.queue, write = queue.writeBuffer.bind(queue), create = device.createCommandEncoder.bind(device);
  const makeBuffer = device.createBuffer.bind(device), makeGroup = device.createBindGroup.bind(device);
  let commands = 0, bodyWrites = 0, buffers = 0, groups = 0, disposed = 0;
  try {
    const b = w.addBox({ size: [1, 1, 1], fixed: true, velocity: [1, 0, 0] })!;
    w.step();
    queue.writeBuffer = (buffer, ...args) => { if (buffer === w.solver.bodyBuffer) bodyWrites++; write(buffer, ...args); };
    device.createCommandEncoder = descriptor => { if (descriptor?.label === 'body commands') commands++; return create(descriptor); };
    device.createBuffer = descriptor => {
      const buffer = makeBuffer(descriptor);
      if (descriptor.label?.startsWith('body command')) {
        buffers++;
        const destroy = buffer.destroy.bind(buffer);
        buffer.destroy = () => { disposed++; destroy(); };
      }
      return buffer;
    };
    device.createBindGroup = descriptor => { groups++; return makeGroup(descriptor); };
    w.step();
    assert.equal(commands, 0); assert.equal(bodyWrites, 0); assert.equal(buffers, 0);
    await w.read();
    near(b.position, [2 * w.dt, 0, 0]); // Prescribed conveyor velocity survives.
    b.moveTo([1, 0, 0]);
    w.step();
    assert.equal(commands, 1); assert.equal(buffers, 2);
    const before = groups;
    b.moveTo([2, 0, 0]);
    w.step();
    assert.equal(commands, 2); assert.equal(buffers, 2); assert.equal(groups, before);
    bodyWrites = 0;
    w.step();
    assert.equal(commands, 2); assert.equal(bodyWrites, 0);
    w.destroy();
    assert.equal(disposed, 2);
  } finally {
    queue.writeBuffer = write; device.createCommandEncoder = create;
    device.createBuffer = makeBuffer; device.createBindGroup = makeGroup;
    w.destroy();
  }
});

gpuTest('body commands: a moveTo platform still carries a resting prop after read and ray flushes', async device => {
  const w = await World.create({ device, maxBodies: 4 });
  try {
    w.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
    const platform = w.addBox({ size: [4, 0.5, 4], position: [0, 1, 0], fixed: true })!;
    const prop = w.addBox({ size: [1, 1, 1], position: [0, 1.75, 0] })!;
    steps(w, 20);
    await w.read();
    const start = prop.position[0];
    for (let i = 1; i <= 40; i++) {
      platform.moveTo([i / 60, 1, 0]);
      if (i === 1) {
        await w.read();
        const hit = await w.raycast([1.5, 5, 0], [0, -1, 0]);
        assert.equal(hit?.body, platform);
        near(platform.position, [0, 1, 0]);
      }
      w.step();
    }
    await w.read();
    near(platform.position, [40 / 60, 1, 0]);
    assert.ok(prop.position[0] - start > 0.45, `carried ${prop.position[0] - start}`);
  } finally { w.destroy(); }
});

gpuTest('body commands: sphere and hull fixed transitions retain shape slots and restore geometric inertia', async device => {
  const w = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
  try {
    const sphere = w.addSphere({ radius: 0.5, position: [0, 3, 0], velocity: [1, 0, 0], friction: 0.3 })!;
    const points = [-1, 1].flatMap(x => [-1, 1].flatMap(y => [-1, 1].flatMap(z => [x, y, z])));
    const hull = w.addHull({ points, position: [10, 3, 0], angularVelocity: [0, 1, 0], friction: 0.7 })!;
    steps(w, 3);
    const before = await w.solver.readBodies();
    for (const b of [sphere, hull]) b.setFixed(true);
    await w.read([]);
    const fixed = await w.solver.readBodies();
    for (const b of [sphere, hull]) {
      near(field(fixed, b, B_POS), field(before, b, B_POS));
      turnNear(field(fixed, b, B_ROT, 4), field(before, b, B_ROT, 4));
      assert.equal(fixed[b.index * BODY_FLOATS + B_SIZE + 3], 0);
      assert.equal(fixed[b.index * BODY_FLOATS + B_ANGVEL + 3], before[b.index * BODY_FLOATS + B_ANGVEL + 3]);
      b.setFixed(false);
    }
    await w.read([]);
    const restored = await w.solver.readBodies();
    for (const b of [sphere, hull]) {
      near(field(restored, b, B_MOMENT, 4), field(before, b, B_MOMENT, 4));
      assert.equal(restored[b.index * BODY_FLOATS + B_SIZE + 3], before[b.index * BODY_FLOATS + B_SIZE + 3]);
      assert.equal(restored[b.index * BODY_FLOATS + B_ANGVEL + 3], before[b.index * BODY_FLOATS + B_ANGVEL + 3]);
    }
  } finally { w.destroy(); }
});
