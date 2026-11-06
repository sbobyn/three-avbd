import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeScene } from '../src/comparison/scenes.ts';
import { STATE_SIZE, type Quality } from '../src/comparison/quality.ts';
import { createAdapter } from '../src/comparison/adapters.ts';
import { DEFAULTS, runOne, validateOptions } from '../src/comparison/run.ts';
import { finalWindow, REST_SPEED, restFraction, SETTLED_MAX_SPEED, type WindowSample } from '../src/comparison/final-window.ts';

// Unit-size bodies, so relative depths equal absolute depths.
function sample(step: number, floor: number, pair: number | null, speed: number, rest = 1): WindowSample {
  const quality: Quality = { nonFiniteBodies: 0, invalidRotations: 0, outsideFloorBodies: 0,
    maxFloorPenetration: floor, maxRelativeFloorPenetration: floor, maxBoxFloorPenetration: floor,
    maxSphereFloorPenetration: 0, worstBody: 1, maxSpeed: speed, translationalKineticEnergy: 0.5 * speed * speed };
  const contacts = pair === null ? null : { maxDepth: pair, maxRelativeDepth: pair, worstPair: [1, 2], candidatePairs: 1 };
  return { step, quality, contacts, restFraction: rest };
}
/** 600 measured steps: an impact phase of `impactSteps`, then a resting pile. */
function trace(impactSteps: number): WindowSample[] {
  return Array.from({ length: 600 }, (_, i) => i < impactSteps
    ? sample(601 + i, 0.3, 0.4, 5, 0.1) : sample(601 + i, 0.002, 0.003, 0.001));
}

test('final-window metrics ignore impacts before the window and report a settled pile', () => {
  const quiet = finalWindow(trace(0));
  const dropped = finalWindow(trace(540));
  assert.deepEqual(dropped, quiet);
  assert.equal(dropped.steps, 60);
  assert.equal(dropped.firstStep, 1141);
  assert.equal(dropped.lastStep, 1200);
  assert.equal(dropped.maxFloorPenetration, 0.002);
  assert.equal(dropped.p95FloorPenetration, 0.002);
  assert.equal(dropped.maxContactDepth, 0.003);
  assert.equal(dropped.p95ContactDepth, 0.003);
  assert.equal(dropped.maxSpeed, 0.001);
  assert.equal(dropped.restFraction, 1);
  assert.equal(dropped.contactTargetMet, true);
  assert.equal(dropped.settled, true);
  // One impact step inside the window is caught.
  const late = finalWindow(trace(541));
  assert.equal(late.maxContactDepth, 0.4);
  assert.equal(late.maxSpeed, 5);
  assert.equal(late.contactTargetMet, false);
  assert.equal(late.settled, false);
  // A window longer than the measured samples uses all of them.
  assert.equal(finalWindow(trace(0).slice(0, 10)).steps, 10);
  assert.throws(() => finalWindow(trace(0), 0));
  assert.throws(() => finalWindow([]));
});

test('final-window p95 discounts a single spike, settled needs the speed bound and measured pairs', () => {
  const spiked = trace(0);
  spiked[580] = sample(1181, 0.05, 0.06, 0.001);
  const f = finalWindow(spiked);
  assert.equal(f.maxFloorPenetration, 0.05);
  assert.equal(f.p95FloorPenetration, 0.002);
  assert.equal(f.maxContactDepth, 0.06);
  assert.equal(f.p95ContactDepth, 0.003);
  assert.equal(f.settled, false);
  // Contact target met throughout, but one body still sliding faster than the bound.
  const sliding = trace(0);
  sliding[599] = sample(1200, 0.002, 0.003, SETTLED_MAX_SPEED * 2, 0.99);
  const s = finalWindow(sliding);
  assert.equal(s.contactTargetMet, true);
  assert.equal(s.settled, false);
  assert.equal(s.restFraction, 0.99);
  const atBound = trace(0);
  atBound[599] = sample(1200, 0.002, 0.003, SETTLED_MAX_SPEED);
  assert.equal(finalWindow(atBound).settled, true);
  // Unmeasured pairs on any window step: no claim either way.
  const unmeasured = trace(0);
  unmeasured[590] = sample(1191, 0.002, null, 0.001);
  const u = finalWindow(unmeasured);
  assert.equal(u.maxContactDepth, null);
  assert.equal(u.contactTargetMet, null);
  assert.equal(u.settled, null);
});

test('rest fraction counts dynamic bodies below the rest speed', () => {
  const scene = makeScene('rest-stack');
  const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, 0, 0, 0, 0, 0, 0]));
  const dynamic = scene.bodies.filter(b => b.mass > 0).length;
  assert.equal(restFraction(scene, state), 1);
  state[STATE_SIZE + 9] = -REST_SPEED;  // exactly at the rest speed is moving
  state[0 + 7] = 5;                     // the static ground is not counted
  assert.equal(restFraction(scene, state), (dynamic - 1) / dynamic);
});

test('large final windows retain maxima without exceeding the call argument limit', () => {
  const samples = Array.from({ length: 150_000 }, (_, i) => sample(i + 1, 0.002, 0.003, 0.001));
  samples[75_000] = sample(75_001, 0.05, 0.06, 2);
  const result = finalWindow(samples, samples.length);
  assert.deepEqual([result.steps, result.firstStep, result.lastStep], [150_000, 1, 150_000]);
  assert.equal(result.maxFloorPenetration, 0.05);
  assert.equal(result.maxRelativeFloorPenetration, 0.05);
  assert.equal(result.p95FloorPenetration, 0.002);
  assert.equal(result.maxContactDepth, 0.06);
  assert.equal(result.maxRelativeContactDepth, 0.06);
  assert.equal(result.p95ContactDepth, 0.003);
  assert.equal(result.maxSpeed, 2);
  assert.equal(result.maxKineticEnergy, 2);
  assert.equal(result.finalKineticEnergy, 0.5 * 0.001 * 0.001);
  assert.equal(result.settled, false);
});

test('runOne reports final-window metrics alongside the unchanged worst-over-window metrics', async () => {
  const scene = makeScene('rest-stack');
  const factory: typeof createAdapter = async () => {
    let step = 0;
    return {
      settings: {}, step() { step++; }, async complete() {}, async inspect() { return {}; },
      async snapshot() {
        const state = Float64Array.from(scene.bodies.flatMap(b =>
          [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
        // A measured-window impact before the final window: deep in the floor and fast.
        if (step === 4) { state[STATE_SIZE + 2] -= 0.1; state[STATE_SIZE + 9] = -3; }
        return state;
      }, destroy() {},
    };
  };
  const opts = { ...DEFAULTS, lead: 2, steps: 10, finalWindow: 4 };
  const r = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.contactTargetMet, false);
  assert.equal(r.measuredContactTargetMet, false);
  assert.equal(r.worstQuality!.maxSpeed, 3);
  const f = r.finalWindow!;
  assert.deepEqual([f.steps, f.firstStep, f.lastStep], [4, 9, 12]);
  assert.equal(f.maxSpeed, 0);
  assert.equal(f.restFraction, 1);
  assert.equal(f.contactTargetMet, true);
  assert.equal(f.settled, true);
  assert.ok(f.maxFloorPenetration < 0.01 && f.maxContactDepth! < 0.01);
  // An impact inside the final window is not settled.
  const inside = await runOne('avbd', scene, 0, { ...opts, finalWindow: 9 }, null as unknown as GPUDevice, undefined, factory);
  assert.equal(inside.finalWindow!.steps, 9);
  assert.equal(inside.finalWindow!.settled, false);
  assert.equal(inside.finalWindow!.maxSpeed, 3);
  assert.throws(() => validateOptions({ ...DEFAULTS, finalWindow: 0 }));
});
