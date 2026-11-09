// Bounded, serialized interlocking-sculpture diagnostic trial (STE-3282). Engine- and clock-injectable.
// One engine per invocation, one authored input sequence: N steps, impulse after step 120 and before
// step 121, pose observations at snapshots only. The runner owns the model it acquires and always
// attempts disposal; it never owns a GPU device. A diagnostic, not a benchmark: no speed ratio, winner,
// FPS, physical qualification or save-state claim is produced. See docs/PAIRED_STUDIES.md.
import { INTERLOCKING, ringMassProperties, type RingPieces } from './interlocking-scene.ts';
import {
  evaluateHanging, INTERLOCKING_QUALITY_CRITERIA, observeInterlocking, summarizeTrial,
  type InterlockingObservation, type InterlockingVerdict, type RingRepresentation, type StudyPose,
} from './interlocking-quality.ts';

import type { createRapierInterlocking } from './interlocking-rapier.ts';
import type { AvbdPose } from './interlocking-avbd.ts';

export const TRIAL_SCHEMA = 'three-avbd/interlocking-trial/v1';
export const TRIAL_DEFAULT_STEPS = 240;
export const TRIAL_MAX_STEPS = 720;
export const TRIAL_SNAPSHOT_INTERVAL = 60;
/** The impulse is applied after the snapshot at this step and before step 120 + 1. Not configurable. */
export const TRIAL_PUSH_AFTER_STEP = 120;
export type TrialEngineName = 'rapier' | 'avbd';
export type TrialPhase = 'setup' | 'push' | 'step' | 'gpu-wait' | 'check' | 'read' | 'observer' | 'summary' | 'dispose';

/** Predictable refusal for invalid input. Thrown before any engine or device is acquired. */
export class TrialRefusal extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TrialRefusal'; this.code = code; }
}

// ---- input validation ---------------------------------------------------------------------------
export interface TrialConfig { engine: TrialEngineName; pieces?: number; steps?: number }
export interface ValidatedTrialConfig {
  readonly engine: TrialEngineName;
  /** Rapier convex sectors per ring; null for AVBD (one analytic field per ring). */
  readonly pieces: RingPieces | null;
  readonly steps: number;
  readonly snapshotSteps: readonly number[];
  readonly pushAfterStep: typeof TRIAL_PUSH_AFTER_STEP;
  readonly maxSteps: typeof TRIAL_MAX_STEPS;
}

export function validateTrialConfig(config: unknown): ValidatedTrialConfig {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new TrialRefusal('config', 'Trial config must be an object');
  const c = config as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!['engine', 'pieces', 'steps'].includes(key)) throw new TrialRefusal('config', `Unknown trial option: ${key}`);
  if (c.engine !== 'rapier' && c.engine !== 'avbd') throw new TrialRefusal('engine', 'engine must be "rapier" or "avbd"');
  const steps = c.steps === undefined ? TRIAL_DEFAULT_STEPS : c.steps;
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps <= TRIAL_PUSH_AFTER_STEP || steps > TRIAL_MAX_STEPS) {
    throw new TrialRefusal('steps', `steps must be an integer in ${TRIAL_PUSH_AFTER_STEP + 1}..${TRIAL_MAX_STEPS} (hard maximum ${TRIAL_MAX_STEPS})`);
  }
  let pieces: RingPieces | null = null;
  if (c.engine === 'avbd') {
    if (c.pieces !== undefined) throw new TrialRefusal('pieces', 'pieces applies to the Rapier engine only; AVBD uses one analytic field per ring');
  } else {
    const p = c.pieces === undefined ? 32 : c.pieces;
    if (p !== 16 && p !== 32 && p !== 64) throw new TrialRefusal('pieces', 'pieces must be 16, 32 or 64');
    pieces = p;
  }
  const snapshotSteps: number[] = [];
  for (let s = 0; s <= steps; s += TRIAL_SNAPSHOT_INTERVAL) snapshotSteps.push(s);
  if (snapshotSteps[snapshotSteps.length - 1] !== steps) snapshotSteps.push(steps);
  return Object.freeze({ engine: c.engine, pieces, steps, snapshotSteps: Object.freeze(snapshotSteps),
    pushAfterStep: TRIAL_PUSH_AFTER_STEP, maxSteps: TRIAL_MAX_STEPS });
}

const USAGE = 'Usage: interlocking-trial --engine rapier|avbd [--pieces 16|32|64 (rapier)] [--steps 121..720 (default 240)] [--json <new file>]';
export interface ParsedTrialArgs { config: TrialConfig; json?: string; help: boolean }

/** Strict CLI parsing. Unknown, duplicate, valueless or non-integer arguments are refused. */
export function parseTrialArgs(argv: readonly string[]): ParsedTrialArgs {
  const seen = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') { help = true; continue; }
    if (!['--engine', '--pieces', '--steps', '--json'].includes(flag)) throw new TrialRefusal('usage', `Unknown argument: ${flag}. ${USAGE}`);
    if (seen.has(flag)) throw new TrialRefusal('usage', `Duplicate ${flag}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new TrialRefusal('usage', `Missing value for ${flag}`);
    seen.set(flag, value);
  }
  const integer = (flag: string) => {
    const v = seen.get(flag);
    if (v === undefined) return undefined;
    if (!/^\d{1,6}$/.test(v)) throw new TrialRefusal('usage', `${flag} must be a non-negative integer`);
    return Number(v);
  };
  const config: TrialConfig = { engine: seen.get('--engine') as TrialEngineName };
  const pieces = integer('--pieces'), steps = integer('--steps');
  if (pieces !== undefined) config.pieces = pieces;
  if (steps !== undefined) config.steps = steps;
  if (!help) validateTrialConfig(config);
  return { config, json: seen.get('--json'), help };
}

// ---- adapter (GPU) assessment -------------------------------------------------------------------
export interface AdapterRecord {
  vendor: string; architecture: string; device: string; description: string;
  /** null when the binding does not report it; recorded, never guessed. */
  isFallbackAdapter: boolean | null;
}
export type AdapterAssessment = { ok: true; record: AdapterRecord } | { ok: false; reason: string; record: AdapterRecord | null };
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|lavapipe|warp|basic render/i;

/** Accept only an adapter positively identified as non-fallback, non-software hardware. A missing
 * identity or unreported-but-software-looking adapter is refused; there is no override. */
export function assessAdapter(info: unknown, legacyFallback?: unknown): AdapterAssessment {
  if (typeof info !== 'object' || info === null) return { ok: false, reason: 'adapter info unavailable: hardware cannot be identified', record: null };
  const i = info as Record<string, unknown>, text = (v: unknown) => typeof v === 'string' ? v : '';
  const fallback = typeof i.isFallbackAdapter === 'boolean' ? i.isFallbackAdapter : typeof legacyFallback === 'boolean' ? legacyFallback : null;
  const record: AdapterRecord = { vendor: text(i.vendor), architecture: text(i.architecture), device: text(i.device),
    description: text(i.description), isFallbackAdapter: fallback };
  if (fallback === true) return { ok: false, reason: 'fallback adapter refused', record };
  if (SOFTWARE.test([record.vendor, record.architecture, record.device, record.description].join(' '))) {
    return { ok: false, reason: 'software adapter refused (SwiftShader/llvmpipe/softpipe class)', record };
  }
  if (!record.vendor && !record.architecture && !record.device && !record.description) {
    return { ok: false, reason: 'adapter reports no identity: unknown hardware refused', record };
  }
  if (!/\b(apple|nvidia|amd|intel|qualcomm|adreno|mali|radeon|geforce|intelgpu)\b/i.test([record.vendor, record.architecture, record.device, record.description].join(' '))) {
    return { ok: false, reason: 'adapter identity is not recognized hardware: trial not run', record };
  }
  return { ok: true, record };
}

// ---- engine / clock / observer interfaces -------------------------------------------------------
export interface TrialEngineDescription {
  engine: TrialEngineName;
  version: string | null;
  representation: RingRepresentation;
  /** Engine-specific settings actually used (JSON-serializable). */
  settings: Record<string, unknown>;
  /** Mass the engine itself reports per ring, or null when it cannot be read back. */
  engineReportedMass: number[] | null;
  /** Engine-reported setup phases (inclusions of the measured setup wall, not additional). */
  setupMs: Record<string, number> | null;
  /** What step() covers for this engine. */
  stepSemantics: string;
  device: AdapterRecord | null;
  metadata?: unknown;
}
export interface PoseRead { poses: readonly StudyPose[]; /** The engine's own step number for these poses, when it reports one. */ step?: number }
export interface TrialEngine {
  description: TrialEngineDescription;
  step(): void;
  push(): void;
  /** Wait for submitted GPU work. Absent for CPU engines: the GPU wait is then not applicable. */
  completeGpu?(): Promise<void>;
  /** Throws if the engine/device has recorded an error (called at snapshots only). */
  check?(): void;
  readPoses(): PoseRead | Promise<PoseRead>;
  dispose(): void | Promise<void>;
}
export type TrialAcquire = (config: ValidatedTrialConfig) => Promise<TrialEngine>;
export interface TrialOptions {
  /** Monotonic milliseconds; default performance.now(). */
  clock?: () => number;
  observe?: (poses: readonly StudyPose[], representation: RingRepresentation) => InterlockingObservation;
  summarize?: typeof summarizeTrial;
  /** Opaque provenance/environment recorded verbatim in the report (no secrets or absolute paths). */
  source?: unknown;
  environment?: unknown;
}

// ---- report -------------------------------------------------------------------------------------
export interface PoseRecord { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }
export interface SnapshotRecord {
  step: number; phase: 'hanging' | 'after-push'; pushApplied: boolean;
  /** The engine's own step number for the poses, when reported. */
  engineStep: number | null;
  poses: PoseRecord[]; observation: InterlockingObservation;
  /** Hanging-phase criteria only; after the push the summary scores the push-safe subset. */
  verdict: InterlockingVerdict | null;
  timingMs: { gpuCompletionWait: number | null; readback: number; observer: number };
}
/** `step` is the number of steps completed when the failure occurred. */
export interface TrialError { phase: TrialPhase; step: number; message: string }
const stats = (raw: number[]) => raw.length ? { count: raw.length, totalMs: raw.reduce((a, b) => a + b, 0), minMs: Math.min(...raw), maxMs: Math.max(...raw), rawMs: raw }
  : { count: 0, totalMs: null, minMs: null, maxMs: null, rawMs: [] as number[] };

const LIMITS = [
  'Bounded diagnostic, not a benchmark: no speed ratio, winner, FPS, throughput or physical qualification is derived',
  'Timers are wall-clock readings of different things and overlap or include one another; none is summed and there is no total of them',
  'cpuStep: Rapier step() completes physics on the CPU; AVBD step() only encodes/submits GPU work, which finishes later on the queue',
  'gpuCompletionWait: wall span of waiting for the queue to drain at a snapshot (absent for CPU engines); it is NOT active GPU time and also absorbs time the CPU spent idle',
  'readback: wall of the awaited pose read (async GPU readback for AVBD, synchronous CPU read for Rapier)',
  'observer: CPU time of observeInterlocking + evaluateHanging at snapshots only, never every step or frame',
  'setup is the whole acquire() wall; engine-reported setupMs phases are included in it',
  'Rendering is not measured: no renderer, no GPU-resident BodyMesh comparison',
  'Observations are pose-only at sparse snapshots; qualification stays gated and unknown is not zero or a pass',
  'Compound (Rapier) representation bands are unproven: boundCertified false, pair/floor/thread verdicts unknown',
  'analyticCoreLinkResolved concerns the analytic centre circles only, not solid/compound-body topology',
  'This report is an observation record, not restorable state: no save/load of simulation state is provided',
];

export interface TrialReport {
  schema: typeof TRIAL_SCHEMA;
  status: 'completed' | 'failed';
  diagnostic: true; benchmark: false;
  source: unknown; environment: unknown;
  config: ValidatedTrialConfig;
  authored: { inputs: typeof INTERLOCKING; ringMass: ReturnType<typeof ringMassProperties>; criteria: typeof INTERLOCKING_QUALITY_CRITERIA };
  engine: TrialEngineDescription | null;
  steps: { requested: number; completed: number };
  snapshots: SnapshotRecord[];
  summaries: { hanging: ReturnType<typeof summarizeTrial>; afterPush: ReturnType<typeof summarizeTrial>;
    /** Definite analytic core-link change anywhere across the whole sequence (both phases). */
    sequenceLink: { linkChanged: boolean; resolvedCoreLinkObservations: number } } | null;
  qualification: 'gated';
  timing: {
    unit: 'ms'; clock: string;
    /** Whole acquire() wall: includes engine-reported setup phases and any lazy initialization. */
    setup: { acquireMs: number | null; engineReportedMs: Record<string, number> | null };
    /** Time inside engine.step() only; excludes the push, waits, reads and observer. */
    cpuStep: ReturnType<typeof stats>;
    pushMs: number | null;
    gpuCompletionWait: { available: boolean; totalMs: number | null; perSnapshotMs: (number | null)[] };
    readback: { totalMs: number | null; perSnapshotMs: number[] };
    observer: { totalMs: number | null; perSnapshotMs: number[] };
    /** From before acquire() to after the last snapshot/summary; includes all of the above plus loop overhead. Excludes dispose. */
    trialWallMs: number | null;
    disposeMs: number | null;
    notes: string;
  };
  rendering: { measured: false; value: null; reason: string };
  error: TrialError | null;
  cleanup: { disposed: boolean; error: string | null };
  limits: string[];
}

/** Report messages are single-line, bounded and free of obvious absolute machine paths. */
export function sanitizeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.split('\n')[0]
    .replace(/(?<![\w.])\/(?:Users|home|private|var|tmp|opt|Volumes|root)\/[^\s'"`)]*/g, '<path>')
    .replace(/[A-Za-z]:\\[^\s'"`)]*/g, '<path>')
    .slice(0, 500);
}
const poseRecord = (p: StudyPose): PoseRecord => ({ position: { x: p.position.x, y: p.position.y, z: p.position.z },
  rotation: { x: p.rotation.x, y: p.rotation.y, z: p.rotation.z, w: p.rotation.w } });

/** Run one bounded trial. Throws TrialRefusal for invalid input before calling acquire; every other
 * engine-work failure becomes a `failed` report (partial snapshots preserved). A throwing custom
 * clock can reject the call, but acquired-model disposal is still attempted in finally. */
export async function runInterlockingTrial(rawConfig: unknown, acquire: TrialAcquire, options: TrialOptions = {}): Promise<TrialReport> {
  const config = validateTrialConfig(rawConfig);
  const clock = options.clock ?? (() => performance.now());
  const observe = options.observe ?? observeInterlocking, summarize = options.summarize ?? summarizeTrial;
  const snapshotSteps = new Set(config.snapshotSteps);
  let phase: TrialPhase = 'setup', step = 0, completed = 0, pushApplied = false;
  let engine: TrialEngine | undefined, description: TrialEngineDescription | null = null;
  let error: TrialError | null = null, acquireMs: number | null = null, pushMs: number | null = null, trialWallMs: number | null = null;
  let summaries: TrialReport['summaries'] = null;
  const snapshots: SnapshotRecord[] = [], stepMs: number[] = [];
  const t0 = clock();
  const cleanup = { disposed: false, error: null as string | null };
  let disposeMs: number | null = null;
  const cleanupStamp = () => { try { return clock(); } catch { return null; } };

  async function snapshot(at: number) {
    const hanging = !pushApplied;
    let gpuWait: number | null = null;
    if (engine!.completeGpu) { phase = 'gpu-wait'; const t = clock(); await engine!.completeGpu(); gpuWait = clock() - t; }
    phase = 'check'; engine!.check?.();
    phase = 'read'; let t = clock();
    const read = await engine!.readPoses(), readbackMs = clock() - t;
    phase = 'check'; engine!.check?.();
    phase = 'read';
    if (read.step !== undefined && read.step !== at) throw new Error(`engine returned poses for step ${read.step}, expected ${at}`);
    phase = 'observer'; t = clock();
    const poses = read.poses.map(poseRecord), observation = observe(poses, description!.representation);
    const verdict = hanging ? evaluateHanging(observation) : null, observerMs = clock() - t;
    snapshots.push({ step: at, phase: hanging ? 'hanging' : 'after-push', pushApplied, engineStep: read.step ?? null, poses, observation, verdict,
      timingMs: { gpuCompletionWait: gpuWait, readback: readbackMs, observer: observerMs } });
  }

  try {
    let ta = clock();
    engine = await acquire(config);
    acquireMs = clock() - ta;
    description = engine.description;
    if (description.engine !== config.engine) throw new Error(`acquired engine ${description.engine} does not match requested ${config.engine}`);
    if (config.engine === 'avbd' && description.representation.kind !== 'analytic-sdf') throw new Error('acquired representation does not match AVBD analytic SDF');
    const wantedPieces = config.pieces;
    if (wantedPieces !== null && !(description.representation.kind === 'rapier-compound' && description.representation.pieces === wantedPieces)) {
      throw new Error('acquired representation does not match the requested piece count');
    }
    if (snapshotSteps.has(0)) { step = 0; await snapshot(0); }
    for (let i = 0; i < config.steps; i++) {
      step = i;
      if (i === config.pushAfterStep) { phase = 'push'; ta = clock(); engine.push(); pushMs = clock() - ta; pushApplied = true; }
      phase = 'step'; ta = clock(); engine.step(); stepMs.push(clock() - ta);
      completed = i + 1; step = completed;
      if (completed > config.maxSteps) throw new Error('hard step maximum exceeded');
      if (snapshotSteps.has(completed)) await snapshot(completed);
    }
    phase = 'summary';
    const obs = (from: number, to: number) => snapshots.filter(s => s.step >= from && s.step <= to).map(s => s.observation);
    const hanging = summarize(obs(0, config.pushAfterStep), 'hanging'), afterPush = summarize(obs(config.pushAfterStep + 1, config.steps), 'after-push');
    const whole = summarize(snapshots.map(s => s.observation), 'after-push');
    summaries = { hanging, afterPush, sequenceLink: { linkChanged: whole.linkChanged, resolvedCoreLinkObservations: whole.resolvedCoreLinkObservations } };
    trialWallMs = clock() - t0;
  } catch (e) {
    error = { phase, step, message: sanitizeMessage(e) };
    trialWallMs = clock() - t0;
  } finally {
    // Re-read: an engine may only know some facts (e.g. derived mass) after it has run. Never fatal.
    if (engine) try { description = engine.description; } catch { /* keep the description captured at setup */ }
    if (engine) {
      const td = cleanupStamp();
      try { await engine.dispose(); cleanup.disposed = true; } catch (e) { cleanup.error = sanitizeMessage(e); }
      const finished = cleanupStamp();
      disposeMs = td !== null && finished !== null ? finished - td : null;
      if (cleanup.error && !error) error = { phase: 'dispose', step: completed, message: cleanup.error };
    }
  }

  const sum = (v: (number | null)[]) => v.length ? v.reduce<number>((a, b) => a + (b ?? 0), 0) : null;
  const gpuAvailable = !!engine?.completeGpu, gpuWaits = snapshots.map(s => s.timingMs.gpuCompletionWait);
  return {
    schema: TRIAL_SCHEMA, status: error ? 'failed' : 'completed', diagnostic: true, benchmark: false,
    source: options.source ?? null, environment: options.environment ?? null, config,
    authored: { inputs: INTERLOCKING, ringMass: ringMassProperties(), criteria: INTERLOCKING_QUALITY_CRITERIA },
    engine: description, steps: { requested: config.steps, completed }, snapshots, summaries, qualification: 'gated',
    timing: {
      unit: 'ms', clock: options.clock ? 'injected monotonic clock' : 'performance.now (wall)',
      setup: { acquireMs, engineReportedMs: description?.setupMs ?? null },
      cpuStep: stats(stepMs), pushMs,
      gpuCompletionWait: { available: gpuAvailable, totalMs: gpuAvailable ? sum(gpuWaits) : null, perSnapshotMs: gpuWaits },
      readback: { totalMs: sum(snapshots.map(s => s.timingMs.readback)), perSnapshotMs: snapshots.map(s => s.timingMs.readback) },
      observer: { totalMs: sum(snapshots.map(s => s.timingMs.observer)), perSnapshotMs: snapshots.map(s => s.timingMs.observer) },
      trialWallMs, disposeMs,
      notes: 'Per-category totals only; they overlap/include one another and must not be added together or compared across engines as like-for-like.',
    },
    rendering: { measured: false, value: null, reason: 'Headless pose trial: no renderer, no GPU-resident BodyMesh comparison' },
    error, cleanup, limits: LIMITS,
  };
}

// ---- engine adapters over the existing models ---------------------------------------------------
export type RapierTrialModel = Awaited<ReturnType<typeof createRapierInterlocking>>;

/** Rapier: physics completes inside step(); poses are a synchronous CPU read. */
export function rapierTrialEngine(model: Pick<RapierTrialModel, 'pieces' | 'version' | 'step' | 'push' | 'poses' | 'dispose'> & { bodies: { mass(): number }[] }): TrialEngine {
  const { dt, iterations, friction, gravity } = INTERLOCKING;
  return {
    // A getter: Rapier derives body mass on its first step, so mass read earlier is 0 (unknown), never reported as measured.
    get description(): TrialEngineDescription {
      const mass = model.bodies.map(b => b.mass());
      return {
        engine: 'rapier', version: model.version, representation: { kind: 'rapier-compound', pieces: model.pieces },
        settings: { dt, solverIterations: iterations, friction, gravity: [...gravity], restitution: 0, sleeping: false, ccd: false,
          convexSectorsPerRing: model.pieces, zeroDensityColliders: true },
        engineReportedMass: mass.every(m => m > 0) ? mass : null, setupMs: null, device: null,
        stepSemantics: 'step() runs Rapier to completion on the CPU (WASM)',
      };
    },
    step: () => model.step(), push: () => model.push(),
    readPoses: () => ({ poses: model.poses() }),
    dispose: () => model.dispose(),
  };
}

export async function createRapierTrialEngine(pieces: RingPieces): Promise<TrialEngine> {
  const { createRapierInterlocking } = await import('./interlocking-rapier.ts');
  const model = await createRapierInterlocking(pieces);
  try { return rapierTrialEngine(model); } catch (e) { model.dispose(); throw e; }
}

export interface AvbdTrialHooks {
  /** Resolves when the device queue has completed all submitted work (queue.onSubmittedWorkDone). */
  completeGpu: () => Promise<void>;
  /** Throws on a recorded uncaptured GPU error or device loss. */
  check?: () => void;
  adapter: AdapterRecord;
}
/** AVBD: step() encodes/submits; the caller owns the device, so dispose destroys only the World. */
export function avbdTrialEngine(model: { metadata: object; step(): void; push(): void; dispose(): void; readPoses(): Promise<{ step: number; poses: AvbdPose[] }> },
  hooks: AvbdTrialHooks): TrialEngine {
  const metadata = JSON.parse(JSON.stringify(model.metadata)) as { setupMs?: Record<string, number> };
  const { dt, iterations, friction, gravity } = INTERLOCKING;
  return {
    description: {
      engine: 'avbd', version: null, representation: { kind: 'analytic-sdf' },
      settings: { dt, iterations, friction, gravity: [...gravity], massOverride: 'authored analytic mass/moments (not read back)' },
      engineReportedMass: null, setupMs: metadata.setupMs ?? null, device: hooks.adapter, metadata,
      stepSemantics: 'step() records and submits GPU commands; solver work completes asynchronously on the device queue',
    },
    step: () => model.step(), push: () => model.push(),
    completeGpu: hooks.completeGpu, check: hooks.check,
    readPoses: () => model.readPoses(),
    dispose: () => model.dispose(),
  };
}

export async function createAvbdTrialEngine(device: GPUDevice, hooks: AvbdTrialHooks): Promise<TrialEngine> {
  const { createAvbdInterlocking } = await import('./interlocking-avbd.ts');
  const model = await createAvbdInterlocking({ device });
  try { return avbdTrialEngine(model, hooks); } catch (e) { model.dispose(); throw e; }
}
