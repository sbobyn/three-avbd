// Iteration-count sweep on the GPU: quality metrics (does the physics still hold?) and cost
// per step, for choosing the default iteration count. Usage: pnpm sweep2d
import { boxRain, pyramid } from '../src/avbd2d/bench-scenes.ts';
import { BODY_FLOATS } from '../src/avbd2d/gpu/layout.ts';
import { GpuSolver2D } from '../src/avbd2d/gpu/solver.ts';
import { parallelParams, Solver } from '../src/avbd2d/ref/solver.ts';
import { sceneByName } from '../src/avbd2d/sim.ts';
import { SoaSolver2D } from '../src/avbd2d/soa/solver.ts';
import { device, skip } from '../tests-gpu/device.ts';
import { compare } from '../src/avbd2d/gpu/timing.ts';

if (!device) {
  console.log(`skipped: ${skip}`);
  process.exit(0);
}

const load = (build: (s: Solver) => void, iterations: number) => {
  const ref = new Solver();
  Object.assign(ref, parallelParams(), { iterations });
  build(ref);
  const s = new SoaSolver2D();
  s.loadFromReference(ref);
  return new GpuSolver2D(device!, s);
};
const scene = (name: string) => (s: Solver) => sceneByName(name).build!(s);

async function run(gpu: GpuSolver2D, frames: number, every = 60, onSample?: (b: Float32Array) => void) {
  for (let f = 1; f <= frames; f++) {
    gpu.step();
    if (f % every === 0) {
      gpu.adapt(await gpu.readCounters());
      if (onSample) onSample(await gpu.readBodies());
    }
  }
  return gpu.readBodies();
}

const maxY = (b: Float32Array, n: number) => {
  let m = -Infinity;
  for (let i = 0; i < n; i++) if (b[i * BODY_FLOATS + 22] > 0) m = Math.max(m, b[i * BODY_FLOATS + 1]);
  return m;
};

console.log('iters | pyr20 top (8.0) | pyr100 top (48.0) | stack top (20.0) | slope creep 20s | rope max err | box rain KE | wreck max |v| | ms pyr200 | ms rain 900x100');
for (const iterations of [1, 2, 3, 4, 6, 10]) {
  const row: string[] = [String(iterations).padStart(5)];

  let g = load(scene('Pyramid'), iterations);
  row.push(maxY(await run(g, 600), g.bodyCount).toFixed(3));
  g.destroy();

  g = load((s) => pyramid(s, 100), iterations);
  row.push(maxY(await run(g, 900), g.bodyCount).toFixed(3));
  g.destroy();

  g = load(scene('Stack'), iterations);
  const stack = await run(g, 600);
  const top = g.bodyCount - 1;
  row.push(`${stack[top * BODY_FLOATS + 1].toFixed(3)} x${stack[top * BODY_FLOATS].toFixed(2)}`);
  g.destroy();

  g = load(scene('Static Friction'), iterations);
  const before = await run(g, 300);
  const after = await run(g, 1200);
  let creep = 0;
  for (let i = 1; i < g.bodyCount; i++) creep = Math.max(creep, Math.hypot(after[i * BODY_FLOATS] - before[i * BODY_FLOATS], after[i * BODY_FLOATS + 1] - before[i * BODY_FLOATS + 1]));
  row.push(`${(creep * 1000).toFixed(1)} mm`);
  g.destroy();

  g = load(scene('Hanging Rope'), iterations);
  let ropeErr = 0;
  for (let f = 0; f < 600; f += 30) {
    for (let i = 0; i < 30; i++) g.step();
    if (f >= 60) ropeErr = Math.max(ropeErr, (await g.readStats()).maxJointError);
  }
  row.push(ropeErr.toExponential(1));
  g.destroy();

  g = load((s) => boxRain(s, 40, 25), iterations);
  await run(g, 900);
  row.push((await g.readStats()).kineticEnergy.toFixed(2));
  g.destroy();

  g = load(scene('Wrecking Ball 100x40 (4k)'), iterations);
  let vmax = 0;
  await run(g, 600, 30, (b) => {
    for (let i = 0; i < g.bodyCount; i++) vmax = Math.max(vmax, Math.hypot(b[i * BODY_FLOATS + 12], b[i * BODY_FLOATS + 13]));
  });
  row.push(vmax.toFixed(1));
  g.destroy();

  for (const build of [(s: Solver) => pyramid(s, 200), (s: Solver) => boxRain(s, 900, 100)]) {
    g = load(build, iterations);
    await run(g, 240);
    const t = await compare(device, () => g.step(), [{ name: 'x', apply: () => {} }], { rounds: 3, warmup: 10 });
    row.push(t.x.toFixed(2));
    g.destroy();
  }
  console.log(row.join(' | '));
}
process.exit(0);
