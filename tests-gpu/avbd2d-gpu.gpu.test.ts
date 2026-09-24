// The WebGPU 2D solver (the whole step on the GPU: broadphase, narrowphase, contact
// persistence, adjacency, colouring, solve) against the GPU-shaped CPU solver it was ported
// from, plus the physical behaviour checks.
//
// Exact single-step parity: the GPU is seeded with the CPU solver's full state mid-simulation
// (bodies, joints, contacts with their warm-start data, colouring), both take one step, and
// the results are diffed. Long trajectories are not compared: f32 arithmetic flips zero-gap
// contacts and chaotic scenes amplify that (docs/FINDINGS.md).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { jointLatticeSoa, pyramid } from '../src/avbd2d/bench-scenes.ts';
import { BODY_FLOATS } from '../src/avbd2d/gpu/layout.ts';
import { PrefixScan } from '../src/avbd2d/gpu/scan.ts';
import { createGpuSim } from '../src/avbd2d/gpu/sim.ts';
import { GpuSolver2D } from '../src/avbd2d/gpu/solver.ts';
import { defaultParams, parallelParams, type SolverParams, Solver } from '../src/avbd2d/ref/solver.ts';
import { sceneByName } from '../src/avbd2d/sim.ts';
import { GridBroadphase, PAIR_SHIFT } from '../src/avbd2d/soa/broadphase.ts';
import { SoaSolver2D } from '../src/avbd2d/soa/solver.ts';
import { device, gpuTest, skip } from './device.ts';

function soa(scene: string, params: SolverParams): SoaSolver2D {
  const ref = new Solver();
  Object.assign(ref, params);
  sceneByName(scene).build!(ref);
  const s = new SoaSolver2D();
  s.loadFromReference(ref);
  return s;
}

function maxPoseDiff(bodies: Float32Array, cpu: SoaSolver2D): number {
  let m = 0;
  for (let i = 0; i < cpu.bodyCount; i++) for (let k = 0; k < 3; k++) m = Math.max(m, Math.abs(bodies[i * BODY_FLOATS + k] - cpu.pose[i * 4 + k]));
  return m;
}

const cpuPairs = (cpu: SoaSolver2D): string[] =>
  [...cpu.broadphase.pairs.subarray(0, cpu.broadphase.pairCount)].map((key) => {
    const a = Math.floor(key / PAIR_SHIFT);
    return `${a}-${key - a * PAIR_SHIFT}`;
  });

// Scenes without exactly-touching boxes: the GPU must reproduce one CPU step to f32 round-off.
const EXACT_SCENES = ['Stack', 'Pyramid', 'Cards', 'Static Friction', 'Dynamic Friction', 'Fracture', 'Soft Body', 'Box Rain 40x25 (1k)'];
// Cards are 2 mm thick and weigh 0.8 g, so f32 round-off moves them the most (measured 1.1e-4).
const POSE_TOLERANCE: Record<string, number> = { Cards: 1e-3 };
// Scenes built from boxes laid exactly touching (zero gap): contacts there flicker between
// f32 and f64, so only the pair set is exact and contact counts agree to within a few.
const TOUCHING_SCENES = ['Net', 'Wrecking Ball 100x40 (4k)'];

for (const [label, params] of [['parallel params', parallelParams()], ['demo params', defaultParams()]] as const) {
  gpuTest(`seeded single step matches the CPU: poses, pairs, contacts, colours (${label})`, async (device) => {
    for (const scene of [...EXACT_SCENES, ...TOUCHING_SCENES]) {
      const exact = EXACT_SCENES.includes(scene);
      const cpu = soa(scene, params);
      let frame = 0;
      // Two states (one step is compared from each, so more add little). Not earlier than 60:
      // the touching scenes' contacts still flicker between f32 and f64 then, and so do colours.
      for (const at of [60, 120]) {
        while (frame < at) {
          cpu.step();
          frame++;
        }
        const gpu = new GpuSolver2D(device, cpu);
        gpu.seedContactsFrom(cpu);
        gpu.step();
        cpu.step();
        frame++;
        const where = `${scene} frame ${at}`;
        const [bodies, counters, pairs, colors] = await Promise.all([gpu.readBodies(), gpu.readCounters(), gpu.readPairs(), gpu.readColors()]);

        const gpuPairs: string[] = [];
        for (let k = 0; k < pairs.length; k += 2) gpuPairs.push(`${pairs[k]}-${pairs[k + 1]}`);
        assert.deepEqual(gpuPairs.sort(), cpuPairs(cpu).sort(), `${where}: pair set`);
        assert.equal(counters.overflow, 0, `${where}: overflow`);
        assert.equal(counters.clashes, 0, `${where}: colour clashes`);
        assert.equal(counters.colors, cpu.numColors, `${where}: colour count`);
        for (let i = 0; i < cpu.bodyCount; i++) {
          if (cpu.dynamic[i]) assert.equal(colors[i], cpu.coloring.colors[i], `${where}: colour of body ${i}`);
        }
        // Touching scenes: only the pair set and colours are exact; contacts flicker there
        if (exact) {
          assert.equal(counters.contacts, cpu.contactCount, `${where}: contacts`);
          const d = maxPoseDiff(bodies, cpu);
          assert.ok(d < (POSE_TOLERANCE[scene] ?? 1e-4), `${where}: pose diff ${d}`);
        }
        gpu.destroy();
      }
    }
  });
}

gpuTest('fresh GPU runs of the joint scenes track the CPU (fixed topology)', async (device) => {
  for (const scene of ['Rope', 'Heavy Rope', 'Hanging Rope', 'Spring', 'Spring Ratio', 'Rod', 'Joint Grid', 'Motor']) {
    const cpu = soa(scene, parallelParams());
    const gpu = new GpuSolver2D(device, soa(scene, parallelParams()));
    cpu.step();
    gpu.step();
    const d1 = maxPoseDiff(await gpu.readBodies(), cpu);
    assert.ok(d1 < 1e-5, `${scene}: step 1 diff ${d1}`);
    for (let i = 1; i < 60; i++) {
      cpu.step();
      gpu.step();
    }
    // Measured ≤ 1.6e-4 after 60 steps (docs/FINDINGS.md)
    const d60 = maxPoseDiff(await gpu.readBodies(), cpu);
    assert.ok(d60 < 1e-3, `${scene}: step 60 diff ${d60}`);
    gpu.destroy();
  }
});

gpuTest('GPU broadphase finds exactly the brute-force pairs, oversized bodies included', async (device) => {
  let seed = 11;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const s = new SoaSolver2D();
  for (let i = 0; i < 2000; i++) {
    const big = i % 251 === 0;
    const w = big ? 30 + rand() * 20 : 0.3 + rand() * 1.2;
    s.addBody([w, big ? 1 : 0.3 + rand() * 1.2], rand() < 0.9 ? 1 : 0, 0.5, [(rand() - 0.5) * 60, (rand() - 0.5) * 60, rand() * 6]);
  }
  s.addIgnoreCollision(1, 2);
  const gpu = new GpuSolver2D(device, s);
  gpu.step();
  const pairs = await gpu.readPairs();
  const got: string[] = [];
  for (let k = 0; k < pairs.length; k += 2) got.push(`${pairs[k]}-${pairs[k + 1]}`);
  const bp = new GridBroadphase();
  const noCollide = Float64Array.from([2 * PAIR_SHIFT + 1]);
  bp.findPairs(s.bodyCount, s.pose, s.props, s.dynamic, noCollide, 1);
  const expected = [...bp.pairs.subarray(0, bp.pairCount)].map((key) => `${Math.floor(key / PAIR_SHIFT)}-${key % PAIR_SHIFT}`);
  assert.deepEqual(got.sort(), expected.sort());
  gpu.destroy();
});

gpuTest('prefix scan matches a CPU exclusive scan at several sizes', async (device) => {
  for (const n of [1, 511, 512, 513, 5000, 300000]) {
    const input = Uint32Array.from({ length: n }, (_, i) => (i * 2654435761) % 7);
    const buffer = device.createBuffer({ size: (n + 3) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buffer, 12, input); // offset 3 elements to exercise the range offset
    const scan = new PrefixScan(device, buffer, 3, n);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    scan.encode(pass);
    pass.end();
    const read = device.createBuffer({ size: n * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    encoder.copyBufferToBuffer(buffer, 12, read, 0, n * 4);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Uint32Array(read.getMappedRange().slice(0));
    read.unmap();
    let sum = 0;
    for (let i = 0; i < n; i++) {
      assert.equal(out[i], sum, `n=${n} at ${i}`);
      sum += input[i];
    }
    scan.destroy();
    buffer.destroy();
    read.destroy();
  }
});

// --- Behaviour on the GPU (same calibrations as tests/avbd2d-behavior.test.ts) --------------

async function runGpu(scene: string, frames: number, params: Partial<SolverParams> = {}) {
  const sim = createGpuSim(device!, scene, { ...parallelParams(), ...params });
  for (let i = 0; i < frames; i++) sim.step();
  const bodies = await sim.solver.readBodies();
  const pose = (i: number) => [bodies[i * BODY_FLOATS], bodies[i * BODY_FLOATS + 1], bodies[i * BODY_FLOATS + 2]];
  return { sim, bodies, pose };
}

gpuTest('GPU: stack of 20 boxes stands and pyramid settles', async () => {
  const stack = await runGpu('Stack', 600);
  const top = stack.pose(stack.sim.bodyCount - 1);
  assert.ok(Math.abs(top[1] - 20) < 0.05 && Math.abs(top[0]) < 0.01, `top ${top}`);
  const pyr = await runGpu('Pyramid', 600);
  let maxY = -Infinity;
  for (let i = 0; i < pyr.sim.bodyCount; i++) if (pyr.sim.isDynamic(i)) maxY = Math.max(maxY, pyr.pose(i)[1]);
  assert.ok(maxY > 7.9, `pyramid top ${maxY}`);
  assert.ok((await pyr.sim.solver.readStats()).kineticEnergy < 0.05);
});

gpuTest('GPU: static friction holds the slope; Eq. 14 recovers Coulomb sliding', async () => {
  const sim = createGpuSim(device!, 'Static Friction', parallelParams());
  for (let i = 0; i < 300; i++) sim.step();
  const before = await sim.solver.readBodies();
  for (let i = 0; i < 600; i++) sim.step();
  const after = await sim.solver.readBodies();
  for (let i = 1; i < sim.bodyCount; i++) {
    const d = Math.hypot(after[i * BODY_FLOATS] - before[i * BODY_FLOATS], after[i * BODY_FLOATS + 1] - before[i * BODY_FLOATS + 1]);
    assert.ok(d < 0.005, `plank ${i} crept ${d}`);
  }
  const { pose, sim: df } = await runGpu('Dynamic Friction', 600, { stiffnessRescale: true });
  for (let i = 0; i < 10; i++) {
    const slid = pose(i + 1)[0] - (-30 + i * 2);
    const coulomb = 100 / (2 * Math.sqrt((5 - i * 0.5) * 0.5) * 10);
    assert.ok(Math.abs(slid - coulomb) / coulomb < 0.05, `box ${i}: slid ${slid}, Coulomb ${coulomb}`);
  }
  void df;
});

gpuTest('GPU: fracture breaks joints; hanging rope stays together; motor reaches speed', async () => {
  const fracture = createGpuSim(device!, 'Fracture', parallelParams());
  const joints0 = (await fracture.solver.readStats()).joints;
  for (let i = 0; i < 300; i++) fracture.step();
  assert.ok((await fracture.solver.readStats()).joints < joints0, 'expected broken joints');

  const rope = createGpuSim(device!, 'Hanging Rope', parallelParams());
  let worst = 0;
  for (let f = 0; f < 600; f += 20) {
    for (let i = 0; i < 20; i++) rope.step();
    if (f >= 60) worst = Math.max(worst, (await rope.solver.readStats()).maxJointError);
  }
  assert.ok(worst < 0.05, `rope joint error ${worst}`);

  const motor = await runGpu('Motor', 240);
  const w = motor.bodies[1 * BODY_FLOATS + 14];
  assert.ok(Math.abs(w + 20) < 0.01, `ω ${w}`);
});

gpuTest('GPU: a drag joint appended mid-run pulls, and its release lets go', async (device) => {
  const gpu = new GpuSolver2D(device, soa('Rope', parallelParams()));
  for (let i = 0; i < 30; i++) gpu.step();
  const before = await gpu.readJoints();
  const tip = gpu.bodyCount - 1;
  const slot = gpu.appendJoint(-1, tip, [14, 16], [0, 0], [1000, 1000, 0]);
  const after = await gpu.readJoints();
  assert.deepEqual(after.subarray(0, before.length), before, 'existing joint records untouched');
  // The soft drag spring swings the falling rope around the target and settles in ~4 s
  for (let i = 0; i < 240; i++) gpu.step();
  for (let f = 240; f < 600; f += 30) {
    for (let i = 0; i < 30; i++) gpu.step();
    const b = await gpu.readBodies();
    const d = Math.hypot(b[tip * BODY_FLOATS] - 14, b[tip * BODY_FLOATS + 1] - 16);
    assert.ok(d < 0.5, `tip ${d} from the drag target at frame ${f + 30}`);
  }
  gpu.disableConstraint(slot);
  for (let i = 0; i < 60; i++) gpu.step();
  const b = await gpu.readBodies();
  assert.ok(b[tip * BODY_FLOATS + 1] < 15, 'tip falls after release');
  gpu.destroy();
});

gpuTest('GPU at scale: 100k-body lattice and a 20k-box pyramid step without clashes, overflow or NaNs', async (device) => {
  const lattice = new SoaSolver2D();
  Object.assign(lattice.params, parallelParams());
  jointLatticeSoa(lattice, 320, 320);
  const ref = new Solver();
  Object.assign(ref, parallelParams());
  pyramid(ref, 200);
  const pile = new SoaSolver2D();
  pile.loadFromReference(ref);
  for (const s of [lattice, pile]) {
    const gpu = new GpuSolver2D(device, s);
    for (let i = 0; i < 120; i++) gpu.step();
    const counters = await gpu.readCounters();
    assert.equal(counters.clashes, 0);
    assert.equal(counters.overflow, 0);
    const b = await gpu.readBodies();
    for (let i = 0; i < b.length; i++) assert.ok(Number.isFinite(b[i]), `non-finite at ${i}`);
    gpu.destroy();
  }
});

test('GPU tests ran on a real adapter', { skip }, () => {});
