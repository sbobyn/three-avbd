// The library (src/lib): only its public API, as a user would drive it, headless on Dawn.

import assert from 'node:assert/strict';
import { convexHull, World } from '../src/lib/index.ts';
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

gpuTest('three-avbd: a ball joint lets a box swing down on its pivot; a fixed joint holds it out', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  // A box held out 2 m sideways from a fixed pivot, by each kind of joint
  const arms = (['ball', 'fixed'] as const).map((type, k) => {
    const pivot = world.addBox({ size: [0.2, 0.2, 0.2], position: [0, 5, 4 * k], fixed: true })!;
    const box = world.addBox({ size: [0.5, 0.5, 0.5], position: [2, 5, 4 * k] })!;
    world.addJoint(pivot, box, { type, anchorB: [-2, 0, 0] });
    return box;
  });
  // Released level, the ball-jointed one swings through the bottom (after about 0.84 s)
  let lowest = Infinity;
  let reach = [Infinity, 0];
  for (let k = 0; k < 20; k++) {
    steps(world, 5);
    await world.read();
    const [x, y] = arms[0].position;
    lowest = Math.min(lowest, y);
    const r = Math.hypot(x, y - 5);
    reach = [Math.min(reach[0], r), Math.max(reach[1], r)];
    const fixed = arms[1].position;
    assert.ok(Math.abs(fixed[1] - 5) < 0.1 && Math.abs(fixed[0] - 2) < 0.05, `the fixed one is held out: ${fixed}`);
  }
  assert.ok(lowest < 3.1, `the ball-jointed box swung down to the bottom: lowest y ${lowest}`);
  assert.ok(reach[0] > 1.95 && reach[1] < 2.05, `and stayed 2 m from its pivot: ${reach}`);
  world.destroy();
});

gpuTest('three-avbd: a box on a spring oscillates about its equilibrium (mg/k below its rest length)', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const hook = world.addBox({ size: [0.2, 0.2, 0.2], position: [0, 5, 0], fixed: true })!;
  // 1 kg on 100 N/m, let go at its rest length (1 m): it swings between 0 and 2mg/k of stretch
  const box = world.addBox({ size: [1, 1, 1], position: [0, 4, 0] })!;
  const spring = world.addSpring(hook, box, { stiffness: 100 });
  assert.ok(Math.abs(spring.rest - 1) < 1e-6, `rest length from where it was added: ${spring.rest}`);
  // Mean over six periods (T = 2π√(m/k) = 0.628 s, 37.7 steps)
  let sum = 0;
  const n = 113;
  for (let k = 0; k < n; k++) {
    steps(world, 2);
    await world.read();
    sum += box.position[1];
  }
  const mean = sum / n;
  assert.ok(Math.abs(mean - (4 - 9.81 / 100)) < 0.02, `mean height ${mean}, equilibrium ${4 - 0.0981}`);
  world.destroy();
});

gpuTest('three-avbd: a hull is placed by its points\' frame, and a tetrahedron settles flat on a face', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  assert.ok(world.hullsEnabled, 'the test device allows hulls');
  world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true });
  // A corner of a cube: its centre of mass is a quarter of the way along each edge from the corner
  const points = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const shape = convexHull(points)!;
  const tetra = world.addHull({ shape, position: [0, 2, 0] })!;
  const c = tetra.position;
  assert.ok(Math.abs(c[0] - 0.25) < 1e-6 && Math.abs(c[1] - 2.25) < 1e-6 && Math.abs(c[2] - 0.25) < 1e-6, `at its centre of mass: ${c}`);
  steps(world, 180);
  await world.read();
  // Its vertices in the world: three on the ground (a face, flat), none below. As its bounding
  // box it would rest on a box face, with only the vertices on that face down
  const [p, q] = [tetra.position, tetra.rotation];
  const ys: number[] = [];
  for (let i = 0; i < shape.vertices.length / 3; i++) {
    const v = [shape.vertices[3 * i], shape.vertices[3 * i + 1], shape.vertices[3 * i + 2]];
    const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
    ys.push(p[1] + v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]));
  }
  assert.equal(ys.filter((y) => y < 0.03).length, 3, `three vertices on the ground: ${ys.map((y) => y.toFixed(3))}`);
  assert.ok(Math.min(...ys) > -0.03, 'none below it');
  world.destroy();
});

gpuTest('three-avbd: impulses change velocity (J/m) and, off-centre, spin (I⁻¹ r × J)', async (device) => {
  const world = await World.create({ device, maxBodies: 16, gravity: [0, 0, 0] });
  // 1 m cubes of 1 kg: I = m/6 about each axis
  const a = world.addBox({ size: [1, 1, 1], position: [0, 0, 0] })!;
  const b = world.addBox({ size: [1, 1, 1], position: [0, 0, 5] })!;
  a.applyImpulse([2, 0, 0]);
  b.applyImpulse([0, 1, 0], [0.5, 0, 5]);
  // Just after (the solver's implicit step then loses spin slowly: 0.1% a step)
  world.step();
  await world.read();
  const close = (u: number[], v: number[], tol: number) => u.every((x, i) => Math.abs(x - v[i]) < tol);
  assert.ok(close(a.velocity, [2, 0, 0], 1e-3), `through its centre: v ${a.velocity}`);
  assert.ok(close(a.angularVelocity, [0, 0, 0], 1e-3), `and no spin: ω ${a.angularVelocity}`);
  assert.ok(close(b.velocity, [0, 1, 0], 1e-3), `off-centre: v ${b.velocity}`);
  assert.ok(close(b.angularVelocity, [0, 0, 3], 0.005), `and spinning at r·J/I = 3 rad/s about z: ω ${b.angularVelocity}`);
  steps(world, 29);
  await world.read();
  assert.ok(Math.abs(a.position[0] - 1) < 0.01, `1 m in half a second: x ${a.position[0]}`);
  world.destroy();
});

gpuTest('three-avbd: a standing force holds a box up against gravity until cleared', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const box = world.addBox({ size: [1, 1, 1], position: [0, 5, 0] })!;
  box.applyForce([0, 9.81, 0]);
  steps(world, 60);
  await world.read();
  assert.ok(Math.abs(box.position[1] - 5) < 0.01, `held up: y ${box.position[1]}`);
  box.clearForces();
  steps(world, 30);
  await world.read();
  const fall = 5 - box.position[1];
  assert.ok(Math.abs(fall - 0.5 * 9.81 * 0.25) < 0.1, `then falls freely: ${fall} m in half a second`);
  world.destroy();
});
