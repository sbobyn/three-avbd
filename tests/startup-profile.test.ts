// CPU fixtures for the startup probe core (docs/STARTUP_PROFILING.md §6). Fake device, scripted clock; no GPU.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  instrumentDevice, parseStartupArgs, profileCycle, profileSequence, sanitizeResourceName, STARTUP_SCHEMA, StartupRefusal,
  unavailable, validateStartupReport, type DeviceCalls, type ProbeModel, type StartupReport,
} from '../src/comparison/startup-profile.ts';

const METHODS = ['createShaderModule', 'createComputePipeline', 'createComputePipelineAsync', 'createRenderPipeline',
  'createRenderPipelineAsync', 'createBindGroupLayout', 'createPipelineLayout', 'createBuffer'] as const;

class FakeQueue { writes = 0; writeBuffer(..._args: unknown[]) { this.writes++; } onSubmittedWorkDone() { return Promise.resolve(); } }
class FakeDevice {
  readonly queue = new FakeQueue();
  pending: { resolve(v: unknown): void; reject(e: unknown): void }[] = [];
  createShaderModule(d: { code: string }) { return new (class GPUShaderModule { code = d.code; })(); }
  createComputePipeline(_d: unknown) { return { kind: 'compute', self: this }; }
  createComputePipelineAsync(_d: unknown) { return new Promise((resolve, reject) => this.pending.push({ resolve, reject })); }
  createRenderPipeline(_d: unknown) { return { kind: 'render' }; }
  createRenderPipelineAsync(_d: unknown) { return Promise.resolve({ kind: 'render-async' }); }
  createBindGroupLayout(_d: unknown) { return new (class GPUBindGroupLayout {})(); }
  createPipelineLayout(_d: unknown) { return new (class GPUPipelineLayout {})(); }
  createBuffer(d: { size: number }) { return { size: d.size }; }
}
const clock = () => { let t = 0; return { now: () => (t += 1), advance: (d: number) => { t += d; } }; };
const asDevice = (d: object) => d as unknown as GPUDevice;
const flush = () => new Promise(r => setImmediate(r));

test('instrumentDevice counts each kind, classifies auto layouts, and records async settles in request order', async () => {
  const dev = new FakeDevice(), c = clock();
  const inst = instrumentDevice(asDevice(dev), c.now);
  assert.equal(inst.available, true);
  const w = inst.window('x');
  const module = dev.createShaderModule({ code: 'a' });
  assert.equal((dev.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } }) as { self: unknown }).self, dev, 'real this');
  dev.createRenderPipeline({ layout: dev.createPipelineLayout({}), vertex: { module, entryPoint: 'vs' } });
  dev.createBindGroupLayout({}); dev.createBuffer({ size: 64 }); dev.createBuffer({ size: 16 });
  dev.queue.writeBuffer({}, 0, new Float32Array(8)); dev.queue.writeBuffer({}, 0, new Uint32Array(8), 2, 3);
  await dev.createRenderPipelineAsync({ layout: 'auto', vertex: { module, entryPoint: 'vs' } });
  // two overlapping async requests, settled in reverse order, then a serial one
  const p1 = dev.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'a' } });
  const p2 = dev.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'b' } });
  c.advance(10); dev.pending[1].resolve('p2'); await p2;
  c.advance(20); dev.pending[0].resolve('p1'); await p1;
  const p3 = dev.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'c' } });
  dev.pending[2].resolve('p3'); await p3; await flush();
  const calls = w.end() as DeviceCalls;
  assert.equal(calls.shaderModules, 1); assert.equal(calls.computePipelinesSync, 1); assert.equal(calls.renderPipelinesSync, 1);
  assert.equal(calls.renderPipelinesAsync, 1); assert.equal(calls.computePipelinesAsync, 3);
  assert.equal(calls.pipelineLayouts, 1); assert.equal(calls.bindGroupLayouts, 1); assert.equal(calls.autoLayoutPipelines, 5);
  assert.equal(calls.buffersCreated, 2); assert.equal(calls.bufferBytesCreated, 80);
  assert.equal(calls.queueWrites, 2); assert.equal(calls.queueWriteBytes, 32 + 12); assert.equal(dev.queue.writes, 2);
  assert.equal(calls.asyncRequestToSettleMs.length, 4); assert.equal(calls.asyncUnsettledAtEnd, 0);
  // request order: render-async, p1, p2, p3; p1 settled after p2 so its interval is longer
  assert.ok(calls.asyncRequestToSettleMs[1] > calls.asyncRequestToSettleMs[2]);
  assert.equal(calls.maxAsyncInFlight, 2);
  assert.ok(calls.syncPipelineCallWallMs > 0);
  inst.restore();
});

test('a rejected async request is counted and delivered unchanged; return identity is preserved', async () => {
  const dev = new FakeDevice();
  const inst = instrumentDevice(asDevice(dev), clock().now);
  const w = inst.window('x');
  const error = new Error('compile failed');
  const p = dev.createComputePipelineAsync({ layout: 'auto' });
  dev.pending[0].reject(error);
  await assert.rejects(p, e => e === error);
  const q = dev.createComputePipelineAsync({});
  const pending = w.end() as DeviceCalls;
  assert.equal(pending.asyncRejected, 1); assert.equal(pending.asyncUnsettledAtEnd, 1);
  const value = { v: 1 }; dev.pending[1].resolve(value);
  assert.equal(await q, value);
  // a synchronous throw propagates as the same object
  const thrown = new TypeError('bad descriptor');
  const d2 = new FakeDevice(); d2.createComputePipeline = () => { throw thrown; };
  const i2 = instrumentDevice(asDevice(d2), clock().now);
  assert.throws(() => d2.createComputePipeline({}), e => e === thrown);
  i2.restore(); inst.restore();
});

test('restore() leaves no new own properties and calls reach the originals', () => {
  const dev = new FakeDevice();
  const before = Object.getOwnPropertyNames(dev).sort(), queueBefore = Object.getOwnPropertyNames(dev.queue).sort();
  const inst = instrumentDevice(asDevice(dev), clock().now);
  assert.ok(METHODS.every(m => Object.hasOwn(dev, m)));
  const w = inst.window('x');
  inst.restore();
  assert.deepEqual(Object.getOwnPropertyNames(dev).sort(), before);
  assert.deepEqual(Object.getOwnPropertyNames(dev.queue).sort(), queueBefore);
  assert.equal(dev.createBuffer, FakeDevice.prototype.createBuffer);
  dev.createBuffer({ size: 4 });
  assert.equal((w.end() as DeviceCalls).buffersCreated, 0);
});

test('pre-existing own methods are restored with their exact descriptors', () => {
  const dev = new FakeDevice();
  const own = function createBuffer(this: unknown, d: { size: number }) { return { own: true, size: d.size, self: this }; };
  Object.defineProperty(dev, 'createBuffer', { value: own, writable: false, configurable: true, enumerable: true });
  const prior = Object.getOwnPropertyDescriptor(dev, 'createBuffer');
  const inst = instrumentDevice(asDevice(dev), clock().now);
  const w = inst.window('x');
  assert.deepEqual(dev.createBuffer({ size: 8 }), { own: true, size: 8, self: dev });
  assert.equal((w.end() as DeviceCalls).buffersCreated, 1);
  inst.restore();
  assert.deepEqual(Object.getOwnPropertyDescriptor(dev, 'createBuffer'), prior);
});

test('a hook that cannot be installed rolls back every earlier hook', () => {
  const dev = new FakeDevice();
  const ownShader = function () { return 'own'; };
  Object.defineProperty(dev, 'createShaderModule', { value: ownShader, writable: true, configurable: true, enumerable: false });
  const shaderPrior = Object.getOwnPropertyDescriptor(dev, 'createShaderModule');
  // createBuffer (8th device method) is non-configurable: installation fails part-way
  Object.defineProperty(dev, 'createBuffer', { value: FakeDevice.prototype.createBuffer, writable: false, configurable: false });
  const inst = instrumentDevice(asDevice(dev), clock().now);
  assert.equal(inst.available, false);
  assert.match((inst as { reason: string }).reason, /could not be shadowed/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(dev, 'createShaderModule'), shaderPrior);
  for (const m of METHODS.filter(m => m !== 'createShaderModule' && m !== 'createBuffer')) assert.equal(Object.hasOwn(dev, m), false, m);
  assert.equal(Object.hasOwn(dev.queue, 'writeBuffer'), false);
  assert.deepEqual(inst.window('x').end(), unavailable((inst as { reason: string }).reason));
  // a queue failure (after all device hooks) also rolls back the device hooks
  const d2 = new FakeDevice(); Object.freeze(d2.queue);
  const i2 = instrumentDevice(asDevice(d2), clock().now);
  assert.equal(i2.available, false);
  for (const m of METHODS) assert.equal(Object.hasOwn(d2, m), false, m);
});

test('distinct counts separate one-character source differences and two entry points of one module', () => {
  const dev = new FakeDevice();
  const inst = instrumentDevice(asDevice(dev), clock().now);
  const w = inst.window('x');
  const a = dev.createShaderModule({ code: 'fn main() {}' }), b = dev.createShaderModule({ code: 'fn main() {} ' });
  const a2 = dev.createShaderModule({ code: 'fn main() {}' }); // same source, different object
  const layout = dev.createPipelineLayout({});
  dev.createComputePipeline({ label: 'one', layout: 'auto', compute: { module: a, entryPoint: 'x' } });
  dev.createComputePipeline({ label: 'two', layout: 'auto', compute: { module: a2, entryPoint: 'x' } }); // same variant, label ignored
  dev.createComputePipeline({ layout: 'auto', compute: { module: a, entryPoint: 'y' } });
  dev.createComputePipeline({ layout: 'auto', compute: { module: b, entryPoint: 'x' } });
  dev.createComputePipeline({ layout, compute: { module: a, entryPoint: 'x' } });
  dev.createComputePipeline({ layout: dev.createPipelineLayout({}), compute: { module: a, entryPoint: 'x' } }); // opaque identity, not {}
  const calls = w.end() as DeviceCalls;
  assert.equal(calls.distinctModuleSources, 2);
  assert.equal(calls.distinctPipelineKeys, 5);
  inst.restore();
});

// ---- cycles ----
test('opaque layout and unknown module handles stay distinct even with plain object prototypes', () => {
  const dev = new FakeDevice();
  const inst = instrumentDevice(asDevice(dev), clock().now);
  const w = inst.window('opaque');
  const module = dev.createShaderModule({ code: '@compute fn main() {}' });
  for (const layout of [{}, {}]) dev.createComputePipeline({ layout, compute: { module, entryPoint: 'main' } });
  for (const unknownModule of [{}, {}]) dev.createComputePipeline({ layout: 'auto', compute: { module: unknownModule, entryPoint: 'main' } });
  assert.equal((w.end() as DeviceCalls).distinctPipelineKeys, 4);
  inst.restore();
});

function fakeModel(log: string[], opts: { failStep?: number; setupMs?: object | null } = {}): ProbeModel {
  let step = 0;
  return {
    metadata: opts.setupMs === null ? {} : { setupMs: opts.setupMs ?? { seeds: 1, worldCreate: 2, sdfEnable: 3 }, seedCandidates: 500 },
    step() { step++; if (step === opts.failStep) throw new Error('step failed at /Users/someone/private/file.ts'); },
    async readPoses() { return { step, poses: [] }; },
    dispose() { log.push('dispose'); },
  };
}

test('a device that refuses shadowing yields unavailable counters and the cycle still completes', async () => {
  const dev = Object.freeze(new FakeDevice());
  const inst = instrumentDevice(asDevice(dev), clock().now);
  assert.equal(inst.available, false);
  const log: string[] = [];
  const { record } = await profileCycle(0, { now: clock().now, drain: async () => {}, instrumentation: inst,
    importModel: async () => async () => fakeModel(log) });
  assert.equal(record.error, undefined);
  assert.equal((record.phases.cycleWall as { value: number }).value > 0, true);
  assert.equal((record.deviceCalls.modelCreate as { value: null }).value, null);
  assert.deepEqual(log, ['dispose']);
});

test('a throwing phase: later phases not reached, dispose once, failed status, sanitised message', async () => {
  const log: string[] = [];
  const cycles = await profileSequence(3, { now: clock().now, drain: async () => {}, importModel: async () => async () => fakeModel(log, { failStep: 2 }) });
  assert.deepEqual(log, ['dispose']);
  const c = cycles[0];
  assert.equal(c.error?.phase, 'stepEncode[2]');
  assert.doesNotMatch(c.error!.message, /Users/);
  const enc = c.phases.stepEncode as { value: number | null; reason?: string }[];
  assert.equal(typeof enc[0].value, 'number'); assert.match(enc[1].reason!, /phase failed/); assert.equal(enc[2].reason, 'not reached');
  assert.equal(typeof (c.phases.cycleWall as { value: number }).value, 'number', 'cycleWall ends at read[1], before the failure');
  assert.equal(typeof (c.phases.dispose as { value: number }).value, 'number');
  assert.match((cycles[1].phases.modelCreate as { reason: string }).reason, /earlier cycle failed/);
  assert.equal(cycles.length, 3);
  const r = baseReport({ status: 'failed', cycles });
  assert.deepEqual(validateStartupReport(r), []);
});

test('dispose is attempted after a read failure and after a clock failure; nullable setupMs is unavailable, not 0', async () => {
  const log: string[] = [];
  const model = fakeModel(log, { setupMs: null });
  model.readPoses = async () => { throw new Error('mapAsync failed'); };
  const { record } = await profileCycle(0, { now: clock().now, drain: async () => {}, importModel: async () => async () => model });
  assert.equal(record.error?.phase, 'read[1]');
  assert.deepEqual(log, ['dispose']);
  assert.match((record.phases.seeds as { reason: string }).reason, /did not report/);
  assert.equal((record.phases.cycleWall as { reason: string }).reason, 'not reached');
  // clock throws after the model exists
  const log2: string[] = []; let calls = 0, broken = false;
  const now = () => { if (broken) throw new Error('clock'); return ++calls; };
  const m2 = fakeModel(log2); m2.step = () => { broken = true; };
  const { record: r2 } = await profileCycle(0, { now, drain: async () => {}, importModel: async () => async () => m2 });
  assert.equal(r2.error?.phase, 'stepEncode[1]');
  assert.deepEqual(log2, ['dispose']);
  assert.match((r2.phases.dispose as { reason: string }).reason, /clock/);
  // a GPU error check failure is attributed to gpuCheck and still disposes
  const log3: string[] = [];
  const { record: r3 } = await profileCycle(0, { now: clock().now, drain: async () => {}, check: () => { throw new Error('GPU error: x'); },
    importModel: async () => async () => fakeModel(log3) });
  assert.equal(r3.error?.phase, 'gpuCheck'); assert.deepEqual(log3, ['dispose']);
});

test('cycle kinds and one dispose per model before the next is created; render only in cycle 0', async () => {
  const log: string[] = [];
  let n = 0, renders = 0;
  const factory = async () => { log.push(`create${n}`); const i = n++; const m = fakeModel(log); m.dispose = () => log.push(`dispose${i}`); return m; };
  const dev = new FakeDevice();
  const inst = instrumentDevice(asDevice(dev), clock().now);
  const cycles = await profileSequence(4, { now: clock().now, drain: async () => {}, instrumentation: inst, importModel: async () => factory,
    render: { call() { renders++; }, nextFrame: async () => {} } });
  inst.restore();
  assert.deepEqual(cycles.map(c => c.kind), ['first-on-device', 'same-device-recreate', 'same-device-recreate', 'same-device-recreate']);
  assert.deepEqual(log, ['create0', 'dispose0', 'create1', 'dispose1', 'create2', 'dispose2', 'create3', 'dispose3']);
  assert.equal(renders, 1);
  assert.equal(typeof (cycles[0].phases.modelImport as { value: number }).value, 'number');
  assert.equal((cycles[1].phases.modelImport as { reason: string }).reason, 'cycle 0 only');
  assert.equal((cycles[1].phases.renderCall as { reason: string }).reason, 'cycle 0 only');
  assert.equal((cycles[0].phases.sdfAtlasPackReplay as { value: null }).value, null);
  assert.match((cycles[0].deviceCalls.worldCreate as { reason: string }).reason, /aggregate/);
  assert.equal(typeof (cycles[0].deviceCalls.modelCreate as DeviceCalls).shaderModules, 'number');
  assert.equal(cycles.every(c => c.poseStep === 3), true);
  assert.deepEqual(validateStartupReport(baseReport({ status: 'completed', cycles })), []);
  await assert.rejects(profileSequence(5, { now: clock().now, drain: async () => {} }), RangeError);
});

test('a clock failure immediately after acquisition still disposes the acquired model', async () => {
  const log: string[] = [];
  let broken = false;
  const { record } = await profileCycle(0, {
    now: () => { if (broken) throw new Error('post-acquire clock'); return 1; }, drain: async () => {},
    importModel: async () => async () => { broken = true; return fakeModel(log); },
  });
  assert.equal(record.error?.phase, 'modelCreate');
  assert.deepEqual(log, ['dispose']);
});

test('a failed disposal blocks replacement models in the same sequence', async () => {
  let made = 0;
  const cycles = await profileSequence(3, { now: clock().now, drain: async () => {}, importModel: async () => async () => {
    made++;
    const model = fakeModel([]);
    model.dispose = () => { throw new Error('dispose failed'); };
    return model;
  } });
  assert.equal(made, 1);
  assert.equal(cycles[0].disposeError, 'dispose failed');
  assert.match((cycles[1].phases.modelCreate as { reason: string }).reason, /earlier cycle failed/);
});

function baseReport(over: Partial<StartupReport>): StartupReport {
  return { schema: STARTUP_SCHEMA, status: 'completed', diagnostic: true, benchmark: false, observedAt: '2026-11-10T00:00:00.000Z',
    source: { git: { source: 'unknown', head: null, dirty: null, reason: 'x' } }, environment: { adapter: unavailable('refused'), userAgent: null },
    settings: { cycles: over.cycles?.length ?? 0 }, run: { label: 'x', navigationType: null, loadIndexInTab: null, orderInSequence: null, operatorNote: null, cacheState: 'unknown' },
    cycles: [], uncapturedGpuErrors: [], deviceLost: null, instrumentation: { requested: false, available: false, reason: null }, limits: [], ...over };
}

test('validateStartupReport rejects NaN, bare null phases, summed/compile keys, other cacheState and machine paths', async () => {
  const { record } = await profileCycle(0, { now: clock().now, drain: async () => {}, importModel: async () => async () => fakeModel([]) });
  const ok = baseReport({ cycles: [record] });
  assert.deepEqual(validateStartupReport(ok), []);
  assert.deepEqual(validateStartupReport(baseReport({ status: 'refused' })), [], 'refused report with nullable metadata is valid');
  const clone = () => structuredClone(ok);
  const nan = clone(); (nan.cycles[0].phases.dispose as { value: number }).value = NaN;
  const bare = clone(); bare.cycles[0].phases.seeds = null as never;
  const total = clone(); (total as unknown as Record<string, unknown>).total = 1;
  const compile = clone(); (compile.cycles[0].phases as Record<string, unknown>).compileMs = { value: 1 };
  const cache = clone(); (cache.run as { cacheState: string }).cacheState = 'warm';
  const path = clone(); path.environment.assets = [{ name: '/@fs/Users/x/y.ts' }];
  const zeroAsMissing = clone(); (zeroAsMissing.cycles[0].phases.dispose as Record<string, unknown>) = { value: 0, reason: 'missing' } as never;
  for (const [name, r] of Object.entries({ nan, bare, total, compile, cache, path, zeroAsMissing })) assert.ok(validateStartupReport(r).length > 0, name);
});

test('resource names drop credentials, queries and machine paths', () => {
  const o = 'http://127.0.0.1:5400';
  assert.equal(sanitizeResourceName('http://u:p@127.0.0.1:5400/src/a.ts?t=123&token=abc#x', o), '/src/a.ts');
  assert.equal(sanitizeResourceName('http://127.0.0.1:5400/@fs/Users/someone/dev/x/node_modules/three/build/three.js?v=1', o), '/@fs/<path>');
  assert.equal(sanitizeResourceName('https://cdn.example.com/private/lib.js?key=1', o), 'https://cdn.example.com/<cross-origin>');
  assert.deepEqual(validateStartupReport({ ...baseReport({}), environment: { assets: [{ name: '/@fs/<path>' }] } }), []);
});

test('CLI arguments are validated before any GPU work', () => {
  assert.deepEqual(parseStartupArgs([]), { cycles: 4, label: 'node', instrument: true, help: false });
  assert.deepEqual(parseStartupArgs(['--cycles', '2', '--no-instrument', '--label', 'nav 1/../x', '--json', 'o.json']),
    { cycles: 2, label: 'nav1..x', instrument: false, help: false, json: 'o.json' });
  for (const bad of [['--cycles', '5'], ['--cycles', '0'], ['--cycles', '1.5'], ['--json'], ['--json', '--cycles'], ['--push']]) {
    assert.throws(() => parseStartupArgs(bad), StartupRefusal, bad.join(' '));
  }
});
