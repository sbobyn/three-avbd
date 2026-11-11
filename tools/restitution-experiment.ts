// Bounded CPU-only report host for docs/RESTITUTION_DESIGN.md §7. No tuning or rendering.
import { pathToFileURL } from 'node:url';
import { COLLISION_MARGIN, Rigid } from '../src/avbd2d/ref/body.ts';
import { Manifold } from '../src/avbd2d/ref/manifold.ts';
import { sceneByName } from '../src/avbd2d/ref/scenes.ts';
import { defaultParams, parallelParams, Solver } from '../src/avbd2d/ref/solver.ts';
import { stepWithRestitution } from '../src/avbd2d/experiments/restitution.ts';
import type { NormalSample } from '../src/avbd2d/experiments/restitution.ts';

export type Gate = 'pass' | 'fail' | 'unknown' | 'notRun';
export type ParameterSet = 'P-ref' | 'P-par' | 'P-3d';
export type Variant = 'V0' | 'V1';
export const DROP_CASES = Object.freeze([Object.freeze({ h: 1, dt: 1 / 60 }), Object.freeze({ h: 1, dt: 1 / 240 }), Object.freeze({ h: 4, dt: 1 / 240 })] as const);
const PARAMETER_SETS: ParameterSet[] = ['P-ref', 'P-par', 'P-3d'];
const VARIANTS: Variant[] = ['V0', 'V1'];
const MAX_DROP_STEPS = 6000;
const REST_STEPS = 600;
const THRESHOLD = 1;

function solverFor(set: ParameterSet, dt: number): Solver {
  const s = new Solver();
  Object.assign(s, set === 'P-par' ? parallelParams() : defaultParams(), { dt });
  if (set === 'P-3d') s.postStabilize = false;
  return s;
}

function buildDrop(s: Solver, h: number): Rigid {
  new Rigid(s, [100, 1], 0, 0.5, [0, 0, 0]);
  // h is the declared geometric gap above the ground; margin height starts h + margin.
  return new Rigid(s, [1, 1], 1, 0.5, [0, 1 + h, 0]);
}

function marginHeight(body: Rigid): number {
  const theta = body.position[2];
  const halfExtent = (Math.abs(Math.cos(theta)) * body.size[1] + Math.abs(Math.sin(theta)) * body.size[0]) / 2;
  return body.position[1] - halfExtent - 0.5 + COLLISION_MARGIN;
}

function trajectory(s: Solver): number[][] {
  return s.bodies.map((b) => [...b.position, ...b.velocity]);
}

function equalTrajectory(a: Solver, b: Solver): boolean {
  const other = trajectory(b);
  const actual = trajectory(a);
  return actual.length === other.length && actual.every((row, i) => row.length === other[i].length &&
    row.every((value, j) => Number.isFinite(value) && Object.is(value, other[i][j])));
}

/** First contact solve with an approaching row and an actual compressive normal force.
 * An outgoing sign reversal is deliberately not required: under-convergence is evidence.
 */
export function impactRows(samples: NormalSample[]): NormalSample[] {
  return samples.filter((sample) => sample.before < -THRESHOLD && sample.normalLambda < 0);
}

function plainStep(s: Solver): NormalSample[] {
  const velocities = s.bodies.map((b) => [...b.velocity]);
  s.step();
  return s.forces.flatMap((f) => {
    if (!(f instanceof Manifold)) return [];
    const ia = s.bodies.indexOf(f.bodyA!), ib = s.bodies.indexOf(f.bodyB);
    return f.contacts.map((c, i) => {
      const rowDot = (a: ArrayLike<number>, b: ArrayLike<number>): number =>
        c.JAn[0] * a[0] + c.JAn[1] * a[1] + c.JAn[2] * a[2] + c.JBn[0] * b[0] + c.JBn[1] * b[1] + c.JBn[2] * b[2];
      const after = rowDot(f.bodyA!.velocity, f.bodyB.velocity);
      return {
        bodyA: ia, bodyB: ib, feature: c.feature, row: i * 2,
        before: rowDot(velocities[ia], velocities[ib]), after, bias: 0, c0: c.C0[0],
        normalLambda: f.lambda[i * 2], penaltyFloor: 0,
        rowResidual: after * s.dt + (s.postStabilize ? 0 : (1 - s.alpha) * c.C0[0]),
      };
    });
  });
}

interface Impact {
  step: number;
  rows: NormalSample[];
  /** Conservative gate evaluation uses every normal row, not only an average. */
  ratios: number[];
}

interface Apex {
  status: 'measured' | 'unknown';
  height: number | null;
  step: number | null;
  reason: string | null;
}

interface Flight {
  impact: Impact | null;
  apex: Apex;
  maxHeight: number;
  maxHeightStep: number;
  hasRisen: boolean;
  leftContact: boolean;
  ended: boolean;
}

function flight(): Flight {
  return { impact: null, apex: { status: 'unknown', height: null, step: null, reason: 'No impact observed within step cap' },
    maxHeight: -Infinity, maxHeightStep: 0, hasRisen: false, leftContact: false, ended: false };
}

function sampleFlight(state: Flight, body: Rigid, samples: NormalSample[], step: number): void {
  const impacting = impactRows(samples);
  if (!state.impact && impacting.length) {
    state.impact = { step, rows: impacting, ratios: impacting.map((row) => row.after / Math.abs(row.before)) };
    state.apex.reason = 'No upward flight and apex observed within step cap';
  }
  if (!state.impact || state.apex.status === 'measured' || state.ended) return;
  if (state.leftContact && impacting.length) {
    state.apex.reason = 'Next impact arrived before a measured first apex';
    state.ended = true;
    return;
  }
  if (!samples.length) state.leftContact = true;
  const height = marginHeight(body);
  if (height > state.maxHeight) { state.maxHeight = height; state.maxHeightStep = step; }
  // In-contact round-off jitter is not an observed ballistic apex.
  if (state.leftContact && height > 0 && body.velocity[1] > 0) state.hasRisen = true;
  else if (state.hasRisen) {
    state.apex = { status: 'measured', height: state.maxHeight, step: state.maxHeightStep, reason: null };
  }
}

export function ratioGate(impact: Impact | null, e: number): Gate {
  if (!impact || !impact.ratios.length || !impact.ratios.every(Number.isFinite)) return 'unknown';
  return impact.ratios.every((rho) => Math.abs(rho - e) <= 0.02 && rho <= e + 0.005) ? 'pass' : 'fail';
}

export function heightGate(apex: Apex, e: number, h: number): Gate {
  if (apex.status !== 'measured' || apex.height === null || !Number.isFinite(apex.height)) return 'unknown';
  return Math.abs(apex.height - e * e * h) <= 0.05 * e * e * h ? 'pass' : 'fail';
}

/** Normal-speed magnitude only, not total mechanical energy or a multi-contact conservation proof. */
export function normalSpeedNoGain(impact: Impact | null): Gate {
  if (!impact || !impact.ratios.length || !impact.ratios.every(Number.isFinite)) return 'unknown';
  return impact.ratios.every(rho => Math.abs(rho) <= 1) ? 'pass' : 'fail';
}

export function measureDrop(set: ParameterSet, variant: Variant, h: number, dt: number, e: number) {
  if (!PARAMETER_SETS.includes(set) || !VARIANTS.includes(variant) ||
      !DROP_CASES.some((c) => c.h === h && c.dt === dt) || ![0, 0.5, 0.9].includes(e)) {
    throw new RangeError('Only the predeclared drop cases are supported');
  }
  const s = solverFor(set, dt), control = solverFor(set, dt);
  const body = buildDrop(s, h), controlBody = buildDrop(control, h);
  const actual = flight(), baseline = flight();
  const firing: { step: number; rows: NormalSample[] }[] = [];
  let exactZero = true, steps = 0;
  for (let step = 1; step <= MAX_DROP_STEPS; step++) {
    const result = stepWithRestitution(s, { restitution: () => e, combine: 'average', threshold: THRESHOLD, impactPenaltyFloor: variant === 'V1' });
    const controlRows = plainStep(control);
    if (e === 0 && !equalTrajectory(s, control)) exactZero = false;
    if (result.fired) firing.push({ step, rows: result.contacts.filter((row) => row.bias > 0) });
    sampleFlight(actual, body, result.contacts, step);
    sampleFlight(baseline, controlBody, controlRows, step);
    steps = step;
    // Preserve 600 matched steps. A missing baseline flight stays unknown rather than
    // chasing tiny in-contact velocity reversals for thousands of frames.
    if (step >= REST_STEPS && actual.impact && baseline.impact &&
        (e === 0 || actual.apex.status === 'measured' || actual.ended)) break;
  }
  const a2: Gate = e > 0 ? ratioGate(actual.impact, e) : 'notRun';
  const a3r: Gate = e > 0 ? heightGate(actual.apex, e, h) : 'notRun';
  const a1: Gate = e !== 0 ? 'notRun' : actual.apex.height === null || baseline.apex.height === null ? 'unknown' :
    actual.apex.height <= baseline.apex.height + 1e-12 ? 'pass' : 'fail';
  const rhoNoGain: Gate = actual.impact ? actual.impact.ratios.every((rho) => rho <= e + 0.005) ? 'pass' : 'fail' : 'unknown';
  const apexNoGain: Gate = actual.apex.height === null ? 'unknown' : actual.apex.height <= h ? 'pass' : 'fail';
  const first = actual.impact?.rows[0];
  const initialMarginHeight = h + COLLISION_MARGIN;
  const overlap = first ? Math.max(0, -first.c0) : null;
  const predicted = first && overlap !== null ? e * e * initialMarginHeight + overlap * (e * e - 1 + (s.postStabilize ? 1 : 0)) +
    e * Math.abs(first.before) * dt * (1 - e) / 2 : null;
  return {
    set, variant, h, dt, e, steps, initialMarginHeight,
    targetHeight: e * e * h, impact: actual.impact, apex: actual.apex, controlImpact: baseline.impact, controlApex: baseline.apex,
    heightErrorFraction: actual.apex.height !== null && e > 0 ? (actual.apex.height - e * e * h) / (e * e * h) : null,
    unverifiedDraftDiagnostic: { overlap, predictedHeight: predicted,
      residual: predicted !== null && actual.apex.height !== null ? actual.apex.height - predicted : null },
    convergence: { status: 'unknown', detail: 'Fixed-J row residual is recorded per contact; no convergence tolerance was predeclared' },
    firing, firingSteps: firing.length, firingRows: firing.reduce((count, event) => count + event.rows.length, 0),
    repeatedActivation: firing.some((event, i) => i > 0 && event.step === firing[i - 1].step + 1),
    gates: { A0: e === 0 ? exactZero ? 'pass' : 'fail' : 'notRun', A1: a1, A2: a2, A3r: a3r,
      A4ratio: rhoNoGain, A4normalSpeedMagnitude: normalSpeedNoGain(actual.impact), A4firstApex: apexNoGain, A4fiveApices: 'notRun' },
  };
}

export function measureRest(set: ParameterSet, variant: Variant, fixture: 'rest' | 'stack') {
  const s = solverFor(set, 1 / 60), zero = solverFor(set, 1 / 60), plain = solverFor(set, 1 / 60);
  for (const solver of [s, zero, plain]) {
    if (fixture === 'stack') sceneByName('Stack').build(solver);
    else buildDrop(solver, 0);
  }
  let exact = true, zeroExact = true, maxApproach = 0, controlMaxApproach = 0, fired = 0;
  let firstDifferenceStep: number | null = null;
  const firing: { step: number; rows: NormalSample[] }[] = [];
  for (let step = 1; step <= REST_STEPS; step++) {
    const result = stepWithRestitution(s, { restitution: () => 0.9, combine: 'average', threshold: THRESHOLD, impactPenaltyFloor: variant === 'V1' });
    const controlResult = stepWithRestitution(zero, { restitution: () => 0, combine: 'average', threshold: THRESHOLD, impactPenaltyFloor: variant === 'V1' });
    plain.step();
    maxApproach = Math.max(maxApproach, result.maxApproach);
    controlMaxApproach = Math.max(controlMaxApproach, controlResult.maxApproach);
    fired += result.fired;
    if (result.fired) firing.push({ step, rows: result.contacts.filter((row) => row.bias > 0) });
    if (!equalTrajectory(s, zero)) { exact = false; firstDifferenceStep ??= step; }
    if (!equalTrajectory(zero, plain)) zeroExact = false;
  }
  return { set, variant, fixture, steps: REST_STEPS, bodies: s.bodies.length, maxApproach, controlMaxApproach, threshold: THRESHOLD,
    fixtureNote: fixture === 'stack' ? 'Unmodified reference Stack starts with 1m gaps; not a pre-settled quiet stack' : 'Single box starts touching ground',
    firstDifferenceStep,
    fired, firing, gates: { A0: zeroExact ? 'pass' : 'fail', A6: exact && fired === 0 ? 'pass' : 'fail' } };
}

export function runRestitutionReport() {
  const drops = PARAMETER_SETS.flatMap((set) => VARIANTS.flatMap((variant) => DROP_CASES.flatMap(({ h, dt }) =>
    [0, 0.5, 0.9].map((e) => measureDrop(set, variant, h, dt, e)))));
  const rest = PARAMETER_SETS.flatMap((set) => VARIANTS.flatMap((variant) =>
    (['rest', 'stack'] as const).map((fixture) => measureRest(set, variant, fixture))));
  const firstFailure = drops.find((c) => c.set === 'P-3d' && c.e > 0 && (c.gates.A2 === 'fail' || c.gates.A3r === 'fail'));
  return {
    schema: 1, purpose: 'Bounded f64 sequential CPU restitution experiment; not GPU or public API qualification',
    units: { length: 'metres', velocity: 'metres/second', dt: 'seconds', coefficient: 'dimensionless', rowResidual: 'metres' },
    sampling: { maxDropSteps: MAX_DROP_STEPS, restSteps: REST_STEPS, maxBodies: 21, dropCases: 54, restCases: 12,
      threshold: THRESHOLD, iterations: 10, gravity: -10, normalSpeed: 'Same step-start contact Jacobian before and after the same solve',
      impact: 'First approaching contact solve with before < -1 m/s and compressive normal lambda; no reversal requirement',
      apex: 'Maximum sampled margin-referenced geometric bottom height after first impact, through first vertical velocity sign change after observed upward contact-free flight, before next impact; no interpolation; in-contact jitter is not an apex',
      heightTarget: 'Original e² times declared geometric drop gap h; margin reference adds 0.0005m to initial height',
      draftFormula: 'Unverified diagnostic; omits discrete apex sampling and does not alter A3r',
      noGain: 'A4ratio is the signed restitution-response upper bound only; A4normalSpeedMagnitude compares absolute normal-speed ratios to 1. Neither proves total mechanical energy conservation; coupled/oblique energy and five-apex checks remain notRun' },
    drops, rest,
    eligibility: VARIANTS.map((variant) => {
      const candidate = drops.filter((c) => c.set === 'P-3d' && c.variant === variant && c.e > 0);
      return { set: 'P-3d', variant, status: candidate.some((c) => c.gates.A2 === 'fail' || c.gates.A3r === 'fail') ? 'ineligible' : 'unknown',
        A2: candidate.every((c) => c.gates.A2 === 'pass') ? 'pass' : candidate.some((c) => c.gates.A2 === 'fail') ? 'fail' : 'unknown',
        A5: candidate.every((c) => c.gates.A2 === 'pass') ? 'pass' : candidate.some((c) => c.gates.A2 === 'fail') ? 'fail' : 'unknown',
        A3r: candidate.every((c) => c.gates.A3r === 'pass') ? 'pass' : candidate.some((c) => c.gates.A3r === 'fail') ? 'fail' : 'unknown' };
    }),
    firstFalsifyingCase: firstFailure ? { set: firstFailure.set, variant: firstFailure.variant, h: firstFailure.h, dt: firstFailure.dt, e: firstFailure.e,
      ratios: firstFailure.impact?.ratios, apex: firstFailure.apex, gates: firstFailure.gates } : null,
    laterCases: { A4fiveApices: 'notRun', A7: 'notRun', A8: 'notRun',
      reason: firstFailure ? 'Mandatory positive-e P-3d eligibility falsified; no coupled/oblique expansion or five-apex qualification' : 'First-stage report only; later qualification not performed' },
  };
}

/** Fixed diagnostic witness for the already falsified case, not another search or tuning arm. */
export function traceFirstFailure(variant: Variant) {
  return traceMemoryArm(variant, false, false);
}

function traceMemoryArm(variant: Variant, releaseImpactLambda: boolean, stiffnessRescale: boolean) {
  if (!VARIANTS.includes(variant)) throw new RangeError('Unknown trace variant');
  const s = solverFor('P-3d', 1 / 60), body = buildDrop(s, 1);
  s.stiffnessRescale = stiffnessRescale;
  const trace: {step:number; position:number[]; velocity:number[]; height:number; contactRows:NormalSample[];
    netVerticalResponse:number; ballistic:{y:number;vy:number}|null}[] = [];
  let ballistic: {y:number;vy:number}|null = null;
  let impactStep:number|null = null;
  for (let step=1;step<=45;step++) {
    const previousVy=body.velocity[1];
    if (ballistic) {
      ballistic.vy += s.gravity*s.dt;
      ballistic.y += ballistic.vy*s.dt;
    }
    const result=stepWithRestitution(s,{restitution:()=>0.5,combine:'average',threshold:THRESHOLD,impactPenaltyFloor:variant==='V1',releaseImpactLambda});
    if (impactStep===null && impactRows(result.contacts).length) {
      impactStep=step;
      ballistic={y:body.position[1],vy:body.velocity[1]};
    }
    trace.push({step,position:[...body.position],velocity:[...body.velocity],height:marginHeight(body),
      contactRows:result.contacts,netVerticalResponse:body.velocity[1]-(previousVy+s.gravity*s.dt),
      ballistic:ballistic?{...ballistic}:null});
  }
  return {variant,steps:45,impactStep,trace,scope:'Owned Solver, unchanged failing case. Ballistic counterfactual starts at the observed impact endpoint; netVerticalResponse includes all departures from a free gravity step, not an independently measured contact impulse or energy.'};
}

/** Fixed §15 factorial controls. No free-form sweep or replacement eligibility gate. */
export function runMemoryControlReport() {
  const arms = VARIANTS.flatMap((variant) => [false, true].flatMap((stiffnessRescale) =>
    [false, true].map((releaseImpactLambda) => {
      const observation = traceMemoryArm(variant, releaseImpactLambda, stiffnessRescale);
      const baseline = traceFirstFailure(variant);
      const state = flight();
      // Replay only observations through the unchanged apex/impact measurement rules.
      const observer = solverFor('P-3d', 1 / 60), body = buildDrop(observer, 1);
      for (const row of observation.trace) {
        body.position.set(row.position);
        body.velocity.set(row.velocity);
        sampleFlight(state, body, row.contactRows, row.step);
      }
      const zero = solverFor('P-3d', 1 / 60), plain = solverFor('P-3d', 1 / 60);
      zero.stiffnessRescale = plain.stiffnessRescale = stiffnessRescale;
      buildDrop(zero, 1); buildDrop(plain, 1);
      let zeroExact = true;
      for (let step = 1; step <= 45; step++) {
        stepWithRestitution(zero, { restitution: () => 0, combine: 'average', threshold: THRESHOLD,
          impactPenaltyFloor: variant === 'V1', releaseImpactLambda });
        plain.step();
        if (!equalTrajectory(zero, plain)) zeroExact = false;
      }
      const first28Exact = observation.trace.slice(0, 28).every((row, i) =>
        [row.position, row.velocity].every((values, j) => values.every((v, k) =>
          Object.is(v, (j === 0 ? baseline.trace[i].position : baseline.trace[i].velocity)[k]))));
      const residual = observation.trace.find((row) => row.step === 29)?.netVerticalResponse ?? null;
      const endpoint = observation.trace.find((row) => row.step === observation.impactStep);
      const releaseCount = observation.trace.reduce((sum, row) => sum +
        row.contactRows.reduce((count, c) => count + (c.releasedCount ?? 0), 0), 0);
      return {
        variant, control: releaseImpactLambda ? stiffnessRescale ? 'both' : 'impact-lambda-release' :
          stiffnessRescale ? 'stiffnessRescale' : 'baseline',
        options: { set: 'P-3d', h: 1, e: 0.5, steps: 45, threshold: THRESHOLD, combine: 'average',
          impactPenaltyFloor: variant === 'V1', releaseImpactLambda,
          solver: { ...defaultParams(), postStabilize: false, stiffnessRescale } },
        impact: state.impact,
        impactEndpoint: endpoint ? { step: endpoint.step, position: endpoint.position, velocity: endpoint.velocity } : null,
        apex: state.apex, targetHeight: 0.25,
        gates: { A2: ratioGate(state.impact, 0.5), A3r: heightGate(state.apex, 0.5, 1) },
        step29NetVerticalResponse: residual,
        hypothesisScreen: { tolerance: 1e-10, status: residual === null || !Number.isFinite(residual) ? 'unknown' :
          Math.abs(residual) <= 1e-10 ? 'pass' : 'fail' },
        controls: { zeroCoefficientMatchesSameOptionPlainSolver: zeroExact,
          first28MatchesBaseline: first28Exact,
          releaseOnlyFirst28Required: releaseImpactLambda && !stiffnessRescale },
        releaseCount, trace: observation.trace,
      };
    })));
  return { schema: 1, purpose: 'Fixed prospective CPU attribution controls, not physical accuracy or energy qualification',
    originalHeightGoal: { target: 0.25, relativeTolerance: 0.05, unchanged: true },
    scope: 'Owned f64 Solver only; existing clamped-force Hessian rescaling is an independent opt-in. No production inference. Original baseline A3r failures retained.',
    arms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || !['--json','--trace-first','--trace-memory-control'].includes(process.argv[2])) throw new Error('Usage: node --experimental-transform-types tools/restitution-experiment.ts --json|--trace-first|--trace-memory-control');
  const report=process.argv[2]==='--trace-memory-control'?runMemoryControlReport():process.argv[2]==='--trace-first'?{schema:1,purpose:'Fixed first-failure diagnostic, no method or gate changes',traces:VARIANTS.map(traceFirstFailure)}:runRestitutionReport();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
