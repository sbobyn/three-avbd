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
import { BODY_FLOATS, CONTACT_WORDS, K_LAM, K_RA, K_RB } from '../src/avbd3d/gpu/layout.ts';
import { createGpuSim3D, GpuSim3D } from '../src/avbd3d/gpu/sim.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
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

interface GpuContact {
  a: number;
  b: number;
  feature: number;
  rA: number[];
  rB: number[];
  lam: number[];
}

function parseContacts(words: ArrayBuffer): GpuContact[] {
  const u = new Uint32Array(words);
  const f = new Float32Array(words);
  const out: GpuContact[] = [];
  for (let o = 0; o < u.length; o += CONTACT_WORDS) {
    out.push({
      a: u[o],
      b: u[o + 1],
      feature: u[o + 2],
      rA: [...f.subarray(o + K_RA, o + K_RA + 3)],
      rB: [...f.subarray(o + K_RB, o + K_RB + 3)],
      lam: [...f.subarray(o + K_LAM, o + K_LAM + 3)],
    });
  }
  return out;
}

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
      const gpu = new GpuSolver3D(device, ref);
      // The reference's exact rules: strict feature matching, the demo's edge/face choice
      gpu.params.matchNearest = false;
      gpu.params.faceBias = false;
      gpu.seedFrom(ref);
      gpu.fixedColors = gpu.sequentialColors();
      gpu.step();
      ref.step();
      frame++;
      const where = `${scene} frame ${at}`;
      const [bodies, counters, words] = await Promise.all([gpu.readBodies(), gpu.readCounters(), gpu.readContacts()]);
      assert.equal(counters.overflow, 0, `${where}: overflow`);
      const contacts = parseContacts(words);

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
  const gpu = new GpuSolver3D(device, ref);
  gpu.params.iterations = 0;
  gpu.params.gravity = 0;
  gpu.params.faceBias = false;
  gpu.step();
  const contacts = parseContacts(await gpu.readContacts());
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

gpuTest('GPU broadphase finds exactly the pairs with overlapping spheres and AABBs, ignored pairs excluded', async (device) => {
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
  const gpu = new GpuSolver3D(device, ref);
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
  for (let i = 0; i < B.length; i++) {
    for (let j = 0; j < i; j++) {
      if (B[i].mass <= 0 && B[j].mass <= 0) continue;
      if (i === 2 && j === 1) continue;
      const d = Math.hypot(B[i].positionLin[0] - B[j].positionLin[0], B[i].positionLin[1] - B[j].positionLin[1], B[i].positionLin[2] - B[j].positionLin[2]);
      const apart = [0, 1, 2].some((k) => Math.abs(B[i].positionLin[k] - B[j].positionLin[k]) > half[i][k] + half[j][k]);
      if (d <= B[i].radius + B[j].radius && !apart) expected.push(`${i}-${j}`);
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

const speed = (b: Float32Array, i: number) => Math.hypot(b[i * BODY_FLOATS + 32], b[i * BODY_FLOATS + 33], b[i * BODY_FLOATS + 34]);

gpuTest('GPU: stack and pyramid settle and stand', async () => {
  const stack = await runGpu('Stack', 900);
  const b = await stack.solver.readBodies();
  for (let i = 1; i < stack.bodyCount; i++) {
    const p = stack.position(i);
    assert.ok(Math.abs(p[2] - i) < 0.011 * i, `box ${i} z ${p[2]}`);
    assert.ok(Math.hypot(p[0], p[1]) < 1e-3, `box ${i} drifted`);
    assert.ok(speed(b, i) < 1e-3, `box ${i} speed ${speed(b, i)}`);
  }
  stack.destroy();

  const pyr = await runGpu('Pyramid', 600);
  const top = pyr.position(pyr.bodyCount - 1);
  assert.ok(Math.abs(top[2] - (0.25 + 15 * 0.5)) < 0.2, `top z ${top[2]}`);
  const pb = await pyr.solver.readBodies();
  for (let i = 0; i < pyr.bodyCount; i++) assert.ok(speed(pb, i) < 0.01, `brick ${i} speed ${speed(pb, i)}`);
  assert.equal(pyr.stats().clashes, 0);
  pyr.destroy();
});

gpuTest('GPU: dynamic friction follows Coulomb; static friction holds above tan 30°', async () => {
  const df = await runGpu('Dynamic Friction', 300);
  for (let i = 0; i < 11; i++) {
    const slid = df.position(i + 1)[0];
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
  const xs = Array.from({ length: 11 }, (_, i) => sf.position(i + 2)[0]);
  for (let f = 0; f < 120; f++) sf.step();
  await sf.sync();
  for (let i = 0; i < 11; i++) {
    const mu = Math.sqrt((i / 10) * 0.25 + 0.25);
    const p = sf.position(i + 2);
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
  const spring = await runGpu('Spring', 600);
  let sum = 0;
  for (let f = 0; f < 600; f += 10) {
    for (let i = 0; i < 10; i++) spring.step();
    await spring.sync();
    sum += spring.position(2)[2];
  }
  assert.ok(Math.abs(sum / 60 - 9.2) < 0.05, `spring mean z ${sum / 60}`);
  spring.destroy();

  for (const [scene, bound] of [
    ['Rope', 0.02],
    ['Heavy Rope', 0.03],
    ['Bridge', 0.03],
  ] as const) {
    const sim = await runGpu(scene, 600);
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
  assert.ok(hit && hit.body === 1, 'ray picks the box');
  sim.startDrag(hit.body, hit.local, [3, 2, 4]);
  for (let i = 0; i < 300; i++) sim.step();
  await sim.sync();
  // The grabbed point hangs just below the target (soft drag spring, box weight)
  const p = sim.position(1);
  assert.ok(Math.hypot(p[0] - 3, p[1] - 2) < 0.6 && Math.abs(p[2] - 4) < 1, `box at ${Array.from(p)}`);
  sim.endDrag();
  sim.addBox([1, 1, 1], 1, 0.5, [0, 0, 8], [0, 0, 0]);
  for (let i = 0; i < 300; i++) sim.step();
  await sim.sync();
  assert.equal(sim.bodyCount, 3);
  assert.ok(sim.position(1)[2] < 1.1 && sim.position(2)[2] < 2.1 && sim.position(2)[2] > 0.9, 'both boxes back on the ground');
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
    return { v: b[6 * BODY_FLOATS + 32], w: b[6 * BODY_FLOATS + 37] };
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
  const z = (i: number) => sim.position(i)[2];
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
    for (let i = 0; i < 900; i++) sim.step();
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
  const last = (sim: GpuSim3D) => sim.position(sim.bodyCount - 1);

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
