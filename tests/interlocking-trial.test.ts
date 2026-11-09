import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { observeInterlocking, type StudyPose } from '../src/comparison/interlocking-quality.ts';
import { INTERLOCKING } from '../src/comparison/interlocking-scene.ts';
import { LOWER_RING_ROTATION } from '../src/comparison/interlocking-avbd.ts';
import {
  assessAdapter, avbdTrialEngine, createRapierTrialEngine, parseTrialArgs, runInterlockingTrial, sanitizeMessage, TrialRefusal,
  validateTrialConfig, type PoseRead, type TrialEngine, type TrialOptions,
} from '../src/comparison/interlocking-trial.ts';

const pose = (p: readonly number[], q: readonly number[] = [0, 0, 0, 1]): StudyPose =>
  ({ position: { x: p[0], y: p[1], z: p[2] }, rotation: { x: q[0], y: q[1], z: q[2], w: q[3] } });
const authored = (): StudyPose[] => [pose(INTERLOCKING.positions[0]), pose(INTERLOCKING.positions[1], LOWER_RING_ROTATION)];

/** Deterministic clock: every reading advances by `tick`; engines add explicit costs with `spend`. */
function fakeClock() {
  let now = 0;
  return { clock: () => now, spend: (ms: number) => { now += ms; } };
}

interface Fake { engine: TrialEngine; log: string[]; disposed: () => number; inFlight: () => number }
/** Fake engine: records the exact call sequence and a step count in each read. */
function fakeEngine(spend: (ms: number) => void, hooks: {
  failAt?: Partial<Record<'step' | 'push' | 'read' | 'gpu' | 'check' | 'dispose', number>>; gpu?: boolean; readStep?: (steps: number) => number | undefined; kind?: 'rapier' | 'avbd';
  cost?: { step?: number; push?: number; gpu?: number; read?: number };
} = {}): Fake {
  const log: string[] = [];
  let steps = 0, disposed = 0, inFlight = 0, reads = 0;
  const cost = { step: 1, push: 2, gpu: 7, read: 5, ...hooks.cost };
  const engine: TrialEngine = {
    description: { engine: hooks.kind ?? 'rapier', version: 'fake', representation: hooks.kind === 'avbd' ? { kind: 'analytic-sdf' } : { kind: 'rapier-compound', pieces: 32 },
      settings: {}, engineReportedMass: null, setupMs: { inner: 3 }, device: null, stepSemantics: 'fake' },
    step() {
      assert.equal(inFlight, 0, 'no step while an async read is in flight');
      if (hooks.failAt?.step === steps) throw new Error('step failed at /Users/someone/secret/dir/file.ts');
      steps++; log.push('step'); spend(cost.step);
    },
    push() { if (hooks.failAt?.push !== undefined) throw new Error('push failed'); log.push(`push@${steps}`); spend(cost.push); },
    check: hooks.failAt?.check === undefined ? undefined : () => { throw new Error('GPU error: validation'); },
    async readPoses(): Promise<PoseRead> {
      assert.equal(inFlight, 0, 'reads are serialized');
      inFlight++;
      try {
        log.push(`read@${steps}`);
        if (hooks.failAt?.read === reads++) throw new Error('read failed');
        await Promise.resolve(); spend(cost.read);
        return { poses: authored(), step: hooks.readStep ? hooks.readStep(steps) : steps };
      } finally { inFlight--; }
    },
    dispose() { disposed++; log.push('dispose'); if (hooks.failAt?.dispose !== undefined) throw new Error('dispose failed'); },
  };
  if (hooks.gpu) engine.completeGpu = async () => {
    if (hooks.failAt?.gpu !== undefined) throw new Error('queue lost');
    log.push(`gpu@${steps}`); await Promise.resolve(); spend(cost.gpu);
  };
  return { engine, log, disposed: () => disposed, inFlight: () => inFlight };
}
const run = (fake: Fake, clock: TrialOptions['clock'], config: unknown = { engine: 'rapier' }, extra: TrialOptions = {}) =>
  runInterlockingTrial(config, async () => fake.engine, { clock, ...extra });

test('input validation refuses before the engine is acquired', async () => {
  const refused: unknown[] = [null, [], 'rapier', {}, { engine: 'both' }, { engine: 'rapier', steps: 120 }, { engine: 'rapier', steps: 721 },
    { engine: 'rapier', steps: 240.5 }, { engine: 'rapier', steps: '240' }, { engine: 'rapier', steps: NaN }, { engine: 'rapier', pieces: 8 },
    { engine: 'rapier', pieces: '16' }, { engine: 'avbd', pieces: 32 }, { engine: 'rapier', dt: 0.01 }, { engine: 'rapier', steps: 1e9 }];
  for (const config of refused) {
    let acquired = 0;
    await assert.rejects(runInterlockingTrial(config, async () => { acquired++; throw new Error('must not acquire'); }), TrialRefusal);
    assert.equal(acquired, 0, JSON.stringify(config));
  }
  const ok = validateTrialConfig({ engine: 'rapier' });
  assert.deepEqual([ok.steps, ok.pieces, ok.pushAfterStep, ok.maxSteps, [...ok.snapshotSteps]], [240, 32, 120, 720, [0, 60, 120, 180, 240]]);
  assert.deepEqual([...validateTrialConfig({ engine: 'avbd', steps: 200 }).snapshotSteps], [0, 60, 120, 180, 200]);
  assert.equal(validateTrialConfig({ engine: 'avbd' }).pieces, null);
  assert.equal(validateTrialConfig({ engine: 'rapier', steps: 720 }).snapshotSteps.at(-1), 720);
  for (const pieces of [16, 32, 64]) assert.equal(validateTrialConfig({ engine: 'rapier', pieces }).pieces, pieces);
});

test('CLI arguments: strict parsing, predictable refusals', () => {
  assert.deepEqual(parseTrialArgs(['--engine', 'rapier', '--pieces', '16', '--steps', '300', '--json', 'out.json']),
    { config: { engine: 'rapier', pieces: 16, steps: 300 }, json: 'out.json', help: false });
  assert.equal(parseTrialArgs(['--help']).help, true);
  for (const argv of [[], ['--engine'], ['--engine', '--steps'], ['--engine', 'rapier', '--engine', 'avbd'], ['--engine', 'rapier', 'extra'],
    ['--engine', 'rapier', '--steps', '12abc'], ['--engine', 'rapier', '--steps', '-5'], ['--engine', 'rapier', '--steps', '9999'],
    ['--engine', 'avbd', '--pieces', '16'], ['--engine', 'rapier', '--pieces', '10'], ['--engine', 'rapier', '--software'], ['--engine', 'webgl']]) {
    assert.throws(() => parseTrialArgs(argv), TrialRefusal, argv.join(' '));
  }
});

test('exact sequence: 240 steps, snapshots 0/60/120/180/240, push after snapshot 120 and before step 121', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend, { gpu: true, kind: 'avbd' });
  let observed = 0;
  const report = await runInterlockingTrial({ engine: 'avbd' }, async () => fake.engine,
    { clock, observe: (poses, representation) => { observed++; assert.deepEqual(representation, { kind: 'analytic-sdf' }); return observeInterlocking(poses, representation); } });
  assert.equal(report.status, 'completed');
  assert.equal(fake.log.filter(e => e === 'step').length, 240);
  assert.equal(observed, 5, 'observer at snapshots only, never every step');
  // Collapse runs of steps to see the ordering.
  const order: string[] = [];
  for (const e of fake.log) { const last = order.at(-1); if (e === 'step' && last?.startsWith('step×')) order[order.length - 1] = `step×${Number(last.slice(5)) + 1}`; else order.push(e === 'step' ? 'step×1' : e); }
  assert.deepEqual(order, ['gpu@0', 'read@0', 'step×60', 'gpu@60', 'read@60', 'step×60', 'gpu@120', 'read@120', 'push@120', 'step×60', 'gpu@180', 'read@180', 'step×60',
    'gpu@240', 'read@240', 'dispose']);
  assert.deepEqual(report.snapshots.map(s => [s.step, s.phase, s.pushApplied, s.engineStep]),
    [[0, 'hanging', false, 0], [60, 'hanging', false, 60], [120, 'hanging', false, 120], [180, 'after-push', true, 180], [240, 'after-push', true, 240]]);
  assert.ok(report.snapshots.slice(0, 3).every(s => s.verdict) && report.snapshots.slice(3).every(s => s.verdict === null));
  assert.deepEqual(report.steps, { requested: 240, completed: 240 });
  assert.equal(report.summaries!.hanging.observations, 3);
  assert.equal(report.summaries!.afterPush.observations, 2);
  assert.equal(report.qualification, 'gated');
  assert.equal(report.summaries!.hanging.qualification, 'gated');
  assert.equal(fake.disposed(), 1);
  assert.deepEqual(report.cleanup, { disposed: true, error: null });
});

test('a longer bounded run still snapshots the final step and never exceeds the hard maximum', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend);
  const report = await run(fake, clock, { engine: 'rapier', steps: 250 });
  assert.deepEqual(report.snapshots.map(s => s.step), [0, 60, 120, 180, 240, 250]);
  assert.equal(fake.log.filter(e => e === 'step').length, 250);
});

test('timers stay separate: setup, CPU step, GPU wait, readback, observer, trial wall', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend, { gpu: true, kind: 'avbd', cost: { step: 1, push: 2, gpu: 7, read: 5 } });
  const report = await runInterlockingTrial({ engine: 'avbd' }, async () => { spend(100); return fake.engine; },
    { clock, observe: (p, r) => { spend(3); return observeInterlocking(p, r); } });
  const t = report.timing;
  assert.equal(t.setup.acquireMs, 100);
  assert.deepEqual(t.setup.engineReportedMs, { inner: 3 }, 'engine-reported phases are inclusions, not extra');
  assert.equal(t.cpuStep.count, 240); assert.equal(t.cpuStep.totalMs, 240); assert.equal(t.cpuStep.rawMs.length, 240);
  assert.equal(t.pushMs, 2);
  assert.deepEqual(t.gpuCompletionWait, { available: true, totalMs: 35, perSnapshotMs: [7, 7, 7, 7, 7] });
  assert.deepEqual(t.readback, { totalMs: 25, perSnapshotMs: [5, 5, 5, 5, 5] });
  assert.deepEqual(t.observer, { totalMs: 15, perSnapshotMs: [3, 3, 3, 3, 3] });
  assert.equal(t.trialWallMs, 100 + 240 + 2 + 35 + 25 + 15, 'wall includes everything measured here, nothing else');
  assert.equal(t.disposeMs, 0);
  assert.ok(!('total' in t) && !('totalMs' in t), 'no summed total of incomparable timers');
  assert.match(t.notes, /must not be added/);
  assert.deepEqual(report.rendering, { measured: false, value: null, reason: report.rendering.reason });
  assert.match(report.rendering.reason, /no GPU-resident BodyMesh/);
  assert.equal(report.benchmark, false);
  for (const key of ['speedRatio', 'winner', 'fps']) assert.ok(!(key in report));
});

test('CPU engine: GPU wait is not applicable (null, not zero) and an observer clock stays separate', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend);
  const report = await run(fake, clock);
  assert.deepEqual(report.timing.gpuCompletionWait, { available: false, totalMs: null, perSnapshotMs: [null, null, null, null, null] });
  assert.ok(report.snapshots.every(s => s.timingMs.gpuCompletionWait === null));
  assert.equal(report.timing.cpuStep.totalMs, 240);
  assert.equal(report.timing.readback.totalMs, 25);
  assert.equal(report.timing.observer.totalMs, 0, 'fake observer costs no clock time; observer is timed separately from readback');
});

test('failures are reported with phase/step, partial data is preserved, and the engine is disposed exactly once', async () => {
  const cases: { name: string; hooks: Parameters<typeof fakeEngine>[1]; options?: (spend: (n: number) => void) => TrialOptions; phase: string; step: number; snapshots: number }[] = [
    { name: 'step', hooks: { failAt: { step: 70 } }, phase: 'step', step: 70, snapshots: 2 },
    { name: 'push', hooks: { failAt: { push: 0 } }, phase: 'push', step: 120, snapshots: 3 },
    { name: 'read', hooks: { failAt: { read: 2 } }, phase: 'read', step: 120, snapshots: 2 },
    { name: 'gpu wait', hooks: { gpu: true, failAt: { gpu: 0 } }, phase: 'gpu-wait', step: 0, snapshots: 0 },
    { name: 'device check', hooks: { gpu: true, failAt: { check: 0 } }, phase: 'check', step: 0, snapshots: 0 },
    { name: 'step mismatch', hooks: { readStep: s => s === 60 ? 59 : s }, phase: 'read', step: 60, snapshots: 1 },
    { name: 'observer', hooks: {}, options: () => ({ observe: (p, r) => { if (p.length && observed++ === 3) throw new Error('observer boom'); return observeInterlocking(p, r); } }), phase: 'observer', step: 180, snapshots: 3 },
    { name: 'summary', hooks: {}, options: () => ({ summarize: () => { throw new Error('summary boom'); } }), phase: 'summary', step: 240, snapshots: 5 },
  ];
  let observed = 0;
  for (const c of cases) {
    observed = 0;
    const { clock, spend } = fakeClock(), fake = fakeEngine(spend, c.hooks);
    const report = await run(fake, clock, { engine: 'rapier' }, c.options?.(spend));
    assert.equal(report.status, 'failed', c.name);
    assert.equal(report.error!.phase, c.phase, c.name);
    assert.equal(report.error!.step, c.step, c.name);
    assert.equal(report.snapshots.length, c.snapshots, c.name);
    assert.equal(report.summaries, null, c.name);
    assert.equal(fake.disposed(), 1, `${c.name}: disposed exactly once`);
    assert.equal(fake.log.at(-1), 'dispose', `${c.name}: dispose is last`);
    assert.deepEqual(report.cleanup, { disposed: true, error: null });
    assert.equal(report.engine?.engine, 'rapier', 'engine settings preserved on failure');
    assert.ok(report.timing.trialWallMs !== null && report.timing.disposeMs !== null);
    assert.ok(!/\/Users\//.test(JSON.stringify(report)), `${c.name}: no absolute machine paths`);
  }
});

test('step failure message is sanitized to a single bounded line with no absolute path', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend, { failAt: { step: 0 } });
  const report = await run(fake, clock);
  assert.equal(report.error!.message, 'step failed at <path>');
  assert.equal(sanitizeMessage(new Error('a\nsecond line /home/x/y')), 'a');
  assert.equal(sanitizeMessage(new Error('C:\\Users\\me\\x.ts failed')), '<path> failed');
  assert.equal(sanitizeMessage(new Error('x'.repeat(900))).length, 500);
});

test('acquire failure leaves nothing to dispose; dispose failure still fails the report', async () => {
  const { clock } = fakeClock();
  const failed = await runInterlockingTrial({ engine: 'rapier' }, async () => { throw new Error('wasm init failed'); }, { clock });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error, { phase: 'setup', step: 0, message: 'wasm init failed' });
  assert.deepEqual([failed.engine, failed.snapshots.length, failed.timing.disposeMs, failed.cleanup], [null, 0, null, { disposed: false, error: null }]);
  assert.equal(failed.timing.cpuStep.totalMs, null, 'not run is null, not zero');
  assert.equal(failed.timing.readback.totalMs, null);

  const { clock: c2, spend } = fakeClock(), fake = fakeEngine(spend, { failAt: { dispose: 0 } });
  const report = await run(fake, c2);
  assert.equal(report.status, 'failed');
  assert.deepEqual(report.error, { phase: 'dispose', step: 240, message: 'dispose failed' });
  assert.deepEqual(report.cleanup, { disposed: false, error: 'dispose failed' });
  assert.equal(report.snapshots.length, 5, 'results preserved');
  assert.equal(fake.disposed(), 1);

  // A run error is reported in preference to a later cleanup error, and both are kept.
  const { clock: c3, spend: s3 } = fakeClock(), both = fakeEngine(s3, { failAt: { step: 5, dispose: 0 } });
  const r3 = await run(both, c3);
  assert.equal(r3.error!.phase, 'step'); assert.equal(r3.cleanup.error, 'dispose failed');
});

test('mismatched acquired engine is refused and still disposed', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend, { kind: 'avbd' });
  const report = await run(fake, clock, { engine: 'rapier' });
  assert.equal(report.status, 'failed');
  assert.equal(report.error!.phase, 'setup');
  assert.equal(fake.disposed(), 1);
  assert.equal(fake.log.includes('step'), false);
  const { clock: c2, spend: s2 } = fakeClock(), wrongPieces = fakeEngine(s2);
  const r2 = await run(wrongPieces, c2, { engine: 'rapier', pieces: 64 });
  assert.match(r2.error!.message, /piece count/); assert.equal(wrongPieces.disposed(), 1);
});

test('adapter assessment refuses fallback, software and unidentified hardware, preserves metadata', () => {
  const hw = { vendor: 'apple', architecture: 'metal-3', device: '', description: 'Apple M4 Max', isFallbackAdapter: false };
  assert.deepEqual(assessAdapter(hw), { ok: true, record: hw });
  assert.deepEqual(assessAdapter({ ...hw, isFallbackAdapter: undefined }), { ok: true, record: { ...hw, isFallbackAdapter: null } }, 'unreported fallback flag is recorded as null');
  assert.deepEqual(assessAdapter({ ...hw, isFallbackAdapter: undefined }, true).ok, false, 'legacy adapter.isFallbackAdapter honoured');
  for (const bad of [{ ...hw, isFallbackAdapter: true }, { ...hw, description: 'SwiftShader Device (Subzero)' }, { ...hw, vendor: 'Mesa', description: 'llvmpipe (LLVM 15)' },
    { ...hw, architecture: 'softpipe' }, { vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false }, undefined, null, 'x', { vendor: 'unidentified vendor', description: 'unknown device', isFallbackAdapter: false }]) {
    assert.equal(assessAdapter(bad).ok, false, JSON.stringify(bad));
  }
  const refused = assessAdapter({ ...hw, isFallbackAdapter: true });
  assert.equal(refused.ok, false); assert.deepEqual(refused.record?.vendor, 'apple');
  assert.equal(assessAdapter(null).record, null);
});

test('AVBD adapter: queue wait and device check are wired; dispose destroys only the World, never the device', async () => {
  const log: string[] = [];
  const { clock, spend } = fakeClock();
  const model = {
    metadata: Object.freeze({ setupMs: { seeds: 1, worldCreate: 2, sdfEnable: 3 }, engine: 'three-avbd' }),
    step: () => { log.push('step'); spend(1); }, push: () => { log.push('push'); },
    async readPoses() { log.push('read'); return { step: log.filter(e => e === 'step').length, poses: authored() }; },
    dispose: () => { log.push('world.destroy'); },
  };
  const adapter = { vendor: 'apple', architecture: 'metal-3', device: '', description: 'x', isFallbackAdapter: false };
  let waits = 0;
  const engine = avbdTrialEngine(model, { adapter, completeGpu: async () => { waits++; spend(4); }, check: () => { if (log.includes('boom')) throw new Error('GPU error'); } });
  const report = await runInterlockingTrial({ engine: 'avbd' }, async () => engine, { clock });
  assert.equal(report.status, 'completed');
  assert.equal(waits, 5, 'queue completion waited at snapshots only');
  assert.deepEqual(report.timing.gpuCompletionWait.perSnapshotMs, [4, 4, 4, 4, 4]);
  assert.deepEqual(report.engine!.device, adapter);
  assert.deepEqual(report.engine!.representation, { kind: 'analytic-sdf' });
  assert.equal(report.engine!.engineReportedMass, null);
  assert.deepEqual(report.timing.setup.engineReportedMs, { seeds: 1, worldCreate: 2, sdfEnable: 3 });
  assert.match(report.engine!.stepSemantics, /submits GPU commands/);
  assert.equal(log.filter(e => e === 'world.destroy').length, 1);
  assert.equal(log.slice(0, log.indexOf('push')).filter(e => e === 'step').length, 120);
});

test('real Rapier trial (CPU): all piece counts complete, report records bands/limits and serializes', async () => {
  for (const pieces of [16, 32, 64] as const) {
    const report = await runInterlockingTrial({ engine: 'rapier', pieces }, () => createRapierTrialEngine(pieces), { source: { package: 'test' } });
    assert.equal(report.status, 'completed', report.error?.message);
    assert.equal(report.error, null);
    assert.deepEqual(report.steps, { requested: 240, completed: 240 });
    assert.deepEqual(report.snapshots.map(s => s.step), [0, 60, 120, 180, 240]);
    assert.deepEqual(report.engine!.representation, { kind: 'rapier-compound', pieces });
    assert.equal(report.engine!.version, '0.21.0');
    assert.ok(report.engine!.engineReportedMass!.every(m => Math.abs(m - report.authored.ringMass.mass) < 1e-5));
    for (const s of report.snapshots) {
      assert.equal(s.observation.valid, true);
      assert.equal(s.observation.representation.boundCertified, false, 'compound band is an unproven estimate');
      assert.equal(s.observation.ringPair!.status, 'unknown', 'unproven compound bands yield unknown geometry');
      assert.equal(s.observation.ringPair!.boundsCertified, false);
      assert.equal(typeof s.observation.analyticCoreLinkResolved, 'boolean');
      assert.ok(!('topologyCertified' in s.observation));
    }
    assert.equal(report.summaries!.hanging.qualification, 'gated');
    assert.equal(report.qualification, 'gated');
    assert.equal(report.summaries!.hanging.perCriterion.ringPairPenetration, 'unknown');
    assert.equal(report.timing.gpuCompletionWait.available, false);
    assert.equal(report.timing.cpuStep.count, 240);
    assert.deepEqual(report.source, { package: 'test' });
    assert.equal(report.rendering.measured, false);
    assert.deepEqual(report.cleanup, { disposed: true, error: null });
    assert.deepEqual(JSON.parse(JSON.stringify(report)).steps, report.steps, 'JSON-serializable');
    assert.ok(!/\/Users\/|\/home\//.test(JSON.stringify(report)), 'no absolute machine paths');
  }
});

test('real Rapier trial is deterministic and uses a fresh model per invocation', async () => {
  const [a, b] = [await runInterlockingTrial({ engine: 'rapier' }, () => createRapierTrialEngine(32)),
    await runInterlockingTrial({ engine: 'rapier' }, () => createRapierTrialEngine(32))];
  assert.deepEqual(a.snapshots.map(s => s.poses), b.snapshots.map(s => s.poses));
  assert.notDeepEqual(a.snapshots[2].poses, a.snapshots[4].poses, 'the push moved the rings');
});

test('CLI (Rapier only, no GPU): refusals exit 2 before any work; a completed run emits one JSON report', () => {
  const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', 'scripts/interlocking-trial.ts', ...args],
    { encoding: 'utf8', timeout: 60_000 });
  for (const args of [[], ['--engine', 'rapier', '--steps', '9999'], ['--engine', 'avbd', '--pieces', '16'], ['--engine', 'rapier', '--pieces', '8'],
    ['--engine', 'rapier', '--software'], ['--engine', 'rapier', '--json', 'package.json']]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.equal(r.stdout, '', 'no report for a refused invocation');
    assert.ok(!/\/Users\//.test(r.stderr));
  }
  const ok = cli('--engine', 'rapier', '--pieces', '16');
  assert.equal(ok.status, 0, ok.stderr);
  const report = JSON.parse(ok.stdout);
  assert.equal(report.status, 'completed'); assert.equal(report.schema, 'three-avbd/interlocking-trial/v1');
  assert.equal(report.source.package.name, 'three-avbd'); assert.equal(report.source.git.source === 'git' || report.source.git.head === null, true);
  assert.equal(report.environment.adapter, undefined, 'no GPU device is opened for Rapier');
  assert.deepEqual(report.config.snapshotSteps, [0, 60, 120, 180, 240]);
  assert.ok(!/\/Users\/|\/home\//.test(ok.stdout));
  const large = cli('--engine', 'rapier', '--steps', '720');
  assert.equal(large.status, 0, large.stderr);
  assert.equal(JSON.parse(large.stdout).steps.completed, 720, 'stdout is flushed before forced Dawn-safe process exit');
});


test('device error discovered during readback fails before recording a successful snapshot', async () => {
  const { clock, spend } = fakeClock(), fake = fakeEngine(spend, { kind: 'avbd', gpu: true });
  const read = fake.engine.readPoses; let readFinished = false;
  fake.engine.readPoses = async () => { const result = await read(); readFinished = true; return result; };
  fake.engine.check = () => { if (readFinished) throw new Error('late GPU validation error'); };
  const report = await run(fake, clock, { engine: 'avbd' });
  assert.equal(report.status, 'failed');
  assert.equal(report.error!.phase, 'check');
  assert.equal(report.snapshots.length, 0);
  assert.equal(fake.disposed(), 1);
});
