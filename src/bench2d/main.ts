// In-browser GPU benchmark for the 2D solver: a fixed scene suite, timed on this machine's
// GPU, with results to copy back. Meant for measuring the target hardware (M1, GTX 1080)
// directly instead of extrapolating from the development machine.

import { boxRain, jointLatticeSoa, pyramid, wreckingBall } from '../avbd2d/bench-scenes.ts';
import { GpuSolver2D, PHASES, type StepProfile } from '../avbd2d/gpu/solver.ts';
import { compare } from '../avbd2d/gpu/timing.ts';
import { parallelParams, Solver } from '../avbd2d/ref/solver.ts';
import { SoaSolver2D } from '../avbd2d/soa/solver.ts';

interface Case {
  name: string;
  make: (iterations: number) => SoaSolver2D;
}

const fromRef = (build: (s: Solver) => void) => (iterations: number) => {
  const ref = new Solver();
  Object.assign(ref, parallelParams(), { iterations });
  build(ref);
  const s = new SoaSolver2D();
  s.loadFromReference(ref);
  return s;
};

const CASES: Case[] = [
  { name: 'Pyramid 100 (5k)', make: fromRef((s) => pyramid(s, 100)) },
  { name: 'Pyramid 200 (20k)', make: fromRef((s) => pyramid(s, 200)) },
  { name: 'Wrecking ball (40k)', make: fromRef((s) => wreckingBall(s, 400, 100)) },
  { name: 'Box rain (90k)', make: fromRef((s) => boxRain(s, 900, 100)) },
  {
    name: 'Joint lattice (100k)',
    make: (iterations) => {
      const s = new SoaSolver2D();
      Object.assign(s.params, parallelParams(), { iterations });
      jointLatticeSoa(s, 320, 320);
      return s;
    },
  },
];

interface Result {
  scene: string;
  iterations: number;
  primal: string;
  bodies: number;
  contacts: number;
  colors: number;
  wallMs: number;
  gpu: StepProfile | null;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const log = (text: string) => ($('#status').textContent = text);
const results: Result[] = [];

async function device(): Promise<{ device: GPUDevice; info: string }> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  const requiredFeatures = (['timestamp-query'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
  const requiredLimits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize };
  const dev = await adapter.requestDevice({ requiredFeatures, requiredLimits });
  const i = adapter.info;
  return { device: dev, info: [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') || 'unknown adapter' };
}

function render(info: string): void {
  const rows = results
    .map((r) => {
      const phases = r.gpu ? PHASES.map((p) => r.gpu![p].toFixed(2)).join('</td><td>') : PHASES.map(() => '—').join('</td><td>');
      return `<tr><td>${r.scene}</td><td>${r.iterations}</td><td>${r.primal}</td><td>${r.bodies}</td><td>${r.contacts}</td><td>${r.colors}</td><td><b>${r.wallMs.toFixed(2)}</b></td><td>${r.gpu ? r.gpu.total.toFixed(2) : '—'}</td><td>${phases}</td></tr>`;
    })
    .join('');
  $('#results').innerHTML = `<p class="adapter">${info}</p><table><thead><tr><th>scene</th><th>iters</th><th>primal</th><th>bodies</th><th>contacts</th><th>colours</th><th>wall ms/step</th><th>GPU ms</th>${PHASES.map((p) => `<th>${p}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
}

/** Build a case, let it settle (and adapt), then time it: wall per step and GPU per phase. */
async function measure(device: GPUDevice, c: Case, iterations: number, primal: 'bucket' | 'scan'): Promise<Result> {
  const label = `${c.name}, ${iterations} iterations, ${primal}`;
  log(`${label}: building…`);
  await new Promise((r) => setTimeout(r, 0));
  const solver = new GpuSolver2D(device, c.make(iterations));
  solver.primalMode = primal;
  log(`${label}: settling…`);
  for (let i = 0; i < 240; i++) {
    solver.step();
    if (i % 60 === 59) solver.adapt(await solver.readCounters());
  }
  log(`${label}: timing…`);
  const wall = await compare(device, () => solver.step(), [{ name: 'wall', apply: () => {} }], { rounds: 3, warmup: 20 });
  const profiles: StepProfile[] = [];
  for (let i = 0; i < 12; i++) {
    solver.profileNextStep((p) => profiles.push(p));
    solver.step();
    await device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 5));
  }
  const median = (key: keyof StepProfile) => profiles.map((p) => p[key]).sort((a, b) => a - b)[profiles.length >> 1];
  const gpuProfile = profiles.length ? (Object.fromEntries(['total', ...PHASES].map((k) => [k, median(k as keyof StepProfile)])) as StepProfile) : null;
  const counters = await solver.readCounters();
  const result = { scene: c.name, iterations, primal, bodies: solver.bodyCount, contacts: counters.contacts, colors: counters.colors, wallMs: wall.wall, gpu: gpuProfile };
  solver.destroy();
  return result;
}

async function run(): Promise<void> {
  $<HTMLButtonElement>('#run').disabled = true;
  results.length = 0;
  let info = '';
  try {
    const gpu = await device();
    info = gpu.info;
    const iterationList = $<HTMLSelectElement>('#iterations').value.split(',').map(Number);
    const primalModes = $<HTMLSelectElement>('#primal').value.split(',') as ('bucket' | 'scan')[];
    for (const iterations of iterationList) {
      for (const c of CASES) {
        for (const primal of primalModes) {
          results.push(await measure(gpu.device, c, iterations, primal));
          render(info);
        }
      }
    }
    log(`Done. ${gpu.device.features.has('timestamp-query') ? '' : 'No timestamp-query on this device: GPU phase times unavailable.'}`);
  } catch (e) {
    log(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  $<HTMLButtonElement>('#run').disabled = false;
  $<HTMLButtonElement>('#copy').disabled = results.length === 0;
  ($('#copy') as HTMLButtonElement).onclick = () => {
    const text = JSON.stringify({ adapter: info, userAgent: navigator.userAgent, results }, null, 1);
    void navigator.clipboard.writeText(text).then(() => log('Results copied to the clipboard.'));
  };
}

$<HTMLButtonElement>('#run').onclick = () => void run();
