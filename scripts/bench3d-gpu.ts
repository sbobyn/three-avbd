// The 3D GPU benchmark suite (../src/avbd3d/bench-cases.ts) headless through Dawn: wall time
// per step (queue kept busy) and GPU time per phase (timestamp queries, median of 10 isolated
// steps, which run at lower clocks and so read high). bench3d.html runs the same suite in a
// browser on the target hardware. Close other GPU work (browser tabs) while it runs.
// Usage: pnpm bench3d:gpu [tier,tier,...|case name,...]   (default: small,paper)
import { BENCH_CASES, measureCase } from '../src/avbd3d/bench-cases.ts';
import { PHASES } from '../src/avbd3d/gpu/solver.ts';
import { device, skip } from '../tests-gpu/device.ts';

if (!device) {
  console.log(`skipped: ${skip}`);
  process.exit(0);
}
const only = (process.argv[2] ?? 'small,paper').split(',');
console.log(`adapter: ${device.adapterInfo?.vendor ?? '?'} ${device.adapterInfo?.architecture ?? ''}`);

for (const c of BENCH_CASES) {
  if (!only.includes(c.tier) && !only.includes(c.name)) continue;
  const r = await measureCase(device, c);
  const gpu = r.gpu ? `GPU ${r.gpu.total.toFixed(2)} = ${PHASES.map((p) => `${p} ${r.gpu![p].toFixed(2)}`).join(', ')}` : 'GPU —';
  console.log(
    `${r.scene.padEnd(30)} ${String(r.iterations).padStart(2)} it ${String(r.bodies).padStart(7)} bodies ${String(r.contacts).padStart(8)} contacts ` +
      `${String(r.colors).padStart(2)} colours (clashes ${r.clashes}, overflow ${r.overflow}): wall ${r.wallMs.toFixed(2)} ms/step | ${gpu}` +
      `${r.paper ? ` | paper ${r.paper}` : ''}${r.error ? ` | ERROR ${r.error}` : ''} [${(r.gpuBytes / 2 ** 20).toFixed(0)} MB of buffers, built in ${(r.buildMs / 1000).toFixed(1)} s]`,
  );
}
process.exit(0);
