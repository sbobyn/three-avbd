import assert from 'node:assert/strict';
import { World, type Body, type ContactEvent } from '../src/lib/index.ts';
import { gpuTest } from './device.ts';

const create = (device: GPUDevice, maxContactEvents = 64) => World.create({ device, maxBodies: 16, gravity: [0, 0, 0], iterations: 0, maxContactEvents });
const box = (world: World, x: number, reportContacts = false) => world.addBox({ size: [1, 1, 1], position: [x, 0, 0], reportContacts })!;
const involves = (event: ContactEvent, body: Body) => event.a === body || event.b === body;

gpuTest('observations: intervening steps prevent read coalescing without body writes', async device => {
  const world = await create(device);
  try {
    const body = world.addBox({ size: [1, 1, 1], velocity: [1, 0, 0] })!;
    world.step();
    const first = world.read([body]);
    assert.equal(world.read([body]), first, 'same-step subset coalesces');
    world.step();
    const second = world.read([body]);
    assert.notEqual(second, first);
    assert.deepEqual(await first, { step: 1 });
    assert.deepEqual(await second, { step: 2 });
    assert.ok(Math.abs(body.position[0] - 2 * world.dt) < 1e-5);
  } finally { world.destroy(); }
});

gpuTest('observations: repeated slot reuse attributes every lifetime and orders end before begin', async device => {
  const world = await create(device);
  try {
    box(world, 0, true);
    let body = box(world, .9);
    const lifetimes = [body];
    const events: ContactEvent[] = [];
    world.onContact(event => events.push(event));
    world.step();
    for (let i = 0; i < 3; i++) {
      body.remove();
      body = box(world, .9);
      assert.equal(body.index, lifetimes[0].index);
      lifetimes.push(body);
      world.step();
    }
    await world.read([]);
    assert.equal(world.droppedContactEvents, 0);
    assert.equal(events.length, 7);
    for (let i = 0; i < 3; i++) {
      const [end, begin] = events.slice(1 + 2 * i, 3 + 2 * i);
      assert.equal(end.type, 'end');
      assert.equal(begin.type, 'begin');
      assert.ok(involves(end, lifetimes[i]));
      assert.ok(involves(begin, lifetimes[i + 1]));
      assert.equal(end.step, begin.step);
    }
  } finally { world.destroy(); }
});

gpuTest('observations: a read before the next step preserves identity for a later end', async device => {
  const world = await create(device);
  try {
    box(world, 0, true);
    const old = box(world, .9);
    world.step();
    await world.read([]);
    old.remove();
    const fresh = box(world, .9);
    await world.read([]); // Previous active pair table still refers to old.
    const events: ContactEvent[] = [];
    world.onContact(e => events.push(e));
    world.step();
    await world.read([]);
    assert.deepEqual(events.map(e => e.type), ['end', 'begin']);
    assert.ok(involves(events[0], old));
    assert.ok(!involves(events[0], fresh));
    assert.ok(involves(events[1], fresh));
  } finally { world.destroy(); }
});

gpuTest('observations: bounded retirement suppresses unverifiable events and counts loss', async device => {
  const world = await create(device);
  try {
    box(world, 0, true);
    let body = box(world, .9);
    const events: ContactEvent[] = [];
    world.onContact(e => events.push(e));
    world.step();
    for (let i = 0; i < 10; i++) { body.remove(); body = box(world, .9); world.step(); }
    await world.read([]);
    assert.equal(world.droppedContactEvents, 4, 'begin/end of the two evicted lifetimes');
    assert.equal(events.length, 17);
    assert.ok(events.every(e => e.a.id >= 1 && e.b.id >= 1));
    assert.equal(events.filter(e => involves(e, body)).length, 1, 'replacement gets only its begin');
  } finally { world.destroy(); }
});

gpuTest('observations: event capacity loss is counted and listeners receive captured identities', async device => {
  const world = await create(device, 1);
  try {
    const bodies = [box(world, 0, true), box(world, .9), box(world, 10, true), box(world, 10.9)];
    const events: ContactEvent[] = [];
    world.onContact(e => events.push(e));
    world.step();
    await world.read([]);
    assert.equal(events.length, 1);
    assert.equal(world.droppedContactEvents, 1);
    assert.ok(bodies.includes(events[0].a) && bodies.includes(events[0].b));
  } finally { world.destroy(); }
});

gpuTest('observations: listener mutation cannot change this batch or replace its handles', async device => {
  const world = await create(device);
  try {
    box(world, 0, true); const first = box(world, .9);
    box(world, 10, true); const second = box(world, 10.9);
    const events: ContactEvent[] = [];
    let unsubscribe = () => {};
    unsubscribe = world.onContact(e => {
      events.push(e);
      unsubscribe();
      first.remove(); second.remove();
      box(world, 30); box(world, 40);
    });
    world.step();
    await world.read([]);
    assert.equal(events.length, 2);
    assert.ok(events.some(e => involves(e, first)));
    assert.ok(events.some(e => involves(e, second)));
  } finally { world.destroy(); }
});

gpuTest('observations: pending rays retain identity across removal and destroy; foreign handles reject', async device => {
  const world = await create(device), foreign = await create(device);
  try {
    const body = box(world, 0), other = box(foreign, 0);
    assert.throws(() => world.read([other]), /another world/);
    assert.throws(() => world.track([other]), /another world/);
    assert.throws(() => world.removeBody(other), /another world/);
    assert.throws(() => world.addJoint(body, other), /another world/);
    await assert.rejects(world.raycasts([{ origin: [-3, 0, 0], direction: [1, 0, 0] }], { ignore: [other] }), /another world/);
    const ray = world.raycast([-3, 0, 0], [1, 0, 0]);
    body.remove(); box(world, 0);
    world.destroy();
    assert.equal((await ray)?.body, body);
  } finally { world.destroy(); foreign.destroy(); }
});

gpuTest('observations: worlds without reporting bodies create no contact watch or readback', async device => {
  const world = await create(device);
  try {
    box(world, 0); box(world, .9);
    const retired = (world as unknown as { retiredBodies: { snapshot: () => unknown } }).retiredBodies;
    retired.snapshot = () => { throw new Error('unreported read must not snapshot identities'); };
    world.step();
    await world.read([]);
    // Inspect resource presence rather than mocking the queue or running a benchmark.
    assert.equal((world as unknown as { contactWatch: unknown }).contactWatch, null);
    assert.equal(world.droppedContactEvents, 0);
  } finally { world.destroy(); }
});


gpuTest('observations: ignoring a removed lifetime does not hide its replacement slot', async device => {
  const world = await create(device);
  try {
    const old = box(world, 0);
    world.step();
    old.remove();
    const replacement = box(world, 0);
    assert.equal(replacement.index, old.index);
    const hit = await world.raycast([-3, 0, 0], [1, 0, 0], { ignore: [old] });
    assert.equal(hit?.body, replacement);
    assert.equal(await world.raycast([-3, 0, 0], [1, 0, 0], { ignore: [replacement] }), null);
  } finally { world.destroy(); }
});
