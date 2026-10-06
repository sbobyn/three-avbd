// Joints beyond the demo's, on the 3D CPU reference: a rest rotation for the angle lock, and
// plastic joints (yield). Both are opt-in on the reference Joint (rest null, yield Infinity are
// the demo's joint, which the oracle fixtures pin), so these run without a GPU, in CI too. The GPU
// solver is checked against the same behaviour in tests-gpu.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Joint } from '../src/avbd3d/ref/forces.ts';
import { conjugate, lengthSq, qmul, quat, rotate, vec3 } from '../src/avbd3d/ref/math.ts';
import { sceneByName } from '../src/avbd3d/ref/scenes.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { createSim3D, RefSim3D } from '../src/avbd3d/sim.ts';
import { decodeJoint } from '../src/avbd3d/gpu/joints.ts';
import { J_LAM_ANG, J_LAM_LIN, J_PEN_ANG, J_PEN_LIN, J_REST, J_REST_START, JOINT_FLOATS } from '../src/avbd3d/gpu/layout.ts';

const deg = (r: number) => (r * 180) / Math.PI;
/** The angle (degrees) of the turn between two orientations. */
function between(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = qmul(quat(), conjugate(quat(), a), b);
  return deg(2 * Math.acos(Math.min(1, Math.abs(d[3]))));
}
/** A turn of `angle` degrees about `axis`, as a quaternion (x, y, z, w). */
function turn(angle: number, axis: number[]): Float64Array {
  const l = Math.hypot(...axis);
  const h = (angle * Math.PI) / 360;
  return quat((axis[0] / l) * Math.sin(h), (axis[1] / l) * Math.sin(h), (axis[2] / l) * Math.sin(h), Math.cos(h));
}

// --- The rest rotation -----------------------------------------------------------------------

/** Two unit boxes joined at a shared face, B turned `apart` degrees from A, both spinning in free fall. */
function pair(apart: number, rest: 'none' | 'turn' | 'identity', flip = false): { solver: Solver; a: Rigid; b: Rigid } {
  const solver = new Solver();
  const qa = turn(50, [0.2, -0.5, 0.7]);
  const qr = turn(apart, [0.3, 0.8, 0.5]);
  const qb = qmul(quat(), qa, qr);
  const a = new Rigid(solver, [1, 1, 1], 1, 0.5, [0, 0, 10]);
  a.positionAng.set(qa);
  // B's centre, so that A's anchor (0.5, 0, 0) and B's (-0.5, 0, 0) are one point
  const pa = rotate(vec3(), qa, [0.5, 0, 0]);
  const pb = rotate(vec3(), qb, [0.5, 0, 0]);
  const b = new Rigid(solver, [1, 1, 1], 1, 0.5, [pa[0] + pb[0], pa[1] + pb[1], 10 + pa[2] + pb[2]]);
  b.positionAng.set(flip ? qb.map((x) => -x) : qb);
  a.velocityAng.set([1, 2, 3]);
  b.velocityAng.set([1, 2, 3]);
  const joint = new Joint(solver, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity);
  if (rest === 'turn') joint.rest = Float64Array.from(qr);
  if (rest === 'identity') joint.rest = quat();
  return { solver, a, b };
}

test('a rest rotation: the angle lock holds rotB = rotA·rest through free fall and tumbling', () => {
  const { solver, a, b } = pair(30, 'turn');
  for (let i = 0; i < 90; i++) {
    solver.step();
    if (i % 30 === 29) assert.ok(Math.abs(between(a.positionAng, b.positionAng) - 30) < 0.05, `frame ${i + 1}: ${between(a.positionAng, b.positionAng)}°`);
  }
});

test('with no rest, as in the demo, the lock twists two bodies turned apart until they match (27°, 22°, 16° of 30° after 10, 30, 60 steps)', () => {
  const { solver, a, b } = pair(30, 'none');
  const angles: number[] = [];
  for (let i = 1; i <= 60; i++) {
    solver.step();
    if (i === 10 || i === 30 || i === 60) angles.push(between(a.positionAng, b.positionAng));
  }
  assert.ok(angles[0] < 28 && angles[1] < 24 && angles[2] < 18, `${angles}`);
});

test('the identity rest is the demo\'s joint to the bit', () => {
  const run = (identity: boolean) => {
    const solver = new Solver();
    sceneByName('Breakable').build(solver);
    if (identity) for (const f of solver.forces) if (f instanceof Joint) f.rest = quat();
    for (let i = 0; i < 120; i++) solver.step();
    return solver.bodies.map((b) => [...b.positionLin, ...b.positionAng]);
  };
  assert.deepEqual(run(true), run(false));
});

test('a rest holds with either sign of the bodies\' quaternions (q and -q are one rotation)', () => {
  // Without taking the short way round, the lock's error would be the long way: pushing the bodies apart
  const { solver, a, b } = pair(30, 'turn', true);
  for (let i = 0; i < 90; i++) solver.step();
  assert.ok(Math.abs(between(a.positionAng, b.positionAng) - 30) < 0.05, `${between(a.positionAng, b.positionAng)}°`);
  // ...and a rest given the other way up holds the same turn
  const other = pair(30, 'none');
  const joint = other.solver.forces.find((f): f is Joint => f instanceof Joint)!;
  joint.rest = qmul(quat(), conjugate(quat(), other.a.positionAng), other.b.positionAng).map((x) => -x) as Float64Array;
  for (let i = 0; i < 90; i++) other.solver.step();
  assert.ok(Math.abs(between(other.a.positionAng, other.b.positionAng) - 30) < 0.05);
});

test('with no rest the lock takes the short way round too: a negated quaternion, or a turn past 180°, is the same rotation and behaves as one', () => {
  // The demo's lock, with no rest, takes the long way round when the two bodies' quaternions are in
  // opposite hemispheres (rotA·rotB⁻¹ has w < 0): it then pushes them apart. Both end up tumbling at
  // 90 rad/s after one step, though their angle to each other (which is all `between` sees) is as it
  // should be: so compare the bodies' own orientations and spins
  const run = (apart: number, flip = false) => {
    const { solver, a, b } = pair(apart, 'none', flip);
    for (let i = 0; i < 40; i++) solver.step();
    return { qa: [...a.positionAng], qb: [...b.positionAng], va: [...a.velocityAng], vb: [...b.velocityAng], angle: between(a.positionAng, b.positionAng) };
  };
  const same = (x: ReturnType<typeof run>, y: ReturnType<typeof run>, what: string) => {
    x.qa.forEach((q, k) => assert.ok(Math.abs(q - y.qa[k]) < 1e-9, `${what}: A's orientation ${x.qa} against ${y.qa}`));
    assert.ok(between(x.qb, y.qb) < 1e-6, `${what}: B's orientation ${x.qb} against ${y.qb}`);
    [...x.va, ...x.vb].forEach((v, k) => assert.ok(Math.abs(v - [...y.va, ...y.vb][k]) < 1e-6, `${what}: spins ${[...x.va, ...x.vb]} against ${[...y.va, ...y.vb]}`));
  };
  const plain = run(30);
  same(run(30, true), plain, 'B negated');
  // 200° about an axis is −160° about it: one rotation, written with a quaternion of the other sign
  const past = run(200);
  same(past, run(-160), 'turned 200°');
  assert.ok(past.angle < 100, `twisted back toward equal from 160° (the short way): ${past.angle.toFixed(1)}°`);
});

test('holdCurrentRotation takes the rest from the bodies as they are', () => {
  const { solver, a, b } = pair(40, 'none');
  const joint = solver.forces.find((f): f is Joint => f instanceof Joint)!;
  joint.holdCurrentRotation();
  assert.ok(Math.abs(deg(2 * Math.acos(Math.abs(joint.rest![3]))) - 40) < 1e-9, 'the rest is the 40° turn between them');
  for (let i = 0; i < 90; i++) solver.step();
  assert.ok(Math.abs(between(a.positionAng, b.positionAng) - 40) < 0.05);
});

// --- Plastic joints --------------------------------------------------------------------------

/**
 * A cantilever (z up): a fixed wall, `links` links of 1 m welded end to end, and a weight on the end.
 * Only the weld at the wall, the one that carries the most, yields or breaks (the others hold).
 */
function cantilever(weight: number, options: { yield?: number; fracture?: number; linear?: boolean; links?: number; breakBend?: number } = {}) {
  const solver = new Solver();
  const links = options.links ?? 4;
  const wall = new Rigid(solver, [1, 1, 1], 0, 0.5, [-0.5, 0, 5]);
  const beam: Rigid[] = [];
  let prev = wall;
  let anchor = [0.5, 0, 0];
  const joints: Joint[] = [];
  for (let i = 0; i < links; i++) {
    const link = new Rigid(solver, [1, 0.3, 0.3], 1, 0.5, [i + 0.5, 0, 5]);
    const joint = new Joint(solver, prev, link, anchor, [-0.5, 0, 0], Infinity, Infinity, i === 0 ? (options.fracture ?? Infinity) : Infinity);
    joint.fractureLinear = options.linear ?? false;
    if (i === 0) {
      joint.yield = options.yield ?? Infinity;
      joint.breakBend = options.breakBend ?? Infinity;
    }
    joints.push(joint);
    beam.push(link);
    prev = link;
    anchor = [0.5, 0, 0];
  }
  const block = new Rigid(solver, [0.6, 0.6, 0.6], weight / 0.216, 0.5, [links + 0.3, 0, 5]);
  const load = new Joint(solver, prev, block, anchor, [-0.3, 0, 0], Infinity, Infinity);
  /** How far the first link has turned down about y, degrees. */
  const bend = () => deg(2 * Math.atan2(beam[0].positionAng[1], beam[0].positionAng[3]));
  return { solver, joints, root: joints[0], load, block, bend };
}

// The root weld's angular force |λ_ang| is the load's moment over its torque arm: 20 kg out at 4.3 m
// asks 118, 12 kg 70, 2 kg 12. A load put on all at once overshoots to about twice that before the
// solver settles (a 5 kg load, asking 29, reached 61 and gave a little: docs/FINDINGS.md)
test('a joint below its yield holds as the demo\'s does: it never gives', () => {
  const { solver, root, bend } = cantilever(2, { yield: 60 });
  for (let i = 0; i < 300; i++) solver.step();
  assert.equal(root.rest, null, 'no yield, so no rest moved');
  assert.ok(bend() < 1, `a small sag, ${bend()}°`);
});

test('past its yield a joint bends, never carries more than yield, and keeps the bend when the load is gone', () => {
  const yieldForce = 60;
  const { solver, root, load, bend } = cantilever(12, { yield: yieldForce });
  let carried = 0;
  for (let i = 0; i < 600; i++) {
    solver.step();
    carried = Math.max(carried, Math.sqrt(lengthSq(root.lambdaAng)));
  }
  assert.ok(carried <= yieldForce * (1 + 1e-9), `carried ${carried}`);
  assert.ok(carried > 0.9 * yieldForce, `and it did carry the yield: ${carried}`);
  const loaded = bend();
  assert.ok(loaded > 25, `it bent under the load: ${loaded}°`);
  assert.ok(Math.abs(deg(2 * Math.acos(root.rest![3])) - loaded) < 2, 'the rest it holds is the bend');
  // The load goes (its weld is cut and it falls away): the beam stays as it is
  load.destroy();
  for (let i = 0; i < 300; i++) solver.step();
  assert.ok(Math.abs(bend() - loaded) < 0.5, `bent ${loaded}° with the load, ${bend()}° without`);
});

test('the same load on the demo\'s joint does not bend it', () => {
  const { solver, root, bend } = cantilever(12);
  for (let i = 0; i < 600; i++) solver.step();
  assert.ok(bend() < 3, `${bend()}°`);
  assert.equal(root.rest, null);
});

test('a plastic joint swings its load as a hinge with a torque of torqueArm × yield (the work-energy balance)', () => {
  // The load's moment about the hinge, W g L cos(φ), against the hinge's M: the swing stops where
  // W g L sin(φ) = M φ. A light beam, so the weight's own moment dominates
  const yieldForce = 60;
  const { solver, root, bend } = cantilever(15, { yield: yieldForce });
  let furthest = 0;
  for (let i = 0; i < 300; i++) {
    solver.step();
    furthest = Math.max(furthest, bend());
  }
  const moment = root.torqueArm * yieldForce;
  const weight = 15 * 10 * 4.3;
  let [lo, hi] = [0.01, Math.PI - 0.01];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((weight * Math.sin(mid)) / mid > moment) lo = mid;
    else hi = mid;
  }
  const ideal = deg((lo + hi) / 2);
  assert.ok(Math.abs(furthest - ideal) < 12, `swung to ${furthest}°, the ideal rigid-plastic hinge ${ideal}°`);
});

test('the dual update: past fracture a joint breaks, past its yield it gives (rest moved, force cut, penalty and reference error settled), below it nothing', () => {
  // B turned 5° about y from A, penalty 100, a reference error of 0.5 and alpha 0.9: the force asked,
  // k·(C − αC0) with C = −2 sin(2.5°)·12 = −1.0468, is 149.7 in length
  const dual = (yieldForce: number, fracture: number) => {
    const solver = new Solver();
    const a = new Rigid(solver, [1, 1, 1], 0, 0.5, [0, 0, 0]);
    const b = new Rigid(solver, [1, 1, 1], 1, 0.5, [1, 0, 0]);
    b.positionAng.set(turn(5, [0, 1, 0]));
    const joint = new Joint(solver, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, fracture);
    joint.yield = yieldForce;
    joint.penaltyAng.fill(100);
    joint.C0Ang.set([0, 0.5, 0]);
    joint.updateDual(0.9);
    return { joint, asked: 149.68 };
  };
  const length = (v: ArrayLike<number>) => Math.sqrt(lengthSq(v));

  const gives = dual(100, 200).joint;
  assert.ok(Math.abs(length(gives.lambdaAng) - 100) < 1e-9, `the force cut back to the yield: ${length(gives.lambdaAng)}`);
  assert.ok(gives.rest && Math.abs(between(quat(), gives.rest) - 5) < 1e-9, 'the rest moved to the 5° turn');
  assert.deepEqual([...gives.C0Ang], [0, 0, 0], 'the step\'s reference error moved with it');
  assert.deepEqual([...gives.penaltyAng], [100, 100, 100], 'and the penalty did not ramp');
  assert.ok(!gives.broken);

  const breaks = dual(100, 120).joint;
  assert.ok(breaks.broken && breaks.rest === null, 'past its fracture it breaks, and never yields');
  assert.equal(length(breaks.lambdaAng), 0);

  const holds = dual(200, 1e9);
  assert.ok(Math.abs(length(holds.joint.lambdaAng) - holds.asked) < 0.1, 'below its yield the force is what was asked');
  assert.equal(holds.joint.rest, null);
  assert.ok(holds.joint.penaltyAng[1] > 249 && holds.joint.penaltyAng[1] < 250, `and the penalty ramps as ever: ${holds.joint.penaltyAng[1]}`);
});

test('a plastic joint whose bodies start off its rest takes the offset as its bend, as a rigid one slowly corrects it', () => {
  // The step's reference error (C0) moves with the rest: kept, it pulls the new rest's error back each step
  const offset = (yieldForce: number) => {
    const solver = new Solver();
    solver.gravity = 0;
    new Rigid(solver, [1, 1, 1], 0, 0.5, [0, 0, 5]);
    const b = new Rigid(solver, [1, 1, 1], 1, 0.5, [1, 0, 5]);
    b.positionAng.set(turn(20, [0, 1, 0]));
    const joint = new Joint(solver, solver.bodies[0], b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity);
    joint.yield = yieldForce;
    for (let i = 0; i < 120; i++) solver.step();
    return { angle: between(solver.bodies[0].positionAng, b.positionAng), joint };
  };
  const plastic = offset(0.05);
  assert.ok(plastic.angle > 18 && plastic.angle < 21, `B stays turned: ${plastic.angle}°`);
  assert.ok(Math.abs(deg(2 * Math.acos(plastic.joint.rest![3])) - plastic.angle) < 0.5, 'as the rest it holds');
  assert.ok(offset(Infinity).angle < 12, 'a rigid joint corrects it, slowly');
});

test('fracture still applies to a plastic joint: its linear force breaks it, and a fracture below the yield wins', () => {
  // 40 kg hangs 400 N on the weld: past the 300 N it tears on, yielding or not
  const heavy = cantilever(40, { yield: 60, fracture: 300, linear: true });
  for (let i = 0; i < 120; i++) heavy.solver.step();
  assert.ok(heavy.root.broken, 'torn off the wall');
  // A fracture below the yield: the force rising through it breaks the joint before it gives
  const brittle = cantilever(20, { yield: 100, fracture: 60 });
  for (let i = 0; i < 120; i++) brittle.solver.step();
  assert.ok(brittle.root.broken && brittle.root.rest === null, 'broke without ever yielding');
});

// --- A plastic joint's bend limit ------------------------------------------------------------

// With yield < force <= fracture the dual cuts the force back to yield before the fracture test, so
// a load that goes on bending a plastic joint never breaks it: 15 kg asks 87 of the weld that yields
// at 60, and the force the dual ever sees is 60. breakBend is how a sustained overload tears it
test('breakBend: a plastic joint under a sustained overload bends, then breaks at its bend limit; a fracture above its yield never sees the load; a lighter load bends less and holds', () => {
  const limit = 0.6; // rad, 34.4°
  const run = (weight: number, breakBend: number) => {
    const c = cantilever(weight, { yield: 60, fracture: 120, breakBend });
    let seen = 0;
    let brokeAt = -1;
    for (let i = 1; i <= 300 && brokeAt < 0; i++) {
      c.solver.step();
      seen = Math.max(seen, Math.sqrt(lengthSq(c.root.lambdaAng)));
      if (c.root.broken) brokeAt = i;
    }
    return { ...c, seen, brokeAt };
  };
  // Without the limit: the overload swings the weld to 90° and it holds
  const unlimited = run(15, Infinity);
  assert.ok(unlimited.seen <= 60 * (1 + 1e-9) && unlimited.brokeAt < 0 && !unlimited.root.broken, `the force it sees stays at the yield (${unlimited.seen}) and it never breaks`);
  assert.ok(unlimited.root.bend > 1.4, `bent ${deg(unlimited.root.bend).toFixed(1)}°, well past the limit`);
  // With it: it breaks when it has bent that far, within the turn of an iteration (0.1°), and with
  // a force no fracture was set to see
  const heavy = run(15, limit);
  assert.ok(heavy.root.broken && heavy.brokeAt > 0, 'the overload tears it');
  assert.ok(heavy.root.bend > limit && heavy.root.bend < limit + 0.01, `at ${deg(heavy.root.bend).toFixed(2)}° of bend, the limit being ${deg(limit).toFixed(2)}°`);
  assert.ok(heavy.seen <= 60 * (1 + 1e-9), `with the force at ${heavy.seen}, below the fracture of 120`);
  // A lighter load (8 kg asks 47: it gives a little on landing) bends less than the limit and holds
  const light = run(8, limit);
  assert.ok(!light.root.broken && light.root.bend > 0 && light.root.bend < limit / 2, `bent ${deg(light.root.bend).toFixed(1)}° and holds`);
  // Heavier breaks sooner (the more it asks, the faster it bends)
  assert.ok(run(20, limit).brokeAt < heavy.brokeAt, 'a heavier load tears it sooner');
});

test('the dual update: a joint that gives and has bent past its breakBend breaks (keeping the rest it moved to), within it does not, and the bend is from the rest it started with', () => {
  // B turned 5° about y from A, penalty 100: the force asked is 150, past a yield of 50. A joint
  // made with a 2° rest has 3° to bend to it, and asked 108
  const dual = (breakBend: number, rest?: Float64Array, yieldForce = 50) => {
    const solver = new Solver();
    const a = new Rigid(solver, [1, 1, 1], 0, 0.5, [0, 0, 0]);
    const b = new Rigid(solver, [1, 1, 1], 1, 0.5, [1, 0, 0]);
    b.positionAng.set(turn(5, [0, 1, 0]));
    const joint = new Joint(solver, a, b, [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, 200);
    joint.yield = yieldForce;
    joint.breakBend = breakBend;
    if (rest) joint.rest = rest;
    joint.penaltyAng.fill(100);
    joint.C0Ang.set([0, 0.5, 0]);
    joint.updateDual(0.9);
    return joint;
  };
  const rad = (d: number) => (d * Math.PI) / 180;
  const within = dual(rad(5.7));
  assert.ok(!within.broken && Math.abs(deg(within.bend) - 5) < 1e-9, `gave to 5° within a limit of 5.7°: ${deg(within.bend)}°`);
  const past = dual(rad(4.6));
  assert.ok(past.broken && Math.abs(deg(past.bend) - 5) < 1e-9, 'past a limit of 4.6° it broke, with the rest it had moved to');
  assert.equal(Math.sqrt(lengthSq(past.lambdaAng)), 0);
  // From the rest it started with: 2° to 5° is 3° of bend, not 5°
  const [start, inside, outside] = [turn(2, [0, 1, 0]), dual(rad(3.4), turn(2, [0, 1, 0])), dual(rad(2.6), turn(2, [0, 1, 0]))];
  assert.ok(!inside.broken && Math.abs(deg(inside.bend) - 3) < 1e-9, `bent ${deg(inside.bend)}° from a 2° rest, within 3.4°`);
  assert.ok(outside.broken, 'and past 2.6°');
  assert.ok(Math.abs(between(inside.restStart!, start)) < 1e-12, 'the rest it started with is kept');
  // A limit is tested when the joint gives: one that holds (yield 200 is above the 150 asked) is not asked, whatever its limit
  const holds = dual(0, undefined, 200);
  assert.ok(!holds.broken && holds.bend === 0 && holds.restStart === null, 'a joint that did not give has not bent');
  // And a limit of 0 breaks a joint at its first give
  assert.ok(dual(0).broken);
});

test('Joint.bend: the turn from the rest it started with to the one it holds, 0 until it gives, whichever sign each quaternion has', () => {
  const solver = new Solver();
  const joint = new Joint(solver, null, new Rigid(solver, [1, 1, 1], 1, 0.5, [0, 0, 0]), [0, 0, 0], [0, 0, 0]);
  assert.equal(joint.bend, 0);
  joint.rest = turn(30, [0, 0, 1]);
  assert.equal(joint.bend, 0, 'a rest it was made with is not a bend');
  joint.restStart = quat();
  assert.ok(Math.abs(deg(joint.bend) - 30) < 1e-9, 'a rest moved 30° from the one it started with');
  joint.rest = turn(30, [0, 0, 1]).map((x) => -x);
  assert.ok(Math.abs(deg(joint.bend) - 30) < 1e-9, 'either sign');
  joint.restStart = turn(10, [0, 0, 1]);
  joint.rest = turn(-20, [0, 0, 1]);
  assert.ok(Math.abs(deg(joint.bend) - 30) < 1e-9, 'from 10° to −20°');
  joint.rest = null;
  joint.restStart = quat();
  assert.equal(joint.bend, 0, 'no rest is the identity');
});

// --- Reading a joint back --------------------------------------------------------------------

test('decodeJoint reads a record: the forces carried, whether it broke, the rest it holds', () => {
  const joints = new Float32Array(2 * JOINT_FLOATS);
  const o = JOINT_FLOATS;
  joints.set([3, 0, 4], o + J_LAM_LIN);
  joints.set([0, 12, 5], o + J_LAM_ANG);
  joints[o + J_PEN_LIN + 3] = 3e38;
  joints[o + J_PEN_ANG + 3] = 3e38;
  joints.set([0, 0, 0.6, 0.8], o + J_REST);
  joints.set([0, 0, 0.6, 0.8], o + J_REST_START);
  const held = decodeJoint(joints, 1);
  assert.equal(held.linear, 5);
  assert.equal(held.angular, 13);
  assert.equal(held.broken, false);
  assert.deepEqual(held.rest.map((x) => Math.round(x * 10) / 10), [0, 0, 0.6, 0.8]);
  assert.equal(held.bend, 0, 'a rest it started with is not a bend: exactly 0');
  // Started from the identity, the rest it holds is 2·atan2(0.6, 0.8) = 73.7° away
  joints.set([0, 0, 0, 1], o + J_REST_START);
  assert.ok(Math.abs(deg(decodeJoint(joints, 1).bend) - 73.7398) < 1e-3, `${deg(decodeJoint(joints, 1).bend)}°`);
  assert.equal(decodeJoint(joints, 0).bend, 0, 'an empty record');
  // A ball joint has no angle lock (its angular stiffness is 0 from the start); broken is both zeroed
  joints[o + J_PEN_ANG + 3] = 0;
  assert.equal(decodeJoint(joints, 1).broken, false, 'a ball joint is not broken');
  joints[o + J_PEN_LIN + 3] = 0;
  assert.equal(decodeJoint(joints, 1).broken, true);
  assert.equal(decodeJoint(joints, 0).broken, true, 'an empty record');
});

// --- The HUD's bend ----------------------------------------------------------------------------

test('SimStats3D.maxBend is how far a joint has bent from the rest it started with, not the turn of the rest it holds', () => {
  // A joint made with a 30° rest, never yielding, has bent not at all (the stat read the rest's turn: 30°)
  const { solver } = pair(30, 'turn');
  const sim = new RefSim3D(solver);
  for (let i = 0; i < 30; i++) sim.step();
  assert.equal(sim.stats().maxBend, 0);
  // A weld that gives bends: the stat is the most bent joint's bend, 33° for 10 kg on a yield of 60
  const beam = cantilever(10, { yield: 60 });
  const bent = new RefSim3D(beam.solver);
  for (let i = 0; i < 300; i++) bent.step();
  assert.equal(bent.stats().maxBend, beam.root.bend);
  assert.ok(Math.abs(deg(bent.stats().maxBend) - 33.2) < 1, `${deg(bent.stats().maxBend)}°`);
});

// --- The demo scene -------------------------------------------------------------------------

// 'Plastic Beam' (bench-scenes.ts): an 8-link cantilever welded to a wall, plastic past 700 N·m, its
// wall weld tearing at 400 N, a weight on the end. The reference runs it as the GPU does
test('Plastic Beam: a light weight holds, a medium one bends the beam for good (cut loose, it stays bent), a heavy one tears it off the wall', () => {
  const run = (weight: number, seconds: number) => {
    const sim = createSim3D('Plastic Beam', {}, { weight });
    for (let i = 0; i < seconds * 60; i++) sim.step();
    return sim;
  };
  const degrees = (rad: number) => (rad * 180) / Math.PI;
  const light = run(2, 6);
  assert.ok(degrees(light.stats().maxBend) < 1 && light.stats().joints === 9, 'a light weight: no bend');

  const medium = run(8, 6);
  const bent = degrees(medium.stats().maxBend);
  assert.ok(bent > 12 && bent < 40 && medium.stats().joints === 9, `a medium one bends it: ${bent.toFixed(1)}°`);
  const tip = (sim: typeof medium) => Array.from(sim.position(sim.bodyCount - 2));
  const [before] = [tip(medium)];
  medium.cut();
  for (let i = 0; i < 4 * 60; i++) medium.step();
  assert.equal(medium.stats().joints, 8, 'the weight is cut loose');
  assert.ok(Math.abs(degrees(medium.stats().maxBend) - bent) < 0.5, `and the beam stays as it was: ${degrees(medium.stats().maxBend).toFixed(1)}°`);
  assert.ok(Math.hypot(...tip(medium).map((x, k) => x - before[k])) < 0.4, 'its end has not moved but for the sag the weight made');

  const heavy = run(25, 6);
  assert.equal(heavy.stats().joints, 8, 'a heavy one tears the weld at the wall, and only that');

  // Made already bent (what the scene offers after a weight comes off), the wall's weld holds the bend it was given
  const made = createSim3D('Plastic Beam', {}, { weight: 0, bend: 21 });
  for (let i = 0; i < 4 * 60; i++) made.step();
  assert.ok(Math.abs(degrees(made.stats().maxBend) - 21) < 0.5, `${degrees(made.stats().maxBend).toFixed(1)}°`);
  // The last link's centre, 7.5 m out along the beam turned 21° about its root (the weld's anchor at 9.5 m)
  const end = made.position(made.bodyCount - 1);
  assert.ok(Math.abs(end[0] - 7.5 * Math.cos((21 * Math.PI) / 180)) < 0.3 && Math.abs(end[2] - (9.5 - 7.5 * Math.sin((21 * Math.PI) / 180))) < 0.3, `${Array.from(end)}`);
});
