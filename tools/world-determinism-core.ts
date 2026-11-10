// Same-device determinism probe through the public World: pure runner, scene, comparison, report and argument logic
// (STE-3003, roadmap F1, first slice). No GPU, file or process access lives here; tools/world-determinism.ts is the
// Node + Dawn host. The runner takes a host that makes Worlds, so CPU tests drive the real runner with fakes.
//
// What one probe is: two Worlds, built one after the other on the same externally owned device from the same authored
// inputs and fixed storage, each stepped the same number of times with no body readback in between, then read ONCE
// (World.read) and compared bit for bit on the public fields listed in OBSERVED_FIELDS. Nothing else is compared.
import { sanitizeMessage } from '../src/comparison/interlocking-trial.ts';

export const WORLD_DETERMINISM_SCHEMA = 'three-avbd.world-determinism/1';
/** `bodies` counts dynamic bodies; a fixed floor is added, so the World holds bodies + 1 (at most 4096). */
export const PROBE_LIMITS = { steps: { min: 1, max: 600, default: 240 }, bodies: { min: 2, max: 4095, default: 16 } } as const;
export const MAX_TOTAL_BODIES = PROBE_LIMITS.bodies.max + 1;
/** `sync`: step() calls back to back, so counter readbacks World issues itself cannot land between steps.
 *  `yield`: one event-loop turn after every step(), so they can (the interleaving an application's frame loop has). */
export const PACINGS = ['sync', 'yield'] as const;
export type Pacing = typeof PACINGS[number];
/** Fixed for every probe and written into the report. */
export const PROBE_WORLD = { dt: 1 / 60, iterations: 10, gravity: [0, -9.81, 0] } as const;
export const USAGE = 'Usage: world-determinism [--steps 1..600 (default 240)] [--bodies 2..4095 (dynamic, default 16; a fixed floor is added)] [--pacing sync|yield (default sync)] [--json <new file>.json]';

export class ProbeRefusal extends Error {
  readonly code: 'input' | 'gpu';
  constructor(code: 'input' | 'gpu', message: string) { super(message); this.name = 'ProbeRefusal'; this.code = code; }
}

export interface ProbeConfig { steps: number; bodies: number; pacing: Pacing }
export const PROBE_DEFAULTS: Readonly<ProbeConfig> = Object.freeze({ steps: PROBE_LIMITS.steps.default, bodies: PROBE_LIMITS.bodies.default, pacing: 'sync' });

/** Strict: unknown or repeated flags, missing values and anything but plain decimal integers in range are refused. */
export function parseProbeArgs(argv: readonly string[]): { help: true } | { help: false; config: ProbeConfig; json?: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag !== '--steps' && flag !== '--bodies' && flag !== '--pacing' && flag !== '--json') throw new ProbeRefusal('input', `Unknown option "${String(flag).slice(0, 40)}". ${USAGE}`);
    if (value === undefined || value.startsWith('--')) throw new ProbeRefusal('input', `${flag} needs a value. ${USAGE}`);
    if (values.has(flag)) throw new ProbeRefusal('input', `${flag} given twice`);
    values.set(flag, value);
  }
  const json = values.get('--json');
  if (json !== undefined && !/\.json$/i.test(json)) throw new ProbeRefusal('input', '--json must be a path ending in .json');
  const raw: Record<string, unknown> = {};
  for (const flag of ['steps', 'bodies'] as const) {
    const text = values.get(`--${flag}`);
    if (text === undefined) continue;
    raw[flag] = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
  }
  if (values.has('--pacing')) raw.pacing = values.get('--pacing');
  return { help: false, config: resolveProbeConfig(raw), ...(json !== undefined ? { json } : {}) };
}

/** Apply defaults and refuse anything out of range. Used by the argument parser and again by the runner, before anything is acquired. */
export function resolveProbeConfig(raw: unknown): ProbeConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ProbeRefusal('input', 'The probe configuration must be an object');
  const given = raw as Record<string, unknown>;
  for (const key of Object.keys(given)) if (key !== 'steps' && key !== 'bodies' && key !== 'pacing') throw new ProbeRefusal('input', `Unknown configuration key "${key.slice(0, 40)}"`);
  const integer = (key: 'steps' | 'bodies') => {
    const { min, max, default: fallback } = PROBE_LIMITS[key], v = given[key];
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ProbeRefusal('input', `${key} must be a whole number from ${min} to ${max}`);
    return v;
  };
  const pacing = given.pacing === undefined ? PROBE_DEFAULTS.pacing : given.pacing;
  if (!PACINGS.includes(pacing as Pacing)) throw new ProbeRefusal('input', `pacing must be one of ${PACINGS.join(', ')}`);
  return { steps: integer('steps'), bodies: integer('bodies'), pacing: pacing as Pacing };
}

// ---- authored inputs ------------------------------------------------------------------------------

type V3 = [number, number, number];
type V4 = [number, number, number, number];
export interface SceneBody { shape: 'box' | 'sphere'; size: V3; position: V3; rotation: V4; fixed: boolean }
export interface SceneJoint { a: number; b: number; anchorA: V3; anchorB: V3 }
export interface Scene { bodies: SceneBody[]; joints: SceneJoint[] }

/**
 * Authored inputs, no randomness: a fixed floor (body 0); a ball-jointed pair of boxes beside the lattice (bodies 1 and 2,
 * joint between them); then boxes and spheres dropped from a staggered 8 x 8 lattice, layer on layer. Every value is a
 * function of the body count, so two builds from the same count are identical.
 */
export function authoredScene(dynamic: number): Scene {
  if (!Number.isInteger(dynamic) || dynamic < PROBE_LIMITS.bodies.min || dynamic > PROBE_LIMITS.bodies.max) throw new ProbeRefusal('input', `bodies must be a whole number from ${PROBE_LIMITS.bodies.min} to ${PROBE_LIMITS.bodies.max}`);
  const bodies: SceneBody[] = [
    { shape: 'box', size: [48, 1, 48], position: [0, -0.5, 0], rotation: [0, 0, 0, 1], fixed: true },
    { shape: 'box', size: [1, 1, 1], position: [-0.6, 2, -10], rotation: [0, 0, 0, 1], fixed: false },
    { shape: 'box', size: [1, 1, 1], position: [0.6, 2, -10], rotation: [0, 0, 0, 1], fixed: false },
  ];
  // The anchors meet at (0, 2, -10): the joint starts unstressed
  const joints: SceneJoint[] = [{ a: 1, b: 2, anchorA: [0.6, 0, 0], anchorB: [-0.6, 0, 0] }];
  for (let k = 0; k < dynamic - 2; k++) {
    const col = k % 8, row = Math.floor(k / 8) % 8, layer = Math.floor(k / 64), odd = layer % 2 === 1;
    const position: V3 = [(col - 3.5) * 1.5 + (odd ? 0.3 : 0), 1 + layer * 1.4 + ((col + row) % 3) * 0.1, (row - 3.5) * 1.5 + (odd ? -0.2 : 0)];
    if (k % 2 === 0) {
      const turn = 0.3 * k;
      bodies.push({ shape: 'box', size: [1, 0.8 + 0.1 * (k % 3), 1], position, rotation: [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)], fixed: false });
    } else bodies.push({ shape: 'sphere', size: [1, 1, 1], position, rotation: [0, 0, 0, 1], fixed: false });
  }
  return { bodies, joints };
}

export interface FixedStorageRequest { growth: 'fixed'; pairs: number; contacts: number; manifolds: number; joints: number; hullVec4s: number }
/**
 * Explicit fixed capacities, roomy on purpose (tools/determinism.ts used the same per-body ratios on a 4k pile): an overflow
 * drops records in an order that depends on thread timing, which would be a different cause than the one being probed.
 * The public World does not report overflow, so this is a precaution and not an observation.
 */
export function fixedStorageFor(totalBodies: number): FixedStorageRequest {
  return { growth: 'fixed', pairs: Math.max(4096, 16 * totalBodies), contacts: Math.max(8192, 32 * totalBodies), manifolds: Math.max(4096, 8 * totalBodies), joints: 256, hullVec4s: 4096 };
}

export interface WorldSetup { maxBodies: number; dt: number; iterations: number; gravity: V3; storage: FixedStorageRequest }
export function worldSetupFor(config: ProbeConfig): WorldSetup {
  const total = config.bodies + 1;
  return { maxBodies: total, dt: PROBE_WORLD.dt, iterations: PROBE_WORLD.iterations, gravity: [...PROBE_WORLD.gravity], storage: fixedStorageFor(total) };
}

// ---- the public World surface the probe uses ------------------------------------------------------

export interface ProbeBody {
  readonly id: number;
  readonly position: readonly number[];
  readonly rotation: readonly number[];
  readonly velocity: readonly number[];
  readonly angularVelocity: readonly number[];
}
/** The structural subset of the public `World` the probe touches. The real class must satisfy it (checked by the host's typecheck). */
export interface ProbeWorld {
  /** Automatic readback period. The probe requires 0 and never assigns it. */
  readbackEvery: number;
  readonly stepCount: number;
  readonly storageInfo: Readonly<{ growth: string }>;
  addBox(options: { size: V3; position: V3; rotation: V4; fixed: boolean }): ProbeBody | null;
  addSphere(options: { radius: number; position: V3; rotation: V4; fixed: boolean }): ProbeBody | null;
  addJoint(a: ProbeBody, b: ProbeBody, options: { type: 'ball'; anchorA: V3; anchorB: V3 }): unknown;
  step(): void;
  read(): Promise<{ step: number }>;
  destroy(): void;
}

export interface ProbeHost {
  /** Make a World on the host's device. The host owns the device; the runner never touches it. */
  createWorld(setup: WorldSetup): Promise<ProbeWorld>;
  /** After a World is destroyed: wait for submitted GPU work. */
  settle?(): Promise<void>;
  /** Throws when the device has recorded an error (uncaptured error, loss). */
  check?(): void;
  /** One event-loop turn; used by `yield` pacing. */
  yieldTurn(): Promise<void>;
  now(): Date;
}

/** Create the scene's bodies and joints in World order; a World that refuses any is a failure, not a smaller scene. */
export function populate(world: ProbeWorld, scene: Scene): ProbeBody[] {
  const handles: ProbeBody[] = [];
  scene.bodies.forEach((s, i) => {
    const common = { position: [...s.position] as V3, rotation: [...s.rotation] as V4, fixed: s.fixed };
    const body = s.shape === 'box' ? world.addBox({ ...common, size: [...s.size] as V3 }) : world.addSphere({ ...common, radius: s.size[0] / 2 });
    if (!body) throw new Error(`World refused body ${i}: full`);
    handles.push(body);
  });
  for (const j of scene.joints) world.addJoint(handles[j.a], handles[j.b], { type: 'ball', anchorA: [...j.anchorA] as V3, anchorB: [...j.anchorB] as V3 });
  return handles;
}

// ---- what is observed -----------------------------------------------------------------------------

/** The public per-body fields compared, in order. Each is the float32 value World.read() put in Body.<field>. */
export const OBSERVED_FIELDS = [
  { name: 'position', components: ['x', 'y', 'z'] },
  { name: 'rotation', components: ['x', 'y', 'z', 'w'] },
  { name: 'velocity', components: ['x', 'y', 'z'] },
  { name: 'angularVelocity', components: ['x', 'y', 'z'] },
] as const;
export const FLOATS_PER_BODY = OBSERVED_FIELDS.reduce((n, f) => n + f.components.length, 0);
const SLOT_LABELS: string[] = OBSERVED_FIELDS.flatMap(f => f.components.map(c => `${f.name}.${c}`));

/** Copy the bodies' public fields as float32. A wrong length, a non-number, a non-finite value or one that is not exactly a float32 is a failed read, not data. */
export function observeBodies(bodies: readonly ProbeBody[]): Float32Array {
  const out = new Float32Array(bodies.length * FLOATS_PER_BODY);
  bodies.forEach((body, i) => {
    let slot = 0;
    for (const field of OBSERVED_FIELDS) {
      const values = body[field.name] as readonly unknown[];
      if (!Array.isArray(values) || values.length !== field.components.length) throw new Error(`Invalid read: body ${i} ${field.name} has ${Array.isArray(values) ? values.length : 'no'} components, expected ${field.components.length}`);
      for (let c = 0; c < values.length; c++, slot++) {
        const v = values[c];
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid read: body ${i} ${SLOT_LABELS[slot]} is not a finite number`);
        if (Math.fround(v) !== v) throw new Error(`Invalid read: body ${i} ${SLOT_LABELS[slot]} is not a float32 readback value`);
        out[i * FLOATS_PER_BODY + slot] = v;
      }
    }
  });
  return out;
}

/** FNV-1a over the float32 bit patterns, for matching reports across runs. Not a security hash and not a comparison: comparison is word by word. */
export function digest(values: Float32Array): string {
  const words = new Uint32Array(values.buffer, values.byteOffset, values.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < words.length; i++) {
    for (let shift = 0; shift < 32; shift += 8) h = Math.imul(h ^ ((words[i] >>> shift) & 0xff), 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface ValueDiff { value: number; bits: string }
export interface Comparison {
  status: 'identical' | 'different';
  bodiesCompared: number;
  bytesCompared: number;
  /** 32-bit words whose bit patterns differ (so +0 against -0 differs). No tolerance exists. */
  differingWords: number;
  differingBodies: number;
  /** The first differing word in body order then field order. */
  first: { body: number; field: string; run0: ValueDiff; run1: ValueDiff } | null;
  /** Informational only: the largest distance between the two position triples of differing bodies, in metres. Never used to decide the status. */
  maxPositionGap: number | null;
}

const bitsOf = (words: Uint32Array, i: number): string => words[i].toString(16).padStart(8, '0');

/** Bit-for-bit comparison of two observations of the same shape. */
export function compareObservations(a: Float32Array, b: Float32Array): Comparison {
  if (a.length !== b.length || a.length % FLOATS_PER_BODY !== 0) throw new Error(`Observations are not comparable: ${a.length} and ${b.length} values`);
  const wa = new Uint32Array(a.buffer, a.byteOffset, a.length), wb = new Uint32Array(b.buffer, b.byteOffset, b.length);
  const bodies = a.length / FLOATS_PER_BODY;
  let words = 0, differing = 0, gap: number | null = null;
  let first: Comparison['first'] = null;
  for (let body = 0; body < bodies; body++) {
    let differs = false;
    for (let slot = 0; slot < FLOATS_PER_BODY; slot++) {
      const i = body * FLOATS_PER_BODY + slot;
      if (wa[i] === wb[i]) continue;
      differs = true;
      words++;
      first ??= { body, field: SLOT_LABELS[slot], run0: { value: a[i], bits: bitsOf(wa, i) }, run1: { value: b[i], bits: bitsOf(wb, i) } };
    }
    if (!differs) continue;
    differing++;
    const o = body * FLOATS_PER_BODY;
    gap = Math.max(gap ?? 0, Math.hypot(a[o] - b[o], a[o + 1] - b[o + 1], a[o + 2] - b[o + 2]));
  }
  return { status: words === 0 ? 'identical' : 'different', bodiesCompared: bodies, bytesCompared: a.byteLength, differingWords: words, differingBodies: differing, first, maxPositionGap: gap };
}

// ---- the runner -----------------------------------------------------------------------------------

export type ProbePhase = 'create' | 'verify' | 'scene' | 'step' | 'read' | 'observe' | 'dispose' | 'settle' | 'gpu-check' | 'compare';
export interface ProbeError { phase: ProbePhase; message: string }
export interface RunRecord {
  index: 0 | 1;
  status: 'observed' | 'failed';
  /** The step World.read() reported, and World.stepCount after it. */
  stepStamp: number | null;
  stepCount: number | null;
  observedBytes: number | null;
  digest: string | null;
  /** The resolved storage plan the World reported (numbers only). */
  storage: Record<string, number | string> | null;
  error: ProbeError | null;
  /** A dispose failure after the run's own failure, kept next to it. */
  disposeError: ProbeError | null;
}

/** What the probe observed and what it did not. Written into every report. */
export const DECLARED_SCOPE = Object.freeze({
  compared: 'After the final step, one World.read() of all bodies, then for every body in creation order the float32 bit patterns of Body.position (3), Body.rotation (4), Body.velocity (3), Body.angularVelocity (3): 13 values, 52 bytes a body. Equal means every one of those 32-bit words is identical; there is no tolerance.',
  singleRead: 'Nothing is read between steps, so a mismatch cannot be placed at a step: there is no first-divergent-step result in this slice.',
  notCompared: [
    'Internal solver buffers (contact and manifold persistence, warm-start state, colourings, hashes, counters, overflow flags): the public API does not expose them',
    'Joint state and forces (the probe joint cannot break or yield, so World.read does not read joints back)',
    'Contact events (no body reports contacts)',
    'Any intermediate step',
    'Any other device, driver, build, scene or configuration',
  ],
  hiddenState: 'Identical observable bytes do not show identical hidden state, and a match does not show a full-state replay.',
  autoReadbacks: 'The probe never sets readbackEvery (it must be 0). World.step() itself still reads solver counters back every 10 steps and applies the colour-scheduling part of its adaptation when that read lands (storage capacity stays fixed). With pacing sync those reads cannot land between steps; with pacing yield they can. The public API has no switch for this, and the probe adds none.',
});
export const NOT_RUN = Object.freeze([
  'adaptive-storage variant',
  'readbackEvery variants',
  'checkpoint reads for a first divergent step',
  'cross-device or cross-build comparison',
]);

export interface ProbeReport {
  schema: typeof WORLD_DETERMINISM_SCHEMA;
  /** matched: two runs, identical on the declared fields · mismatch: two runs, a difference (evidence, nothing loosened) · failed: an error before both runs were observed and compared · refused: nothing ran. */
  status: 'matched' | 'mismatch' | 'failed' | 'refused';
  diagnostic: true;
  benchmark: false;
  generatedAt: string;
  verdict: string;
  source: unknown;
  environment: unknown;
  config: (ProbeConfig & { totalBodies: number; dt: number; iterations: number; gravity: number[]; storageRequest: FixedStorageRequest; readbackEvery: 0 }) | null;
  scope: typeof DECLARED_SCOPE;
  runs: RunRecord[];
  comparison: Comparison | { status: 'not-compared'; reason: string };
  error: (ProbeError & { run: number | null }) | null;
  notRun: readonly string[];
  /** Host errors discovered while draining or destroying its own device, after the runner returns. */
  gpuErrors?: readonly string[];
  teardownErrors?: readonly string[];
}

const VERDICTS = {
  matched: 'The two runs were identical on the declared fields. One pair of runs on one device and configuration: it shows no more than that.',
  mismatch: 'The two runs differed on the declared fields. This is recorded as evidence; no tolerance was applied and no setting was changed.',
  failed: 'The probe failed before both runs were observed and compared. No determinism result.',
  refused: 'The probe did not run. No determinism result.',
} as const;

const errorOf = (phase: ProbePhase, e: unknown): ProbeError => ({ phase, message: sanitizeMessage(e) });
const NUMERIC_STORAGE_KEYS = ['bodies', 'pairs', 'contacts', 'manifolds', 'joints', 'hullVec4s', 'watchPairs', 'watchEvents', 'colors', 'totalBytes'];
function summarizeStorage(info: unknown): Record<string, number | string> | null {
  if (typeof info !== 'object' || info === null) return null;
  const record = info as Record<string, unknown>, out: Record<string, number | string> = {};
  if (typeof record.growth === 'string') out.growth = record.growth;
  for (const key of NUMERIC_STORAGE_KEYS) if (typeof record[key] === 'number') out[key] = record[key] as number;
  return out;
}

async function oneRun(index: 0 | 1, config: ProbeConfig, scene: Scene, host: ProbeHost): Promise<{ record: RunRecord; observed: Float32Array | null }> {
  const record: RunRecord = { index, status: 'failed', stepStamp: null, stepCount: null, observedBytes: null, digest: null, storage: null, error: null, disposeError: null };
  let phase: ProbePhase = 'create', observed: Float32Array | null = null, world: ProbeWorld | undefined;
  try { world = await host.createWorld(worldSetupFor(config)); } catch (e) { record.error = errorOf(phase, e); }
  if (world) {
    try {
      phase = 'verify';
      // No silent fallback: an adaptive World, or one already reading back on its own, is not the configuration being probed
      if (world.storageInfo.growth !== 'fixed') throw new Error(`The World reports storage growth "${String(world.storageInfo.growth)}", not "fixed"`);
      if (world.readbackEvery !== 0) throw new Error(`The World's readbackEvery is ${String(world.readbackEvery)}, not 0`);
      if (world.stepCount !== 0) throw new Error(`A new World reports stepCount ${world.stepCount}, not 0`);
      record.storage = summarizeStorage(world.storageInfo);
      phase = 'scene';
      const handles = populate(world, scene);
      phase = 'step';
      for (let s = 0; s < config.steps; s++) {
        world.step();
        if (config.pacing === 'yield') await host.yieldTurn();
      }
      phase = 'read';
      const landed = await world.read();
      record.stepStamp = landed.step;
      record.stepCount = world.stepCount;
      if (landed.step !== config.steps) throw new Error(`world.read() landed on step ${String(landed.step)}, expected ${config.steps}`);
      if (world.stepCount !== config.steps) throw new Error(`World.stepCount is ${world.stepCount} after ${config.steps} steps`);
      phase = 'gpu-check';
      host.check?.();
      phase = 'observe';
      observed = observeBodies(handles);
      record.observedBytes = observed.byteLength;
      record.digest = digest(observed);
    } catch (e) { record.error = errorOf(phase, e); observed = null; }
    // Every acquired World is destroyed, on success and on failure, before anything else is made
    try { world.destroy(); } catch (e) {
      const failure = errorOf('dispose', e);
      // The run's own failure stays the error; a dispose failure alone is the error of an otherwise good run
      if (record.error) record.disposeError = failure; else record.error = failure;
      observed = null;
    }
  }
  if (!record.error) {
    try { await host.settle?.(); } catch (e) { record.error = errorOf('settle', e); observed = null; }
  }
  if (!record.error) {
    try { host.check?.(); } catch (e) { record.error = errorOf('gpu-check', e); observed = null; }
  }
  if (!record.error && observed) record.status = 'observed';
  return { record, observed: record.status === 'observed' ? observed : null };
}

/**
 * Run the probe: two Worlds one after the other. Invalid input throws ProbeRefusal before the host is asked for anything.
 * Any engine-work failure becomes a `failed` report (a run's own error first, then its dispose error); the second run is
 * not attempted after the first fails. The runner never touches the device.
 */
export async function runWorldDeterminism(rawConfig: unknown, host: ProbeHost, context: { source: unknown; environment: unknown }): Promise<ProbeReport> {
  const config = resolveProbeConfig(rawConfig);
  const scene = authoredScene(config.bodies);
  const setup = worldSetupFor(config);
  const runs: RunRecord[] = [], observations: Float32Array[] = [];
  let comparison: ProbeReport['comparison'] = { status: 'not-compared', reason: 'fewer than two runs were observed' };
  let error: ProbeReport['error'] = null;
  for (const index of [0, 1] as const) {
    const { record, observed } = await oneRun(index, config, scene, host);
    runs.push(record);
    if (record.error) { error = { run: index, ...record.error }; break; }
    observations.push(observed!);
  }
  if (!error && observations.length === 2) {
    try { comparison = compareObservations(observations[0], observations[1]); } catch (e) { error = { run: null, ...errorOf('compare', e) }; }
  }
  const status: ProbeReport['status'] = error ? 'failed' : (comparison as Comparison).status === 'identical' ? 'matched' : 'mismatch';
  return {
    schema: WORLD_DETERMINISM_SCHEMA, status, diagnostic: true, benchmark: false, generatedAt: host.now().toISOString(), verdict: VERDICTS[status],
    source: context.source, environment: context.environment,
    config: { ...config, totalBodies: setup.maxBodies, dt: setup.dt, iterations: setup.iterations, gravity: setup.gravity, storageRequest: setup.storage, readbackEvery: 0 },
    scope: DECLARED_SCOPE, runs, comparison, error, notRun: NOT_RUN,
  };
}

/** A report for a probe that never ran (host-level refusal such as no qualified GPU). */
export function refusedReport(reason: string, parts: { source: unknown; environment: unknown; config: ProbeConfig | null; now: Date }): ProbeReport {
  const setup = parts.config ? worldSetupFor(parts.config) : null;
  return {
    schema: WORLD_DETERMINISM_SCHEMA, status: 'refused', diagnostic: true, benchmark: false, generatedAt: parts.now.toISOString(), verdict: `${VERDICTS.refused} ${reason}`,
    source: parts.source, environment: parts.environment,
    config: parts.config && setup ? { ...parts.config, totalBodies: setup.maxBodies, dt: setup.dt, iterations: setup.iterations, gravity: setup.gravity, storageRequest: setup.storage, readbackEvery: 0 } : null,
    scope: DECLARED_SCOPE, runs: [], comparison: { status: 'not-compared', reason: 'nothing ran' }, error: null, notRun: NOT_RUN,
  };
}

/** Publish only after host cleanup: a byte match cannot conceal a device or teardown failure. */
export function finalizeProbeReport(report: ProbeReport, gpuErrors: readonly string[], teardownErrors: readonly string[]): ProbeReport {
  if (gpuErrors.length === 0 && teardownErrors.length === 0) return report;
  const gpu = gpuErrors.map(sanitizeMessage), teardown = teardownErrors.map(sanitizeMessage);
  return { ...report, status: 'failed', verdict: VERDICTS.failed,
    error: report.error ?? { run: null, phase: teardown.length ? 'dispose' : 'gpu-check', message: teardown[0] ?? gpu[0] },
    ...(gpu.length ? { gpuErrors: gpu } : {}), ...(teardown.length ? { teardownErrors: teardown } : {}),
  };
}
