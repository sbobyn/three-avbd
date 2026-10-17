// Diagnostic (STE-2538, not run by the gate): the fused colour tail against the per-colour
// dispatches when bodies of one colour share a constraint (a clashing colouring). Prints, for each
// case, whether two per-colour solvers agree with each other and whether the fused one agrees.
//   node --experimental-transform-types --no-warnings tests-gpu/sparse-colors-clash.diag.ts
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { device, skip } from './device.ts';

if (skip) { console.log(`no GPU: ${skip}`); process.exit(0); }

async function run(name: string, count: number, colorOf: (i: number) => number) {
  const make = (fuse: boolean) => {
    const ref = new Solver();
    for (let i = 0; i < count; i++) new Rigid(ref, [0.1, 0.1, 0.1], 1, 0.5, [i * 0.3, 0, 3], [0, 0.2 * ((i % 3) - 1), 0]);
    const gpu = new GpuSolver3D(device!, ref, { spatialSort: false });
    gpu.fuseSparseColors = fuse;
    gpu.appendJoints(Array.from({ length: count - 1 }, (_, i) => ({ a: i, b: i + 1, rA: [0.15, 0, 0], rB: [-0.15, 0, 0] })));
    gpu.fixedColors = Uint32Array.from({ length: count }, (_, i) => colorOf(i));
    return gpu;
  };
  // normal twice: is the per-colour path repeatable with itself under the same clash?
  const solvers = [make(false), make(false), make(true)];
  let firstRepeat = -1, firstFused = -1, worst = 0;
  for (let step = 0; step < 30; step++) {
    for (const s of solvers) s.step();
    const [a, b, f] = await Promise.all(solvers.map(s => s.readBodies()));
    for (let k = 0; k < a.length; k++) {
      if (!Object.is(a[k], b[k]) && firstRepeat < 0) firstRepeat = step;
      if (!Object.is(a[k], f[k])) { if (firstFused < 0) firstFused = step; if (step === firstFused) worst = Math.max(worst, Math.abs(a[k] - f[k])); }
    }
  }
  for (const s of solvers) s.destroy();
  console.log(`${name}: per-colour vs per-colour ${firstRepeat < 0 ? 'identical for 30 steps' : `differs from step ${firstRepeat}`}; fused vs per-colour ${firstFused < 0 ? 'identical for 30 steps' : `differs from step ${firstFused} (largest difference that step ${worst})`}`);
}

await run('proper colouring, alternating tail colours 20/21 (several chunks each)', 40, i => 20 + i % 2);
await run('clash inside one chunk only (bodies 0-7 share colour 20; rest alternate 21/22)', 40, i => i < 8 ? 20 : 21 + i % 2);
await run('clash across chunks (all 40 jointed bodies share colour 20)', 40, () => 20);
await run('clash across chunks below the tail (all 40 share colour 5: both sides run primal)', 40, () => 5);
await device!.queue.onSubmittedWorkDone();
process.exit(0);
