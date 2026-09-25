// Headless run of the painting scene (src/avbd3d/painting.ts): pours the spheres, reports how
// long it takes, whether anything overflowed or escaped the box, and writes the finished
// picture (each sphere coloured by the painting at its final spot) as raw RGB. Run from the
// repo root:
//   node --experimental-transform-types tools/painting-preview.ts <image.rgb> <imgW> <imgH> [bodies] [out.rgb] [twice]
import { readFileSync, writeFileSync } from 'node:fs';
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const { GpuSolver3D, gpuParams3D } = await import('../src/avbd3d/gpu/solver.ts');
const { BODY_FLOATS } = await import('../src/avbd3d/gpu/layout.ts');
const { Solver } = await import('../src/avbd3d/ref/solver.ts');
const { buildPainting, paintingEmitter, paintingLayout, pictureCoords, PAINTING_DT } = await import('../src/avbd3d/painting.ts');

const [imagePath, iwArg, ihArg, bodiesArg = '20000', outPath = 'painting.rgb', twice] = process.argv.slice(2);
const [iw, ih] = [Number(iwArg), Number(ihArg)];
const image = readFileSync(imagePath);
const layout = paintingLayout(Number(bodiesArg));
console.log('layout', JSON.stringify(layout, (_, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v)));

const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize },
});
(globalThis as { __keep?: unknown }).__keep = [gpu, adapter, device];

async function pour(): Promise<{ bodies: Float32Array; first: number; ms: number; overflow: number }> {
  const ref = new Solver();
  buildPainting(ref, layout);
  const n = layout.bodies;
  const solver = new GpuSolver3D(device, ref, {
    bodyCapacity: ref.bodies.length + n,
    capacity: { pairs: 16 * n, manifolds: 8 * n, contacts: 8 * n, colors: Number(process.env.COLORS ?? 10) },
  });
  Object.assign(solver.params, gpuParams3D(), { dt: PAINTING_DT, gravity: -layout.gravity, iterations: Number(process.env.ITERATIONS ?? 4) });
  const first = ref.bodies.length;
  const emitter = paintingEmitter(layout);
  const scratch = new Solver();
  let overflow = 0;
  const t0 = performance.now();
  for (let s = 0; s < layout.steps; s++) {
    emitter.spawn(s, scratch);
    if (scratch.bodies.length) {
      solver.addBodies(scratch.bodies);
      scratch.clear();
    }
    solver.step();
    if (s % 200 === 199) {
      const c = await solver.readCounters();
      overflow |= c.overflow;
    }
  }
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  const bodies = await solver.readBodies();
  solver.destroy();
  return { bodies, first, ms, overflow };
}

const run = await pour();
const { bodies, first } = run;
console.log(`poured ${layout.bodies} spheres in ${layout.steps} steps: ${(run.ms / 1000).toFixed(1)} s (${(run.ms / layout.steps).toFixed(2)} ms/step), overflow ${run.overflow}`);

// Where they ended up
const { width: w, boxHeight: bh, depth: d, radius: r } = layout;
const zs: number[] = [];
let escaped = 0;
let maxY = 0;
for (let i = first; i < first + layout.bodies; i++) {
  const o = i * BODY_FLOATS;
  const [x, y, z] = [bodies[o], bodies[o + 1], bodies[o + 2]];
  maxY = Math.max(maxY, Math.abs(y));
  if (Math.abs(x) > 3 * w || z < -5 || !Number.isFinite(x + y + z)) escaped++;
  zs.push(z);
}
zs.sort((a, b) => a - b);
const pct = (p: number) => zs[Math.min(zs.length - 1, Math.floor(p * zs.length))];
const fill = pct(0.995) + r;
console.log(`escaped ${escaped}, max |y| ${maxY.toFixed(3)} (half depth ${(d / 2).toFixed(3)}), z p50 ${pct(0.5).toFixed(2)} p99 ${pct(0.99).toFixed(2)} p99.5 ${pct(0.995).toFixed(2)} max ${zs[zs.length - 1].toFixed(2)}, expected fill ${layout.height.toFixed(2)}, picture top ${fill.toFixed(2)}`);

if (twice) {
  const again = await pour();
  const a = new Uint32Array(bodies.buffer), b = new Uint32Array(again.bodies.buffer);
  let differ = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ++;
  console.log(differ === 0 ? 'second run: IDENTICAL' : `second run: ${differ} words differ`);
}

// The finished picture: discs coloured by the painting at their final spot
const xs = new Float32Array(layout.bodies), zf = new Float32Array(layout.bodies);
for (let k = 0; k < layout.bodies; k++) {
  xs[k] = bodies[(first + k) * BODY_FLOATS];
  zf[k] = bodies[(first + k) * BODY_FLOATS + 2];
}
const uv = pictureCoords(layout, xs, zf);
let spilled = 0;
for (let k = 0; k < layout.bodies; k++) if (zf[k] < 0 || Math.abs(xs[k]) > w / 2) spilled++;
console.log(`spilled out of the frame: ${spilled} of ${layout.bodies} (frame ${w.toFixed(2)} x ${layout.height.toFixed(2)} m)`);
const px = 640;
const py = Math.round((px * fill) / w);
const out = Buffer.alloc(px * py * 3, 20);
const scale = px / w;
for (let i = first; i < first + layout.bodies; i++) {
  const o = i * BODY_FLOATS;
  const [x, z] = [bodies[o], bodies[o + 2]];
  const [u, v] = [Math.min(0.999, uv[2 * (i - first)]), Math.min(0.999, uv[2 * (i - first) + 1])];
  const k = (Math.floor(v * ih) * iw + Math.floor(u * iw)) * 3;
  const [cx, cy, cr] = [(x + w / 2) * scale, (fill - z) * scale, r * scale];
  for (let yy = Math.floor(cy - cr); yy <= cy + cr; yy++) {
    for (let xx = Math.floor(cx - cr); xx <= cx + cr; xx++) {
      if (xx < 0 || yy < 0 || xx >= px || yy >= py || (xx - cx) ** 2 + (yy - cy) ** 2 > cr * cr) continue;
      out.set(image.subarray(k, k + 3), (yy * px + xx) * 3);
    }
  }
}
writeFileSync(outPath, out);
console.log(`picture ${px}x${py} -> ${outPath}`);
await device.queue.onSubmittedWorkDone();
process.exit(0);
