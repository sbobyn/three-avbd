// GPU scaling for the 3D solver, headless through Dawn. Reports wall time per step (robust:
// warm-up, drained batches, best median over rounds; ../src/avbd2d/gpu/timing.ts) and GPU time
// per phase (timestamp queries, median of 10 isolated steps, which run at lower clocks and so
// read high). Close other GPU work (browser tabs) while it runs.
// Usage: pnpm bench3d:gpu [iterations] [case,case,...]
import { boxColumns, boxPile, chainMail, wallSmash } from '../src/avbd3d/bench-scenes.ts';
import { GpuSolver3D, PHASES, type StepProfile } from '../src/avbd3d/gpu/solver.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { compare } from '../src/avbd2d/gpu/timing.ts';
import { device, skip } from '../tests-gpu/device.ts';

if (!device) {
  console.log(`skipped: ${skip}`);
  process.exit(0);
}
const iterations = Number(process.argv[2] ?? 10);
const only = process.argv[3]?.split(',');
console.log(`adapter: ${device.adapterInfo?.vendor ?? '?'} ${device.adapterInfo?.architecture ?? ''}, ${iterations} iterations`);

const cases: [string, (s: Solver) => void][] = [
  ['wall smash 2k', (s) => wallSmash(s)],
  ['chain mail 1.6k', (s) => chainMail(s)],
  ['columns 32x32x10', (s) => boxColumns(s, 32, 10)],
  ['pile 40x40x20', (s) => boxPile(s, 40, 20)],
  ['columns 50x50x20', (s) => boxColumns(s, 50, 20)],
  ['columns 100x100x10', (s) => boxColumns(s, 100, 10)],
  ['columns 100x100x25', (s) => boxColumns(s, 100, 25)],
];

for (const [name, build] of cases) {
  if (only && !only.includes(name)) continue;
  const ref = new Solver();
  build(ref);
  ref.iterations = iterations;
  const gpu = new GpuSolver3D(device, ref, { bodyCapacity: ref.bodies.length + 16 });
  // Settle into contact (and let capacities / colour cap adapt), as an app would
  for (let i = 0; i < 180; i++) {
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
  const wall = (await compare(device, () => gpu.step(), [{ name: 'wall', apply: () => {} }], { rounds: 3, warmup: 20 })).wall;
  const c = await gpu.readCounters();
  const median = (key: keyof StepProfile) => {
    const v = profiles.map((p) => p[key]).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1].toFixed(2) : '—';
  };
  console.log(
    `${name.padEnd(20)} ${String(gpu.bodyCount).padStart(7)} bodies ${String(c.contacts).padStart(8)} contacts ` +
      `${String(c.colors).padStart(2)} colours (clashes ${c.clashes}, overflow ${c.overflow}): wall ${wall.toFixed(2)} ms/step | ` +
      `GPU ${median('total')} = ${PHASES.map((ph) => `${ph} ${median(ph)}`).join(', ')}`,
  );
  gpu.destroy();
}
process.exit(0);
