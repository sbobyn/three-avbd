// World contracts from the 2026-10-31 audit (docs/audit-remediation.md): joint slots reused in
// the frame they are released (A2), contact set overflow (A3), reads for bodies a read in flight
// does not hold (A5), use after destroy (A6), and a reproducer for the contact-reuse hypothesis
// on rewritten slots (AH-1). Public API, except where a counter or contact list is the evidence.

import assert from 'node:assert/strict';
import { type ContactEvent, World } from '../src/lib/index.ts';
import { gpuTest } from './device.ts';

const steps = (world: World, n: number) => {
  for (let k = 0; k < n; k++) world.step();
};

/** Three pairs of overlapping boxes, far apart, that never move (no gravity, no iterations). */
async function pairsWorld(device: GPUDevice) {
  const world = await World.create({ device, maxBodies: 16, gravity: [0, 0, 0], iterations: 0 });
  const pair = (x: number) => [world.addBox({ size: [1, 1, 1], position: [x, 0, 0] })!, world.addBox({ size: [1, 1, 1], position: [x + 0.9, 0, 0] })!];
  const [ab, cd, ef] = [pair(0), pair(10), pair(20)];
  /** Broadphase pairs after a step: the overlapping pairs no joint keeps apart. */
  const count = async () => {
    world.step();
    const c = await world.solver.readCounters();
    assert.equal(c.overflow, 0);
    return c.pairs;
  };
  return { world, ab, cd, ef, count };
}

// --- A2: joint slots released and reused in one frame -----------------------------------------

gpuTest('world contracts: a joint slot released and reused in the same frame keeps only the new pair apart', async (device) => {
  const { world, ab, cd, count } = await pairsWorld(device);
  const old = world.addJoint(ab[0], ab[1]);
  assert.equal(await count(), 2, 'a, b jointed: only c-d and e-f');
  old.remove();
  const fresh = world.addJoint(cd[0], cd[1]);
  assert.equal(await count(), 2, 'a-b collides again, c-d is kept apart');
  assert.equal(fresh.slot, old.slot, 'the new joint took the released slot');
  const contacts = await world.solver.readContactList();
  assert.ok(contacts.some((k) => [k.a, k.b].includes(ab[0].index) && [k.a, k.b].includes(ab[1].index)), 'old pair has contacts');
  assert.ok(!contacts.some((k) => [k.a, k.b].includes(cd[0].index) && [k.a, k.b].includes(cd[1].index)), 'new pair has no contacts');
  world.destroy();
});

gpuTest('world contracts: a slot placed, released and reused again before the next step keeps only the last pair apart', async (device) => {
  const { world, ab, cd, ef, count } = await pairsWorld(device);
  const first = world.addJoint(ab[0], ab[1]);
  assert.equal(await count(), 2);
  first.remove();
  const second = world.addJoint(cd[0], cd[1]);
  // A read flushes the queue, placing the joint without a step (its no-collide entry pending)
  const reading = world.read([]);
  assert.equal(second.slot, first.slot);
  second.remove();
  const third = world.addJoint(ef[0], ef[1]);
  await reading;
  assert.equal(await count(), 2, 'a-b and c-d collide; only e-f is kept apart');
  assert.equal(third.slot, first.slot);
  world.destroy();
});

gpuTest('world contracts: a spring that takes a released joint slot keeps only its own pair apart', async (device) => {
  const { world, ab, cd, count } = await pairsWorld(device);
  const joint = world.addJoint(ab[0], ab[1]);
  assert.equal(await count(), 2);
  joint.remove();
  const spring = world.addSpring(cd[0], cd[1], { stiffness: 10 });
  assert.equal(await count(), 2, 'a-b collides again, c-d is kept apart');
  assert.equal(spring.slot, joint.slot);
  world.destroy();
});

gpuTest('world contracts: a joint seen broken at a readback frees its pair, even when its slot is reused that frame', async (device) => {
  const { world, ab, cd, count } = await pairsWorld(device);
  const broken: unknown[] = [];
  world.onBreak((j) => broken.push(j));
  const joint = world.addJoint(ab[0], ab[1], { breakForce: 1e6 });
  assert.equal(await count(), 2);
  // As the solver breaks a joint: its penalties zeroed on the GPU
  world.solver.disableConstraint(joint.slot);
  await world.read();
  assert.deepEqual(broken, [joint], 'the readback saw it broken and released it');
  const fresh = world.addJoint(cd[0], cd[1]);
  assert.equal(await count(), 2, 'a-b collides, c-d is kept apart');
  assert.equal(fresh.slot, joint.slot);
  world.destroy();
});

// --- A3: contact set overflow ------------------------------------------------------------------

gpuTest('world contracts: a contact set overflow is counted, the set grows, and events then go quiet', async (device) => {
  // 100 reporting boxes resting apart on the ground: 100 pairs, against sets sized for 1 (64 slots)
  const world = await World.create({ device, maxBodies: 128, maxContactPairs: 1 });
  world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
  const boxes = Array.from({ length: 100 }, (_, k) => world.addBox({ size: [1, 1, 1], position: [2 * (k % 10) - 9, 0.5, 2 * Math.floor(k / 10) - 9], reportContacts: true })!);
  const events: ContactEvent[] = [];
  world.onContact((e) => events.push(e));
  steps(world, 60);
  await world.read();
  assert.ok(world.solver.manifoldCapacity > 64, `the solver holds every pair: ${world.solver.manifoldCapacity}`);
  assert.ok(world.contactSetOverflows >= 1, 'the overflow is counted');
  const overflows = world.contactSetOverflows;

  // Resized before the next step: the fresh sets see every resting pair begin once, then nothing
  events.length = 0;
  const dropped = world.droppedContactEvents;
  steps(world, 60);
  await world.read();
  assert.equal(world.contactSetOverflows, overflows, 'no overflow after the resize');
  assert.ok(events.every((e) => e.type === 'begin'), `only begins at the resize: ${[...new Set(events.map((e) => e.type))]}`);
  const begun = new Map<unknown, number>();
  for (const e of events) for (const b of [e.a, e.b]) if (boxes.includes(b)) begun.set(b, (begun.get(b) ?? 0) + 1);
  assert.ok([...begun.values()].every((n) => n === 1), 'each box begins at most once');

  events.length = 0;
  steps(world, 60);
  await world.read();
  assert.deepEqual(events, [], 'resting quietly: no events');
  assert.equal(world.contactSetOverflows, overflows);
  assert.equal(world.droppedContactEvents, dropped, 'nothing more dropped');
  world.destroy();
});

// --- A5: reads for bodies the read in flight does not hold --------------------------------------

gpuTest('world contracts: read(bodies) during a read of other bodies still reads them', async (device) => {
  const world = await World.create({ device, maxBodies: 16, gravity: [0, 0, 0] });
  const [a, b, c] = [0, 1, 2].map((k) => world.addBox({ size: [1, 1, 1], position: [3 * k, 0, 0], velocity: [0, 1, 0] })!);
  steps(world, 60);
  const first = world.read([a]);
  const second = world.read([b]);
  await second;
  assert.ok(Math.abs(b.position[1] - 1) < 0.02, `b was read: ${b.position}`);
  await first;
  assert.ok(Math.abs(a.position[1] - 1) < 0.02, `a was read: ${a.position}`);
  // A full read while a subset read is in flight reads everyone
  steps(world, 60);
  const subset = world.read([a]);
  await world.read();
  assert.ok(Math.abs(c.position[1] - 2) < 0.03, `c was read by the full read: ${c.position}`);
  await subset;
  world.destroy();
});

gpuTest('world contracts: read(bodies) for a body written since the read in flight began reads it again', async (device) => {
  const world = await World.create({ device, maxBodies: 16, gravity: [0, 0, 0] });
  const a = world.addBox({ size: [1, 1, 1], position: [0, 0, 0], velocity: [0, 1, 0] })!;
  steps(world, 60);
  const before = world.read([a]);
  a.set({ position: [0, 10, 0] });
  world.step();
  await world.read([a]);
  assert.ok(Math.abs(a.position[1] - (10 + 1 / 60)) < 0.01, `a as the GPU has it after the write and a step: ${a.position}`);
  await before;
  world.destroy();
});

// --- A6: use after destroy ----------------------------------------------------------------------

gpuTest('world contracts: after destroy the world refuses use, retained handles included, and destroy is idempotent', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  const a = world.addBox({ size: [1, 1, 1], position: [0, 0, 0] })!;
  const b = world.addBox({ size: [1, 1, 1], position: [2, 0, 0] })!;
  const joint = world.addJoint(a, b);
  world.step();
  world.destroy();
  world.destroy();
  const gone = /World destroyed/;
  assert.throws(() => world.step(), gone);
  assert.throws(() => world.update(1), gone);
  assert.throws(() => world.addBox({ size: [1, 1, 1] }), gone);
  assert.throws(() => world.addSphere({ radius: 1 }), gone);
  assert.throws(() => world.addJoint(a, b), gone);
  assert.throws(() => world.addSpring(a, b, { stiffness: 1 }), gone);
  const position = a.position, fixed = a.fixed, group = a.group, reports = a.reportContacts;
  assert.throws(() => a.set({ position: [99, 99, 99] }), gone);
  assert.throws(() => a.setFixed(!fixed), gone);
  assert.throws(() => a.moveTo([99, 99, 99]), gone);
  assert.throws(() => a.setCollisionGroups(group + 1), gone);
  assert.throws(() => { a.reportContacts = !reports; }, gone);
  assert.throws(() => a.applyImpulse([1, 0, 0]), gone);
  assert.throws(() => a.applyAngularImpulse([1, 0, 0]), gone);
  assert.throws(() => a.applyForce([1, 0, 0]), gone);
  assert.throws(() => a.applyTorque([1, 0, 0]), gone);
  assert.throws(() => a.clearForces(), gone);
  assert.deepEqual(a.position, position);
  assert.equal(a.fixed, fixed);
  assert.equal(a.group, group);
  assert.equal(a.reportContacts, reports);
  assert.throws(() => a.remove(), gone);
  assert.throws(() => joint.remove(), gone);
  assert.ok(a.alive && joint.holding, 'a refused removal leaves the handles as they were');
  await assert.rejects(world.read(), gone);
  await assert.rejects(world.read([a]), gone);
  await assert.rejects(world.readJoints(), gone);
  await assert.rejects(world.raycast([0, 5, 0], [0, -1, 0]), gone);
  await assert.rejects(world.raycasts([{ origin: [0, 5, 0], direction: [0, -1, 0] }]), gone);
});

gpuTest('world contracts: reads in flight at destroy settle (reject) and touch no destroyed buffer', async (device) => {
  const world = await World.create({ device, maxBodies: 16 });
  world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true });
  const a = world.addBox({ size: [1, 1, 1], position: [0, 0.5, 0], reportContacts: true })!;
  const b = world.addBox({ size: [1, 1, 1], position: [0, 1.5, 0] })!;
  const c = world.addBox({ size: [1, 1, 1], position: [3, 0.5, 0] })!;
  // Breakable, so the read decodes joints and would release the broken one
  const joint = world.addJoint(a, b, { breakForce: 1e6 });
  steps(world, 10);
  world.solver.disableConstraint(joint.slot);
  // A read of a (which also decodes the joints and the contact events), and one of c chained after it
  const first = world.read([a]);
  const chained = world.read([c]);
  world.destroy();
  // gpuTest fails on any uncaptured GPU error, such as a write to a destroyed joint buffer
  await assert.rejects(first, /World destroyed/);
  await assert.rejects(chained, /World destroyed/);
  assert.ok(joint.holding, 'nothing applied after destroy');
});

// --- AH-1 rewritten-slot contact history ------------------------------------------------------

for (const reuseContacts of [true, false]) gpuTest(`world contracts (AH-1): rewritten body gets fresh contacts (reuse=${reuseContacts})`, async (device) => {
  // A packed body record leaves inertialPos.w (the step it last moved, refsWGSL) at 0, and the
  // reference pose stays the old occupant's: a rewrite at the same pose may let the narrowphase
  // keep the old pair's points (reuseContacts). A fresh world with the bigger box is the control.
  const make = async () => {
    const world = await World.create({ device, maxBodies: 8 });
    world.solver.params.reuseContacts = reuseContacts;
    world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true });
    return world;
  };
  const world = await make();
  const small = world.addBox({ size: [1, 1, 1], position: [0, 0.5, 0] })!;
  steps(world, 100);
  small.remove();
  const big = world.addBox({ size: [2, 2, 2], position: [0, 0.5, 0] })!;
  assert.equal(big.index, small.index, 'the slot is rewritten in place');
  world.step();
  const rewritten = (await world.solver.readContactList()).filter((k) => k.a === big.index || k.b === big.index);

  const control = await make();
  const fresh = control.addBox({ size: [2, 2, 2], position: [0, 0.5, 0] })!;
  control.step();
  const expected = (await control.solver.readContactList()).filter((k) => k.a === fresh.index || k.b === fresh.index);

  const arm = (list: typeof rewritten, index: number) => list.map((k) => (k.a === index ? k.rA : k.rB)[1]).sort((x, y) => x - y);
  assert.equal(rewritten.length, expected.length, `contact count: ${rewritten.length} rewritten, ${expected.length} fresh`);
  assert.ok(arm(expected, fresh.index).every((y) => Math.abs(y + 1) < 0.05), 'control: the points are on the big box\'s bottom face');
  assert.ok(arm(rewritten, big.index).every((y) => Math.abs(y + 1) < 0.05), `rewritten: the points are on the big box's bottom face, not the old one's: ${arm(rewritten, big.index)}`);
  world.destroy();
  control.destroy();
});


gpuTest('world contracts (AH-1): rewriteFixed discards the old floor anchors at the same pose', async (device) => {
  const world = await World.create({ device, maxBodies: 8 });
  try {
    const floor = world.addBox({ size: [10, 1, 10], position: [0, -0.5, 0], fixed: true })!;
    world.addBox({ size: [1, 1, 1], position: [0, 0.5, 0] });
    steps(world, 100);
    world.solver.rewriteFixed([floor.index], [0, -0.5, 0], [10, 2, 10], 0.6);
    world.step();
    const contacts = (await world.solver.readContactList()).filter(k => k.a === floor.index || k.b === floor.index);
    assert.ok(contacts.length > 0, 'the taller floor still touches the box');
    const heights = contacts.map(k => (k.a === floor.index ? k.rA : k.rB)[1]);
    assert.ok(heights.every(y => Math.abs(y - 1) < 0.05), `new floor top, not old anchors: ${heights}`);
  } finally {
    world.destroy();
  }
});
