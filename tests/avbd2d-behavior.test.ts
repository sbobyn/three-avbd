// Physical behaviour every 2D backend must reproduce. Thresholds are calibrated against the
// reference port (docs/FINDINGS.md), so a backend passing here behaves like the upstream demo.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SolverParams } from '../src/avbd2d/ref/solver.ts';
import { type CpuBackend2D, createSim, type Sim2D } from '../src/avbd2d/sim.ts';

function run(backend: CpuBackend2D, scene: string, frames: number, params: Partial<SolverParams> = {}): Sim2D {
  const sim = createSim(backend, scene, params);
  for (let i = 0; i < frames; i++) sim.step();
  return sim;
}

const dynamicIds = (s: Sim2D) => [...Array(s.bodyCount).keys()].filter((i) => s.isDynamic(i));
const maxY = (s: Sim2D) => Math.max(...dynamicIds(s).map((i) => s.pose(i)[1]));

// Boxes start 2 apart at x = -30 + 2i with friction 5 - 0.5i against ground friction 0.5, all
// at 10 m/s. Coulomb stopping distance: d = v² / (2 μ g), μ = sqrt(μ_box μ_ground).
const slid = (s: Sim2D) => dynamicIds(s).map((id, i) => s.pose(id)[0] - (-30 + i * 2));
const coulomb = (i: number) => 100 / (2 * Math.sqrt((5 - i * 0.5) * 0.5) * 10);

for (const backend of ['ref', 'soa-seq', 'soa-colored'] as CpuBackend2D[]) {
  describe(`2D behaviour: ${backend}`, () => {
    test('stack of 20 boxes stays standing', () => {
      const s = run(backend, 'Stack', 600);
      const top = s.pose(s.bodyCount - 1);
      assert.ok(Math.abs(top[1] - 20) < 0.05, `top y ${top[1]}`);
      assert.ok(Math.abs(top[0]) < 0.01, `top x ${top[0]}`);
      assert.ok(s.stats().kineticEnergy < 1e-3);
    });

    test('pyramid of 210 boxes settles without collapsing', () => {
      const s = run(backend, 'Pyramid', 600);
      // Ground top at -1.75 plus 20 rows of 0.5 puts the top box centre at 8.0
      assert.ok(maxY(s) > 7.9, `top y ${maxY(s)}`);
      assert.ok(s.stats().kineticEnergy < 0.05);
    });

    test('static friction holds boxes on a 30° slope (μ = 1 > tan 30°)', () => {
      // The boxes slide a few cm while landing on the slope, then must hold still. Coloured
      // Gauss-Seidel propagates through the 11-plank stack more slowly than the demo's
      // top-down order: at 10 iterations one plank slips ~3 cm once (docs/FINDINGS.md), so
      // the coloured backend is held to the same bar at 20 iterations.
      const s = run(backend, 'Static Friction', 300, backend === 'soa-colored' ? { iterations: 20 } : {});
      const before = dynamicIds(s).map((i) => s.pose(i));
      for (let i = 0; i < 900; i++) s.step();
      dynamicIds(s).forEach((id, i) => {
        const p = s.pose(id);
        const d = Math.hypot(p[0] - before[i][0], p[1] - before[i][1]);
        assert.ok(d < 0.005, `box ${i} crept ${d}`);
      });
    });

    test('dynamic friction: stopping distance decreases with friction', () => {
      const travelled = slid(run(backend, 'Dynamic Friction', 600));
      for (let i = 1; i < travelled.length; i++) assert.ok(travelled[i] > travelled[i - 1]);
      // The demo builds the friction Hessian from the unclamped penalty, which under-applies
      // sliding friction: boxes slide ~2x the Coulomb distance at 10 iterations.
      assert.ok(travelled[8] > 1.5 * coulomb(8), `μ=1 slid ${travelled[8]}`);
    });

    test('stiffness rescaling (Eq. 14) recovers Coulomb sliding friction', () => {
      const travelled = slid(run(backend, 'Dynamic Friction', 600, { stiffnessRescale: true }));
      for (let i = 0; i < 10; i++) {
        const rel = Math.abs(travelled[i] - coulomb(i)) / coulomb(i);
        assert.ok(rel < 0.05, `box ${i}: slid ${travelled[i]}, Coulomb ${coulomb(i)}`);
      }
    });

    test('motor spins the bar up to the target speed under its torque limit', () => {
      // Max torque 50 on I = 5.26 accelerates at 9.5 rad/s², reaching 20 rad/s after ~2.1 s.
      const s = run(backend, 'Motor', 240);
      assert.ok(Math.abs(s.velocity(1)[2] + 20) < 0.01, `ω ${s.velocity(1)[2]}`);
    });

    test('rigid rod cantilever sags a little, then recovers', () => {
      const s = run(backend, 'Rod', 300);
      const sag5 = 10 - s.pose(s.bodyCount - 1)[1];
      assert.ok(sag5 < 0.12, `tip sag ${sag5} at 5 s`);
      for (let i = 0; i < 1500; i++) s.step();
      const sag30 = 10 - s.pose(s.bodyCount - 1)[1];
      assert.ok(sag30 < sag5 * 0.75, `tip sag ${sag30} at 30 s`);
    });

    test('hard joints stay together on a hanging rope with a 200:1 heavy end', () => {
      const s = run(backend, 'Hanging Rope', 60);
      let worst = 0;
      for (let i = 0; i < 540; i++) {
        s.step();
        worst = Math.max(worst, s.stats().maxJointError);
      }
      // Links are 1 unit long; the demo settings keep every anchor within 5% of that.
      assert.ok(worst < 0.05, `worst joint error ${worst}`);
    });

    test('fracture scene breaks joints under the falling load', () => {
      const s = run(backend, 'Fracture', 0);
      const joints0 = s.stats().joints;
      for (let i = 0; i < 300; i++) s.step();
      assert.ok(s.stats().joints < joints0, 'expected broken joints');
    });

    test('drag joint pulls a picked body toward the cursor, and releases', () => {
      const s = run(backend, 'Ground', 0);
      s.addBox([1, 1], 1, 0.5, [0, 1, 0], [0, 0, 0]);
      s.step();
      const hit = s.pick(0.2, 1.1);
      assert.ok(hit);
      s.startDrag(hit.body, hit.local, [3, 4]);
      for (let i = 0; i < 120; i++) s.step();
      const p = s.pose(hit.body);
      assert.ok(Math.hypot(p[0] - 3, p[1] - 4) < 0.5, `body at ${p[0]}, ${p[1]}`);
      s.endDrag();
      for (let i = 0; i < 120; i++) s.step();
      assert.ok(s.pose(hit.body)[1] < 1, 'body falls back after release');
    });

    // The card house is marginally stable: it stands in the demo's solve order but falls in
    // about half of shuffled orders and in coloured order (docs/FINDINGS.md), so it is only
    // a pass/fail check for the backends that keep the demo's order.
    if (backend !== 'soa-colored') {
      test('card house stands', () => {
        assert.ok(maxY(run(backend, 'Cards', 600)) > 1.6);
      });
    }
  });
}
