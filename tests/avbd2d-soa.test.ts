// The GPU-shaped CPU solver: exact parity with the upstream C++ in sequential f64 mode, and
// unit checks of the pieces the GPU will run (broadphase, colouring, constraint storage).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sceneByName, scenes } from '../src/avbd2d/ref/scenes.ts';
import { parallelParams, Solver } from '../src/avbd2d/ref/solver.ts';
import { createSim } from '../src/avbd2d/sim.ts';
import { GridBroadphase, pairKey } from '../src/avbd2d/soa/broadphase.ts';
import { Coloring } from '../src/avbd2d/soa/coloring.ts';
import { CS, INFO_STRIDE, SoaSolver2D } from '../src/avbd2d/soa/solver.ts';

interface OracleSample {
  frame: number;
  bodies: [number, number, number][];
}

test('sequential f64 mode matches the upstream C++ solver on every scene', () => {
  scenes.forEach((scene, i) => {
    const golden = JSON.parse(readFileSync(new URL(`./fixtures/oracle2d/scene-${i}.json`, import.meta.url), 'utf8'));
    const ref = new Solver();
    scene.build(ref);
    const s = new SoaSolver2D({ precision: 'f64', order: 'sequential' });
    s.loadFromReference(ref);
    let frame = 0;
    for (const sample of golden.samples as OracleSample[]) {
      while (frame < sample.frame) {
        s.step();
        frame++;
      }
      let maxDiff = 0;
      for (let b = 0; b < s.bodyCount; b++) {
        for (let k = 0; k < 3; k++) maxDiff = Math.max(maxDiff, Math.abs(s.pose[b * 4 + k] - sample.bodies[b][k]));
      }
      assert.ok(maxDiff < 1e-7, `${scene.name} frame ${frame}: max pose diff ${maxDiff}`);
    }
  });
});

test('grid broadphase finds exactly the brute-force pair set', () => {
  let seed = 7;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 20; trial++) {
    const n = 300;
    const pose = new Float64Array(n * 4);
    const props = new Float64Array(n * 4);
    const dynamic = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      pose[i * 4] = (rand() - 0.5) * 30;
      pose[i * 4 + 1] = (rand() - 0.5) * 30;
      // A few huge bodies exercise the large-body path
      props[i * 4 + 1] = i % 97 === 0 ? 20 + rand() * 30 : 0.2 + rand() * 0.8;
      dynamic[i] = rand() < 0.9 ? 1 : 0;
    }
    const noCollide = Float64Array.from([pairKey(1, 2), pairKey(5, 9), pairKey(0, 3)]).sort();
    const bp = new GridBroadphase();
    bp.findPairs(n, pose, props, dynamic, noCollide, noCollide.length);

    const expected: number[] = [];
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < a; b++) {
        if (!dynamic[a] && !dynamic[b]) continue;
        const dx = pose[a * 4] - pose[b * 4];
        const dy = pose[a * 4 + 1] - pose[b * 4 + 1];
        const r = props[a * 4 + 1] + props[b * 4 + 1];
        if (dx * dx + dy * dy <= r * r && !noCollide.includes(pairKey(a, b))) expected.push(pairKey(a, b));
      }
    }
    expected.sort((x, y) => x - y);
    assert.deepEqual([...bp.pairs.subarray(0, bp.pairCount)], expected, `trial ${trial}`);
  }
});

/** Chain graph 0-1-2-...-(n-1) as constraint records for the colouring. */
function chain(n: number) {
  const info = new Int32Array((n - 1) * INFO_STRIDE);
  for (let c = 0; c < n - 1; c++) info.set([1, c, c + 1, 0], c * INFO_STRIDE);
  const adjStart = new Int32Array(n + 1);
  const lists: number[][] = Array.from({ length: n }, () => []);
  for (let c = 0; c < n - 1; c++) {
    lists[c].push(c);
    lists[c + 1].push(c);
  }
  const adjList = Int32Array.from(lists.flat());
  lists.forEach((l, i) => (adjStart[i + 1] = adjStart[i] + l.length));
  return { info, adjStart, adjList, dynamic: new Uint8Array(n).fill(1) };
}

test('colouring converges quickly on long chains and stays stable', () => {
  const n = 5000;
  const g = chain(n);
  const coloring = new Coloring();
  const first = coloring.run(n, g.dynamic, g.adjStart, g.adjList, g.info, 64);
  assert.equal(first.conflicts, 0);
  // Index-priority colouring would need ~n rounds on a chain; hashed priorities need O(log n)
  assert.ok(first.rounds <= 20, `rounds ${first.rounds}`);
  assert.ok(first.numColors <= 3, `colours ${first.numColors}`);
  for (let i = 0; i + 1 < n; i++) assert.notEqual(coloring.colors[i], coloring.colors[i + 1]);
  // Unchanged graph: nothing is pending, so no rounds run
  const again = coloring.run(n, g.dynamic, g.adjStart, g.adjList, g.info, 64);
  assert.equal(again.rounds, 0);
  assert.equal(again.conflicts, 0);
});

test('colouring stays valid (no clashes) through a whole collapsing scene', () => {
  const sim = createSim('soa-colored', 'Net');
  for (let i = 0; i < 300; i++) {
    sim.step();
    assert.equal(sim.stats().colorConflicts, 0, `frame ${i}`);
  }
});

test('adding a joint while contacts exist keeps every contact record intact', () => {
  const ref = new Solver();
  sceneByName('Stack').build(ref);
  const s = new SoaSolver2D();
  s.loadFromReference(ref);
  for (let i = 0; i < 120; i++) s.step();
  const before = { info: s.info.slice(s.jointCount * INFO_STRIDE, (s.jointCount + s.contactCount) * INFO_STRIDE), data: s.data.slice(s.jointCount * CS, (s.jointCount + s.contactCount) * CS) };
  const handle = s.addJoint(-1, 5, [0, 6], [0, 0], [1000, 1000, 0]);
  const after = { info: s.info.slice(s.jointCount * INFO_STRIDE, (s.jointCount + s.contactCount) * INFO_STRIDE), data: s.data.slice(s.jointCount * CS, (s.jointCount + s.contactCount) * CS) };
  assert.deepEqual(after.info, before.info);
  assert.deepEqual(after.data, before.data);
  s.removeJoint(handle);
  s.step();
  assert.equal(s.jointCount, 0);
});

test('parallelParams (α = 0.95) holds the slope at 10 iterations in coloured order', () => {
  const s = createSim('soa-colored', 'Static Friction', parallelParams());
  for (let i = 0; i < 300; i++) s.step();
  const before = [...Array(s.bodyCount).keys()].map((i) => s.pose(i));
  for (let i = 0; i < 1800; i++) s.step();
  for (let i = 1; i < s.bodyCount; i++) {
    const p = s.pose(i);
    const d = Math.hypot(p[0] - before[i][0], p[1] - before[i][1]);
    assert.ok(d < 0.005, `box ${i} crept ${d}`);
  }
});
