import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../examples/fresh-project/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');

/** Isolated device-free consumer harness: never creates a canvas context or GPU. */
async function fixture(failure?: 'constructor' | 'world') {
  const elements: { textContent?: string }[] = [];
  const events = new Map<string, () => void>();
  const docEvents = new Map<string, () => void>();
  const deltas: number[] = [];
  const ratios: number[] = [];
  let callback: (now: number) => void = () => {};
  let draws = 0, disposed = 0, removed = 0, worldDestroyed = 0;
  const document = {
    hidden: false,
    body: { append: (element: object) => elements.push(element) },
    createElement: () => ({ style: {}, textContent: '' }),
    addEventListener: (name: string, fn: () => void) => docEvents.set(name, fn),
  };
  class Node {
    position = { set: () => {} };
    lookAt() {}
    add() {}
    updateProjectionMatrix() {}
  }
  class Renderer {
    domElement = { remove: () => { removed++; } };
    constructor() { if (failure === 'constructor') throw new Error('context refused'); }
    setPixelRatio(value: number) { ratios.push(value); }
    setSize() {}
    setAnimationLoop(fn: typeof callback) { callback = fn; }
    render() { draws++; }
    dispose() { disposed++; }
  }
  const world = {
    addBox: () => ({ applyImpulse: () => {} }), addSphere: () => ({}),
    update: (dt: number) => deltas.push(dt), destroy: () => { worldDestroyed++; },
  };
  const context = vm.createContext({
    THREE: { WebGPURenderer: Renderer, Scene: Node, Color: Node, PerspectiveCamera: Node,
      HemisphereLight: Node, MeshStandardNodeMaterial: Node },
    World: { create: async () => { if (failure === 'world') throw 'adapter refused'; return world; } },
    BodyMesh: Node, navigator: { gpu: {} }, document, window: {},
    devicePixelRatio: 4, innerWidth: 800, innerHeight: 600,
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    console: { error: () => {} },
  });
  await vm.runInContext(`(async () => { ${source}\n })()`, context);
  return { context, document, elements, events, docEvents, ratios, deltas,
    frame: (now: number) => callback(now), counts: () => ({ draws, disposed, removed, worldDestroyed }) };
}

test('consumer reports constructor failure without attempting recovery/reload', async () => {
  const f = await fixture('constructor');
  assert.match(f.elements.at(-1)!.textContent!, /AVBD could not start:.*context refused/);
  assert.equal(f.counts().disposed, 0);
  assert.equal(f.deltas.length, 0);
});

test('consumer reports non-Error init failure and retires its own renderer', async () => {
  const f = await fixture('world');
  assert.match(f.elements.at(-1)!.textContent!, /AVBD could not start: adapter refused/);
  assert.equal(f.counts().disposed, 1);
  assert.equal(f.counts().removed, 1);
  assert.equal(f.counts().worldDestroyed, 0);
});

test('consumer bounds deltas, drops hidden-tab time, and leaves scene state intact', async () => {
  const f = await fixture();
  f.frame(1000); f.frame(1016); f.frame(900); f.frame(10000);
  assert.deepEqual(f.deltas, [0, 0.016, 0, 0.1]);
  const exports = { ...f.context.window };
  f.document.hidden = true;
  f.docEvents.get('visibilitychange')!();
  f.frame(100000);
  assert.equal(f.counts().draws, 4);
  f.document.hidden = false;
  f.docEvents.get('visibilitychange')!();
  f.frame(200000); f.frame(200016); f.frame(NaN); f.frame(400000);
  assert.deepEqual(f.deltas.slice(4), [0, 0.016, 0]);
  assert.equal(f.context.window.world, exports.world);
  assert.equal(f.context.window.crate, exports.crate);
  assert.equal(f.counts().worldDestroyed, 0);
});

test('consumer resizes with bounded current DPR and handles invalid DPR', async () => {
  const f = await fixture();
  assert.equal(f.ratios[0], 2);
  for (const value of [1.5, Infinity, NaN, -1, 0, 3]) {
    f.context.devicePixelRatio = value;
    f.events.get('resize')!();
  }
  assert.deepEqual(f.ratios, [2, 1.5, 1, 1, 1, 1, 2]);
});
