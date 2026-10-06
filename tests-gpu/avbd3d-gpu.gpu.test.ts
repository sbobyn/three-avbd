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
import { BODY_FLOATS, J_PEN_ANG, J_PEN_LIN } from '../src/avbd3d/gpu/layout.ts';
import { decodeJoint } from '../src/avbd3d/gpu/joints.ts';
import { createGpuSim3D, GpuSim3D } from '../src/avbd3d/gpu/sim.ts';
import { GpuSolver3D, gpuParams3D } from '../src/avbd3d/gpu/solver.ts';
import { starryNight } from '../src/avbd3d/painting.ts';
import { monaLisaTower, towerLayout } from '../src/avbd3d/tower.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { collide } from '../src/avbd3d/ref/collide.ts';
import { IgnoreCollision, Joint } from '../src/avbd3d/ref/forces.ts';
import { Manifold } from '../src/avbd3d/ref/manifold.ts';
import { lengthSq, mat3, qmul, qnormalize, quat, rotate, vec3 } from '../src/avbd3d/ref/math.ts';
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

// --- Per-joint thresholds, rest rotations, plastic joints ------------------------------------------

/** What `readJoints` says of each slot's joint: broken, its forces, and how far (degrees) it has bent from the rest it started with. */
async function jointsOf(solver: GpuSolver3D, slots: number[]) {
  const raw = await solver.readJoints();
  return slots.map((slot) => {
    const { broken, bend, linear, angular } = decodeJoint(raw, slot);
    return { broken, linear, angular, bend: (bend * 180) / Math.PI };
  });
}

// One appendJoints call, five hanging 1 kg boxes (10 N on each joint): a joint's own fracture and
// linear override the call's (5, torque only), and a joint that names neither takes the call's
gpuTest('appendJoints: each joint carries its own break threshold, over the call\'s', async (device) => {
  const ref = new Solver();
  const hooks = [0, 1, 2, 3, 4].map((k) => new Rigid(ref, [1, 1, 1], 0, 0.5, [4 * k, 0, 5]));
  const boxes = [0, 1, 2, 3, 4].map((k) => new Rigid(ref, [1, 1, 1], 1, 0.5, [4 * k, 0, 4]));
  const solver = new GpuSolver3D(device, ref);
  const at = (k: number) => ({ a: solver.gpuIndex(ref.bodies.indexOf(hooks[k])), b: solver.gpuIndex(ref.bodies.indexOf(boxes[k])), rA: [0, 0, -0.5], rB: [0, 0, 0.5] });
  const slots = solver.appendJoints(
    [
      { ...at(0), fracture: 2, linear: true }, // pulled by 10 N: breaks
      { ...at(1), fracture: 1e9, linear: true }, // holds
      { ...at(2) }, // the call's 5, on torque alone (a straight hang has none): holds
      { ...at(3), linear: true }, // the call's 5, on pull too: breaks
      { ...at(4), fracture: Infinity, linear: true }, // never breaks
    ],
    5,
  );
  for (let k = 0; k < 60; k++) solver.step();
  const states = await jointsOf(solver, slots);
  assert.deepEqual(states.map((j) => j.broken), [true, false, false, true, false], 'only the weak joints broke');
  const bodies = await solver.readBodies();
  const z = (k: number) => bodies[solver.gpuIndex(ref.bodies.indexOf(boxes[k])) * BODY_FLOATS + 2];
  assert.ok(z(0) < 0 && z(3) < 0, `the broken ones' boxes fell: ${z(0).toFixed(1)}, ${z(3).toFixed(1)}`);
  for (const k of [1, 2, 4]) assert.ok(Math.abs(z(k) - 4) < 0.1, `box ${k} still hangs: z ${z(k).toFixed(2)}`);
  // A spec that can't be taken is refused whole, before any slot is: a yield needs a rigid angle lock, and a rest a rotation
  const count = solver.jointCount;
  assert.throws(() => solver.appendJoints([{ ...at(0) }, { ...at(1), angular: 0, yield: 1 }]), /yield needs a rigid angle lock/);
  assert.throws(() => solver.appendJoints([{ ...at(1), yield: -1 }]), /yield is a force/);
  assert.throws(() => solver.appendJoints([{ ...at(1), rest: [0, 0, 0, 0] }]), /rotation/);
  // ...a ball joint has no angle lock to hold a rest, and the sign of a threshold is the flag for `linear`
  assert.throws(() => solver.appendJoints([{ ...at(0) }, { ...at(1), angular: 0, rest: [0, 0, 0, 1] }]), /rest needs an angle lock/);
  assert.throws(() => solver.appendJoints([{ ...at(0) }, { ...at(1), fracture: -5 }]), /fracture is a force of at least 0/);
  assert.throws(() => solver.appendJoints([{ ...at(1) }], -5), /fracture is a force of at least 0/);
  assert.throws(() => solver.appendJoints([{ ...at(1), fracture: NaN }]), /fracture is a force of at least 0/);
  // ...a bend limit is an angle from 0 to π (a joint cannot bend more than π, so a larger limit could never be
  // reached), and needs a joint that yields (else it could never bend)
  for (const breakBend of [-0.1, NaN, -Infinity, Math.PI + 0.001, 4, 100]) {
    assert.throws(() => solver.appendJoints([{ ...at(1), yield: 5, breakBend }]), /appendJoints: breakBend is an angle from 0 to π \(rad\)/, `breakBend ${breakBend}`);
  }
  assert.throws(() => solver.appendJoints([{ ...at(1), breakBend: 0.5 }]), /breakBend limits how far a plastic joint bends: it needs a yield/);
  assert.throws(() => solver.appendJoints([{ ...at(1), yield: Infinity, breakBend: 0.5 }]), /needs a yield/);
  assert.equal(solver.jointCount, count, 'no slot was taken');
  // π is the most a joint can bend, 0 breaks it at its first give, and Infinity says never: all three are taken
  assert.equal(solver.appendJoints([{ ...at(1), yield: 5, breakBend: Math.PI }, { ...at(1), yield: 5, breakBend: 0 }, { ...at(1), yield: 5, breakBend: Infinity }]).length, 3);
  // The held joints read the pull they carry: the box's weight, 10 N
  assert.ok(Math.abs(states[1].linear - 10) < 1 && Math.abs(states[4].linear - 10) < 1, `carrying ${states[1].linear.toFixed(1)} N, ${states[4].linear.toFixed(1)} N`);
  solver.destroy();
});

// appendConstraints took the freed slots and counted the new ones before it read the spec's bodies, so an
// index that names no body threw a TypeError with them gone: a freed slot lost, the joint count up. The
// bodies are checked with the rest of the spec, before anything is taken
gpuTest('appendJoints: a body index that names no body is refused whole, leaving the joint count and the freed slots as they were', async (device) => {
  const ref = new Solver();
  const hooks = [0, 1].map((k) => new Rigid(ref, [1, 1, 1], 0, 0.5, [4 * k, 0, 5]));
  const boxes = [0, 1].map((k) => new Rigid(ref, [1, 1, 1], 1, 0.5, [4 * k, 0, 4]));
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  const at = (k: number) => ({ a: ref.bodies.indexOf(hooks[k]), b: ref.bodies.indexOf(boxes[k]), rA: [0, 0, -0.5], rB: [0, 0, 0.5] });
  // Two joints hang the boxes, and the first is released: its slot is free for the next append
  const [first] = solver.appendJoints([at(0), at(1)]);
  solver.releaseJoints([first]);
  const count = solver.jointCount;
  const info = Array.from(solver.jointInfo());
  const n = solver.bodyCount;
  // An index past the bodies, below zero, a fraction, NaN, Infinity, none at all: each refused, as either end of a spec
  // (one that comes after a good spec leaves that one untaken too)
  for (const bad of [n, n + 100, -1, 0.5, NaN, Infinity, undefined as unknown as number]) {
    assert.throws(() => solver.appendJoints([at(0), { ...at(1), b: bad }]), /appendJoints: spec 1: b must be the index of a body in the solver/, `b ${bad}`);
    assert.throws(() => solver.appendJoints([{ ...at(1), a: bad }]), /appendJoints: spec 0: a must be the index of a body in the solver/, `a ${bad}`);
  }
  assert.equal(solver.jointCount, count, 'no slot was taken');
  assert.deepEqual(Array.from(solver.jointInfo()), info, 'and no joint was written');
  // The freed slot is still free: the next append takes it, and the joint works
  assert.deepEqual(solver.appendJoints([at(0)]), [first], 'the freed slot was not used up');
  assert.equal(solver.jointCount, count);
  for (let k = 0; k < 60; k++) solver.step();
  const bodies = await solver.readBodies();
  for (const k of [0, 1]) {
    const z = bodies[ref.bodies.indexOf(boxes[k]) * BODY_FLOATS + 2];
    assert.ok(Math.abs(z - 4) < 0.1, `box ${k} hangs from its joint: z ${z.toFixed(2)}`);
  }
  solver.destroy();
});

/** Two unit boxes in free fall, B turned 30° from A, both spinning, joined at a face by one fixed joint with this `rest` (or not). */
async function turnedPair(device: GPUDevice, options: { rest: boolean; flip?: boolean; aTurned?: boolean }): Promise<number[]> {
  const mul = (a: number[], b: number[]) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const turn = (angle: number, axis: number[]) => {
    const l = Math.hypot(...axis);
    return [...axis.map((x) => (x / l) * Math.sin(angle / 2)), Math.cos(angle / 2)];
  };
  const conj = (q: number[]) => [-q[0], -q[1], -q[2], q[3]];
  const qa = options.aTurned ? turn(0.9, [0.2, -0.5, 0.7]) : [0, 0, 0, 1];
  const qr = turn(Math.PI / 6, [0.3, 0.8, 0.5]);
  const qb = mul(qa, qr);
  const rotate = (q: number[], v: number[]) => {
    const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
    return [v[0] + q[3] * t[0] + (q[1] * t[2] - q[2] * t[1]), v[1] + q[3] * t[1] + (q[2] * t[0] - q[0] * t[2]), v[2] + q[3] * t[2] + (q[0] * t[1] - q[1] * t[0])];
  };
  const ref = new Solver();
  const a = new Rigid(ref, [1, 1, 1], 1, 0.5, [0, 0, 10]);
  a.positionAng.set(qa);
  // B's centre, so that A's anchor (0.5, 0, 0) and B's (-0.5, 0, 0) are one point
  const [pa, pb] = [rotate(qa, [0.5, 0, 0]), rotate(qb, [0.5, 0, 0])];
  const b = new Rigid(ref, [1, 1, 1], 1, 0.5, [pa[0] + pb[0], pa[1] + pb[1], 10 + pa[2] + pb[2]]);
  b.positionAng.set(options.flip ? qb.map((x) => -x) : qb);
  a.velocityAng.set([1, 2, 3]);
  b.velocityAng.set([1, 2, 3]);
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  solver.appendJoints([{ a: 0, b: 1, rA: [0.5, 0, 0], rB: [-0.5, 0, 0], rest: options.rest ? mul(conj(qa), qb) : undefined }]);
  // The angle between the two, after 10, 30 and 60 steps
  const angles: number[] = [];
  for (let step = 1; step <= 60; step++) {
    solver.step();
    if (step === 10 || step === 30 || step === 60) {
      const bodies = await solver.readBodies();
      const d = mul(conj([...bodies.subarray(4, 8)]), [...bodies.subarray(BODY_FLOATS + 4, BODY_FLOATS + 8)]);
      angles.push((2 * Math.acos(Math.min(1, Math.abs(d[3]))) * 180) / Math.PI);
    }
  }
  solver.destroy();
  return angles;
}

// three-destruction's measurement: a fixed joint twists two bodies placed 30° apart toward equal,
// 27°, 22° and 16° after 10, 30 and 60 steps (a hull's frame is its principal frame, so the pieces
// of a building are turned from each other); with the rest, they keep the turn
gpuTest('a joint\'s rest rotation holds two bodies turned apart (30° through free fall and tumbling), where the default twists them', async (device) => {
  for (const aTurned of [false, true]) {
    const twisted = await turnedPair(device, { rest: false, aTurned });
    [27.07, 22.07, 16.28].forEach((angle, k) => assert.ok(Math.abs(twisted[k] - angle) < 0.5, `default, step ${[10, 30, 60][k]}: ${twisted[k].toFixed(2)}° (was ${angle}°)`));
    const held = await turnedPair(device, { rest: true, aTurned });
    held.forEach((angle, k) => assert.ok(Math.abs(angle - 30) < 0.05, `rest, step ${[10, 30, 60][k]}: ${angle.toFixed(3)}°`));
  }
  // The same turn held with either sign of B's quaternion (q and -q are one rotation)
  const flipped = await turnedPair(device, { rest: true, aTurned: true, flip: true });
  flipped.forEach((angle, k) => assert.ok(Math.abs(angle - 30) < 0.05, `rest, B negated, step ${[10, 30, 60][k]}: ${angle.toFixed(3)}°`));
});

/**
 * A cantilever on the GPU (z up): a fixed wall, four links of 1 m and a weight on the end, welded with
 * appendJoints. The weld at the wall is the one that yields and breaks; `weight` 0: none.
 */
function cantileverOn(device: GPUDevice, weight: number, root: { yield?: number; fracture?: number; linear?: boolean; breakBend?: number }) {
  const ref = new Solver();
  const wall = new Rigid(ref, [1, 1, 1], 0, 0.5, [-0.5, 0, 5]);
  const links = [0, 1, 2, 3].map((i) => new Rigid(ref, [1, 0.3, 0.3], 1, 0.5, [i + 0.5, 0, 5]));
  const block = weight > 0 ? new Rigid(ref, [0.6, 0.6, 0.6], weight / 0.216, 0.5, [4.3, 0, 5]) : null;
  const solver = new GpuSolver3D(device, ref, { spatialSort: false });
  const index = (b: Rigid) => solver.gpuIndex(ref.bodies.indexOf(b));
  const chain = [wall, ...links];
  const slots = solver.appendJoints(
    chain.slice(1).map((link, k) => ({
      a: index(chain[k]),
      b: index(link),
      rA: k === 0 ? [0.5, 0, 0] : [0.5, 0, 0],
      rB: [-0.5, 0, 0],
      ...(k === 0 ? root : {}),
    })),
  );
  const load = block ? solver.appendJoints([{ a: index(links[3]), b: index(block), rA: [0.5, 0, 0], rB: [-0.3, 0, 0] }])[0] : -1;
  /** How far the first link has turned down about y, degrees. */
  const bend = async () => {
    const q = (await solver.readBodies()).subarray(index(links[0]) * BODY_FLOATS + 4, index(links[0]) * BODY_FLOATS + 8);
    return (2 * Math.atan2(q[1], q[3]) * 180) / Math.PI;
  };
  return { solver, slots, load, bend };
}

gpuTest('a plastic joint: holds a light load rigidly, bends under a heavy one and stays bent when the load goes', async (device) => {
  const yieldForce = 60;
  // 2 kg out at 4.3 m asks about 12 of the weld: it holds, and no rest moves
  const light = cantileverOn(device, 2, { yield: yieldForce });
  for (let k = 0; k < 300; k++) light.solver.step();
  const [held] = await jointsOf(light.solver, [light.slots[0]]);
  assert.ok(held.bend < 0.5 && (await light.bend()) < 1, `no bend under a light load: ${held.bend}°`);
  light.solver.destroy();

  // 12 kg asks about 70, past the yield of 60: it bends, carries no more than 60, and holds the bend
  const heavy = cantileverOn(device, 12, { yield: yieldForce });
  let carried = 0;
  for (let k = 0; k < 600; k++) {
    heavy.solver.step();
    if (k % 10 === 0) carried = Math.max(carried, (await jointsOf(heavy.solver, [heavy.slots[0]]))[0].angular);
  }
  const loaded = await heavy.bend();
  const [yielded] = await jointsOf(heavy.solver, [heavy.slots[0]]);
  assert.ok(loaded > 25, `bent under the load: ${loaded.toFixed(1)}°`);
  assert.ok(Math.abs(yielded.bend - loaded) < 2, `and the rest it holds is the bend: ${yielded.bend.toFixed(1)}°`);
  assert.ok(carried <= yieldForce * 1.0001 && carried > 0.8 * yieldForce, `it carried the yield and no more: ${carried.toFixed(2)}`);
  // The weight is cut loose: the beam stays as it is
  heavy.solver.releaseJoints([heavy.load]);
  for (let k = 0; k < 300; k++) heavy.solver.step();
  const unloaded = await heavy.bend();
  assert.ok(Math.abs(unloaded - loaded) < 0.5, `bent ${loaded.toFixed(1)}° with the load, ${unloaded.toFixed(1)}° without`);
  assert.ok(unloaded > 25, 'and still bent');
  heavy.solver.destroy();

  // The demo's joint under the same load: no bend
  const rigid = cantileverOn(device, 12, {});
  for (let k = 0; k < 600; k++) rigid.solver.step();
  assert.ok((await rigid.bend()) < 3, `a joint with no yield holds: ${(await rigid.bend()).toFixed(1)}°`);
  rigid.solver.destroy();
});

gpuTest('a plastic joint still breaks above its fracture: on its pull, and a fracture below the yield wins', async (device) => {
  // 40 kg hangs 400 N on the weld: it yields, and tears past 300 N
  const torn = cantileverOn(device, 40, { yield: 60, fracture: 300, linear: true });
  for (let k = 0; k < 120; k++) torn.solver.step();
  assert.ok((await jointsOf(torn.solver, [torn.slots[0]]))[0].broken, 'torn off the wall');
  torn.solver.destroy();
  // A fracture below the yield: it breaks before it gives
  const brittle = cantileverOn(device, 20, { yield: 100, fracture: 60 });
  for (let k = 0; k < 120; k++) brittle.solver.step();
  const [state] = await jointsOf(brittle.solver, [brittle.slots[0]]);
  assert.ok(state.broken && state.bend < 0.5, `broke without bending: ${state.bend.toFixed(2)}°`);
  brittle.solver.destroy();
});

/**
 * Steps the solver, reading the joint in `slot` after each, until it breaks (up to `max` steps): the
 * step it broke in (0: it did not), the most angular force it ever carried, and how far (rad) it had bent.
 */
async function untilBroken(solver: GpuSolver3D, slot: number, max: number) {
  let seen = 0;
  for (let step = 1; step <= max; step++) {
    solver.step();
    const state = decodeJoint(await solver.readJoints(), slot);
    seen = Math.max(seen, state.angular);
    if (state.broken) return { step, seen, bend: state.bend };
  }
  return { step: 0, seen, bend: decodeJoint(await solver.readJoints(), slot).bend };
}

// A hinge that gives has its force cut back to its yield every iteration, so a fracture above the
// yield sees only a sudden jump: 15 kg asks 87 of a weld yielding at 60, and the dual never sees more
// than 60. A bend limit is what a load that keeps bending it tears it with (docs/FINDINGS.md)
gpuTest('breakBend: a plastic joint under a sustained overload bends, then breaks at its bend limit; a fracture above its yield never sees the load; a lighter load bends less and holds', async (device) => {
  const limit = 0.6; // rad, 34.4°
  const unlimited = cantileverOn(device, 15, { yield: 60, fracture: 120 });
  const free = await untilBroken(unlimited.solver, unlimited.slots[0], 300);
  assert.ok(free.step === 0 && free.seen <= 60 * 1.0001, `with no bend limit it holds, seeing a force of ${free.seen.toFixed(1)}`);
  assert.ok(free.bend > 1.2, `swung to ${((free.bend * 180) / Math.PI).toFixed(0)}°, far past the limit`);
  unlimited.solver.destroy();

  // It breaks as the bend passes the limit (within the turn of an iteration), the force at the yield
  const heavy = cantileverOn(device, 15, { yield: 60, fracture: 120, breakBend: limit });
  const torn = await untilBroken(heavy.solver, heavy.slots[0], 300);
  assert.ok(torn.step > 0, 'the overload tears it');
  assert.ok(torn.bend > limit && torn.bend < limit + 0.01, `at ${((torn.bend * 180) / Math.PI).toFixed(2)}° of bend, the limit being ${((limit * 180) / Math.PI).toFixed(2)}°`);
  assert.ok(torn.seen <= 60 * 1.0001, `a force of ${torn.seen.toFixed(1)}, below its fracture of 120`);
  heavy.solver.destroy();

  // 8 kg asks 47: it gives a little when it lands, bends less than the limit and holds
  const light = cantileverOn(device, 8, { yield: 60, fracture: 120, breakBend: limit });
  const held = await untilBroken(light.solver, light.slots[0], 300);
  assert.ok(held.step === 0 && held.bend > 0 && held.bend < limit / 2, `bent ${((held.bend * 180) / Math.PI).toFixed(1)}° and holds`);
  light.solver.destroy();
});

// The reference is the oracle for what a joint does (single-step diffs; long runs diverge, f32 and
// colouring): so the sustained overload runs on both, from one scene, and the step a joint breaks in
// and the bend it has then are compared. Measured: the same step (or one apart) and 0.2° of bend
gpuTest('a plastic cantilever under a sustained overload breaks at its bend limit on the GPU in the step the reference does (the limit and the rest it started with travel through writeJoint)', async (device) => {
  const limit = 0.6;
  for (const [weight, breaks] of [[8, false], [12, true], [15, true], [20, true]] as const) {
    const ref = new Solver();
    let [prev, anchor] = [new Rigid(ref, [1, 1, 1], 0, 0.5, [-0.5, 0, 5]), [0.5, 0, 0]];
    let root!: Joint;
    for (let i = 0; i < 4; i++) {
      const link = new Rigid(ref, [1, 0.3, 0.3], 1, 0.5, [i + 0.5, 0, 5]);
      const joint = new Joint(ref, prev, link, anchor, [-0.5, 0, 0], Infinity, Infinity, i === 0 ? 120 : Infinity);
      if (i === 0) {
        joint.yield = 60;
        joint.breakBend = limit;
        root = joint;
      }
      [prev, anchor] = [link, [0.5, 0, 0]];
    }
    new Joint(ref, prev, new Rigid(ref, [0.6, 0.6, 0.6], weight / 0.216, 0.5, [4.3, 0, 5]), anchor, [-0.3, 0, 0], Infinity, Infinity);
    const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
    let [cpuStep, gpuStep, gpuBend] = [0, 0, 0];
    for (let step = 1; step <= 150; step++) {
      ref.step();
      gpu.step();
      if (!cpuStep && root.broken) cpuStep = step;
      const state = decodeJoint(await gpu.readJoints(), 0);
      if (!gpuStep && state.broken) gpuStep = step;
      gpuBend = state.bend;
    }
    const where = `${weight} kg`;
    assert.equal(cpuStep > 0, breaks, `${where}: the reference ${breaks ? 'breaks' : 'holds'} (step ${cpuStep})`);
    assert.equal(gpuStep > 0, breaks, `${where}: the GPU ${breaks ? 'breaks' : 'holds'} (step ${gpuStep})`);
    if (breaks) assert.ok(Math.abs(cpuStep - gpuStep) <= 3, `${where}: broke in step ${gpuStep} on the GPU, ${cpuStep} in the reference`);
    for (const [name, bend] of [['reference', root.bend], ['GPU', gpuBend]] as const) {
      assert.ok(breaks ? bend > limit && bend < limit + 0.01 : bend > 0 && bend < limit / 2, `${where}: the ${name} has bent ${((bend * 180) / Math.PI).toFixed(2)}°`);
    }
    assert.ok(Math.abs(gpuBend - root.bend) < 0.01, `${where}: bent ${((gpuBend * 180) / Math.PI).toFixed(2)}° on the GPU, ${((root.bend * 180) / Math.PI).toFixed(2)}° in the reference`);
    gpu.destroy();
  }
});

// What a joint starts with is the rest its bend is measured from (J_REST_START): a joint made with
// a rest, appendJoints' `rest`, has bent from it, not from no turn
gpuTest('a plastic joint made with a rest measures its bend from that rest, and breaks on that bend (appendJoints keeps the rest it started with)', async (device) => {
  const h = (25 * Math.PI) / 360;
  const start = [Math.sin(h), 0, 0, Math.cos(h)];
  // B turned 25° about x from A and held there by the rest, spinning about y: it gives a little
  const run = async (breakBend: number | undefined) => {
    const ref = new Solver();
    ref.gravity = 0;
    new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 5]);
    const b = new Rigid(ref, [1, 1, 1], 10, 0.5, [0.5 + 0.5 * Math.cos(2 * h), -0.5 * Math.sin(2 * h), 5]);
    b.positionAng.set(start);
    b.velocityAng.set([0, 10, 0]);
    const solver = new GpuSolver3D(device, ref, { spatialSort: false });
    solver.params.gravity = 0;
    const [slot] = solver.appendJoints([{ a: 0, b: 1, rA: [0.5, 0, 0], rB: [-0.5, 0, 0], rest: start, yield: 30, breakBend }]);
    for (let k = 0; k < 3; k++) solver.step();
    const state = decodeJoint(await solver.readJoints(), slot);
    solver.destroy();
    return state;
  };
  const free = await run(undefined);
  assert.ok(!free.broken && free.bend > 0.02 && free.bend < 0.25, `it has given ${((free.bend * 180) / Math.PI).toFixed(1)}° from its rest (it is turned 25° from none)`);
  const within = await run(free.bend * 1.5);
  assert.ok(!within.broken, 'within a limit above that bend it holds (measured from no turn, the 25° would have broken it)');
  const past = await run(free.bend / 2);
  assert.ok(past.broken, 'past a limit below it breaks');
});

// A joint given an error it can't correct within its yield takes it as the bend. The step's
// reference error (C0, Eq. 18) moves with the rest: kept, it would pull the new rest's error back
// each step, and the bodies spun away (measured, docs/FINDINGS.md)
gpuTest('a plastic joint whose bodies start off its rest takes the offset as its bend, as a rigid one slowly corrects it', async (device) => {
  const offset = async (yieldForce: number) => {
    const ref = new Solver();
    new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 5]);
    const b = new Rigid(ref, [1, 1, 1], 1, 0.5, [1, 0, 5]);
    // 20° about y from the identity rest
    b.positionAng.set([0, Math.sin(Math.PI / 18), 0, Math.cos(Math.PI / 18)]);
    const solver = new GpuSolver3D(device, ref, { spatialSort: false });
    solver.params.gravity = 0;
    const [slot] = solver.appendJoints([{ a: 0, b: 1, rA: [0.5, 0, 0], rB: [-0.5, 0, 0], yield: yieldForce }]);
    for (let k = 0; k < 120; k++) solver.step();
    const q = (await solver.readBodies()).subarray(BODY_FLOATS + 4, BODY_FLOATS + 8);
    const [state] = await jointsOf(solver, [slot]);
    solver.destroy();
    return { angle: (2 * Math.atan2(q[1], q[3]) * 180) / Math.PI, bend: state.bend, carried: state.angular };
  };
  const plastic = await offset(0.05);
  assert.ok(plastic.angle > 18 && plastic.angle < 21, `B stays turned: ${plastic.angle.toFixed(2)}°`);
  assert.ok(Math.abs(plastic.bend - plastic.angle) < 0.5, `as the rest it holds: ${plastic.bend.toFixed(2)}°`);
  assert.ok(plastic.carried <= 0.05 * 1.001, `with no more than the yield: ${plastic.carried}`);
  const rigid = await offset(Infinity);
  assert.ok(rigid.angle < 12 && rigid.bend < 0.01, `a rigid joint corrects it, slowly: ${rigid.angle.toFixed(2)}°`);
});

// The GPU's dual makes the CPU reference's decisions on a joint asked for a lot at once. A heavy
// box spinning at 10 rad/s about y is held by a joint whose angular penalty is 100 (a stiff linear
// one, as after a long load): the force asked is 54 on the first iteration and settles at 82. The
// reference is the oracle for what a joint does past its yield and its fracture, and in which
// order, and for how the penalty ramps while it gives; the last case holds a turned pair by its rest.
// A joint that gives is 3.285° bent (0.0573 rad) from the rest it started with after the step: the
// bend limits 0.065 and 0.05 either side of it say whether it holds or breaks, as the reference's do.
gpuTest('seeded single step: plastic, breaking and rest joints match the CPU reference (yield, fracture, bend limit, the rest it moves)', async (device) => {
  const cases: { name: string; yield: number; fracture: number; rest?: number[]; breakBend?: number; breaks?: boolean; bend?: [number, number] }[] = [
    { name: 'rigid', yield: Infinity, fracture: Infinity },
    { name: 'yields', yield: 30, fracture: Infinity },
    { name: 'fracture below the force asked, yield below it too', yield: 30, fracture: 40 },
    { name: 'yield above the force asked', yield: 200, fracture: Infinity },
    { name: 'yields between yield and fracture', yield: 30, fracture: 200 },
    { name: 'yields within its bend limit', yield: 30, fracture: 200, breakBend: 0.065, breaks: false, bend: [0.05, 0.065] },
    { name: 'yields past its bend limit: breaks', yield: 30, fracture: 200, breakBend: 0.05, breaks: true },
    { name: 'a bend limit on a joint that does not yield', yield: 200, fracture: Infinity, breakBend: 0, breaks: false },
    // B starts turned 25° about x from A's frame and the rest says so (no error, no yield)
    { name: 'rest', yield: Infinity, fracture: Infinity, rest: [Math.sin((25 * Math.PI) / 360), 0, 0, Math.cos((25 * Math.PI) / 360)] },
    // ...and one that gives, from that rest: it has bent a few degrees from it, not the 25° it is turned from the identity
    { name: 'yields from a rest it started with: the bend is from that rest', yield: 30, fracture: 200, breakBend: 0.2, breaks: false, bend: [0.01, 0.2], rest: [Math.sin((25 * Math.PI) / 360), 0, 0, Math.cos((25 * Math.PI) / 360)] },
  ];
  for (const c of cases) {
    const ref = new Solver();
    ref.gravity = 0;
    const a = new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 5]);
    const b = new Rigid(ref, [1, 1, 1], 10, 0.5, [1, 0, 5]);
    if (c.rest) {
      b.positionAng.set(c.rest);
      b.positionLin.set([0.5 + 0.5 * Math.cos((25 * Math.PI) / 180), -0.5 * Math.sin((25 * Math.PI) / 180), 5]);
    }
    b.velocityAng.set([0, 10, 0]);
    const joint = new Joint(ref, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, c.fracture);
    joint.yield = c.yield;
    joint.breakBend = c.breakBend ?? Infinity;
    if (c.rest) joint.rest = Float64Array.from(c.rest);
    joint.penaltyAng.fill(100);
    joint.penaltyLin.fill(1e4);
    const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
    // The reference's exact rules, as the seeded parity test above
    for (const flag of ['matchNearest', 'faceBias', 'reuseContacts', 'startAtRest', 'massPenalty'] as const) gpu.params[flag] = false;
    gpu.params.gravity = 0;
    gpu.seedFrom(ref);
    gpu.fixedColors = gpu.sequentialColors();
    gpu.step();
    ref.step();
    const [bodies, joints] = [await gpu.readBodies(), await gpu.readJoints()];
    const state = decodeJoint(joints, 0);
    const where = `${c.name}`;
    assert.equal(state.broken, joint.broken, `${where}: broken`);
    if (c.breaks !== undefined) assert.equal(joint.broken, c.breaks, `${where}: the reference's own decision`);
    if (c.bend) assert.ok(joint.bend > c.bend[0] && joint.bend < c.bend[1], `${where}: the reference's own bend, ${joint.bend}`);
    // How far it has bent, from the rest it started with: also of a joint that broke on it
    assert.ok(Math.abs(state.bend - joint.bend) < 1e-5, `${where}: bend ${state.bend} vs ${joint.bend}`);
    if (!joint.broken) {
      assert.ok(Math.abs(state.angular - Math.sqrt(lengthSq(joint.lambdaAng))) < 0.02 * Math.max(1, state.angular), `${where}: |λ_ang| ${state.angular} vs ${Math.sqrt(lengthSq(joint.lambdaAng))}`);
      // The rest it holds: the reference's (null: the identity), either sign
      const expected = joint.rest ?? [0, 0, 0, 1];
      const same = Math.abs(state.rest[0] * expected[0] + state.rest[1] * expected[1] + state.rest[2] * expected[2] + state.rest[3] * expected[3]);
      assert.ok(same > 1 - 1e-5, `${where}: rest ${state.rest} vs ${[...expected]}`);
      const pen = joints.subarray(J_PEN_ANG, J_PEN_ANG + 3);
      for (let r = 0; r < 3; r++) assert.ok(Math.abs(pen[r] - joint.penaltyAng[r]) < 1e-3 * Math.max(1, pen[r]), `${where}: penalty ${[...pen]} vs ${[...joint.penaltyAng]}`);
    }
    let d = 0;
    ref.bodies.forEach((body, i) => {
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + k] - body.positionLin[k]));
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + 4 + k] - body.positionAng[k]));
    });
    // Measured ≤ 9.1e-8 (docs/FINDINGS.md)
    assert.ok(d < 1e-5, `${where}: pose diff ${d}`);
    gpu.destroy();
  }
});

// A joint with no rest holds the two rotations equal. q and -q are one rotation, so the lock's error
// is taken the short way round: on the GPU for every joint, and in the reference whether or not the
// joint has a rest. Without that, a reference joint whose bodies' quaternions had opposite signs, or
// were turned apart by more than 180°, pushed them the other way (with a spin of 90 rad/s in a step).
gpuTest('seeded single step: a joint without a rest takes the short way round on the GPU and in the reference (B\'s quaternion negated, B turned past 180°)', async (device) => {
  const turn = (angle: number, axis: number[]) => {
    const l = Math.hypot(...axis);
    const h = (angle * Math.PI) / 360;
    return quat(...axis.map((x) => (x / l) * Math.sin(h)), Math.cos(h));
  };
  const cases = [
    { name: 'in one hemisphere', apart: 30, flip: false },
    { name: 'B negated', apart: 30, flip: true },
    { name: 'B turned 200° from A', apart: 200, flip: false },
    { name: 'B turned 200° from A, and negated', apart: 200, flip: true },
  ];
  for (const c of cases) {
    const ref = new Solver();
    ref.gravity = 0;
    const qa = turn(50, [0.2, -0.5, 0.7]);
    const qb = qmul(quat(), qa, turn(c.apart, [0.3, 0.8, 0.5]));
    const a = new Rigid(ref, [1, 1, 1], 0, 0.5, [0, 0, 5]);
    a.positionAng.set(qa);
    // B's centre, so that A's anchor (0.5, 0, 0) and B's (-0.5, 0, 0) are one point
    const [pa, pb] = [rotate(vec3(), qa, [0.5, 0, 0]), rotate(vec3(), qb, [0.5, 0, 0])];
    const b = new Rigid(ref, [1, 1, 1], 10, 0.5, [pa[0] + pb[0], pa[1] + pb[1], 5 + pa[2] + pb[2]]);
    b.positionAng.set(c.flip ? qb.map((x) => -x) : qb);
    const joint = new Joint(ref, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity);
    joint.penaltyAng.fill(100);
    joint.penaltyLin.fill(1e4);
    const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
    for (const flag of ['matchNearest', 'faceBias', 'reuseContacts', 'startAtRest', 'massPenalty'] as const) gpu.params[flag] = false;
    gpu.params.gravity = 0;
    gpu.seedFrom(ref);
    gpu.fixedColors = gpu.sequentialColors();
    gpu.step();
    ref.step();
    const bodies = await gpu.readBodies();
    let d = 0;
    ref.bodies.forEach((body, i) => {
      for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + k] - body.positionLin[k]));
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(bodies[i * BODY_FLOATS + 4 + k] - body.positionAng[k]));
    });
    assert.ok(d < 1e-5, `${c.name}: pose diff ${d}`);
    // And it is a lock that restores, not one that sends B spinning: B's orientation moved a little, toward A's
    const spin = Math.hypot(...ref.bodies[1].velocityAng);
    assert.ok(spin < 30, `${c.name}: B spins at ${spin.toFixed(1)} rad/s`);
    gpu.destroy();
  }
});

// The HUD's maxBend is how far a joint has bent from the rest it started with (J_REST_START): a
// joint made with a 30° rest that never gives has not bent
gpuTest('the GPU sim\'s maxBend reads how far a joint has bent, not the turn of the rest it holds', async (device) => {
  const turn = (angle: number, axis: number[]) => {
    const l = Math.hypot(...axis);
    const h = (angle * Math.PI) / 360;
    return quat(...axis.map((x) => (x / l) * Math.sin(h)), Math.cos(h));
  };
  const ref = new Solver();
  const qr = turn(30, [0.3, 0.8, 0.5]);
  const a = new Rigid(ref, [1, 1, 1], 1, 0.5, [0, 0, 10]);
  const pb = rotate(vec3(), qr, [0.5, 0, 0]);
  const b = new Rigid(ref, [1, 1, 1], 1, 0.5, [0.5 + pb[0], pb[1], 10 + pb[2]]);
  b.positionAng.set(qr);
  a.velocityAng.set([1, 2, 3]);
  b.velocityAng.set([1, 2, 3]);
  const joint = new Joint(ref, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity);
  joint.rest = Float64Array.from(qr);
  const sim = createGpuSim3D(device, 'Ground', {}, undefined, undefined, ref);
  for (let k = 0; k < 30; k++) sim.step();
  await sim.sync();
  assert.equal(sim.stats().joints, 1);
  assert.equal(sim.stats().maxBend, 0, 'a joint made with a 30° rest has not bent');
  sim.destroy();
});

// The demo's cantilever (bench-scenes.ts plasticBeam), through the reference's Joint into the GPU's
// records: yield, rest and the linear fracture all travel in writeJoint
gpuTest('Plastic Beam on the GPU: a light weight holds, a medium one bends the beam for good (cut loose, it stays bent), a heavy one tears it off the wall', async (device) => {
  const run = async (weight: number, seconds: number) => {
    const sim = createGpuSim3D(device, 'Plastic Beam', {}, undefined, { weight });
    for (let k = 0; k < seconds * 60; k++) sim.step();
    await sim.sync();
    return sim;
  };
  const degrees = (rad: number) => (rad * 180) / Math.PI;
  const light = await run(2, 6);
  assert.ok(degrees(light.stats().maxBend) < 1 && light.stats().joints === 9, `a light weight: no bend (${degrees(light.stats().maxBend).toFixed(2)}°)`);
  light.destroy();

  const medium = await run(8, 6);
  const bent = degrees(medium.stats().maxBend);
  assert.ok(bent > 12 && bent < 40 && medium.stats().joints === 9, `a medium one bends it: ${bent.toFixed(1)}°`);
  const tip = () => Array.from(at(medium, 9)); // the last link: the ground, the wall, eight links, the weight
  const before = tip();
  medium.cut();
  for (let k = 0; k < 4 * 60; k++) medium.step();
  await medium.sync();
  assert.equal(medium.stats().joints, 8, 'the weight is cut loose');
  assert.ok(Math.abs(degrees(medium.stats().maxBend) - bent) < 0.5, `and the beam stays as it was: ${degrees(medium.stats().maxBend).toFixed(1)}°`);
  assert.ok(Math.hypot(...tip().map((x, k) => x - before[k])) < 0.4, 'its end has not moved but for the sag the weight made');
  medium.destroy();

  const heavy = await run(25, 6);
  assert.equal(heavy.stats().joints, 8, 'a heavy one tears the weld at the wall, and only that');
  heavy.destroy();

  // Made already bent, the wall's weld holds the bend it was given (the rest travels through writeJoint)
  const made = await (async () => {
    const sim = createGpuSim3D(device, 'Plastic Beam', {}, undefined, { weight: 0, bend: 21 });
    for (let k = 0; k < 4 * 60; k++) sim.step();
    await sim.sync();
    return sim;
  })();
  assert.ok(Math.abs(degrees(made.stats().maxBend) - 21) < 0.5, `${degrees(made.stats().maxBend).toFixed(1)}°`);
  // The last link's centre, 7.5 m out along the beam turned 21° about its root (the weld's anchor at 9.5 m)
  const end = at(made, 9);
  const [c, s] = [Math.cos((21 * Math.PI) / 180), Math.sin((21 * Math.PI) / 180)];
  assert.ok(Math.abs(end[0] - 7.5 * c) < 0.3 && Math.abs(end[2] - (9.5 - 7.5 * s)) < 0.3, `a beam turned 21° about its root ends where it was put: ${Array.from(end)}`);
  made.destroy();
});
