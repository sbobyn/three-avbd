// Headless run of the Mona Lisa tower (src/avbd3d/tower.ts): knocks it down, reports timing and
// the peak contact storage it used, and writes the rubble seen from above, coloured by the
// picture, as raw RGB. Run from the repo root:
//   node --experimental-transform-types tools/tower-preview.ts <image.rgb> <imgW> <imgH> [bricks] [out.rgb] [twice]
import { readFileSync, writeFileSync } from 'node:fs';
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const { createGpuSim3D } = await import('../src/avbd3d/gpu/sim.ts');
const { gpuParams3D } = await import('../src/avbd3d/gpu/solver.ts');
const { B_POS, B_SIZE, BODY_FLOATS } = await import('../src/avbd3d/gpu/layout.ts');
const { monaLisaTower, rubbleCoords, rubblePicture, rubbleSurround, towerLayout } = await import('../src/avbd3d/tower.ts');

const [imagePath, iwArg, ihArg, bricksArg = '50000', outPath = 'tower.rgb', twice] = process.argv.slice(2);
const [iw, ih] = [Number(iwArg), Number(ihArg)];
const image = readFileSync(imagePath);
const options = { bricks: Number(bricksArg) };
const layout = towerLayout(options.bricks);
console.log(`tower: radius ${layout.radius} m, ${layout.courses} courses (${(0.5 * layout.courses).toFixed(0)} m), ${layout.bricks} bricks, ${layout.steps} steps`);

const gpu = create([]);
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice({
  requiredLimits: { maxStorageBufferBindingSize: adapter!.limits.maxStorageBufferBindingSize, maxBufferSize: adapter!.limits.maxBufferSize },
});
(globalThis as { __keep?: unknown }).__keep = [gpu, adapter, device];

async function run(): Promise<{ bodies: Float32Array; count: number }> {
  const sim = createGpuSim3D(device, monaLisaTower.name, { ...gpuParams3D(), ...(monaLisaTower.params as object) }, undefined, options);
  sim.readbackEvery = Number.MAX_SAFE_INTEGER;
  const peak = { pairs: 0, manifolds: 0, contacts: 0, colors: 0, overflow: 0, clashes: 0 };
  const t0 = performance.now();
  for (let s = 0; s < layout.steps; s++) {
    sim.step();
    if (s % 30 === 29) {
      const c = await sim.solver.readCounters();
      for (const k of ['pairs', 'manifolds', 'contacts', 'colors', 'clashes'] as const) peak[k] = Math.max(peak[k], c[k]);
      peak.overflow |= c.overflow;
    }
  }
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;
  const n = sim.bodyCount;
  console.log(`${(ms / 1000).toFixed(1)} s (${(ms / layout.steps).toFixed(2)} ms/step); peak per brick: pairs ${(peak.pairs / n).toFixed(1)}, manifolds ${(peak.manifolds / n).toFixed(1)}, contacts ${(peak.contacts / n).toFixed(1)}; colours ${peak.colors}, clashes ${peak.clashes}, overflow ${peak.overflow}`);
  const bodies = await sim.solver.readBodies();
  sim.destroy();
  return { bodies, count: n };
}

const a = await run();
if (twice) {
  const b = await run();
  const [x, y] = [new Uint32Array(a.bodies.buffer), new Uint32Array(b.bodies.buffer)];
  let differ = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
  console.log(differ === 0 ? 'second run: IDENTICAL' : `second run: ${differ} words differ`);
}

// Rubble from above, coloured by the picture
const index: number[] = [];
for (let i = 0; i < a.count; i++) if (a.bodies[i * BODY_FLOATS + B_SIZE + 3] > 0) index.push(i);
const p = new Float32Array(3 * index.length);
index.forEach((i, k) => p.set(a.bodies.subarray(i * BODY_FLOATS + B_POS, i * BODY_FLOATS + B_POS + 3), 3 * k));
const uv = rubbleCoords(p);
console.log('picture', rubblePicture(p));
let [minX, maxX, minY, maxY, maxZ] = [Infinity, -Infinity, Infinity, -Infinity, 0];
for (let k = 0; k < index.length; k++) {
  [minX, maxX] = [Math.min(minX, p[3 * k]), Math.max(maxX, p[3 * k])];
  [minY, maxY] = [Math.min(minY, p[3 * k + 1]), Math.max(maxY, p[3 * k + 1])];
  maxZ = Math.max(maxZ, p[3 * k + 2]);
}
console.log(`rubble spans x ${minX.toFixed(0)}..${maxX.toFixed(0)}, y ${minY.toFixed(0)}..${maxY.toFixed(0)}, heap ${maxZ.toFixed(1)} m high`);
// Top-down: draw low to high so the top brick of each spot wins
const order = [...index.keys()].sort((i, j) => p[3 * i + 2] - p[3 * j + 2]);
const span = 140;
const px = 560;
const out = Buffer.alloc(px * px * 3, 240);
for (const k of order) {
  const [x, y] = [p[3 * k], p[3 * k + 1]];
  const [cx, cy] = [((x + span / 2) / span) * px, ((span / 2 - y) / span) * px];
  const [u, v] = [uv[2 * k], uv[2 * k + 1]];
  const off = u < 0 || u > 1 || v < 0 || v > 1;
  const s = rubbleSurround(u, v);
  const c = (Math.min(ih - 1, Math.floor(v * ih)) * iw + Math.min(iw - 1, Math.floor(u * iw))) * 3;
  const rgb = off ? Buffer.from([s >> 16, (s >> 8) & 255, s & 255]) : image.subarray(c, c + 3);
  for (let yy = Math.floor(cy - 1.5); yy <= cy + 1.5; yy++) {
    for (let xx = Math.floor(cx - 1.5); xx <= cx + 1.5; xx++) {
      if (xx >= 0 && yy >= 0 && xx < px && yy < px) out.set(rgb, (yy * px + xx) * 3);
    }
  }
}
writeFileSync(outPath, out);
console.log(`top-down ${px}x${px} (${span} m square) -> ${outPath}`);
await device.queue.onSubmittedWorkDone();
process.exit(0);
