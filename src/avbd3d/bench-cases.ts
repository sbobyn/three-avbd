// The 3D GPU benchmark suite and its measurement, shared by the headless script
// (scripts/bench3d-gpu.ts, Dawn) and the in-browser page (bench3d.html) that runs it on the
// target hardware (M1, GTX 1080). Scenes in motion are timed in a short window right after a
// fixed lead-in, so every machine times the same stretch of the simulation.

import { compare } from '../avbd2d/gpu/timing.ts';
import { boxColumns, boxPile, brickGables, brickRing, chainMail, jointedDrop, wallSmash } from './bench-scenes.ts';
import { GpuSolver3D, PHASES, type StepProfile } from './gpu/solver.ts';
import { Joint } from './ref/forces.ts';
import { Solver } from './ref/solver.ts';

/**
 * small: runs anywhere, quick. paper: the paper's 110k brick ring (Fig. 1) and a stand-in for
 * its jointed scene (Fig. 14). large: its 510k field of brick walls (Fig. 3).
 * steady: settled scenes the development notes track (docs/FINDINGS.md).
 */
export type Tier = 'small' | 'paper' | 'large' | 'steady';

export interface BenchCase {
  name: string;
  tier: Tier;
  iterations: number;
  build: (solver: Solver) => void;
  /** Steps before timing starts (capacities and the colour cap adapt meanwhile). */
  lead: number;
  /** The paper's reported time for this scene on an RTX 4090, if it has one. */
  paper?: string;
}

export const BENCH_CASES: BenchCase[] = [
  { name: 'Wall smash 2k', tier: 'small', iterations: 10, build: (s) => wallSmash(s), lead: 30 },
  { name: 'Chain mail 1.6k', tier: 'small', iterations: 10, build: (s) => chainMail(s), lead: 60 },
  { name: 'Brick ring 9k', tier: 'small', iterations: 4, build: (s) => brickRing(s, 12, 20, 2, 10), lead: 60 },
  { name: 'Brick gables 6.7k', tier: 'small', iterations: 3, build: (s) => brickGables(s, 4, 8, 20), lead: 60 },
  { name: 'Jointed drop 6k', tier: 'small', iterations: 10, build: (s) => jointedDrop(s, 5, 4, 32), lead: 60 },
  { name: 'Brick ring 110k', tier: 'paper', iterations: 4, build: (s) => brickRing(s), lead: 60, paper: '9.8 ms (3.5 solve)' },
  {
    name: 'Jointed drop 34k (71k joints)',
    tier: 'paper',
    iterations: 10,
    build: (s) => jointedDrop(s),
    lead: 60,
    paper: '16 ms (35k bodies, 72k joints, onto cloth)',
  },
  // Table 1 lists 3 iterations for this scene, the Fig. 3 caption 4
  { name: 'Brick gables 506k', tier: 'large', iterations: 3, build: (s) => brickGables(s), lead: 60, paper: '17.6 ms (10.3 solve)' },
  { name: 'Settled pile 32k', tier: 'steady', iterations: 4, build: (s) => boxPile(s, 40, 20), lead: 180 },
  { name: 'Box columns 100k', tier: 'steady', iterations: 4, build: (s) => boxColumns(s, 100, 10), lead: 180 },
];

export interface BenchResult {
  scene: string;
  iterations: number;
  bodies: number;
  joints: number;
  contacts: number;
  colors: number;
  clashes: number;
  overflow: number;
  /** Wall time per step with the queue kept busy: what a frame costs. */
  wallMs: number;
  /** Median GPU time per phase over isolated steps (timestamp queries), if supported. */
  gpu: StepProfile | null;
  buildMs: number;
  /** Peak bytes of GPU buffers the solver held. */
  gpuBytes: number;
  paper?: string;
  error?: string;
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/** Build a case, run its lead-in, then time it: wall time per step and GPU time per phase. */
export async function measureCase(device: GPUDevice, c: BenchCase, log: (text: string) => void = () => {}): Promise<BenchResult> {
  log(`${c.name}: building…`);
  await yieldToEventLoop();
  const t0 = performance.now();
  const ref = new Solver();
  c.build(ref);
  ref.iterations = c.iterations;
  const result: BenchResult = {
    scene: c.name,
    iterations: c.iterations,
    bodies: ref.bodies.length,
    joints: ref.forces.filter((f) => f instanceof Joint).length,
    contacts: 0,
    colors: 0,
    clashes: 0,
    overflow: 0,
    wallMs: NaN,
    gpu: null,
    buildMs: 0,
    gpuBytes: 0,
    paper: c.paper,
  };
  // Count the solver's buffer bytes: wrap createBuffer for the duration of the case
  const createBuffer = device.createBuffer;
  let live = 0;
  device.createBuffer = (descriptor: GPUBufferDescriptor) => {
    const buffer = createBuffer.call(device, descriptor);
    live += descriptor.size;
    result.gpuBytes = Math.max(result.gpuBytes, live);
    const destroy = buffer.destroy;
    let destroyed = false;
    buffer.destroy = () => {
      if (!destroyed) live -= descriptor.size;
      destroyed = true;
      destroy.call(buffer);
    };
    return buffer;
  };
  const errors: string[] = [];
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  let gpu: GpuSolver3D | null = null;
  try {
    gpu = new GpuSolver3D(device, ref, { bodyCapacity: ref.bodies.length + 16 });
    const solver = gpu;
    result.buildMs = performance.now() - t0;
    log(`${c.name}: ${c.lead} lead-in steps…`);
    for (let i = 0; i < c.lead; i++) {
      solver.step();
      if (i % 30 === 29) solver.adapt(await solver.readCounters());
    }
    log(`${c.name}: timing…`);
    // One short window: the scene is in motion, so more rounds would time later stretches
    result.wallMs = (await compare(device, () => solver.step(), [{ name: 'wall', apply: () => {} }], { rounds: 2, batches: 5, perBatch: 10, warmup: 0 })).wall;
    const profiles: StepProfile[] = [];
    for (let i = 0; i < 10; i++) {
      solver.profileNextStep((p) => profiles.push(p));
      solver.step();
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 2));
    }
    const median = (key: keyof StepProfile) => profiles.map((p) => p[key]).sort((a, b) => a - b)[profiles.length >> 1];
    if (profiles.length) result.gpu = Object.fromEntries(['total', ...PHASES].map((k) => [k, median(k as keyof StepProfile)])) as StepProfile;
    const counters = await solver.readCounters();
    Object.assign(result, { contacts: counters.contacts, colors: counters.colors, clashes: counters.clashes, overflow: counters.overflow });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }
  for (const scope of ['validation', 'out-of-memory']) {
    const err = await device.popErrorScope();
    if (err) errors.push(`${scope}: ${err.message}`);
  }
  gpu?.destroy();
  device.createBuffer = createBuffer;
  if (errors.length) result.error = errors.join('; ');
  return result;
}
