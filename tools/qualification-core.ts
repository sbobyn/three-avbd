// Pure, device-free core of the S1 qualification harness v0 (STE-3354). The protocol is docs/QUALIFICATION_MATRIX.md §§1-7,
// accepted before any trial; this file freezes its rows and criteria, instruments the existing comparison adapters,
// judges each criterion as pass / fail / unknown, and builds the report. It runs rows through the existing `runOne`
// (timed pass + validation replay) and reuses its metrics; it adds no scene, solver setting or threshold.
//
// Everything that touches a real device lives in tools/qualification.ts. Tests drive `runQualification` with fakes.
// A row pass is a short-window engineering observation on sampled states: not full S1, not World integration,
// not physical, performance or human acceptance. There is no ratio, ranking, FPS or winner anywhere in the schema.
import { assessAdapter, sanitizeMessage, type AdapterRecord } from '../src/comparison/interlocking-trial.ts';
import { DEFAULTS, runOne, validateOptions, type Options, type Result } from '../src/comparison/run.ts';
import type { Adapter, createAdapter, Engine } from '../src/comparison/adapters.ts';
import { FINAL_WINDOW, REST_SPEED, SETTLED_MAX_SPEED } from '../src/comparison/final-window.ts';
import { FLOOR_TARGET } from '../src/comparison/quality.ts';
import { sceneHash, type Scene } from '../src/comparison/scenes.ts';
import type { GitProvenance } from '../scripts/git-provenance.ts';

export const QUALIFICATION_SCHEMA = 'three-avbd.qualification-matrix/0';
export const USAGE = 'Usage: qualification [--rows Q1,Q2,Q3] [--engines avbd|rapier|avbd,rapier (default avbd)] [--configs A,B (default A,B)] [--json <new file>.json]';

// ---- declared constants (QUALIFICATION_MATRIX §3) ------------------------------------------------

/** Hard bounds of this slice (§7). No flag changes any of them. */
export const BOUNDS = Object.freeze({ rows: 3, bodies: 1000, steps: 120, repeats: 1 });
/** `quality()` rejects a quaternion whose norm is off by more than this (src/comparison/quality.ts; the literal is not exported). */
export const QUATERNION_NORM_TOLERANCE = 1e-4;
/** Lead-adopted coarse regression guard for chain-20 (§3 J1); not a mature constraint-quality target. */
export const JOINT_ANCHOR_MAX = 0.05;
/** `runOne` defines the resting criterion only over at least this many measured seconds. */
export const RESTING_MIN_SECONDS = 10;
export const THRESHOLDS = Object.freeze({ floorTarget: FLOOR_TARGET, settledMaxSpeed: SETTLED_MAX_SPEED, restSpeed: REST_SPEED,
  quaternionNorm: QUATERNION_NORM_TOLERANCE, jointAnchorMax: JOINT_ANCHOR_MAX, restingMinSeconds: RESTING_MIN_SECONDS });

export const ROW_IDS = ['Q1', 'Q2', 'Q3'] as const;
export type RowId = typeof ROW_IDS[number];
export const ENGINES = ['avbd', 'rapier'] as const;
export const CONFIG_IDS = ['A', 'B'] as const;
export type ConfigId = typeof CONFIG_IDS[number];
/** Rapier has one configuration: A and B differ only in AVBD's contact margin, so a Rapier run applies to every selected A/B. */
export type RunConfigId = ConfigId | 'R';

export interface RowDef { id: RowId; title: string; scene: string; hash: string; bodies: number; dynamicBodies: number; joints: number }
/** Counts and hashes were read from `makeScene` when the protocol was accepted; V4 re-derives them on every run. */
export const ROWS: Readonly<Record<RowId, RowDef>> = Object.freeze({
  Q1: { id: 'Q1', title: 'uniform rest', scene: 'rest-grid-100', hash: 'a978ed4e', bodies: 101, dynamicBodies: 100, joints: 0 },
  Q2: { id: 'Q2', title: 'sphere pile, mixed box/sphere contact', scene: 'sphere-pile-hcp-100', hash: '232dff17', bodies: 104, dynamicBodies: 100, joints: 0 },
  Q3: { id: 'Q3', title: 'jointed chain', scene: 'chain-20', hash: '1c3dd1b4', bodies: 22, dynamicBodies: 20, joints: 20 },
});

export const AVBD_CONFIGS: Readonly<Record<ConfigId, { margin: number; label: string }>> = Object.freeze({
  A: { margin: 0.01, label: 'shipped default: 10 iterations, contactMargin 0.01' },
  B: { margin: 0.001, label: 'documented resting setting: 10 iterations, contactMargin 0.001' },
});

/** Fixed options of every run. Rapier ignores `avbdMargin` (reported as such); AVBD ignores the Rapier fields. */
export function declaredOptions(engine: Engine, config: RunConfigId): Options {
  if (engine === 'avbd' && config === 'R') throw new Error('AVBD has configurations A and B');
  if (engine === 'rapier' && config !== 'R') throw new Error('Rapier has the single configuration R');
  const margin = config === 'R' ? DEFAULTS.avbdMargin : AVBD_CONFIGS[config].margin;
  return { ...DEFAULTS, dt: 1 / 60, lead: 0, steps: 120, batchSize: 10, repeats: 1, avbdIterations: 10, rapierIterations: 10,
    rapierPgsIterations: 1, avbdMargin: margin, jitter: 0, impactPhase: 0, finalWindow: FINAL_WINDOW };
}

// ---- criteria (QUALIFICATION_MATRIX §3) ------------------------------------------------------------

export const CRITERIA_IDS = ['V1', 'V2', 'V3', 'V4', 'C1', 'C2', 'C3', 'R1', 'R2', 'R3', 'J1', 'E1'] as const;
export type CriterionId = typeof CRITERIA_IDS[number];
type Role = 'required' | 'recorded' | 'notObservable' | 'notDefined';
/** A criterion absent from a row's map is not part of that row (the matrix has "—"). */
export const ROW_CRITERIA: Readonly<Record<RowId, Partial<Record<CriterionId, Role>>>> = Object.freeze({
  Q1: { V1: 'required', V2: 'required', V3: 'required', V4: 'required', C1: 'required', C2: 'required', C3: 'required', R1: 'required', R2: 'recorded', R3: 'required', E1: 'recorded' },
  Q2: { V1: 'required', V2: 'required', V3: 'required', V4: 'required', C1: 'required', C2: 'required', C3: 'required', R1: 'required', R2: 'recorded', R3: 'notDefined', E1: 'recorded' },
  Q3: { V1: 'required', V2: 'required', V3: 'required', V4: 'required', C1: 'required', C2: 'recorded', C3: 'notObservable', R1: 'recorded', R2: 'recorded', R3: 'notDefined', J1: 'required', E1: 'recorded' },
});
const CRITERION_INFO: Readonly<Record<CriterionId, { title: string; unit: string | null; cadence: string; source: string }>> = Object.freeze({
  V1: { title: 'Finite state, quaternion norm', unit: 'bodies', cadence: 'each of the replay steps, plus initial and timed-final state', source: 'quality (tolerance 1e-4)' },
  V2: { title: 'Capacity and colouring counters', unit: 'count', cadence: 'each replay step (AVBD)', source: 'Adapter.inspect overflow, clashes' },
  V3: { title: 'Timed final state equals replay final state', unit: null, cadence: 'once, bitwise', source: 'runOne replayMatches' },
  V4: { title: 'Manifest hash and body counts match the declaration', unit: null, cadence: 'once', source: 'sceneHash, makeScene' },
  C1: { title: 'Floor coverage', unit: 'bodies', cadence: 'each replay step', source: 'quality outsideFloorBodies' },
  C2: { title: 'Floor depth / smallest body dimension', unit: 'ratio of body size', cadence: 'each replay step', source: 'FLOOR_TARGET' },
  C3: { title: 'Body-pair depth / smallest dimension of the pair', unit: 'ratio of body size', cadence: 'each replay step', source: 'FLOOR_TARGET via contactQuality' },
  R1: { title: 'Final-window max linear speed', unit: 'm/s', cadence: 'last 60 replay steps', source: 'SETTLED_MAX_SPEED' },
  R2: { title: 'Fraction of dynamic bodies below the rest speed', unit: 'fraction', cadence: 'last replay step', source: 'REST_SPEED' },
  R3: { title: 'Centre drift / smallest dimension over at least 10 s', unit: 'ratio of body size', cadence: 'whole measured window', source: 'runOne restingTargetMet' },
  J1: { title: 'Max joint anchor separation', unit: 'm', cadence: 'each replay step', source: 'lead-adopted coarse regression guard; physicalQuality maxJointError' },
  E1: { title: 'Energy and momentum change', unit: 'J', cadence: 'last replay step', source: 'physicalQuality (diagnostic, not a conservation error)' },
});

export type CriterionState = 'measured' | 'notObservable' | 'unknown' | 'notRun';
/** `null` means the criterion is recorded or not decidable by design and carries no verdict. */
export type Verdict = 'pass' | 'fail' | 'unknown';
export type CriterionValue = number | boolean | string | null;
export interface Criterion {
  id: CriterionId; title: string; required: boolean; state: CriterionState; value: CriterionValue; unit: string | null;
  threshold: { op: '<=' | '==' | 'bitwise-equal'; value: number | boolean } | null;
  verdict: Verdict | null; reason: string | null; cadence: string; source: string;
  coverage?: { expected: number; observed: number };
  detail?: Record<string, unknown>;
}
export type RowVerdict = Verdict | 'notRun';

// The exported protocol must stay fixed even through nested references held by report consumers.
for (const row of Object.values(ROWS)) Object.freeze(row);
for (const config of Object.values(AVBD_CONFIGS)) Object.freeze(config);
for (const roles of Object.values(ROW_CRITERIA)) Object.freeze(roles);
Object.freeze(ROW_IDS); Object.freeze(ENGINES); Object.freeze(CONFIG_IDS);

// ---- configuration and refusals ---------------------------------------------------------------------

export class QualificationRefusal extends Error {
  readonly code: 'input' | 'gpu';
  readonly adapter: AdapterRecord | null;
  constructor(code: 'input' | 'gpu', message: string, adapter: AdapterRecord | null = null) { super(message); this.name = 'QualificationRefusal'; this.code = code; this.adapter = adapter; }
}
export interface QualificationConfig { rows: RowId[]; engines: Engine[]; configs: ConfigId[] }
export const QUALIFICATION_DEFAULTS: Readonly<QualificationConfig> = Object.freeze({ rows: [...ROW_IDS], engines: ['avbd'] as Engine[], configs: [...CONFIG_IDS] });
Object.freeze(QUALIFICATION_DEFAULTS.rows); Object.freeze(QUALIFICATION_DEFAULTS.engines); Object.freeze(QUALIFICATION_DEFAULTS.configs);

function pick<T extends string>(raw: unknown, allowed: readonly T[], name: string, fallback: readonly T[], max: number): T[] {
  if (raw === undefined) return [...fallback];
  if (!Array.isArray(raw) || raw.length === 0) throw new QualificationRefusal('input', `${name} must be a non-empty list`);
  if (raw.length > max) throw new QualificationRefusal('input', `at most ${max} ${name} per invocation`);
  const seen = new Set<unknown>();
  for (const item of raw) {
    if (!allowed.includes(item as T)) throw new QualificationRefusal('input', `${name}: "${String(item).slice(0, 40)}" is not one of ${allowed.join(', ')}`);
    if (seen.has(item)) throw new QualificationRefusal('input', `${name}: "${String(item)}" given twice`);
    seen.add(item);
  }
  // canonical order, so the record never depends on how the flags were spelled
  return allowed.filter(a => seen.has(a));
}

/** Apply defaults and refuse anything out of range. Used by the argument parser and again by the runner, before anything is acquired. */
export function resolveQualificationConfig(raw: unknown): QualificationConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new QualificationRefusal('input', 'The qualification configuration must be an object');
  const given = raw as Record<string, unknown>;
  for (const key of Object.keys(given)) if (key !== 'rows' && key !== 'engines' && key !== 'configs') throw new QualificationRefusal('input', `Unknown configuration key "${key.slice(0, 40)}"`);
  return { rows: pick(given.rows, ROW_IDS, 'rows', QUALIFICATION_DEFAULTS.rows, BOUNDS.rows), engines: pick(given.engines, ENGINES, 'engines', QUALIFICATION_DEFAULTS.engines, ENGINES.length),
    configs: pick(given.configs, CONFIG_IDS, 'configs', QUALIFICATION_DEFAULTS.configs, CONFIG_IDS.length) };
}

const list = (text: string) => text.split(',');
/** Strict: unknown or repeated flags, missing values, empty list items and anything outside the declared rows are refused. No flag can change a workload or threshold. */
export function parseQualificationArgs(argv: readonly string[]): { help: true } | { help: false; config: QualificationConfig; json?: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag !== '--rows' && flag !== '--engines' && flag !== '--configs' && flag !== '--json') throw new QualificationRefusal('input', `Unknown option "${String(flag).slice(0, 40)}". ${USAGE}`);
    if (value === undefined || value.startsWith('--')) throw new QualificationRefusal('input', `${flag} needs a value. ${USAGE}`);
    if (values.has(flag)) throw new QualificationRefusal('input', `${flag} given twice`);
    values.set(flag, value);
  }
  const json = values.get('--json');
  if (json !== undefined && !/\.json$/i.test(json)) throw new QualificationRefusal('input', '--json must be a path ending in .json');
  const raw: Record<string, unknown> = {};
  for (const key of ['rows', 'engines', 'configs'] as const) {
    const text = values.get(`--${key}`);
    if (text !== undefined) raw[key] = list(text);
  }
  return { help: false, config: resolveQualificationConfig(raw), ...(json !== undefined ? { json } : {}) };
}

export interface RunSpec { row: RowId; engine: Engine; config: RunConfigId; appliesToConfigs: ConfigId[]; runId: string }
/** Serial plan: per row, AVBD A then B, then the single Rapier run. Mapping A/B -> Rapier R is explicit on every spec. */
export function planRuns(config: QualificationConfig): RunSpec[] {
  const specs: RunSpec[] = [];
  for (const row of config.rows) {
    for (const engine of config.engines) {
      if (engine === 'avbd') for (const c of config.configs) specs.push({ row, engine, config: c, appliesToConfigs: [c], runId: `${row}:avbd:${c}` });
      else specs.push({ row, engine, config: 'R', appliesToConfigs: [...config.configs], runId: `${row}:rapier:R` });
    }
  }
  return specs;
}

/** Defence in depth for the hard bounds: they hold for the frozen table and are re-checked before any device is requested. */
export function assertWithinBounds(specs: readonly RunSpec[], scenes: ReadonlyMap<RowId, Scene>): void {
  if (new Set(specs.map(s => s.row)).size > BOUNDS.rows) throw new QualificationRefusal('input', `at most ${BOUNDS.rows} rows per invocation`);
  for (const spec of specs) {
    const o = declaredOptions(spec.engine, spec.config);
    validateOptions(o);
    if (o.steps > BOUNDS.steps || o.repeats > BOUNDS.repeats) throw new QualificationRefusal('input', `steps are bounded by ${BOUNDS.steps} and repeats by ${BOUNDS.repeats}`);
    const scene = scenes.get(spec.row);
    if (!scene || scene.bodies.length > BOUNDS.bodies) throw new QualificationRefusal('input', `scenes are bounded by ${BOUNDS.bodies} bodies`);
  }
}

/** The adapter gate. Fallback, software and unidentified adapters are refused: there is no override. */
export function assessGpuAdapter(info: unknown, legacyFallback?: unknown): AdapterRecord {
  const assessment = assessAdapter(info, legacyFallback);
  if (!assessment.ok) throw new QualificationRefusal('gpu', assessment.reason, assessment.record);
  return assessment.record;
}

// ---- host interface -----------------------------------------------------------------------------------

/** An owned GPU session. Everything past `acquireGpu` is the host's to clean up through `close`, which never throws. */
export interface GpuSession {
  device: GPUDevice;
  adapter: AdapterRecord;
  requiredLimits: Record<string, number>;
  /** Throws when an uncaptured GPU error or a device loss was seen. Passed to `runOne` as its guard. */
  guard(): void;
  /** Every uncaptured error and unexpected loss seen so far. */
  gpuErrors(): readonly string[];
  /** Wait for submitted work so late errors surface. */
  settle(): Promise<void>;
  /** Drain, destroy the owned device, await its loss. Returns teardown failures instead of throwing. */
  close(): Promise<string[]>;
}
export interface QualificationHost {
  now(): Date;
  /** Monotonic milliseconds for the instrumentation. */
  clock(): number;
  makeScene(name: string): Scene;
  createAdapter: typeof createAdapter;
  /** Called at most once, and only when AVBD is selected. Refusals throw `QualificationRefusal('gpu', ...)`. */
  acquireGpu(): Promise<GpuSession>;
}

// ---- instrumentation ---------------------------------------------------------------------------------------

export interface InspectObservation { call: number; ms: number; overflow: number | null; clashes: number | null; error: string | null }
export interface SnapshotObservation { call: number; ms: number; length: number | null; nonFiniteValues: number | null; error: string | null }
type Method = 'step' | 'complete' | 'snapshot' | 'inspect' | 'destroy';

/** Everything seen on one adapter. Wall milliseconds per call, in call order; nothing here is summed across kinds. */
export class PassRecord {
  readonly index: number;
  readonly engine: Engine;
  /** The first adapter of a runOne call is the timed pass, the second the validation replay. */
  readonly phase: 'timed' | 'replay' | 'unexpected';
  creationStartedMs: number | null = null;
  creationMs: number | null = null;
  creationError: string | null = null;
  setupCompletedMs: number | null = null;
  settings: unknown = null;
  readonly calls: Record<Method, number> = { step: 0, complete: 0, snapshot: 0, inspect: 0, destroy: 0 };
  readonly stepMs: number[] = [];
  readonly completeMs: number[] = [];
  readonly snapshots: SnapshotObservation[] = [];
  readonly inspects: InspectObservation[] = [];
  readonly errors: { method: Method; call: number; message: string }[] = [];
  destroyAttempted = false;
  destroyed = false;
  redundantDestroyCalls = 0;
  destroyError: string | null = null;
  /** The adapter this record owns: kept only so a run can be swept clean. */
  owned: Adapter | null = null;
  constructor(index: number, engine: Engine) { this.index = index; this.engine = engine; this.phase = index === 0 ? 'timed' : index === 1 ? 'replay' : 'unexpected'; }
  get setupMs(): number | null {
    return this.creationStartedMs === null || this.setupCompletedMs === null ? null : this.setupCompletedMs - this.creationStartedMs;
  }
  /** Destroy once. A second request (for example runOne's `finally` after a failed explicit destroy) is counted, not forwarded. */
  destroyOnce(): void {
    this.calls.destroy++;
    if (this.destroyAttempted) { this.redundantDestroyCalls++; return; }
    this.destroyAttempted = true;
    try { this.owned?.destroy(); this.destroyed = true; } catch (e) {
      this.destroyError = sanitizeMessage(e);
      this.errors.push({ method: 'destroy', call: this.calls.destroy, message: this.destroyError });
      throw e;
    }
  }
}

function numberOrNull(v: unknown): number | null { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function countNonFinite(values: ArrayLike<number>): number { let n = 0; for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) n++; return n; }
function cloneSettings(settings: unknown): unknown { try { return JSON.parse(JSON.stringify(settings) ?? 'null'); } catch { return null; } }

/** Wrap an owned adapter to time and record its calls. The original method runs with the original `this`, receives the same
 * arguments, and its value, error and lifetime reach the caller unchanged; only `destroy` is forwarded once (see `destroyOnce`).
 * Nothing is patched or restored: the original object, and any shared device, are not touched. */
export function instrumentAdapter(adapter: Adapter, record: PassRecord, clock: () => number): Adapter {
  const fail = (method: Method, call: number, e: unknown) => record.errors.push({ method, call, message: sanitizeMessage(e) });
  const instrumented: Record<string, unknown> = {
    step: () => {
      const call = ++record.calls.step, t = clock();
      try { return adapter.step(); } catch (e) { fail('step', call, e); throw e; } finally { record.stepMs.push(clock() - t); }
    },
    complete: async () => {
      const call = ++record.calls.complete, t = clock();
      let ok = false;
      try { const v = await adapter.complete(); ok = true; return v; } catch (e) { fail('complete', call, e); throw e; } finally {
        const now = clock();
        record.completeMs.push(now - t);
        if (ok && record.setupCompletedMs === null) record.setupCompletedMs = now;
      }
    },
    snapshot: async () => {
      const call = ++record.calls.snapshot, t = clock();
      let value: Float64Array;
      try { value = await adapter.snapshot(); } catch (e) {
        record.snapshots.push({ call, ms: clock() - t, length: null, nonFiniteValues: null, error: sanitizeMessage(e) }); fail('snapshot', call, e); throw e;
      }
      const ms = clock() - t;
      // The scan is outside the interval, and the very same array object goes back to the caller.
      record.snapshots.push({ call, ms, length: value.length, nonFiniteValues: countNonFinite(value), error: null });
      return value;
    },
    inspect: async () => {
      const call = ++record.calls.inspect, t = clock();
      let value: object;
      try { value = await adapter.inspect(); } catch (e) {
        const message = sanitizeMessage(e);
        const parsed = /overflow=(\d+), clashes=(\d+)/.exec(message);
        record.inspects.push({ call, ms: clock() - t, overflow: parsed ? Number(parsed[1]) : null, clashes: parsed ? Number(parsed[2]) : null, error: message });
        fail('inspect', call, e); throw e;
      }
      const ms = clock() - t, counters = value as { overflow?: unknown; clashes?: unknown } | null;
      record.inspects.push({ call, ms, overflow: numberOrNull(counters?.overflow), clashes: numberOrNull(counters?.clashes), error: null });
      return value;
    },
    destroy: () => record.destroyOnce(),
  };
  return new Proxy(adapter, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(instrumented, prop)) return instrumented[prop];
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Records for one `runOne` call, in adapter-creation order. */
export class RunObserver {
  readonly passes: PassRecord[] = [];
  readonly clock: () => number;
  constructor(clock: () => number) { this.clock = clock; }
  /** Destroy anything runOne did not (or could not) destroy. Never throws; failures are returned. */
  sweep(): string[] {
    const errors: string[] = [];
    for (const pass of this.passes) {
      if (!pass.owned || pass.destroyAttempted) continue;
      try { pass.destroyOnce(); } catch (e) { errors.push(`Adapter cleanup failed (${pass.phase}): ${sanitizeMessage(e)}`); }
    }
    return errors;
  }
}

/** A `runOne` factory around the real or fake `createAdapter`. If instrumenting fails after the adapter was acquired, it is destroyed. */
export function observedFactory(base: typeof createAdapter, observer: RunObserver): typeof createAdapter {
  return async (engine, scene, config, device, bodyBuffer) => {
    const record = new PassRecord(observer.passes.length, engine);
    observer.passes.push(record);
    let adapter: Adapter | undefined;
    try {
      record.creationStartedMs = observer.clock();
      adapter = await base(engine, scene, config, device, bodyBuffer);
      record.creationMs = observer.clock() - record.creationStartedMs;
      record.owned = adapter;
      record.settings = cloneSettings(adapter.settings);
      return instrumentAdapter(adapter, record, observer.clock);
    } catch (e) {
      if (!record.owned) record.creationError = sanitizeMessage(e);
      if (adapter) { record.owned = adapter; try { record.destroyOnce(); } catch { /* the original failure is the one to report */ } }
      throw e;
    }
  };
}

// ---- timing record -------------------------------------------------------------------------------------------

const TIMING_REASONS = Object.freeze({
  gpuActiveMs: 'not measured: no timestamp query in harness v0',
  renderMs: 'not measured: headless, no renderer',
  droppedSimulationTimeS: 'not applicable: fixed-step loop without a frame clock; the direct adapter does not reach World, so World.droppedTime is out of reach',
});
const TIMING_NOTE = 'Raw wall intervals from performance.now(), one entry per call, per pass. Rapier physics, AVBD encode/submit, AVBD queue-completion wait (a wait, not GPU active time), readback and counters reads are separate kinds and are never summed. The replay pass is a fresh solver that reads counters and all bodies after every step; none of its time is step cost.';
export const TIMING_NOT_REPORTABLE = 'Harness v0 never unlocks timing: R3 (10 s resting) cannot be decided in a 120-step window, no matched Rapier configuration is established, and there is one repeat per engine and configuration. Legacy runOne means and quantiles in `run` are combined step-encode plus queue-wait batch averages kept as raw evidence only.';

export interface PassTiming {
  pass: PassRecord['phase']; calls: Record<Method, number>;
  setupMs: number | null; rapierStepMs: number[] | null; avbdEncodeMs: number[] | null; avbdQueueWaitMs: number[] | null;
  readbackMs: number[]; countersReadMs: number[] | null; nullReasons: Record<string, string>;
}
function passTiming(record: PassRecord): PassTiming {
  const reasons: Record<string, string> = {};
  const rapier = record.engine === 'rapier';
  if (record.setupMs === null) reasons.setupMs = 'setup never completed (adapter creation or the first completion failed)';
  if (!rapier) reasons.rapierStepMs = 'AVBD: step() only encodes and submits';
  if (rapier) { reasons.avbdEncodeMs = 'Rapier: physics completes inside step()'; reasons.avbdQueueWaitMs = 'Rapier: there is no GPU queue'; reasons.countersReadMs = 'Rapier: inspect() reads a CPU active-body count, not GPU counters'; }
  return { pass: record.phase, calls: { ...record.calls }, setupMs: record.setupMs,
    rapierStepMs: rapier ? [...record.stepMs] : null, avbdEncodeMs: rapier ? null : [...record.stepMs],
    avbdQueueWaitMs: rapier ? null : [...record.completeMs], readbackMs: record.snapshots.map(s => s.ms),
    countersReadMs: rapier ? null : record.inspects.map(s => s.ms), nullReasons: reasons };
}
export function buildTiming(observer: RunObserver) {
  const timed = observer.passes.find(p => p.phase === 'timed'), replay = observer.passes.find(p => p.phase === 'replay');
  return { unit: 'ms', note: TIMING_NOTE, timedPass: timed ? passTiming(timed) : null, replayPass: replay ? passTiming(replay) : null,
    gpuActiveMs: null, renderMs: null, droppedSimulationTimeS: null, nullReasons: { ...TIMING_REASONS } };
}

// ---- judging ---------------------------------------------------------------------------------------------------

export interface SceneFacts { hash: string; bodies: number; dynamicBodies: number; joints: number }
export function sceneFacts(scene: Scene): SceneFacts {
  return { hash: sceneHash(scene), bodies: scene.bodies.length, dynamicBodies: scene.bodies.filter(b => b.mass > 0).length, joints: (scene.joints ?? []).length };
}
export type FailureKind = 'counter-limit' | 'invalid-state' | 'replay-mismatch' | 'timeout' | 'gpu-error' | 'adapter-cleanup' | 'scene-mismatch' | 'harness-error' | 'execution-error';
export interface ExecutionFailure { kind: FailureKind; phase: 'setup' | 'timed' | 'replay' | 'cleanup' | 'preflight' | 'late'; message: string }

export interface JudgeInput {
  row: RowDef; engine: Engine; options: Options; facts: SceneFacts;
  /** `null` when runOne rejected (it throws only from cleanup) or never ran. */
  result: Result | null;
  /** The replay pass, when one was created. */
  replay: PassRecord | null;
  /** Non-finite values seen in any snapshot of any pass. */
  nonFiniteSnapshotValues: number;
  failure: ExecutionFailure | null;
}

interface Pending { state: CriterionState; value: CriterionValue; verdict: Verdict | null; reason: string | null; coverage?: Criterion['coverage']; detail?: Record<string, unknown> }
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sampleCoverage(input: JudgeInput): { complete: boolean; expected: number; observed: number } {
  const expected = input.options.lead + input.options.steps, samples = input.result?.qualitySamples ?? [];
  let observed = 0;
  while (observed < samples.length && samples[observed].step === observed + 1) observed++;
  return { complete: input.result?.status === 'completed' && observed === expected && samples.length === expected, expected, observed };
}

/** A maximum over samples against `<= limit`. Over the limit is a failure even when coverage is partial (the run only got worse);
 * a pass needs every sample present, finite and at or under it; anything else cannot be decided. */
function judgeMax(values: readonly unknown[], covered: { complete: boolean; expected: number; observed: number }, limit: number, what: string): Pending {
  const finite = values.filter(isNum);
  const peak = finite.length ? Math.max(...finite) : null;
  const coverage = { expected: covered.expected, observed: covered.observed };
  if (peak !== null && peak > limit) return { state: 'measured', value: peak, verdict: 'fail', reason: `${what} exceeds the limit`, coverage };
  const missing = values.length - finite.length;
  if (!covered.complete || missing > 0 || peak === null) {
    const why = !covered.complete ? `incomplete sample coverage (${covered.observed} of ${covered.expected} steps)` : `${missing || 'no'} sample value(s) missing or not finite`;
    return { state: 'unknown', value: null, verdict: 'unknown', reason: `${what}: ${why}`, coverage, detail: { partialMax: peak } };
  }
  return { state: 'measured', value: peak, verdict: 'pass', reason: null, coverage };
}
function judgeZero(values: readonly unknown[], covered: { complete: boolean; expected: number; observed: number }, what: string): Pending {
  const finite = values.filter(isNum);
  const peak = finite.length ? Math.max(...finite) : null;
  const coverage = { expected: covered.expected, observed: covered.observed };
  if (peak !== null && peak > 0) return { state: 'measured', value: peak, verdict: 'fail', reason: `${what} is not zero`, coverage };
  if (!covered.complete || finite.length !== values.length || peak === null) {
    return { state: 'unknown', value: null, verdict: 'unknown', reason: `${what}: incomplete or non-finite samples`, coverage, detail: { partialMax: peak } };
  }
  return { state: 'measured', value: 0, verdict: 'pass', reason: null, coverage };
}
const unknown = (reason: string, detail?: Record<string, unknown>): Pending => ({ state: 'unknown', value: null, verdict: 'unknown', reason, ...(detail ? { detail } : {}) });

function evaluate(id: CriterionId, input: JudgeInput): Pending {
  const { result, options, row, facts, engine } = input;
  const cover = sampleCoverage(input);
  const samples = result?.qualitySamples ?? [];
  switch (id) {
    case 'V1': {
      const per = samples.map(s => (s.quality?.nonFiniteBodies ?? NaN) + (s.quality?.invalidRotations ?? NaN));
      const endpoints = [result?.initialQuality, result?.finalQuality];
      const endpointBad = endpoints.some(q => q && (q.nonFiniteBodies > 0 || q.invalidRotations > 0));
      if (endpointBad || input.nonFiniteSnapshotValues > 0 || per.some(v => v > 0)) {
        const peak = Math.max(0, ...per.filter(isNum), ...endpoints.map(q => q ? q.nonFiniteBodies + q.invalidRotations : 0));
        return { state: 'measured', value: peak, verdict: 'fail', reason: 'non-finite body or quaternion norm off by more than 1e-4', coverage: { expected: cover.expected, observed: cover.observed },
          detail: { nonFiniteSnapshotValues: input.nonFiniteSnapshotValues } };
      }
      if (!endpoints.every(Boolean)) return unknown('initial or timed-final state was not evaluated', { coverage: cover });
      return judgeZero(per, cover, 'non-finite bodies plus invalid quaternions');
    }
    case 'V2': {
      if (engine === 'rapier') return { state: 'notObservable', value: null, verdict: null, reason: 'Rapier has no GPU counters' };
      const obs = input.replay?.inspects ?? [];
      const bad = obs.filter(o => o.error !== null && /overflow|clashes/i.test(o.error) || (o.overflow ?? 0) > 0 || (o.clashes ?? 0) > 0);
      if (bad.length) {
        const v = Math.max(...bad.map(o => Math.max(o.overflow ?? 1, o.clashes ?? 0)));
        return { state: 'measured', value: v, verdict: 'fail', reason: 'counter overflow or clashes are not zero', coverage: { expected: cover.expected, observed: obs.length } };
      }
      const clean = obs.every(o => o.error === null && o.overflow === 0 && o.clashes === 0);
      if (obs.length !== cover.expected || !clean) {
        return unknown(`counters were not read cleanly on every replay step (${obs.length} of ${cover.expected})`, { coverage: { expected: cover.expected, observed: obs.length } });
      }
      return { state: 'measured', value: 0, verdict: 'pass', reason: null, coverage: { expected: cover.expected, observed: obs.length } };
    }
    case 'V3':
      if (result?.replayMatches === false) return { state: 'measured', value: false, verdict: 'fail', reason: 'the replay did not reproduce the timed final state' };
      if (result?.replayMatches === true && result.status === 'completed') return { state: 'measured', value: true, verdict: 'pass', reason: null };
      return unknown('the replay comparison was not reached');
    case 'V4': {
      const observed = { hash: result?.hash ?? facts.hash, bodies: result?.bodies ?? facts.bodies, dynamicBodies: result?.dynamicBodies ?? facts.dynamicBodies, joints: facts.joints };
      const declared = { hash: row.hash, bodies: row.bodies, dynamicBodies: row.dynamicBodies, joints: row.joints };
      const same = observed.hash === declared.hash && observed.bodies === declared.bodies && observed.dynamicBodies === declared.dynamicBodies && observed.joints === declared.joints
        && facts.hash === declared.hash && facts.bodies === declared.bodies;
      return { state: 'measured', value: observed.hash, verdict: same ? 'pass' : 'fail', reason: same ? null : 'the scene does not match the declaration', detail: { declared, observed } };
    }
    case 'C1': return judgeZero(samples.map(s => s.quality?.outsideFloorBodies), cover, 'bodies outside the floor');
    case 'C2': return judgeMax(samples.map(s => s.quality?.maxRelativeFloorPenetration), cover, FLOOR_TARGET, 'relative floor depth');
    case 'C3': {
      const contacts = samples.map(s => s.contacts?.maxRelativeDepth);
      const pending = judgeMax(contacts, cover, FLOOR_TARGET, 'relative body-pair depth');
      if (ROW_CRITERIA[row.id].C3 !== 'notObservable') return pending;
      const finite = contacts.filter(isNum);
      return { state: 'notObservable', value: null, verdict: null, reason: 'contactQuality does not know that jointed pairs ignore collision, so neighbouring-link depth is not a contact result',
        detail: { rawMaxRelativeDepth: finite.length ? Math.max(...finite) : null, rawMaxDepth: samples.some(s => isNum(s.contacts?.maxDepth)) ? Math.max(...samples.map(s => s.contacts?.maxDepth).filter(isNum)) : null, unjudged: true, samples: contacts.length } };
    }
    case 'R1': {
      const w = result?.finalWindow, want = Math.min(options.finalWindow, options.steps);
      if (!w || w.steps !== want || !isNum(w.maxSpeed)) return unknown(`final-window speed unavailable (${w ? `${w.steps} of ${want} steps` : 'run did not finish'})`);
      return { state: 'measured', value: w.maxSpeed, verdict: w.maxSpeed <= SETTLED_MAX_SPEED ? 'pass' : 'fail', reason: w.maxSpeed <= SETTLED_MAX_SPEED ? null : 'speed exceeds the limit', coverage: { expected: want, observed: w.steps } };
    }
    case 'R2': {
      const w = result?.finalWindow;
      return w && isNum(w.restFraction) ? { state: 'measured', value: w.restFraction, verdict: null, reason: null } : unknown('rest fraction unavailable');
    }
    case 'R3': {
      if (ROW_CRITERIA[row.id].R3 === 'notDefined') return { state: 'notObservable', value: null, verdict: null, reason: 'not defined for this scene' };
      const seconds = options.steps * options.dt;
      if (!(seconds >= RESTING_MIN_SECONDS)) return unknown(`needs at least ${RESTING_MIN_SECONDS} measured seconds; this window is ${seconds.toFixed(0)} s`, { measuredSeconds: seconds });
      if (typeof result?.restingTargetMet !== 'boolean') return unknown('runOne did not decide the resting target');
      return { state: 'measured', value: result.restingTargetMet, verdict: result.restingTargetMet ? 'pass' : 'fail', reason: result.restingTargetMet ? null : 'resting target not met' };
    }
    case 'J1': {
      const joint = result?.physical?.maxJointError;
      // maxJointError is already a maximum over every replay step, so it is decided only for a finished run
      return judgeMax([joint], cover, JOINT_ANCHOR_MAX, 'joint anchor separation');
    }
    case 'E1': {
      const p = result?.physical?.final;
      if (!p || !isNum(p.energyChange) || !isNum(p.momentumChange)) return unknown('energy and momentum change unavailable');
      return { state: 'measured', value: p.energyChange, verdict: null, reason: null, detail: { energyChange: p.energyChange, relativeEnergyChange: p.relativeEnergyChange, momentumChange: p.momentumChange, relativeMomentumChange: p.relativeMomentumChange, note: 'diagnostics at the last replay step, not conservation errors' } };
    }
  }
}

const THRESHOLD_OF: Readonly<Partial<Record<CriterionId, Criterion['threshold']>>> = Object.freeze({
  V1: { op: '==', value: 0 }, V2: { op: '==', value: 0 }, V3: { op: 'bitwise-equal', value: true }, V4: { op: '==', value: true }, C1: { op: '==', value: 0 },
  C2: { op: '<=', value: FLOOR_TARGET }, C3: { op: '<=', value: FLOOR_TARGET }, R1: { op: '<=', value: SETTLED_MAX_SPEED },
  R3: { op: '<=', value: FLOOR_TARGET }, J1: { op: '<=', value: JOINT_ANCHOR_MAX },
});

/** Judge every criterion of a row. Missing or non-finite aggregates are unknown, never a numeric zero or a pass. */
export function judgeRow(input: JudgeInput): { criteria: Criterion[]; rowVerdict: RowVerdict } {
  const roles = ROW_CRITERIA[input.row.id];
  const criteria: Criterion[] = [];
  for (const id of CRITERIA_IDS) {
    const role = roles[id];
    if (!role) continue;
    const info = CRITERION_INFO[id];
    const required = role === 'required' && !(id === 'V2' && input.engine === 'rapier');
    let pending = evaluate(id, input);
    // Recorded criteria carry a value but no verdict; failed runs may still have decided a failure above.
    if (role === 'recorded') pending = { ...pending, verdict: null };
    const threshold = role === 'recorded' || role === 'notObservable' || role === 'notDefined' ? null : THRESHOLD_OF[id] ?? null;
    criteria.push({ id, title: info.title, required, state: pending.state, value: pending.value, unit: info.unit, threshold: pending.state === 'notObservable' ? null : threshold,
      verdict: pending.verdict, reason: pending.reason, cadence: info.cadence, source: info.source,
      ...(pending.coverage ? { coverage: pending.coverage } : {}), ...(pending.detail ? { detail: pending.detail } : {}) });
  }
  return { criteria, rowVerdict: rowVerdictOf(criteria, input.failure) };
}

/** `fail` if the run failed or any required criterion fails; else `unknown` if any required one is unknown; else `pass`. */
export function rowVerdictOf(criteria: readonly Criterion[], failure: ExecutionFailure | null): Verdict {
  const required = criteria.filter(c => c.required);
  if (failure || required.some(c => c.verdict === 'fail')) return 'fail';
  return required.every(c => c.verdict === 'pass') ? 'pass' : 'unknown';
}

// ---- failure classification --------------------------------------------------------------------------------------

export function classifyFailure(message: string, status: Result['status'] | 'rejected', passes: number, gpuErrors: boolean): ExecutionFailure {
  const phase: ExecutionFailure['phase'] = status === 'rejected' ? 'cleanup' : passes >= 2 ? 'replay' : passes === 1 ? 'timed' : 'setup';
  const kind: FailureKind = gpuErrors || /^GPU error|device lost/i.test(message) ? 'gpu-error' : status === 'timeout' || /case timeout/i.test(message) ? 'timeout'
    : /overflow=|clashes=|Invalid GPU step/i.test(message) ? 'counter-limit' : /Invalid body state/i.test(message) ? 'invalid-state'
    : /replay did not reproduce/i.test(message) ? 'replay-mismatch' : status === 'rejected' ? 'adapter-cleanup' : 'execution-error';
  return { kind, phase, message: sanitizeMessage(message) };
}

// ---- running rows ---------------------------------------------------------------------------------------------------

export interface RowRecord {
  id: RowId; runId: string; title: string; scene: string; declared: { hash: string; bodies: number; dynamicBodies: number; joints: number };
  observed: SceneFacts | null; engine: Engine; config: Record<string, unknown>;
  execution: { status: 'completed' | 'failed' | 'notRun'; failure: ExecutionFailure | null; notRunReason: string | null; cleanupErrors: string[]; gpuErrors: string[] };
  run: Record<string, unknown> | null; criteria: Criterion[]; rowVerdict: RowVerdict;
  timing: ReturnType<typeof buildTiming> | null; timingReportable: false; timingReportableReason: string;
  observations: { passes: PassObservation[] };
  limits: string[];
}
export interface PassObservation {
  phase: PassRecord['phase']; engine: Engine; creationMs: number | null; creationError: string | null; settings: unknown;
  inspects: InspectObservation[]; snapshots: SnapshotObservation[]; errors: PassRecord['errors']; destroy: { calls: number; destroyed: boolean; redundantCalls: number; error: string | null };
}
const ROW_LIMITS = Object.freeze([
  'Necessary engineering checks on sampled states over a 2 s window on one device: not full S1, not World integration, not a proof of non-penetration, contact correctness, physical accuracy, performance or human acceptance.',
  'Bounding-box overlap is only a candidate filter; C2 and C3 measure exact box/sphere overlap at stored poses and do not see engine contacts, forces or anything between samples.',
  'Legacy runOne means and quantiles inside `run` are combined batch averages kept as raw nested evidence only; this record offers no comparison, ranking or winner.',
]);

function observationOf(p: PassRecord): PassObservation {
  return { phase: p.phase, engine: p.engine, creationMs: p.creationMs, creationError: p.creationError, settings: p.settings, inspects: p.inspects, snapshots: p.snapshots, errors: p.errors,
    destroy: { calls: p.calls.destroy, destroyed: p.destroyed, redundantCalls: p.redundantDestroyCalls, error: p.destroyError } };
}
function resolvedConfig(spec: RunSpec, options: Options, observer: RunObserver | null, result: Result | null): Record<string, unknown> {
  const settings = result?.settings ?? observer?.passes[0]?.settings ?? null;
  if (spec.engine === 'avbd') {
    return { id: spec.config, label: AVBD_CONFIGS[spec.config as ConfigId].label, appliesToConfigs: spec.appliesToConfigs, resolvedSettings: settings,
      declared: { dt: options.dt, iterations: options.avbdIterations, contactMargin: options.avbdMargin, lead: options.lead, steps: options.steps, batchSize: options.batchSize,
        repeats: options.repeats, finalWindow: options.finalWindow, jitter: options.jitter, impactPhase: options.impactPhase, timeoutMs: options.timeoutMs, sleeping: false, adapt: false } };
  }
  return { id: 'R', label: 'Rapier 0.21.0 reference: 10 solver iterations, 1 PGS, sleeping off, CCD off; one run serves every selected AVBD configuration',
    appliesToConfigs: spec.appliesToConfigs, mapping: 'A and B differ only in AVBD contactMargin, which Rapier does not have', resolvedSettings: settings,
    declared: { dt: options.dt, iterations: options.rapierIterations, internalPgsIterations: options.rapierPgsIterations, sleeping: options.rapierSleeping, ccd: options.rapierCcd,
      ccdSubsteps: options.rapierCcdSubsteps, lead: options.lead, steps: options.steps, batchSize: options.batchSize, repeats: options.repeats, finalWindow: options.finalWindow, timeoutMs: options.timeoutMs } };
}
function sanitizedResult(result: Result): Record<string, unknown> {
  return { ...result, ...(result.error === undefined ? {} : { error: sanitizeMessage(result.error) }) };
}
function baseRow(spec: RunSpec, row: RowDef): Pick<RowRecord, 'id' | 'runId' | 'title' | 'scene' | 'declared' | 'engine' | 'timingReportable' | 'timingReportableReason' | 'limits'> {
  return { id: row.id, runId: spec.runId, title: row.title, scene: row.scene, declared: { hash: row.hash, bodies: row.bodies, dynamicBodies: row.dynamicBodies, joints: row.joints },
    engine: spec.engine, timingReportable: false, timingReportableReason: TIMING_NOT_REPORTABLE, limits: [...ROW_LIMITS] };
}
/** A declared row that was not executed. It is `notRun`, never a pass; `verdict` is `fail` only when V4 already refuted the scene. */
export function notRunRow(spec: RunSpec, reason: string, verdict: RowVerdict = 'notRun', criteria: Criterion[] = [], observed: SceneFacts | null = null, failure: ExecutionFailure | null = null): RowRecord {
  const row = ROWS[spec.row];
  return { ...baseRow(spec, row), observed, config: resolvedConfig(spec, declaredOptions(spec.engine, spec.config), null, null),
    execution: { status: 'notRun', failure, notRunReason: reason, cleanupErrors: [], gpuErrors: [] }, run: null, criteria, rowVerdict: verdict, timing: null, observations: { passes: [] } };
}

interface RunContext { host: QualificationHost; session: GpuSession | null; poison: { reason: string | null } }
async function executeRun(spec: RunSpec, ctx: RunContext): Promise<RowRecord> {
  const row = ROWS[spec.row], options = declaredOptions(spec.engine, spec.config), gpu = spec.engine === 'avbd';
  const noop = () => {};
  if (gpu && ctx.poison.reason) return notRunRow(spec, `Not run: ${ctx.poison.reason}`);
  let scene: Scene;
  try { scene = ctx.host.makeScene(row.scene); } catch (e) {
    const failure: ExecutionFailure = { kind: 'harness-error', phase: 'preflight', message: sanitizeMessage(e) };
    return notRunRow(spec, 'The declared scene could not be built', 'fail', [], null, failure);
  }
  const facts = sceneFacts(scene);
  const declaredFacts = facts.hash === row.hash && facts.bodies === row.bodies && facts.dynamicBodies === row.dynamicBodies && facts.joints === row.joints;
  if (!declaredFacts) {
    // V4 refutes the declaration before any compute: running another scene would not be this row.
    const { criteria } = judgeRow({ row, engine: spec.engine, options, facts, result: null, replay: null, nonFiniteSnapshotValues: 0, failure: null });
    const failure: ExecutionFailure = { kind: 'scene-mismatch', phase: 'preflight', message: 'The scene does not match the declared hash and counts (V4); nothing ran' };
    return notRunRow(spec, failure.message, 'fail', criteria.map(c => c.id === 'V4' ? c : { ...c, state: 'notRun', value: null, verdict: null, reason: 'not run' }), facts, failure);
  }
  const observer = new RunObserver(ctx.host.clock);
  const gpuBefore = ctx.session ? ctx.session.gpuErrors().length : 0;
  let result: Result | null = null, rejection: unknown;
  let rejected = false;
  try {
    result = await runOne(spec.engine, scene, 0, options, ctx.session?.device ?? (null as unknown as GPUDevice), gpu && ctx.session ? () => ctx.session!.guard() : noop, observedFactory(ctx.host.createAdapter, observer));
  } catch (e) { rejected = true; rejection = e; }
  const cleanupErrors = observer.sweep();
  // runOne catches a failure in its explicit timed-pass destroy, so it does not reject.
  // The attempted destroy is not retried by sweep; still retain it and poison this session.
  for (const pass of observer.passes) if (pass.destroyError !== null) {
    const message = `Adapter cleanup failed (${pass.phase}): ${pass.destroyError}`;
    if (!cleanupErrors.includes(message)) cleanupErrors.push(message);
  }
  let late: string[] = [];
  if (gpu && ctx.session) {
    try { await ctx.session.settle(); } catch (e) { late.push(`Queue drain failed: ${sanitizeMessage(e)}`); }
    late = [...ctx.session.gpuErrors().slice(gpuBefore).map(sanitizeMessage), ...late];
  }
  let failure: ExecutionFailure | null = null;
  if (rejected) failure = classifyFailure(sanitizeMessage(rejection), 'rejected', observer.passes.length, late.length > 0);
  else if (cleanupErrors.length) failure = { kind: 'adapter-cleanup', phase: 'cleanup', message: cleanupErrors[0] };
  else if (result && result.status !== 'completed') failure = classifyFailure(result.error ?? result.status, result.status, observer.passes.length, late.length > 0);
  else if (late.length) failure = { kind: 'gpu-error', phase: 'late', message: late[0] };
  // A shared GPU failure, a timeout or a leaked solver leaves the device untrustworthy for the next row.
  if (gpu && ctx.session && !ctx.poison.reason && (late.length > 0 || (failure && ['gpu-error', 'timeout', 'adapter-cleanup'].includes(failure.kind))))
    ctx.poison.reason = `shared GPU failure in ${spec.runId}${failure ? ` (${failure.kind})` : ''}; remaining GPU rows are not attempted on a poisoned device`;
  const replay = observer.passes.find(p => p.phase === 'replay') ?? null;
  const nonFinite = observer.passes.reduce((n, p) => n + p.snapshots.reduce((m, s) => m + (s.nonFiniteValues ?? 0), 0), 0);
  const { criteria, rowVerdict } = judgeRow({ row, engine: spec.engine, options, facts, result, replay, nonFiniteSnapshotValues: nonFinite, failure });
  return { ...baseRow(spec, row), observed: facts, config: resolvedConfig(spec, options, observer, result),
    execution: { status: failure ? 'failed' : 'completed', failure, notRunReason: null, cleanupErrors, gpuErrors: late },
    run: result ? sanitizedResult(result) : null, criteria, rowVerdict, timing: buildTiming(observer), observations: { passes: observer.passes.map(observationOf) } };
}

// ---- report ------------------------------------------------------------------------------------------------------------

export type ReportStatus = 'completed' | 'failed' | 'refused';
export interface QualificationReport {
  schema: typeof QUALIFICATION_SCHEMA; status: ReportStatus; proposal: true; benchmark: false; generatedAt: string; verdict: string;
  protocol: { document: string; scope: string };
  source: unknown; environment: unknown;
  config: Record<string, unknown> | null;
  rows: RowRecord[];
  error: { message: string } | null;
  gpuErrors?: string[]; teardownErrors?: string[];
  declaredNotRun: readonly string[];
}
const DECLARED_NOT_RUN = Object.freeze([
  'R3 10 s resting window (needs 600 measured steps; stays unknown at 120)', 'Rapier with sleeping on', 'AVBD below 10 iterations',
  'Staged, larger and per-feature rows (QUALIFICATION_MATRIX §4-5)', 'Repeats with alternating order', 'Any World-level, rendered, long-run, large-scale or target-hardware (M1, GTX 1080) path',
]);
const PROTOCOL = Object.freeze({ document: 'docs/QUALIFICATION_MATRIX.md', scope: 'Engineering protocol, accepted before any trial. Not Steven acceptance, not hardware qualification until a clean identified run is filed, not full S1.' });
const VERDICTS = Object.freeze({
  completed: 'Every selected row ran to a decision. Verdicts are per row and criterion (pass / fail / unknown); a row pass is a short-window necessary check, not S1, World, physical, performance or human acceptance.',
  failed: 'At least one row, or the host cleanup, failed. Partial records are kept and nothing was retuned.',
  refused: 'Refused before any compute: nothing ran.',
});

function configRecord(config: QualificationConfig, specs: readonly RunSpec[]): Record<string, unknown> {
  return { rows: config.rows, engines: config.engines, configs: config.configs, bounds: BOUNDS, thresholds: THRESHOLDS,
    rowTable: config.rows.map(id => ROWS[id]),
    runs: specs.map(s => ({ runId: s.runId, engine: s.engine, config: s.config, appliesToConfigs: s.appliesToConfigs, options: declaredOptions(s.engine, s.config) })),
    rapierMapping: config.engines.includes('rapier') ? 'One Rapier run per row; it applies to every selected AVBD configuration because A and B differ only in contactMargin.' : null };
}

function summarize(rows: readonly RowRecord[]): ReportStatus {
  return rows.every(r => r.execution.status === 'completed') ? 'completed' : 'failed';
}

/** A report for a run that never started (usage is refused earlier; this is the host-level refusal such as no qualified GPU). */
export function refusedReport(reason: string, parts: { source: unknown; environment: unknown; config: QualificationConfig | null; now: Date }): QualificationReport {
  const specs = parts.config ? planRuns(parts.config) : [];
  return { schema: QUALIFICATION_SCHEMA, status: 'refused', proposal: true, benchmark: false, generatedAt: parts.now.toISOString(), verdict: `${VERDICTS.refused} ${reason}`, protocol: PROTOCOL,
    source: parts.source, environment: parts.environment, config: parts.config ? configRecord(parts.config, specs) : null,
    rows: specs.map(s => notRunRow(s, `Refused: ${reason}`)), error: { message: reason }, declaredNotRun: DECLARED_NOT_RUN };
}

/** Publish only after host cleanup: a pass cannot conceal a late device or teardown failure. A refusal stays a refusal. */
export function finalizeQualificationReport(report: QualificationReport, gpuErrors: readonly string[], teardownErrors: readonly string[]): QualificationReport {
  if (gpuErrors.length === 0 && teardownErrors.length === 0) return report;
  const gpu = gpuErrors.map(sanitizeMessage), teardown = teardownErrors.map(sanitizeMessage);
  return { ...report, status: report.status === 'refused' ? 'refused' : 'failed', verdict: report.status === 'refused' ? report.verdict : VERDICTS.failed,
    error: report.error ?? { message: teardown[0] ?? gpu[0] }, ...(gpu.length ? { gpuErrors: gpu } : {}), ...(teardown.length ? { teardownErrors: teardown } : {}) };
}

/** Build provenance. Git head, dirty flag and change counts are copied exactly; unknown provenance stays null with its reason. */
export function buildSource(pkg: { name: string; version: string; devDependencies?: Record<string, string>; dependencies?: Record<string, string> }, git: GitProvenance) {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return { package: { name: pkg.name, version: pkg.version }, git,
    declaredDependencies: Object.fromEntries(['three', 'typescript', 'webgpu', '@dimforge/rapier3d-compat'].map(k => [k, deps[k] ?? null])) };
}

/** Non-finite numbers are not JSON: write them as explicit strings rather than letting them become `null`. */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>).map(toJsonSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}

/** Run the selected rows serially and return the finalized report. Row failures keep their partial record and permit the next row;
 * a shared GPU failure stops GPU execution and marks the rest `notRun`. The report is finalized only after the owned device is closed. */
export async function runQualification(rawConfig: unknown, host: QualificationHost, context: { source: unknown; environment: Record<string, unknown> }): Promise<QualificationReport> {
  const config = resolveQualificationConfig(rawConfig);
  const specs = planRuns(config);
  const scenes = new Map<RowId, Scene>(config.rows.map(id => [id, host.makeScene(ROWS[id].scene)]));
  assertWithinBounds(specs, scenes);
  // Everything above refuses before a device is requested.
  let session: GpuSession | null = null;
  let environment: Record<string, unknown> = { ...context.environment };
  const rows: RowRecord[] = [];
  let report: QualificationReport | undefined;
  let teardownErrors: string[] = [];
  let fatal: unknown;
  try {
    if (specs.some(s => s.engine === 'avbd')) {
      try { session = await host.acquireGpu(); } catch (e) {
        if (e instanceof QualificationRefusal && e.code === 'gpu') {
          report = refusedReport(e.message, { source: context.source, environment: { ...environment, adapter: e.adapter }, config, now: host.now() });
          return report;
        }
        throw e;
      }
      environment = { ...environment, adapter: session.adapter, requiredFeatures: [], requiredLimits: session.requiredLimits };
    }
    const ctx: RunContext = { host, session, poison: { reason: null } };
    for (const spec of specs) {
      try { rows.push(await executeRun(spec, ctx)); } catch (e) {
        // A bug in the harness itself must not lose the rows already run.
        rows.push(notRunRow(spec, 'The harness failed before this row finished', 'fail', [], null, { kind: 'harness-error', phase: 'late', message: sanitizeMessage(e) }));
        rows[rows.length - 1].execution.status = 'failed';
      }
    }
    report = { schema: QUALIFICATION_SCHEMA, status: summarize(rows), proposal: true, benchmark: false, generatedAt: '', verdict: '', protocol: PROTOCOL,
      source: context.source, environment, config: configRecord(config, specs), rows, error: null, declaredNotRun: DECLARED_NOT_RUN };
    report.verdict = VERDICTS[report.status];
    if (report.status === 'failed') report.error = { message: rows.find(r => r.execution.failure)?.execution.failure?.message ?? rows.find(r => r.execution.status === 'notRun')?.execution.notRunReason ?? 'a row failed' };
  } catch (e) { fatal = e; } finally {
    if (session) teardownErrors = await session.close();
  }
  if (fatal !== undefined) throw fatal;
  const gpuErrors = session ? [...session.gpuErrors()] : [];
  // stamped and finalized only now, after the owned device is closed
  return finalizeQualificationReport({ ...report!, generatedAt: host.now().toISOString() }, gpuErrors, teardownErrors);
}
