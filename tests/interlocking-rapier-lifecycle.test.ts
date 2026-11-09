import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DisposableScope, createStudySlot, runFixedSteps } from '../examples/interlocking-rapier-lifecycle.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const nameOf = (slot: { readonly current?: { name?: string } }) => slot.current?.name;
const fakeStudy = (log: string[], name: string) => ({ name, dispose() { log.push(`dispose ${name}`); } });

test('teardown releases in reverse order, survives failing steps and reports them in order', async () => {
  const log: string[] = [], scope = new DisposableScope();
  const first = new Error('sync failure'), second = new Error('async failure');
  scope.add(() => log.push('device'));
  scope.add(() => { log.push('renderer'); return Promise.reject(second); });
  scope.add(() => { log.push('materials'); throw first; });
  scope.add(() => log.push('loop'));
  const errors = await scope.dispose();
  assert.deepEqual(log, ['loop', 'materials', 'renderer', 'device']);
  assert.deepEqual(errors, [first, second]);
});

test('teardown waits for the renderer before destroying the device and is idempotent', async () => {
  const log: string[] = [], scope = new DisposableScope(), rendererDone = deferred<void>();
  scope.add(() => log.push('device destroyed'));
  scope.add(() => rendererDone.promise.then(() => log.push('renderer disposed')));
  scope.add(() => log.push('loop stopped'));
  const finished = scope.dispose();
  assert.equal(scope.dispose(), finished, 'second dispose joins the first');
  assert.deepEqual(log, ['loop stopped'], 'synchronous work (pagehide) is not deferred; the rest waits');
  await Promise.resolve();
  assert.deepEqual(log, ['loop stopped'], 'device survives while the renderer is still disposing');
  rendererDone.resolve();
  await finished;
  assert.deepEqual(log, ['loop stopped', 'renderer disposed', 'device destroyed']);
  await scope.dispose();
  assert.equal(log.length, 3, 'steps never run twice');
});

test('a resource acquired after disposal began is released rather than leaked, and its failure is reported', async () => {
  const log: string[] = [], late: unknown[] = [], scope = new DisposableScope(error => late.push(error));
  const pending = deferred<void>();
  scope.add(() => pending.promise);
  const finished = scope.dispose();
  assert.equal(scope.disposed, true);
  const failure = new Error('late failure');
  scope.add(() => log.push('device from a stale async request'));
  scope.add(() => { throw failure; });
  assert.deepEqual(log, [], 'not released while earlier teardown is still running');
  pending.resolve();
  await finished;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['device from a stale async request']);
  assert.deepEqual(late, [failure]);
});

test('reset disposes the previous study before constructing the next and never overlaps', async () => {
  const log: string[] = [], pending = deferred<ReturnType<typeof fakeStudy>>();
  let count = 0;
  const slot = createStudySlot(() => { log.push('create'); return count++ === 0 ? Promise.resolve(fakeStudy(log, 'a')) : pending.promise; });
  assert.equal(await slot.reset(), 'ready');
  assert.equal(nameOf(slot), 'a');
  const second = slot.reset();
  assert.equal(slot.busy, true);
  assert.equal(nameOf(slot), undefined, 'no stale study is usable while the replacement builds');
  assert.equal(await slot.reset(), 'busy');
  assert.deepEqual(log, ['create', 'dispose a', 'create'], 'a busy reset does not construct a second study');
  pending.resolve(fakeStudy(log, 'b'));
  assert.equal(await second, 'ready');
  assert.equal(nameOf(slot), 'b');
  assert.equal(slot.busy, false);
});

test('a study that finishes after close is disposed, not adopted, and later resets are refused', async () => {
  const log: string[] = [], pending = deferred<ReturnType<typeof fakeStudy>>();
  const slot = createStudySlot(() => pending.promise);
  const reset = slot.reset();
  slot.close(); slot.close();
  pending.resolve(fakeStudy(log, 'late'));
  assert.equal(await reset, 'closed');
  assert.deepEqual(log, ['dispose late']);
  assert.equal(nameOf(slot), undefined);
  assert.equal(slot.busy, false);
  assert.equal(await slot.reset(), 'closed');
  assert.deepEqual(log, ['dispose late'], 'no construction after close');
});

test('close disposes the live study exactly once', async () => {
  const log: string[] = [], slot = createStudySlot(async () => fakeStudy(log, 'live'));
  await slot.reset();
  slot.close(); slot.close();
  assert.deepEqual(log, ['dispose live']);
  assert.equal(slot.current, undefined);
});

test('a failed reset leaves an empty, retryable slot and the old study released', async () => {
  const log: string[] = [], failure = new Error('Rapier rejected a torus sector');
  let attempt = 0;
  const slot = createStudySlot(async () => {
    if (attempt++ === 1) throw failure;
    return fakeStudy(log, `s${attempt}`);
  });
  await slot.reset();
  await assert.rejects(slot.reset(), failure);
  assert.deepEqual(log, ['dispose s1']);
  assert.equal(slot.current, undefined);
  assert.equal(slot.busy, false, 'busy is cleared so the user can retry');
  assert.equal(await slot.reset(), 'ready');
  assert.equal(nameOf(slot), 's3');
});

test('a failure while disposing the old study still releases the slot for a retry', async () => {
  const failure = new Error('free failed');
  let first = true;
  const slot = createStudySlot(async () => first
    ? (first = false, { dispose() { throw failure; } })
    : { dispose() {} });
  await slot.reset();
  await assert.rejects(slot.reset(), failure);
  assert.equal(slot.busy, false);
  assert.equal(slot.current, undefined);
  assert.equal(await slot.reset(), 'ready');
});

test('fixed steps are capped per frame, remaining debt is reported as dropped and the remainder carries', () => {
  let ran = 0;
  const frame = runFixedSteps(0, 1, .25, 4, () => { ran++; });
  assert.deepEqual([ran, frame.steps, frame.accumulator, frame.droppedSeconds], [4, 4, 0, 0], '1 s at dt .25 fits exactly');
  ran = 0;
  const capped = runFixedSteps(.125, 1.25, .25, 4, () => { ran++; });
  assert.deepEqual([ran, capped.steps, capped.accumulator, capped.droppedSeconds], [4, 4, 0, .375]);
  const partial = runFixedSteps(.125, .25, .25, 4, () => {});
  assert.deepEqual([partial.steps, partial.accumulator, partial.droppedSeconds], [1, .125, 0]);
  const idle = runFixedSteps(0, .125, .25, 4, () => assert.fail('under one step of time'));
  assert.deepEqual([idle.steps, idle.accumulator], [0, .125]);
  assert.ok(!('error' in idle));
});

test('a throwing step stops the frame, reports completed steps and clears accumulated time', () => {
  const failure = new Error('recursive use of an object detected');
  let calls = 0;
  const frame = runFixedSteps(0, 1, .25, 4, () => { if (++calls === 3) throw failure; });
  assert.equal(calls, 3, 'no further steps after the failure');
  assert.deepEqual(frame, { accumulator: 0, steps: 2, droppedSeconds: 0, error: failure });
});
