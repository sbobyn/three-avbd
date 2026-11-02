// Fixed retained storage (GpuSolverOptions.fixed, ../src/lib/storage-budget.ts): a fixed solver
// and its helpers (Pusher, ContactWatch, BodyMover, BodyReset) allocate every buffer, bind group
// and pipeline up front, so a warmed loop of body, joint, hull, push, statics and adapt work
// creates none; work past a topology capacity is refused leaving everything as it was; and a
// fixed solver steps to the same bits as an adaptive one of the same capacities, bodies appended
// after construction included (its adjacency scan spans every slot, not just those in use).
// z is up (the solver's frame).

import assert from 'node:assert/strict';
import { BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { BodyMover } from '../src/avbd3d/gpu/body-mover.ts';
import { BodyReset } from '../src/avbd3d/gpu/body-reset.ts';
import { type GpuCollisionBackend3D, GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { IgnoreCollision, Joint } from '../src/avbd3d/ref/forces.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { convexHull, hull, type HullShape } from '../src/avbd3d/shapes.ts';
import { ContactWatch } from '../src/lib/contacts.ts';
import { addImpulse, noPush, Pusher, type Pushes } from '../src/lib/push.ts';
import { type FixedStoragePlan, hullVec4s, resolveFixedStorage, StorageCapacityError } from '../src/lib/storage-budget.ts';
import { gpuTest } from './device.ts';

/** More than one 512-element scan block, so the adjacency scan has two levels. */
const N = 1100;

function plan(device: GPUDevice, overrides: Partial<{ pairs: number; contacts: number; manifolds: number; joints: number; hullVec4s: number }> = {}, bodies = N): FixedStoragePlan {
  return resolveFixedStorage(
    { maxBodies: bodies, maxContactPairs: 256, maxContactEvents: 512 },
    { growth: 'fixed', pairs: Math.max(4096, 4 * bodies), contacts: Math.max(8192, 4 * bodies), manifolds: Math.max(4096, bodies), joints: 256, hullVec4s: 4096, ...overrides },
    device.limits,
  );
}

const cubePoints = (s: number) => {
  const out: number[] = [];
  for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) out.push(x, y, z);
  return out;
};

/** Ground: a static 30 × 30 × 1 box, its top at z = 0. */
const ground = (ref: Solver) => new Rigid(ref, [30, 30, 1], 0, 0.6, [0, 0, -0.5]);

/** Box k of a 15 × 15 lattice of layers, 0.4 m boxes 0.8 m apart. */
const box = (ref: Solver, k: number) => new Rigid(ref, [0.4, 0.4, 0.4], 1, 0.6, [((k % 15) - 7) * 0.8, ((Math.floor(k / 15) % 15) - 7) * 0.8, 1 + 0.8 * Math.floor(k / 225)]);

type Counts = Record<'createBuffer' | 'createBindGroup' | 'createComputePipeline' | 'createShaderModule' | 'createBindGroupLayout' | 'createPipelineLayout' | 'createQuerySet', number>;

/** Count the device's object creations (and writes into the statics buffer) while `body` runs. */
async function spy(device: GPUDevice, body: () => Promise<void> | void): Promise<{ counts: Counts; staticWrites: number }> {
  const counts: Counts = { createBuffer: 0, createBindGroup: 0, createComputePipeline: 0, createShaderModule: 0, createBindGroupLayout: 0, createPipelineLayout: 0, createQuerySet: 0 };
  const restore: (() => void)[] = [];
  const wrap = (object: object, name: string, wrapper: (original: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown) => {
    const target = object as Record<string, (...args: unknown[]) => unknown>;
    const own = Object.getOwnPropertyDescriptor(object, name);
    const original = target[name];
    target[name] = wrapper(original);
    restore.push(() => (own ? Object.defineProperty(object, name, own) : delete target[name]));
  };
  for (const name of Object.keys(counts) as (keyof Counts)[]) {
    wrap(device, name, (original) => (...args) => {
      counts[name]++;
      return original.apply(device, args);
    });
  }
  let staticWrites = 0;
  wrap(device.queue, 'writeBuffer', (original) => (...args) => {
    if ((args[0] as GPUBuffer).label === 'statics') staticWrites++;
    return original.apply(device.queue, args);
  });
  try {
    await body();
  } finally {
    for (const undo of restore.reverse()) undo();
  }
  return { counts, staticWrites };
}

const none = (counts: Counts) => Object.fromEntries(Object.keys(counts).map((k) => [k, 0]));

/** The solver's hull allocator, to show a refused operation changed nothing. */
function hullState(solver: GpuSolver3D) {
  const s = solver as unknown as { hullTop: number; hullFree: unknown[]; hullSlots: Map<HullShape, { offset: number; size: number; refs: number }>; hullBuffer: GPUBuffer; bodies: { hull?: HullShape }[] };
  return JSON.stringify({ top: s.hullTop, free: s.hullFree, slots: [...s.hullSlots.values()], buffer: s.hullBuffer.size, bodyHulls: s.bodies.map((b) => !!b.hull) });
}

gpuTest('a warmed fixed solver and its helpers create no GPU objects in a loop of every edit', async (device) => {
  const p = plan(device);
  const ref = new Solver();
  ground(ref);
  for (let k = 0; k < 60; k++) box(ref, k);
  const solver = new GpuSolver3D(device, ref, { fixed: p });
  assert.ok(solver.hulls, 'the test device requests the adapter limit');
  assert.equal(solver.bodyCapacity, N);
  assert.equal(solver.fixed, p);
  assert.deepEqual([solver.contactCapacity, solver.pairCapacity, solver.manifoldCapacity], [p.contacts, p.pairs, p.manifolds], 'contact storage exactly the plan');
  const pusher = new Pusher(device, solver.bodyBuffer, N);
  const watch = new ContactWatch(device, solver.bodyBuffer, N, p.watchPairs, p.watchEvents);
  watch.prewarm(solver.contactStorages());
  const mover = new BodyMover(device, solver.bodyBuffer, N);
  const reset = new BodyReset(device, solver.bodyBuffer, N);
  const shape = convexHull(cubePoints(0.25))!;
  // Pinning compiles the hull narrowphase and uploads the shape: bodies packed with it later do neither
  const compiled = await spy(device, () => solver.pinHull(shape));
  assert.ok(compiled.counts.createComputePipeline > 0, 'the pin compiled the hull narrowphase');
  assert.ok(solver.canPinHull(shape), 'a resident shape can be pinned');
  const watched = Array.from({ length: 60 }, (_, k) => k + 1);
  watch.setWatched(watched, watched.map((i) => i), watched.map(() => true));
  let steps = 0;
  const step = () => {
    solver.step();
    watch.run(solver.contactStorage, solver.manifoldCapacity, ++steps, 1 / 60);
  };
  step();

  const scratch = new Solver();
  let joints: number[] = [];
  let hullSlot = -1;
  const { counts, staticWrites } = await spy(device, () => {
    for (let k = 0; k < 80; k++) {
      // Bodies up to the capacity in chunks, some of them hulls of the pinned shape
      if (solver.bodyCount < N) {
        const chunk = Array.from({ length: Math.min(150, N - solver.bodyCount) }, (_, i) =>
          i % 25 === 0 ? hull(scratch, shape, 1, 0.6, [(i / 25 - 3) * 1.2, 3, 6 + k]) : box(scratch, solver.bodyCount + i - 1),
        );
        assert.ok(solver.addBodies(chunk) >= 0);
      }
      // A slot packed as a hull of the pinned shape, then back to a box (and a size change, for the statics)
      const x = (k % 40) * 0.5 - 10;
      if (k % 4 === 0) {
        hullSlot = 2 + (k % 50);
        solver.rewriteBodies([hullSlot, hullSlot + 1], [hull(scratch, shape, 1, 0.6, [x, -5, 8]), new Rigid(scratch, [0.3 + 0.01 * (k % 8), 0.4, 0.4], 1, 0.6, [x + 1, -5, 8])]);
      } else if (k % 4 === 2) {
        solver.rewriteBodies([hullSlot], [new Rigid(scratch, [0.4, 0.4, 0.4], 1, 0.6, [x - 1, -5, 8])]);
      }
      solver.patchBody(5, new Set(['velocity']), new Rigid(scratch, [0.4, 0.4, 0.4], 1, 0.6, [0, 0, 3], [0, 0, 1]));
      // Joints appended, released and appended again into the released slots; a spring; a single joint
      if (k % 3 === 0) joints = solver.appendJoints([{ a: 10, b: 11, rA: [0, 0, 0.3], rB: [0, 0, -0.3] }, { a: 12, b: 13, rA: [0, 0, 0.3], rB: [0, 0, -0.3], angular: 0 }]);
      if (k % 3 === 1) joints.push(...solver.appendSprings([{ a: 14, b: 15, rA: [0, 0, 0], rB: [0, 0, 0], stiffness: 100, rest: 1 }]), solver.appendJoint(-1, 16, [0, 0, 3], [0, 0, 0], 1e4, 0));
      if (k % 3 === 2) solver.releaseJoints(joints);
      // Pushes (once for every slot), moves and resets
      const pushes = new Map<number, Pushes>();
      for (let i = 1; i < (k === 7 ? N : 40); i++) {
        const push = noPush();
        addImpulse(push, [0, 0, 0.01], [0, 0, 1]);
        pushes.set(i, push);
      }
      pusher.apply(pushes);
      mover.apply([{ index: 20, position: [0, 0, 2], rotation: [0, 0, 0, 1], left: 3, dt: 1 / 60 }]);
      reset.apply([21, 22]);
      // A readback reporting every store overflowed and the colouring clashing: colours adapt, storage holds
      if (k % 10 === 5) solver.adapt({ pairs: 10 * p.pairs, contacts: 10 * p.contacts, manifolds: 10 * p.manifolds, overflow: 7, clashes: 50, colors: 60, tailBodies: 0 });
      step();
    }
  });
  assert.deepEqual(counts, none(counts), 'nothing created in the warmed loop');
  assert.ok(staticWrites > 0, 'the loop uploaded the statics (joints and body sizes changed)');
  assert.equal(solver.bodyCount, N, 'filled to the capacity');
  assert.equal(solver.colorCap, 64, 'the injected readback raised the colour cap to the most');
  assert.deepEqual([solver.contactCapacity, solver.pairCapacity, solver.manifoldCapacity], [p.contacts, p.pairs, p.manifolds], 'adapt grew nothing');
  assert.equal(solver.addBody(box(scratch, 0)), -1, 'no slot past the capacity');
  const bodies = await solver.readBodies();
  for (let i = 0; i < N; i++) for (let a = 0; a < 3; a++) assert.ok(Number.isFinite(bodies[i * BODY_FLOATS + a]), `body ${i} finite`);
  // Pushes past the fixed capacity are refused
  const tooMany = new Map<number, Pushes>(Array.from({ length: N + 1 }, (_, i) => [i, noPush()]));
  assert.throws(() => pusher.apply(tooMany), (e: unknown) => e instanceof StorageCapacityError && e.resource === 'bodies' && e.requested === N + 1 && e.capacity === N);
  await device.queue.onSubmittedWorkDone();
  for (const helper of [pusher, watch, mover, reset, solver]) helper.destroy();
});

gpuTest('the spy sees what an adaptive solver allocates for the same edits', async (device) => {
  const ref = new Solver();
  ground(ref);
  const solver = new GpuSolver3D(device, ref, { bodyCapacity: N });
  const pusher = new Pusher(device, solver.bodyBuffer);
  const watch = new ContactWatch(device, solver.bodyBuffer, N, 256, 512);
  solver.step();
  const scratch = new Solver();
  const { counts } = await spy(device, () => {
    solver.addBodies(Array.from({ length: 10 }, (_, k) => box(scratch, k)));
    pusher.apply(new Map([[1, noPush()]]));
    solver.step();
    watch.run(solver.contactStorage, solver.manifoldCapacity, 1, 1 / 60);
  });
  assert.ok(counts.createBuffer > 0, 'the adjacency scan was rebuilt, the push storage made');
  assert.ok(counts.createBindGroup > 0);
  // ContactWatch keeps a group per ping-pong storage: after both parities, steps make none
  solver.step();
  watch.run(solver.contactStorage, solver.manifoldCapacity, 2, 1 / 60);
  const warm = await spy(device, () => {
    for (let k = 0; k < 4; k++) {
      solver.step();
      watch.run(solver.contactStorage, solver.manifoldCapacity, 3 + k, 1 / 60);
    }
  });
  assert.equal(warm.counts.createBindGroup, 0, 'contact watch groups reused across parities');
  await device.queue.onSubmittedWorkDone();
  for (const helper of [pusher, watch, solver]) helper.destroy();
});

gpuTest('fixed and adaptive solvers step to the same bits, empty to partly to fully used', async (device) => {
  // Roomy enough that neither overflows (an overflow drops records in thread order)
  const p = plan(device, { pairs: 16384, contacts: 32768, manifolds: 8192 });
  const make = (fixed: boolean) =>
    new GpuSolver3D(device, new Solver(), fixed ? { fixed: p } : { bodyCapacity: N, capacity: { contacts: p.contacts, pairs: p.pairs, manifolds: p.manifolds, joints: p.joints } });
  const solvers = [make(true), make(false)];
  assert.deepEqual(solvers.map((s) => [s.contactCapacity, s.pairCapacity, s.manifoldCapacity, s.colorCap]), [0, 1].map(() => [p.contacts, p.pairs, p.manifolds, solvers[0].colorCap]), 'the same capacities');
  const stage = async (what: string, edit: (s: GpuSolver3D, scratch: Solver) => void, steps: number) => {
    for (const s of solvers) {
      edit(s, new Solver());
      for (let k = 0; k < steps; k++) s.step();
    }
    const [x, y] = await Promise.all(solvers.map(async (s) => new Uint32Array((await s.readBodies()).buffer)));
    assert.equal(x.length, y.length, `${what}: body counts`);
    let differ = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
    assert.equal(differ, 0, `${what}: ${differ} words differ between fixed and adaptive`);
    const counters = await Promise.all(solvers.map((s) => s.readCounters()));
    assert.deepEqual(counters.map((c) => c.overflow), [0, 0], `${what}: no overflow`);
    return { bodies: new Float32Array(x.buffer), counters };
  };
  // Empty: no bodies at all
  await stage('empty', () => {}, 3);
  // Partly used, past a scan block: the ground, 700 boxes and a few joints
  await stage('partial', (s, scratch) => {
    s.addBodies([ground(scratch), ...Array.from({ length: 700 }, (_, k) => box(scratch, k))]);
    s.appendJoints([{ a: 1, b: 2, rA: [0.4, 0, 0], rB: [-0.4, 0, 0] }, { a: 600, b: 601, rA: [0.4, 0, 0], rB: [-0.4, 0, 0] }]);
  }, 40);
  // Full, in two appends (the adaptive scan is rebuilt for each, the fixed one never)
  const full = await stage('full', (s, scratch) => {
    s.addBodies(Array.from({ length: 200 }, (_, k) => box(scratch, 700 + k)));
    s.addBodies(Array.from({ length: N - 901 }, (_, k) => box(scratch, 900 + k)));
    s.appendJoints([{ a: 1000, b: 1001, rA: [0.4, 0, 0], rB: [-0.4, 0, 0] }]);
  }, 60);
  assert.equal(solvers[0].bodyCount, N);
  assert.ok(full.counters[0].manifolds > 500, `the pile touches (${full.counters[0].manifolds} pairs)`);
  let low = Infinity;
  let high = -Infinity;
  for (let i = 1; i < N; i++) {
    low = Math.min(low, full.bodies[i * BODY_FLOATS + 2]);
    high = Math.max(high, full.bodies[i * BODY_FLOATS + 2]);
  }
  assert.ok(low > 0 && high < 6, `the boxes rest on the ground, not through it or flung (z ${low.toFixed(2)} to ${high.toFixed(2)})`);
  for (const s of solvers) s.destroy();
});

gpuTest('joints past a fixed capacity are refused before anything changes', async (device) => {
  const p = plan(device, {}, 64);
  const ref = new Solver();
  for (let k = 0; k < 20; k++) box(ref, k);
  const solver = new GpuSolver3D(device, ref, { fixed: p, spatialSort: false });
  const pending = () => (solver as unknown as { noCollideTable: { pending: unknown[] } }).noCollideTable.pending.length;
  const spec = (k: number) => ({ a: k % 20, b: (k + 1) % 20, rA: [0, 0, 0], rB: [0, 0, 0] });
  const slots = solver.appendJoints(Array.from({ length: p.joints - 1 }, (_, k) => spec(k)));
  assert.equal(slots.length, p.joints - 1);
  solver.releaseJoints([3, 7]);
  // Room for three: two released slots and one fresh
  const before = { count: solver.jointCount, info: Array.from(solver.jointInfo()), pending: pending() };
  const refused = (e: unknown) => e instanceof StorageCapacityError && e.resource === 'joints' && e.capacity === p.joints;
  assert.throws(() => solver.appendJoints(Array.from({ length: 4 }, (_, k) => spec(k))), refused);
  assert.throws(() => solver.appendSprings(Array.from({ length: 4 }, (_, k) => ({ ...spec(k), stiffness: 1, rest: 0 }))), refused);
  assert.deepEqual({ count: solver.jointCount, info: Array.from(solver.jointInfo()), pending: pending() }, before, 'no slot taken, count changed or exclusion added');
  // What fits still goes in, released slots first, by every path
  assert.equal(solver.appendJoint(0, 1, [0, 0, 0], [0, 0, 0], 1e4, 0), 3, 'a single joint reuses a released slot');
  assert.deepEqual(solver.appendSprings([{ ...spec(2), stiffness: 1, rest: 0 }]), [7]);
  assert.deepEqual(solver.appendJoints([spec(5)]), [p.joints - 1]);
  assert.equal(solver.jointCount, p.joints);
  assert.throws(() => solver.appendJoint(0, 1, [0, 0, 0], [0, 0, 0], 1e4, 0), refused);
  assert.throws(() => solver.appendJoint(0, 99, [0, 0, 0], [0, 0, 0], 1e4, 0), /not both bodies/, 'a bad endpoint is refused too');
  solver.releaseJoints([100]);
  assert.equal(solver.appendJoint(2, 3, [0, 0, 0], [0, 0, 0], 1e4, 0), 100);
  for (let k = 0; k < 5; k++) solver.step();
  solver.destroy();
});

gpuTest('hulls past a fixed capacity are refused before anything changes; a batch may reuse what it frees', async (device) => {
  const p = plan(device, {}, 64);
  const ref = new Solver();
  ground(ref);
  for (let k = 0; k < 10; k++) box(ref, k);
  const solver = new GpuSolver3D(device, ref, { fixed: p, spatialSort: false });
  assert.ok(solver.hulls);
  const scratch = new Solver();
  const copy = () => convexHull(cubePoints(0.25))!;
  const a = copy();
  const size = hullVec4s(a);
  // Slot 1 collides as hull a; then pins of copies until the next copy fits nowhere
  solver.rewriteBodies([1], [hull(scratch, a, 1, 0.6, [0, 0, 1])]);
  assert.equal((solver as unknown as { hullTop: number }).hullTop, size, 'storage-budget hullVec4s agrees with the solver');
  const pins: HullShape[] = [];
  for (let shape = copy(); solver.canPinHull(shape); shape = copy()) {
    solver.pinHull(shape);
    pins.push(shape);
  }
  assert.equal(pins.length, Math.floor(p.hullVec4s / size) - 1);
  const b = copy();
  const state = hullState(solver);
  const count = solver.bodyCount;
  const refused = (e: unknown) => e instanceof StorageCapacityError && e.resource === 'hullVec4s' && e.requested === size && e.capacity < size;
  assert.equal(solver.canPinHull(b), false);
  assert.throws(() => solver.pinHull(b), refused);
  assert.throws(() => solver.addBodies([box(scratch, 0), hull(scratch, b, 1, 0.6, [0, 0, 1])]), refused);
  // Slot 2 takes b before slot 1 frees a: does not fit
  assert.throws(() => solver.rewriteBodies([2, 1], [hull(scratch, b, 1, 0.6, [0, 0, 1]), box(scratch, 1)]), refused);
  assert.equal(hullState(solver), state, 'allocator, buffer and slots unchanged');
  assert.equal(solver.bodyCount, count);
  // Slot 1 frees a before slot 2 takes b, into a's block
  solver.rewriteBodies([1, 2], [box(scratch, 1), hull(scratch, b, 1, 0.6, [0, 0, 1])]);
  assert.equal(solver.canPinHull(a), false, 'a went, b took its storage');
  // Unpins free storage; an unpinned shape cannot be unpinned again
  solver.unpinHull(pins[0]);
  assert.ok(solver.canPinHull(a));
  assert.throws(() => solver.unpinHull(pins[0]), /not pinned/);
  solver.pinHull(a);
  assert.equal(solver.addBodies([hull(scratch, a, 1, 0.6, [2, 0, 1])]), count, 'a body of a pinned shape needs no storage');
  for (let k = 0; k < 5; k++) solver.step();
  solver.destroy();
});

gpuTest('a fixed solver refuses collision backends, growth, and scenes its plan cannot hold', async (device) => {
  const p = plan(device, {}, 64);
  const ref = new Solver();
  for (let k = 0; k < 4; k++) box(ref, k);
  const solver = new GpuSolver3D(device, ref, { fixed: p });
  let prepared = 0;
  let destroyed = 0;
  const backend: GpuCollisionBackend3D = { prepare: () => void prepared++, encode: () => {}, destroy: () => void destroyed++ };
  assert.throws(() => solver.setCollisionBackend(backend), /Fixed storage: collision backends/);
  assert.deepEqual([prepared, destroyed], [0, 0], 'refused before the backend prepared');
  assert.equal(solver.activeCollisionBackend, null);
  solver.setCollisionBackend(null);
  assert.throws(() => solver.assertBackendSwitchAllowed(), /Fixed storage/);
  solver.reserveCollisionCapacity(p.manifolds);
  assert.throws(() => solver.reserveCollisionCapacity(p.manifolds + 1), (e: unknown) => e instanceof StorageCapacityError && e.resource === 'manifolds');
  assert.deepEqual([solver.contactCapacity, solver.manifoldCapacity], [p.contacts, p.manifolds]);
  solver.step();
  solver.destroy();

  const ignoring = new Solver();
  const [x, y] = [box(ignoring, 0), box(ignoring, 1)];
  new IgnoreCollision(ignoring, x, y);
  assert.throws(() => new GpuSolver3D(device, ignoring, { fixed: p }), /IgnoreCollision/);
  const jointed = new Solver();
  const bodies = [box(jointed, 0), box(jointed, 1)];
  for (let k = 0; k <= p.joints; k++) new Joint(jointed, bodies[0], bodies[1], [0, 0, 0], [0, 0, 0]);
  assert.throws(() => new GpuSolver3D(device, jointed, { fixed: p }), (e: unknown) => e instanceof StorageCapacityError && e.resource === 'joints' && e.requested === p.joints + 1);
  const wrong = device.createBuffer({ size: (p.bodies + 1) * BODY_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  assert.throws(() => new GpuSolver3D(device, new Solver(), { fixed: p, bodyBuffer: wrong }), /holds exactly 64 bodies/);
  wrong.destroy();
});
