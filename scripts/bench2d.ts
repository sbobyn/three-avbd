// CPU scaling baseline for the GPU-shaped 2D solver: ms per step by phase on the benchmark
// scenes. Usage: node --experimental-transform-types scripts/bench2d.ts [frames]
import { createSim, type SoaSim } from '../src/avbd2d/sim.ts';
import { benchScenes } from '../src/avbd2d/bench-scenes.ts';

const frames = Number(process.argv[2] ?? 300);
const warmup = 60;
console.log(`frames ${frames} after ${warmup} warm-up, 10 iterations, colored f32\n`);
const phases = ['broadphase', 'narrowphase', 'adjacency', 'coloring', 'primal', 'dual'];
console.log(['scene'.padEnd(26), 'bodies', 'contacts', 'colors', 'ms/step', ...phases].join('\t'));
for (const scene of benchScenes) {
  const sim = createSim('soa-colored', scene.name) as SoaSim;
  for (let i = 0; i < warmup; i++) sim.step();
  sim.solver.profiling = true;
  sim.solver.resetProfile();
  const t0 = performance.now();
  let colors = 0;
  for (let i = 0; i < frames; i++) {
    sim.step();
    colors = Math.max(colors, sim.solver.numColors);
  }
  const ms = (performance.now() - t0) / frames;
  const p = sim.solver.profile;
  console.log([scene.name.padEnd(26), sim.bodyCount, sim.solver.contactCount, colors, ms.toFixed(2), ...phases.map((k) => ((p[k] ?? 0) / frames).toFixed(2))].join('\t'));
}
