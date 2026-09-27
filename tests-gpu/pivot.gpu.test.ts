// The per-body 6x6 Newton solve (finishBody, an unpivoted LDLᵀ in f32) against ill-conditioned
// systems: a light sliver resting on an edge under contacts at PENALTY_MAX. Rotation about the
// edge is held only by the sliver's inertia term, ~12 orders of magnitude under the contact
// rows, so in f32 its pivot cancels to noise and can come out negative: the Newton step then
// climbs instead of descending and the body goes to Inf, then NaN (three-destruction STE-2219).

import assert from 'node:assert/strict';
import { BODY_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Manifold } from '../src/avbd3d/ref/manifold.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { gpuTest } from './device.ts';

gpuTest('a sliver on its edge under saturated contacts stays finite', async (device) => {
  const ref = new Solver();
  new Rigid(ref, [100, 100, 1], 0, 0.8, [0, 0, -0.5]);
  // 5 cm × 4 mm × 4 mm at 750 kg/m³: 0.6 g, turned 45° about its length to rest on an edge
  const chip = new Rigid(ref, [0.05, 0.004, 0.004], 750, 0.8, [0, 0, 0.004 * Math.SQRT1_2]);
  const s = Math.sin(Math.PI / 8);
  chip.positionAng.set([s, 0, 0, Math.cos(Math.PI / 8)]);
  for (let i = 0; i < 5; i++) ref.step();
  const manifolds = ref.forces.filter((f): f is Manifold => f instanceof Manifold);
  assert.ok(manifolds.some((m) => m.contacts.length === 2), 'the chip rests on an edge (2 contacts)');
  // As under a slab's weight: every contact row at PENALTY_MAX, the chip rocking about the edge
  for (const m of manifolds) for (const c of m.contacts) c.penalty.set([1e10, 1e10, 1e10]);
  chip.velocityAng.set([3, 0, 0]);
  const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
  gpu.params.matchNearest = false;
  gpu.params.faceBias = false;
  gpu.params.reuseContacts = false;
  gpu.seedFrom(ref);
  for (let i = 0; i < 20; i++) gpu.step();
  const bodies = await gpu.readBodies();
  const at = ref.bodies.indexOf(chip) * BODY_FLOATS;
  const state = [...bodies.subarray(at, at + BODY_FLOATS)];
  assert.ok(state.every(Number.isFinite), `chip state ${state}`);
  // Still on the ground, not flung away
  assert.ok(Math.abs(state[2]) < 0.05 && Math.hypot(state[0], state[1]) < 0.05, `chip at ${state.slice(0, 3)}`);
  gpu.destroy();
});
