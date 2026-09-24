// Scaling study: box rain from 10k to 250k bodies (100 rows, width varied so every size lands
// in the same ~5 s) at 4 and 10 iterations, wall time per step and GPU time per phase, after
// the pile has settled into contact. Writes
// docs/data/scaling2d-<adapter>.json. Usage: pnpm scaling2d
import { writeFileSync } from 'node:fs';
import { boxRainSoa } from '../src/avbd2d/bench-scenes.ts';
import { GpuSolver2D, PHASES, type StepProfile } from '../src/avbd2d/gpu/solver.ts';
import { compare } from '../src/avbd2d/gpu/timing.ts';
import { parallelParams } from '../src/avbd2d/ref/solver.ts';
import { SoaSolver2D } from '../src/avbd2d/soa/solver.ts';
import { device, skip } from '../tests-gpu/device.ts';

if (!device) {
  console.log(`skipped: ${skip}`);
  process.exit(0);
}
const adapter = `${device.adapterInfo?.vendor ?? 'unknown'}-${device.adapterInfo?.architecture ?? ''}`.replace(/[^\w-]+/g, '-');
const widths = [100, 250, 500, 900, 1600, 2500];
const rows: Record<string, unknown>[] = [];
for (const iterations of [4, 10]) {
  for (const width of widths) {
    const s = new SoaSolver2D();
    boxRainSoa(s, width, 100);
    Object.assign(s.params, parallelParams(), { iterations });
    const gpu = new GpuSolver2D(device, s);
    // Let the rain land (~5 s) so the timing is of a settled, fully-contacting pile
    for (let i = 0; i < 480; i++) {
      gpu.step();
      if (i % 60 === 59) gpu.adapt(await gpu.readCounters());
    }
    const wall = await compare(device, () => gpu.step(), [{ name: 'wall', apply: () => {} }], { rounds: 3, warmup: 20 });
    const profiles: StepProfile[] = [];
    for (let i = 0; i < 15; i++) {
      gpu.profileNextStep((p) => profiles.push(p));
      gpu.step();
      await device.queue.onSubmittedWorkDone();
      await new Promise((r) => setTimeout(r, 2));
    }
    const median = (k: keyof StepProfile) => profiles.map((p) => p[k]).sort((a, b) => a - b)[profiles.length >> 1];
    const c = await gpu.readCounters();
    const row = {
      iterations,
      bodies: gpu.bodyCount,
      contacts: c.contacts,
      colors: c.colors,
      wallMs: +wall.wall.toFixed(3),
      ...Object.fromEntries(['total', ...PHASES].map((k) => [k, +median(k as keyof StepProfile).toFixed(3)])),
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    gpu.destroy();
  }
}
const file = `docs/data/scaling2d-${adapter}.json`;
writeFileSync(file, JSON.stringify({ adapter: device.adapterInfo, scene: 'box rain (settled pile)', rows }, null, 1) + '\n');
console.log(`wrote ${file}`);
process.exit(0);
