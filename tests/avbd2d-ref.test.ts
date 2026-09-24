import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
// Physical behaviour checks shared by all backends live in avbd2d-behavior.test.ts.
import { sceneByName, scenes } from '../src/avbd2d/ref/scenes.ts';
import { Solver } from '../src/avbd2d/ref/solver.ts';

function run(name: string, frames: number, setup?: (s: Solver) => void): Solver {
  const solver = new Solver();
  setup?.(solver);
  sceneByName(name).build(solver);
  for (let i = 0; i < frames; i++) solver.step();
  return solver;
}

interface OracleSample {
  frame: number;
  forces: number;
  bodies: [number, number, number][];
}

// Golden trajectories from the upstream C++ demo compiled in double precision
// (tools/cpp-oracle/gen2d.sh). The port must match to round-off, including force counts
// (i.e. every contact manifold is created and destroyed on the same frame).
test('matches the upstream C++ solver on every scene', () => {
  scenes.forEach((scene, i) => {
    const golden = JSON.parse(readFileSync(new URL(`./fixtures/oracle2d/scene-${i}.json`, import.meta.url), 'utf8'));
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
        for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(b.position[k] - sample.bodies[j][k]));
      });
      assert.ok(maxDiff < 1e-7, `${scene.name} frame ${frame}: max pose diff ${maxDiff}`);
    }
  });
});

test('every scene stays finite in each solver mode', () => {
  const modes: Partial<Solver>[] = [
    { postStabilize: false, alpha: 0.95 },
    { stiffnessRescale: true },
    { vbd: true },
    { iterations: 1 },
  ];
  for (const mode of modes) {
    for (const scene of scenes) {
      const s = run(scene.name, 120, (solver) => Object.assign(solver, mode));
      for (const b of s.bodies) assert.ok(b.position.every(Number.isFinite), `${scene.name} ${JSON.stringify(mode)}`);
    }
  }
});

test('is deterministic', () => {
  const a = run('Cards', 120);
  const b = run('Cards', 120);
  a.bodies.forEach((body, i) => assert.deepEqual([...body.position], [...b.bodies[i].position]));
});
