// The WebGPU 3D solver against the 3D CPU reference (../src/avbd3d/ref), plus the physical
// behaviour checks of tests/avbd3d-ref.test.ts run on the GPU with its own colouring.
//
// Seeded single-step parity: the GPU gets the reference's full state mid-simulation (bodies,
// joints and contacts with their warm-start data) and one colour per body in the reference's
// Gauss-Seidel order, both take one step, and the results are diffed. f32 against f64 can
// break a tie differently (a box lying flat on a box: both faces give the same separation),
// giving the same contact points under other feature keys; the contact geometry is then
// still compared, but the poses are not, since the warm start of those contacts is lost.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BODY_FLOATS, J_PEN_LIN } from '../src/avbd3d/gpu/layout.ts';
import { createGpuSim3D, GpuSim3D } from '../src/avbd3d/gpu/sim.ts';
import { GpuSolver3D, gpuParams3D } from '../src/avbd3d/gpu/solver.ts';
import { starryNight } from '../src/avbd3d/painting.ts';
import { monaLisaTower, towerLayout } from '../src/avbd3d/tower.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { collide } from '../src/avbd3d/ref/collide.ts';
import { IgnoreCollision } from '../src/avbd3d/ref/forces.ts';
import { Manifold } from '../src/avbd3d/ref/manifold.ts';
import { mat3, qnormalize, quat, rotate, vec3 } from '../src/avbd3d/ref/math.ts';
import { sceneByName, scenePyramid } from '../src/avbd3d/ref/scenes.ts';
import { sphere } from '../src/avbd3d/shapes.ts';
import { breakableWall, chainMail, heavyPendulum, wallSmash } from '../src/avbd3d/bench-scenes.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { device, gpuTest, skip } from './device.ts';

const dist = (x: number[], y: ArrayLike<number>) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);

// Scenes with at most 64 dynamic bodies (one colour each)
const PARITY_SCENES = ['Ground', 'Dynamic Friction', 'Static Friction', 'Rope', 'Heavy Rope', 'Spring', 'Spring Ratio', 'Stack', 'Stack Ratio', 'Breakable'];

gpuTest('seeded single step matches the CPU reference: contacts and poses', async (device) => {
  let tieFrames = 0;
  for (const scene of PARITY_SCENES) {
    const ref = new Solver();
    sceneByName(scene).build(ref);
    let frame = 0;
    for (const at of [60, 120, 300]) {
      while (frame < at) {
        ref.step();
        frame++;
      }
      const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
      // The reference's exact rules: strict feature matching, the demo's edge/face choice
      gpu.params.matchNearest = false;
      gpu.params.faceBias = false;
      gpu.params.reuseContacts = false;
      gpu.params.startAtRest = false;
      gpu.params.massPenalty = false;
      gpu.seedFrom(ref);
      gpu.fixedColors = gpu.sequentialColors();
      gpu.step();
      ref.step();
      frame++;
      const where = `${scene} frame ${at}`;
      const [bodies, counters, contacts] = await Promise.all([gpu.readBodies(), gpu.readCounters(), gpu.readContactList()]);
      assert.equal(counters.overflow, 0, `${where}: overflow`);

      // Contact geometry: every reference contact between bodies that can move is found at
      // the same point, and nothing else is (the reference also keeps static-static manifolds)
      let keysMatch = true;
      let expected = 0;
      for (const m of ref.forces) {
        if (!(m instanceof Manifold) || (m.bodyA!.mass <= 0 && m.bodyB.mass <= 0)) continue;
        const a = ref.bodies.indexOf(m.bodyA!);
        const b = ref.bodies.indexOf(m.bodyB);
        for (const c of m.contacts) {
          expected++;
          const g = contacts.find((k) => k.a === a && k.b === b && dist(k.rA, c.rA) < 1e-4 && dist(k.rB, c.rB) < 1e-4);
          assert.ok(g, `${where}: contact ${a}-${b} at ${[...c.rA]} not found on the GPU`);
          if (g.feature !== c.feature >>> 0) keysMatch = false;
          else {
            const scale = Math.max(1, Math.abs(c.lambda[0]));
            for (let r = 0; r < 3; r++) assert.ok(Math.abs(g.lam[r] - c.lambda[r]) < 1e-3 * scale, `${where}: contact ${a}-${b} lambda ${g.lam} vs ${[...c.lambda]}`);
          }
        }
      }
      assert.equal(contacts.length, expected, `${where}: contact count`);

      if (!keysMatch) {
        tieFrames++;
      } else {
        let d = 0;
        ref.bodies.forEach((body, i) => {
          for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + k] - body.positionLin[k]));
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + 4 + k] - body.positionAng[k]));
        });
        // Measured ≤ 2.7e-6 (docs/FINDINGS.md)
        assert.ok(d < 1e-5, `${where}: pose diff ${d}`);
      }
      gpu.destroy();
    }
  }
  // Only Dynamic Friction's flat boxes tie (frames 60 and 120)
  assert.ok(tieFrames <= 2, `${tieFrames} frames with feature ties`);
});

gpuTest('narrowphase finds the reference contacts for randomly posed box pairs', async (device) => {
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const ref = new Solver();
  const q = quat();
  // Pairs of boxes (far apart from other pairs), overlapping by construction
  for (let p = 0; p < 300; p++) {
    const base = [(p % 20) * 20, Math.floor(p / 20) * 20, 0];
    for (let k = 0; k < 2; k++) {
      const size = [0.4 + rand() * 1.6, 0.4 + rand() * 1.6, 0.4 + rand() * 1.6];
      const offset = k === 0 ? [0, 0, 0] : [(rand() - 0.5) * 1.2, (rand() - 0.5) * 1.2, (rand() - 0.5) * 1.2];
      const body = new Rigid(ref, size, 1, 0.5, [base[0] + offset[0], base[1] + offset[1], base[2] + offset[2]]);
      body.positionAng.set(qnormalize(q, [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5]));
    }
  }
  const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
  gpu.params.iterations = 0;
  gpu.params.gravity = 0;
  gpu.params.faceBias = false;
  gpu.step();
  const contacts = await gpu.readContactList();
  let expected = 0;
  let featureMismatches = 0;
  const basis = mat3();
  for (let p = 0; p < 300; p++) {
    const a = ref.bodies[2 * p + 1];
    const b = ref.bodies[2 * p];
    const cpu = collide(a, b, basis);
    const mine = contacts.filter((c) => c.a === 2 * p + 1 && c.b === 2 * p);
    expected += cpu.length;
    assert.equal(mine.length, cpu.length, `pair ${p}: contact count`);
    for (const c of cpu) {
      const g = mine.find((k) => dist(k.rA, c.rA) < 1e-3 && dist(k.rB, c.rB) < 1e-3);
      assert.ok(g, `pair ${p}: contact at ${[...c.rA]} missing`);
      if (g.feature !== c.feature >>> 0) featureMismatches++;
    }
  }
  assert.equal(contacts.length, expected);
  // Random poses have no exact ties
  assert.equal(featureMismatches, 0);
  gpu.destroy();
});

gpuTest('GPU broadphase finds exactly the pairs whose spheres, AABBs and face axes overlap, ignored pairs excluded', async (device) => {
  let seed = 11;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const ref = new Solver();
  for (let i = 0; i < 3000; i++) {
    const big = i % 499 === 0;
    const s = big ? [30, 30, 1] : [0.3 + rand(), 0.3 + rand(), 0.3 + rand()];
    const body = new Rigid(ref, s, rand() < 0.9 ? 1 : 0, 0.5, [(rand() - 0.5) * 40, (rand() - 0.5) * 40, (rand() - 0.5) * 40]);
    if (!big) body.positionAng.set(qnormalize(quat(), [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5]));
  }
  new IgnoreCollision(ref, ref.bodies[2], ref.bodies[1]);
  const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
  gpu.params.iterations = 0;
  gpu.step();
  const pairs = await gpu.readPairs();
  const got: string[] = [];
  for (let k = 0; k < pairs.length; k += 2) got.push(`${pairs[k]}-${pairs[k + 1]}`);
  const expected: string[] = [];
  const B = ref.bodies;
  // World AABB half extents |R|·h
  const half = B.map((body) => {
    const h = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const e = [0, 0, 0];
      e[k] = body.size[k] * 0.5;
      const w = rotate(vec3(), body.positionAng, e);
      for (let c = 0; c < 3; c++) h[c] += Math.abs(w[c]);
    }
    return h;
  });
  // World axes, for the face-axis test (separated by more than 1 mm along a face normal)
  const axes = B.map((body) => [0, 1, 2].map((k) => rotate(vec3(), body.positionAng, [0, 1, 2].map((c) => (c === k ? 1 : 0)))));
  const dot = (u: ArrayLike<number>, v: ArrayLike<number>) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const extent = (i: number, n: ArrayLike<number>) => [0, 1, 2].reduce((e, k) => e + B[i].size[k] * 0.5 * Math.abs(dot(n, axes[i][k])), 0);
  for (let i = 0; i < B.length; i++) {
    for (let j = 0; j < i; j++) {
      if (B[i].mass <= 0 && B[j].mass <= 0) continue;
      if (i === 2 && j === 1) continue;
      const delta = [0, 1, 2].map((k) => B[i].positionLin[k] - B[j].positionLin[k]);
      const d = Math.hypot(delta[0], delta[1], delta[2]);
      const apart = [0, 1, 2].some((k) => Math.abs(delta[k]) > half[i][k] + half[j][k]);
      const faceApart = [...axes[i], ...axes[j]].some((n) => Math.abs(dot(delta, n)) - extent(i, n) - extent(j, n) > 1e-3);
      if (d <= B[i].radius + B[j].radius && !apart && !faceApart) expected.push(`${i}-${j}`);
    }
  }
  assert.deepEqual(got.sort(), expected.sort());
  gpu.destroy();
});

// --- Behaviour on the GPU (calibrations of tests/avbd3d-ref.test.ts) --------------------------

async function runGpu(scene: string, frames: number): Promise<GpuSim3D> {
  const sim = createGpuSim3D(device!, scene);
  for (let i = 0; i < frames; i++) sim.step();
  await sim.sync();
  return sim;
}

/** Position of the reference's body i (the GPU stores bodies in spatial order). */
const at = (sim: GpuSim3D, i: number) => sim.position(sim.solver.gpuIndex(i));

const speed = (b: Float32Array, i: number) => Math.hypot(b[i * BODY_FLOATS + 32], b[i * BODY_FLOATS + 33], b[i * BODY_FLOATS + 34]);

// Standing after 5 s: at rest height, not drifting, and only easing out of the landing (a few
// cm/s; a collapse moves at m/s). The exact rest state is checked on the CPU reference.
gpuTest('GPU: stack and pyramid stand', async () => {
  const stack = await runGpu('Stack', 300);
  const b = await stack.solver.readBodies();
  for (let i = 1; i < stack.bodyCount; i++) {
    const p = at(stack, i);
    assert.ok(Math.abs(p[2] - i) < 0.02 * i, `box ${i} z ${p[2]}`);
    assert.ok(Math.hypot(p[0], p[1]) < 1e-3, `box ${i} drifted`);
    const v = speed(b, stack.solver.gpuIndex(i));
    assert.ok(v < 0.1, `box ${i} speed ${v}`);
  }
  stack.destroy();

  // Settles as the CPU reference does: at 10 iterations the 16 courses end 0.23 m short of
  // resting exactly (7.75), and the reference's top brick is at 7.523 after 300 frames (bit-
  // identical to upstream). A bad landing (colouring cap overflow) left it near 7.16, then fell.
  const pyr = await runGpu('Pyramid', 300);
  const top = at(pyr, pyr.bodyCount - 1);
  assert.ok(Math.abs(top[2] - 7.523) < 0.05, `top z ${top[2]} (reference 7.523)`);
  const pb = await pyr.solver.readBodies();
  for (let i = 0; i < pyr.bodyCount; i++) assert.ok(speed(pb, i) < 0.1, `brick ${i} speed ${speed(pb, i)}`);
  assert.equal(pyr.stats().clashes, 0);
  pyr.destroy();

  // A colour cap too small for the landing bricks is reported as clashes (so adapt grows it),
  // not hidden by committing neighbours to the same last colour
  const tight = createGpuSim3D(device!, 'Pyramid');
  tight.solver.colorCap = 2;
  for (let i = 0; i < 60; i++) tight.solver.step();
  const counters = await tight.solver.readCounters();
  assert.ok(counters.clashes > 0, `clashes ${counters.clashes} with ${counters.colors} colours in a cap of 2`);
  tight.destroy();
});


gpuTest('GPU: dynamic friction follows Coulomb; static friction holds above tan 30°', async () => {
  const df = await runGpu('Dynamic Friction', 300);
  for (let i = 0; i < 11; i++) {
    const slid = at(df, i + 1)[0];
    if (i === 10) {
      assert.ok(Math.abs(slid - 50) < 1e-3, `frictionless box slid ${slid}`);
      continue;
    }
    const mu = Math.sqrt((5 - i * 0.5) * 0.5);
    const expected = 100 / (2 * mu * 10);
    assert.ok(Math.abs(slid - expected) / expected < 0.15, `box ${i}: slid ${slid}, Coulomb ${expected}`);
  }
  df.destroy();

  const sf = await runGpu('Static Friction', 600);
  const xs = Array.from({ length: 11 }, (_, i) => at(sf, i + 2)[0]);
  for (let f = 0; f < 120; f++) sf.step();
  await sf.sync();
  for (let i = 0; i < 11; i++) {
    const mu = Math.sqrt((i / 10) * 0.25 + 0.25);
    const p = at(sf, i + 2);
    if (mu > Math.tan(Math.PI / 6) + 0.01) {
      assert.ok(p[2] > 7, `box ${i} (mu ${mu.toFixed(3)}) left the ramp`);
      assert.ok(Math.abs(p[0] - xs[i]) < 0.005, `box ${i} creeps ${p[0] - xs[i]}`);
    } else if (mu < Math.tan(Math.PI / 6) - 0.01) {
      assert.ok(p[2] < 1.5, `box ${i} (mu ${mu.toFixed(3)}) is still on the ramp`);
    }
  }
  sf.destroy();
});

gpuTest('GPU: spring equilibrium, joints hold, breakable fractures', async () => {
  // Undamped: the mean over whole periods (T = 2π√(m/k) = 106.6 frames; 6 periods) from the
  // start is the equilibrium, no settling needed
  const spring = await runGpu('Spring', 0);
  let sum = 0;
  for (let f = 0; f < 640; f += 20) {
    await spring.sync();
    sum += at(spring, 2)[2];
    for (let i = 0; i < 20; i++) spring.step();
  }
  assert.ok(Math.abs(sum / 32 - 9.2) < 0.05, `spring mean z ${sum / 32}`);
  spring.destroy();

  for (const [scene, bound, frames] of [
    ['Rope', 0.02, 240],
    ['Heavy Rope', 0.03, 600],
    ['Bridge', 0.03, 240],
  ] as const) {
    const sim = await runGpu(scene, frames);
    const err = sim.stats().maxJointError;
    assert.ok(err > 0 && err < bound, `${scene}: joint error ${err}`);
    sim.destroy();
  }

  const breakable = await runGpu('Breakable', 1);
  assert.equal(breakable.stats().joints, 10);
  for (let i = 0; i < 120; i++) breakable.step();
  await breakable.sync();
  const left = breakable.stats().joints;
  assert.ok(left > 0 && left < 10, `${left} joints left`);
  breakable.destroy();
});

gpuTest('GPU: a drag joint pulls a box to the target, and shot boxes join the simulation', async () => {
  const sim = await runGpu('Ground', 120);
  const hit = sim.pick([0, -10, 1], [0, 1, 0]);
  assert.ok(hit && hit.body === sim.solver.gpuIndex(1), 'ray picks the box');
  sim.startDrag(hit.body, hit.local, [3, 2, 4]);
  for (let i = 0; i < 300; i++) sim.step();
  await sim.sync();
  // The grabbed point hangs just below the target (soft drag spring, box weight)
  const p = at(sim, 1);
  assert.ok(Math.hypot(p[0] - 3, p[1] - 2) < 0.6 && Math.abs(p[2] - 4) < 1, `box at ${Array.from(p)}`);
  sim.endDrag();
  sim.addBox([1, 1, 1], 1, 0.5, [0, 0, 8], [0, 0, 0]);
  for (let i = 0; i < 300; i++) sim.step();
  await sim.sync();
  assert.equal(sim.bodyCount, 3);
  assert.ok(at(sim, 1)[2] < 1.1 && at(sim, 2)[2] < 2.1 && at(sim, 2)[2] > 0.9, 'both boxes back on the ground');
  sim.destroy();
});

// A 40-row pyramid collapses on the CPU reference too (the rows start 0.35 apart and drop onto
// each other; 10 iterations cannot hold it), so this only checks the machinery at scale.
gpuTest('GPU at scale: an 820-brick pyramid steps without clashes, overflow or NaNs', async (device) => {
  const ref = new Solver();
  scenePyramid(ref, 40);
  const sim = new GpuSim3D(new GpuSolver3D(device, ref));
  for (let i = 0; i < 300; i++) sim.step();
  await sim.sync();
  const counters = await sim.solver.readCounters();
  assert.equal(counters.clashes, 0);
  assert.equal(counters.overflow, 0);
  const b = await sim.solver.readBodies();
  for (let i = 0; i < b.length; i++) assert.ok(Number.isFinite(b[i]), `non-finite at ${i}`);
  sim.destroy();
});

test('3D GPU tests ran on a real adapter', { skip }, () => {});

// --- Stage 8: spheres, face-biased SAT, showcase scenes ---------------------------------------

gpuTest('GPU spheres rest, stack, and roll without slipping', async (device) => {
  const s = new Solver();
  new Rigid(s, [100, 100, 1], 0, 0.5, [0, 0, 0]); // top face at z = 0.5
  sphere(s, 0.5, 1, 0.5, [0, 0, 3]); // 1: on the ground
  new Rigid(s, [1, 1, 1], 1, 0.5, [5, 0, 1]); // 2: box
  sphere(s, 0.5, 1, 0.5, [5, 0, 3]); // 3: on the box
  sphere(s, 0.5, 1, 0.5, [-5, 0, 1.2]); // 4: under a box
  new Rigid(s, [0.6, 0.6, 0.6], 1, 0.5, [-5, 0, 2.5]); // 5: on the sphere
  sphere(s, 0.5, 1, 0.5, [10, 0, 1.01], [3, 0, 0]); // 6: launched sliding
  const sim = new GpuSim3D(new GpuSolver3D(device, s));
  const rolling = async () => {
    const b = await sim.solver.readBodies();
    const i = sim.solver.gpuIndex(6);
    return { v: b[i * BODY_FLOATS + 32], w: b[i * BODY_FLOATS + 37] };
  };
  // Sliding friction turns 3 m/s of sliding into rolling at 5/7 of it (solid sphere), within
  // 2v/(7μg) = 0.17 s
  for (let i = 0; i < 60; i++) sim.step();
  const early = await rolling();
  assert.ok(Math.abs(early.v - (5 / 7) * 3) < 0.05, `rolling speed ${early.v}`);
  assert.ok(Math.abs(early.w * 0.5 - early.v) < 0.02, `slip ${early.w * 0.5 - early.v}`);
  for (let i = 0; i < 540; i++) sim.step();
  await sim.sync();
  // Resting contacts sit about one collision margin deep, as with boxes
  const z = (i: number) => at(sim, i)[2];
  assert.ok(Math.abs(z(1) - 1) < 0.02, `sphere on ground z ${z(1)}`);
  assert.ok(Math.abs(z(3) - 2) < 0.04, `sphere on box z ${z(3)}`);
  assert.ok(Math.abs(z(5) - 1.8) < 0.04, `box on sphere z ${z(5)}`);
  assert.ok(Math.abs(z(6) - 1) < 0.02, `rolling sphere z ${z(6)}`);
  // Still rolling without slip; a small numerical rolling resistance costs ~1% speed per
  // second (measured 2.14 -> 1.94 m/s over 9 s; docs/FINDINGS.md)
  const late = await rolling();
  assert.ok(late.v > 0.85 * early.v && late.v < early.v, `speed after 9 s ${late.v}`);
  assert.ok(Math.abs(late.w * 0.5 - late.v) < 0.02, `slip ${late.w * 0.5 - late.v}`);
  sim.destroy();
});

gpuTest('face-biased SAT lets the Breakable scene settle (the demo rule leaves a box jittering)', async () => {
  for (const [faceBias, settles] of [
    [true, true],
    [false, false],
  ] as const) {
    const sim = createGpuSim3D(device!, 'Breakable', { faceBias });
    for (let i = 0; i < 600; i++) sim.step();
    await sim.sync();
    const ke = sim.stats().kineticEnergy;
    assert.equal(ke < 1e-4, settles, `faceBias ${faceBias}: KE ${ke}`);
    sim.destroy();
  }
});

gpuTest('showcase scenes run clean: wall smash, breakable wall, chain mail, heavy pendulum', async (device) => {
  const run = async (build: (s: Solver) => void, frames: number) => {
    const ref = new Solver();
    build(ref);
    const sim = new GpuSim3D(new GpuSolver3D(device, ref));
    for (let i = 0; i < frames; i++) {
      sim.step();
      if (i % 60 === 59) await sim.sync();
    }
    await sim.sync();
    const counters = await sim.solver.readCounters();
    assert.equal(counters.overflow, 0);
    assert.equal(counters.clashes, 0);
    const b = await sim.solver.readBodies();
    for (let i = 0; i < b.length; i++) assert.ok(Number.isFinite(b[i]), `non-finite at ${i}`);
    return sim;
  };
  const last = (sim: GpuSim3D) => at(sim, sim.bodyCount - 1);

  // The ball goes through the wall
  const smash = await run((s) => wallSmash(s), 120);
  assert.ok(last(smash)[1] > 10, `ball y ${last(smash)[1]}`);
  smash.destroy();

  // The breakable wall stands under its own weight, and the ball breaks joints
  const wall = await run((s) => breakableWall(s), 180);
  assert.ok(wall.stats().joints < 30 * 19 + 29 * 20, `${wall.stats().joints} joints left`);
  wall.destroy();

  // Chain mail catches a ball ~16000x heavier than a link, well above the ground
  const mail = await run((s) => chainMail(s), 300);
  assert.ok(last(mail)[2] > 6, `ball z ${last(mail)[2]}`);
  assert.ok(mail.stats().maxJointError < 0.15, `chain mail stretch ${mail.stats().maxJointError}`);
  mail.destroy();

  // 50-link pendulum with a 50000:1 end mass holds together while swinging
  const pendulum = await run((s) => heavyPendulum(s), 300);
  assert.ok(pendulum.stats().maxJointError < 0.15, `pendulum joint error ${pendulum.stats().maxJointError}`);
  assert.equal(pendulum.stats().joints, 51);
  pendulum.destroy();
});

// The painting scene's trick needs its runs to repeat exactly: two runs through GpuSim3D (the
// emitter spawning spheres, readbacks in between) end with every body in the same place, to
// the bit. A small painting (3k spheres) keeps it quick.
gpuTest('a picture scene runs identically twice (painting.ts)', async (device) => {
  const options = { bodies: 3000 };
  const steps = starryNight.picture!.steps(options);
  const run = async () => {
    const sim = createGpuSim3D(device, starryNight.name, { ...gpuParams3D(), ...(starryNight.params as (o: object) => object)(options) }, undefined, options);
    for (let s = 0; s < steps; s++) sim.step();
    const bodies = await sim.solver.readBodies();
    const counters = await sim.solver.readCounters();
    sim.destroy();
    return { bodies: new Uint32Array(bodies.buffer), counters, count: sim.bodyCount, emitted: sim.bodyCount - sim.firstEmitted };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.count, b.count);
  assert.equal(a.emitted, 3000, 'every sphere poured');
  assert.equal(a.counters.overflow, 0, 'fixed storage never overflowed');
  let differ = 0;
  for (let i = 0; i < a.bodies.length; i++) if (a.bodies[i] !== b.bodies[i]) differ++;
  assert.equal(differ, 0, `${differ} words differ between the runs`);
});

// The tower's picture needs the same of a collapse: a smaller tower coming down under its own
// weight repeats to the bit, well into the fall, within its fixed storage. 20k bricks: a much
// shorter tower mostly holds itself up.
gpuTest('a collapsing tower runs identically twice (tower.ts)', async (device) => {
  const options = { bricks: 20_000 };
  const layout = towerLayout(options.bricks);
  const run = async () => {
    const sim = createGpuSim3D(device, monaLisaTower.name, { ...gpuParams3D(), ...(monaLisaTower.params as object) }, undefined, options);
    for (let s = 0; s < 360; s++) sim.step();
    const bodies = await sim.solver.readBodies();
    const counters = await sim.solver.readCounters();
    sim.destroy();
    return { bodies, counters, count: sim.bodyCount };
  };
  const a = await run();
  const b = await run();
  assert.equal(a.count, b.count);
  assert.equal(a.counters.overflow, 0, 'fixed storage never overflowed');
  let top = 0;
  for (let i = 1; i < a.count; i++) top = Math.max(top, a.bodies[i * BODY_FLOATS + 2]);
  assert.ok(top < 0.75 * 0.5 * layout.courses, `the tower is falling (highest brick ${top.toFixed(1)} m of ${0.5 * layout.courses} m)`);
  const [x, y] = [new Uint32Array(a.bodies.buffer), new Uint32Array(b.bodies.buffer)];
  let differ = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) differ++;
  assert.equal(differ, 0, `${differ} words differ between the runs`);
});

// Runtime destruction: a fixed body turned loose mid-run (rewriteBodies) falls,
// and joints appended to also break on linear force (appendJoints, not in the paper) part when
// the pair lands, where torque-only joints (the paper's) hold a square landing.
gpuTest('a fixed pair let loose falls, and linear-fracture joints part on landing', async (device) => {
  const land = async (linear: boolean) => {
    const ref = new Solver();
    new Rigid(ref, [20, 20, 1], 0, 0.5, [0, 0, -0.5]);
    new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 6]);
    new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 7]);
    const solver = new GpuSolver3D(device, ref);
    const [a, b] = [solver.gpuIndex(1), solver.gpuIndex(2)];
    for (let k = 0; k < 10; k++) solver.step();
    const scratch = new Solver();
    solver.rewriteBodies([a, b].sort((x, y) => x - y), [a, b].sort((x, y) => x - y).map((i) => new Rigid(scratch, [1, 1, 1], 1, 0.5, [0, 0, i === a ? 6 : 7])));
    solver.appendJoints([{ a, b, rA: [0, 0, 0.5], rB: [0, 0, -0.5] }], 20, linear);
    for (let k = 0; k < 90; k++) solver.step();
    const [bodies, joints] = [await solver.readBodies(), await solver.readJoints()];
    solver.destroy();
    return { z: bodies[a * BODY_FLOATS + 2], stiffness: joints[J_PEN_LIN + 3] };
  };
  const linear = await land(true);
  const angular = await land(false);
  assert.ok(linear.z < 1, `the loosened box fell (z ${linear.z.toFixed(2)})`);
  assert.equal(linear.stiffness, 0, 'the linear-fracture joint broke on landing');
  assert.ok(angular.stiffness > 0, 'the torque-only joint held');
});

// Released joints (releaseJoints) stop acting and stop excluding their pair from collision, and
// appendJoints fills the released slots before growing the joint count: a destruction demo's rubble
// freezes joints all the time, and the count must not grow with every blast
gpuTest('released joints let go, their pair collides again, and their slots are reused', async (device) => {
  const ref = new Solver();
  new Rigid(ref, [20, 20, 1], 0, 0.5, [0, 0, -0.5]);
  // Two stacks: a box on a box. The lower boxes are fixed; each upper box hangs from a joint
  // 0.5 above its rest (held in the air by the joint alone)
  for (const x of [0, 5]) {
    new Rigid(ref, [1, 1, 1], 0, 0.5, [x, 0, 0.5]);
    new Rigid(ref, [1, 1, 1], 1, 0.5, [x, 0, 2]);
  }
  const solver = new GpuSolver3D(device, ref);
  const [lowA, upA, lowB, upB] = [1, 2, 3, 4].map((i) => solver.gpuIndex(i));
  const first = solver.appendJoints(
    [
      { a: lowA, b: upA, rA: [0, 0, 0.5], rB: [0, 0, -1] },
      { a: lowB, b: upB, rA: [0, 0, 0.5], rB: [0, 0, -1] },
    ],
    1e9,
  );
  assert.deepEqual(first, [0, 1], 'fresh slots');
  for (let k = 0; k < 30; k++) solver.step();
  let bodies = await solver.readBodies();
  assert.ok(bodies[upA * BODY_FLOATS + 2] > 1.8, `joint A holds its box up (z ${bodies[upA * BODY_FLOATS + 2].toFixed(2)})`);
  // Release A's joint: its box drops onto the fixed box (a released pair collides), B's stays up
  solver.releaseJoints([0, 0, 7]);
  for (let k = 0; k < 90; k++) solver.step();
  bodies = await solver.readBodies();
  const zA = bodies[upA * BODY_FLOATS + 2];
  const zB = bodies[upB * BODY_FLOATS + 2];
  assert.ok(Math.abs(zA - 1.5) < 0.1, `the released box rests on the fixed one (z ${zA.toFixed(2)})`);
  assert.ok(zB > 1.8, `the other joint still holds (z ${zB.toFixed(2)})`);
  // A new joint takes the released slot; the count does not grow
  const count = solver.jointCount;
  const reused = solver.appendJoints([{ a: lowA, b: upA, rA: [0, 0, 0.5], rB: [0, 0, -0.5] }], 1e9);
  assert.deepEqual(reused, [0], 'the released slot is reused');
  assert.equal(solver.jointCount, count, 'the joint count did not grow');
  const grown = solver.appendJoints([{ a: lowB, b: upB, rA: [0, 0, 0.5], rB: [0, 0, -1] }], 1e9);
  assert.deepEqual(grown, [count], 'with no slot free, the count grows');
  for (let k = 0; k < 30; k++) solver.step();
  bodies = await solver.readBodies();
  assert.ok(Math.abs(bodies[upA * BODY_FLOATS + 2] - 1.5) < 0.1, 'the reused joint holds the box where it lay');
  solver.destroy();
});

// The colour cap never passes MAX_COLORS: the indirect arguments hold that many colours. A
// dense pile whose colouring clashed near the limit once shrank the cap to colours in use plus
// spares, past the buffer's end: every step's commands were invalid and the simulation froze.
gpuTest('the colour cap stays within the indirect arguments when colouring near the limit', async (device) => {
  const ref = new Solver();
  scenePyramid(ref);
  const solver = new GpuSolver3D(device, ref);
  const busy = { pairs: 100, contacts: 400, manifolds: 100, overflow: 0 };
  // Clashes double the colouring rounds, then quiet readbacks near the limit vote to shrink
  solver.adapt({ ...busy, clashes: 3, colors: 62 });
  for (let k = 0; k < 4; k++) solver.adapt({ ...busy, clashes: 0, colors: 62 });
  assert.ok(solver.colorCap <= 64, `colour cap ${solver.colorCap}`);
  solver.step();
  await device.queue.onSubmittedWorkDone();
  solver.destroy();
});

// Up is a parameter: y by default (Three.js), z when seeded from the reference (its scenes are
// z-up). A free box in a y-up solver falls along -y only.
gpuTest('gravity pulls against the up axis (y-up by default, z when seeded from the reference)', async (device) => {
  const ref = new Solver();
  new Rigid(ref, [1, 1, 1], 1, 0.5, [0, 5, 0]);
  const solver = new GpuSolver3D(device, ref);
  assert.deepEqual(gpuParams3D().up, [0, 1, 0], 'y-up by default');
  assert.deepEqual(solver.params.up, [0, 0, 1], 'seeded from the reference: z-up');
  solver.params.up = [0, 1, 0];
  for (let k = 0; k < 30; k++) solver.step();
  const bodies = await solver.readBodies();
  const [x, y, z] = bodies.subarray(0, 3);
  // Half a second of free fall at -10: 1.25 m
  assert.ok(Math.abs(y - (5 - 1.25)) < 0.1, `y ${y}`);
  assert.ok(Math.abs(x) < 1e-5 && Math.abs(z) < 1e-5, `x ${x}, z ${z}`);
  solver.destroy();
});
