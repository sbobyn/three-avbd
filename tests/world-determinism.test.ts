import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { resolveFixedStorage } from '../src/lib/storage-budget.ts';
import { checkOutputTarget } from '../tools/world-determinism.ts';
import {
  authoredScene, compareObservations, type Comparison, digest, FLOATS_PER_BODY, fixedStorageFor, observeBodies, parseProbeArgs, PROBE_DEFAULTS, PROBE_LIMITS, ProbeRefusal,
  finalizeProbeReport, refusedReport, resolveProbeConfig, runWorldDeterminism, WORLD_DETERMINISM_SCHEMA, worldSetupFor,
  type ProbeBody, type ProbeHost, type ProbeReport, type ProbeWorld, type WorldSetup,
} from '../tools/world-determinism-core.ts';

// CPU only. The real runner is driven with an injected fake host, World and clock; nothing here starts a GPU. The CLI cases run with
// the `webgpu` module made unloadable, so a refusal that reached GPU acquisition would show up as a different message and exit code.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'three-avbd-world-determinism-')));
after(() => rmSync(dir, { recursive: true, force: true }));

// ---- a fake World that behaves like the real one where the probe depends on it -------------------
// Fields are stale until read() (the real World returns what it last read back), step() is deterministic float32 arithmetic.

interface FakeOptions {
  /** Change what read() exposes, after the honest values are computed: (run, bodyIndex, slot, snapshot). */
  tamper?: (run: number, snapshot: Float32Array) => void;
  readStamp?: (run: number, expected: number) => number;
  stepCountAfterRead?: (run: number, expected: number) => number;
  failStep?: { run: number; step: number };
  failDestroy?: number;
  failCreate?: number;
  refuseBody?: { run: number; index: number };
  readbackEvery?: number;
  growth?: string;
  failRead?: number;
  failSettle?: number;
  gpuErrorAfterRead?: number;
  /** Replace a body field with a non-readback value on read (e.g. NaN). */
  poison?: (run: number) => ((snapshot: Float32Array) => unknown) | undefined;
}

function fakeHost(options: FakeOptions = {}) {
  const log: string[] = [];
  const setups: WorldSetup[] = [];
  const worlds: { run: number; destroyed: number; reads: number; steps: number; sets: number[] }[] = [];
  let created = 0, gpuError: string | null = null, yields = 0;
  const host: ProbeHost = {
    async createWorld(setup) {
      const run = created++;
      log.push(`create ${run}`);
      setups.push(setup);
      if (options.failCreate === run) throw new Error('create failed at /Users/someone/private/dir');
      const state = new Float32Array(setup.maxBodies * FLOATS_PER_BODY);
      let snapshot = new Float32Array(state.length), steps = 0, added = 0, readbackEvery = options.readbackEvery ?? 0;
      const record = { run, destroyed: 0, reads: 0, steps: 0, sets: [] as number[] };
      worlds.push(record);
      const make = (init: number[]): ProbeBody => {
        const i = added++;
        const o = i * FLOATS_PER_BODY;
        state.set(init.map(Math.fround), o);
        const field = (from: number, n: number) => Array.from(snapshot.subarray(o + from, o + from + n));
        return { id: i + 1, get position() { return field(0, 3); }, get rotation() { return field(3, 4); }, get velocity() { return field(7, 3); }, get angularVelocity() { return field(10, 3); } };
      };
      const world: ProbeWorld = {
        get readbackEvery() { return readbackEvery; },
        set readbackEvery(v: number) { record.sets.push(v); readbackEvery = v; },
        get stepCount() { return options.stepCountAfterRead && record.reads > 0 ? options.stepCountAfterRead(run, steps) : steps; },
        storageInfo: Object.freeze({ growth: options.growth ?? 'fixed', pairs: setup.storage.pairs, bodies: setup.maxBodies, totalBytes: 1234 }),
        addBox(o) { if (options.refuseBody?.run === run && options.refuseBody.index === added) return null; return make([...o.position, ...o.rotation, 0, 0, 0, 0, 0, 0]); },
        addSphere(o) { if (options.refuseBody?.run === run && options.refuseBody.index === added) return null; return make([...o.position, ...o.rotation, 0, 0, 0, 0, 0, 0]); },
        addJoint() { log.push(`joint ${run}`); return {}; },
        step() {
          if (options.failStep?.run === run && options.failStep.step === steps) throw new Error('step failed');
          steps++; record.steps++; log.push(`step ${run}`);
          for (let i = 0; i < state.length; i++) state[i] = Math.fround(state[i] * 0.999 + (i % FLOATS_PER_BODY + 1) * 0.0003 - 0.00981);
        },
        async read() {
          if (options.failRead === run) throw new Error('read rejected');
          record.reads++; log.push(`read ${run}`);
          await Promise.resolve();
          snapshot = Float32Array.from(state);
          options.tamper?.(run, snapshot);
          options.poison?.(run)?.(snapshot);
          if (options.gpuErrorAfterRead === run) gpuError = 'validation error at /Users/someone/private/dir/shader.wgsl';
          return { step: options.readStamp ? options.readStamp(run, steps) : steps };
        },
        destroy() { record.destroyed++; log.push(`destroy ${run}`); if (options.failDestroy === run) throw new Error('destroy failed'); },
      };
      return world;
    },
    async settle() { log.push('settle'); if (options.failSettle !== undefined && options.failSettle === created - 1) throw new Error('queue failed'); },
    check() { if (gpuError) throw new Error(`GPU error: ${gpuError}`); },
    async yieldTurn() { yields++; },
    now: () => new Date('2026-11-10T12:00:00.000Z'),
  };
  return { host, log, setups, worlds, get yields() { return yields; } };
}

const context = { source: { git: { head: 'abc', dirty: false } }, environment: { backend: 'fake' } };
const run = (config: unknown, fake = fakeHost()) => runWorldDeterminism(config, fake.host, context).then(report => ({ report, fake }));
const small = { steps: 12, bodies: 6 };
const wordCount = (config: { bodies: number }) => (config.bodies + 1) * FLOATS_PER_BODY;

// ---- arguments and configuration -------------------------------------------------------------------

const refusal = (argv: string[]) => { try { parseProbeArgs(argv); } catch (e) { return e instanceof ProbeRefusal ? e.message : `other: ${e}`; } return null; };

test('arguments: defaults, ceilings, and every malformed form is a refusal', () => {
  assert.deepEqual(parseProbeArgs([]), { help: false, config: PROBE_DEFAULTS });
  assert.ok(PROBE_DEFAULTS.steps <= 240 && PROBE_DEFAULTS.bodies < 64, 'default probe stays small');
  assert.deepEqual(parseProbeArgs(['--steps', '600', '--bodies', '4095', '--pacing', 'yield', '--json', 'r.json']),
    { help: false, config: { steps: 600, bodies: 4095, pacing: 'yield' }, json: 'r.json' });
  assert.ok(PROBE_LIMITS.bodies.max + 1 <= 4096 && PROBE_LIMITS.steps.max <= 600);
  assert.deepEqual(parseProbeArgs(['--help']), { help: true });
  assert.deepEqual(parseProbeArgs(['-h', '--bogus']), { help: true });
  for (const argv of [
    ['--steps'], ['--steps', '--bodies'], ['--steps', '0'], ['--steps', '601'], ['--steps', '12.5'], ['--steps', '1e2'], ['--steps', '-3'], ['--steps', ' 5'], ['--steps', '0x10'],
    ['--bodies', '1'], ['--bodies', '4096'], ['--bodies', 'many'], ['--pacing', 'fast'], ['--pacing', ''], ['--json', 'a.txt'], ['--json', 'a'], ['--json'],
    ['--steps', '5', '--steps', '6'], ['--software'], ['extra'], ['--gpu', 'swiftshader'], ['--readback-every', '10'], ['--storage', 'adaptive'],
  ]) assert.ok(refusal(argv), `refused: ${JSON.stringify(argv)}`);
  assert.match(refusal(['--software'])!, /Unknown option/, 'there is no software override');
});

test('configuration: the runner validates its own input and refuses before the host is asked for anything', async () => {
  for (const bad of [null, [], 'x', { steps: 601 }, { steps: 0 }, { bodies: 1 }, { bodies: 4096 }, { steps: 1.5 }, { steps: '5' }, { pacing: 'turbo' }, { readbackEvery: 5 }, { storage: 'adaptive' }]) {
    const fake = fakeHost();
    await assert.rejects(runWorldDeterminism(bad, fake.host, context), ProbeRefusal, JSON.stringify(bad));
    assert.equal(fake.log.length, 0, 'nothing was acquired');
  }
  assert.deepEqual(resolveProbeConfig({}), PROBE_DEFAULTS);
});

// ---- authored inputs and storage -------------------------------------------------------------------

test('authored scene: deterministic, bounded, a fixed floor first, one valid joint, valid shapes and unit rotations', () => {
  for (const n of [PROBE_LIMITS.bodies.min, 17, 130, PROBE_LIMITS.bodies.max]) {
    const scene = authoredScene(n);
    assert.equal(scene.bodies.length, n + 1);
    assert.deepEqual(scene.bodies.map(b => b.fixed), [true, ...Array(n).fill(false)]);
    assert.equal(scene.joints.length, 1);
    const [pair] = scene.joints, a = scene.bodies[pair.a], b = scene.bodies[pair.b];
    assert.ok(!a.fixed && !b.fixed, 'the joint holds two dynamic bodies');
    // anchors coincide in the world at the start: the joint begins unstressed
    for (let k = 0; k < 3; k++) assert.equal(a.position[k] + pair.anchorA[k], b.position[k] + pair.anchorB[k]);
    for (const body of scene.bodies) {
      assert.ok(body.size.every(v => v > 0 && v <= 48));
      assert.ok(Math.abs(Math.hypot(...body.rotation) - 1) < 1e-12);
      assert.ok(body.position.every(v => Number.isFinite(v) && Math.abs(v) < 1000));
      if (body.shape === 'sphere') assert.ok(body.size[0] === body.size[1] && body.size[1] === body.size[2]);
    }
  }
  assert.deepEqual(authoredScene(40), authoredScene(40));
  assert.throws(() => authoredScene(1), ProbeRefusal);
  assert.throws(() => authoredScene(4096), ProbeRefusal);
});

test('fixed storage request satisfies the library plan resolver (policy floors, manifolds <= pairs) from the smallest World to the largest', () => {
  const limits = { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 31, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
  for (const dynamic of [PROBE_LIMITS.bodies.min, 16, 500, PROBE_LIMITS.bodies.max]) {
    const setup = worldSetupFor({ steps: 10, bodies: dynamic, pacing: 'sync' });
    assert.equal(setup.maxBodies, dynamic + 1);
    const plan = resolveFixedStorage({ maxBodies: setup.maxBodies }, setup.storage, limits);
    // exactly what was asked, never rounded up
    assert.deepEqual([plan.pairs, plan.contacts, plan.manifolds, plan.joints, plan.hullVec4s], [setup.storage.pairs, setup.storage.contacts, setup.storage.manifolds, setup.storage.joints, setup.storage.hullVec4s]);
    assert.ok(plan.totalBytes > 0);
  }
  assert.deepEqual(fixedStorageFor(10).growth, 'fixed');
});

// ---- comparison ------------------------------------------------------------------------------------

const filled = (bodies: number) => Float32Array.from({ length: bodies * FLOATS_PER_BODY }, (_, i) => Math.fround(Math.sin(i + 1)));
const flipBit = (a: Float32Array, index: number, bit = 0) => { const w = new Uint32Array(a.buffer, a.byteOffset, a.length); w[index] ^= 1 << bit; };

test('compare: equal bytes match; a single flipped bit in ANY field of ANY body is found, with no tolerance', () => {
  const a = filled(5);
  const same = compareObservations(a, Float32Array.from(a));
  assert.equal(same.status, 'identical');
  assert.deepEqual([same.differingWords, same.differingBodies, same.first, same.maxPositionGap], [0, 0, null, null]);
  assert.equal(same.bytesCompared, 5 * FLOATS_PER_BODY * 4);
  for (const body of [0, 2, 4]) for (let slot = 0; slot < FLOATS_PER_BODY; slot++) {
    const b = Float32Array.from(a);
    flipBit(b, body * FLOATS_PER_BODY + slot, 0); // one unit in the last place: far below any plausible tolerance
    const c = compareObservations(a, b);
    assert.equal(c.status, 'different', `body ${body} slot ${slot}`);
    assert.equal(c.differingWords, 1);
    assert.equal(c.differingBodies, 1);
    assert.equal(c.first!.body, body);
  }
  const b = Float32Array.from(a);
  flipBit(b, 3 * FLOATS_PER_BODY + 8); // velocity.y of body 3
  assert.equal(compareObservations(a, b).first!.field, 'velocity.y');
  const w = Float32Array.from(a);
  flipBit(w, 1 * FLOATS_PER_BODY + 6); // rotation.w of body 1
  assert.equal(compareObservations(a, w).first!.field, 'rotation.w');
});

test('compare: negative against positive zero differs, the first difference is in body-then-field order, counts are exact, the position gap is informational', () => {
  const a = filled(4), b = Float32Array.from(a);
  a[2 * FLOATS_PER_BODY + 1] = 0; b[2 * FLOATS_PER_BODY + 1] = -0;
  const zero = compareObservations(a, b);
  assert.equal(zero.status, 'different', '+0 and -0 are different bit patterns');
  assert.equal(zero.first!.field, 'position.y');
  assert.deepEqual([zero.first!.run0.bits, zero.first!.run1.bits], ['00000000', '80000000']);
  assert.equal(zero.maxPositionGap, 0, 'a gap of zero metres does not turn a difference into a match');
  const c = Float32Array.from(a);
  flipBit(c, 3 * FLOATS_PER_BODY + 12); flipBit(c, 3 * FLOATS_PER_BODY + 2); flipBit(c, 1 * FLOATS_PER_BODY + 9);
  const many = compareObservations(a, c);
  assert.deepEqual([many.differingWords, many.differingBodies, many.first!.body, many.first!.field], [3, 2, 1, 'velocity.z']);
  assert.throws(() => compareObservations(a, filled(3)), /not comparable/);
});

test('observe: a wrong length, NaN, Infinity, a non-number or a non-float32 value is a failed read, never data', () => {
  const body = (over: Partial<Record<'position' | 'rotation' | 'velocity' | 'angularVelocity', unknown>> = {}): ProbeBody =>
    ({ id: 1, position: [1, 2, 3], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0], ...over }) as ProbeBody;
  assert.equal(observeBodies([body(), body()]).length, 2 * FLOATS_PER_BODY);
  for (const bad of [{ position: [1, 2] }, { rotation: [0, 0, 0] }, { velocity: [0, 0, 0, 0] }, { angularVelocity: [] }, { position: [NaN, 0, 0] }, { velocity: [0, Infinity, 0] },
    { rotation: [0, 0, 0, -Infinity] }, { position: [0, '1', 0] }, { position: [0.1, 0, 0] }, { position: undefined }]) {
    assert.throws(() => observeBodies([body(), body(bad as never)]), /Invalid read: body 1/, JSON.stringify(bad));
  }
  const nanBits = Float32Array.of(NaN);
  assert.notEqual(digest(nanBits), digest(Float32Array.of(0)), 'digest reads bit patterns');
  assert.equal(digest(filled(3)), digest(filled(3)));
  const x = filled(3); flipBit(x, 5);
  assert.notEqual(digest(filled(3)), digest(x));
});

// ---- the runner ------------------------------------------------------------------------------------

test('runner, matching Worlds: matched report; exactly one read per run, after every step, with no readbackEvery assignment', async () => {
  const { report, fake } = await run(small);
  assert.equal(report.status, 'matched');
  assert.equal(report.comparison.status, 'identical');
  assert.equal(report.schema, WORLD_DETERMINISM_SCHEMA);
  assert.equal(report.generatedAt, '2026-11-10T12:00:00.000Z');
  assert.equal(report.error, null);
  assert.deepEqual(report.runs.map(r => [r.index, r.status, r.stepStamp, r.stepCount, r.observedBytes]), [[0, 'observed', 12, 12, wordCount(small) * 4], [1, 'observed', 12, 12, wordCount(small) * 4]]);
  assert.equal(report.runs[0].digest, report.runs[1].digest);
  // sequence: build, 12 steps, one read, destroy, settle — and only then the second World
  const expectRun = (r: number) => [`create ${r}`, `joint ${r}`, ...Array(12).fill(`step ${r}`), `read ${r}`, `destroy ${r}`, 'settle'];
  assert.deepEqual(fake.log, [...expectRun(0), ...expectRun(1)]);
  assert.deepEqual(fake.worlds.map(w => [w.reads, w.steps, w.destroyed, w.sets.length]), [[1, 12, 1, 0], [1, 12, 1, 0]]);
  assert.equal(fake.yields, 0, 'sync pacing never yields');
  assert.deepEqual(report.config, { ...small, pacing: 'sync', totalBodies: 7, dt: 1 / 60, iterations: 10, gravity: [0, -9.81, 0], storageRequest: fixedStorageFor(7), readbackEvery: 0 });
  assert.deepEqual(fake.setups[0], fake.setups[1], 'both Worlds are built from identical setup');
  assert.deepEqual(report.runs[0].storage, { growth: 'fixed', pairs: 4096, bodies: 7, totalBytes: 1234 });
  assert.match(report.verdict, /one pair of runs/i);
  assert.ok(report.notRun.some(s => /adaptive/.test(s)) && report.notRun.some(s => /readbackEvery/.test(s)));
  assert.match(JSON.stringify(report.scope), /no tolerance/);
  assert.match(JSON.stringify(report.scope), /counters back every 10 steps/);
});

test('runner: yield pacing yields once per step and says so; defaults apply', async () => {
  const { report, fake } = await run({ steps: 9, bodies: 3, pacing: 'yield' });
  assert.equal(fake.yields, 18);
  assert.equal(report.config!.pacing, 'yield');
  const d = await run({});
  assert.deepEqual([d.report.config!.steps, d.report.config!.bodies, d.report.config!.totalBodies], [240, 16, 17]);
});

test('runner, a mismatch: one flipped bit in the second run, in any field or body, is reported as a mismatch with its location (the equality is not loosened)', async () => {
  for (const [body, slot] of [[0, 0], [3, 7], [small.bodies, FLOATS_PER_BODY - 1], [2, 5]]) {
    const { report } = await run(small, fakeHost({ tamper: (r, s) => { if (r === 1) flipBit(s, body * FLOATS_PER_BODY + slot, 0); } }));
    assert.equal(report.status, 'mismatch', `body ${body} slot ${slot}`);
    const c = report.comparison as Comparison;
    assert.equal(c.status, 'different');
    assert.equal(c.differingWords, 1);
    assert.equal(c.first!.body, body);
    assert.notEqual(report.runs[0].digest, report.runs[1].digest);
    assert.equal(report.error, null, 'a mismatch is a result, not an error');
    assert.match(report.verdict, /no tolerance was applied/);
  }
  // a change in the FIRST run is found just as well
  const first = await run(small, fakeHost({ tamper: (r, s) => { if (r === 0) flipBit(s, 4); } }));
  assert.equal(first.report.status, 'mismatch');
});

test('runner, step stamp and step count: a read that lands on the wrong step, or a World that miscounts, is a failure that still destroys the World', async () => {
  for (const [name, options] of [
    ['stamp early', { readStamp: (_r: number, expected: number) => expected - 1 }],
    ['stamp late', { readStamp: (_r: number, expected: number) => expected + 1 }],
    ['stamp NaN', { readStamp: () => NaN }],
    ['stepCount', { stepCountAfterRead: (_r: number, expected: number) => expected + 1 }],
  ] as const) {
    const { report, fake } = await run(small, fakeHost(options));
    assert.equal(report.status, 'failed', name);
    assert.equal(report.error!.phase, 'read', name);
    assert.equal(report.error!.run, 0);
    assert.equal(report.runs.length, 1, 'the second run is not attempted');
    assert.equal(report.runs[0].status, 'failed');
    assert.deepEqual(fake.worlds.map(w => w.destroyed), [1]);
    assert.equal(report.comparison.status, 'not-compared');
  }
  // the stamp must be right in the second run too
  const second = await run(small, fakeHost({ readStamp: (r, e) => r === 1 ? e + 1 : e }));
  assert.equal(second.report.status, 'failed');
  assert.deepEqual([second.report.runs[0].status, second.report.runs[1].status, second.report.error!.run], ['observed', 'failed', 1]);
  assert.equal(second.report.comparison.status, 'not-compared', 'a good run beside a bad one is not a comparison');
});

test('runner, invalid reads: non-finite or non-float32 values fail the run and are never compared', async () => {
  for (const poison of [(s: Float32Array) => { s[FLOATS_PER_BODY + 2] = NaN; }, (s: Float32Array) => { s[3] = Infinity; }, (s: Float32Array) => { s[s.length - 1] = -Infinity; }]) {
    const { report, fake } = await run(small, fakeHost({ poison: r => r === 1 ? poison : undefined }));
    assert.equal(report.status, 'failed');
    assert.equal(report.error!.phase, 'observe');
    assert.equal(report.error!.run, 1);
    assert.equal(report.comparison.status, 'not-compared');
    assert.deepEqual(fake.worlds.map(w => w.destroyed), [1, 1]);
  }
});

test('runner, failure and disposal ordering: every acquired World is destroyed, before anything else is made, on every failure path', async () => {
  const cases: [string, FakeOptions, string, number][] = [
    ['step throws in run 0', { failStep: { run: 0, step: 7 } }, 'step', 0],
    ['step throws in run 1', { failStep: { run: 1, step: 0 } }, 'step', 1],
    ['a body is refused', { refuseBody: { run: 0, index: 4 } }, 'scene', 0],
    ['read rejects', { failRead: 1 }, 'read', 1],
    ['readbackEvery already on', { readbackEvery: 10 }, 'verify', 0],
    ['adaptive storage reported', { growth: 'adaptive' }, 'verify', 0],
    ['a GPU error shows after the read', { gpuErrorAfterRead: 0 }, 'gpu-check', 0],
  ];
  for (const [name, options, phase, failedRun] of cases) {
    const { report, fake } = await run(small, fakeHost(options));
    assert.equal(report.status, 'failed', name);
    assert.equal(report.error!.phase, phase, name);
    assert.equal(report.error!.run, failedRun, name);
    assert.equal(report.comparison.status, 'not-compared', name);
    assert.equal(fake.worlds.length, failedRun + 1, `${name}: no World is made after a failure`);
    assert.ok(fake.worlds.every(w => w.destroyed === 1), `${name}: every World destroyed exactly once`);
    // each destroy comes before the next create
    const creates = fake.log.map((l, i) => l.startsWith('create') ? i : -1).filter(i => i >= 0);
    const destroys = fake.log.map((l, i) => l.startsWith('destroy') ? i : -1).filter(i => i >= 0);
    creates.slice(1).forEach((c, k) => assert.ok(destroys[k] < c, `${name}: World ${k} destroyed before World ${k + 1} created`));
    assert.equal(fake.worlds.at(-1)!.sets.length, 0, `${name}: readbackEvery never assigned`);
  }
});

test('runner, the destroy itself failing: its error is reported (alone, or beside the run\'s own failure), and the second run is not made', async () => {
  const alone = await run(small, fakeHost({ failDestroy: 0 }));
  assert.equal(alone.report.status, 'failed');
  assert.deepEqual([alone.report.error!.phase, alone.report.error!.run], ['dispose', 0]);
  assert.equal(alone.report.runs.length, 1);
  assert.equal(alone.report.comparison.status, 'not-compared');
  assert.equal(alone.fake.worlds.length, 1);
  const both = await run(small, fakeHost({ failStep: { run: 0, step: 3 }, failDestroy: 0 }));
  assert.equal(both.report.error!.phase, 'step', 'the original failure stays the error');
  assert.equal(both.report.runs[0].disposeError!.phase, 'dispose');
  assert.equal(both.report.runs[0].error!.message, 'step failed');
});

test('runner, creation and settle failures: nothing to destroy when nothing was made; a failed settle is an error', async () => {
  const create = await run(small, fakeHost({ failCreate: 1 }));
  assert.equal(create.report.status, 'failed');
  assert.deepEqual([create.report.error!.phase, create.report.error!.run, create.report.runs[0].status, create.report.runs[1].status], ['create', 1, 'observed', 'failed']);
  assert.equal(create.report.comparison.status, 'not-compared');
  assert.deepEqual(create.fake.worlds.map(w => w.destroyed), [1], 'only the first World ever existed, and it was destroyed; the failed creation leaves nothing to destroy');
  const settle = await run(small, fakeHost({ failSettle: 0 }));
  assert.equal(settle.report.error!.phase, 'settle');
  assert.equal(settle.report.runs.length, 1);
});

test('reports hold no local path and are plain JSON', async () => {
  const failed = await run(small, fakeHost({ failCreate: 0, gpuErrorAfterRead: 0 }));
  const text = JSON.stringify(failed.report);
  assert.ok(!text.includes('/Users/') && !text.includes('/private'), text);
  assert.match(text, /<path>/);
  const gpu = await run(small, fakeHost({ gpuErrorAfterRead: 1 }));
  assert.ok(!JSON.stringify(gpu.report).includes('/Users/') && !/wgsl/i.test(JSON.stringify(gpu.report)));
  const ok = await run(small);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.report)), ok.report);
  const refused = refusedReport('no adapter', { source: {}, environment: {}, config: { steps: 5, bodies: 3, pacing: 'sync' }, now: new Date('2026-11-10T00:00:00Z') });
  assert.equal(refused.status, 'refused');
  assert.deepEqual(refused.runs, []);
  assert.equal(refused.comparison.status, 'not-compared');
});

// ---- the CLI refuses before a GPU is requested --------------------------------------------------------

const cli = (args: string[], blockGpu = true) => {
  const hooks = encodeURIComponent('export async function resolve(s,c,n){if(s==="webgpu")throw new Error("GPU-MODULE-REQUESTED");return n(s,c)}');
  const block = encodeURIComponent(`import{register}from"node:module";register("data:text/javascript,${hooks}")`);
  return spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...(blockGpu ? ['--import', `data:text/javascript,${block}`] : []), 'tools/world-determinism.ts', ...args],
    { encoding: 'utf8', timeout: 60_000, cwd: new URL('..', import.meta.url) });
};

test('output target: a new .json file in an existing directory; an existing file or folder, or a missing directory, is refused', () => {
  checkOutputTarget(join(dir, 'new.json'));
  const taken = join(dir, 'taken.json');
  writeFileSync(taken, '{}');
  assert.throws(() => checkOutputTarget(taken), ProbeRefusal);
  assert.equal(existsSync(taken), true);
  assert.throws(() => checkOutputTarget(join(dir, 'missing', 'new.json')), /directory does not exist/);
  mkdirSync(join(dir, 'folder.json'));
  assert.throws(() => checkOutputTarget(join(dir, 'folder.json')), /already exists/);
});

test('CLI: --help and every refusal exit before any GPU module is requested, print nothing to stdout but help, and write nothing', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: world-determinism/);
  assert.doesNotMatch(help.stderr, /GPU-MODULE-REQUESTED/);
  const existing = join(dir, 'existing.json');
  writeFileSync(existing, 'keep');
  for (const args of [['--steps', '601'], ['--bodies', '4096'], ['--bodies', '1'], ['--pacing', 'fast'], ['--json', join(dir, 'a.txt')], ['--json', existing],
    ['--json', join(dir, 'nodir', 'd.json')], ['--software'], ['--readback-every', '5'], ['--steps']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /GPU-MODULE-REQUESTED/, 'refused before the GPU module was requested');
    assert.ok(!r.stderr.includes(dir) && !/\/Users\//.test(r.stderr), 'no local path in the message');
  }
  assert.equal(existsSync(join(dir, 'a.txt')), false);
  assert.equal(readFileSync(existing, 'utf8'), 'keep', 'the existing file is untouched');
});

test('CLI: a valid configuration reaches GPU acquisition only after validation; a missing GPU module is a GPU refusal with a refused report (new file, no path)', () => {
  const out = join(dir, 'refused.json');
  const r = cli(['--steps', '5', '--bodies', '3', '--json', out]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /webgpu \(Dawn\) package could not be loaded: nothing ran/);
  assert.equal(r.stdout, '');
  const text = readFileSync(out, 'utf8');
  const report = JSON.parse(text) as ProbeReport;
  assert.deepEqual([report.status, report.runs.length, report.comparison.status, report.config!.steps], ['refused', 0, 'not-compared', 5]);
  assert.ok(!text.includes(dir) && !/\/Users\//.test(text), 'no local path in the report');
  // a second run refuses early: the report is never overwritten
  const again = cli(['--json', out]);
  assert.equal(again.status, 2);
  assert.equal(readFileSync(out, 'utf8'), text);
  // without --json the report goes to stdout
  const stdout = cli(['--steps', '5']);
  assert.equal(stdout.status, 3);
  assert.equal((JSON.parse(stdout.stdout) as ProbeReport).status, 'refused');
});

test('late device or teardown failure cannot publish matched/mismatch as a successful probe', () => {
  const refused = refusedReport('fixture', { source: null, environment: null, config: null, now: new Date(0) });
  for (const status of ['matched', 'mismatch'] as const) {
    const report: ProbeReport = { ...refused, status, error: null };
    assert.equal(finalizeProbeReport(report, [], []), report);
    const device = finalizeProbeReport(report, ['device lost'], []);
    assert.equal(device.status, 'failed');
    assert.equal(device.error?.phase, 'gpu-check');
    assert.deepEqual(device.gpuErrors, ['device lost']);
    const teardown = finalizeProbeReport(report, [], ['destroy failed']);
    assert.equal(teardown.status, 'failed');
    assert.equal(teardown.error?.phase, 'dispose');
    assert.deepEqual(teardown.teardownErrors, ['destroy failed']);
    assert.equal(report.status, status);
  }
  const earlier: ProbeReport = { ...refused, status: 'failed', error: { phase: 'read', run: 0, message: 'original read failure' } };
  const both = finalizeProbeReport(earlier, ['late GPU failure'], ['late cleanup failure']);
  assert.equal(both.error, earlier.error);
  assert.equal(both.comparison, earlier.comparison);
  assert.deepEqual(both.gpuErrors, ['late GPU failure']);
  assert.deepEqual(both.teardownErrors, ['late cleanup failure']);
});
