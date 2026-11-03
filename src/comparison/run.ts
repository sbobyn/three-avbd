import { physicalQuality } from './physical-quality.ts';
import { contactQuality } from './contact-quality.ts';
import { dumpMovers, MoverTracker, type MoverDump } from './movers.ts';
import { FINAL_WINDOW, finalWindow, REST_SPEED, restFraction, SETTLED_MAX_SPEED, type FinalWindow, type WindowSample } from './final-window.ts';
// Timings wait for completed batches. An independent replay checks EVERY step outside the
// timer, then must reproduce the timed final snapshot exactly before a result is accepted.
import { createAdapter, initializeRapier, type Adapter, type Engine, type Settings } from './adapters.ts';
import { jitterScene, makeScene, SCENE_VALIDITY, sceneHash, type CaseName, type Scene } from './scenes.ts';
import { FLOOR_TARGET, percentile, quality, passesFloorTarget, type Quality, STATE_SIZE } from './quality.ts';

export interface Options extends Settings {
  lead: number; steps: number; repeats: number; timeoutMs: number; batchSize: number; impactPhase: number;
  /** Seeded horizontal position jitter (m) applied to every dynamic body; 0 is none. */
  jitter: number; jitterSeed: number;
  /** Steps at the end of the measured window used by the final-window (resting) metrics. */
  finalWindow: number;
  /** Diagnostic: report the N fastest bodies and N deepest pairs of the final window (0: off). */
  dumpMovers: number;
}
export const DEFAULTS: Options = { dt: 1 / 60, avbdIterations: 4, rapierIterations: 4,
  rapierPgsIterations: 1, rapierSleeping: false, rapierCcd: false, rapierCcdSubsteps: 1, avbdMargin: 0.01, lead: 60, steps: 120, repeats: 3,
  timeoutMs: 300_000, batchSize: 10, impactPhase: 0, jitter: 0, jitterSeed: 1,
  finalWindow: FINAL_WINDOW, dumpMovers: 0 };
export function validateOptions(o: Options): void {
  for (const k of ['lead', 'steps', 'repeats', 'avbdIterations', 'rapierIterations', 'rapierPgsIterations', 'rapierCcdSubsteps', 'batchSize', 'finalWindow'] as const) {
    if (!Number.isInteger(o[k]) || o[k] < (k === 'lead' ? 0 : 1)) throw new Error(`Invalid ${k}`);
  }
  if (!Number.isInteger(o.dumpMovers) || o.dumpMovers < 0) throw new Error('Invalid dumpMovers');
  if (!Number.isFinite(o.jitter) || o.jitter < 0 || !Number.isInteger(o.jitterSeed)) throw new Error('Invalid jitter');
  if (!Number.isFinite(o.avbdMargin) || o.avbdMargin < 0) throw new Error('Invalid avbdMargin');
  if (!Number.isFinite(o.impactPhase) || o.impactPhase < 0 || o.impactPhase >= 1) throw new Error('Invalid impactPhase');
  if (!Number.isFinite(o.dt) || o.dt <= 0 || !Number.isFinite(o.timeoutMs) || o.timeoutMs <= 0) throw new Error('Invalid dt or timeout');
}
export interface Result {
  scene: string; hash: string; engine: Engine; repeat: number; bodies: number; dynamicBodies: number;
  status: 'completed' | 'failed' | 'timeout'; error?: string; settings?: object; buildMs: number;
  completedSteps: number; samplesMs: number[]; sampleSteps: number[];
  meanMs?: number; medianMs?: number; p95Ms?: number; p99Ms?: number;
  physical?: { final: ReturnType<typeof physicalQuality>; maxJointError: number; maxTrajectoryError: number | null; maxVelocityError: number | null; maxAngularError: number | null };
  endpointStates?: { initial: number[]; final: number[] };
  diagnostics?: object; initialContacts?: ReturnType<typeof contactQuality>; initialQuality?: Quality; finalQuality?: Quality;
  qualitySamples: { step: number; quality: Quality; contacts: ReturnType<typeof contactQuality> }[];
  measuredMaxRelativeDrift?: number; measuredContactTargetMet?: boolean; restingTargetMet?: boolean;
  contactTargetMet?: boolean; maxRelativeContactDepth?: number; maxContactDepth?: number;
  worstQuality?: Quality; floorTargetMet?: boolean; replayMatches?: boolean;
  /** Resting metrics over the last `finalWindow` measured steps; the worst-over-window fields above are unchanged. */
  finalWindow?: FinalWindow;
  /** With `dumpMovers`: the final window's fastest bodies and deepest pairs. */
  movers?: MoverDump;
}
const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Componentwise maxima; worstBody belongs to the largest absolute floor penetration. */
function accumulate(worst: Quality | undefined, q: Quality): Quality {
  if (!worst) return { ...q };
  const result = { ...q };
  for (const key of Object.keys(q) as (keyof Quality)[]) {
    if (key !== 'worstBody') result[key] = Math.max(worst[key]!, q[key]!);
  }
  result.worstBody = q.maxFloorPenetration > worst.maxFloorPenetration ? q.worstBody : worst.worstBody;
  return result;
}

export async function runOne(engine: Engine, scene: Scene, repeat: number, o: Options, device: GPUDevice,
  guard: () => void = () => {}, factory: typeof createAdapter = createAdapter): Promise<Result> {
  validateOptions(o);
  const r: Result = { scene: scene.name, hash: sceneHash(scene), engine, repeat, bodies: scene.bodies.length,
    dynamicBodies: scene.bodies.filter((b) => b.mass > 0).length, status: 'failed', buildMs: 0,
    completedSteps: 0, samplesMs: [], sampleSteps: [], qualitySamples: [] };
  let adapter: Adapter | undefined;
  const started = performance.now();
  const check = () => {
    guard();
    if (performance.now() - started > o.timeoutMs) { r.status = 'timeout'; throw new Error('Case timeout (including validation replay)'); }
  };
  try {
    adapter = await factory(engine, scene, o, device);
    await adapter.complete();
    check();
    r.buildMs = performance.now() - started;
    r.settings = adapter.settings;
    const initial = await adapter.snapshot();
    r.initialQuality = quality(scene, initial);
    r.initialContacts = contactQuality(scene, initial);
    // Never let a batch straddle the lead-in/timed boundary. A short final batch retains its weight.
    for (const [count, measured] of [[o.lead, false], [o.steps, true]] as const) {
      for (let done = 0; done < count;) {
        check();
        const n = Math.min(o.batchSize, count - done);
        const t = performance.now();
        for (let i = 0; i < n; i++) adapter.step();
        await adapter.complete();
        const elapsed = performance.now() - t;
        check();
        done += n;
        r.completedSteps += n;
        if (measured) { r.samplesMs.push(elapsed / n); r.sampleSteps.push(n); }
        await yieldToUI();
      }
    }
    const timedFinal = await adapter.snapshot();
    r.finalQuality = quality(scene, timedFinal);
    if (scene.name.startsWith('impact-')) r.endpointStates = { initial: Array.from(initial), final: Array.from(timedFinal) };
    adapter.destroy();
    adapter = undefined;
    check();
    adapter = await factory(engine, scene, o, device);
    await adapter.complete();
    let baseline = o.lead === 0 ? await adapter.snapshot() : undefined;
    r.measuredMaxRelativeDrift = 0;
    const windowSamples: WindowSample[] = [];
    const windowStart = o.lead + Math.max(0, o.steps - o.finalWindow);
    const tracker = o.dumpMovers ? new MoverTracker(scene, SETTLED_MAX_SPEED) : undefined;
    // Replay both lead-in and measurement windows, catching transient storage faults and NaNs.
    for (let step = 1; step <= o.lead + o.steps; step++) {
      check();
      adapter.step();
      await adapter.complete();
      r.diagnostics = await adapter.inspect();
      const snapshot = await adapter.snapshot();
      const physics = physicalQuality(scene, initial, snapshot, step * o.dt);
      const maximum = (a: number | null | undefined, b: number | null) => b === null ? null : Math.max(a ?? 0, b);
      r.physical = { final: physics, maxJointError: Math.max(r.physical?.maxJointError ?? 0, physics.maxJointError),
        maxTrajectoryError: maximum(r.physical?.maxTrajectoryError, physics.trajectoryError),
        maxVelocityError: maximum(r.physical?.maxVelocityError, physics.velocityError),
        maxAngularError: maximum(r.physical?.maxAngularError, physics.angularError) };
      const q = quality(scene, snapshot);
      const contacts = contactQuality(scene, snapshot);
      if (step === o.lead) baseline = snapshot;
      if (step > o.lead && baseline) {
        for (let i = 0; i < scene.bodies.length; i++) {
          const body = scene.bodies[i];
          if (!body.mass) continue;
          const offset = i * STATE_SIZE;
          const drift = Math.hypot(...[0, 1, 2].map(k => snapshot[offset + k] - baseline![offset + k]));
          r.measuredMaxRelativeDrift = Math.max(r.measuredMaxRelativeDrift, drift / Math.min(...body.size));
        }
      }
      r.worstQuality = accumulate(r.worstQuality, q);
      r.qualitySamples.push({ step, quality: q, contacts });
      if (step > windowStart) {
        windowSamples.push({ step, quality: q, contacts, restFraction: restFraction(scene, snapshot) });
        tracker?.add(step, snapshot);
        if (tracker && step === o.lead + o.steps) r.movers = dumpMovers(scene, tracker, snapshot, step, o.dumpMovers);
      }
      if (q.nonFiniteBodies || q.invalidRotations) throw new Error(`Invalid body state at replay step ${step}`);
      if (step % 10 === 0) await yieldToUI();
    }
    const replayFinal = await adapter.snapshot();
    check();
    r.replayMatches = replayFinal.length === timedFinal.length && replayFinal.every((v, i) => Object.is(v, timedFinal[i]));
    if (!r.replayMatches) throw new Error('Validation replay did not reproduce the timed final state');
    r.floorTargetMet = passesFloorTarget(r.worstQuality!);
    r.finalWindow = finalWindow(windowSamples, o.finalWindow);
    if (r.qualitySamples.every(s => s.contacts !== null)) {
      r.maxContactDepth = r.qualitySamples.reduce((max, s) => Math.max(max, s.contacts!.maxDepth), 0);
      r.maxRelativeContactDepth = r.qualitySamples.reduce((max, s) => Math.max(max, s.contacts!.maxRelativeDepth), 0);
      r.contactTargetMet = r.floorTargetMet && r.maxRelativeContactDepth <= FLOOR_TARGET;
      r.measuredContactTargetMet = r.qualitySamples.filter(s => s.step > o.lead)
        .every(s => passesFloorTarget(s.quality) && s.contacts!.maxRelativeDepth <= FLOOR_TARGET);
      if ((scene.name === 'rest-stack' || scene.name.startsWith('rest-grid-')) && o.steps * o.dt >= 10) {
        r.restingTargetMet = r.measuredContactTargetMet && r.measuredMaxRelativeDrift <= FLOOR_TARGET;
      }
    }
    r.meanMs = r.samplesMs.reduce((sum, ms, i) => sum + ms * r.sampleSteps[i], 0) / o.steps;
    r.medianMs = percentile(r.samplesMs, 0.5);
    r.p95Ms = percentile(r.samplesMs, 0.95);
    r.p99Ms = percentile(r.samplesMs, 0.99);
    r.status = 'completed';
  } catch (error) {
    if (r.status !== 'timeout') r.status = 'failed';
    r.error = error instanceof Error ? error.message : String(error);
  } finally { adapter?.destroy(); }
  return r;
}

export async function runComparison(device: GPUDevice, cases: string[], options: Options,
  log: (s: string) => void = () => {}, guard: () => void = () => {}, engines: Engine[] = ['rapier', 'avbd']) {
  validateOptions(options);
  if (!cases.length) throw new Error('Select at least one case');
  if (!engines.length || engines.some((e) => e !== 'rapier' && e !== 'avbd') || new Set(engines).size !== engines.length) {
    throw new Error('Choose unique engines: rapier,avbd');
  }
  const rapierVersion = await initializeRapier();
  const warmScene = makeScene('pile-100');
  for (const engine of engines) {
    log(`Warming ${engine}`);
    const warm = await runOne(engine, warmScene, -1, { ...options, lead: 0, steps: 20 }, device, guard);
    if (warm.status !== 'completed') throw new Error(`Warmup ${engine}: ${warm.error ?? warm.status}`);
  }
  const results: Result[] = [];
  const manifests = [];
  for (const name of cases) {
    const scene = jitterScene(makeScene(name, name.startsWith('impact-') ? 30 * options.dt * options.impactPhase : 0),
      options.jitter, options.jitterSeed);
    manifests.push({ ...scene, hash: sceneHash(scene), validity: SCENE_VALIDITY[name as CaseName] ?? null });
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const order = repeat % 2 ? [...engines].reverse() : engines;
      for (const engine of order) {
        log(`${name} · ${engine} · repeat ${repeat + 1}/${options.repeats} (timing + validation replay)`);
        const result = await runOne(engine, scene, repeat, options, device, guard);
        results.push(result);
        log(`${engine}: ${result.status}, mean ${result.meanMs?.toFixed(3) ?? '—'} ms/step, floor target ${result.floorTargetMet ?? 'unverified'}`);
      }
    }
  }
  return { schema: 5, date: new Date().toISOString(), rapierVersion, options, engines, manifests, results,
    timing: 'Completed batches; samples are batch wall time / steps, quantiles are batch-average quantiles, mean is step-weighted; no rendering',
    quality: { floorTarget: FLOOR_TARGET, normalization: 'smallest full body dimension (sphere diameter)',
      scope: 'Floor every step; independent swept candidates and exact box/sphere overlap; contact target requires both ≤1%',
      resting: 'rest-stack/rest-grid only: at least 10 measured seconds, floor and pair depth ≤1%, center drift from lead-in endpoint ≤1%; not overall accuracy',
      finalWindow: `Last options.finalWindow measured steps only (worst-over-window fields unchanged): max and p95 over those steps of each step's worst floor and pair depth; max speed and kinetic energy; fraction of bodies below ${REST_SPEED} m/s on the last step; settled = contact target on every window step and max speed ≤ ${SETTLED_MAX_SPEED} m/s`,
      replay: 'Per-step counter/state validation; timed final snapshot must match replay exactly' },
    limitations: ['No SIMD variant comparison yet', 'Dense diagnostic candidate searches can be quadratic; analytic trajectories cover only named diagnostic cases',
      'Timeout checked between batches/steps; cannot interrupt a blocked synchronous step or diagnostic',
      'No portable peak-memory measurement; capacities recorded', 'Pipelined batch averages are not frame latency'] };
}

export async function comparisonDevice(): Promise<GPUDevice> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('WebGPU adapter unavailable');
  return adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize } });
}
