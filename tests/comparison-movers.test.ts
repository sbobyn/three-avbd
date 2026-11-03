import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BodySpec, Scene } from '../src/comparison/scenes.ts';
import { STATE_SIZE } from '../src/comparison/quality.ts';
import type { createAdapter } from '../src/comparison/adapters.ts';
import { DEFAULTS, runOne, validateOptions } from '../src/comparison/run.ts';
import { satOverlaps } from '../src/comparison/movers.ts';

const box = (position: number[], rotation = [0, 0, 0, 1], size = [1, 1, 1], mass = 1): BodySpec => ({
  shape: 'box', size, position, rotation, velocity: [0, 0, 0], angularVelocity: [0, 0, 0], mass, inertia: [1, 1, 1], friction: 0.5 });
const s = Math.SQRT1_2;
// 1 on the floor with 2 resting on it; 4 sunk 0.1 m into 3; 5 balanced on an edge (45° about x).
const scene: Scene = { name: 'movers', seed: null, up: 'z', gravity: -10, groundTop: 0.5, bodies: [
  box([0, 0, 0], undefined, [200, 200, 1], 0),
  box([0, 0, 1]), box([0, 0, 2]), box([5, 0, 1]), box([5, 0, 1.9]),
  box([10, 0, 0.5 + s], [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)]),
] };

const factory: typeof createAdapter = async () => {
  let step = 0;
  return {
    settings: {}, step() { step++; }, async complete() {}, async inspect() { return {}; },
    async snapshot() {
      const state = Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
      if (step === 10 || step === 11) state[2 * STATE_SIZE + 7] = 0.2;  // body 2 slides for two steps
      if (step === 3) state[3 * STATE_SIZE + 7] = 9;                     // a fast step before the window is ignored
      if (step === 12) state[5 * STATE_SIZE] += 0.3;                     // body 5 has moved 0.3 m by the last step
      return state;
    }, destroy() {},
  };
};

test('--dump-movers reports the final window\'s fastest bodies and deepest pairs with their surroundings', async () => {
  const opts = { ...DEFAULTS, lead: 2, steps: 10, finalWindow: 4, dumpMovers: 3 };
  const r = await runOne('avbd', scene, 0, opts, null as unknown as GPUDevice, undefined, factory);
  assert.equal(r.status, 'completed', r.error);
  const d = r.movers!;
  assert.equal(d.step, 12);
  assert.equal(d.movers.length, 3);
  const [fast] = d.movers;
  assert.deepEqual([fast.id, fast.maxSpeed, fast.maxSpeedStep, fast.stepsAboveSettled], [2, 0.2, 10, 2]);
  assert.equal(fast.speed, 0);
  assert.deepEqual([fast.contacts, fast.above, fast.below, fast.onFloor], [1, 0, 1, false]);
  assert.equal(fast.heightFraction, 1);
  assert.equal(fast.tilt, 0);
  // Body 3's 9 m/s was before the window; the rest tie at 0 and are listed by id.
  assert.deepEqual(d.movers.map(b => b.id), [2, 1, 3]);
  assert.deepEqual([d.movers[1].onFloor, d.movers[1].above], [true, 1]);

  assert.equal(d.deepestPairs.length, 1, 'touching pairs are not overlapping pairs');
  const [pair] = d.deepestPairs;
  assert.deepEqual([pair.a, pair.b], [3, 4]);
  assert.ok(Math.abs(pair.depth - 0.1) < 1e-12 && Math.abs(pair.firstDepth - 0.1) < 1e-12);
  assert.ok(Math.abs(pair.relativeDepth - 0.1) < 1e-12);
  assert.ok(Math.abs(pair.faceOverlap! - 0.1) < 1e-12);
  assert.deepEqual(pair.bodies.map(b => [b.id, b.onFloor, b.above, b.below]), [[3, true, 1, 0], [4, false, 0, 1]]);

  // The edge-balanced body: tilt 45°, on the floor, and its window displacement.
  const all = await runOne('avbd', scene, 0, { ...opts, dumpMovers: 5 }, null as unknown as GPUDevice, undefined, factory);
  const edge = all.movers!.movers.find(b => b.id === 5)!;
  assert.ok(Math.abs(edge.tilt - 45) < 1e-9);
  assert.equal(edge.onFloor, true);
  assert.ok(Math.abs(edge.displacement - 0.3) < 1e-12);
  assert.equal(edge.contacts, 0);
});

test('--dump-movers is off by default and validated', async () => {
  const r = await runOne('avbd', scene, 0, { ...DEFAULTS, lead: 2, steps: 10, finalWindow: 4 }, null as unknown as GPUDevice, undefined, factory);
  assert.equal(r.status, 'completed', r.error);
  assert.equal(r.movers, undefined);
  assert.throws(() => validateOptions({ ...DEFAULTS, dumpMovers: -1 }));
  assert.throws(() => validateOptions({ ...DEFAULTS, dumpMovers: 1.5 }));
});

test('satOverlaps separates the face and edge axes of an edge-on-edge crossing', () => {
  // Two unit cubes turned 45° about x and about y, crossing edge to edge 0.1 m deep along z.
  const qa = [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)], qb = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  const { face, edge } = satOverlaps([0, 0, 0], qa, [1, 1, 1], [0, 0, 2 * s - 0.1], qb, [1, 1, 1]);
  assert.ok(Math.abs(edge - 0.1) < 1e-12);
  assert.ok(face > edge + 0.1, `face ${face}`);
});
