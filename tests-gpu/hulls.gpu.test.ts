// Convex hull shapes on the GPU solver (../src/avbd3d/hull.ts, ../src/avbd3d/gpu/wgsl-hull.ts):
// hulls resting on boxes, on each other and under spheres, against the box path they generalise.
// z is up (the solver's frame), gravity -10.

import assert from 'node:assert/strict';
import { B_POS, B_ROT, BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { convexHull, hull, sphere, type HullShape } from '../src/avbd3d/shapes.ts';
import { gpuTest } from './device.ts';

function boxPoints(w: number, d: number, h: number): number[] {
  const out: number[] = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-d / 2, d / 2]) for (const z of [-h / 2, h / 2]) out.push(x, y, z);
  return out;
}

/** Ground: a static 20 × 20 × 1 box, its top at z = 0. */
function scene(): Solver {
  const ref = new Solver();
  new Rigid(ref, [20, 20, 1], 0, 0.6, [0, 0, -0.5]);
  return ref;
}

async function run(solver: GpuSolver3D, steps: number): Promise<Float32Array> {
  for (let i = 0; i < steps; i++) solver.step();
  return solver.readBodies();
}

const pos = (b: Float32Array, i: number) => [...b.subarray(i * BODY_FLOATS + B_POS, i * BODY_FLOATS + B_POS + 3)];
const rot = (b: Float32Array, i: number) => [...b.subarray(i * BODY_FLOATS + B_ROT, i * BODY_FLOATS + B_ROT + 4)];

function rotate(q: number[], v: number[]): number[] {
  const [x, y, z, w] = q;
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

/** Lowest world z of a hull body's vertices. */
function lowest(b: Float32Array, i: number, shape: HullShape): number {
  const p = pos(b, i);
  const q = rot(b, i);
  let low = Infinity;
  for (let k = 0; k < shape.vertices.length; k += 3) low = Math.min(low, rotate(q, [shape.vertices[k], shape.vertices[k + 1], shape.vertices[k + 2]])[2] + p[2]);
  return low;
}

gpuTest('hulls are on where the device allows a ninth storage buffer', async (device) => {
  const solver = new GpuSolver3D(device, scene());
  assert.equal(solver.hulls, device.limits.maxStorageBuffersPerShaderStage >= 9);
  assert.ok(solver.hulls, 'the test device requests the adapter limit');
  solver.destroy();
});

gpuTest('a box-shaped hull rests on the ground where the same box does', async (device) => {
  const ref = scene();
  const shape = convexHull(boxPoints(1, 0.6, 0.4))!;
  hull(ref, shape, 1, 0.6, [-2, 0, 1]);
  new Rigid(ref, [1, 0.6, 0.4], 1, 0.6, [2, 0, 1]);
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  const b = await run(solver, 180);
  // Principal axes of a 1 × 0.6 × 0.4 box: its size is (1, 0.6, 0.4) up to order; resting flat
  assert.ok(Math.abs(pos(b, 1)[2] - pos(b, 2)[2]) < 2e-3, `hull ${pos(b, 1)[2]} box ${pos(b, 2)[2]}`);
  assert.ok(Math.abs(pos(b, 1)[0] + 2) < 1e-2 && Math.abs(pos(b, 1)[1]) < 1e-2, 'it did not slide');
  solver.destroy();
});

gpuTest('a box-shaped hull topples onto a face exactly as the box does', async (device) => {
  // Tipped 30° so it lands on an edge and falls over: the contact on the landing face must keep
  // its feature keys (warm starts, static-friction anchors) from step to step, as boxes do
  const ref = scene();
  const q = [Math.sin(Math.PI / 12), 0, 0, Math.cos(Math.PI / 12)];
  new Rigid(ref, [1, 1, 1], 1, 0.6, [0, 0, 1.2]).positionAng.set(q);
  hull(ref, convexHull(boxPoints(1, 1, 1))!, 1, 0.6, [3, 0, 1.2], q);
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  const b = await run(solver, 90);
  const box = pos(b, 1);
  const shape = pos(b, 2);
  assert.ok(Math.abs(shape[0] - 3) < 1e-3 && Math.abs(shape[1] - box[1]) < 5e-3 && Math.abs(shape[2] - box[2]) < 5e-3, `box ${box} hull ${shape}`);
  solver.destroy();
});

gpuTest('hulls added to a running solver collide (a tetrahedron that lands on an edge first)', async (device) => {
  const ref = scene();
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  await run(solver, 5);
  const tetra = convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])!;
  const scratch = new Solver();
  const first = solver.addBodies([hull(scratch, tetra, 1, 0.6, [0, 0, 1]), hull(scratch, convexHull(boxPoints(0.5, 0.5, 0.5))!, 1, 0.6, [2, 0, 1])]);
  const b = await run(solver, 300);
  const low = lowest(b, first, tetra);
  assert.ok(low > -0.03 && low < 0.03, `tetrahedron's lowest vertex at ${low}`);
  assert.ok(Math.abs(pos(b, first + 1)[2] - 0.24) < 0.02, `cube at ${pos(b, first + 1)[2]}`);
  solver.destroy();
});

gpuTest('a tetrahedron falls onto a face and stays; a sphere rests on a hull slab', async (device) => {
  const ref = scene();
  const tetra = convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])!;
  // Tipped so it lands on a corner first
  hull(ref, tetra, 2, 0.6, [0, 0, 1.2], [0.3, 0.2, 0.1, 0.927]);
  const slab = convexHull([...boxPoints(1.2, 1.2, 0.2), 0.7, 0, 0.1, -0.7, 0, 0.1])!; // a slab with a ridge
  hull(ref, slab, 0, 0.6, [3, 0, 0.1]);
  sphere(ref, 0.2, 1, 0.5, [3, 0, 1.5]);
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  let b = await run(solver, 300);
  const settled = pos(b, 1);
  b = await run(solver, 60);
  assert.ok(Math.hypot(...pos(b, 1).map((v, k) => v - settled[k])) < 2e-3, 'the tetrahedron has settled');
  const low = lowest(b, 1, tetra);
  assert.ok(low > -0.03 && low < 0.03, `lowest vertex at ${low}`);
  // Face down: one face's normal points straight down
  const q = rot(b, 1);
  assert.ok(tetra.faces.some((f) => rotate(q, f.normal)[2] < -0.999), 'resting on a face');
  // The sphere sits on the ridge top (0.1 + 0.1 up) or the slab (0.2), within the margin
  const s = pos(b, 3)[2];
  assert.ok(s > 0.38 && s < 0.45, `sphere at ${s}`);
  solver.destroy();
});

gpuTest('a pile of irregular hulls comes to rest on the ground and on each other', async (device) => {
  const ref = scene();
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const shapes: HullShape[] = [];
  for (let i = 0; i < 24; i++) {
    const points: number[] = [];
    for (let k = 0; k < 14; k++) points.push(rnd() * 0.3, rnd() * 0.2, rnd() * 0.25);
    const shape = convexHull(points)!;
    shapes.push(shape);
    hull(ref, shape, 1, 0.6, [(i % 4) * 0.25 - 0.4, Math.floor(i / 12) * 0.3, 0.4 + Math.floor((i % 12) / 4) * 0.45], [rnd() * 0.5, rnd() * 0.5, 0, 1].map((v, _, a) => v / Math.hypot(...a)));
  }
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  const b = await run(solver, 480);
  let fastest = 0;
  const after = await run(solver, 30);
  shapes.forEach((shape, i) => {
    const low = lowest(b, i + 1, shape);
    assert.ok(low > -0.03, `hull ${i} sank to ${low}`);
    assert.ok(pos(b, i + 1).every(Number.isFinite));
    fastest = Math.max(fastest, Math.hypot(...pos(after, i + 1).map((v, k) => v - pos(b, i + 1)[k])) / 0.5);
  });
  assert.ok(fastest < 0.05, `still moving at ${fastest} m/s`);
  // Something rests on something else (not all on the ground)
  assert.ok(shapes.some((shape, i) => lowest(b, i + 1, shape) > 0.05), 'the hulls pile up');
  solver.destroy();
});

gpuTest('without hulls, a hull collides as its bounding box', async (device) => {
  const ref = scene();
  const tetra = convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1])!;
  hull(ref, tetra, 1, 0.6, [0, 0, 1]);
  const solver = new GpuSolver3D(device, ref, { spatialSort: false, hulls: false });
  const b = await run(solver, 240);
  // Resting on its bounding box: centre half its box height up (any face of the box down)
  assert.ok(tetra.size.some((s) => Math.abs(pos(b, 1)[2] - s / 2) < 0.02), `at ${pos(b, 1)[2]}`);
  solver.destroy();
});
