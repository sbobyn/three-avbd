// GPU scaling for the 2D solver, headless through Dawn: joint lattices (no contacts) and box
// piles (the full contact pipeline). Reports GPU time (timestamp queries, median of 10 steps)
// and wall time per step with the queue drained. Usage: pnpm bench2d:gpu [iterations]
import { boxRain, jointLatticeSoa, pyramid, wreckingBall } from '../src/avbd2d/bench-scenes.ts';
import { GpuSolver2D, PHASES, type StepProfile } from '../src/avbd2d/gpu/solver.ts';
import { parallelParams, Solver } from '../src/avbd2d/ref/solver.ts';
import { SoaSolver2D } from '../src/avbd2d/soa/solver.ts';
import { device, skip } from '../tests-gpu/device.ts';

if (!device) {
  console.log(`skipped: ${skip}`);
  process.exit(0);
}
const iterations = Number(process.argv[2] ?? 10);
console.log(`adapter: ${device.adapterInfo?.vendor ?? '?'} ${device.adapterInfo?.architecture ?? ''}, ${iterations} iterations`);

const fromRef = (build: (s: Solver) => void) => () => {
  const ref = new Solver();
  Object.assign(ref, parallelParams(), { iterations });
  build(ref);
  const s = new SoaSolver2D();
  s.loadFromReference(ref);
  return s;
};
const lattice = (side: number) => () => {
  const s = new SoaSolver2D();
  Object.assign(s.params, parallelParams(), { iterations });
  jointLatticeSoa(s, side, side);
  return s;
};

const cases: [string, () => SoaSolver2D][] = [
  ['lattice 128²', lattice(128)],
  ['lattice 320²', lattice(320)],
  ['lattice 512²', lattice(512)],
  ['pyramid 100', fromRef((s) => pyramid(s, 100))],
  ['pyramid 200', fromRef((s) => pyramid(s, 200))],
  ['wrecking ball 400x100', fromRef((s) => wreckingBall(s, 400, 100))],
  ['box rain 900x100', fromRef((s) => boxRain(s, 900, 100))],
];

for (const [name, make] of cases) {
  const gpu = new GpuSolver2D(device, make());
  // Settle into contact (and let capacities / colour cap adapt), as an app would
  for (let i = 0; i < 240; i++) {
    gpu.step();
    if (i % 60 === 59) gpu.adapt(await gpu.readCounters());
  }
  await device.queue.onSubmittedWorkDone();
  const profiles: StepProfile[] = [];
  for (let i = 0; i < 10; i++) {
    gpu.profileNextStep((p) => profiles.push(p));
    gpu.step();
    await device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 2));
  }
  const frames = 30;
  const t = performance.now();
  for (let i = 0; i < frames; i++) gpu.step();
  await device.queue.onSubmittedWorkDone();
  const wall = (performance.now() - t) / frames;
  const c = await gpu.readCounters();
  // Median per phase over the profiled steps
  const median = (key: keyof StepProfile) => {
    const v = profiles.map((p) => p[key]).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1].toFixed(2) : '—';
  };
  console.log(
    `${name.padEnd(22)} ${String(gpu.bodyCount).padStart(7)} bodies ${String(c.contacts).padStart(7)} contacts ` +
      `${String(c.colors).padStart(2)} colours (clashes ${c.clashes}, overflow ${c.overflow}): wall ${wall.toFixed(2)} ms/step | ` +
      `GPU ${median('total')} = ${PHASES.map((ph) => `${ph} ${median(ph)}`).join(', ')}`,
  );
  gpu.destroy();
}
process.exit(0);
