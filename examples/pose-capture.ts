// Headless pose capture: step a small authored World on this machine's GPU (Node + Dawn, no browser, no rendering),
// read every body's pose after each step, and write one JSON pose track for examples/pose-playback.html.
//
//   node --experimental-transform-types --no-warnings examples/pose-capture.ts --out <new file>.json [--bodies 12] [--steps 120]
//
// Public API only (World from src/lib). Needs a real hardware adapter: fallback, software and unidentified adapters are
// refused, with no override. The track is transforms only: no velocities, events or editable world state, so it cannot
// restore a World, and nothing here claims a repeatable or identical replay. Timings are one run's wall-clock
// observations, not GPU time and not a performance comparison.
// Exit codes: 0 done (or --help) · 1 failed (nothing written) · 2 usage/input refusal (before any GPU work) · 3 GPU refusal/unavailable.
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAdapter, sanitizeMessage, type AdapterRecord } from '../src/comparison/interlocking-trial.ts';
import { gitProvenance } from '../scripts/git-provenance.ts';
import { checkTrackBytes, f32Short, parsePoseTrack, POSE_TRACK_SCHEMA, POSE_TRACK_UNITS, serializeWithOutputBytes, TRACK_LIMITS } from './pose-track.ts';

export const CAPTURE_DEFAULTS = { bodies: 12, steps: 120 } as const;
/** Fixed for every capture and written into the track. */
export const CAPTURE_WORLD = { dt: 1 / 60, iterations: 10, gravity: [0, -9.81, 0] } as const;
export const USAGE = 'Usage: pose-capture --out <new file>.json [--bodies 1..63 (dynamic, default 12; a fixed floor is added)] [--steps 1..300 (default 120)]';

export class CaptureRefusal extends Error {
  readonly code: 'input' | 'gpu';
  constructor(code: 'input' | 'gpu', message: string) { super(message); this.name = 'CaptureRefusal'; this.code = code; }
}

export interface CaptureConfig { out: string; bodies: number; steps: number }

/** Strict parse: unknown or repeated flags, missing values and anything but plain decimal integers in range are refused. */
export function parseCaptureArgs(argv: readonly string[]): { help: true } | { help: false; config: CaptureConfig } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (flag !== '--out' && flag !== '--bodies' && flag !== '--steps') throw new CaptureRefusal('input', `Unknown option "${String(flag).slice(0, 40)}". ${USAGE}`);
    if (value === undefined || value.startsWith('--')) throw new CaptureRefusal('input', `${flag} needs a value. ${USAGE}`);
    if (values.has(flag)) throw new CaptureRefusal('input', `${flag} given twice`);
    values.set(flag, value);
  }
  const out = values.get('--out');
  if (out === undefined) throw new CaptureRefusal('input', `--out is required: the track is never printed or written anywhere by default. ${USAGE}`);
  if (out === '' || extname(out).toLowerCase() !== '.json') throw new CaptureRefusal('input', '--out must be a path ending in .json');
  const integer = (flag: string, fallback: number, min: number, max: number) => {
    const raw = values.get(flag);
    if (raw === undefined) return fallback;
    const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new CaptureRefusal('input', `${flag} must be a whole number from ${min} to ${max}`);
    return n;
  };
  return { help: false, config: {
    out, bodies: integer('--bodies', CAPTURE_DEFAULTS.bodies, 1, TRACK_LIMITS.maxBodies - 1), steps: integer('--steps', CAPTURE_DEFAULTS.steps, 1, TRACK_LIMITS.maxSteps) } };
}

/** The output target must be a new file in an existing directory. Nothing is created or opened here; the write itself uses `wx` as well. */
export function checkOutputTarget(out: string): void {
  let existing = false;
  try { lstatSync(out); existing = true; } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw new CaptureRefusal('input', '--out cannot be inspected'); }
  if (existing) throw new CaptureRefusal('input', '--out target already exists; tracks never overwrite files');
  try { if (!statSync(dirname(out)).isDirectory()) throw new Error('not a directory'); } catch { throw new CaptureRefusal('input', "--out's directory does not exist"); }
}

// ---- the authored scene -------------------------------------------------------------------------

export interface SceneBody { shape: 'box' | 'sphere'; size: [number, number, number]; position: [number, number, number]; rotation: [number, number, number, number]; fixed: boolean }

/** A fixed floor and `dynamic` boxes and spheres dropped from a staggered grid. Small and fixed on purpose: not a scene editor. */
export function authoredScene(dynamic: number): SceneBody[] {
  const bodies: SceneBody[] = [{ shape: 'box', size: [24, 1, 24], position: [0, -0.5, 0], rotation: [0, 0, 0, 1], fixed: true }];
  for (let k = 0; k < dynamic; k++) {
    const col = k % 4, row = Math.floor(k / 4), position: SceneBody['position'] = [(col - 1.5) * 1.6, 1 + row * 1.5 + col * 0.15, (row % 2 ? 0.4 : -0.4) + (col % 2 ? 0.2 : 0)];
    if (k % 2 === 0) {
      const turn = 0.3 * k;
      bodies.push({ shape: 'box', size: [1, 0.8 + 0.1 * (k % 3), 1], position, rotation: [0, Math.sin(turn / 2), 0, Math.cos(turn / 2)], fixed: false });
    } else bodies.push({ shape: 'sphere', size: [1, 1, 1], position, rotation: [0, 0, 0, 1], fixed: false });
  }
  return bodies;
}

// ---- capture ------------------------------------------------------------------------------------

export interface CaptureResult {
  /** One read at step 0 and one after each of `steps` steps. */
  frames: { step: number; poses: number[][] }[];
  bodies: { id: number; shape: 'box' | 'sphere'; size: [number, number, number]; fixed: boolean }[];
  captureWallMs: number;
  readbackWallMs: number;
}

/**
 * Build the World on a device the caller owns and capture. The World is destroyed here, on success and on failure; the
 * device is never touched. Every frame's `step` is the one `world.read()` reported, and a read that does not land on the expected
 * step is a failure, not a recorded frame.
 */
export async function captureOnDevice(device: GPUDevice, config: CaptureConfig): Promise<CaptureResult> {
  const { World } = await import('../src/lib/index.ts');
  const scene = authoredScene(config.bodies);
  const world = await World.create({ device, maxBodies: scene.length, dt: CAPTURE_WORLD.dt, iterations: CAPTURE_WORLD.iterations, gravity: [...CAPTURE_WORLD.gravity] });
  try {
    const handles = scene.map((s, i) => {
      const options = { position: s.position, rotation: s.rotation, fixed: s.fixed };
      const body = s.shape === 'box' ? world.addBox({ ...options, size: s.size }) : world.addSphere({ ...options, radius: s.size[0] / 2 });
      if (!body) throw new Error(`World refused body ${i}: full`);
      return body;
    });
    const bodies = handles.map(b => ({ id: b.id, shape: b.shape as 'box' | 'sphere', size: [...b.size] as [number, number, number], fixed: b.fixed }));
    const frames: CaptureResult['frames'] = [];
    let readbackWallMs = 0;
    const record = async (expected: number) => {
      const t = performance.now();
      const read = await world.read();
      readbackWallMs += performance.now() - t;
      if (read.step !== expected) throw new Error(`world.read() landed on step ${read.step}, expected ${expected}`);
      frames.push({ step: read.step, poses: handles.map(b => [...b.position, ...b.rotation].map(f32Short)) });
    };
    const started = performance.now();
    await record(0);
    for (let step = 1; step <= config.steps; step++) { world.step(); await record(step); }
    const captureWallMs = performance.now() - started;
    return { frames, bodies, captureWallMs, readbackWallMs };
  } finally { world.destroy(); }
}

const round1 = (v: number) => Math.round(v * 10) / 10;

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Dawn's native runner can keep Node alive after release
  const exit = (code: number): never => process.exit(code);
  let parsed: ReturnType<typeof parseCaptureArgs>;
  try { parsed = parseCaptureArgs(process.argv.slice(2)); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof CaptureRefusal ? 2 : 1); }
  if (parsed.help) { console.log(USAGE); return exit(0); }
  const { config } = parsed;
  try { checkOutputTarget(config.out); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof CaptureRefusal ? 2 : 1); }
  // Everything above refuses before a GPU is requested. From here on nothing is written unless the capture and cleanup succeeded.

  // Dawn instance/adapter/device stay reachable through cleanup (see tests-gpu/device.ts): a collected instance leaves pending native callbacks polling freed memory.
  const keep: unknown[] = [];
  (globalThis as { __poseCaptureDawn?: unknown }).__poseCaptureDawn = keep;
  const gpuErrors: string[] = [];
  let device: GPUDevice | undefined, code = 0, run: CaptureResult | undefined, record: AdapterRecord | undefined, limits: Record<string, number> | undefined;
  try {
    const { create, globals } = await import('webgpu').catch(() => { throw new CaptureRefusal('gpu', 'The webgpu (Dawn) package could not be loaded: nothing captured'); });
    Object.assign(globalThis, globals);
    const gpu = create([]); keep.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new CaptureRefusal('gpu', 'No WebGPU adapter available: nothing captured');
    keep.push(adapter);
    // assessAdapter reads vendor/architecture/device/description by name: GPUAdapterInfo accessors are not enumerable
    const assessment = assessAdapter((adapter as { info?: unknown }).info, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
    if (!assessment.ok) throw new CaptureRefusal('gpu', `${assessment.reason}: nothing captured`);
    record = assessment.record;
    // No optional feature is required; storage limits are raised to the adapter's own, as in tests-gpu/device.ts.
    limits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage };
    device = await adapter.requestDevice({ requiredLimits: limits });
    keep.push(device);
    const d = device;
    d.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
    void d.lost.then(info => { if (info.reason !== 'destroyed') gpuErrors.push(`Device lost: ${info.message}`); });
    run = await captureOnDevice(d, config);
    await d.queue.onSubmittedWorkDone();
  } catch (e) {
    console.error(sanitizeMessage(e));
    code = e instanceof CaptureRefusal ? (e.code === 'gpu' ? 3 : 2) : 1;
    run = undefined;
  } finally {
    // captureOnDevice destroyed the World; the device is this script's own
    try { device?.destroy(); } catch (e) { console.error(`Device cleanup failed: ${sanitizeMessage(e)}`); code ||= 1; }
  }
  if (code === 0 && gpuErrors.length) { console.error(`Uncaptured GPU errors: ${gpuErrors.map(m => sanitizeMessage(m)).join(' | ')}`); code = 1; }
  if (code === 0 && run && record && limits) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; devDependencies: Record<string, string> };
      const { text, bytes } = serializeWithOutputBytes({
        schema: POSE_TRACK_SCHEMA,
        scope: 'Rigid-body transforms read from a headless World: no velocities, events or editable world state; not a World snapshot and not a replay. Example-local, provisional.',
        units: POSE_TRACK_UNITS, dt: CAPTURE_WORLD.dt, bodies: run.bodies, frames: run.frames,
        capture: {
          tool: 'examples/pose-capture.ts',
          source: { package: { name: pkg.name, version: pkg.version }, git: gitProvenance(root) },
          environment: { runtime: process.version, platform: platform(), arch: arch(), backend: 'Node + Dawn (webgpu binding); no browser, no rendering', webgpu: pkg.devDependencies.webgpu ?? null },
          device: record, requiredFeatures: [], requiredLimits: limits,
          config: { dynamicBodies: config.bodies, trackedBodies: run.bodies.length, steps: config.steps, everyStep: true, dt: CAPTURE_WORLD.dt, iterations: CAPTURE_WORLD.iterations, gravity: [...CAPTURE_WORLD.gravity] },
          frameCount: run.frames.length,
          timing: { unit: 'ms', clock: 'performance.now (wall)', captureWallMs: round1(run.captureWallMs), readbackWallMs: round1(run.readbackWallMs),
            scope: 'One run on one machine. captureWallMs covers every step() call and every awaited read(); readbackWallMs is the time spent awaiting read(), which includes the GPU finishing that step. Not GPU time, not a performance comparison, not a first-load measurement.' },
          uncapturedGpuErrors: [],
        },
      });
      // The file must pass the same validator the player uses before it is written
      checkTrackBytes(bytes); parsePoseTrack(text);
      writeFileSync(config.out, text, { flag: 'wx' });
      console.log(`Wrote ${run.frames.length} frames of ${run.bodies.length} bodies (${bytes} bytes) to the --out file. Capture ${round1(run.captureWallMs)} ms wall, of which ${round1(run.readbackWallMs)} ms awaiting reads (one run; not GPU time or a benchmark).`);
    } catch (e) { console.error(`Not written: ${sanitizeMessage(e)}`); code = 1; }
  }
  return exit(code);
}

// Importable for tests; runs only when this file is the entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
