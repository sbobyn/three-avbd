// The library (src/lib): only its public API, as a user would drive it, headless on Dawn.

import assert from 'node:assert/strict';
import { type ContactEvent, convexHull, World } from '../src/lib/index.ts';
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

gpuTest('three-avbd: raycasts find the nearest body and its surface (box, sphere, turned box, hull)', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const ground = world.addBox({ size: [20, 1, 20], position: [0, -0.5, 0], fixed: true })!;
  const box = world.addBox({ size: [1, 1, 1], position: [0, 0.5, 0], fixed: true })!;
  const ball = world.addSphere({ radius: 0.5, position: [3, 0.5, 0], fixed: true })!;
  // 2 m long in x, turned a quarter about y: long in z, its +z end at z = 1
  const turned = world.addBox({ size: [2, 1, 1], position: [-3, 0.5, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], fixed: true })!;
  // A corner of a cube (faces x = 0, y = 0, z = 0 and x + y + z = 1), its corner at (6, 0, 0)
  const tetra = world.addHull({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], position: [6, 0, 0], fixed: true })!;
  const close = (u: ArrayLike<number>, v: number[], tol = 1e-4) => Array.from(u).every((x, i) => Math.abs(x - v[i]) < tol);
  const show = (h: { body: { index: number } | null; distance: number; normal: number[] } | null) => (h ? `body ${h.body?.index} at ${h.distance}, normal ${h.normal}` : 'none');
  const [onBox, onBall, onTurned, onTetra, up] = await world.raycasts([
    { origin: [0, 5, 0], direction: [0, -1, 0] },
    { origin: [3, 5, 0], direction: [0, -2, 0] },
    { origin: [-3, 0.5, 5], direction: [0, 0, -1] },
    { origin: [6.2, 5, 0.2], direction: [0, -1, 0] },
    { origin: [0, 5, 0], direction: [0, 1, 0] },
  ]);
  assert.ok(onBox && onBox.body === box && close([onBox.distance], [4]) && close(onBox.normal, [0, 1, 0]), `the box's top: ${show(onBox)}`);
  assert.ok(onBall && onBall.body === ball && close([onBall.distance], [4]) && close(onBall.normal, [0, 1, 0]), `the sphere's top: ${show(onBall)}`);
  assert.ok(onTurned && onTurned.body === turned && close([onTurned.distance], [4]) && close(onTurned.normal, [0, 0, 1]), `the turned box's end: ${show(onTurned)}`);
  const s = 1 / Math.sqrt(3);
  assert.ok(onTetra && onTetra.body === tetra && close([onTetra.distance], [4.4]) && close(onTetra.normal, [s, s, s]), `the hull's slanted face: ${show(onTetra)}`);
  assert.ok(close(onTetra!.point, [6.2, 0.6, 0.2]), `at ${onTetra!.point}`);
  assert.equal(up, null, 'nothing above');
  assert.equal(await world.raycast([0, 5, 0], [0, -1, 0], { maxDistance: 3 }), null, 'out of reach');
  const through = await world.raycast([0, 5, 0], [0, -1, 0], { ignore: [box] });
  assert.ok(through && through.body === ground && close([through.distance], [5]), `ignoring the box, the ground: ${show(through)}`);
  world.destroy();
});

gpuTest('three-avbd: collision groups: a body only meets the groups it collides with (and so do rays)', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true });
  const ghost = world.addBox({ size: [1, 1, 1], position: [3, 2, 0], collidesWith: 0 })!;
  // a in group 2, resting on the ground; b above it colliding with everything but group 2
  const a = world.addBox({ size: [1, 1, 1], position: [0, 0.5, 0], group: 2 })!;
  const b = world.addBox({ size: [1, 1, 1], position: [0, 2.5, 0], collidesWith: ~2 })!;
  steps(world, 120);
  await world.read();
  assert.ok(ghost.position[1] < -2, `the ghost fell through the ground: y ${ghost.position[1]}`);
  assert.ok(Math.abs(a.position[1] - 0.5) < 0.02, `a rests on the ground: y ${a.position[1]}`);
  assert.ok(Math.abs(b.position[1] - 0.5) < 0.02 && Math.abs(b.position[0]) < 0.02, `b fell through a onto the ground: ${b.position}`);
  // Rays see only the groups asked for: the same spot, a different body
  const [inGroup1, inGroup2] = await Promise.all([1, 2].map((collidesWith) => world.raycast([0, 5, 0], [0, -1, 0], { collidesWith })));
  assert.equal(inGroup1?.body, b, 'group 1: b');
  assert.equal(inGroup2?.body, a, 'group 2: a');
  // Changed on the way down, it takes from the next step: falling through nothing, then onto the ground
  // (From low: a fast landing sinks in, to come out over many steps: no continuous collision yet)
  const late = world.addBox({ size: [1, 1, 1], position: [-3, 3, 0], collidesWith: 0 })!;
  steps(world, 10);
  late.setCollisionGroups(1, 0xffffffff);
  steps(world, 120);
  await world.read();
  // (As the first test: a landing settles within 5 cm of resting height)
  assert.ok(Math.abs(late.position[1] - 0.5) < 0.05, `it lands on the ground once it collides: y ${late.position[1]}`);
  world.destroy();
});

gpuTest('three-avbd: a fixed body moved each step (moveTo) carries what rests on it: a conveyor and an elevator', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
  const slide = world.addBox({ size: [4, 0.5, 4], position: [0, 1, 0], fixed: true })!;
  const lift = world.addBox({ size: [4, 0.5, 4], position: [10, 1, 0], fixed: true })!;
  const onSlide = world.addBox({ size: [1, 1, 1], position: [0, 1.75, 0] })!;
  const onLift = world.addBox({ size: [1, 1, 1], position: [10, 1.75, 0] })!;
  steps(world, 30);
  await world.read();
  const [x0, y0] = [onSlide.position[0], onLift.position[1]];
  // One second: the slide at 1 m/s along x, the lift up at 0.5 m/s
  for (let k = 1; k <= 60; k++) {
    slide.moveTo([k / 60, 1, 0]);
    lift.moveTo([10, 1 + 0.5 * (k / 60), 0]);
    world.step();
  }
  await world.read();
  const carried = onSlide.position[0] - x0;
  assert.ok(carried > 0.8 && carried < 1.02, `friction carried the box along: ${carried} m (the slide went 1 m)`);
  assert.ok(Math.abs(onLift.position[1] - y0 - 0.5) < 0.05, `the lift raised its box 0.5 m: ${onLift.position[1] - y0}`);
  assert.ok(Math.abs(slide.position[0] - 1) < 1e-4, `the slide is where it was moved: ${slide.position}`);
  // A door swung a quarter turn about y over a second ends up turned a quarter
  const door = world.addBox({ size: [2, 2, 0.1], position: [-10, 1, 0], fixed: true })!;
  world.step();
  for (let k = 1; k <= 60; k++) {
    const a = (Math.PI / 2) * (k / 60);
    door.moveTo([-10, 1, 0], [0, Math.sin(a / 2), 0, Math.cos(a / 2)]);
    world.step();
  }
  await world.read();
  const q = door.rotation;
  const angle = 2 * Math.atan2(q[1], q[3]);
  assert.ok(Math.abs(angle - Math.PI / 2) < 0.01 && Math.abs(q[0]) < 1e-3 && Math.abs(q[2]) < 1e-3, `turned a quarter about y: ${q}`);
  world.destroy();
});

gpuTest('three-avbd: read(bodies) reads back only those bodies; track() narrows the automatic readback', async (device) => {
  const world = await World.create({ device, maxBodies: 16, gravity: [0, 0, 0] });
  // Five bodies drifting up at 1 m/s; a and c are not neighbours, and d, e are (one run)
  const [a, b, c, d, e] = [0, 1, 2, 3, 4].map((k) => world.addBox({ size: [1, 1, 1], position: [3 * k, 0, 0], velocity: [0, 1, 0] })!);
  steps(world, 60);
  await world.read([a, c, d, e]);
  for (const body of [a, c, d, e]) assert.ok(Math.abs(body.position[1] - 1) < 0.02, `read: ${body.position}`);
  assert.strictEqual(b.position[1], 0, 'b was not read: still as it was added');
  assert.deepStrictEqual([a, c, d, e].map((x) => x.position[0]), [0, 6, 9, 12], 'each read record went to its own body');
  await world.read();
  assert.ok(Math.abs(b.position[1] - 1) < 0.02, `a full read: ${b.position}`);
  // Tracking a only: the automatic readback leaves the others where the last read had them
  world.readbackEvery = 60;
  world.track([a]);
  steps(world, 60);
  await world.read([]); // (waits for the automatic read the last step started)
  assert.ok(Math.abs(a.position[1] - 2) < 0.05, `a tracked: ${a.position}`);
  assert.ok(Math.abs(b.position[1] - 1) < 0.02, `b untracked: ${b.position}`);
  world.destroy();
});

gpuTest('three-avbd: contact events: a reporting box landing begins once (how hard), rests quietly, and ends when lifted', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const ground = world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true })!;
  // 1 kg falling 1.25 m: 5 m/s at impact. A second box nearby, not reporting, lands unheard.
  const box = world.addBox({ size: [1, 1, 1], position: [0, 1.75, 0], reportContacts: true })!;
  world.addBox({ size: [1, 1, 1], position: [5, 1.75, 0] });
  const events: ContactEvent[] = [];
  world.onContact((e) => events.push(e));
  steps(world, 120);
  await world.read();
  assert.strictEqual(events.length, 1, `one event: ${events.map((e) => `${e.type}@${e.step}`)}`);
  const [hit] = events;
  assert.ok(hit.type === 'begin' && new Set([hit.a, hit.b]).has(box) && new Set([hit.a, hit.b]).has(ground), 'box and ground began touching');
  // It lands after about sqrt(2 * 1.25 / 9.81) = 0.505 s, step 30
  assert.ok(Math.abs(hit.step - 30) <= 2, `when: step ${hit.step}`);
  assert.ok(Math.abs(hit.point[1]) < 0.05 && Math.abs(hit.point[0]) < 0.6, `where: ${hit.point}`);
  const up = hit.a === box ? 1 : -1;
  assert.ok(Math.abs(hit.normal[1] * up - 1) < 1e-3, `the normal points from b to a: ${hit.normal}`);
  assert.ok(hit.impulse > 4 && hit.impulse < 6.5, `how hard: ${hit.impulse} N·s (m v = 5)`);
  // Lifted off: it ends; then stops reporting, so landing again is unheard
  box.set({ position: [0, 3, 0], velocity: [0, 0, 0] });
  steps(world, 5);
  await world.read();
  assert.deepStrictEqual(events.slice(1).map((e) => e.type), ['end'], 'lifted: an end');
  box.reportContacts = false;
  steps(world, 120);
  await world.read();
  assert.strictEqual(events.length, 2, 'no longer reporting');
  // Removed while touching, its slot reused at once: the end is the removed box's, not the newcomer's
  box.reportContacts = true;
  steps(world, 5);
  await world.read();
  events.length = 0;
  box.remove();
  const newcomer = world.addBox({ size: [1, 1, 1], position: [0, 10, 0] })!;
  assert.strictEqual(newcomer.index, box.index, 'the slot is reused');
  steps(world, 2);
  await world.read();
  assert.deepStrictEqual(events.map((e) => [e.type, e.a === box || e.b === box]), [['end', true]], 'the removed box stopped touching');
  assert.strictEqual(world.droppedContactEvents, 0);
  world.destroy();
});

/** The angle (degrees) of the turn between two orientations (x, y, z, w). */
function between(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const w = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return (2 * Math.acos(Math.min(1, w)) * 180) / Math.PI;
}

gpuTest('three-avbd: a joint with rest: \'current\' (or a rotation) holds the turn its bodies had when it was added, where the default twists them', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  // Two cubes in free fall, spinning, B turned 30° about y from A and touching it at a shared face
  const pairs = (rest: 'current' | number[] | undefined, x: number) => {
    const h = Math.PI / 12;
    const turned: [number, number, number, number] = [0, Math.sin(h), 0, Math.cos(h)];
    const a = world.addBox({ size: [1, 1, 1], position: [x, 20, 0], angularVelocity: [1, 2, 3] })!;
    // B's centre: A's anchor (0.5, 0, 0) plus B's own half-width turned 30° about y
    const b = world.addBox({ size: [1, 1, 1], position: [x + 0.5 + 0.5 * Math.cos(2 * h), 20, -0.5 * Math.sin(2 * h)], rotation: turned, angularVelocity: [1, 2, 3] })!;
    const joint = world.addJoint(a, b, { anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0], rest: rest as 'current' });
    return { a, b, joint };
  };
  const current = pairs('current', 0);
  const given = pairs([0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)], 10);
  const twisted = pairs(undefined, 20);
  for (let k = 0; k < 60; k++) world.step();
  await world.read();
  for (const [name, p] of [['current', current], ['a given rotation', given]] as const) {
    const turn = between(p.a.rotation, p.b.rotation);
    assert.ok(Math.abs(turn - 30) < 0.1, `${name}: ${turn.toFixed(3)}°`);
  }
  assert.ok(between(twisted.a.rotation, twisted.b.rotation) < 20, `the default twists them toward equal: ${between(twisted.a.rotation, twisted.b.rotation).toFixed(1)}°`);
  // The convention: b = a·rest (the product, a first), whatever the two have tumbled to
  const [qa, qr] = [current.a.rotation, current.joint.restRotation!];
  const product = [
    qa[3] * qr[0] + qa[0] * qr[3] + qa[1] * qr[2] - qa[2] * qr[1],
    qa[3] * qr[1] - qa[0] * qr[2] + qa[1] * qr[3] + qa[2] * qr[0],
    qa[3] * qr[2] + qa[0] * qr[1] - qa[1] * qr[0] + qa[2] * qr[3],
    qa[3] * qr[3] - qa[0] * qr[0] - qa[1] * qr[1] - qa[2] * qr[2],
  ];
  assert.ok(between(product, current.b.rotation) < 0.1, `b is a·rest: ${between(product, current.b.rotation).toFixed(3)}° off`);
  assert.ok(Math.abs(between(current.joint.restRotation!, [0, Math.sin(Math.PI / 12), 0, Math.cos(Math.PI / 12)])) < 1e-4, 'the handle says the turn it holds');
  assert.equal(twisted.joint.restRotation, null);
  // A joint that never yielded has not bent: exactly, whatever turn it was made to hold
  await world.readJoints();
  assert.equal(current.joint.bend, 0);
  assert.equal(given.joint.bend, 0);
  assert.equal(twisted.joint.bend, 0);
  // A ball joint has no angle lock to hold a turn or to bend
  assert.throws(() => world.addJoint(current.a, current.b, { type: 'ball', rest: 'current' }), /ball joint/);
  assert.throws(() => world.addJoint(current.a, current.b, { type: 'ball', yieldForce: 5 }), /ball joint/);
  assert.throws(() => world.addJoint(current.a, current.b, { yieldForce: -1 }), /at least 0/);
  world.destroy();
});

gpuTest('three-avbd: a joint with a yieldForce bends under a load and keeps the bend when it goes; Joint.force and Joint.bend read it', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  // A cantilever along x (y up): a fixed wall, four links of 1 m welded end to end, a 12 kg weight on the end
  const wall = world.addBox({ size: [1, 1, 1], position: [-0.5, 5, 0], fixed: true })!;
  const links = [0, 1, 2, 3].map((i) => world.addBox({ size: [1, 0.3, 0.3], position: [i + 0.5, 5, 0] })!);
  const weight = world.addBox({ size: [0.6, 0.6, 0.6], density: 12 / 0.216, position: [4.3, 5, 0] })!;
  const yieldForce = 60;
  const welds = [wall, ...links].slice(0, 4).map((a, i) => world.addJoint(a, links[i], { anchorA: [0.5, 0, 0], anchorB: [-0.5, 0, 0], yieldForce: i === 0 ? yieldForce : undefined }));
  const load = world.addJoint(links[3], weight, { anchorA: [0.5, 0, 0], anchorB: [-0.3, 0, 0] });
  let carried = 0;
  for (let k = 0; k < 600; k++) {
    world.step();
    if (k % 10 === 0) {
      await world.read();
      carried = Math.max(carried, welds[0].force.angular);
    }
  }
  await world.read();
  const turn = (q: ArrayLike<number>) => (2 * Math.atan2(-q[2], q[3]) * 180) / Math.PI;
  const bent = turn(links[0].rotation);
  assert.ok(bent > 25, `the wall's weld gave under the load: ${bent.toFixed(1)}°`);
  assert.ok(Math.abs((welds[0].bend * 180) / Math.PI - bent) < 2, `Joint.bend says by how much: ${((welds[0].bend * 180) / Math.PI).toFixed(1)}°`);
  assert.ok(carried <= yieldForce * 1.0001 && carried > 0.8 * yieldForce, `carrying no more than its yield: ${carried.toFixed(1)}`);
  assert.equal(welds[1].bend, 0, 'the others never gave');
  assert.ok(welds[0].holding && !welds[0].broken);
  // The load is cut loose: the bend stays
  load.remove();
  weight.remove();
  for (let k = 0; k < 300; k++) world.step();
  await world.read();
  assert.ok(Math.abs(turn(links[0].rotation) - bent) < 0.5, `bent ${bent.toFixed(1)}° with the load, ${turn(links[0].rotation).toFixed(1)}° without`);
  world.destroy();
});

gpuTest('three-avbd: readJoints says what a joint carries: its pull (N), and joints that never break need not be watched', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const hook = world.addBox({ size: [1, 1, 1], position: [0, 5, 0], fixed: true })!;
  const box = world.addBox({ size: [1, 1, 1], position: [0, 4, 0] })!;
  const joint = world.addJoint(hook, box, { anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0] });
  const spring = world.addSpring(hook, world.addBox({ size: [1, 1, 1], position: [4, 4, 0] })!, { stiffness: 100 });
  assert.deepEqual(joint.force, { linear: 0, angular: 0 }, 'nothing read yet');
  for (let k = 0; k < 120; k++) world.step();
  await world.readJoints();
  // A 1 kg box hangs 9.81 N on it, and no torque (it hangs straight)
  assert.ok(Math.abs(joint.force.linear - 9.81) < 0.5, `pull ${joint.force.linear.toFixed(2)} N`);
  assert.ok(joint.force.angular < 0.5, `torque ${joint.force.angular}`);
  assert.equal(joint.bend, 0);
  assert.deepEqual(spring.force, { linear: 0, angular: 0 }, 'a spring has no multipliers');
  world.destroy();
});
