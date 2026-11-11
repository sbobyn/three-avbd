import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PENALTY_MAX, Rigid } from '../src/avbd2d/ref/body.ts';
import { IgnoreCollision } from '../src/avbd2d/ref/forces.ts';
import { Manifold } from '../src/avbd2d/ref/manifold.ts';
import { Solver } from '../src/avbd2d/ref/solver.ts';
import { combineRestitution, RestitutionManifold, stepWithRestitution } from '../src/avbd2d/experiments/restitution.ts';
import type { NormalSample, RestitutionOptions } from '../src/avbd2d/experiments/restitution.ts';
import { DROP_CASES, heightGate, impactRows, normalSpeedNoGain, ratioGate, runRestitutionReport, runMemoryControlReport, traceFirstFailure } from '../tools/restitution-experiment.ts';

const options = (e = 0.5): RestitutionOptions => ({ restitution: () => e, combine: 'average', threshold: 1 });

function contactSolver(): Solver {
  const s = new Solver();
  s.postStabilize = false;
  new Rigid(s, [100, 1], 0, 0.5, [0, 0, 0]);
  new Rigid(s, [1, 1], 1, 0.5, [0, 0.99, 0], [0, -4, 0]);
  return s;
}

function snapshot(s: Solver) {
  return { forces: [...s.forces], bodies: s.bodies.map((b) => ({ forces: [...b.forces], position: [...b.position],
    initial: [...b.initial], inertial: [...b.inertial], velocity: [...b.velocity], previous: [...b.prevVelocity] })),
    forceState: s.forces.map((f) => ({ lambda: [...f.lambda], penalty: [...f.penalty], C: [...f.C] })) };
}

test('combine rules use the declared dimensionless coefficients', () => {
  assert.equal(combineRestitution(0.2, 0.8, 'average'), 0.5);
  assert.equal(combineRestitution(0.2, 0.8, 'min'), 0.2);
  assert.equal(combineRestitution(0.2, 0.8, 'max'), 0.8);
  assert.equal(combineRestitution(0.2, 0.8, 'multiply'), 0.2 * 0.8);
  for (const value of [NaN, Infinity, -0.01, 1.01]) {
    assert.throws(() => combineRestitution(value, 0, 'average'), RangeError);
    assert.throws(() => combineRestitution(0, value, 'average'), RangeError);
  }
  assert.throws(() => combineRestitution(0, 0, 'bad' as 'max'), RangeError);
});

test('invalid options and any invalid coefficient reject before solver mutation', () => {
  const invalid = [
    { threshold: NaN }, { threshold: -1 }, { threshold: 0.099 }, { threshold: Infinity },
    { combine: 'bad' }, { impactPenaltyFloor: 1 }, { releaseImpactLambda: 1 }, { restitution: 0 },
  ];
  for (const patch of invalid) {
    const s = contactSolver(), before = snapshot(s);
    assert.throws(() => stepWithRestitution(s, { ...options(), ...patch } as RestitutionOptions));
    assert.deepEqual(snapshot(s), before);
  }
  for (const value of [NaN, Infinity, -1, 1.01]) {
    const s = contactSolver(), before = snapshot(s);
    let calls = 0;
    assert.throws(() => stepWithRestitution(s, { ...options(), restitution: () => ++calls === 1 ? 0.5 : value }));
    assert.equal(calls, 2);
    assert.deepEqual(snapshot(s), before);
  }
  const s = contactSolver();
  stepWithRestitution(s, options());
  const before = snapshot(s);
  assert.throws(() => stepWithRestitution(s, options(NaN)));
  assert.deepEqual(snapshot(s), before);
});

test('invalid solver/body inputs reject before any contact registration', () => {
  for (const patch of [{ dt: 0 }, { dt: NaN }, { dt: 1e-300 }, { iterations: 0 }, { iterations: 1.5 }, { vbd: true }, { alpha: Infinity }]) {
    const s = contactSolver();
    Object.assign(s, patch);
    const before = snapshot(s);
    assert.throws(() => stepWithRestitution(s, options()));
    assert.deepEqual(snapshot(s), before);
  }
  const s = contactSolver();
  s.bodies[1].velocity[0] = NaN;
  const before = snapshot(s);
  assert.throws(() => stepWithRestitution(s, options()));
  assert.deepEqual(snapshot(s), before);
});

test('prior plain manifolds are explicitly refused, including zero mode', () => {
  const s = contactSolver();
  s.step();
  const before = snapshot(s);
  assert.ok(s.forces.some((f) => f instanceof Manifold));
  assert.throws(() => stepWithRestitution(s, options(0)), /ordinary Manifold/);
  assert.deepEqual(snapshot(s), before);
});

test('coefficients are read once per body per step and persistent contacts refresh options', () => {
  const s = contactSolver();
  let calls = 0;
  const values = new Map(s.bodies.map((b) => [b, 0]));
  const config: RestitutionOptions = { ...options(), restitution: (b) => { calls++; return values.get(b)!; } };
  assert.equal(stepWithRestitution(s, config).fired, 0);
  assert.equal(calls, s.bodies.length);
  const manifold = s.forces[0];
  for (const b of s.bodies) values.set(b, 0.9);
  s.bodies[1].position.set([0, 0.99, 0]);
  s.bodies[1].velocity.set([0, -4, 0]);
  config.impactPenaltyFloor = true;
  const result = stepWithRestitution(s, config);
  assert.equal(calls, 2 * s.bodies.length);
  assert.equal(s.forces[0], manifold);
  assert.equal(result.fired, 2);
  assert.ok(result.contacts.every((row) => row.bias === 0.9 * 4 * s.dt && row.penaltyFloor === 1 / (s.dt * s.dt)));
  config.threshold = 10;
  s.bodies[1].position.set([0, 0.99, 0]);
  s.bodies[1].velocity.set([0, -4, 0]);
  assert.equal(stepWithRestitution(s, config).fired, 0);
});

test('normal speed uses both linear and angular Jacobians; tangent row is unchanged', () => {
  const s = contactSolver(), plain = contactSolver();
  for (const solver of [s, plain]) {
    solver.bodies[0].velocity.set([0.2, 0.5, 0.1]);
    solver.bodies[1].velocity.set([1, -4, 0.25]);
  }
  const f = new RestitutionManifold(s, s.bodies[1], s.bodies[0]);
  const reference = new Manifold(plain, plain.bodies[1], plain.bodies[0]);
  f.prepare(0.5, 1, false);
  assert.equal(f.initialize(), true);
  assert.equal(reference.initialize(), true);
  for (const solver of [s, plain]) {
    for (const b of solver.bodies) b.initial.set(b.position);
    solver.bodies[1].position[1] += 0.02;
    solver.bodies[1].position[2] += 0.03;
  }
  f.computeConstraint(0.99);
  reference.computeConstraint(0.99);
  f.contacts.forEach((c, i) => {
    const a = s.bodies[1].velocity, b = s.bodies[0].velocity;
    const vn = c.JAn[0] * a[0] + c.JAn[1] * a[1] + c.JAn[2] * a[2] + c.JBn[0] * b[0] + c.JBn[1] * b[1] + c.JBn[2] * b[2];
    assert.equal(f.incoming[i], vn);
    assert.equal(f.bias[i], 0.5 * -vn * s.dt);
    assert.equal(f.C[i * 2], reference.C[i * 2] + Math.min(0, -f.bias[i] - (1 - 0.99) * c.C0[0]));
    assert.equal(f.C[i * 2 + 1], reference.C[i * 2 + 1]);
  });
});

test('V1 floors only biased normal rows, once, after reference penalty decay', () => {
  const s = contactSolver();
  Object.assign(s, { iterations: 1, gamma: 0.25, beta: 0 });
  const result = stepWithRestitution(s, { ...options(), impactPenaltyFloor: true });
  const f = s.forces[0] as RestitutionManifold;
  assert.equal(result.fired, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(f.penalty[i * 2], 1 / (s.dt * s.dt));
    assert.equal(f.penalty[i * 2 + 1], 1);
  }
  f.penalty[0] = 2;
  f.computeConstraint(s.alpha);
  assert.equal(f.penalty[0], 2, 'floor is not repeated within a step');
  const zero = contactSolver();
  Object.assign(zero, { iterations: 1, gamma: 0.25, beta: 0 });
  stepWithRestitution(zero, { ...options(0), impactPenaltyFloor: true });
  assert.deepEqual([...zero.forces[0].penalty], [1, 1, 1, 1]);
  const capped = contactSolver();
  capped.dt = 1e-6;
  capped.iterations = 1;
  capped.beta = 0;
  const cappedResult = stepWithRestitution(capped, { ...options(), impactPenaltyFloor: true });
  assert.ok(cappedResult.contacts.every((c) => c.penaltyFloor === PENALTY_MAX));
});

test('reference lifecycle drops inactive contacts, preserves history, respects pair exclusions', () => {
  const s = contactSolver();
  stepWithRestitution(s, options(0));
  const f = s.forces[0];
  assert.ok(f instanceof RestitutionManifold);
  const feature = f.contacts[0].feature;
  f.penalty[0] = 1234;
  f.lambda[0] = -7;
  assert.equal(f.initialize(), true);
  const matched = f.contacts.findIndex((c) => c.feature === feature);
  assert.ok(matched >= 0);
  assert.equal(f.penalty[matched * 2], 1234);
  assert.equal(f.lambda[matched * 2], -7);
  s.bodies[1].position[1] = 10;
  s.bodies[1].velocity.fill(0);
  stepWithRestitution(s, options());
  assert.equal(s.forces.length, 0);
  assert.ok(s.bodies.every((b) => b.forces.length === 0));
  const excluded = contactSolver();
  const ignore = new IgnoreCollision(excluded, excluded.bodies[1], excluded.bodies[0]);
  assert.equal(stepWithRestitution(excluded, options()).contacts.length, 0);
  assert.deepEqual(excluded.forces, [ignore]);
});

test('threshold is strict and separating/slow contacts execute the zero-bias path', () => {
  for (const speed of [-1, -0.1, 0, 4]) {
    const s = contactSolver(), plain = contactSolver();
    s.bodies[1].velocity[1] = plain.bodies[1].velocity[1] = speed;
    const result = stepWithRestitution(s, options(0.9));
    plain.step();
    assert.equal(result.fired, 0);
    assert.deepEqual(snapshot(s).bodies.map((b) => [b.position, b.velocity]), snapshot(plain).bodies.map((b) => [b.position, b.velocity]));
  }
});

test('impact measurement retains failed rebound, missing observations remain unknown, fixed gates reject known failures', () => {
  const row: NormalSample = { bodyA: 1, bodyB: 0, feature: 12, row: 0, before: -4, after: -1, bias: 0.03, c0: -0.01,
    normalLambda: -1, penaltyFloor: 0, rowResidual: -0.02 };
  assert.deepEqual(impactRows([row]), [row], 'actual first impact need not reverse velocity');
  assert.deepEqual(impactRows([{ ...row, normalLambda: 0 }]), []);
  assert.equal(ratioGate(null, 0.5), 'unknown');
  assert.equal(ratioGate({ step: 1, rows: [row], ratios: [-0.25] }, 0.5), 'fail');
  assert.equal(ratioGate({ step: 1, rows: [row], ratios: [0.51] }, 0.5), 'fail', 'no-gain bound is independent of +/- .02');
  assert.equal(heightGate({ status: 'unknown', height: null, step: null, reason: 'no apex' }, 0.5, 1), 'unknown');
  assert.equal(heightGate({ status: 'measured', height: 0.23, step: 2, reason: null }, 0.5, 1), 'fail');
});

// These assertions validate the bounded report and measurement rules, not method eligibility.
// A failed A2/A3r/A6 remains a failed result in JSON and does not fail this harness test.
test('predeclared CPU report preserves exact zero mode, bounded coverage and failed eligibility', () => {
  const report = runRestitutionReport();
  assert.equal(report.drops.length, 54);
  assert.equal(report.rest.length, 12);
  assert.ok(report.drops.every((c) => c.steps <= 6000));
  assert.ok(report.rest.every((c) => c.steps === 600 && c.bodies <= 21));
  assert.ok(report.drops.filter((c) => c.e === 0).every((c) => c.gates.A0 === 'pass' && c.firingRows === 0));
  assert.ok(report.rest.every((c) => c.gates.A0 === 'pass'));
  assert.ok(report.rest.filter((c) => c.fixture === 'rest').every((c) => c.gates.A6 === 'pass' && c.maxApproach < 1));
  for (const c of report.drops.filter((c) => c.e > 0)) {
    assert.equal(c.gates.A2, ratioGate(c.impact, c.e));
    assert.equal(c.gates.A3r, heightGate(c.apex, c.e, c.h));
    assert.ok(c.impact && c.impact.rows.every((row) => row.before < -1 && row.normalLambda < 0));
    assert.ok(c.firing.every((event) => event.rows.every((row) => row.bias > 0 && row.before < -1)));
  }
  for (const eligibility of report.eligibility) {
    const failed = report.drops.some((c) => c.set === 'P-3d' && c.variant === eligibility.variant && c.e > 0 &&
      (c.gates.A2 === 'fail' || c.gates.A3r === 'fail'));
    assert.equal(eligibility.status, failed ? 'ineligible' : 'unknown');
  }
  assert.equal(report.laterCases.A7, 'notRun');
  assert.equal(report.laterCases.A8, 'notRun');
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report, 'report is losslessly JSON serializable');
});


test('missing non-finite apex data stays unknown and frozen drop declarations cannot be mutated', () => {
  assert.equal(heightGate({status:'measured',height:NaN,step:2,reason:null},0.5,1),'unknown');
  assert.equal(heightGate({status:'measured',height:Infinity,step:2,reason:null},0.5,1),'unknown');
  assert.equal(Reflect.set(DROP_CASES[0], 'h', 2), false);
  assert.equal(Reflect.set(DROP_CASES, '0', {h:2,dt:1/60}), false);
});


test('signed under-response cannot masquerade as a normal-speed no-gain observation', () => {
  const observed = (rho: number) => ({step:1,rows:[],ratios:[rho]});
  assert.equal(normalSpeedNoGain(observed(-1.1)), 'fail');
  assert.equal(normalSpeedNoGain(observed(1.1)), 'fail');
  assert.equal(normalSpeedNoGain(observed(-1)), 'pass');
  assert.equal(normalSpeedNoGain(observed(0.5)), 'pass');
  assert.equal(normalSpeedNoGain(observed(NaN)), 'unknown');
  assert.equal(normalSpeedNoGain(null), 'unknown');
});


test('fixed failure trace observes the same first impact without feeding ballistic state into the solver', () => {
  for (const variant of ['V0','V1'] as const) {
    const report=traceFirstFailure(variant);
    assert.equal(report.steps,45); assert.equal(report.trace.length,45); assert.equal(report.impactStep,28);
    assert.ok(report.trace.slice(0,27).every(row=>row.ballistic===null));
    const impact=report.trace[27];
    assert.deepEqual(impact.ballistic,{y:impact.position[1],vy:impact.velocity[1]});
    assert.ok(impact.contactRows.every(c=>c.before < -1 && c.bias>0));
    for(let i=28;i<report.trace.length;i++) {
      const prior=report.trace[i-1].ballistic!,now=report.trace[i].ballistic!;
      assert.equal(now.vy,prior.vy-10/60);
      assert.equal(now.y,prior.y+now.vy/60);
    }
    assert.deepEqual(traceFirstFailure(variant),report,'observer is reproducible and owns its state');
    assert.ok(report.trace.every(row=>row.position.every(Number.isFinite)&&row.velocity.every(Number.isFinite)));
  }
});


test('release follows the biased feature across row reorder, preserving penalties, tangents and geometry', () => {
  const s = contactSolver(), plain = contactSolver();
  const f = new RestitutionManifold(s, s.bodies[1], s.bodies[0]);
  const reference = new Manifold(plain, plain.bodies[1], plain.bodies[0]);
  f.prepare(0.5, 1, false, true);
  f.initialize(); reference.initialize();
  const biasedFeature = f.contacts[0].feature;
  f.bias[1] = 0; // Controlled preceding-step history: only one feature was biased.
  for (const manifold of [f, reference]) {
    manifold.lambda.set([-7, 2, -11, 3]);
    manifold.penalty.set([101, 102, 103, 104]);
  }
  // Simulate a different old row order while retaining each feature's own cache.
  f.contacts.reverse(); f.bias.reverse();
  f.lambda.set([-11, 3, -7, 2]); f.penalty.set([103, 104, 101, 102]);
  s.bodies[1].velocity[1] = plain.bodies[1].velocity[1] = 4;
  f.prepare(0.5, 1, false, true);
  f.initialize(); reference.initialize();
  assert.deepEqual(f.contacts, reference.contacts);
  assert.deepEqual(f.penalty, reference.penalty);
  const rows = f.samples();
  rows.forEach((row, i) => {
    assert.equal(f.lambda[i * 2 + 1], reference.lambda[i * 2 + 1]);
    assert.equal(f.lambda[i * 2], row.feature === biasedFeature ? 0 : reference.lambda[i * 2]);
    assert.equal(row.releasedCount, row.feature === biasedFeature ? 1 : 0);
    assert.equal(row.releasedNormalLambda, row.feature === biasedFeature ? -7 : 0);
  });
  // A separating step has no bias; the history cannot linger for a later step.
  f.lambda[0] = -23; f.lambda[2] = -24;
  f.initialize();
  assert.deepEqual([...f.lambda].filter((_, i) => i % 2 === 0), [-23, -24]);
  assert.ok(f.samples().every((row) => row.releasedCount === 0));
});

test('release requires prior impact, matching feature, positive separation and current opt-in', () => {
  for (const scenario of ['rest', 'zero-speed', 'approach', 'unmatched', 'disabled'] as const) {
    const s = contactSolver();
    const f = new RestitutionManifold(s, s.bodies[1], s.bodies[0]);
    f.prepare(scenario === 'rest' ? 0 : 0.5, 1, false, true);
    f.initialize();
    f.lambda.set([-7, 2, -11, 3]);
    if (scenario === 'unmatched') f.contacts.forEach((c) => { c.feature = -c.feature; });
    s.bodies[1].velocity[1] = scenario === 'zero-speed' ? 0 : scenario === 'approach' ? -4 : 4;
    f.prepare(0.5, 1, false, scenario !== 'disabled');
    f.initialize();
    if (scenario === 'unmatched') assert.deepEqual([...f.lambda], [0, 0, 0, 0]);
    else assert.deepEqual([...f.lambda], [-7, 2, -11, 3]);
    assert.ok(f.samples().every((row) => scenario === 'disabled' ?
      !Object.hasOwn(row, 'releasedCount') && !Object.hasOwn(row, 'releasedNormalLambda') : row.releasedCount === 0));
  }
});

test('wrapper refreshes release opt-in on persistent contacts without extra callbacks', () => {
  for (const enabled of [false, true]) {
    const s = contactSolver();
    let calls = 0;
    const config = { ...options(), restitution: () => { calls++; return 0.5; }, releaseImpactLambda: false };
    stepWithRestitution(s, config);
    const f = s.forces[0];
    s.bodies[1].position.set([0, 0.99, 0]);
    s.bodies[1].velocity.set([0, 4, 0]);
    config.releaseImpactLambda = enabled;
    const result = stepWithRestitution(s, config);
    assert.equal(calls, 4);
    assert.equal(s.forces[0], f);
    assert.ok(result.contacts.every((row) => enabled ? row.releasedCount === 1 : !Object.hasOwn(row, 'releasedCount')));
    s.bodies[1].position[1] = 10;
    stepWithRestitution(s, config);
    assert.equal(s.forces.length, 0, 'release diagnostic does not retain inactive manifolds');
  }
});

test('fixed eight-arm memory report preserves controls and retains failed attribution/height observations', () => {
  const report = runMemoryControlReport();
  assert.equal(report.arms.length, 8);
  for (const arm of report.arms) {
    assert.equal(arm.trace.length, 45);
    assert.equal(arm.options.solver.iterations, 10);
    assert.equal(arm.options.solver.dt, 1 / 60);
    assert.equal(arm.options.threshold, 1);
    assert.equal(arm.controls.zeroCoefficientMatchesSameOptionPlainSolver, true);
    if (arm.controls.releaseOnlyFirst28Required) assert.equal(arm.controls.first28MatchesBaseline, true);
    assert.equal(arm.hypothesisScreen.status, Math.abs(arm.step29NetVerticalResponse!) <= 1e-10 ? 'pass' : 'fail');
    assert.equal(arm.gates.A2, ratioGate(arm.impact, 0.5));
    assert.equal(arm.gates.A3r, heightGate(arm.apex, 0.5, 1));
    assert.equal(arm.gates.A3r, 'fail', 'control results cannot erase the original height failure');
    if (arm.control === 'baseline') assert.deepEqual(arm.trace, traceFirstFailure(arm.variant).trace);
    if (arm.options.releaseImpactLambda) {
      assert.equal(arm.releaseCount, 2);
      assert.ok(arm.trace[28].contactRows.every((row) => row.bias === 0 && row.normalLambda === 0 &&
        row.releasedCount === 1 && row.releasedNormalLambda! < 0));
      assert.ok(arm.trace.slice(0, 28).every((row) => row.contactRows.every((c) => c.releasedCount === 0)));
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});
