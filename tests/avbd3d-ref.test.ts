import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Joint } from '../src/avbd3d/ref/forces.ts';
import { vec3 } from '../src/avbd3d/ref/math.ts';
import { sceneByName, scenes } from '../src/avbd3d/ref/scenes.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';

function run(name: string, frames: number): Solver {
  const solver = new Solver();
  sceneByName(name).build(solver);
  for (let i = 0; i < frames; i++) solver.step();
  return solver;
}

interface OracleSample {
  frame: number;
  forces: number;
  /** Per body: position xyz then orientation quaternion xyzw. */
  bodies: number[][];
}

// Golden trajectories from the upstream C++ demo compiled in double precision without FMA
// contraction (tools/cpp-oracle/gen3d.sh). The port reproduces them bit for bit; the bound
// only leaves room for a libm difference in the one sin/cos call (Static Friction's ramp).
test('matches the upstream C++ solver on every scene', () => {
  scenes.forEach((scene, i) => {
    const golden = JSON.parse(readFileSync(new URL(`./fixtures/oracle3d/scene-${i}.json`, import.meta.url), 'utf8'));
    assert.equal(golden.scene, scene.name);
    const solver = new Solver();
    scene.build(solver);
    let frame = 0;
    for (const sample of golden.samples as OracleSample[]) {
      while (frame < sample.frame) {
        solver.step();
        frame++;
      }
      assert.equal(solver.forces.length, sample.forces, `${scene.name} frame ${frame}: force count`);
      let maxDiff = 0;
      solver.bodies.forEach((b, j) => {
        const g = sample.bodies[j];
        for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(b.positionLin[k] - g[k]));
        for (let k = 0; k < 4; k++) maxDiff = Math.max(maxDiff, Math.abs(b.positionAng[k] - g[3 + k]));
      });
      assert.ok(maxDiff < 1e-9, `${scene.name} frame ${frame}: max pose diff ${maxDiff}`);
    }
  });
});

test('boxes rest on the ground within the collision margin', () => {
  // The stack bounces on landing and is quasi-static (residual speed ~2e-4) from ~800 frames
  const s = run('Stack', 900);
  s.bodies.slice(1).forEach((b, i) => {
    // Each contact settles about one collision margin (0.01) deep
    assert.ok(Math.abs(b.positionLin[2] - (i + 1)) < 0.011 * (i + 1), `box ${i} z ${b.positionLin[2]}`);
    assert.ok(Math.hypot(b.positionLin[0], b.positionLin[1]) < 1e-6);
    assert.ok(Math.hypot(...b.velocityLin) < 1e-3);
  });
});

test('dynamic friction: stopping distance follows Coulomb friction', () => {
  // Boxes launched along x at 10 m/s with friction 5 - 0.5i against ground friction 0.5
  const s = run('Dynamic Friction', 300);
  s.bodies.slice(1).forEach((b, i) => {
    const slid = b.positionLin[0];
    if (i === 10) {
      assert.ok(Math.abs(slid - 50) < 1e-6, 'frictionless box keeps its speed');
      return;
    }
    const mu = Math.sqrt((5 - i * 0.5) * 0.5);
    const expected = 100 / (2 * mu * 10);
    assert.ok(Math.abs(slid - expected) / expected < 0.15, `box ${i}: slid ${slid}, Coulomb ${expected}`);
  });
});

test('static friction: boxes above tan(30°) hold on the ramp, the rest slide off', () => {
  const s = run('Static Friction', 600);
  const xs = s.bodies.slice(2).map((b) => b.positionLin[0]);
  for (let f = 0; f < 120; f++) s.step();
  s.bodies.slice(2).forEach((b, i) => {
    const mu = Math.sqrt((i / 10) * 0.25 + 0.25);
    if (mu > Math.tan(Math.PI / 6) + 0.01) {
      assert.ok(b.positionLin[2] > 7, `box ${i} (mu ${mu.toFixed(3)}) left the ramp`);
      assert.ok(Math.abs(b.positionLin[0] - xs[i]) < 0.005, `box ${i} creeps`);
    } else if (mu < Math.tan(Math.PI / 6) - 0.01) {
      assert.ok(b.positionLin[2] < 1.5, `box ${i} (mu ${mu.toFixed(3)}) is still on the ramp`);
    }
  });
});

test('spring oscillates about its static equilibrium', () => {
  // Anchor at z = 14, rest length 4, k = 100, block mass 8: equilibrium 14 - 4 - 0.8
  const s = run('Spring', 600);
  let sum = 0;
  for (let i = 0; i < 600; i++) {
    s.step();
    sum += s.bodies[2].positionLin[2];
  }
  assert.ok(Math.abs(sum / 600 - 9.2) < 0.05, `mean z ${sum / 600}`);
});

test('hard joints hold ropes and the bridge together', () => {
  // Measured once the swing has died down (the heavy rope's 5 m end box takes ~10 s)
  for (const [name, bound, frames] of [
    ['Rope', 0.02, 240],
    ['Heavy Rope', 0.03, 600],
    ['Bridge', 0.03, 240],
  ] as const) {
    const s = run(name, frames);
    const c = vec3();
    let err = 0;
    for (const f of s.forces) if (f instanceof Joint) err = Math.max(err, Math.hypot(...f.evaluateLin(c)));
    assert.ok(err < bound, `${name}: joint error ${err}`);
  }
});

test('breakable joints fracture under load', () => {
  const joints = (s: Solver) => s.forces.filter((f) => f instanceof Joint).length;
  assert.equal(joints(run('Breakable', 1)), 10);
  const s = run('Breakable', 120);
  assert.ok(joints(s) < 10 && joints(s) > 0, `${joints(s)} joints left`);
});

test('a world-anchored drag joint pulls a body to the target', () => {
  const s = run('Ground', 120);
  const box = s.bodies[1];
  const target = [3, 2, 4];
  const hit = s.pick([0, -10, 1], [0, 1, 0]);
  assert.ok(hit && hit.body === box, 'ray picks the box');
  new Joint(s, null, box, target, hit.local, 5000, 0);
  for (let i = 0; i < 300; i++) s.step();
  const anchor = vec3();
  new Joint(s, null, box, target, hit.local).evaluateLin(anchor);
  assert.ok(Math.hypot(...anchor) < 0.05, `anchor error ${Math.hypot(...anchor)}`);
});

// Blow-ups show within a few dozen frames (every scene is in contact or swinging by then)
test('every scene stays finite at 1 and 20 iterations', () => {
  for (const iterations of [1, 20]) {
    for (const scene of scenes) {
      const s = new Solver();
      s.iterations = iterations;
      scene.build(s);
      for (let i = 0; i < 40; i++) s.step();
      for (const b of s.bodies) assert.ok([...b.positionLin, ...b.positionAng].every(Number.isFinite), `${scene.name} @ ${iterations}`);
    }
  }
});

test('is deterministic', () => {
  const a = run('Soft Body', 120);
  const b = run('Soft Body', 120);
  a.bodies.forEach((body, i) => assert.deepEqual([...body.positionLin, ...body.positionAng], [...b.bodies[i].positionLin, ...b.bodies[i].positionAng]));
});

test('mass properties follow the box dimensions', () => {
  const s = new Solver();
  const b = new Rigid(s, [1, 2, 3], 2, 0.5, [0, 0, 0]);
  assert.equal(b.mass, 12);
  assert.deepEqual([...b.moment], [13, 10, 5]);
  assert.ok(Math.abs(b.radius - Math.hypot(0.5, 1, 1.5)) < 1e-15);
});
