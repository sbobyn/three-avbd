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

/** What the paper reports for a scene one of ours stands in for (RTX 4090). */
export interface PaperScene {
  figure: string;
  description: string;
  bodies: number;
  iterations: number;
  /** Per frame, including collision detection. */
  totalMs: number;
  /** The solver alone (Table 1), when reported. */
  solveMs?: number;
  /** How our scene differs. */
  note: string;
}

export const PAPER_SCENES = {
  fig1: {
    figure: 'Fig. 1, Table 1',
    description: 'A pile of 110,000 blocks (a stepped ring wall of bricks) smashed by a sphere',
    bodies: 110_000,
    iterations: 4,
    totalMs: 9.8,
    solveMs: 3.5,
    note: 'Ours: a stepped ring wall of 110,332 bricks, 160 m across, hit from inside by one sphere.',
  },
  fig3: {
    figure: 'Fig. 3, Table 1',
    description: 'Piles of 510,000 blocks (a field of triangular brick walls) smashed by two spheres',
    bodies: 510_000,
    iterations: 3,
    totalMs: 17.6,
    solveMs: 10.3,
    note: 'Ours: 1,088 triangular walls of 465 bricks (505,920) and two spheres. Table 1 gives 3 iterations, the caption 4.',
  },
  fig14: {
    figure: 'Fig. 14',
    description: '35,000 rigid bodies joined by 72,000 joints falling onto a 10,000-vertex cloth',
    bodies: 35_000,
    iterations: 10,
    totalMs: 16,
    note: 'Ours has no cloth: 600 jointed plates (34,097 bodies, 71,064 joints) fall onto a chain-mail net pinned at its edges.',
  },
} satisfies Record<string, PaperScene>;

export interface BenchCase {
  name: string;
  tier: Tier;
  iterations: number;
  build: (solver: Solver) => void;
  /** Steps before timing starts (capacities and the colour cap adapt meanwhile). */
  lead: number;
  /** The paper's scene this one stands in for, if any. */
  paper?: PaperScene;
}

export const BENCH_CASES: BenchCase[] = [
  { name: 'Wall smash 2k', tier: 'small', iterations: 10, build: (s) => wallSmash(s), lead: 30 },
  { name: 'Chain mail 1.6k', tier: 'small', iterations: 10, build: (s) => chainMail(s), lead: 60 },
  { name: 'Brick ring 9k', tier: 'small', iterations: 4, build: (s) => brickRing(s, 12, 20, 2, 10), lead: 60 },
  { name: 'Brick gables 6.7k', tier: 'small', iterations: 3, build: (s) => brickGables(s, 4, 8, 20), lead: 60 },
  { name: 'Jointed drop 6k', tier: 'small', iterations: 10, build: (s) => jointedDrop(s, 5, 4, 32), lead: 60 },
  { name: 'Brick ring 110k', tier: 'paper', iterations: 4, build: (s) => brickRing(s), lead: 60, paper: PAPER_SCENES.fig1 },
  {
    name: 'Jointed drop 34k (71k joints)',
    tier: 'paper',
    iterations: 10,
    build: (s) => jointedDrop(s),
    lead: 60,
    paper: PAPER_SCENES.fig14,
  },
  // Table 1 lists 3 iterations for this scene, the Fig. 3 caption 4
  { name: 'Brick gables 506k', tier: 'large', iterations: 3, build: (s) => brickGables(s), lead: 60, paper: PAPER_SCENES.fig3 },
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
  /** The paper's time for the scene this stands in for (display text). */
  paper?: string;
  error?: string;
}

/** One machine's run of the suite: what bench3d.html downloads and results.html reads. */
export interface BenchReport {
  /** A short name for the machine, e.g. "MacBook Pro M1". */
  machine: string;
  adapter: string;
  /** How it was run: a browser (user agent) or the headless script. */
  source: string;
  /** ISO date of the run. */
  date: string;
  timestamps: boolean;
  results: BenchResult[];
}

export const paperText = (p: PaperScene): string => `${p.totalMs} ms${p.solveMs ? ` (${p.solveMs} solve)` : ''}`;

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
    paper: c.paper && paperText(c.paper),
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
