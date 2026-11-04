// BodyPool (three-avbd/pool) on a real device: reservation ledger, typed failures that leave
// the World as it was, fresh lives in reused slots, template immutability, no retained GPU
// allocation in warmed churn, and the 10,000-life witness (N = 33: one anchor, a 32-slot pool).

import assert from 'node:assert/strict';
import { World, type Body, type ContactEvent } from '../src/lib/index.ts';
import { BodyPool, type BodyTemplate } from '../src/lib/pool.ts';
import { StorageCapacityError } from '../src/lib/storage-budget.ts';
import { convexHull } from '../src/avbd3d/hull.ts';
import { gpuTest } from './device.ts';

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;
const BOX: BodyTemplate = { kind: 'box', options: { size: [0.5, 0.5, 0.5], density: 2, friction: 0.3, reportContacts: true } };
const at = (x: number, y: number, z = 0) => ({ position: [x, y, z] as [number, number, number], rotation: [0, 0, 0, 1] as [number, number, number, number] });
const CUBE = [-1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1].map(v => v * 0.25);

async function created(world: World, capacity: number, template: BodyTemplate = BOX): Promise<BodyPool> {
  const result = await BodyPool.create(world, { capacity, template });
  assert.ok(result.ok, `pool create failed: ${!result.ok && result.reason}`);
  return result.pool;
}

/** live = ordinary + pooled, available = N − ordinary − reserved, reserved = pooled + vacant. */
function ledger(world: World, pools: BodyPool[]): void {
  const s = world.bodyStats;
  const pooled = pools.reduce((n, p) => n + p.stats.leased, 0);
  const vacant = pools.reduce((n, p) => n + p.stats.available, 0);
  const reserved = pools.reduce((n, p) => n + (p.active ? p.capacity : 0), 0);
  assert.equal(s.reserved, reserved, 'reserved');
  assert.equal(s.reservedAvailable, vacant, 'reservedAvailable');
  assert.equal(s.available, s.capacity - (s.live - pooled) - reserved, 'available');
  assert.equal(s.live, s.enabled + s.disabled, 'live');
  assert.equal(world.bodies.length, s.live);
}

/** Count GPU object creation (and live retained buffers) while `fn` runs. */
function census(device: GPUDevice) {
  const counts = { buffers: 0, staging: 0, groups: 0, pipelines: 0, modules: 0, live: 0, perCall: 0 };
  let excluded = false;
  const saved = { createBuffer: device.createBuffer, createBindGroup: device.createBindGroup, createComputePipeline: device.createComputePipeline, createShaderModule: device.createShaderModule };
  const d = device as unknown as Record<string, unknown>;
  d.createBuffer = (desc: GPUBufferDescriptor) => {
    const buffer = saved.createBuffer.call(device, desc);
    if (excluded) { counts.perCall++; return buffer; }
    // Per-call read staging is outside the fixed-storage promise; count it separately
    if (desc.usage & GPUBufferUsage.MAP_READ) { counts.staging++; return buffer; }
    counts.buffers++; counts.live++;
    const destroy = buffer.destroy.bind(buffer);
    let gone = false;
    buffer.destroy = () => { if (!gone) { gone = true; counts.live--; } destroy(); };
    return buffer;
  };
  d.createBindGroup = (desc: GPUBindGroupDescriptor) => { if (excluded) counts.perCall++; else counts.groups++; return saved.createBindGroup.call(device, desc); };
  d.createComputePipeline = (desc: GPUComputePipelineDescriptor) => { counts.pipelines++; return saved.createComputePipeline.call(device, desc); };
  d.createShaderModule = (desc: GPUShaderModuleDescriptor) => { counts.modules++; return saved.createShaderModule.call(device, desc); };
  /** Run `fn` with its creations counted as per-call query cost (rays), not retained storage. */
  const perCall = <T>(fn: () => T): T => { excluded = true; try { return fn(); } finally { excluded = false; } };
  return { counts, perCall, restore: () => Object.assign(device, saved) };
}

gpuTest('pool create: typed failures change nothing; reservations keep the ledger', async device => {
  const adaptive = await World.create({ device, maxBodies: 8 });
  assert.deepEqual(await BodyPool.create(adaptive, { capacity: 2, template: BOX }), { ok: false, reason: 'fixed-storage-required' });
  assert.equal(adaptive.capabilities.bodyPooling, false);
  adaptive.destroy();

  const world = await World.create({ device, maxBodies: 40, storage: FIXED });
  assert.equal(world.capabilities.bodyPooling, true);
  assert.equal(world.storageInfo.growth, 'fixed');
  const ordinary = [0, 1, 2].map(k => world.addBox({ size: [1, 1, 1], position: [k * 3, 0, 0] })!);
  ordinary[1].remove();
  world.step();
  const before = world.bodyStats;
  assert.deepEqual(await BodyPool.create(world, { capacity: 39, template: BOX }), { ok: false, reason: 'capacity' });
  assert.deepEqual(world.bodyStats, before, 'capacity failure reserves nothing');
  await assert.rejects(BodyPool.create(world, { capacity: 0, template: BOX }), RangeError);
  await assert.rejects(BodyPool.create(world, { capacity: 1, template: { kind: 'box', options: { size: [1, 1, 1], position: [0, 0, 0] } as never } }), TypeError);
  await assert.rejects(BodyPool.create(world, { capacity: 1, template: { kind: 'sphere', options: { radius: NaN } } }), RangeError);
  assert.deepEqual(world.bodyStats, before, 'invalid templates reserve nothing');

  const a = await created(world, 10);
  ledger(world, [a]);
  assert.equal(world.bodyStats.available, 40 - 2 - 10);
  // The hole (slot 1) went to the pool: an ordinary add takes the tail, past the reserved slots
  const late = world.addBox({ size: [1, 1, 1], position: [0, 5, 0] })!;
  // Reserved: hole 1 and tail 3..11; the ordinary add goes to 12
  assert.equal(late.index, 12, `ordinary add took slot ${late.index}`);
  const b = await created(world, 5, { kind: 'sphere', options: { radius: 0.25 } });
  ledger(world, [a, b]);
  const leases = Array.from({ length: 10 }, (_, k) => a.tryAcquire(at(k, 10)));
  assert.ok(leases.every(r => r.ok));
  assert.deepEqual(a.tryAcquire(at(0, 20)), { ok: false, reason: 'capacity' });
  const first = (leases[0] as { body: Body }).body;
  first.setEnabled(false);
  assert.deepEqual(a.stats, { capacity: 10, leased: 10, enabled: 9, disabled: 1, available: 0 });
  ledger(world, [a, b]);
  assert.throws(() => b.release(first), /not from this pool/);
  a.release(first);
  a.release(first);
  assert.equal(first.alive, false);
  assert.equal(a.stats.available, 1);
  ledger(world, [a, b]);
  world.step();
  a.dispose();
  a.dispose();
  assert.deepEqual(a.stats, { capacity: 10, leased: 0, enabled: 0, disabled: 0, available: 0 });
  assert.deepEqual(a.tryAcquire(at(0, 0)), { ok: false, reason: 'disposed' });
  ledger(world, [b]);
  assert.equal(world.bodyStats.available, 40 - 3 - 5);
  // Disposed slots serve ordinary adds again
  const refill = Array.from({ length: 32 }, () => world.addBox({ size: [1, 1, 1] }));
  assert.equal(refill.filter(Boolean).length, 32);
  assert.equal(world.addBox({ size: [1, 1, 1] }), null);
  ledger(world, [b]);
  world.step();
  world.destroy();
  assert.equal(b.active, false);
  assert.deepEqual(b.tryAcquire(at(0, 0)), { ok: false, reason: 'disposed' });
  b.dispose();
  await assert.rejects(BodyPool.create(world, { capacity: 1, template: BOX }), /destroyed/);
});

gpuTest('fresh lives in reused slots: GPU record, metadata and joints start clean', async device => {
  const world = await World.create({ device, maxBodies: 4, storage: FIXED });
  const anchor = world.addBox({ size: [4, 1, 4], fixed: true, position: [0, -0.5, 0] })!;
  const pool = await created(world, 2, { kind: 'box', options: { size: [0.5, 0.5, 0.5], group: 2, collidesWith: 0xffffffff } });
  const one = (pool.tryAcquire({ ...at(0, 3), velocity: [5, 0, 0], angularVelocity: [0, 4, 0] }) as { body: Body }).body;
  one.setCollisionGroups(4, 1);
  one.applyForce([0, 50, 0]);
  const joint = world.addJoint(anchor, one, { anchorA: [0, 3.5, 0] });
  world.step(); world.step();
  await world.read();
  const index = one.index, id = one.id;
  pool.release(one);
  assert.equal(joint.holding, false, 'its joints go with it');
  assert.equal(one.alive, false);
  const frozen = one.position;
  // Same slot again (LIFO), before and after a flush
  const two = (pool.tryAcquire(at(1, 2)) as { body: Body }).body;
  assert.equal(two.index, index);
  assert.ok(two.id > id, 'lifetime IDs are monotonic, never reused');
  assert.deepEqual(two.group, 2, 'template filters, not the old life’s');
  assert.deepEqual(two.collidesWith, 0xffffffff);
  world.step();
  await world.read([two]);
  assert.ok(Math.abs(two.position[0] - 1) < 0.05, `fresh pose x ${two.position[0]}`);
  assert.ok(Math.abs(two.velocity[0]) < 0.05, `no old velocity: ${two.velocity}`);
  assert.ok(two.velocity[1] < 0.5, `no old standing force: ${two.velocity}`);
  // The vacant record was written disabled: the new life must integrate (fall under gravity)
  assert.ok(two.enabled);
  assert.ok(two.velocity[1] < -0.05, `re-acquired slot integrates: ${two.velocity}`);
  assert.ok(Math.hypot(...two.angularVelocity) < 0.05, `no old spin: ${two.angularVelocity}`);
  assert.deepEqual(one.position, frozen, 'old handles stay frozen');
  assert.equal(world.solver.jointCount - (world.solver as unknown as { freeSlots: number[] }).freeSlots.length, 0, 'no joint slot held');
  world.destroy();
});

gpuTest('hull templates: one pinned copy, immune to caller and lease mutation', async device => {
  if (device.limits.maxStorageBuffersPerShaderStage < 9) {
    const world = await World.create({ device, maxBodies: 4, storage: FIXED });
    assert.deepEqual(await BodyPool.create(world, { capacity: 1, template: { kind: 'hull', shape: convexHull(CUBE)! } }), { ok: false, reason: 'resource-limit' });
    world.destroy();
    return;
  }
  const world = await World.create({ device, maxBodies: 8, storage: FIXED });
  const shape = convexHull(CUBE)!;
  const pool = await created(world, 3, { kind: 'hull', shape, options: { density: 1 } });
  const slots = (world.solver as unknown as { hullSlots: Map<unknown, { refs: number; offset: number }> }).hullSlots;
  assert.equal(slots.size, 1);
  const [pinned] = slots.values();
  assert.equal(pinned.refs, 1, 'the pool pin only');
  shape.vertices.fill(100);
  const lease = (pool.tryAcquire(at(0, 2)) as { body: Body }).body;
  assert.notEqual(lease.hull, shape);
  assert.ok(lease.hull!.vertices.every(v => Math.abs(v) <= 0.25 + 1e-6), 'template copy predates the mutation');
  lease.hull!.vertices.fill(-7);
  world.step();
  assert.equal(pinned.refs, 2);
  pool.release(lease);
  world.step();
  assert.equal(pinned.refs, 1, 'pin survives zero leases');
  const again = (pool.tryAcquire(at(0, 2)) as { body: Body }).body;
  assert.ok(again.hull!.vertices.every(v => Math.abs(v) <= 0.25 + 1e-6), 'lease snapshot mutation stayed private');
  const census0 = census(device);
  try { world.step(); pool.release(again); world.step(); pool.tryAcquire(at(0, 3)); world.step(); }
  finally { census0.restore(); }
  assert.deepEqual([census0.counts.buffers, census0.counts.groups, census0.counts.pipelines, census0.counts.modules], [0, 0, 0, 0], 'no upload/recompile on reacquire');
  pool.dispose();
  world.step();
  assert.equal(slots.size, 0, 'dispose drops the pin once leases are gone');
  world.destroy();
});

gpuTest('fixed World refuses growth: joints past capacity, SDF and custom backends', async device => {
  const world = await World.create({ device, maxBodies: 300, storage: FIXED });
  const bodies = Array.from({ length: 258 }, (_, k) => world.addBox({ size: [0.2, 0.2, 0.2], position: [k, 0, 0] })!);
  for (let k = 0; k < 256; k++) world.addJoint(bodies[k], bodies[k + 1]);
  assert.throws(() => world.addJoint(bodies[256], bodies[257]), StorageCapacityError);
  assert.throws(() => world.addSpring(bodies[256], bodies[257], { stiffness: 10 }), StorageCapacityError);
  world.step();
  assert.equal(world.solver.jointCount, 256, 'refused joints took no slot');
  await assert.rejects(world.enableSdfCollisions(), /fixed/i);
  assert.equal(world.sdfCollisionsEnabled, false);
  world.step();
  world.destroy();
});

gpuTest('destroy during create, ID exhaustion, hull resource-limit and freed-extent reuse', async device => {
  // Destroyed while the create awaits the GPU: rejects, publishes nothing
  const doomed = await World.create({ device, maxBodies: 4, storage: FIXED });
  const pending = BodyPool.create(doomed, { capacity: 2, template: BOX });
  doomed.destroy();
  await assert.rejects(pending, /destroyed/);

  // ID exhaustion: no slot or ID spent, no wrap (test seam: the World's private BodyIds)
  const world = await World.create({ device, maxBodies: 64, storage: FIXED });
  const pool = await created(world, 2);
  const ids = (world as unknown as { bodyIds: { next: number } }).bodyIds;
  ids.next = 0x7fffffff;
  const last = pool.tryAcquire(at(0, 1));
  assert.ok(last.ok && last.body.id === 0x7fffffff);
  assert.deepEqual(pool.tryAcquire(at(0, 2)), { ok: false, reason: 'id-exhausted' });
  assert.equal(pool.stats.available, 1, 'exhaustion spends no slot');
  assert.equal(world.bodyStats.remainingBodyIds, 0);
  pool.dispose();
  world.destroy();

  if (device.limits.maxStorageBuffersPerShaderStage < 9) return;
  // Hull storage: fill it with ordinary hulls of distinct shapes until refused
  const hulls = await World.create({ device, maxBodies: 256, storage: FIXED });
  const shapeOf = (k: number) => convexHull(CUBE.map((v, i) => v * (1 + k * 0.01) + (i % 3 === 0 ? k * 1e-3 : 0)))!;
  const held: Body[] = [];
  let k = 0;
  for (;; k++) {
    try { held.push(hulls.addHull({ shape: shapeOf(k), position: [k * 2, 0, 0] })!); }
    catch (error) { assert.ok(error instanceof StorageCapacityError && error.resource === 'hullVec4s'); break; }
  }
  assert.ok(held.length > 10);
  hulls.step();
  const before = hulls.bodyStats;
  const slots = (hulls.solver as unknown as { hullSlots: Map<unknown, unknown> }).hullSlots;
  const resident = slots.size;
  assert.deepEqual(await BodyPool.create(hulls, { capacity: 4, template: { kind: 'hull', shape: shapeOf(1000) } }), { ok: false, reason: 'resource-limit' });
  assert.deepEqual(hulls.bodyStats, before, 'hull refusal reserves nothing');
  assert.equal(slots.size, resident, 'and pins nothing');
  // Remove one (unflushed): its extent is reclaimed by create's flush and reused by a pool
  held[0].remove();
  const a = await created(hulls, 2, { kind: 'hull', shape: shapeOf(1001) });
  // A second pool's hull no longer fits; disposing the first frees its extent for a fresh one
  assert.deepEqual(await BodyPool.create(hulls, { capacity: 2, template: { kind: 'hull', shape: shapeOf(1002) } }), { ok: false, reason: 'resource-limit' });
  const lease = (a.tryAcquire(at(0, 3)) as { body: Body }).body;
  hulls.step();
  a.dispose();
  assert.equal(lease.alive, false);
  hulls.step();
  const b = await created(hulls, 2, { kind: 'hull', shape: shapeOf(1003) });
  assert.ok(b.tryAcquire(at(0, 3)).ok);
  hulls.step();
  hulls.destroy();
});

gpuTest('warmed churn allocates no retained GPU storage, bind groups or pipelines', async device => {
  const world = await World.create({ device, maxBodies: 33, storage: FIXED });
  const anchor = world.addBox({ size: [20, 1, 20], fixed: true, position: [0, -0.5, 0], reportContacts: true })!;
  const pool = await created(world, 32);
  const cycle = (k: number) => {
    const bodies: Body[] = [];
    for (let i = 0; i < 32; i++) {
      const r = pool.tryAcquire({ ...at((i % 8) - 4, 0.3 + Math.floor(i / 8) * 0.6), velocity: [0, -1, 0] });
      if (r.ok) bodies.push(r.body);
    }
    bodies[0].applyImpulse([0, 1, 0]);
    bodies[1].applyForce([1, 0, 0]);
    bodies[2].setEnabled(false);
    world.addJoint(anchor, bodies[3], { anchorA: [0, 1, 0] });
    world.addSpring(bodies[4], bodies[5], { stiffness: 50 });
    bodies[6].reset({ position: [0, 3, 0] });
    anchor.moveTo([0, -0.5 + (k % 2) * 0.01, 0]);
    world.step(); world.step();
    for (const b of bodies.slice(0, 16)) pool.release(b);
    // Reacquire before the flush
    pool.tryAcquire(at(6, 1));
    world.step();
    for (const b of [...bodies.slice(16)]) b.remove();
    for (const b of world.bodies) if (b !== anchor) b.remove();
    world.step();
  };
  for (let k = 0; k < 3; k++) cycle(k);
  await world.read();
  await device.queue.onSubmittedWorkDone();
  const spy = census(device);
  try { for (let k = 0; k < 20; k++) cycle(k); }
  finally { spy.restore(); }
  assert.deepEqual({ buffers: spy.counts.buffers, groups: spy.counts.groups, pipelines: spy.counts.pipelines, modules: spy.counts.modules }, { buffers: 0, groups: 0, pipelines: 0, modules: 0 });
  await world.read();
  world.destroy();
});

for (const fixture of ['box', 'hull'] as const) gpuTest(`10,000 lives (${fixture}): unique IDs, no misattributed events, bounded history, flat GPU census`, async device => {
  if (fixture === 'hull' && device.limits.maxStorageBuffersPerShaderStage < 9) return;
  const N = 33, LIVES = 10_000;
  const world = await World.create({ device, maxBodies: N, storage: FIXED });
  const anchor = world.addBox({ size: [40, 1, 40], fixed: true, position: [0, -0.5, 0] })!;
  const template: BodyTemplate = fixture === 'box' ? BOX : { kind: 'hull', shape: convexHull(CUBE)!, options: { density: 2, reportContacts: true } };
  const pool = await created(world, 32, template);
  const life = new Map<Body, { start: number; end: number }>();
  const ids = new Set<number>();
  let lastId = 0, lives = 0, failed33 = 0, misattributed = 0, events = 0;
  const unsubscribe = world.onContact((e: ContactEvent) => {
    events++;
    for (const body of [e.a, e.b]) {
      if (body === anchor) continue;
      const span = life.get(body);
      if (!span) { misattributed++; continue; }
      const end = span.end < 0 ? Infinity : span.end + 1;
      if (e.step < span.start || e.step > end) misattributed++;
    }
  });
  const leased: Body[] = [];
  const acquire = (x: number) => {
    const r = pool.tryAcquire({ ...at(x, 0.26 + (leased.length % 4) * 0.55, (leased.length >> 2) - 4), velocity: [0, -0.5, 0] });
    if (!r.ok) return null;
    assert.ok(r.body.id > lastId && !ids.has(r.body.id));
    lastId = r.body.id; ids.add(r.body.id);
    life.set(r.body, { start: world.stepCount + 1, end: -1 });
    leased.push(r.body);
    lives++;
    return r.body;
  };
  const release = (body: Body) => {
    life.get(body)!.end = world.stepCount;
    pool.release(body);
    leased.splice(leased.indexOf(body), 1);
  };
  let reading: Promise<unknown> | null = null;
  const rays = new Set<Promise<unknown>>();
  let rayHits = 0, staleRayHits = 0;
  let spy: ReturnType<typeof census> | null = null;
  let warmLive = 0;
  for (let burst = 0; lives < LIVES; burst++) {
    if (burst === 20) {
      if (reading) await reading;
      await world.read();
      spy = census(device);
      warmLive = spy.counts.live;
    }
    while (leased.length < 32) acquire(leased.length % 8 - 4);
    if (pool.tryAcquire(at(0, 9)).ok) assert.fail('33rd acquire'); else failed33++;
    if (burst % 3 === 0) leased[0].setEnabled(false);
    if (burst % 5 === 0) world.addJoint(anchor, leased[1], { anchorA: [0, 2, 0] });
    leased[2].applyImpulse([0.1, 0, 0]);
    world.step();
    // Release/reacquire before the next flush
    release(leased[3]); acquire(0);
    world.step();
    // One outstanding read at most, while slots are reused under it
    if (!reading) reading = world.read([]).finally(() => { reading = null; });
    // At most two ray batches in flight, across slot reuse; a hit names its submission-time body
    if (rays.size < 2) {
      const cast = () => world.raycasts([{ origin: [-4, 5, -4], direction: [0, -1, 0] }, { origin: [0, 5, 0], direction: [0, -1, 0] }]);
      const ray: Promise<unknown> = (spy ? spy.perCall(cast) : cast()).then(hits => {
        for (const hit of hits) if (hit?.body && hit.body !== anchor) { rayHits++; if (!life.has(hit.body)) staleRayHits++; }
      }).finally(() => rays.delete(ray));
      rays.add(ray);
    }
    for (const body of leased.slice(0, 16)) release(body);
    world.step();
    while (leased.length) release(leased[0]);
    // Let reads and rays land while their slots are being reused
    await new Promise(resolve => setImmediate(resolve));
  }
  world.step();
  if (reading) await reading;
  await Promise.all(rays);
  await world.read();
  await world.read();
  const counts = spy!.counts;
  spy!.restore();
  unsubscribe();
  assert.ok(lives >= LIVES);
  assert.equal(ids.size, lives);
  assert.ok(failed33 > 0);
  assert.equal(misattributed, 0, `${misattributed} of ${events} contact events outside their body's life`);
  assert.ok(events > 0, 'contacts reported');
  assert.equal(staleRayHits, 0);
  assert.deepEqual({ buffers: counts.buffers, groups: counts.groups, pipelines: counts.pipelines, modules: counts.modules }, { buffers: 0, groups: 0, pipelines: 0, modules: 0 });
  assert.equal(counts.live, warmLive, 'retained buffers return to the warmed census');
  const retired = (world as unknown as { retiredBodies: { slots: Map<number, unknown[]> } }).retiredBodies.slots;
  assert.ok([...retired.values()].every(list => list.length <= 8), 'retired history bounded per slot');
  const w = world as unknown as Record<string, { size: number } | unknown[]>;
  for (const key of ['rewatches', 'refilters', 'patches', 'resets', 'lifecycleDirty', 'coldBodies', 'impulses', 'forces', 'vacancies']) {
    assert.equal((w[key] as { size: number }).size, 0, `${key} drained`);
  }
  assert.equal((w.pendingJoints as unknown[]).length, 0);
  assert.equal(world.bodyStats.live, 1);
  assert.deepEqual(pool.stats, { capacity: 32, leased: 0, enabled: 0, disabled: 0, available: 32 });
  console.log(`# 10k witness (${fixture}): ${lives} lives, ${rayHits} pooled ray hits, ${counts.perCall} per-call ray creations, ${events} contact events, ${world.stepCount} steps, ${counts.staging} read staging buffers, plan ${world.storageInfo.growth === 'fixed' ? (world.storageInfo as { totalBytes: number }).totalBytes : 0} B`);
  pool.dispose();
  world.destroy();
});
