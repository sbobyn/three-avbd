// Per-body velocity damping (STE-3328, second slice of the body-aux record, docs/BODY_AUX_DESIGN.md):
// input validation, the effective rate × dt check, the shader text (public custom-solve source
// unchanged, built-in variant only), the capability, and, on a recording fake device (no GPU, no
// shader compilation), what World, BodyPool and GpuSolver3D write: aux uploads and their lifetime,
// refused changes leaving everything as it was, and no allocation from setters or steps. GPU
// behaviour (analytic decay, fixed/kinematic, SDF, default equivalence) is
// tests-gpu/damping.gpu.test.ts.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { A_ANGULAR_DAMPING, A_GRAVITY_SCALE, A_LINEAR_DAMPING, BODY_AUX_FLOATS, BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { solveBodyAuxWGSL, solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { checkDamping, checkEffectiveDamping, MAX_DAMPING_RATE } from '../src/lib/world-validation.ts';
import { deviceCapabilities, worldCapabilities } from '../src/lib/capabilities.ts';
import type { StorageLimits } from '../src/lib/storage-budget.ts';
import { World } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import type { BodyDamping, DampingOptions } from '../src/lib/index.ts';

const F32_MAX = 3.4028234663852886e38;
/** solveWGSL's SHA-256 before damping (and before gravity scale): the custom-solve contract. */
const SOLVE_WGSL_SHA256 = 'f2228d885f039af67798bd759ce25dbfa927d290c9d8d149ae3419cda2ff5df3';
const BAD_RATES: unknown[] = [NaN, Infinity, -Infinity, -1, -1e-50, 1001, 1000.001, 1e39, '1', null, true, {}, [1], 1n];
const BAD_SHAPES: unknown[] = [null, 1, 'x', true, [], [1, 2], 1n, { linear: 1, angluar: 1 }, { x: 0 }];

// --- Pure checks ------------------------------------------------------------------------------

test('damping: rates finite as f32 within [0, 1000] 1/s; missing rates (or pair) are 0 in options', () => {
  assert.equal(MAX_DAMPING_RATE, 1000);
  assert.deepEqual(checkDamping(undefined, 'addBox'), { linear: 0, angular: 0 });
  assert.deepEqual(checkDamping({}, 'addBox'), { linear: 0, angular: 0 });
  assert.deepEqual(checkDamping({ linear: 2 }, 'addBox'), { linear: 2, angular: 0 });
  assert.deepEqual(checkDamping({ angular: 3 }, 'addBox'), { linear: 0, angular: 3 });
  assert.deepEqual(checkDamping({ linear: undefined, angular: 1 }, 'addBox'), { linear: 0, angular: 1 });
  // -0, f32 underflow (1e-46 rounds to 0) and a value that rounds to the bound are accepted
  for (const ok of [0, -0, 1, 0.5, 1000, 1e-46, 1e-39, 1000.00000001]) {
    assert.deepEqual(checkDamping({ linear: ok, angular: ok }, 'x', true), { linear: ok, angular: ok }, String(ok));
  }
  for (const bad of BAD_RATES) {
    for (const key of ['linear', 'angular']) {
      assert.throws(() => checkDamping({ linear: 0, angular: 0, [key]: bad }, 'Body.setDamping', true), (e: unknown) => e instanceof RangeError && e.message.startsWith(`Body.setDamping: damping.${key} must be`), `${key} ${String(bad)}`);
    }
  }
  for (const bad of BAD_SHAPES) assert.throws(() => checkDamping(bad, 'addSphere'), (e: unknown) => e instanceof TypeError && /^addSphere: damping/.test(e.message), String(bad));
});

test('damping: the setter form needs both rates; the result is a frozen copy read once', () => {
  for (const partial of [undefined, {}, { linear: 1 }, { angular: 1 }, { linear: 1, angular: undefined }]) {
    assert.throws(() => checkDamping(partial, 'Body.setDamping', true), TypeError, String(partial));
  }
  const source: DampingOptions = { linear: 1, angular: 2 };
  const pair: BodyDamping = checkDamping(source, 'x', true);
  source.linear = 5;
  assert.deepEqual(pair, { linear: 1, angular: 2 }, 'the caller’s object does not alias it');
  assert.ok(Object.isFrozen(pair));
  assert.throws(() => { (pair as { linear: number }).linear = 9; }, TypeError);
  // A getter is read once: what is checked is what is kept
  let reads = 0;
  const tricky = { get linear() { reads++; return reads === 1 ? 1 : NaN; }, angular: 0 };
  assert.deepEqual(checkDamping(tricky, 'x', true), { linear: 1, angular: 0 });
  assert.equal(reads, 1);
});

test('effective damping: rate × dt must be finite as f32, which a finite rate and dt do not guarantee', () => {
  checkEffectiveDamping(1000, 1 / 60, 'x');
  checkEffectiveDamping(1000, 3e35, 'x');
  checkEffectiveDamping(0, F32_MAX, 'x');
  checkEffectiveDamping(1e-46, F32_MAX, 'x'); // rounds to 0 as f32
  assert.throws(() => checkEffectiveDamping(1000, 1e36, 'World.dt'), /World\.dt: damping 1000 1\/s times dt .* not finite \(as f32\)/);
  assert.throws(() => checkEffectiveDamping(2, F32_MAX, 'addBox'), RangeError);
});

// --- Shader text and capability ------------------------------------------------------------------

test('shader: exported solveWGSL is byte-identical; only the built-in variant damps, in warmStartBodies, before prediction', () => {
  assert.equal(createHash('sha256').update(solveWGSL).digest('hex'), SOLVE_WGSL_SHA256);
  assert.ok(!solveWGSL.includes('bodyAux') && !solveWGSL.includes('exp(-aux'));
  const start = solveBodyAuxWGSL.indexOf('fn warmStartBodies(');
  const end = solveBodyAuxWGSL.indexOf('@compute', start + 1);
  const body = solveBodyAuxWGSL.slice(start, end);
  assert.equal([...solveBodyAuxWGSL.matchAll(/bodyAux\[/g)].length, 1, 'the record is read once');
  assert.ok(body.includes('let aux = bodyAux[i];'));
  const branch = body.indexOf('if (dynamic && (aux.y > 0.0 || aux.z > 0.0))');
  assert.ok(branch > 0, 'dynamic bodies with a nonzero rate only');
  assert.ok(body.includes('vel.xyz * exp(-aux.y * dt)') && body.includes('angVel * exp(-aux.z * dt)'));
  assert.ok(branch < body.indexOf('var inertialPos'), 'before the inertial target and warm start');
  assert.ok(branch > body.indexOf('let dynamic'), 'after the dynamic test');
  // updateVelocities is unchanged in both variants
  const update = (code: string) => code.slice(code.indexOf('fn updateVelocities('));
  assert.equal(update(solveBodyAuxWGSL), update(solveWGSL));
});

test('capability: damping follows gravityScale (the built-in integrator), independently of collision backend', () => {
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 8 } });
  for (const backend of ['standard', 'sdf', 'custom'] as const) {
    for (const args of [[false], [true], [false, false, false], [false, false, true], [false, false, false, false]] as const) {
      const c = worldCapabilities(device, backend, ...(args as [boolean]));
      assert.equal(c.damping, c.gravityScale, `${backend} ${args}`);
    }
    assert.equal(worldCapabilities(device, backend, false).damping, true);
    assert.equal(worldCapabilities(device, backend, false, true).damping, false, `${backend}, custom shaders`);
  }
});

// --- A recording fake device ----------------------------------------------------------------------

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
interface FakeBuffer { label: string; size: number; destroyed: boolean }
interface Write { buffer: FakeBuffer; offset: number; bytes: Uint8Array }

function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const writes: Write[] = [];
  const counts = { bindGroups: 0, pipelines: 0 };
  const device: Any = {
    limits: { maxStorageBuffersPerShaderStage: 8, ...LIMITS },
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
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) { return { label: desc.label, entries: [...desc.entries] }; },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) { return { bindGroupLayouts: [...desc.bindGroupLayouts] }; },
    createShaderModule(desc: GPUShaderModuleDescriptor) { return { code: desc.code }; },
    createComputePipeline(desc: Any) {
      counts.pipelines++;
      return { label: desc.label, layout: desc.layout, getBindGroupLayout: () => ({ auto: true }) };
    },
    createBindGroup(desc: Any) { counts.bindGroups++; return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createQuerySet() { return { destroy() {} }; },
    createCommandEncoder() {
      return {
        clearBuffer() {}, copyBufferToBuffer() {}, resolveQuerySet() {}, finish: () => ({}),
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {} }),
      };
    },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device: device as GPUDevice, buffers, writes, counts };
}

type Fake = ReturnType<typeof fakeDevice>;

const auxBuffer = (fake: Fake) => fake.buffers.find((b) => b.label === 'body aux')!;
const auxWrites = (fake: Fake, from = 0) => fake.writes.slice(from).filter((w) => w.buffer === auxBuffer(fake));
const f32 = (bytes: Uint8Array) => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];
const r32 = (v: number) => Math.fround(v);

/** Slot → whole aux record (scale, linear, angular, reserved) for each aux write since `from`. */
function auxRecords(fake: Fake, from: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const w of auxWrites(fake, from)) {
    const v = f32(w.bytes);
    assert.equal(w.offset % 16, 0, 'whole records');
    assert.equal(v.length % BODY_AUX_FLOATS, 0, 'whole records');
    for (let k = 0; k < v.length / 4; k++) out.set(w.offset / 16 + k, v.slice(4 * k, 4 * k + 4));
  }
  return out;
}

function scene(): Solver {
  const ref = new Solver();
  new Rigid(ref, [10, 1, 10], 0, 0.5, [0, -0.5, 0]);
  for (let i = 0; i < 3; i++) new Rigid(ref, [0.5, 0.5, 0.5], 1, 0.5, [i * 2, 2, 0]);
  return ref;
}

// --- GpuSolver3D -------------------------------------------------------------------------------------

test('solver: setBodyAux with rates writes whole records (scale and both rates), runs in one write', () => {
  const fake = fakeDevice();
  const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8 });
  const from = fake.writes.length;
  (gpu as Any).manifoldsValid = true;
  gpu.setBodyAux([2], [0.5], [1], [2]);
  gpu.setBodyAux([3, 4, 6], [1, -1, 1], [0, 3, 0.25], [4, 0, 0]);
  assert.equal((gpu as Any).manifoldsValid, true, 'contacts keep their warm starts');
  assert.deepEqual(auxWrites(fake, from).map((x) => [x.offset, f32(x.bytes)]), [
    [2 * 16, [0.5, 1, 2, 0]],
    [3 * 16, [1, 0, 4, 0, -1, 3, 0, 0]],
    [6 * 16, [1, 0.25, 0, 0]],
  ]);
  assert.equal(fake.writes.length - from, 3, 'nothing but the aux record');
  // Older callers (no rate arrays): a single slot's scale lane only, as before
  const before = fake.writes.length;
  gpu.setBodyAux([2], [3]);
  assert.deepEqual(auxWrites(fake, before).map((x) => [x.offset, f32(x.bytes)]), [[2 * 16, [3]]]);
  gpu.destroy();
});

test('solver: setBodyAux checks every rate before any write; both rate arrays or neither', () => {
  const fake = fakeDevice();
  const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8 });
  const from = fake.writes.length;
  for (const bad of [NaN, Infinity, -1, 1e39, '1' as unknown as number]) {
    assert.throws(() => gpu.setBodyAux([0, 1, 2], [1, 1, 1], [0, 0, bad], [0, 0, 0]), /damping rates/, String(bad));
    assert.throws(() => gpu.setBodyAux([0, 1, 2], [1, 1, 1], [0, 0, 0], [bad, 0, 0]), /damping rates/, String(bad));
  }
  assert.throws(() => gpu.setBodyAux([0], [1], [0]), /both damping rate arrays or neither/);
  assert.throws(() => gpu.setBodyAux([0], [1], undefined, [0]), /both damping rate arrays or neither/);
  assert.throws(() => gpu.setBodyAux([0, 1], [1, 1], [0], [0, 0]), /one damping pair per index/);
  assert.throws(() => gpu.setBodyAux([0], [NaN], [0], [0]), /scales/);
  assert.equal(fake.writes.length, from, 'nothing written by a refused call');
  gpu.destroy();
});

test('solver: custom solve modules refuse damping writes (never silently ignored)', () => {
  for (const solve of [solveWGSL, solveWGSL + '\n// @group(0) @binding(9) var<storage, read> bodyAux: array<vec4f>;']) {
    const fake = fakeDevice();
    const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8, shaders: { solve } });
    assert.equal(gpu.supportsBodyAux, false);
    assert.throws(() => gpu.setBodyAux([0], [1], [1], [0]), /built-in solve shaders/);
    gpu.step();
    gpu.destroy();
  }
});

test('solver: steps with damped slots allocate no buffers, bind groups or pipelines', () => {
  const fake = fakeDevice();
  const gpu = new GpuSolver3D(fake.device, scene(), { bodyCapacity: 8 });
  gpu.setBodyAux([1, 2, 3], [1, 1, 1], [1, 2, 3], [0.5, 0, 1]);
  gpu.step();
  const made = { buffers: fake.buffers.length, ...fake.counts };
  const from = fake.writes.length;
  for (let k = 0; k < 5; k++) gpu.step();
  assert.deepEqual({ buffers: fake.buffers.length, ...fake.counts }, made);
  assert.equal(auxWrites(fake, from).length, 0, 'no aux upload per step');
  gpu.destroy();
});

// --- World ------------------------------------------------------------------------------------

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;

async function world(fixed = false) {
  const fake = fakeDevice();
  const w = await World.create({ device: fake.device, maxBodies: 16, ...(fixed ? { storage: FIXED } : {}) });
  return { fake, w };
}

test('World: unset and explicit 0 write the same record; options and setter upload whole records, aux only', async () => {
  const { fake, w } = await world();
  let from = fake.writes.length;
  const a = w.addBox({ size: [1, 1, 1] })!;
  const b = w.addBox({ size: [1, 1, 1], damping: { linear: 0, angular: 0 } })!;
  const c = w.addSphere({ radius: 0.5, damping: { linear: 1 } })!;
  const d = w.addSphere({ radius: 0.5, damping: { angular: 0.5 }, gravityScale: 2 })!;
  const e = w.addBox({ size: [1, 1, 1], fixed: true, damping: { linear: 3, angular: 4 } })!;
  assert.deepEqual([a, b, c, d, e].map((x) => x.damping), [{ linear: 0, angular: 0 }, { linear: 0, angular: 0 }, { linear: 1, angular: 0 }, { linear: 0, angular: 0.5 }, { linear: 3, angular: 4 }]);
  assert.equal(e.fixed, true, 'a fixed body keeps its rates and stays fixed');
  w.flushCommands();
  const records = auxRecords(fake, from);
  assert.deepEqual(records.get(a.index), records.get(b.index), 'unset is explicit 0');
  assert.deepEqual([...records], [[a.index, [1, 0, 0, 0]], [b.index, [1, 0, 0, 0]], [c.index, [1, 1, 0, 0]], [d.index, [2, 0, 0.5, 0]], [e.index, [1, 3, 4, 0]]]);

  from = fake.writes.length;
  (w.solver as Any).manifoldsValid = true;
  c.setDamping({ linear: 0.1, angular: 2 });
  d.setGravityScale(-1);
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[c.index, [1, r32(0.1), 2, 0]], [d.index, [-1, 0, 0.5, 0]]], 'scale and rates kept together');
  assert.deepEqual(fake.writes.slice(from).map((x) => x.buffer.label), ['body aux'], 'no body, filter, colour or lifecycle write');
  assert.equal((w.solver as Any).manifoldsValid, true, 'contacts are not invalidated');
  w.destroy();
});

test('World: the damping getter is an owned frozen pair; caller objects and getters cannot change it', async () => {
  const { w } = await world();
  const source = { linear: 1, angular: 2 };
  const a = w.addBox({ size: [1, 1, 1], damping: source })!;
  source.linear = 7;
  assert.deepEqual(a.damping, { linear: 1, angular: 2 });
  const pair = a.damping;
  assert.ok(Object.isFrozen(pair));
  assert.throws(() => { (pair as Any).angular = 9; }, TypeError);
  const next = { linear: 3, angular: 4 };
  a.setDamping(next);
  next.angular = 0;
  assert.deepEqual(a.damping, { linear: 3, angular: 4 });
  assert.deepEqual(pair, { linear: 1, angular: 2 }, 'an earlier read is a snapshot');
  w.destroy();
});

test('World: invalid or partial damping changes nothing (no slot, ID or upload); the setter needs both rates', async () => {
  const { fake, w } = await world();
  const a = w.addBox({ size: [1, 1, 1], damping: { linear: 2, angular: 1 } })!;
  w.flushCommands();
  const from = fake.writes.length;
  for (const bad of BAD_RATES) {
    assert.throws(() => a.setDamping({ linear: bad as number, angular: 0 }), RangeError, String(bad));
    assert.throws(() => a.setDamping({ linear: 0, angular: bad as number }), RangeError, String(bad));
    assert.throws(() => w.addBox({ size: [1, 1, 1], damping: { linear: bad as number } }), /addBox: damping\.linear/, String(bad));
    assert.throws(() => w.addSphere({ radius: 0.5, damping: { angular: bad as number } }), /addSphere: damping\.angular/, String(bad));
  }
  for (const bad of [...BAD_SHAPES, undefined, {}, { linear: 1 }, { angular: 1 }]) {
    assert.throws(() => a.setDamping(bad as Any), TypeError, String(bad));
  }
  for (const bad of BAD_SHAPES) assert.throws(() => w.addBox({ size: [1, 1, 1], damping: bad as Any }), TypeError, String(bad));
  assert.deepEqual(a.damping, { linear: 2, angular: 1 });
  w.flushCommands();
  assert.equal(fake.writes.length, from, 'nothing queued');
  assert.equal(w.bodies.length, 1);
  const next = w.addBox({ size: [1, 1, 1] })!;
  assert.equal(next.id, a.id + 1, 'no lifetime ID taken by a refused add');
  assert.equal(next.index, a.index + 1, 'no slot taken by a refused add');
  w.destroy();
});

test('World.dt: refused atomically when a live body or active pool template rate × dt would overflow; default bodies keep accepted dt', async () => {
  // Without damping, every dt checkDt accepted before is still accepted
  const plain = await world();
  plain.w.addBox({ size: [1, 1, 1] });
  plain.w.dt = 1e36;
  assert.equal(plain.w.dt, 1e36);
  plain.w.dt = F32_MAX;
  plain.w.destroy();

  const { fake, w } = await world();
  const a = w.addBox({ size: [1, 1, 1], damping: { linear: 0, angular: 1000 } })!;
  w.flushCommands();
  const from = fake.writes.length;
  assert.throws(() => { w.dt = 1e36; }, /World\.dt: damping 1000 .* not finite/);
  assert.equal(w.dt, 1 / 60, 'dt unchanged');
  assert.throws(() => { w.dt = -1; }, /World\.dt must be finite and positive/);
  w.dt = 1e33;
  assert.equal(w.dt, 1e33);
  // And the reverse: rates refused for the current dt, at creation and in the setter
  a.setDamping({ linear: 0, angular: 1 });
  w.dt = 1e36; // 1/s × 1e36 s is finite; 1000/s × 1e36 s is not
  assert.throws(() => a.setDamping({ linear: 1000, angular: 0 }), /Body\.setDamping: damping .* not finite/);
  assert.throws(() => w.addBox({ size: [1, 1, 1], damping: { angular: 1000 } }), /addBox: damping .* not finite/);
  a.setDamping({ linear: 1, angular: 1 });
  assert.equal(w.bodies.length, 1);
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[a.index, [1, 1, 1, 0]]], 'only the accepted setter calls are uploaded (one record)');
  // A removed body no longer constrains dt
  w.dt = 1 / 60;
  a.setDamping({ linear: 1000, angular: 1000 });
  assert.throws(() => { w.dt = 1e36; }, RangeError);
  a.remove();
  w.dt = 1e36;
  assert.equal(w.dt, 1e36);
  w.destroy();
});

test('World: removal writes the default; a reused slot takes its new occupant’s rates; reset and disable keep them', async () => {
  const { fake, w } = await world();
  const a = w.addBox({ size: [1, 1, 1], damping: { linear: 5, angular: 6 } })!;
  const b = w.addBox({ size: [1, 1, 1], damping: { linear: 1, angular: 2 } })!;
  w.flushCommands();
  let from = fake.writes.length;
  a.remove();
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[a.index, [1, 0, 0, 0]]], 'a vacated slot holds the default');
  assert.deepEqual(a.damping, { linear: 5, angular: 6 }, 'the handle keeps its last value for reading');
  // As setGravityScale: a removed handle's setter uploads nothing
  from = fake.writes.length;
  a.setDamping({ linear: 0, angular: 0 });
  w.flushCommands();
  assert.equal(auxWrites(fake, from).length, 0);
  from = fake.writes.length;
  const c = w.addBox({ size: [1, 1, 1] })!;
  w.flushCommands();
  assert.equal(c.index, a.index, 'the slot is reused');
  assert.deepEqual([...auxRecords(fake, from)], [[c.index, [1, 0, 0, 0]]], 'no old rates leak');
  // Removed and reused before a flush: one write, the new occupant's
  from = fake.writes.length;
  c.remove();
  const d = w.addSphere({ radius: 0.5, damping: { angular: 3 } })!;
  w.flushCommands();
  assert.equal(d.index, c.index);
  assert.deepEqual([...auxRecords(fake, from)], [[d.index, [1, 0, 3, 0]]]);
  // Reset and disable: configuration, not state
  from = fake.writes.length;
  b.reset({ position: [0, 3, 0], velocity: [1, 0, 0] });
  b.setEnabled(false);
  w.flushCommands();
  b.setEnabled(true);
  w.flushCommands();
  assert.equal(auxWrites(fake, from).length, 0);
  assert.deepEqual(b.damping, { linear: 1, angular: 2 });
  // A disabled body's rates can change; they apply when enabled
  b.setEnabled(false);
  b.setDamping({ linear: 0, angular: 0.5 });
  from = fake.writes.length;
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[b.index, [1, 0, 0.5, 0]]]);
  w.destroy();
});

// --- BodyPool ---------------------------------------------------------------------------------

test('pool: template rates validated and copied at create, restored for each lease, defaulted on release; no allocation', async () => {
  const { fake, w } = await world(true);
  for (const bad of BAD_RATES) {
    await assert.rejects(BodyPool.create(w, { capacity: 2, template: { kind: 'sphere', options: { radius: 0.2, damping: { linear: bad as number } } } }), /BodyPool template: damping\.linear/, String(bad));
  }
  for (const bad of BAD_SHAPES) {
    await assert.rejects(BodyPool.create(w, { capacity: 2, template: { kind: 'sphere', options: { radius: 0.2, damping: bad as Any } } }), /BodyPool template: damping/, String(bad));
  }
  assert.equal(w.bodyStats.reserved, 0, 'nothing reserved');
  const damping = { linear: 2, angular: 0.5 };
  const made = await BodyPool.create(w, { capacity: 2, template: { kind: 'sphere', options: { radius: 0.2, damping } } });
  assert.ok(made.ok);
  damping.linear = 99; // the caller's template object no longer matters
  const pool = made.pool;
  const created = fake.buffers.length;
  let from = fake.writes.length;
  const first = (pool.tryAcquire({ position: [0, 1, 0], rotation: [0, 0, 0, 1] }) as Any).body;
  assert.deepEqual(first.damping, { linear: 2, angular: 0.5 });
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[first.index, [1, 2, 0.5, 0]]]);
  first.setDamping({ linear: 0, angular: 0 });
  pool.release(first);
  from = fake.writes.length;
  w.flushCommands();
  assert.deepEqual([...auxRecords(fake, from)], [[first.index, [1, 0, 0, 0]]], 'a released slot holds the default');
  const second = (pool.tryAcquire({ position: [0, 1, 0], rotation: [0, 0, 0, 1] }) as Any).body;
  assert.deepEqual(second.damping, { linear: 2, angular: 0.5 }, 'the template, not the previous lease’s value');
  assert.notEqual(second.damping, first.damping);
  from = fake.writes.length;
  w.flushCommands();
  assert.deepEqual(auxRecords(fake, from).get(second.index), [1, 2, 0.5, 0]);
  assert.equal(fake.buffers.length, created, 'no buffer allocated by leases, setters or flushes');
  // An active template constrains World.dt even with no live lease
  pool.release(second);
  const big = await BodyPool.create(w, { capacity: 1, template: { kind: 'box', options: { size: [1, 1, 1], damping: { angular: 1000 } } } });
  assert.ok(big.ok);
  assert.throws(() => { w.dt = 1e36; }, /World\.dt/);
  assert.equal(w.dt, 1 / 60);
  big.pool.dispose();
  w.dt = 1e36;
  // ...and the reverse: a template refused for the current dt, before anything is reserved
  const reserved = w.bodyStats.reserved;
  await assert.rejects(BodyPool.create(w, { capacity: 1, template: { kind: 'box', options: { size: [1, 1, 1], damping: { linear: 1000 } } } }), /BodyPool\.create: .*not finite/);
  assert.equal(w.bodyStats.reserved, reserved);
  pool.dispose();
  w.destroy();
});

test('layout: rates sit in the existing aux record; body stride and record size unchanged', () => {
  assert.deepEqual([BODY_AUX_FLOATS, A_GRAVITY_SCALE, A_LINEAR_DAMPING, A_ANGULAR_DAMPING, BODY_FLOATS], [4, 0, 1, 2, 40]);
});
