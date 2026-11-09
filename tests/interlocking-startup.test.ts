import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { DisposableScope, createStudySlot, runFixedSteps } from '../examples/interlocking-rapier-lifecycle.ts';
import { progressLine, shouldWriteProgress } from '../examples/interlocking-progress.ts';

const source = stripTypeScriptTypes(readFileSync(new URL('../examples/interlocking-view.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\n/gm, '');

// Runs the actual page's owning startup boundary with a fake device/renderer. No graphics contexts.
// The AVBD page has no piece-count select (it describes its exact torus fields in text); the Rapier page has one.
async function fixture(failure: 'constructor' | 'init' | 'fallback', engine: 'rapier' | 'avbd' = 'rapier') {
  const elements = new Map<string, { textContent: string; disabled: boolean }>();
  const log: string[] = [];
  class Renderer {
    backend = { isWebGPUBackend: failure !== 'fallback' };
    domElement = { remove() { log.push('canvas removed'); } };
    constructor() { if (failure === 'constructor') throw new Error('context refused'); }
    async init() { if (failure === 'init') throw new Error('device initialization refused'); }
    async dispose() { log.push('renderer disposed'); }
  }
  const context = vm.createContext({
    THREE: { WebGPURenderer: Renderer }, DisposableScope, createStudySlot, runFixedSteps, progressLine, shouldWriteProgress, AbortController, Error,
    navigator: { gpu: { requestAdapter: async () => ({
      info: { vendor: 'fixture hardware', architecture: '', device: '', description: '', isFallbackAdapter: false },
      limits: { maxStorageBuffersPerShaderStage: 10 },
      requestDevice: async () => ({ lost: new Promise(() => {}), destroy() { log.push('device destroyed'); } }),
    }) } },
    document: { body: { dataset: engine === 'avbd' ? { engine } : {} }, getElementById(id: string) {
      if (engine === 'avbd' && id === 'pieces') return null;
      if (!elements.has(id)) elements.set(id, { textContent: '', disabled: false });
      return elements.get(id);
    } },
    addEventListener() {}, console: { error(...errors: unknown[]) { log.push(`unexpected: ${errors.join(' ')}`); } },
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  await new Promise(resolve => setImmediate(resolve)); // Let asynchronous reverse-order teardown finish.
  return { elements, log };
}

test('study startup reports constructor rejection and releases its newly acquired device', async () => {
  const f = await fixture('constructor');
  assert.match(f.elements.get('status')!.textContent, /Study could not start: context refused/);
  assert.deepEqual(f.log, ['device destroyed']);
  assert.equal(f.elements.get('play')!.disabled, true);
});

test('study startup preserves init error without calling dispose on an uninitialized renderer', async () => {
  const f = await fixture('init');
  assert.match(f.elements.get('status')!.textContent, /device initialization refused/);
  assert.deepEqual(f.log, ['canvas removed', 'device destroyed']);
  assert.equal(f.elements.get('reset')!.disabled, true);
});

test('study refuses actual WebGL fallback instead of attributing it to the probed WebGPU adapter', async () => {
  const f = await fixture('fallback');
  assert.match(f.elements.get('status')!.textContent, /WebGL2 fallback refused/);
  assert.deepEqual(f.log, ['renderer disposed', 'canvas removed', 'device destroyed']);
});

test('the AVBD page, which has no piece-count select, still reports a startup failure and releases the device', async () => {
  const f = await fixture('constructor', 'avbd');
  assert.match(f.elements.get('status')!.textContent, /Study could not start: context refused/);
  assert.deepEqual(f.log, ['device destroyed']);
  assert.equal(f.elements.get('play')!.disabled, true);
  assert.equal(f.elements.get('progress')!.textContent, '', 'no progress is shown for a study that did not start');
  assert.equal(f.elements.has('pieces'), false);
});

test('the Rapier page still disables its piece-count select with the other controls after a failed start', async () => {
  const f = await fixture('init');
  assert.equal(f.elements.get('pieces')!.disabled, true);
});
