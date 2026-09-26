// The library (src/lib): only its public API, as a user would drive it, headless on Dawn.

import assert from 'node:assert/strict';
import { World } from '../src/lib/index.ts';
import { gpuTest } from './device.ts';

const steps = (world: World, n: number) => {
  for (let k = 0; k < n; k++) world.step();
};

gpuTest('three-avbd: a box dropped on fixed ground comes to rest on it (y-up)', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true });
  const box = world.addBox({ size: [1, 1, 1], position: [0, 2, 0] })!;
  steps(world, 120);
  await world.read();
  const [x, y, z] = box.position;
  assert.ok(Math.abs(y - 0.5) < 0.05, `rests on the ground: y ${y}`);
  assert.ok(Math.abs(x) < 0.01 && Math.abs(z) < 0.01, `straight down: x ${x}, z ${z}`);
  assert.ok(Math.hypot(...box.velocity) < 0.05, `at rest: ${box.velocity}`);
  world.destroy();
});

gpuTest('three-avbd: a joint that breaks on pull lets go under load, and says so', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  // Two 1 kg boxes hanging from fixed blocks: one joint breaks past 2 N, the other never
  const hangs = [2, Infinity].map((breakForce, k) => {
    const hook = world.addBox({ size: [1, 1, 1], position: [4 * k, 5, 0], fixed: true })!;
    const box = world.addBox({ size: [1, 1, 1], position: [4 * k, 4, 0] })!;
    const joint = world.addJoint(hook, box, { anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0], breakForce, breakOnPull: true });
    return { box, joint };
  });
  const seen: unknown[] = [];
  world.onBreak((j) => seen.push(j));
  steps(world, 30);
  await world.read();
  assert.ok(hangs[0].joint.broken, 'the weak joint broke');
  assert.deepEqual(seen, [hangs[0].joint], 'onBreak told of it, once');
  assert.ok(hangs[1].joint.holding, 'the unbreakable joint holds');
  steps(world, 60);
  await world.read();
  assert.ok(hangs[0].box.position[1] < 3, `its box fell: y ${hangs[0].box.position[1]}`);
  assert.ok(Math.abs(hangs[1].box.position[1] - 4) < 0.05, `the other still hangs: y ${hangs[1].box.position[1]}`);
  world.destroy();
});

gpuTest('three-avbd: removed bodies free their slots for new ones', async (device) => {
  const world = await World.create({ device, maxBodies: 3 });
  const [a, b, c] = [0, 1, 2].map((k) => world.addBox({ size: [1, 1, 1], position: [3 * k, 5, 0] })!);
  assert.equal(world.addBox({ size: [1, 1, 1] }), null, 'full at maxBodies');
  steps(world, 5);
  b.remove();
  assert.ok(!b.alive);
  const d = world.addSphere({ radius: 0.5, position: [3, 10, 0] })!;
  assert.equal(d.index, b.index, "the new body takes the removed one's slot");
  assert.deepEqual(
    world.bodies.map((x) => x.index),
    [a.index, d.index, c.index],
  );
  steps(world, 30);
  await world.read();
  // Half a second of free fall from 10 m (it started where the parked body was not)
  const y = d.position[1];
  assert.ok(Math.abs(y - (10 - 0.5 * 9.81 * 0.5 ** 2)) < 0.15, `the new sphere falls from its own start: y ${y}`);
  assert.ok(Math.abs(d.position[0] - 3) < 1e-3, 'straight down');
  world.destroy();
});
