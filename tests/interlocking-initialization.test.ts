import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRapierInterlocking } from '../src/comparison/interlocking-rapier.ts';

// This file runs in its own process, so the factory's module-level init cache starts empty.
test('a rejected Rapier init is shared by concurrent callers, not cached, and a later attempt recovers', async () => {
  // Rapier's frozen export cannot be patched, so the controllable boundary is WebAssembly instantiation.
  const realInstantiate = WebAssembly.instantiate, failure = new Error('wasm unavailable');
  let calls = 0, rejectInit!: (error: unknown) => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  WebAssembly.instantiate = ((...args: unknown[]) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => { rejectInit = reject; markStarted(); });
    return (realInstantiate as (...a: unknown[]) => Promise<unknown>)(...args);
  }) as typeof WebAssembly.instantiate;
  const models: Awaited<ReturnType<typeof createRapierInterlocking>>[] = [];
  try {
    const a = createRapierInterlocking(16), b = createRapierInterlocking(16);
    const settled = Promise.allSettled([a, b]);
    await started;
    assert.equal(calls, 1, 'concurrent callers share one pending init');
    rejectInit(failure);
    const results = await settled;
    for (const r of results) {
      assert.equal(r.status, 'rejected');
      assert.equal((r as PromiseRejectedResult).reason, failure, 'every caller gets the original error');
    }

    const retry = await createRapierInterlocking(16);
    models.push(retry);
    assert.equal(calls, 2, 'the rejected attempt was evicted, so a later attempt re-ran init');
    retry.step();

    models.push(await createRapierInterlocking(16));
    assert.equal(calls, 2, 'successful init is reused for later models');
  } finally {
    WebAssembly.instantiate = realInstantiate;
    for (const model of models) model.dispose();
  }
});
