// CPU-only settling trace for one comparison scene: per-step max speed and final heights.
// Never opens a GPU device. The AVBD CPU reference (src/avbd3d/ref) collides every body as a
// box, so `--engine ref` treats spheres as 2r cubes; `--engine ref-sdf` keeps the same
// reference solver and gives it the opt-in CPU SDF contacts (analytic spheres and boxes).
//
// node --experimental-transform-types --no-warnings scripts/settling-trace.ts sphere-pile-100
//   --engine ref|ref-sdf|rapier [--iterations 4 --steps 600 --dt 0.016666666666666666]
//   [--jitter 0.001 --jitter-seed 1 --json trace.json]
import { writeFileSync } from 'node:fs';
import { createAdapter } from '../src/comparison/adapters.ts';
import { DEFAULTS } from '../src/comparison/run.ts';
import { CASES, jitterScene, makeScene, referenceFromScene, type Scene } from '../src/comparison/scenes.ts';
import { STATE_SIZE } from '../src/comparison/quality.ts';
import { contactQuality } from '../src/comparison/contact-quality.ts';
import { SdfCollisionAdapter } from '../src/avbd3d/ref/sdf/adapter.ts';
import { AnalyticField } from '../src/avbd3d/ref/sdf/shapes.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args.splice(i, 2)[1];
};
const engine = option('--engine') ?? 'ref';
const iterations = Number(option('--iterations') ?? 4);
const steps = Number(option('--steps') ?? 600);
const dt = Number(option('--dt') ?? 1 / 60);
const jitter = Number(option('--jitter') ?? 0);
const jitterSeed = Number(option('--jitter-seed') ?? 1);
const json = option('--json');
if (args.length !== 1 || !CASES.includes(args[0] as typeof CASES[number])) throw new Error(`One case: ${CASES.join(', ')}`);
if (!['ref', 'ref-sdf', 'rapier'].includes(engine)) throw new Error('--engine ref|ref-sdf|rapier');
if (!Number.isInteger(iterations) || iterations < 1 || !Number.isInteger(steps) || steps < 1) throw new Error('Invalid counts');
const scene: Scene = jitterScene(makeScene(args[0]), jitter, jitterSeed);

let step: () => void, state: () => Promise<Float64Array>, destroy = () => {};
if (engine === 'rapier') {
  // Rapier ignores the device argument.
  const adapter = await createAdapter('rapier', scene, { ...DEFAULTS, dt, rapierIterations: iterations }, null as unknown as GPUDevice);
  step = () => adapter.step(); state = () => adapter.snapshot(); destroy = () => adapter.destroy();
} else {
  const solver = referenceFromScene(scene, dt, iterations);
  if (engine === 'ref-sdf') {
    const sdf = new SdfCollisionAdapter(solver);
    solver.bodies.forEach((body, i) => sdf.attach(body, new AnalyticField(scene.bodies[i].shape === 'sphere'
      ? { kind: 'sphere', radius: scene.bodies[i].size[0] / 2 }
      : { kind: 'box', halfExtents: scene.bodies[i].size.map(v => v / 2) as [number, number, number] })));
  }
  step = () => solver.step();
  state = async () => Float64Array.from(solver.bodies.flatMap(b =>
    [...b.positionLin, ...b.positionAng, ...b.velocityLin, ...b.velocityAng]));
}

const dynamic = scene.bodies.flatMap((b, i) => b.mass > 0 ? [i] : []);
const initial = await state();
const top = Math.max(...dynamic.map(i => initial[i * STATE_SIZE + 2]));
const topLayer = dynamic.filter(i => initial[i * STATE_SIZE + 2] > top - 0.25);
const maxSpeed: number[] = [];
/** Is the motion a few stray bodies or the whole scene? Speeds in m/s, energy in J. */
const distribution = (x: Float64Array) => {
  const v = dynamic.map(i => Math.hypot(x[i * STATE_SIZE + 7], x[i * STATE_SIZE + 8], x[i * STATE_SIZE + 9]));
  const sorted = [...v].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], above1cm: v.filter(s => s > 0.01).length,
    above5cm: v.filter(s => s > 0.05).length,
    kineticEnergy: dynamic.reduce((e, i, k) => e + 0.5 * scene.bodies[i].mass * v[k] ** 2, 0) };
};
let half: ReturnType<typeof distribution> | undefined;
const started = performance.now();
for (let s = 1; s <= steps; s++) {
  step();
  const x = await state();
  maxSpeed.push(Math.max(...dynamic.map(i => Math.hypot(x[i * STATE_SIZE + 7], x[i * STATE_SIZE + 8], x[i * STATE_SIZE + 9]))));
  if (s === Math.ceil(steps / 2)) half = distribution(x);
}
const final = await state();
destroy();
const z = (x: Float64Array, i: number) => x[i * STATE_SIZE + 2];
const topZ = topLayer.map(i => z(final, i));
// A body that ends more than half a radius/half-box below where it started has fallen.
const fallen = dynamic.filter(i => z(final, i) < z(initial, i) - 0.25).length;
const peak = maxSpeed.reduce((best, v, i) => v > maxSpeed[best] ? i : best, 0);
const summary = {
  scene: scene.name, engine, iterations, steps, dt, jitter, jitterSeed: jitter ? jitterSeed : null,
  dynamicBodies: dynamic.length, initialMaxPairDepth: contactQuality(scene, initial)?.maxDepth ?? null,
  peakMaxSpeed: maxSpeed[peak], peakStep: peak + 1, finalMaxSpeed: maxSpeed[steps - 1],
  firstStepAbove: Object.fromEntries([0.1, 1].map(v => [v, (maxSpeed.findIndex(s => s > v) + 1) || null])),
  topLayer: { bodies: topLayer.length, initialZ: top, finalMinZ: Math.min(...topZ), finalMeanZ: topZ.reduce((a, b) => a + b, 0) / topZ.length,
    finalMaxZ: Math.max(...topZ) },
  finalMaxZ: Math.max(...dynamic.map(i => z(final, i))), fallen, toppled: fallen > 0,
  speeds: { step: Math.ceil(steps / 2), ...half!, final: distribution(final) },
  wallSeconds: (performance.now() - started) / 1000,
};
console.log(JSON.stringify(summary, null, 2));
const every = Math.max(1, Math.round(steps / 30));
console.log('max speed (m/s) every', every, 'steps:', maxSpeed.filter((_, i) => (i + 1) % every === 0).map(v => v.toFixed(3)).join(' '));
if (json) writeFileSync(json, JSON.stringify({ ...summary, maxSpeed }, null, 2) + '\n');
