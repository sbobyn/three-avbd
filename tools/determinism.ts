// Determinism probe: build a scene twice, step both identically on the GPU, and compare the
// body buffers bit for bit at checkpoints. Run from the repo root:
//   node --experimental-transform-types <this file> [scene] [steps] [every]
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const { buildScene3D } = await import(`../src/avbd3d/gpu/sim.ts`);
const { GpuSolver3D } = await import(`../src/avbd3d/gpu/solver.ts`);
const { BODY_FLOATS } = await import(`../src/avbd3d/gpu/layout.ts`);

const [scene = 'Box Pile (4k)', stepsArg = '300', everyArg = '10'] = process.argv.slice(2);
const steps = Number(stepsArg);
const every = Number(everyArg);

const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize },
});
(globalThis as { __keep?: unknown }).__keep = [gpu, adapter, device];

const make = () => {
  const ref = buildScene3D(scene);
  const n = ref.bodies.length;
  // Worst case for a pile: about 13 neighbours a body, 4 points a box pair
  return new GpuSolver3D(device, ref, { bodyCapacity: n + 16, capacity: { pairs: 16 * n, manifolds: 8 * n, contacts: 32 * n, colors: 16 } });
};
const a = make();
const b = make();
console.log(`${scene}: ${a.bodyCount} bodies, ${steps} steps, compare every ${every}`);

let firstDiff = -1;
for (let s = 1; s <= steps; s++) {
  a.step();
  b.step();
  if (s % every !== 0 && s !== steps) continue;
  const [x, y] = await Promise.all([a.readBodies(), b.readBodies()]);
  const xi = new Uint32Array(x.buffer), yi = new Uint32Array(y.buffer);
  let bodies = 0, maxPos = 0;
  for (let i = 0; i < a.bodyCount; i++) {
    let differs = false;
    for (let k = 0; k < BODY_FLOATS; k++) if (xi[i * BODY_FLOATS + k] !== yi[i * BODY_FLOATS + k]) differs = true;
    if (!differs) continue;
    bodies++;
    const o = i * BODY_FLOATS;
    maxPos = Math.max(maxPos, Math.hypot(x[o] - y[o], x[o + 1] - y[o + 1], x[o + 2] - y[o + 2]));
  }
  const [ca, cb] = await Promise.all([a.readCounters(), b.readCounters()]);
  if (ca.overflow || cb.overflow || ca.clashes || cb.clashes) console.log(`step ${s}: overflow ${ca.overflow}/${cb.overflow} clashes ${ca.clashes}/${cb.clashes} colours ${ca.colors}/${cb.colors} (caps: contacts ${a.contactCapacity}, pairs ${a.pairCapacity ?? '?'}, colours ${a.colorCap})`);
  if (bodies && firstDiff < 0) firstDiff = s;
  if (bodies || s === steps) console.log(`step ${s}: ${bodies} bodies differ, max position gap ${maxPos.toExponential(2)} m`);
  if (bodies > a.bodyCount / 2) break;
}
console.log(firstDiff < 0 ? 'DETERMINISTIC over the run' : `first divergence by step ${firstDiff}`);
a.destroy();
b.destroy();
await device.queue.onSubmittedWorkDone();
process.exit(0);
