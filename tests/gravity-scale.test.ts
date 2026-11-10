// Per-body gravity scale (STE-3328, first slice of the F2 body-aux record, docs/BODY_AUX_DESIGN.md):
// input validation, the aux record's layout and budget, the capability, and, on a recording fake
// device (no GPU, no shader compilation), what World and GpuSolver3D write and encode: the aux
// uploads and their lifetime, refused changes leaving everything as it was, the integrate layout,
// and that every dispatch of a step has bind groups matching its pipeline's layout. GPU behaviour
// (free fall, SDF, default equivalence) is tests-gpu/gravity-scale.gpu.test.ts.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A_ANGULAR_DAMPING, A_GRAVITY_SCALE, A_LINEAR_DAMPING, BODY_AUX_ABI_VERSION, BODY_AUX_BINDING, BODY_AUX_FLOATS, BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { solveBodyAuxWGSL, solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { broadphaseWGSL, contactsWGSL } from '../src/avbd3d/gpu/wgsl-collision.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { checkEffectiveGravity, checkGravityScale, MAX_GRAVITY_SCALE } from '../src/lib/world-validation.ts';
import { deviceCapabilities, worldCapabilities } from '../src/lib/capabilities.ts';
import { resolveFixedStorage, type StorageLimits } from '../src/lib/storage-budget.ts';
import { World } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';

const F32_MAX = 3.4028234663852886e38;
const BAD_SCALES: unknown[] = [NaN, Infinity, -Infinity, 1e39, -1e39, 1001, -1001, 1000.001, '1', '0', null, undefined, true, {}, [1], 1n];

// --- Pure checks ------------------------------------------------------------------------------

test('gravityScale: signed, finite as f32, within ±1000; anything else is a RangeError naming the caller', () => {
  assert.equal(MAX_GRAVITY_SCALE, 1000);
  for (const ok of [1, 0, -0, -1, 2, 0.5, 1000, -1000, 1e-39, -1e-30, 1000.00000001]) assert.equal(checkGravityScale(ok, 'addBox'), ok, String(ok));
  for (const bad of BAD_SCALES) {
    assert.throws(() => checkGravityScale(bad, 'Body.setGravityScale'), (e: unknown) => e instanceof RangeError && /^Body\.setGravityScale: gravityScale/.test(e.message), String(bad));
  }
});

test('effective gravity: the f32 product of the rounded operands must be finite, which finite operands do not guarantee', () => {
  checkEffectiveGravity(-9.81, 1000, 'x');
  checkEffectiveGravity(-F32_MAX, 1, 'x');
  checkEffectiveGravity(-F32_MAX, -1, 'x');
  checkEffectiveGravity(-3e35, 1000, 'x');
  checkEffectiveGravity(0, -1000, 'x');
  // Both finite (and the f64 product finite too), the f32 product not
  assert.throws(() => checkEffectiveGravity(-2e38, 2, 'World.gravity'), /World\.gravity: .* not finite \(as f32\)/);
  assert.throws(() => checkEffectiveGravity(-1e36, 1000, 'addBox'), RangeError);
  // The operands as the GPU holds them: 1 + 2^-24 rounds to 1 in f32 (finite product); 1 + 2^-23 does not
  checkEffectiveGravity(-F32_MAX, 1 + 2 ** -24, 'x');
  assert.throws(() => checkEffectiveGravity(-F32_MAX, 1 + 2 ** -23, 'x'), RangeError);
  // Tiny effective gravity is finite (accepted); its numerical behaviour is a GPU test case, not a guarantee
  checkEffectiveGravity(-9.81, 1e-39, 'x');
});

// --- Record, shader text, budget, capability ---------------------------------------------------------

test('aux record: 4 floats per slot in its own binding; body and filter strides unchanged', () => {
  assert.deepEqual([BODY_AUX_FLOATS, A_GRAVITY_SCALE, A_LINEAR_DAMPING, A_ANGULAR_DAMPING, BODY_AUX_ABI_VERSION, BODY_AUX_BINDING], [4, 0, 1, 2, 1, 9]);
  assert.equal(BODY_FLOATS, 40);
  assert.equal(solveBodyAuxWGSL.match(/@binding\(9\)/g)?.length, 1, 'binding 9 declared once');
  // Read once, inside warmStartBodies only
  const uses = [...solveBodyAuxWGSL.matchAll(/bodyAux\[/g)].map((m) => m.index!);
  assert.equal(uses.length, 1);
  const start = solveBodyAuxWGSL.indexOf('fn warmStartBodies(');
  const end = solveBodyAuxWGSL.indexOf('@compute', start + 1);
  assert.ok(start > 0 && uses[0] > start && uses[0] < end, 'the aux read is in warmStartBodies');
  for (const code of [contactsWGSL, broadphaseWGSL]) assert.ok(!code.includes('bodyAux'));
  assert.ok(!solveWGSL.includes('bodyAux'), 'public custom-solve binding contract unchanged');
});

const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
const FLOOR = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;

test('fixed plan budgets the aux buffer at 16 bytes per body; filters and bodies unchanged', () => {
  for (const N of [1, 33, 1000]) {
    const plan = resolveFixedStorage({ maxBodies: N }, FLOOR, LIMITS);
    assert.equal(plan.buffers.bodyAux, N * 16);
    assert.equal(plan.buffers.filters, N * 8);
    assert.equal(plan.buffers.bodies, N * 160);
    assert.equal(plan.totalBytes, Object.values(plan.buffers).reduce((a, b) => a + b, 0));
  }
});

test('capability: gravityScale follows the built-in integrator independently of collision backend', () => {
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 8 } });
  assert.equal(worldCapabilities(device, 'standard', false).gravityScale, true);
  assert.equal(worldCapabilities(device, 'sdf', false).gravityScale, true);
  assert.equal(worldCapabilities(device, 'custom', false).gravityScale, true);
  for (const backend of ['standard', 'sdf', 'custom'] as const) {
    assert.equal(worldCapabilities(device, backend, false, true).gravityScale, false, `${backend}, custom shaders`);
    assert.equal(worldCapabilities(device, backend, false, false, false, false).gravityScale, false, `${backend}, no aux support`);
  }
});

// --- A recording fake device ----------------------------------------------------------------------

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

interface FakeBuffer { label: string; size: number; usage: number; destroyed: boolean; destroy(): void }
interface Write { buffer: FakeBuffer; offset: number; bytes: Uint8Array }
type Call = ['pipeline', Any] | ['group', number, Any, number[]] | ['dispatch'];

function fakeDevice(options: { storage?: number; failPipeline?: string } = {}) {
  const buffers: FakeBuffer[] = [];
  const writes: Write[] = [];
  const passes: Call[][] = [];
  const layouts: Any[] = [];
  const pipelines: Any[] = [];
  const device: Any = {
    limits: { maxStorageBuffersPerShaderStage: options.storage ?? 8, ...LIMITS },
    features: new Set<string>(),
    lost: new Promise(() => undefined),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
        const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        const unit = (view as Any).BYTES_PER_ELEMENT ?? 1;
        const all = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        writes.push({ buffer, offset, bytes: all.slice(dataOffset * unit, size === undefined ? undefined : (dataOffset + size) * unit) });
      },
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createBuffer(desc: GPUBufferDescriptor) {
      const b: Any = { label: desc.label ?? '', size: desc.size, usage: desc.usage, destroyed: false, destroy() { b.destroyed = true; }, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {}, mapAsync: () => new Promise(() => undefined) };
      buffers.push(b);
      return b;
    },
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) { const l = { label: desc.label, entries: [...desc.entries] }; layouts.push(l); return l; },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) { return { bindGroupLayouts: [...desc.bindGroupLayouts] }; },
    createShaderModule(desc: GPUShaderModuleDescriptor) { return { code: desc.code }; },
    createComputePipeline(desc: Any) {
      if (options.failPipeline !== undefined && desc.label === options.failPipeline) throw new Error(`fake: ${desc.label} refused`);
      const auto = new Map<number, Any>();
      const p = { label: desc.label, layout: desc.layout, module: desc.compute.module, entryPoint: desc.compute.entryPoint, getBindGroupLayout(i: number) { if (!auto.has(i)) auto.set(i, { auto: true }); return auto.get(i); } };
      pipelines.push(p);
      return p;
    },
    createBindGroup(desc: Any) { return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createQuerySet() { return { destroy() {} }; },
    createCommandEncoder() {
      return {
        clearBuffer() {}, copyBufferToBuffer() {}, resolveQuerySet() {}, finish: () => ({}),
        beginComputePass() {
          const calls: Call[] = [];
          passes.push(calls);
          return {
            setPipeline(p: Any) { calls.push(['pipeline', p]); },
            setBindGroup(i: number, group: Any, offsets?: Uint32Array | number[], start = 0, length?: number) {
              const list = offsets === undefined ? [] : offsets instanceof Uint32Array ? [...offsets.subarray(start, start + (length ?? offsets.length - start))] : [...offsets];
              calls.push(['group', i, group, list]);
            },
            dispatchWorkgroups() { calls.push(['dispatch']); },
            dispatchWorkgroupsIndirect() { calls.push(['dispatch']); },
            end() {},
          };
        },
      };
    },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device: device as GPUDevice, buffers, writes, passes, layouts, pipelines };
}

type Fake = ReturnType<typeof fakeDevice>;

/** Replay a pass as WebGPU validates a dispatch: every group the pipeline's layout has is bound with that layout. */
function dispatches(calls: Call[]): { name: string; groups: Any[]; offsets: number[][] }[] {
  let pipeline: Any = null;
  const groups: Any[] = [];
  const offsets: number[][] = [];
  const out: { name: string; groups: Any[]; offsets: number[][] }[] = [];
  for (const call of calls) {
    if (call[0] === 'pipeline') pipeline = call[1];
    else if (call[0] === 'group') { groups[call[1]] = call[2]; offsets[call[1]] = call[3]; }
    else {
      assert.ok(pipeline, 'a pipeline is set');
      const want = pipeline.layout === 'auto' ? [0].map((i) => pipeline.getBindGroupLayout(i)) : pipeline.layout.bindGroupLayouts;
      want.forEach((layout: Any, i: number) => {
        assert.ok(groups[i], `${pipeline.label}: group ${i} bound`);
        assert.equal(groups[i].layout, layout, `${pipeline.label}: group ${i} matches its layout`);
        const dynamic = (layout.entries ?? []).filter((e: Any) => e.buffer?.hasDynamicOffset).length;
        assert.equal(offsets[i].length, dynamic, `${pipeline.label}: group ${i} dynamic offsets`);
      });
      out.push({ name: pipeline.label, groups: [...groups], offsets: offsets.map((o) => [...(o ?? [])]) });
    }
  }
  return out;
}

const auxBuffer = (fake: Fake) => fake.buffers.find((b) => b.label === 'body aux')!;
const auxWrites = (fake: Fake, from = 0) => fake.writes.slice(from).filter((w) => w.buffer === auxBuffer(fake));
const f32 = (bytes: Uint8Array) => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];

function scene(): Solver {
  const ref = new Solver();
  new Rigid(ref, [10, 1, 10], 0, 0.5, [0, -0.5, 0]);
  for (let i = 0; i < 3; i++) new Rigid(ref, [0.5, 0.5, 0.5], 1, 0.5, [i * 2, 2, 0]);
  return ref;
}

/** solveWGSL as it was before the aux record: an older custom module. */
function oldSolveWGSL(): string {
  const old = solveWGSL
    .replace(/@group\(0\) @binding\(9\) var<storage, read> bodyAux: array<vec4f>;\n/, '')
    .replace(' * bodyAux[i].x;', ';');
  assert.ok(!old.includes('bodyAux['), 'the old module reads no aux');
  return old;
}

// --- GpuSolver3D on the fake device --------------------------------------------------------------------

test('solver: aux buffer at capacity × 16 bytes, every slot (1, 0, 0, 0); integrate layout of params, bodies and aux', () => {
  const fake = fakeDevice();
  const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 7 });
  const aux = auxBuffer(fake);
  assert.equal(aux.size, 7 * 16);
  const init = fake.writes.filter((w) => w.buffer === aux);
  assert.equal(init.length, 1);
  assert.deepEqual(f32(init[0].bytes), Array.from({ length: 7 }, () => [1, 0, 0, 0]).flat());
  const integrate = fake.layouts.find((l) => l.label === 'integrate 3d');
  assert.deepEqual(integrate.entries.map((e: Any) => [e.binding, e.buffer.type]), [[0, 'uniform'], [1, 'storage'], [9, 'read-only-storage']]);
  const solve = fake.layouts.find((l) => l.label === 'solve 3d');
  assert.deepEqual(solve.entries.map((e: Any) => e.buffer.type), ['uniform', 'storage', 'storage', 'read-only-storage', 'storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage'], 'the full solve layout is unchanged');
  // No layout binds more storage buffers than the default limit (no hulls at 8)
  for (const l of fake.layouts) assert.ok(l.entries.filter((e: Any) => e.buffer && e.buffer.type !== 'uniform').length <= 8, String(l.label));
  const pipe = (name: string) => fake.pipelines.find((p) => p.label === name);
  assert.deepEqual(pipe('warmStartBodies').layout.bindGroupLayouts.map((l: Any) => l.label), ['integrate 3d', 'pass']);
  for (const name of ['warmStartJoints', 'primal', 'primalSparse', 'dual', 'updateVelocities']) {
    assert.deepEqual(pipe(name).layout.bindGroupLayouts.map((l: Any) => l.label), ['solve 3d', 'pass'], name);
  }
  assert.equal(pipe('warmStartBodies').module, pipe('primal').module, 'one solve module');
  assert.equal(gpu.supportsBodyAux, true);
  gpu.destroy();
  assert.ok(aux.destroyed, 'destroyed with the solver');
});

test('solver: setBodyAux writes runs of slots, leaves manifold reuse, refuses bad slots and values', () => {
  const fake = fakeDevice();
  const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8 });
  const from = fake.writes.length;
  (gpu as Any).manifoldsValid = true;
  gpu.setBodyAux([2], [0]);
  gpu.setBodyAux([3, 4, 6], [2, -1, 0.5]);
  assert.equal((gpu as Any).manifoldsValid, true, 'contacts keep their warm starts');
  const w = auxWrites(fake, from);
  assert.deepEqual(w.map((x) => [x.offset, f32(x.bytes)]), [[2 * 16, [0]], [3 * 16, [2, 0, 0, 0, -1, 0, 0, 0]], [6 * 16, [0.5]]]);
  assert.equal(fake.writes.length - from, 3, 'nothing but the aux record');
  for (const [i, s] of [[8, 1], [-1, 1], [1.5, 1], [0, NaN], [0, 1e39]] as const) assert.throws(() => gpu.setBodyAux([i], [s]));
  assert.throws(() => gpu.setBodyAux([0, 1], [1]));
  gpu.destroy();
});

test('solver step: warmStartBodies on the integrate group, the solve group and pass entry 0 restored, for joints and 0 iterations', () => {
  for (const iterations of [0, 1, 3]) {
    for (const split of [false, true]) {
      const fake = fakeDevice();
      const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8, spatialSort: false });
      gpu.appendJoints([{ a: 1, b: 2, rA: [1, 0, 0], rB: [-1, 0, 0] }]);
      gpu.params.iterations = iterations;
      gpu.splitPasses = split;
      for (let k = 0; k < 2; k++) {
        fake.passes.length = 0;
        gpu.step();
        const all = fake.passes.flatMap((calls) => dispatches(calls));
        const names = all.map((d) => d.name);
        const at = names.indexOf('warmStartBodies');
        assert.equal(names.filter((n) => n === 'warmStartBodies').length, 1);
        assert.equal(names[at - 1], 'warmStartJoints', 'joints warm-start first');
        assert.equal(all[at].groups[0].label, 'integrate 3d');
        assert.deepEqual(all[at].offsets[1], [0], 'pass entry 0');
        const solveGroup = all[at - 1].groups[0];
        for (const d of all.slice(at + 1)) {
          assert.notEqual(d.groups[0].label, 'integrate 3d', `${d.name} after warmStartBodies`);
          if (['primal', 'dual', 'updateVelocities'].includes(d.name)) assert.equal(d.groups[0], solveGroup, `${d.name}: the solve group`);
        }
        assert.equal(names[at + 1], iterations ? 'primal' : 'updateVelocities');
        assert.equal(names.filter((n) => n === 'dual').length, iterations);
        assert.equal(names.at(-1), 'updateVelocities');
        assert.deepEqual(all.find((d) => d.name === 'updateVelocities')!.offsets[1].length, 1);
      }
      gpu.destroy();
    }
  }
});

test('solver: an older custom solve module keeps the full layout and works by default; aux writes are refused under custom shaders', () => {
  const old = fakeDevice();
  const legacy = new GpuSolver3D(old.device, scene(), { bodyCapacity: 8, shaders: { solve: oldSolveWGSL() } });
  const pipe = (fake: Fake, name: string) => fake.pipelines.find((p) => p.label === name);
  assert.deepEqual(pipe(old, 'warmStartBodies').layout.bindGroupLayouts.map((l: Any) => l.label), ['solve 3d', 'pass']);
  legacy.appendJoints([{ a: 1, b: 2, rA: [1, 0, 0], rB: [-1, 0, 0] }]);
  legacy.step();
  const all = old.passes.flatMap((calls) => dispatches(calls));
  assert.equal(all.find((d) => d.name === 'warmStartBodies')!.groups[0].label, undefined, 'the full solve group (unlabelled)');
  assert.equal(legacy.supportsBodyAux, false);
  assert.throws(() => legacy.setBodyAux([0], [1]), /built-in solve shaders/);
  legacy.destroy();
  // Current public custom source keeps the full layout; custom contacts still use the built-in integrator.
  for (const shaders of [{ solve: solveWGSL }, { solve: solveWGSL + '\n// var<storage, read> bodyAux: array<vec4f>;' }, { contacts: contactsWGSL }]) {
    const fake = fakeDevice();
    const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8, shaders });
    assert.deepEqual(pipe(fake, 'warmStartBodies').layout.bindGroupLayouts.map((l: Any) => l.label), [shaders.solve ? 'solve 3d' : 'integrate 3d', 'pass']);
    gpu.step();
    fake.passes.forEach((calls) => dispatches(calls));
    assert.equal(gpu.supportsBodyAux, false);
    assert.throws(() => gpu.setBodyAux([0], [1]), /built-in solve shaders/);
    gpu.destroy();
  }
});

test('solver: a constructor failure releases what it made, the aux buffer included, and never a caller-owned body buffer', () => {
  for (const failPipeline of ['warmStartBodies', 'primal', 'updateRefs']) {
    const fake = fakeDevice({ failPipeline });
    const own = fake.device.createBuffer({ label: 'caller bodies', size: 8 * BODY_FLOATS * 4, usage: 0 }) as unknown as FakeBuffer;
    assert.throws(() => new GpuSolver3D(fake.device, scene(), { bodyBuffer: own as unknown as GPUBuffer }), /refused/);
    assert.ok(auxBuffer(fake), failPipeline);
    assert.deepEqual(fake.buffers.filter((b) => b !== own && !b.destroyed).map((b) => b.label), [], `${failPipeline}: nothing left`);
    assert.equal(own.destroyed, false, 'the caller keeps its buffer');
  }
});

// --- World on the fake device ------------------------------------------------------------------------------

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;

async function world(fixed = false) {
  const fake = fakeDevice();
  const w = await World.create({ device: fake.device, maxBodies: 16, ...(fixed ? { storage: FIXED } : {}) });
  return { fake, w };
}

/** Slot → gravity scale for each aux write of a flush (single-f32 and whole-record writes). */
function auxSlots(fake: Fake, from: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const w of auxWrites(fake, from)) {
    const v = f32(w.bytes);
    if (v.length === 1) { assert.equal(w.offset % 16, 0); out.set(w.offset / 16, v[0]); continue; }
    for (let k = 0; k < v.length / 4; k++) {
      assert.deepEqual(v.slice(4 * k + 1, 4 * k + 4), [0, 0, 0], 'reserved lanes stay 0');
      out.set(w.offset / 16 + k, v[4 * k]);
    }
  }
  return out;
}

test('World: every new body writes its scale (default 1) at the next flush; the setter queues only the aux record', async () => {
  const { fake, w } = await world();
  let from = fake.writes.length;
  const a = w.addBox({ size: [1, 1, 1] })!;
  const b = w.addSphere({ radius: 0.5, gravityScale: 2 })!;
  const c = w.addSphere({ radius: 0.5, gravityScale: 0, fixed: true })!;
  const d = w.addBox({ size: [1, 1, 1], gravityScale: -1, velocity: [1, 0, 0] })!;
  assert.deepEqual([a, b, c, d].map((x) => x.gravityScale), [1, 2, 0, -1]);
  assert.equal(c.fixed, true, 'a fixed body keeps its scale and stays fixed');
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[a.index, 1], [b.index, 2], [c.index, 0], [d.index, -1]]);

  from = fake.writes.length;
  (w.solver as Any).manifoldsValid = true;
  b.setGravityScale(0);
  a.setGravityScale(1);
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[a.index, 1], [b.index, 0]]);
  assert.deepEqual(fake.writes.slice(from).map((x) => x.buffer.label), ['body aux'], 'no body, filter, colour or lifecycle write');
  assert.equal((w.solver as Any).manifoldsValid, true, 'contacts are not invalidated');
  w.destroy();
  assert.ok(auxBuffer(fake).destroyed);
});

test('World: an invalid scale changes nothing, at creation (no slot or ID) and in the setter', async () => {
  const { fake, w } = await world();
  const a = w.addBox({ size: [1, 1, 1], gravityScale: 3 })!;
  w.flushCommands();
  for (const bad of BAD_SCALES) {
    if (bad === undefined) continue;
    const from = fake.writes.length;
    assert.throws(() => a.setGravityScale(bad as number), RangeError, String(bad));
    assert.equal(a.gravityScale, 3);
    assert.throws(() => w.addSphere({ radius: 0.5, gravityScale: bad as number }), /addSphere: gravityScale/, String(bad));
    assert.throws(() => w.addBox({ size: [1, 1, 1], gravityScale: bad as number }), /addBox: gravityScale/, String(bad));
    w.flushCommands();
    assert.equal(fake.writes.length, from, `${String(bad)}: nothing queued`);
  }
  assert.equal(w.bodies.length, 1);
  const next = w.addBox({ size: [1, 1, 1] })!;
  assert.equal(next.id, a.id + 1, 'no lifetime ID taken by a refused add');
  assert.equal(next.index, a.index + 1, 'no slot taken by a refused add');
  w.destroy();
});

test('World.gravity: refused atomically when any live body or active pool template would overflow (as f32)', async () => {
  const { fake, w } = await world();
  const big = w.addBox({ size: [1, 1, 1], gravityScale: -1000 })!;
  w.flushCommands();
  const before = { gravity: w.gravity, g: w.solver.params.gravity, up: [...w.solver.params.up] };
  let from = fake.writes.length;
  // Finite magnitude (1e36), product with |scale| 1000 is not finite in f32
  assert.throws(() => { w.gravity = [0, -1e36, 0]; }, /World\.gravity: .*not finite/);
  assert.throws(() => { w.gravity = [3e35, -1e36, 0]; }, /World\.gravity/);
  assert.deepEqual({ gravity: w.gravity, g: w.solver.params.gravity, up: [...w.solver.params.up] }, before, 'no partial change of size or direction');
  w.flushCommands();
  assert.equal(fake.writes.length, from, 'nothing queued');
  w.gravity = [0, -3e35, 0];
  assert.equal(w.solver.params.gravity, -3e35);
  // And the reverse: a scale refused for the current gravity, at creation and in the setter
  assert.throws(() => w.addBox({ size: [1, 1, 1], gravityScale: 1001 }), RangeError);
  big.setGravityScale(2);
  w.gravity = [0, -1e36, 0];
  from = fake.writes.length;
  assert.throws(() => big.setGravityScale(1000), /Body\.setGravityScale: gravity .* not finite/);
  assert.throws(() => w.addBox({ size: [1, 1, 1], gravityScale: -1000 }), /addBox: gravity .* not finite/);
  assert.equal(big.gravityScale, 2, 'the setter rolled back nothing because it changed nothing');
  assert.equal(w.bodies.length, 1);
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[big.index, 2]], 'only the accepted setter call is uploaded');
  // A removed body no longer constrains gravity
  w.gravity = [0, -9.81, 0];
  big.setGravityScale(1000);
  big.remove();
  w.gravity = [0, -1e36, 0];
  assert.equal(w.gravity[1], -1e36);
  w.destroy();
});

test('World: removal rewrites the default; a reused slot takes its new occupant’s value; reset and disable keep the scale', async () => {
  const { fake, w } = await world();
  const a = w.addBox({ size: [1, 1, 1], gravityScale: 0 })!;
  const b = w.addBox({ size: [1, 1, 1], gravityScale: 2 })!;
  w.flushCommands();
  let from = fake.writes.length;
  a.remove();
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[a.index, 1]], 'a vacated slot holds the default');
  assert.equal(a.gravityScale, 0, 'the handle keeps its last value for reading');
  from = fake.writes.length;
  const c = w.addBox({ size: [1, 1, 1] })!;
  w.flushCommands();
  assert.equal(c.index, a.index, 'the slot is reused');
  assert.deepEqual([...auxSlots(fake, from)], [[c.index, 1]]);
  // Removed and reused before a flush: one write, the new occupant's
  from = fake.writes.length;
  c.remove();
  const d = w.addSphere({ radius: 0.5, gravityScale: -1 })!;
  w.flushCommands();
  assert.equal(d.index, c.index);
  assert.deepEqual([...auxSlots(fake, from)], [[d.index, -1]]);
  // Reset and disable: configuration, not state
  from = fake.writes.length;
  b.reset({ position: [0, 3, 0] });
  b.setEnabled(false);
  w.flushCommands();
  b.setEnabled(true);
  w.flushCommands();
  assert.equal(auxWrites(fake, from).length, 0);
  assert.equal(b.gravityScale, 2);
  // A disabled body's scale can change; it applies when enabled
  b.setEnabled(false);
  b.setGravityScale(0.5);
  from = fake.writes.length;
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[b.index, 0.5]]);
  w.destroy();
});

test('pool: template scale validated at create (before reserving), restored for each new lease, defaulted on release; fixed storage allocates nothing', async () => {
  const { fake, w } = await world(true);
  assert.equal(auxBuffer(fake).size, (w.storageInfo as Any).buffers.bodyAux, 'the aux buffer is the plan’s');
  for (const bad of BAD_SCALES) {
    if (bad === undefined) continue;
    await assert.rejects(BodyPool.create(w, { capacity: 2, template: { kind: 'sphere', options: { radius: 0.2, gravityScale: bad as number } } }), /BodyPool template: gravityScale/, String(bad));
  }
  assert.equal(w.bodyStats.reserved, 0, 'nothing reserved');
  const made = await BodyPool.create(w, { capacity: 2, template: { kind: 'sphere', options: { radius: 0.2, gravityScale: 0 } } });
  assert.ok(made.ok);
  const pool = made.pool;
  const created = fake.buffers.length;
  let from = fake.writes.length;
  const first = (pool.tryAcquire({ position: [0, 1, 0], rotation: [0, 0, 0, 1] }) as Any).body;
  assert.equal(first.gravityScale, 0);
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[first.index, 0]]);
  first.setGravityScale(1);
  pool.release(first);
  from = fake.writes.length;
  w.flushCommands();
  assert.deepEqual([...auxSlots(fake, from)], [[first.index, 1]], 'a released slot holds the default');
  const second = (pool.tryAcquire({ position: [0, 1, 0], rotation: [0, 0, 0, 1] }) as Any).body;
  assert.equal(second.gravityScale, 0, 'the template, not the previous lease’s value');
  from = fake.writes.length;
  w.flushCommands();
  assert.equal(auxSlots(fake, from).get(second.index), 0);
  assert.equal(fake.buffers.length, created, 'no buffer allocated by leases, setters or flushes');
  // An active template constrains World.gravity even with no live lease
  pool.release(second);
  const big = await BodyPool.create(w, { capacity: 1, template: { kind: 'box', options: { size: [1, 1, 1], gravityScale: 1000 } } });
  assert.ok(big.ok);
  assert.throws(() => { w.gravity = [0, -1e36, 0]; }, /World\.gravity/);
  big.pool.dispose();
  w.gravity = [0, -1e36, 0];
  // ...and the reverse: a template refused for the current gravity, before anything is reserved
  const reserved = w.bodyStats.reserved;
  await assert.rejects(BodyPool.create(w, { capacity: 1, template: { kind: 'box', options: { size: [1, 1, 1], gravityScale: 1000 } } }), /BodyPool\.create: .*not finite/);
  assert.equal(w.bodyStats.reserved, reserved);
  pool.dispose();
  w.destroy();
});
