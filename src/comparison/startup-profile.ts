// Startup / same-device recreate diagnostic probe core (STE-3003, docs/STARTUP_PROFILING.md).
// Device-free and clock-injectable: the Node script and the dev-only browser page own the GPU device
// and renderer, and pass them in only through the callbacks below. Not a benchmark: no summed total,
// no compile-time figure, no cache-hit inference. Nothing here imports the model, the library or Three.js,
// so the hosts' dynamic import of the model stays a measurable window.
import { INTERLOCKING } from './interlocking-scene.ts';
import { sanitizeMessage } from './interlocking-trial.ts';

export const STARTUP_SCHEMA = 'three-avbd/startup-profile/v1';
export const STARTUP_MAX_CYCLES = 4;
export const STARTUP_STEPS_PER_CYCLE = 3;
export type Unavailable = { value: null; reason: string };
/** A measured duration, or why it was not measured. A real 0 is a measured zero, never "missing". */
export type Ms = { value: number } | Unavailable;
export const unavailable = (reason: string): Unavailable => ({ value: null, reason });
const ms = (value: number): Ms => ({ value });

export const STARTUP_LIMITS = [
  'Diagnostic observation of one tiny scene, not a benchmark; phases overlap and are never summed',
  'No phase is compile time: sync pipeline calls may defer compilation to first use (stepDrain)',
  'cacheState is always unknown: browser/driver compiled-shader reuse is opaque to WebGPU',
  'Same-device cycles 1..n against cycle 0 are the only comparison isolating the application',
  'seeds/worldCreate/sdfEnable are the model\'s own setupMs; their device calls are only available in aggregate (modelCreate)',
  'Device-call counters identify requests and request variants, not driver or browser cache hits',
  'Dev-server asset timings reflect an unbundled module graph and the HTTP cache only',
  'M4 Max development-machine figures do not transfer to the M1 / GTX 1080 target',
];

// ---- device-call instrumentation --------------------------------------------------------------------

export interface DeviceCalls {
  shaderModules: number;
  computePipelinesSync: number; computePipelinesAsync: number;
  renderPipelinesSync: number; renderPipelinesAsync: number;
  bindGroupLayouts: number; pipelineLayouts: number; autoLayoutPipelines: number;
  /** Main-thread time inside sync createComputePipeline/createRenderPipeline calls. NOT compile time. */
  syncPipelineCallWallMs: number;
  /** Main-thread time inside createShaderModule calls. */
  shaderModuleCallWallMs: number;
  /** One per async request issued in this window that settled before the window ended, in request order. */
  asyncRequestToSettleMs: number[];
  /** Async requests issued in this window still pending when it ended (absent from the list above). */
  asyncUnsettledAtEnd: number;
  asyncRejected: number; maxAsyncInFlight: number;
  /** Computed after the window closes, by source value (modules) and request variant (pipelines). */
  distinctModuleSources: number; distinctPipelineKeys: number;
  buffersCreated: number; bufferBytesCreated: number;
  queueWrites: number; queueWriteBytes: number;
}

export interface DeviceWindow { end(): DeviceCalls }
export type Instrumentation =
  | { available: true; window(name: string): DeviceWindow; restore(): void }
  | { available: false; reason: string; window(name: string): { end(): Unavailable }; restore(): void };

const DEVICE_METHODS = ['createShaderModule', 'createComputePipeline', 'createComputePipelineAsync', 'createRenderPipeline',
  'createRenderPipelineAsync', 'createBindGroupLayout', 'createPipelineLayout', 'createBuffer'] as const;
const QUEUE_METHODS = ['writeBuffer'] as const;

interface WindowState {
  calls: Omit<DeviceCalls, 'asyncRequestToSettleMs' | 'asyncUnsettledAtEnd' | 'distinctModuleSources' | 'distinctPipelineKeys'>;
  settles: (number | undefined)[]; // request order; undefined while pending
  sources: string[];               // references only; compared after the window closes
  pipelines: object[];             // descriptor references; keyed after the window closes
  open: boolean;
}

/** Collapses a descriptor into a request-variant key without stringifying GPU objects: plain data is
 * serialized, shader modules map to their source (by value, after the window), any other object
 * (explicit layouts, unknown modules) to an opaque identity. Labels are ignored. */
function variantKey(value: unknown, sourceOf: WeakMap<object, string>, sourceIds: Map<string, number>, ids: WeakMap<object, number>, next: { id: number }): string {
  const identity = (o: object) => { let id = ids.get(o); if (id === undefined) ids.set(o, id = next.id++); return `#${id}`; };
  const walk = (v: unknown, field?: string): string => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? JSON.stringify(v) : String(v);
    const source = sourceOf.get(v);
    if (source !== undefined) {
      let id = sourceIds.get(source);
      if (id === undefined) sourceIds.set(source, id = sourceIds.size);
      return `module:${id}`;
    }
    if (field === 'layout' || field === 'module') return `opaque${identity(v)}`;
    if (Array.isArray(v)) return `[${v.map(item => walk(item)).join(',')}]`;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return `opaque${identity(v)}`;
    return `{${Object.keys(v).filter(k => k !== 'label').sort().map(k => `${JSON.stringify(k)}:${walk((v as Record<string, unknown>)[k], k)}`).join(',')}}`;
  };
  return walk(value);
}

const byteLength = (data: unknown, dataOffset: unknown, size: unknown): number => {
  const d = data as { byteLength?: number; BYTES_PER_ELEMENT?: number };
  const unit = typeof d?.BYTES_PER_ELEMENT === 'number' ? d.BYTES_PER_ELEMENT : 1;
  if (typeof size === 'number') return size * unit;
  return typeof d?.byteLength === 'number' ? Math.max(0, d.byteLength - (typeof dataOffset === 'number' ? dataOffset : 0) * unit) : 0;
};

/**
 * Shadows the probe-owned device's creation methods (and its queue's writeBuffer) with own properties
 * that call the originals with the real `this` and return their exact result (or throw/reject with the
 * exact error). No Proxy: the same object reaches World and Three.js. Each original own descriptor is
 * saved and restored exactly; a shadow is deleted only where there was none. If any hook cannot be
 * installed, every hook already installed is rolled back and the result is `available: false`.
 */
export function instrumentDevice(device: GPUDevice, now: () => number): Instrumentation {
  const open = new Set<WindowState>();
  const sourceOf = new WeakMap<object, string>();
  let inFlight = 0;
  const each = (f: (w: WindowState) => void) => { for (const w of open) f(w); };
  const timed = <T>(run: () => T, after: (elapsed: number) => void): T => {
    const t0 = now();
    try { return run(); } finally { after(now() - t0); }
  };
  type Fn = (this: unknown, ...args: unknown[]) => unknown;
  const wrappers: Record<string, (original: Fn) => Fn> = {
    createShaderModule: original => function (this: unknown, ...args) {
      const descriptor = args[0] as { code?: unknown } | undefined;
      const targets = [...open];
      targets.forEach(w => { w.calls.shaderModules++; if (typeof descriptor?.code === 'string') w.sources.push(descriptor.code); });
      const module = timed(() => original.apply(this, args), e => targets.forEach(w => { w.calls.shaderModuleCallWallMs += e; }));
      if (module && typeof module === 'object' && typeof descriptor?.code === 'string') sourceOf.set(module, descriptor.code);
      return module;
    },
    createBindGroupLayout: original => function (this: unknown, ...args) { each(w => w.calls.bindGroupLayouts++); return original.apply(this, args); },
    createPipelineLayout: original => function (this: unknown, ...args) { each(w => w.calls.pipelineLayouts++); return original.apply(this, args); },
    createBuffer: original => function (this: unknown, ...args) {
      const size = (args[0] as { size?: unknown } | undefined)?.size;
      each(w => { w.calls.buffersCreated++; if (typeof size === 'number' && Number.isFinite(size)) w.calls.bufferBytesCreated += size; });
      return original.apply(this, args);
    },
    writeBuffer: original => function (this: unknown, ...args) {
      const bytes = byteLength(args[2], args[3], args[4]);
      each(w => { w.calls.queueWrites++; if (Number.isFinite(bytes)) w.calls.queueWriteBytes += bytes; });
      return original.apply(this, args);
    },
  };
  const syncPipeline = (field: 'computePipelinesSync' | 'renderPipelinesSync') => (original: Fn): Fn => function (this: unknown, ...args) {
    const descriptor = args[0];
    const targets = [...open];
    targets.forEach(w => { w.calls[field]++; if ((descriptor as { layout?: unknown })?.layout === 'auto') w.calls.autoLayoutPipelines++;
      if (descriptor && typeof descriptor === 'object') w.pipelines.push(descriptor); });
    return timed(() => original.apply(this, args), e => targets.forEach(w => { w.calls.syncPipelineCallWallMs += e; }));
  };
  const asyncPipeline = (field: 'computePipelinesAsync' | 'renderPipelinesAsync') => (original: Fn): Fn => function (this: unknown, ...args) {
    const descriptor = args[0];
    const targets = [...open];
    const slots = targets.map(w => {
      w.calls[field]++; if ((descriptor as { layout?: unknown })?.layout === 'auto') w.calls.autoLayoutPipelines++;
      if (descriptor && typeof descriptor === 'object') w.pipelines.push(descriptor);
      w.settles.push(undefined); return w.settles.length - 1;
    });
    const t0 = now();
    const result = original.apply(this, args); // a synchronous throw propagates unchanged and counts no request in flight
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      inFlight++;
      each(w => { w.calls.maxAsyncInFlight = Math.max(w.calls.maxAsyncInFlight, inFlight); });
      const settle = (rejected: boolean) => {
        inFlight--;
        let elapsed: number;
        try { elapsed = now() - t0; } catch { elapsed = NaN; }
        targets.forEach((w, i) => { if (rejected) w.calls.asyncRejected++; if (Number.isFinite(elapsed)) w.settles[slots[i]] = elapsed; });
      };
      // Observation only: the handlers never throw, so this derived promise never rejects.
      // The caller still receives the original promise and its original rejection.
      (result as PromiseLike<unknown>).then(() => settle(false), () => settle(true));
    }
    return result;
  };
  wrappers.createComputePipeline = syncPipeline('computePipelinesSync');
  wrappers.createRenderPipeline = syncPipeline('renderPipelinesSync');
  wrappers.createComputePipelineAsync = asyncPipeline('computePipelinesAsync');
  wrappers.createRenderPipelineAsync = asyncPipeline('renderPipelinesAsync');

  const installed: { target: object; name: string; prior: PropertyDescriptor | undefined }[] = [];
  const rollback = () => {
    const failures: string[] = [];
    while (installed.length) {
      const { target, name, prior } = installed.pop()!;
      try {
        if (prior) Object.defineProperty(target, name, prior);
        else if (!Reflect.deleteProperty(target, name)) throw new Error('delete refused');
      } catch (e) { failures.push(`${name}: ${sanitizeMessage(e)}`); }
    }
    if (failures.length) throw new Error(`instrumentation restore failed (${failures.join('; ')})`);
  };
  const install = (target: object, name: string) => {
    const original = (target as Record<string, unknown>)[name];
    if (typeof original !== 'function') throw new Error(`${name} is not a function`);
    const prior = Object.getOwnPropertyDescriptor(target, name);
    const wrapper = wrappers[name](original as Fn);
    Object.defineProperty(target, name, { value: wrapper, writable: true, configurable: true, enumerable: prior?.enumerable ?? false });
    installed.push({ target, name, prior });
    if ((target as Record<string, unknown>)[name] !== wrapper) throw new Error(`${name} shadow not visible`);
  };
  let queue: object;
  try {
    queue = device.queue;
    if (!queue || typeof queue !== 'object') throw new Error('device.queue unavailable');
    for (const name of DEVICE_METHODS) install(device, name);
    for (const name of QUEUE_METHODS) install(queue, name);
  } catch (e) {
    let reason = `device methods could not be shadowed: ${sanitizeMessage(e)}`;
    try { rollback(); } catch (r) { reason += `; ${sanitizeMessage(r)}`; }
    return { available: false, reason, window: () => ({ end: () => unavailable(reason) }), restore() {} };
  }
  let restored = false;
  return {
    available: true,
    window(_name: string): DeviceWindow {
      const state: WindowState = { open: true, settles: [], sources: [], pipelines: [], calls: {
        shaderModules: 0, computePipelinesSync: 0, computePipelinesAsync: 0, renderPipelinesSync: 0, renderPipelinesAsync: 0,
        bindGroupLayouts: 0, pipelineLayouts: 0, autoLayoutPipelines: 0, syncPipelineCallWallMs: 0, shaderModuleCallWallMs: 0,
        asyncRejected: 0, maxAsyncInFlight: inFlight, buffersCreated: 0, bufferBytesCreated: 0, queueWrites: 0, queueWriteBytes: 0 } };
      if (!restored) open.add(state);
      return {
        end(): DeviceCalls {
          open.delete(state);
          const settled = state.settles.filter((v): v is number => v !== undefined);
          const snapshot = { ...state.calls, asyncRequestToSettleMs: settled, asyncUnsettledAtEnd: state.settles.length - settled.length };
          // Value comparison happens only now, outside the timed window.
          const sourceIds = new Map<string, number>(), ids = new WeakMap<object, number>(), next = { id: 0 };
          const keys = new Set(state.pipelines.map(p => variantKey(p, sourceOf, sourceIds, ids, next)));
          return { ...snapshot, distinctModuleSources: new Set(state.sources).size, distinctPipelineKeys: keys.size };
        },
      };
    },
    restore() { if (restored) return; restored = true; open.clear(); rollback(); },
  };
}

// ---- one cycle -----------------------------------------------------------------------------------

export interface ProbeModel {
  metadata: { setupMs?: Partial<Record<'seeds' | 'worldCreate' | 'sdfEnable', number>> } & Record<string, unknown>;
  step(): void;
  readPoses(): Promise<{ step: number; poses: unknown[] }>;
  dispose(): void;
}
export type CycleKind = 'first-on-device' | 'same-device-recreate';
export interface CycleRecord {
  index: number; kind: CycleKind;
  phases: Record<string, Ms | Ms[]>;
  deviceCalls: Record<string, DeviceCalls | Unavailable | (DeviceCalls | Unavailable)[]>;
  poseStep: number | null;
  error?: { phase: string; message: string };
  disposeError?: string;
}
export interface CycleHost {
  now: () => number;
  /** Cycle 0 only: the host's dynamic import of the model module; resolves with the model factory. */
  importModel?: () => Promise<() => Promise<ProbeModel>>;
  /** The factory from an earlier cycle (cycles after 0). */
  createModel?: () => Promise<ProbeModel>;
  /** queue.onSubmittedWorkDone() on the probe's own device. */
  drain: () => Promise<void>;
  /** Throws when the host saw an uncaptured GPU error or device loss. */
  check?: () => void;
  /** Browser, cycle 0 only: syncs meshes to the last poses and calls renderer.render once. */
  render?: { call(poses: unknown[]): void; nextFrame(): Promise<void> };
  instrumentation?: Instrumentation | null;
}
export const SINGLE_PHASES = ['modelImport', 'modelCreate', 'seeds', 'worldCreate', 'sdfEnable', 'sdfAtlasPackReplay', 'setupDrain',
  'renderCall', 'renderDrain', 'nextFrame', 'dispose', 'cycleWall'] as const;
export const STEP_PHASES = ['stepEncode', 'stepDrain', 'read'] as const;

/**
 * Runs one bounded cycle: [import] → create → drain → 3 × (step, drain, read) → [render] → dispose.
 * Never throws for model/GPU failures: the failing phase is recorded, the phases after it are
 * `unavailable('not reached')`, and dispose is still attempted on any created model.
 * `cycleWall` runs from the model-creation call to the first read resolving (modelImport excluded).
 */
export async function profileCycle(index: number, host: CycleHost): Promise<{ record: CycleRecord; factory?: () => Promise<ProbeModel> }> {
  const kind: CycleKind = index === 0 ? 'first-on-device' : 'same-device-recreate';
  const phases: CycleRecord['phases'] = {}, calls: CycleRecord['deviceCalls'] = {};
  const steps = STEP_PHASES.map(() => [] as Ms[]), stepCalls = STEP_PHASES.map(() => [] as (DeviceCalls | Unavailable)[]);
  STEP_PHASES.forEach((p, i) => { phases[p] = steps[i]; calls[p] = stepCalls[i]; });
  const record: CycleRecord = { index, kind, phases, deviceCalls: calls, poseStep: null };
  const inst = host.instrumentation;
  const noCounters = unavailable('instrumentation disabled (--no-instrument / ?instrument=0)');
  const open = (name: string) => inst ? inst.window(name) : { end: () => noCounters };
  let current = 'setup';
  /** Times one window; a throw inside it (or from the clock) is recorded as that phase's failure. */
  async function measure<T>(name: string, run: () => T | Promise<T>, slot?: { list: Ms[]; callList: (DeviceCalls | Unavailable)[] }): Promise<T> {
    current = slot ? `${name}[${slot.list.length + 1}]` : name;
    const w = open(current);
    const put = (v: Ms) => { if (slot) slot.list.push(v); else phases[name] = v; };
    let value: T, elapsed: Ms;
    try {
      const t0 = host.now();
      const result = run();
      value = result && typeof (result as PromiseLike<T>).then === 'function' ? await result : result as T;
      elapsed = ms(host.now() - t0);
    } catch (e) { put(unavailable('phase failed: see cycle error')); throw e; } finally {
      const counters = w.end();
      if (slot) slot.callList.push(counters); else calls[name] = counters;
    }
    put(elapsed);
    return value;
  }
  const check = () => { current = 'gpuCheck'; host.check?.(); };
  let factory = host.createModel, model: ProbeModel | undefined;
  try {
    if (index === 0) {
      if (!host.importModel) throw new Error('cycle 0 needs importModel');
      factory = await measure('modelImport', host.importModel);
    } else { phases.modelImport = unavailable('cycle 0 only'); calls.modelImport = unavailable('cycle 0 only'); }
    if (!factory) throw new Error('no model factory');
    const make = factory;
    current = 'modelCreate';
    const wall = open('cycleWall'), wallStart = host.now();
    let wallClosed = false;
    const closeWall = () => { if (!wallClosed) { wallClosed = true; calls.cycleWall = wall.end(); } };
    try {
      model = await measure('modelCreate', async () => { model = await make(); return model; });
      const setup = model.metadata?.setupMs ?? {};
      for (const name of ['seeds', 'worldCreate', 'sdfEnable'] as const) {
        const v = setup[name];
        phases[name] = typeof v === 'number' && Number.isFinite(v) ? ms(v) : unavailable('model metadata.setupMs did not report it');
        calls[name] = unavailable('no phase hooks in createAvbdInterlocking: counters only in aggregate (modelCreate)');
      }
      await measure('setupDrain', host.drain);
      check();
      for (let i = 0; i < STARTUP_STEPS_PER_CYCLE; i++) {
        await measure('stepEncode', () => model!.step(), { list: steps[0], callList: stepCalls[0] });
        await measure('stepDrain', host.drain, { list: steps[1], callList: stepCalls[1] });
        check();
        const read = await measure('read', () => model!.readPoses(), { list: steps[2], callList: stepCalls[2] });
        record.poseStep = read.step;
        if (i === 0) { phases.cycleWall = ms(host.now() - wallStart); closeWall(); }
        if (i === STARTUP_STEPS_PER_CYCLE - 1 && index === 0 && host.render) {
          const render = host.render;
          await measure('renderCall', () => render.call(read.poses));
          await measure('renderDrain', host.drain);
          await measure('nextFrame', () => render.nextFrame());
          check();
        }
      }
    } finally { closeWall(); }
  } catch (e) {
    record.error = { phase: current, message: sanitizeMessage(e) };
  }
  // dispose: always attempted on a created model, even after a phase, read or clock failure
  if (model) {
    const w = open('dispose');
    let t0: number | undefined;
    try { t0 = host.now(); } catch { /* clock failure: duration unavailable, dispose still runs */ }
    try { model.dispose(); } catch (e) { record.disposeError = sanitizeMessage(e); }
    calls.dispose = w.end();
    let t1: number | undefined;
    try { t1 = host.now(); } catch { /* as above */ }
    phases.dispose = t0 !== undefined && t1 !== undefined && !record.disposeError ? ms(t1 - t0)
      : unavailable(record.disposeError ? 'dispose threw' : 'clock failed around dispose');
  } else { phases.dispose = unavailable('no model was created'); calls.dispose = phases.dispose; }
  fillUnreached(record, index, !!host.render);
  return { record, factory };
}

function fillUnreached(record: CycleRecord, index: number, rendering: boolean) {
  const reason = (name: string) => {
    if (name === 'sdfAtlasPackReplay') return 'not reconstructed: exact packSdfAtlas inputs are internal to World';
    if (['renderCall', 'renderDrain', 'nextFrame'].includes(name)) {
      if (!rendering) return 'no renderer in this host';
      if (index !== 0) return 'cycle 0 only';
    }
    return 'not reached';
  };
  for (const name of SINGLE_PHASES) if (!(name in record.phases)) record.phases[name] = unavailable(reason(name));
  for (const name of SINGLE_PHASES) if (!(name in record.deviceCalls)) {
    const p = record.phases[name] as Ms;
    record.deviceCalls[name] = p.value === null ? unavailable(p.reason) : unavailable('phase not instrumented as a window');
  }
  for (const name of STEP_PHASES) {
    const list = record.phases[name] as Ms[], callList = record.deviceCalls[name] as (DeviceCalls | Unavailable)[];
    while (list.length < STARTUP_STEPS_PER_CYCLE) list.push(unavailable('not reached'));
    while (callList.length < STARTUP_STEPS_PER_CYCLE) callList.push(unavailable('not reached'));
  }
}

/** Fixed sequence on one device: cycle 0 then same-device recreates. Stops after a failed cycle; later
 * cycles are listed with every phase `unavailable`. Each model is disposed before the next is created. */
export async function profileSequence(cycles: number, host: Omit<CycleHost, 'createModel'>): Promise<CycleRecord[]> {
  if (!Number.isInteger(cycles) || cycles < 1 || cycles > STARTUP_MAX_CYCLES) throw new RangeError(`cycles must be 1..${STARTUP_MAX_CYCLES}`);
  const out: CycleRecord[] = [];
  let factory: (() => Promise<ProbeModel>) | undefined;
  for (let i = 0; i < cycles; i++) {
    if (out.some(c => c.error || c.disposeError)) {
      const r: CycleRecord = { index: i, kind: 'same-device-recreate', phases: {}, deviceCalls: {}, poseStep: null };
      const skipped = () => unavailable('not reached: an earlier cycle failed');
      for (const name of SINGLE_PHASES) { r.phases[name] = skipped(); r.deviceCalls[name] = skipped(); }
      for (const name of STEP_PHASES) {
        r.phases[name] = Array.from({ length: STARTUP_STEPS_PER_CYCLE }, skipped);
        r.deviceCalls[name] = Array.from({ length: STARTUP_STEPS_PER_CYCLE }, skipped);
      }
      out.push(r); continue;
    }
    const { record, factory: f } = await profileCycle(i, { ...host, createModel: factory });
    factory = f; out.push(record);
  }
  return out;
}

// ---- report ------------------------------------------------------------------------------------

export interface StartupReport {
  schema: typeof STARTUP_SCHEMA;
  status: 'completed' | 'failed' | 'refused';
  diagnostic: true; benchmark: false;
  observedAt: string;
  source: Record<string, unknown>;
  environment: Record<string, unknown>;
  settings: Record<string, unknown>;
  run: { label: string; navigationType: string | null; loadIndexInTab: number | null; orderInSequence: number | null;
    operatorNote: string | null; cacheState: 'unknown' };
  cycles: CycleRecord[];
  uncapturedGpuErrors: string[]; deviceLost: string | null;
  teardownErrors?: string[];
  error?: { phase: string; message: string };
  instrumentation: { requested: boolean; available: boolean; reason: string | null };
  limits: string[];
}

/** Scene settings, read from the shared authored inputs and the model's own metadata (never retyped). */
export function probeSettings(metadata: Record<string, unknown> | null, cycles: number, instrument: boolean) {
  const from = (key: string) => metadata && key in metadata ? metadata[key] : unavailable('no model was created');
  return { scene: 'interlocking-avbd' as const, dt: INTERLOCKING.dt, iterations: INTERLOCKING.iterations, maxBodies: 4 as const,
    ringSeedCandidates: from('seedCandidates'), collisionParams: from('collisionParams'), sdfCapacity: from('sdfCapacity'),
    cycles, stepsPerCycle: STARTUP_STEPS_PER_CYCLE, push: false, instrument };
}

export function statusOf(cycles: readonly CycleRecord[], expected: number, gpuErrors: readonly string[], deviceLost: string | null = null): 'completed' | 'failed' {
  return cycles.length === expected && cycles.every(c => !c.error && !c.disposeError) && gpuErrors.length === 0 && !deviceLost ? 'completed' : 'failed';
}

export function sanitizeLabel(label: unknown): string {
  const text = typeof label === 'string' ? label : '';
  const clean = text.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40);
  return clean || 'unlabelled';
}

/** A resource-timing name without credentials, query or fragment; Vite /@fs/ machine paths and other
 * absolute paths are redacted, and cross-origin entries keep only their origin. */
export function sanitizeResourceName(name: string, pageOrigin: string): string {
  let url: URL;
  try { url = new URL(name, pageOrigin); } catch { return '<unparseable>'; }
  if (url.origin !== pageOrigin) return `${url.protocol}//${url.host}/<cross-origin>`;
  let path = url.pathname;
  const fs = path.indexOf('/@fs/');
  if (fs >= 0) path = `${path.slice(0, fs)}/@fs/<path>`;
  path = path.replace(/\/(?:Users|home|private|var|tmp|opt|Volumes|root)\/.*$/, '/<path>');
  return path;
}

const FORBIDDEN_KEYS = /^(total|totalMs|compile|compileMs|compileTime|sum|summed)$/i;
const PRIVATE_TEXT = /(?<![\w.])\/(?:Users|home|private|Volumes|root)\/|\/@fs\/(?!<path>)|[A-Za-z]:\\/;
const isMs = (v: unknown): boolean => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.value === 'number') return Number.isFinite(o.value) && o.value >= 0 && !('reason' in o);
  return o.value === null && typeof o.reason === 'string' && o.reason.length > 0;
};
const isUnavailable = (v: unknown) => isMs(v) && (v as Ms).value === null;

/** Problems with a report; empty when it is valid. Applied before any report is emitted. */
export function validateStartupReport(report: unknown): string[] {
  const problems: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${path}: non-finite number`);
    else if (typeof v === 'string' && PRIVATE_TEXT.test(v)) problems.push(`${path}: absolute/machine path`);
    else if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        if (FORBIDDEN_KEYS.test(k)) problems.push(`${path}.${k}: summed/compile field is not allowed`);
        walk(child, `${path}.${k}`);
      }
    }
  };
  walk(report, '$');
  const r = report as Partial<StartupReport> | null;
  if (!r || typeof r !== 'object') return ['report is not an object'];
  if (r.schema !== STARTUP_SCHEMA) problems.push('schema mismatch');
  if (!['completed', 'failed', 'refused'].includes(r.status as string)) problems.push('bad status');
  if (r.diagnostic !== true || r.benchmark !== false) problems.push('must be diagnostic, not benchmark');
  if (r.run?.cacheState !== 'unknown') problems.push('run.cacheState must be "unknown"');
  if (!Array.isArray(r.cycles)) { problems.push('cycles missing'); return problems; }
  if (r.status === 'refused' && r.cycles.length) problems.push('a refused report has no cycles');
  r.cycles.forEach((c, i) => {
    const at = `cycles[${i}]`;
    if (c.index !== i) problems.push(`${at}: index`);
    if (c.kind !== (i === 0 ? 'first-on-device' : 'same-device-recreate')) problems.push(`${at}: kind`);
    for (const name of SINGLE_PHASES) if (!isMs(c.phases?.[name])) problems.push(`${at}.phases.${name}: must be {value:number} or {value:null,reason}`);
    for (const name of STEP_PHASES) {
      const list = c.phases?.[name];
      if (!Array.isArray(list) || list.length !== STARTUP_STEPS_PER_CYCLE || !list.every(isMs)) problems.push(`${at}.phases.${name}: ${STARTUP_STEPS_PER_CYCLE} durations`);
    }
    for (const name of Object.keys(c.phases ?? {})) if (!(SINGLE_PHASES as readonly string[]).includes(name) && !(STEP_PHASES as readonly string[]).includes(name)) problems.push(`${at}.phases.${name}: unknown phase`);
    for (const [name, v] of Object.entries(c.deviceCalls ?? {})) {
      const ok = (x: unknown) => isUnavailable(x) || (!!x && typeof x === 'object' && typeof (x as DeviceCalls).shaderModules === 'number');
      if (Array.isArray(v) ? !v.every(ok) : !ok(v)) problems.push(`${at}.deviceCalls.${name}: counters or {value:null,reason}`);
    }
    if (r.status === 'completed' && (c.error || c.disposeError)) problems.push(`${at}: error in a completed report`);
  });
  if (r.status === 'completed' && (r.cycles.length !== (r.settings as { cycles?: number } | undefined)?.cycles || r.uncapturedGpuErrors?.length || r.deviceLost || r.teardownErrors?.length)) problems.push('completed report must have every cycle and no GPU or teardown error');
  return problems;
}

// ---- CLI arguments (validated before any GPU import) --------------------------------------------

export class StartupRefusal extends Error {}
export interface StartupArgs { cycles: number; json?: string; label: string; instrument: boolean; help: boolean }
export function parseStartupArgs(argv: readonly string[]): StartupArgs {
  const out: StartupArgs = { cycles: STARTUP_MAX_CYCLES, label: 'node', instrument: true, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => { const v = argv[++i]; if (v === undefined || v.startsWith('--')) throw new StartupRefusal(`${a} needs a value`); return v; };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--no-instrument') out.instrument = false;
    else if (a === '--cycles') {
      const v = value();
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > STARTUP_MAX_CYCLES) throw new StartupRefusal(`--cycles must be 1..${STARTUP_MAX_CYCLES}`);
      out.cycles = Number(v);
    } else if (a === '--json') out.json = value();
    else if (a === '--label') out.label = sanitizeLabel(value());
    else throw new StartupRefusal(`Unknown argument: ${a.slice(0, 40)}`);
  }
  return out;
}

/** Smallest non-zero difference between consecutive clock reads (bounded sample), or null if none seen. */
export function observeTimerStep(now: () => number, samples = 2000): number | null {
  let min = Infinity, previous = now();
  for (let i = 0; i < samples; i++) {
    const t = now(), d = t - previous;
    if (d > 0 && d < min) min = d;
    previous = t;
  }
  return Number.isFinite(min) ? min : null;
}
