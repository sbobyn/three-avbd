import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { releaseRenderer, requireWebGpu, startExample } from '../examples/startup.ts';

// Runs the real source of each Three.js example with fake modules, DOM and renderer: no graphics context, no GPU,
// no navigator or security change. What is asserted is what the page shows and what it releases when startup fails.

type Failure = 'none' | 'no-webgpu' | 'renderer-init' | 'world' | 'late' | 'bake' | 'release' | 'loop' | 'frame' | 'frame-release' | 'read' | 'read-late';
const EXAMPLES = ['basic', 'sdf-gear', 'sdf-hollow', 'sdf-from-mesh'] as const;

/** A value that absorbs property reads, writes, calls and `new` (not awaitable) and converts to 0, standing in for Three.js objects. */
const anything = (): any => new Proxy(function () {}, {
  get: (_, key) => key === Symbol.toPrimitive ? () => 0 : key === 'then' || typeof key === 'symbol' ? undefined : anything(),
  set: () => true, apply: () => anything(), construct: () => anything(),
});

function sourceOf(example: string) {
  return stripTypeScriptTypes(readFileSync(new URL(`../examples/${example}.ts`, import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/import\.meta\.url/g, "'file:///examples/page.ts'");
}

/** What a test can do with a started example: run the animation-loop callback it registered, or let queued work settle. */
interface Drive { frame(time?: number): void; resize(): void; flush(): Promise<void>; breakWorld(): void; rejectRead(error: Error): void; resolveRead(): void; readonly resizes: number; readonly updates: number; readonly deltas: unknown[]; readonly clocks: number }

async function run(example: typeof EXAMPLES[number], failure: Failure, drive?: (d: Drive) => Promise<void>) {
  const log: string[] = [], errors: string[] = [];
  const status = { textContent: 'Starting…', attrs: {} as Record<string, string>, setAttribute(k: string, v: string) { this.attrs[k] = v; } };
  let loop = false, frame: ((time: number) => void) | undefined, broken = failure === 'frame' || failure === 'frame-release', updates = 0, clocks = 0;
  const deltas: unknown[] = [];
  let rejectRead = (_: Error) => {}, resolveRead = () => {}, resizes = 0;
  const resizeHandlers: (() => void)[] = [];
  const releaseFails = failure === 'release' || failure === 'frame-release';
  class Renderer {
    initialized = false;
    domElement = { remove() { log.push('canvas removed'); } };
    shadowMap = {};
    async init() {
      if (failure === 'renderer-init') throw new Error('device initialization refused');
      this.initialized = true;
    }
    async dispose() { log.push('renderer disposed'); if (releaseFails) throw new Error('renderer dispose failed'); }
    setPixelRatio() {}
    setSize() { resizes++; }
    render() {}
    async setAnimationLoop(callback: ((time: number) => void) | null) {
      if (callback === null) { await Promise.resolve(); log.push('loop stopped'); loop = false; return; } // stopping is asynchronous in Three.js
      if (failure === 'loop') throw new Error('animation loop initialization refused');
      frame = callback;
      loop = true;
    }
  }
  const world = new Proxy({
    destroy() { log.push('world destroyed'); if (releaseFails) throw new Error('world destroy failed'); },
    dt: 1 / 120,
    update(dt: unknown) { updates++; deltas.push(dt); if (broken) throw new Error('device lost'); },
    step() { updates++; if (broken) throw new Error('device lost'); },
    addBox() { if (failure === 'late' || failure === 'release') throw new Error('late failure'); return anything(); },
    enableSdfCollisions: async () => {},
    read: () => failure === 'read' ? Promise.reject(new Error('readback lost'))
      : failure === 'read-late' ? new Promise<void>((resolve, reject) => { resolveRead = resolve; rejectRead = reject; }) : Promise.resolve(),
  } as Record<string, unknown>, { get: (target, key) => key in target ? target[key as string] : typeof key === 'symbol' || key === 'then' ? undefined : anything() });
  const element = () => anything();
  const context = vm.createContext({
    THREE: new Proxy({ WebGPURenderer: Renderer, Clock: class { constructor() { clocks++; } } }, { get: (t, k) => k in t ? (t as any)[k] : anything() }),
    OrbitControls: anything(), BodyMesh: anything(), mergeVertices: () => anything(), convexHull: () => anything(), AnalyticField: class { seeds = []; },
    recommendedLimits: async () => ({}), curvatureSeeds: () => [],
    World: { async create({ renderer }: { renderer: Renderer }) {
      await renderer.init();
      if (failure === 'world') throw new Error('World.create refused');
      return world;
    } },
    bakeVoxelSdfAsync: async () => { if (failure === 'bake') throw new Error('bake refused'); return { watertight: true, warnings: [], field: {} }; },
    bakeVoxelSdfInWorker: async () => { if (failure === 'bake') throw new Error('bake refused'); return { watertight: true, warnings: [], field: {} }; },
    finalizeSdf: () => ({ volume: 1, centerOfMass: [0, 0, 0], inertia: [1, 0, 0, 0, 1, 0, 0, 0, 1] }),
    principalInertia: () => ({ moments: [1, 1, 1], rotation: [0, 0, 0, 1] }),
    releaseRenderer, requireWebGpu, startExample,
    Worker: class { terminate() {} },
    navigator: failure === 'no-webgpu' ? {} : { gpu: {} },
    document: { body: { append() {} }, getElementById: (id: string) => id === 'status' ? status : element() },
    window: {}, URL, devicePixelRatio: 1, innerWidth: 800, innerHeight: 600,
    addEventListener(type: string, callback: () => void) { if (type === 'resize') resizeHandlers.push(callback); },
    removeEventListener() {}, performance, setTimeout, Error,
  });
  // startExample logs through the host console; keep the expected failures out of the test output
  // and requireWebGpu reads the host's navigator: give this process a fake one for the duration of the run
  const original = console.error, navigatorKey = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  console.error = (...a: unknown[]) => {
    const text = a.map(String).join(' ');
    if (!/ExperimentalWarning/.test(text)) errors.push(text); // Node's one-time notice about stripTypeScriptTypes can land during any run
  };
  Object.defineProperty(globalThis, 'navigator', { value: context.navigator, configurable: true, writable: true });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
  try {
    await vm.runInContext(`(async () => { ${sourceOf(example)}\n })()`, context);
    await drive?.({
      frame: (time = performance.now() + 1000) => frame!(time), flush, breakWorld: () => { broken = true; }, rejectRead: error => rejectRead(error),
      resize: () => resizeHandlers.forEach(handler => handler()), resolveRead: () => resolveRead(), get resizes() { return resizes; },
      get updates() { return updates; }, deltas, get clocks() { return clocks; },
    });
  } finally {
    console.error = original;
    if (navigatorKey) Object.defineProperty(globalThis, 'navigator', navigatorKey); else delete (globalThis as { navigator?: unknown }).navigator;
  }
  return { log, errors, status, get loop() { return loop; } };
}

for (const example of EXAMPLES) {
  test(`${example}: a successful start releases nothing and leaves the status to the page`, async () => {
    const r = await run(example, 'none');
    assert.deepEqual(r.log, []);
    assert.deepEqual(r.errors, []);
    assert.equal(r.loop, true, 'the animation loop started');
    assert.doesNotMatch(r.status.textContent, /Could not start/);
    assert.equal(r.status.attrs.role, undefined);
  });

  test(`${example}: without WebGPU it says so and creates nothing`, async () => {
    const r = await run(example, 'no-webgpu');
    assert.match(r.status.textContent, /^Could not start: WebGPU is unavailable\. Use a hardware WebGPU browser on localhost or HTTPS\.$/);
    assert.equal(r.status.attrs.role, 'alert');
    assert.deepEqual(r.log, []);
    assert.equal(r.loop, false);
  });

  test(`${example}: a renderer that fails to initialize keeps its error, is not disposed, and only its canvas is removed`, async () => {
    const r = await run(example, 'renderer-init');
    assert.match(r.status.textContent, /Could not start: .*device initialization refused/);
    assert.deepEqual(r.log, ['canvas removed']);
    assert.equal(r.loop, false);
  });

  test(`${example}: a World that fails to create leaves the initialized renderer disposed, and no world to destroy`, async () => {
    const r = await run(example, 'world');
    assert.equal(r.status.textContent, 'Could not start: World.create refused');
    assert.deepEqual(r.log, ['canvas removed', 'renderer disposed']);
  });

  test(`${example}: a failure after the World exists destroys it before the renderer`, async () => {
    const r = await run(example, 'late');
    assert.equal(r.status.textContent, 'Could not start: late failure');
    assert.deepEqual(r.log, ['world destroyed', 'canvas removed', 'renderer disposed']);
    assert.equal(r.loop, false);
  });

  test(`${example}: async animation-loop setup rejection is visible and releases the owned world and renderer`, async () => {
    const r = await run(example, 'loop');
    assert.equal(r.status.textContent, 'Could not start: animation loop initialization refused');
    assert.deepEqual(r.log, ['world destroyed', 'canvas removed', 'renderer disposed']);
    assert.equal(r.loop, false);
  });

  test(`${example}: a cleanup that throws is logged, later steps still run, and the original error stays visible`, async () => {
    const r = await run(example, 'release');
    assert.equal(r.status.textContent, 'Could not start: late failure');
    assert.deepEqual(r.log, ['world destroyed', 'canvas removed', 'renderer disposed']);
    assert.ok(r.errors.some(e => /Cleanup after failed startup:.*world destroy failed/.test(e)), r.errors.join('\n'));
    assert.ok(r.errors.some(e => /Cleanup after failed startup:.*renderer dispose failed/.test(e)), r.errors.join('\n'));
  });
}

test('basic: the loop takes its delta from the frame timestamp, capped, and never builds the deprecated THREE.Clock', async () => {
  await run('basic', 'none', async d => {
    d.frame(1000); d.frame(1016); d.frame(Number.NaN); d.frame(1032); d.frame(9000);
    await d.flush();
    assert.deepEqual(d.deltas.map(Number).map(x => Math.round(x * 1000) / 1000), [0, 0.016, 0, 0, 0.1]);
    assert.equal(d.clocks, 0);
  });
});

const STOPPED = /^Stopped: (.*)\. The simulation is no longer running; reload the page to restart\.$/;
const RELEASED = ['loop stopped', 'world destroyed', 'canvas removed', 'renderer disposed'];

for (const example of EXAMPLES) {
  test(`${example}: running frames leave the status to the page and release nothing`, async () => {
    const r = await run(example, 'none', async d => { d.frame(); d.frame(); await d.flush(); });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.log, []);
    assert.equal(r.loop, true);
    assert.doesNotMatch(r.status.textContent, /Stopped|Could not start/);
  });

  test(`${example}: a frame that throws after startup stops the loop once, says it stopped, and releases in order`, async () => {
    let updatesAfterFailure = 0;
    const r = await run(example, 'frame', async d => {
      d.frame();
      // Frames the renderer had already queued run before the asynchronous stop lands: they must do nothing
      d.frame(); d.frame();
      updatesAfterFailure = d.updates;
      await d.flush();
      d.frame();
      assert.equal(d.updates, updatesAfterFailure, 'no frame runs the simulation after the failure');
    });
    const match = STOPPED.exec(r.status.textContent);
    assert.ok(match, r.status.textContent);
    assert.equal(match[1], 'device lost', 'the original error is shown');
    assert.doesNotMatch(r.status.textContent, /Could not start/);
    assert.equal(r.status.attrs.role, 'alert');
    assert.deepEqual(r.log, RELEASED, 'the loop stops before the World and renderer are released, the canvas goes before the renderer');
    assert.equal(r.loop, false);
    assert.equal(r.errors.filter(e => /device lost/.test(e)).length, 1, `reported once: ${r.errors.join('\n')}`);
    assert.equal(r.errors.some(e => /Ignored after the example stopped/.test(e)), false);
  });

  test(`${example}: a release that fails after a frame failure is logged and the original error stays visible`, async () => {
    const r = await run(example, 'frame-release', async d => { d.frame(); await d.flush(); });
    assert.equal(STOPPED.exec(r.status.textContent)?.[1], 'device lost');
    assert.deepEqual(r.log, RELEASED);
    assert.ok(r.errors.some(e => /Cleanup after runtime failure:.*world destroy failed/.test(e)), r.errors.join('\n'));
    assert.ok(r.errors.some(e => /Cleanup after runtime failure:.*renderer dispose failed/.test(e)), r.errors.join('\n'));
  });

  test(`${example}: a queued resize after stopping does not touch the disposed renderer`, async () => {
    await run(example, 'frame', async d => {
      d.resize();
      const before = d.resizes;
      d.frame();
      await d.flush();
      d.resize(); // includes a callback already queued before its listener was removed
      assert.equal(d.resizes, before);
    });
  });
}

for (const example of ['sdf-gear', 'sdf-hollow'] as const) {
  test(`${example}: a successful readback arriving after stopping cannot replace the original error`, async () => {
    const r = await run(example, 'read-late', async d => {
      d.frame();
      d.breakWorld();
      d.frame(performance.now() + 5000);
      await d.flush();
      d.resolveRead();
      await d.flush();
    });
    assert.equal(STOPPED.exec(r.status.textContent)?.[1], 'device lost');
    assert.deepEqual(r.log, RELEASED);
  });

  test(`${example}: a rejected readback stops the example with its error instead of going unhandled`, async () => {
    const r = await run(example, 'read', async d => { d.frame(); await d.flush(); d.frame(); await d.flush(); });
    assert.equal(STOPPED.exec(r.status.textContent)?.[1], 'readback lost');
    assert.equal(r.status.attrs.role, 'alert');
    assert.deepEqual(r.log, RELEASED);
    assert.equal(r.loop, false);
  });

  test(`${example}: a readback that rejects after the example already stopped is logged, not shown or released twice`, async () => {
    const r = await run(example, 'read-late', async d => {
      d.frame(); // starts the readback, which stays pending
      d.breakWorld();
      d.frame(performance.now() + 5000); // the next frame fails (a later timestamp, so the fixed-step example owes a step)
      await d.flush();
      d.rejectRead(new Error('readback lost'));
      await d.flush();
    });
    assert.equal(STOPPED.exec(r.status.textContent)?.[1], 'device lost', 'the first error stays on screen');
    assert.deepEqual(r.log, RELEASED, 'nothing is released a second time');
    assert.ok(r.errors.some(e => /Ignored after the example stopped:.*readback lost/.test(e)), r.errors.join('\n'));
  });
}

for (const example of ['sdf-gear', 'sdf-from-mesh'] as const) {
  test(`${example}: a failed bake is reported before any World exists`, async () => {
    const r = await run(example, 'bake');
    assert.equal(r.status.textContent, 'Could not start: bake refused');
    assert.equal(r.status.attrs.role, 'alert');
    assert.ok(!r.log.includes('world destroyed'));
    assert.ok(!r.log.includes('renderer disposed'), 'a renderer that never initialized is not disposed');
    assert.equal(r.loop, false);
  });
}

test('startup cleanup runs every step in reverse order and logs, but does not show, a failing release', async () => {
  const order: string[] = [], errors: unknown[][] = [];
  const status = { textContent: '', setAttribute() {} } as unknown as HTMLElement;
  const original = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const startup = startExample(status);
    startup.own('first', v => order.push(v));
    startup.own('second', () => { order.push('second'); throw new Error('release second failed'); });
    startup.own('third', async v => { await Promise.resolve(); order.push(v); });
    await startup.fail('plain string failure');
    assert.equal(status.textContent, 'Could not start: plain string failure');
    assert.deepEqual(order, ['third', 'second', 'first']);
    assert.ok(errors.some(e => e.some(x => x instanceof Error && x.message === 'release second failed')));
    // A resource acquired while cleanup is running is still released afterwards
    startup.own('late', v => order.push(v));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(order.at(-1), 'late');
  } finally { console.error = original; }
});

test('animate: a failing frame stops the loop before anything it owns is released, once, and the first error stays shown', async () => {
  const order: string[] = [], errors: unknown[][] = [];
  const status = { textContent: '', setAttribute() {} } as unknown as HTMLElement;
  const original = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    const startup = startExample(status);
    startup.own('renderer', v => order.push(v));
    startup.own('world', async v => { await Promise.resolve(); order.push(v); throw new Error('world destroy failed'); });
    let frame: ((time: number) => void) | null = null, calls = 0;
    await startup.animate({ async setAnimationLoop(callback) { if (callback) frame = callback; else { await Promise.resolve(); order.push('loop stopped'); } } }, () => {
      calls++;
      throw new Error(`frame ${calls}`);
    });
    frame!(0); frame!(1); // a second queued frame must not run the callback or report again
    startup.guard(Promise.reject(new Error('late readback'))); // nor a rejection that lands after the first failure
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.match(status.textContent, /^Stopped: frame 1\. The simulation is no longer running/);
    assert.deepEqual(order, ['loop stopped', 'world', 'renderer']);
    assert.ok(errors.some(e => e.some(x => x instanceof Error && x.message === 'world destroy failed')), 'a failing release is logged');
    assert.ok(errors.some(e => e.some(x => x instanceof Error && x.message === 'late readback')), 'a late rejection is logged');
    assert.match(status.textContent, /frame 1/, 'the original error is not replaced by cleanup or later errors');
  } finally { console.error = original; }
});

test('animate: a loop that cannot start rejects to startup.fail() and has no loop to stop', async () => {
  const stops: unknown[] = [];
  const status = { textContent: '', setAttribute() {} } as unknown as HTMLElement;
  const original = console.error;
  console.error = () => {};
  try {
    const startup = startExample(status);
    await assert.rejects(startup.animate({ setAnimationLoop(callback) { stops.push(callback); throw new Error('refused'); } }, () => {}), /refused/);
    await startup.fail(new Error('refused'));
    assert.equal(stops.length, 1, 'only the failed start was attempted');
  } finally { console.error = original; }
});

test('releaseRenderer disposes only a renderer that finished init()', async () => {
  const log: string[] = [];
  const make = (initialized: boolean) => ({ initialized, domElement: { remove() { log.push('removed'); } }, dispose() { log.push('disposed'); } });
  assert.equal(await releaseRenderer(make(false)), undefined);
  assert.deepEqual(log, ['removed']);
  await releaseRenderer(make(true));
  assert.deepEqual(log, ['removed', 'removed', 'disposed']);
});
