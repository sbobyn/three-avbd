import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as THREE from 'three/webgpu';
import { World } from '../src/lib/world.ts';

test('renderer initialization rejection retains cause and caller ownership', async () => {
  const failure = new Error('context creation refused');
  let disposed = false;
  const renderer = {
    init: async () => { throw failure; },
    dispose: () => { disposed = true; },
    get backend() { throw new Error('backend must not be accessed after failed init'); },
  } as unknown as THREE.WebGPURenderer;
  await assert.rejects(World.create({ renderer, maxBodies: 4 }), (error: Error) => {
    assert.match(error.message, /World.create: renderer initialization failed/);
    assert.match(error.message, /context creation refused/);
    assert.match(error.message, /WebGPU/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(disposed, false);
});

test('WebGL renderer fallback is refused before solver allocations', async () => {
  const renderer = { init: async () => {}, backend: {} } as unknown as THREE.WebGPURenderer;
  await assert.rejects(World.create({ renderer, maxBodies: 4 }), /no WebGPU device.*WebGL fallback/);
});

test('non-Error initialization rejection remains visible as a cause', async () => {
  const renderer = { init: async () => { throw 'adapter unavailable'; } } as unknown as THREE.WebGPURenderer;
  await assert.rejects(World.create({ renderer, maxBodies: 4 }), (error: Error) => {
    assert.match(error.message, /adapter unavailable/);
    assert.equal(error.cause, 'adapter unavailable');
    return true;
  });
});
