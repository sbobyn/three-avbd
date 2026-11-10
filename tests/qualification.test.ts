import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Adapter, createAdapter } from '../src/comparison/adapters.ts';
import { FINAL_WINDOW, REST_SPEED, SETTLED_MAX_SPEED } from '../src/comparison/final-window.ts';
import { FLOOR_TARGET, quality, STATE_SIZE } from '../src/comparison/quality.ts';
import { DEFAULTS, runOne, validateOptions, type Result } from '../src/comparison/run.ts';
import { CASES, makeScene, SCENE_VALIDITY, sceneHash, type Scene } from '../src/comparison/scenes.ts';
import type { GitProvenance } from '../scripts/git-provenance.ts';
import { checkOutputTarget } from '../tools/qualification.ts';
import {
  assertWithinBounds, assessGpuAdapter, AVBD_CONFIGS, BOUNDS, buildSource, buildTiming, CRITERIA_IDS, declaredOptions, finalizeQualificationReport, instrumentAdapter, JOINT_ANCHOR_MAX,
  judgeRow, observedFactory, parseQualificationArgs, PassRecord, planRuns, QUATERNION_NORM_TOLERANCE, QualificationRefusal, refusedReport, resolveQualificationConfig,
  RESTING_MIN_SECONDS, ROW_CRITERIA, ROW_IDS, ROWS, RunObserver, runQualification, sceneFacts, THRESHOLDS, toJsonSafe,
  type Criterion, type CriterionId, type GpuSession, type QualificationHost, type QualificationReport, type RowId, type RowRecord,
} from '../tools/qualification-core.ts';

// CPU only. Fake adapters go through the real `runOne` (timed pass + validation replay); no device, Dawn, Rapier trial or timing is involved.
// The CLI cases run with the `webgpu` module made unloadable, so a refusal that reached GPU acquisition would show up as a different message and exit code.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'three-avbd-qualification-')));
after(() => rmSync(dir, { recursive: true, force: true }));

// ---- fakes ----------------------------------------------------------------------------------------------------

const flat = (scene: Scene) => Float64Array.from(scene.bodies.flatMap(b => [...b.position, ...b.rotation, ...b.velocity, ...b.angularVelocity]));
interface FakeContext { pass: 'timed' | 'replay'; steps: number; scene: Scene }
interface Behavior {
  /** Change the state a snapshot returns, after the honest (static) poses. */
  mutate?: (state: Float64Array, c: FakeContext) => void;
  /** Replace inspect(); throwing is how the real AVBD adapter reports overflow or clashes. */
  inspect?: (c: FakeContext) => object;
  stepThrows?: (c: FakeContext) => boolean;
  failComplete?: (c: FakeContext & { call: number }) => boolean;
  destroyThrows?: (pass: 'timed' | 'replay') => boolean;
  createThrows?: (pass: 'timed' | 'replay') => boolean;
  /** Fake clock advances inside each method, so measured intervals are known. */
  advance?: Partial<Record<'step' | 'complete' | 'snapshot' | 'inspect', number>>;
  onGuardCheck?: () => void;
}
const fakeClock = () => { let t = 0; return { now: () => t, advance: (n: number) => { t += n; } }; };
const setBody = (state: Float64Array, body: number, offset: number, ...values: number[]) => state.set(values, body * STATE_SIZE + offset);

interface FakeLog { created: number; destroys: number[]; steps: number[] }
function fakeFactory(behaviorFor: (engine: string, created: number) => Behavior | undefined, clock = fakeClock(), log: FakeLog = { created: 0, destroys: [], steps: [] }) {
  const factory: typeof createAdapter = async (engine, scene) => {
    const index = log.created++, pass = index % 2 === 0 ? 'timed' : 'replay';
    const b = behaviorFor(engine, index) ?? {};
    if (b.createThrows?.(pass)) throw new Error('create failed at /Users/someone/secret/dir');
    let steps = 0, completes = 0;
    log.destroys[index] = 0; log.steps[index] = 0;
    const ctx = () => ({ pass, steps, scene } as FakeContext);
    const adapter: Adapter = {
      settings: { fake: true, engine },
      step() { if (b.stepThrows?.(ctx())) throw new Error('step failed'); steps++; log.steps[index]++; clock.advance(b.advance?.step ?? 0); },
      async complete() { clock.advance(b.advance?.complete ?? 0); if (b.failComplete?.({ ...ctx(), call: ++completes })) throw new Error('queue failed'); },
      async inspect() { clock.advance(b.advance?.inspect ?? 0); return b.inspect ? b.inspect(ctx()) : { overflow: 0, clashes: 0, colors: 3 }; },
      async snapshot() {
        clock.advance(b.advance?.snapshot ?? 0);
        const state = flat(scene);
        b.mutate?.(state, ctx());
        return state;
      },
      destroy() { log.destroys[index]++; if (b.destroyThrows?.(pass)) throw new Error('destroy failed'); },
    };
    return adapter;
  };
  return { factory, clock, log };
}

interface FakeSessionOptions { errorAt?: () => string | null; closeErrors?: string[]; events?: string[]; settleFails?: boolean }
function fakeSession(o: FakeSessionOptions = {}): GpuSession & { errors: string[]; events: string[] } {
  const errors: string[] = [], events = o.events ?? [];
  return {
    device: {} as GPUDevice, adapter: { vendor: 'apple', architecture: 'metal-3', device: '', description: 'Apple M4 Max', isFallbackAdapter: false }, requiredLimits: { maxBufferSize: 1 },
    errors, events,
    guard() { const e = o.errorAt?.(); if (e) errors.push(e); if (errors.length) throw new Error(`GPU error: ${errors[0]}`); },
    gpuErrors: () => errors,
    async settle() { events.push('settle'); if (o.settleFails) throw new Error('settle failed at /Users/someone/x'); },
    async close() { events.push('close'); return o.closeErrors ?? []; },
  };
}
interface HostBits { factory: typeof createAdapter; clock?: ReturnType<typeof fakeClock>; session?: GpuSession; acquire?: () => Promise<GpuSession>; makeScene?: (name: string) => Scene; acquired?: { count: number } }
function fakeHost(bits: HostBits): QualificationHost {
  const clock = bits.clock ?? fakeClock();
  return { now: () => new Date('2026-11-10T00:00:00Z'), clock: clock.now, makeScene: bits.makeScene ?? ((name: string) => makeScene(name)), createAdapter: bits.factory,
    acquireGpu: async () => { if (bits.acquired) bits.acquired.count++; return bits.acquire ? bits.acquire() : (bits.session ?? fakeSession()); } };
}
const context = { source: { git: { source: 'git', head: 'abc', dirty: false } }, environment: { runtime: 'test' } };
const run = (bits: HostBits, config: unknown) => runQualification(config, fakeHost(bits), context);
const row = (report: QualificationReport, id: string) => report.rows.find(r => r.runId === id)!;
const crit = (r: RowRecord, id: CriterionId) => r.criteria.find(c => c.id === id)!;
const verdicts = (r: RowRecord) => Object.fromEntries(r.criteria.map(c => [c.id, c.verdict ?? c.state]));

/** Run one row through the real runOne with the instrumented factory, returning what judgeRow needs. */
async function execute(rowId: RowId, behavior?: Behavior, engine: 'avbd' | 'rapier' = 'avbd') {
  const spec = planRuns({ rows: [rowId], engines: [engine], configs: ['A'] })[0];
  const options = declaredOptions(spec.engine, spec.config), scene = makeScene(ROWS[rowId].scene);
  const observer = new RunObserver(fakeClock().now), { factory } = fakeFactory(() => behavior);
  const result = await runOne(spec.engine, scene, 0, options, null as unknown as GPUDevice, undefined, observedFactory(factory, observer));
  return { spec, options, scene, observer, result, facts: sceneFacts(scene) };
}
const judgeOf = (e: Awaited<ReturnType<typeof execute>>, result: Result | null = e.result) =>
  judgeRow({ row: ROWS[e.spec.row], engine: e.spec.engine, options: e.options, facts: e.facts, result, replay: e.observer.passes[1] ?? null, nonFiniteSnapshotValues: 0, failure: null });

// ---- 1. row table ----------------------------------------------------------------------------------------------

test('row table: scenes exist and are valid, counts and hashes equal makeScene, within hard bounds, thresholds equal the exported constants', () => {
  assert.deepEqual([...ROW_IDS], ['Q1', 'Q2', 'Q3']);
  for (const id of ROW_IDS) {
    const def = ROWS[id], scene = makeScene(def.scene);
    assert.ok((CASES as readonly string[]).includes(def.scene), def.scene);
    assert.equal(SCENE_VALIDITY[def.scene as keyof typeof SCENE_VALIDITY]?.status, id === 'Q3' ? undefined : 'valid');
    assert.deepEqual(sceneFacts(scene), { hash: def.hash, bodies: def.bodies, dynamicBodies: def.dynamicBodies, joints: def.joints }, id);
    assert.equal(sceneHash(scene), def.hash);
    assert.ok(scene.bodies.length <= BOUNDS.bodies);
    assert.equal(scene.seed, null);
  }
  assert.deepEqual([101, 104, 22].map(n => n), ROW_IDS.map(id => ROWS[id].bodies));
  assert.deepEqual([100, 100, 20], ROW_IDS.map(id => ROWS[id].dynamicBodies));
  assert.equal(ROWS.Q3.joints, 20);
  assert.deepEqual(BOUNDS, { rows: 3, bodies: 1000, steps: 120, repeats: 1 });
  assert.deepEqual({ ...THRESHOLDS }, { floorTarget: FLOOR_TARGET, settledMaxSpeed: SETTLED_MAX_SPEED, restSpeed: REST_SPEED, quaternionNorm: 1e-4, jointAnchorMax: 0.05, restingMinSeconds: 10 });
  assert.equal(FLOOR_TARGET, 0.01); assert.equal(SETTLED_MAX_SPEED, 0.05); assert.equal(REST_SPEED, 0.01);
  // the quaternion tolerance is quality()'s own literal: just inside passes, just outside is counted
  const scene = makeScene('rest-grid-100'), state = flat(scene);
  setBody(state, 1, 3, 0, 0, 0, 1 + QUATERNION_NORM_TOLERANCE * 0.5);
  assert.equal(quality(scene, state).invalidRotations, 0);
  setBody(state, 1, 3, 0, 0, 0, 1 + QUATERNION_NORM_TOLERANCE * 1.5);
  assert.equal(quality(scene, state).invalidRotations, 1);
  assert.equal(JOINT_ANCHOR_MAX, 0.05); assert.equal(RESTING_MIN_SECONDS, 10);
  // declared options: identical fixed workload for both engines; only the AVBD margin differs between A and B
  for (const [engine, config, margin] of [['avbd', 'A', 0.01], ['avbd', 'B', 0.001], ['rapier', 'R', DEFAULTS.avbdMargin]] as const) {
    const o = declaredOptions(engine, config);
    validateOptions(o);
    assert.deepEqual([o.dt, o.lead, o.steps, o.batchSize, o.repeats, o.avbdIterations, o.rapierIterations, o.rapierPgsIterations, o.avbdMargin, o.rapierSleeping, o.rapierCcd, o.jitter, o.impactPhase, o.finalWindow, o.timeoutMs],
      [1 / 60, 0, 120, 10, 1, 10, 10, 1, margin, false, false, 0, 0, FINAL_WINDOW, DEFAULTS.timeoutMs]);
  }
  assert.throws(() => declaredOptions('avbd', 'R')); assert.throws(() => declaredOptions('rapier', 'A'));
  // criteria table: the matrix roles
  assert.equal(ROW_CRITERIA.Q1.R3, 'required'); assert.equal(ROW_CRITERIA.Q3.C3, 'notObservable'); assert.equal(ROW_CRITERIA.Q3.J1, 'required'); assert.equal(ROW_CRITERIA.Q1.J1, undefined);
  assert.deepEqual(CRITERIA_IDS.filter(id => ROW_CRITERIA.Q2[id] === 'required'), ['V1', 'V2', 'V3', 'V4', 'C1', 'C2', 'C3', 'R1']);
  // the plan: Rapier runs once per row and says which AVBD configurations it serves
  const plan = planRuns({ rows: ['Q1'], engines: ['avbd', 'rapier'], configs: ['A', 'B'] });
  assert.deepEqual(plan.map(p => p.runId), ['Q1:avbd:A', 'Q1:avbd:B', 'Q1:rapier:R']);
  assert.deepEqual(plan[2].appliesToConfigs, ['A', 'B']);
  assert.deepEqual(planRuns({ rows: ['Q1'], engines: ['rapier'], configs: ['B'] })[0].appliesToConfigs, ['B']);
});

// ---- 2. clean fakes through runOne ---------------------------------------------------------------------------------

test('a clean run passes where decidable, R3 and Q1 stay unknown, Q3 C3 is notObservable, nothing passes by omission', async () => {
  const { factory, log } = fakeFactory(() => undefined);
  const acquired = { count: 0 };
  const session = fakeSession();
  const report = await run({ factory, session, acquired }, { rows: [...ROW_IDS], engines: ['avbd'], configs: ['A', 'B'] });
  assert.equal(acquired.count, 1);
  assert.equal(report.status, 'completed', JSON.stringify(report.error));
  assert.equal(report.rows.length, 6);
  assert.deepEqual(session.events, ['settle', 'settle', 'settle', 'settle', 'settle', 'settle', 'close']);
  assert.ok(log.destroys.every(n => n === 1), 'every adapter destroyed exactly once');
  for (const r of report.rows) {
    assert.equal(r.execution.status, 'completed');
    assert.equal(r.run!.status, 'completed', String(r.run!.error));
    assert.equal(r.timingReportable, false);
    assert.match(r.timingReportableReason, /never unlocks timing/);
  }
  const q1 = row(report, 'Q1:avbd:A'), q2 = row(report, 'Q2:avbd:B'), q3 = row(report, 'Q3:avbd:A');
  assert.equal(q1.rowVerdict, 'unknown');
  assert.equal(crit(q1, 'R3').state, 'unknown'); assert.equal(crit(q1, 'R3').verdict, 'unknown'); assert.equal(crit(q1, 'R3').required, true);
  assert.match(crit(q1, 'R3').reason!, /at least 10 measured seconds/);
  for (const id of ['V1', 'V2', 'V3', 'V4', 'C1', 'C2', 'C3', 'R1'] as const) assert.equal(crit(q1, id).verdict, 'pass', id);
  assert.equal(crit(q1, 'R2').verdict, null); assert.equal(crit(q1, 'R2').state, 'measured'); assert.equal(crit(q1, 'R2').value, 1);
  assert.equal(q1.criteria.some(c => c.id === 'J1'), false, 'J1 belongs to Q3 only');
  assert.equal(q2.rowVerdict, 'pass', JSON.stringify(verdicts(q2)));
  assert.equal(crit(q2, 'R3').state, 'notObservable'); assert.equal(crit(q2, 'R3').required, false);
  assert.equal(q3.rowVerdict, 'pass', JSON.stringify(verdicts(q3)));
  assert.equal(crit(q3, 'C3').state, 'notObservable'); assert.equal(crit(q3, 'C3').verdict, null); assert.equal(crit(q3, 'C3').value, null); assert.equal(crit(q3, 'C3').required, false);
  assert.equal(crit(q3, 'C3').detail!.unjudged, true); assert.ok('rawMaxRelativeDepth' in crit(q3, 'C3').detail!);
  assert.equal(crit(q3, 'J1').verdict, 'pass'); assert.equal(crit(q3, 'J1').required, true);
  assert.equal(crit(q3, 'C2').verdict, null); assert.equal(crit(q3, 'R1').verdict, null);
  assert.equal(crit(q1, 'E1').verdict, null);
  // A and B are separate verdicts with their own resolved configuration
  assert.deepEqual([row(report, 'Q1:avbd:A').config.id, row(report, 'Q1:avbd:B').config.id], ['A', 'B']);
  assert.equal((row(report, 'Q1:avbd:B').config.declared as { contactMargin: number }).contactMargin, 0.001);
  assert.equal(JSON.stringify(report).includes('"winner"'), false);
  // roles survive in the record
  assert.equal(crit(q3, 'V2').required, true);
});

test('Rapier: one run per row serves every selected configuration, V2 is not observable, and no GPU is ever requested', async () => {
  const { factory } = fakeFactory(() => undefined);
  const acquired = { count: 0 };
  const rapierOnly = await run({ factory, acquired }, { rows: ['Q3'], engines: ['rapier'], configs: ['A', 'B'] });
  assert.equal(acquired.count, 0, 'acquireGpu is never called for a Rapier-only invocation');
  assert.equal(rapierOnly.rows.length, 1);
  const r = rapierOnly.rows[0];
  assert.equal(r.runId, 'Q3:rapier:R');
  assert.deepEqual(r.config.appliesToConfigs, ['A', 'B']);
  assert.match(String(r.config.mapping), /contactMargin/);
  assert.equal(crit(r, 'V2').state, 'notObservable'); assert.equal(crit(r, 'V2').required, false);
  assert.equal(r.rowVerdict, 'pass');
  assert.equal((rapierOnly.environment as { adapter?: unknown }).adapter, undefined);
  const mixed = await run({ factory: fakeFactory(() => undefined).factory, acquired }, { rows: ['Q3'], engines: ['rapier', 'avbd'], configs: ['A', 'B'] });
  assert.equal(acquired.count, 1);
  assert.deepEqual(mixed.rows.map(x => x.runId), ['Q3:avbd:A', 'Q3:avbd:B', 'Q3:rapier:R']);
});

// ---- 3. injected faults ------------------------------------------------------------------------------------------

const fault = async (rowId: RowId, behavior: Behavior, config: Partial<{ engines: string[] }> = {}) => {
  const { factory, log } = fakeFactory(() => behavior);
  const session = fakeSession();
  const report = await run({ factory, session }, { rows: [rowId], engines: config.engines ?? ['avbd'], configs: ['A'] });
  return { report, r: report.rows[0], log, session };
};

test('genuine failures fail the row and keep the partial record', async () => {
  // non-finite pose during the replay
  let f = await fault('Q1', { mutate: (s, c) => { if (c.pass === 'replay' && c.steps >= 30) setBody(s, 1, 0, NaN); } });
  assert.equal(f.report.status, 'failed');
  assert.equal(f.r.execution.status, 'failed'); assert.equal(f.r.execution.failure!.kind, 'invalid-state');
  assert.equal(f.r.rowVerdict, 'fail'); assert.equal(crit(f.r, 'V1').verdict, 'fail');
  assert.equal(f.r.run!.status, 'failed'); assert.equal((f.r.run!.qualitySamples as unknown[]).length, 30, 'partial samples kept');
  assert.equal(crit(f.r, 'C2').verdict, 'unknown', 'incomplete coverage is unknown, not a pass');
  assert.equal(crit(f.r, 'R1').verdict, 'unknown');
  assert.ok(f.r.timing!.replayPass!.calls.snapshot > 0);
  assert.ok(f.log.destroys.every(n => n === 1));
  // non-unit quaternion
  f = await fault('Q2', { mutate: (s, c) => { if (c.pass === 'replay' && c.steps === 10) setBody(s, 1, 3, 0, 0, 0, 1 + 3 * QUATERNION_NORM_TOLERANCE); } });
  assert.equal(crit(f.r, 'V1').verdict, 'fail'); assert.equal(f.r.execution.failure!.kind, 'invalid-state'); assert.equal(f.r.rowVerdict, 'fail');
  // counter overflow, then clashes, as the real adapter reports them
  for (const [message, v] of [['Invalid GPU step: overflow=3, clashes=0', 3], ['Invalid GPU step: overflow=0, clashes=2', 2]] as const) {
    f = await fault('Q1', { inspect: c => { if (c.steps === 5) throw new Error(message); return { overflow: 0, clashes: 0 }; } });
    assert.equal(f.r.execution.failure!.kind, 'counter-limit');
    assert.equal(crit(f.r, 'V2').verdict, 'fail'); assert.equal(crit(f.r, 'V2').value, v);
    assert.equal(f.r.rowVerdict, 'fail'); assert.equal(f.report.status, 'failed');
    assert.equal(f.r.observations.passes[1].inspects.length, 5);
  }
  // counters that report non-zero without throwing are a failure too; counters that are absent are unknown
  f = await fault('Q1', { inspect: c => c.steps === 7 ? { overflow: 1, clashes: 0 } : { overflow: 0, clashes: 0 } });
  assert.equal(crit(f.r, 'V2').verdict, 'fail'); assert.equal(f.r.execution.status, 'completed', 'the adapter did not throw: a completed run with a failing criterion');
  assert.equal(f.r.rowVerdict, 'fail'); assert.equal(f.report.status, 'completed');
  f = await fault('Q2', { inspect: () => ({}) });
  assert.equal(crit(f.r, 'V2').verdict, 'unknown'); assert.equal(f.r.rowVerdict, 'unknown');
  // replay does not reproduce the timed final state
  f = await fault('Q1', { mutate: (s, c) => { if (c.pass === 'replay' && c.steps === 120) s[STATE_SIZE] += 1e-9; } });
  assert.equal(f.r.execution.failure!.kind, 'replay-mismatch'); assert.equal(crit(f.r, 'V3').verdict, 'fail'); assert.equal(f.r.run!.replayMatches, false); assert.equal(f.r.rowVerdict, 'fail');
  // timeout
  const slow = fakeClock();
  const t = fakeFactory(() => ({}), slow);
  const options = declaredOptions('avbd', 'A');
  const origNow = performance.now;
  let fake = 0;
  performance.now = () => (fake += options.timeoutMs / 3);
  try {
    const report = await run({ factory: t.factory, session: fakeSession() }, { rows: ['Q1'], engines: ['avbd'], configs: ['A'] });
    assert.equal(report.rows[0].execution.failure!.kind, 'timeout'); assert.equal(report.rows[0].run!.status, 'timeout'); assert.equal(report.rows[0].rowVerdict, 'fail');
  } finally { performance.now = origNow; }
});

test('depth, speed and joint error just over the limit fail; just under stays a pass; counts and samples survive', async () => {
  // floor depth 0.0101 of a 1 m body: C2 (and the stacked pair, C3) fail; a run that finishes is a completed row with failing criteria
  // body 1 sinks 0.0101 into the floor and body 2 (above it) 0.0101 into body 1
  let f = await fault('Q1', { mutate: (s, c) => { if (c.steps >= 20) { setBody(s, 1, 2, 1 - 0.0101); setBody(s, 2, 2, 2 - 0.0202); } } });
  assert.equal(f.r.execution.status, 'completed'); assert.equal(crit(f.r, 'C2').verdict, 'fail'); assert.ok((crit(f.r, 'C2').value as number) > FLOOR_TARGET);
  assert.equal(crit(f.r, 'C3').verdict, 'fail'); assert.equal(f.r.rowVerdict, 'fail'); assert.equal(f.report.status, 'completed');
  f = await fault('Q1', { mutate: (s, c) => { if (c.steps >= 20) { setBody(s, 1, 2, 1 - 0.005); setBody(s, 2, 2, 2 - 0.01); } } });
  assert.equal(crit(f.r, 'C2').verdict, 'pass'); assert.equal(crit(f.r, 'C3').verdict, 'pass');
  // final-window speed: exactly 0.05 passes (hypot of a single component is exact), 0.0501 fails
  f = await fault('Q1', { mutate: s => setBody(s, 1, 7, SETTLED_MAX_SPEED, 0, 0) });
  assert.equal(crit(f.r, 'R1').value, SETTLED_MAX_SPEED); assert.equal(crit(f.r, 'R1').verdict, 'pass');
  f = await fault('Q1', { mutate: s => setBody(s, 1, 7, 0.0501, 0, 0) });
  assert.equal(crit(f.r, 'R1').verdict, 'fail'); assert.equal(f.r.rowVerdict, 'fail');
  assert.ok((crit(f.r, 'R2').value as number) < 1 && (crit(f.r, 'R2').value as number) >= 0);
  // joint anchor separation on the chain
  f = await fault('Q3', { mutate: (s, c) => { if (c.steps >= 10) setBody(s, 6, 0, s[6 * STATE_SIZE] + 0.0501); } });
  assert.equal(crit(f.r, 'J1').verdict, 'fail'); assert.ok((crit(f.r, 'J1').value as number) > JOINT_ANCHOR_MAX);
  f = await fault('Q3', { mutate: (s, c) => { if (c.steps >= 10) setBody(s, 6, 0, s[6 * STATE_SIZE] + 0.04); } });
  assert.equal(crit(f.r, 'J1').verdict, 'pass');
  // a body that leaves the floor fails coverage (C1)
  f = await fault('Q2', { mutate: s => setBody(s, 1, 0, 5000) });
  assert.equal(crit(f.r, 'C1').verdict, 'fail');
});

test('judgeRow boundaries: exactly at each limit passes, just over fails, missing or non-finite is unknown', async () => {
  const q1 = await execute('Q1'), q3 = await execute('Q3');
  assert.equal(q1.result.status, 'completed', q1.result.error);
  const get = (e: typeof q1, id: CriterionId, edit: (r: Result) => void): Criterion => {
    const r = structuredClone(e.result); edit(r);
    return judgeOf(e, r).criteria.find(c => c.id === id)!;
  };
  const EPS = 1e-9;
  const setAll = (r: Result, key: 'maxRelativeFloorPenetration', v: number) => r.qualitySamples.forEach(s => { s.quality[key] = v; });
  // C2
  assert.equal(get(q1, 'C2', r => setAll(r, 'maxRelativeFloorPenetration', FLOOR_TARGET)).verdict, 'pass');
  assert.equal(get(q1, 'C2', r => setAll(r, 'maxRelativeFloorPenetration', FLOOR_TARGET + EPS)).verdict, 'fail');
  // C3 (pair depth)
  assert.equal(get(q1, 'C3', r => r.qualitySamples.forEach(s => { s.contacts!.maxRelativeDepth = FLOOR_TARGET; })).verdict, 'pass');
  assert.equal(get(q1, 'C3', r => { r.qualitySamples[60].contacts!.maxRelativeDepth = FLOOR_TARGET + EPS; }).verdict, 'fail');
  // R1
  assert.equal(get(q1, 'R1', r => { r.finalWindow!.maxSpeed = SETTLED_MAX_SPEED; }).verdict, 'pass');
  assert.equal(get(q1, 'R1', r => { r.finalWindow!.maxSpeed = SETTLED_MAX_SPEED + EPS; }).verdict, 'fail');
  // J1
  assert.equal(get(q3, 'J1', r => { r.physical!.maxJointError = JOINT_ANCHOR_MAX; }).verdict, 'pass');
  assert.equal(get(q3, 'J1', r => { r.physical!.maxJointError = JOINT_ANCHOR_MAX + EPS; }).verdict, 'fail');
  // C1 and V1 are exact zero tests
  assert.equal(get(q1, 'C1', r => { r.qualitySamples[3].quality.outsideFloorBodies = 1; }).verdict, 'fail');
  assert.equal(get(q1, 'V1', r => { r.qualitySamples[3].quality.invalidRotations = 1; }).verdict, 'fail');
  assert.equal(get(q1, 'V1', r => { r.finalQuality!.nonFiniteBodies = 1; }).verdict, 'fail');
  // an over-limit sample fails even when coverage is partial (it can only get worse); a clean partial run is unknown
  assert.equal(get(q1, 'C2', r => { r.status = 'failed'; r.qualitySamples.length = 50; r.qualitySamples[49].quality.maxRelativeFloorPenetration = 0.02; }).verdict, 'fail');
  assert.equal(get(q1, 'C2', r => { r.status = 'failed'; r.qualitySamples.length = 50; }).verdict, 'unknown');
  // missing or non-finite aggregates are unknown, never a numeric zero or a pass
  const unknowns: [typeof q1, CriterionId, (r: Result) => void][] = [
    [q1, 'C2', r => { r.qualitySamples[5].quality.maxRelativeFloorPenetration = NaN; }],
    [q1, 'C2', r => { r.qualitySamples.length = 119; }],
    [q1, 'C2', r => { r.qualitySamples = []; }],
    [q1, 'C3', r => { r.qualitySamples[5].contacts = null; }],
    [q1, 'C1', r => { (r.qualitySamples[5].quality as { outsideFloorBodies: unknown }).outsideFloorBodies = undefined; }],
    [q1, 'R1', r => { delete r.finalWindow; }],
    [q1, 'R1', r => { r.finalWindow!.maxSpeed = NaN; }],
    [q1, 'R1', r => { r.finalWindow!.steps = 59; }],
    [q1, 'R2', r => { delete r.finalWindow; }],
    [q1, 'V3', r => { delete r.replayMatches; }],
    [q1, 'V1', r => { delete r.finalQuality; }],
    [q1, 'E1', r => { delete r.physical; }],
    [q3, 'J1', r => { delete r.physical; }],
    [q3, 'J1', r => { r.physical!.maxJointError = NaN; }],
    [q3, 'J1', r => { r.physical!.maxJointError = Infinity; r.status = 'failed'; }],
  ];
  for (const [e, id, edit] of unknowns) {
    const c = get(e, id, edit);
    const expect = id === 'R2' || id === 'E1' ? null : 'unknown';
    assert.equal(c.verdict, expect, `${id}: ${edit}`);
    if (expect === 'unknown') { assert.equal(c.state, 'unknown'); assert.equal(c.value, null, 'unknown carries no value that could be read as zero'); }
    else if (id === 'R2' || id === 'E1') assert.equal(c.state, 'unknown');
  }
  // V2: no replay inspections means unknown
  assert.equal(judgeRow({ row: ROWS.Q1, engine: 'avbd', options: q1.options, facts: q1.facts, result: q1.result, replay: null, nonFiniteSnapshotValues: 0, failure: null })
    .criteria.find(c => c.id === 'V2')!.verdict, 'unknown');
  // R3 is decided only from a 10 s window (not reachable inside the hard bounds, but the rule is the matrix's)
  const longOptions = { ...q1.options, steps: 600 };
  const longResult = structuredClone(q1.result); longResult.restingTargetMet = true;
  const r3 = (result: Result, options = longOptions) => judgeRow({ row: ROWS.Q1, engine: 'avbd', options, facts: q1.facts, result, replay: null, nonFiniteSnapshotValues: 0, failure: null }).criteria.find(c => c.id === 'R3')!;
  assert.equal(r3(longResult).verdict, 'pass');
  assert.equal(r3({ ...longResult, restingTargetMet: false }).verdict, 'fail');
  assert.equal(r3({ ...longResult, restingTargetMet: undefined }).verdict, 'unknown');
  assert.equal(r3(longResult, { ...longOptions, steps: 599 }).verdict, 'unknown');
  // V4: any difference from the declaration fails
  const wrong = structuredClone(q1.result); wrong.hash = '00000000';
  assert.equal(judgeOf(q1, wrong).criteria.find(c => c.id === 'V4')!.verdict, 'fail');
  assert.equal(judgeOf(q1, wrong).rowVerdict, 'fail');
  // a row is a pass only when every required criterion passes
  assert.equal(judgeOf(q3).rowVerdict, 'pass');
  assert.equal(judgeOf(q1).rowVerdict, 'unknown');
});

// ---- 4. instrumentation ---------------------------------------------------------------------------------------------

test('instrument: per-kind counts and intervals, other-engine fields null with reasons, original values, errors and this preserved', async () => {
  const clock = fakeClock();
  const advance = { step: 2, complete: 5, snapshot: 3, inspect: 7 };
  const { factory } = fakeFactory(() => ({ advance }), clock);
  const observer = new RunObserver(clock.now);
  const scene = makeScene('rest-grid-100');
  const options = { ...declaredOptions('avbd', 'A'), steps: 20 };
  const result = await runOne('avbd', scene, 0, options, null as unknown as GPUDevice, undefined, observedFactory(factory, observer));
  assert.equal(result.status, 'completed', result.error);
  const timing = buildTiming(observer);
  const t = timing.timedPass!, r = timing.replayPass!;
  assert.equal(t.pass, 'timed'); assert.equal(r.pass, 'replay');
  assert.deepEqual(t.calls, { step: 20, complete: 3, snapshot: 2, inspect: 0, destroy: 1 });
  assert.deepEqual(r.calls, { step: 20, complete: 21, snapshot: 22, inspect: 20, destroy: 1 });
  assert.deepEqual(t.avbdEncodeMs, Array(20).fill(2)); assert.deepEqual(t.avbdQueueWaitMs, [5, 5, 5]); assert.deepEqual(t.readbackMs, [3, 3]);
  assert.deepEqual(r.countersReadMs, Array(20).fill(7)); assert.equal(r.readbackMs.length, 22);
  assert.equal(t.rapierStepMs, null); assert.match(t.nullReasons.rapierStepMs, /AVBD/);
  assert.equal(t.setupMs, 5, 'creation to first completion');
  assert.equal(timing.gpuActiveMs, null); assert.equal(timing.renderMs, null); assert.equal(timing.droppedSimulationTimeS, null);
  for (const key of ['gpuActiveMs', 'renderMs', 'droppedSimulationTimeS']) assert.ok(timing.nullReasons[key as 'gpuActiveMs'].length > 10, key);
  assert.match(timing.nullReasons.droppedSimulationTimeS, /World/);
  // no summed or compared field exists in the timing block
  assert.ok(!Object.keys(timing).some(k => /total|sum|ratio|speedup|winner|fps/i.test(k)));
  // Rapier: the other-engine fields are null with reasons
  const rapierClock = fakeClock(), rapierObserver = new RunObserver(rapierClock.now);
  await runOne('rapier', scene, 0, { ...declaredOptions('rapier', 'R'), steps: 10 }, null as unknown as GPUDevice, undefined, observedFactory(fakeFactory(() => ({ advance }), rapierClock).factory, rapierObserver));
  const rt = buildTiming(rapierObserver).timedPass!;
  assert.deepEqual(rt.rapierStepMs, Array(10).fill(2)); assert.equal(rt.avbdEncodeMs, null); assert.equal(rt.avbdQueueWaitMs, null); assert.equal(rt.countersReadMs, null);
  assert.match(rt.nullReasons.avbdQueueWaitMs, /Rapier/);

  // faithfulness on a hand-made adapter: this, arguments, return identity, the thrown error object, lazily optional members, no mutation of the original
  const seen: unknown[] = [];
  const boom = new Error('inspect failed /Users/someone/x');
  const state = new Float64Array(3);
  const original = {
    settings: { a: 1 }, gpuIndices: [1, 2], tag: 'orig',
    step() { seen.push(['step', (this as { tag: string }).tag]); },
    async complete() { seen.push('complete'); },
    async inspect(): Promise<object> { throw boom; },
    async snapshot() { return state; },
    destroy() { seen.push('destroy'); },
    raycasts: async (rays: unknown[]) => rays.map(() => 1),
  } as unknown as Adapter;
  const keys = Object.keys(original), stepFn = original.step;
  const record = new PassRecord(0, 'avbd');
  const wrapped = instrumentAdapter(original, record, clock.now);
  wrapped.step();
  assert.deepEqual(seen[0], ['step', 'orig'], 'original this');
  assert.equal(await wrapped.snapshot(), state, 'same array object');
  await assert.rejects(wrapped.inspect(), (e: unknown) => e === boom);
  assert.equal(wrapped.settings, original.settings); assert.deepEqual(wrapped.gpuIndices, [1, 2]);
  assert.deepEqual(await wrapped.raycasts!([1, 2] as never), [1, 1]);
  assert.equal(record.inspects[0].error, 'inspect failed <path>', 'recorded errors carry no local path');
  assert.deepEqual(Object.keys(original), keys); assert.equal(original.step, stepFn, 'the original object is untouched');
  assert.equal(wrapped.watchContacts, undefined, 'absent optional members stay absent');
  // destroy forwards once; a repeated request is counted and not forwarded
  record.owned = original;
  wrapped.destroy(); wrapped.destroy();
  assert.equal(seen.filter(s => s === 'destroy').length, 1);
  assert.deepEqual([record.calls.destroy, record.redundantDestroyCalls, record.destroyed], [2, 1, true]);
});

// ---- 5. lifecycle --------------------------------------------------------------------------------------------------

test('adapters are destroyed once, on every path; runOne rejecting from cleanup keeps partial observations and fabricates no Result', async () => {
  // the explicit destroy of the timed adapter throws: runOne's own finally asks again, the wrapper does not forward it twice
  let f = await fault('Q1', { destroyThrows: pass => pass === 'timed' });
  assert.equal(f.r.execution.status, 'failed'); assert.match(f.r.execution.failure!.message, /destroy failed/);
  assert.deepEqual(f.log.destroys, [1], 'one real destroy of the failed adapter, no second request forwarded');
  assert.equal(f.r.observations.passes[0].destroy.redundantCalls, 1); assert.equal(f.r.observations.passes[0].destroy.destroyed, false);
  assert.equal(f.r.rowVerdict, 'fail'); assert.equal(f.report.status, 'failed');
  // the final destroy of the replay adapter throws: runOne rejects from `finally`; no Result exists
  f = await fault('Q1', { destroyThrows: pass => pass === 'replay' });
  assert.equal(f.r.run, null, 'no completed Result is fabricated');
  assert.equal(f.r.execution.status, 'failed'); assert.equal(f.r.execution.failure!.kind, 'adapter-cleanup'); assert.equal(f.r.execution.failure!.phase, 'cleanup');
  assert.equal(f.r.rowVerdict, 'fail');
  assert.equal(f.r.observations.passes.length, 2); assert.equal(f.r.observations.passes[1].snapshots.length, 122); assert.equal(f.r.observations.passes[1].inspects.length, 120);
  assert.equal(f.r.timing!.replayPass!.calls.step, 120);
  assert.equal(crit(f.r, 'V4').verdict, 'pass', 'what is known stays judged'); assert.equal(crit(f.r, 'V2').verdict, 'pass', 'counters were read cleanly on every replay step');
  assert.equal(crit(f.r, 'C2').verdict, 'unknown'); assert.equal(crit(f.r, 'V3').verdict, 'unknown');
  assert.deepEqual(f.log.destroys, [1, 1]);
  // a failing queue completion mid-run still destroys the adapter
  f = await fault('Q2', { failComplete: c => c.pass === 'timed' && c.call === 4 });
  assert.equal(f.r.run!.status, 'failed'); assert.match(String(f.r.run!.error), /queue failed/); assert.deepEqual(f.log.destroys, [1]);
  assert.equal(f.r.execution.failure!.phase, 'timed');
  // creation failure: error recorded, path scrubbed, nothing to destroy
  f = await fault('Q1', { createThrows: () => true });
  assert.equal(f.r.run!.status, 'failed'); assert.ok(!JSON.stringify(f.r).includes('/Users/')); assert.equal(f.r.observations.passes[0].creationError, 'create failed at <path>');
  assert.equal(f.r.timing!.timedPass!.setupMs, null); assert.match(f.r.timing!.timedPass!.nullReasons.setupMs, /never completed/);
  // a probe error while wrapping an acquired adapter destroys it and is rethrown
  const brokenClock = { n: 0 };
  const log = { created: 0, destroys: [] as number[], steps: [] as number[] };
  const { factory } = fakeFactory(() => undefined, fakeClock(), log);
  const observer = new RunObserver(() => { if (++brokenClock.n > 1) throw new Error('clock failed'); return 0; });
  await assert.rejects(observedFactory(factory, observer)('avbd', makeScene('chain-20'), declaredOptions('avbd', 'A'), null as unknown as GPUDevice), /clock failed/);
  assert.deepEqual(log.destroys, [1]);
  assert.deepEqual(observer.sweep(), [], 'nothing left to sweep');
  // an adapter runOne never saw (a leak) is swept
  const leakObserver = new RunObserver(() => 0);
  const leakLog = { created: 0, destroys: [] as number[], steps: [] as number[] };
  await observedFactory(fakeFactory(() => undefined, fakeClock(), leakLog).factory, leakObserver)('avbd', makeScene('chain-20'), declaredOptions('avbd', 'A'), null as unknown as GPUDevice);
  assert.deepEqual(leakObserver.sweep(), []); assert.deepEqual(leakLog.destroys, [1]); assert.deepEqual(leakObserver.sweep(), []); assert.deepEqual(leakLog.destroys, [1]);
});

// ---- 6. host: shared GPU failure, late errors, teardown ordering ----------------------------------------------------------

test('a row-local failure permits the next row; a shared GPU error stops GPU rows (notRun) and Rapier rows still run', async () => {
  // row-local: Q1 A overflows, the rest run
  let overflow = true;
  const local = fakeFactory(() => ({ inspect: () => { if (overflow) { overflow = false; throw new Error('Invalid GPU step: overflow=1, clashes=0'); } return { overflow: 0, clashes: 0 }; } }));
  const first = await run({ factory: local.factory, session: fakeSession() }, { rows: ['Q1', 'Q2'], engines: ['avbd'], configs: ['A'] });
  assert.deepEqual(first.rows.map(r => r.execution.status), ['failed', 'completed']);
  assert.equal(first.status, 'failed');
  // shared: the second AVBD run sees an uncaptured GPU error
  let calls = 0;
  const shared = fakeSession({ errorAt: () => (++calls === 200 ? 'Validation error at /Users/someone/shader' : null) });
  const events = fakeFactory(() => undefined);
  const report = await run({ factory: events.factory, session: shared }, { rows: ['Q1', 'Q2'], engines: ['avbd', 'rapier'], configs: ['A', 'B'] });
  assert.deepEqual(report.rows.map(r => [r.runId, r.execution.status]), [
    ['Q1:avbd:A', 'completed'], ['Q1:avbd:B', 'failed'], ['Q1:rapier:R', 'completed'],
    ['Q2:avbd:A', 'notRun'], ['Q2:avbd:B', 'notRun'], ['Q2:rapier:R', 'completed']]);
  assert.equal(report.rows[1].execution.failure!.kind, 'gpu-error');
  assert.match(report.rows[3].execution.notRunReason!, /poisoned device/);
  assert.equal(report.rows[3].rowVerdict, 'notRun'); assert.equal(report.rows[3].criteria.length, 0); assert.equal(report.rows[3].run, null);
  assert.deepEqual(report.rows[3].config.appliesToConfigs, ['A']);
  assert.equal(report.status, 'failed'); assert.deepEqual(report.gpuErrors, ['Validation error at <path>']);
  assert.equal(report.rows[3].observations.passes.length + report.rows[4].observations.passes.length, 0, 'AVBD rows after the error never created an adapter');
  assert.ok(events.log.created >= 2);
  // a late error (after a row completed) fails that row's execution and poisons the rest
  const late = fakeSession();
  const lateFactory = fakeFactory(() => undefined);
  const hostWithLate: HostBits = { factory: lateFactory.factory, session: { ...late, settle: async () => { if (late.events.filter(e => e === 'settle').length === 0) late.errors.push('late validation error'); late.events.push('settle'); } } as GpuSession };
  const lateReport = await run(hostWithLate, { rows: ['Q1', 'Q2'], engines: ['avbd'], configs: ['A'] });
  assert.equal(lateReport.rows[0].execution.status, 'failed'); assert.equal(lateReport.rows[0].execution.failure!.kind, 'gpu-error'); assert.equal(lateReport.rows[0].execution.failure!.phase, 'late');
  assert.equal(lateReport.rows[1].execution.status, 'notRun');
  assert.equal(lateReport.rows[0].run!.status, 'completed', 'the partial/complete record is kept');
});

test('the report is finalized only after the owned device is closed, and late or teardown failures cannot leave a clean status', async () => {
  const events: string[] = [];
  const session = fakeSession({ events, closeErrors: ['Device cleanup failed: lost at /Users/someone/d'] });
  const host = fakeHost({ factory: fakeFactory(() => undefined).factory, session });
  const finalNow = host.now;
  host.now = () => { events.push('now'); return finalNow(); };
  const report = await runQualification({ rows: ['Q3'], engines: ['avbd'], configs: ['A'] }, host, context);
  assert.ok(events.indexOf('close') > events.lastIndexOf('settle'));
  assert.ok(events.lastIndexOf('now') > events.indexOf('close'), 'the report is stamped and finalized after cleanup');
  assert.equal(report.status, 'failed'); assert.deepEqual(report.teardownErrors, ['Device cleanup failed: lost at <path>']);
  assert.equal(report.rows[0].execution.status, 'completed'); assert.equal(report.rows[0].rowVerdict, 'pass');
  assert.equal(report.error!.message, 'Device cleanup failed: lost at <path>');
  // a loss seen only at close is surfaced too
  const closing = fakeSession();
  closing.close = async () => { closing.errors.push('Device lost: gone'); return []; };
  const lost = await run({ factory: fakeFactory(() => undefined).factory, session: closing }, { rows: ['Q3'], engines: ['avbd'], configs: ['A'] });
  assert.equal(lost.status, 'failed'); assert.deepEqual(lost.gpuErrors, ['Device lost: gone']);
  // finalize: clean stays identical, a refusal stays a refusal, the first failure is not overwritten
  const refused = refusedReport('no adapter', { source: {}, environment: {}, config: { rows: ['Q1'], engines: ['avbd'], configs: ['A'] }, now: new Date(0) });
  assert.equal(finalizeQualificationReport(refused, [], []), refused);
  assert.equal(finalizeQualificationReport(refused, ['x'], []).status, 'refused');
  const failed = { ...refused, status: 'failed' as const, error: { message: 'first' } };
  assert.equal(finalizeQualificationReport(failed, ['late'], ['cleanup']).error!.message, 'first');
  // an unexpected host exception still closes the owned device before it propagates
  const closeLog: string[] = [];
  const explode = fakeHost({ factory: fakeFactory(() => undefined).factory, session: fakeSession({ events: closeLog }) });
  explode.now = () => { throw new RangeError('clock exploded'); };
  await assert.rejects(runQualification({ rows: ['Q1'], engines: ['avbd'], configs: ['A'] }, explode, context), /clock exploded/);
  assert.ok(closeLog.includes('close'));
  // a bug inside one row's bookkeeping must not lose the row or the others
  const flaky = fakeSession();
  const original = flaky.gpuErrors;
  let first = true;
  flaky.gpuErrors = () => { if (first) { first = false; throw new RangeError('bookkeeping failed'); } return original(); };
  const kept = await run({ factory: fakeFactory(() => undefined).factory, session: flaky }, { rows: ['Q1', 'Q3'], engines: ['avbd'], configs: ['A'] });
  assert.deepEqual(kept.rows.map(r => [r.execution.status, r.rowVerdict]), [['failed', 'fail'], ['completed', 'pass']]);
  assert.equal(kept.rows[0].execution.failure!.kind, 'harness-error');
  // a scene that cannot be built is a failed row that never ran
  const noScene = fakeHost({ factory: fakeFactory(() => undefined).factory, session: fakeSession() });
  let built = 0;
  noScene.makeScene = name => { if (++built > 1) throw new RangeError('scene builder exploded'); return makeScene(name); };
  const missing = await runQualification({ rows: ['Q1'], engines: ['avbd'], configs: ['A'] }, noScene, context);
  assert.deepEqual([missing.rows[0].execution.status, missing.rows[0].rowVerdict, missing.rows[0].execution.failure!.kind], ['notRun', 'fail', 'harness-error']);
});

// ---- 7. refusals ---------------------------------------------------------------------------------------------------

test('argument parsing refuses everything outside the declared rows and bounds; no flag changes a workload or threshold', () => {
  assert.deepEqual(parseQualificationArgs([]), { help: false, config: { rows: ['Q1', 'Q2', 'Q3'], engines: ['avbd'], configs: ['A', 'B'] } });
  assert.deepEqual(parseQualificationArgs(['--help']), { help: true });
  assert.deepEqual(parseQualificationArgs(['--rows', 'Q3,Q1', '--engines', 'rapier,avbd', '--configs', 'B', '--json', 'out.json']),
    { help: false, config: { rows: ['Q1', 'Q3'], engines: ['avbd', 'rapier'], configs: ['B'] }, json: 'out.json' });
  const bad = [['--rows', 'Q1,Q2,Q3,Q1'], ['--rows', 'Q1,Q1'], ['--rows', 'Q4'], ['--rows', ''], ['--rows', 'Q1,,Q2'], ['--engines', 'gpu'], ['--engines', 'avbd,avbd'], ['--configs', 'C'], ['--configs', 'A,A,B'],
    ['--steps', '120'], ['--dt', '0.01'], ['--iterations', '4'], ['--threshold', '1'], ['--software'], ['--rows'], ['--rows', '--json'], ['--rows', 'Q1', '--rows', 'Q2'], ['--json', 'a.txt'], ['Q1'], ['--json']];
  for (const args of bad) assert.throws(() => parseQualificationArgs(args), QualificationRefusal, args.join(' '));
  assert.throws(() => resolveQualificationConfig({ rows: ['Q1'], steps: 5 }), /Unknown configuration key/);
  assert.throws(() => resolveQualificationConfig(null), QualificationRefusal);
  assert.throws(() => resolveQualificationConfig({ rows: new Array(4).fill('Q1') }), /at most 3 rows/);
});

test('hard bounds and refusals happen before any device is requested', async () => {
  const acquired = { count: 0 };
  const { factory } = fakeFactory(() => undefined);
  const big = (name: string) => { const s = makeScene(name); s.bodies = [...s.bodies, ...Array.from({ length: 1000 }, () => s.bodies[1])]; return s; };
  await assert.rejects(run({ factory, acquired, makeScene: big }, { rows: ['Q1'], engines: ['avbd'], configs: ['A'] }), /bounded by 1000 bodies/);
  assert.equal(acquired.count, 0);
  const specs = planRuns({ rows: ['Q1'], engines: ['avbd'], configs: ['A'] });
  assertWithinBounds(specs, new Map([['Q1', makeScene('rest-grid-100')]]));
  assert.throws(() => assertWithinBounds(specs, new Map()), QualificationRefusal);
  assert.throws(() => assertWithinBounds(specs, new Map([['Q1', big('rest-grid-100')]])), /1000 bodies/);
  await assert.rejects(run({ factory, acquired }, { rows: ['Q1', 'Q2', 'Q3', 'Q1'], engines: ['avbd'] }), QualificationRefusal);
  assert.equal(acquired.count, 0);
  // a refused GPU: no adapter was created, the rows are explicitly notRun, the refusal keeps the adapter record
  const software = { vendor: 'google', architecture: 'swiftshader', device: 'SwiftShader Device', description: 'SwiftShader', isFallbackAdapter: false };
  const created = { count: 0 };
  const counting: typeof createAdapter = async (...args) => { created.count++; return fakeFactory(() => undefined).factory(...args); };
  const refused = await run({ factory: counting, acquire: async () => { assessGpuAdapter(software); throw new Error('unreachable'); } }, { rows: ['Q1', 'Q2'], engines: ['avbd'], configs: ['A', 'B'] });
  assert.equal(refused.status, 'refused'); assert.equal(created.count, 0);
  assert.equal(refused.rows.length, 4); assert.ok(refused.rows.every(r => r.execution.status === 'notRun' && r.rowVerdict === 'notRun' && r.run === null));
  assert.match(refused.error!.message, /software adapter refused/);
  assert.deepEqual((refused.environment as { adapter: { architecture: string } }).adapter.architecture, 'swiftshader');
});

test('adapter gate: fallback, software and unidentified adapters are refused with their record; a hardware adapter passes', () => {
  const refusal = (info: unknown, fallback?: unknown) => { try { assessGpuAdapter(info, fallback); } catch (e) { return e as QualificationRefusal; } throw new Error('not refused'); };
  const apple = { vendor: 'apple', architecture: 'metal-3', device: '', description: 'Apple M4 Max' };
  assert.equal(assessGpuAdapter(apple).vendor, 'apple');
  const fallback = refusal({ ...apple, isFallbackAdapter: true });
  assert.equal(fallback.code, 'gpu'); assert.match(fallback.message, /fallback adapter refused/); assert.equal(fallback.adapter!.isFallbackAdapter, true);
  assert.match(refusal(apple, true).message, /fallback/);
  assert.match(refusal({ vendor: 'google', architecture: 'swiftshader', device: '', description: '' }).message, /software adapter refused/);
  assert.match(refusal({ vendor: 'mesa', architecture: '', device: 'llvmpipe', description: '' }).message, /software adapter refused/);
  assert.match(refusal({ vendor: '', architecture: '', device: '', description: '' }).message, /no identity/);
  assert.match(refusal({ vendor: 'acme', architecture: 'x', device: '', description: '' }).message, /not recognized hardware/);
  assert.match(refusal(null).message, /cannot be identified/); assert.equal(refusal(null).adapter, null);
});

// ---- 8. provenance, JSON ---------------------------------------------------------------------------------------------

test('provenance is copied exactly: dirty stays dirty with its counts, unknown stays null with its reason', () => {
  const pkg = { name: 'three-avbd', version: '0.0.0', devDependencies: { three: '0.187.0', typescript: '^5', webgpu: '0.6.1' }, dependencies: { '@dimforge/rapier3d-compat': '0.21.0' } };
  const dirty: GitProvenance = { source: 'git', head: 'a'.repeat(40), dirty: true, changes: { entries: 3, tracked: 1, untracked: 2, staged: 0, unstaged: 1, renamed: 0, conflicted: 0 } };
  const unknown: GitProvenance = { source: 'unknown', head: null, dirty: null, reason: 'not a Git checkout' };
  const a = buildSource(pkg, dirty), b = buildSource(pkg, unknown);
  assert.equal(a.git, dirty); assert.equal(a.git.dirty, true); assert.deepEqual((a.git as { changes: unknown }).changes, dirty.changes);
  assert.equal(b.git.head, null); assert.equal(b.git.dirty, null); assert.equal((b.git as { reason: string }).reason, 'not a Git checkout');
  assert.deepEqual(a.declaredDependencies, { three: '0.187.0', typescript: '^5', webgpu: '0.6.1', '@dimforge/rapier3d-compat': '0.21.0' });
  // it reaches the report untouched
  return run({ factory: fakeFactory(() => undefined).factory, session: fakeSession() }, { rows: ['Q3'], engines: ['avbd'], configs: ['A'] }).then(report => assert.ok(report.source !== undefined));
});

test('the report is JSON-safe: non-finite values stay visible, there is no local path, no ratio, ranking or winner', async () => {
  assert.deepEqual(toJsonSafe({ a: NaN, b: [Infinity, -Infinity, 1], c: undefined, d: new Float64Array([1, NaN]) }), { a: 'NaN', b: ['Infinity', '-Infinity', 1], d: [1, 'NaN'] });
  const { r, report } = await fault('Q1', { mutate: (s, c) => { if (c.pass === 'replay' && c.steps >= 30) setBody(s, 1, 0, NaN); } });
  const text = JSON.stringify(toJsonSafe(report));
  assert.ok(text.includes('"NaN"') || r.execution.failure !== null);
  const clean = await run({ factory: fakeFactory(() => undefined).factory, session: fakeSession() }, { rows: ['Q1', 'Q3'], engines: ['avbd'], configs: ['A', 'B'] });
  const json = JSON.stringify(toJsonSafe(clean));
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(JSON.parse(json))));
  assert.ok(!json.includes('/Users/') && !/\\Users\\/.test(json));
  const forbidden = /(^|_)(ratio|speedup|winner|rank|ranking|fps|faster|slower|score)(_|$)/i;
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { assert.ok(!forbidden.test(k) && !/^(total|sum)/i.test(k), `${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  walk(clean, 'report');
  assert.equal(clean.proposal, true); assert.equal(clean.benchmark, false); assert.equal(clean.schema, 'three-avbd.qualification-matrix/0');
  assert.ok(clean.rows.every(x => x.timingReportable === false));
  assert.ok(clean.declaredNotRun.some(x => /R3/.test(x)));
});

// ---- 9. CLI ---------------------------------------------------------------------------------------------------------------

const cli = (args: string[]) => {
  const hooks = encodeURIComponent('export async function resolve(s,c,n){if(s==="webgpu")throw new Error("GPU-MODULE-REQUESTED");return n(s,c)}');
  const block = encodeURIComponent(`import{register}from"node:module";register("data:text/javascript,${hooks}")`);
  return spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', '--import', `data:text/javascript,${block}`, 'tools/qualification.ts', ...args],
    { encoding: 'utf8', timeout: 120_000, cwd: new URL('..', import.meta.url) });
};

test('output target: a new .json file in an existing directory; an existing file, folder or (dangling) symlink, or a missing directory, is refused', () => {
  checkOutputTarget(join(dir, 'new.json'));
  const taken = join(dir, 'taken.json');
  writeFileSync(taken, '{}');
  assert.throws(() => checkOutputTarget(taken), QualificationRefusal);
  assert.equal(readFileSync(taken, 'utf8'), '{}');
  assert.throws(() => checkOutputTarget(join(dir, 'missing', 'new.json')), /directory does not exist/);
  mkdirSync(join(dir, 'folder.json'));
  assert.throws(() => checkOutputTarget(join(dir, 'folder.json')), /already exists/);
  symlinkSync(join(dir, 'nowhere.json'), join(dir, 'dangling.json'));
  assert.throws(() => checkOutputTarget(join(dir, 'dangling.json')), /already exists/);
  assert.equal(existsSync(join(dir, 'nowhere.json')), false);
});

test('CLI: --help and every refusal exit before any GPU module is requested, print nothing to stdout but help, and write nothing', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: qualification/);
  assert.doesNotMatch(help.stderr, /GPU-MODULE-REQUESTED/);
  const existing = join(dir, 'existing.json');
  writeFileSync(existing, 'keep');
  const dangling = join(dir, 'cli-dangling.json');
  symlinkSync(join(dir, 'cli-target.json'), dangling);
  for (const args of [['--rows', 'Q1,Q2,Q3,Q1'], ['--rows', 'Q9'], ['--engines', 'gpu'], ['--configs', 'C'], ['--steps', '240'], ['--json', join(dir, 'a.txt')], ['--json', existing], ['--json', dangling],
    ['--json', join(dir, 'nodir', 'd.json')], ['--software'], ['--rows']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /GPU-MODULE-REQUESTED/, 'refused before the GPU module was requested');
    assert.ok(!r.stderr.includes(dir) && !/\/Users\//.test(r.stderr), 'no local path in the message');
  }
  assert.equal(existsSync(join(dir, 'a.txt')), false);
  assert.equal(readFileSync(existing, 'utf8'), 'keep', 'the existing file is untouched');
  assert.equal(existsSync(join(dir, 'cli-target.json')), false, 'a dangling link is not written through');
});

test('CLI: a valid AVBD selection reaches GPU acquisition only after validation; a missing GPU module is a GPU refusal with a refused report (new file, no path)', () => {
  const out = join(dir, 'refused.json');
  const r = cli(['--rows', 'Q1,Q3', '--json', out]);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /webgpu \(Dawn\) package could not be loaded: nothing ran/);
  assert.equal(r.stdout, '');
  const text = readFileSync(out, 'utf8');
  const report = JSON.parse(text) as QualificationReport;
  assert.deepEqual([report.status, report.rows.length, report.rows.every(x => x.execution.status === 'notRun' && x.rowVerdict === 'notRun')], ['refused', 4, true]);
  assert.deepEqual(report.rows.map(x => x.runId), ['Q1:avbd:A', 'Q1:avbd:B', 'Q3:avbd:A', 'Q3:avbd:B']);
  assert.equal(report.benchmark, false);
  assert.ok(!text.includes(dir) && !/\/Users\//.test(text), 'no local path in the report');
  assert.equal(((report.source as { git: { source: string } }).git.source), 'git');
  // a second run refuses early: the report is never overwritten
  const again = cli(['--json', out]);
  assert.equal(again.status, 2);
  assert.equal(readFileSync(out, 'utf8'), text);
  // without --json the report goes to stdout
  const stdout = cli(['--rows', 'Q2', '--configs', 'A']);
  assert.equal(stdout.status, 3);
  assert.equal((JSON.parse(stdout.stdout) as QualificationReport).status, 'refused');
});


test('a timed-adapter destroy failure poisons later GPU rows and retains the cleanup failure', async () => {
  const f = fakeFactory((_engine, created) => created === 0 ? { destroyThrows: () => true } : undefined);
  const report = await run({ factory: f.factory, session: fakeSession() }, { rows: ['Q1', 'Q2'], engines: ['avbd'], configs: ['A'] });
  assert.equal(report.rows[0].execution.failure?.kind, 'adapter-cleanup');
  assert.ok(report.rows[0].execution.cleanupErrors.some(e => /destroy failed/.test(e)));
  assert.equal(report.rows[1].execution.status, 'notRun');
  assert.equal(f.log.created, 1, 'no adapter is created on the possibly leaked session');
  assert.deepEqual(f.log.destroys, [1]);
});

test('exported protocol records cannot be changed through nested references', () => {
  assert.equal(Reflect.set(ROWS.Q1, 'hash', 'changed'), false);
  assert.equal(Reflect.set(ROW_CRITERIA.Q1, 'C2', 'recorded'), false);
  assert.equal(Reflect.set(AVBD_CONFIGS.A, 'margin', 0), false);
  assert.equal(Reflect.set(ROW_IDS, '0', 'Q3'), false);
  assert.equal(ROWS.Q1.hash, 'a978ed4e');
  assert.equal(ROW_CRITERIA.Q1.C2, 'required');
  assert.equal(AVBD_CONFIGS.A.margin, 0.01);
});
