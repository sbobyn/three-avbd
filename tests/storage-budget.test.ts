import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hullVec4s, resolveFixedStorage, scanBytes, STORAGE_FLOORS, StorageLimitError, watchSlots, type StorageLimits } from '../src/lib/storage-budget.ts';
import { worldCapabilities, deviceCapabilities } from '../src/lib/capabilities.ts';
import { convexHull } from '../src/avbd3d/hull.ts';

const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
const floor = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;

const rejects = (fn: () => unknown, resource: string) => assert.throws(fn, (e: unknown) => e instanceof StorageLimitError && e.resource === resource, resource);

test('fixed plans keep requested counts exactly and report derived sizes', () => {
  const plan = resolveFixedStorage({ maxBodies: 33 }, floor, LIMITS);
  assert.equal(plan.growth, 'fixed');
  assert.deepEqual([plan.bodies, plan.pairs, plan.contacts, plan.manifolds, plan.joints, plan.hullVec4s], [33, 4096, 8192, 4096, 256, 4096]);
  assert.deepEqual([plan.watchPairs, plan.watchEvents, plan.watchSlots, plan.retiredPerSlot], [8192, 4096, 16384, 8]);
  assert.equal(plan.colors, 64);
  assert.equal(plan.passEntries, 65);
  assert.equal(plan.staticWords, 33 + 3 * 256);
  assert.equal(plan.gridTable, 128);
  assert.equal(plan.manifoldHash, 8192);
  assert.equal(plan.buffers.bodies, 33 * 160);
  assert.equal(plan.buffers.contacts, 2 * 8192 * 64);
  assert.equal(plan.buffers.manifolds, 2 * 4096 * 32);
  assert.equal(plan.buffers.adjacency, (2 * 33 + 1 + 2 * (256 + 4096)) * 4);
  assert.equal(plan.totalBytes, Object.values(plan.buffers).reduce((a, b) => a + b, 0));
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.buffers));
  const odd = resolveFixedStorage({ maxBodies: 1000, maxContactPairs: 5, maxContactEvents: 7 }, { ...floor, pairs: 4001 * 1 + 4000, contacts: 9001, manifolds: 4097, joints: 257, hullVec4s: 4097 }, LIMITS);
  assert.deepEqual([odd.pairs, odd.contacts, odd.manifolds, odd.joints, odd.hullVec4s, odd.watchPairs, odd.watchEvents], [8001, 9001, 4097, 257, 4097, 5, 7]);
  assert.equal(odd.watchSlots, 64);
});

test('policy floors scale with bodies, and malformed counts are rejected', () => {
  assert.equal(STORAGE_FLOORS.pairs, 4096);
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, pairs: 4095 }, LIMITS), 'pairs');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, contacts: 8191 }, LIMITS), 'contacts');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, manifolds: 4095 }, LIMITS), 'manifolds');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, joints: 255 }, LIMITS), 'joints');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, hullVec4s: 4095 }, LIMITS), 'hullVec4s');
  // 4 per body above the absolute floors
  rejects(() => resolveFixedStorage({ maxBodies: 2000 }, floor, LIMITS), 'pairs');
  assert.doesNotThrow(() => resolveFixedStorage({ maxBodies: 2000 }, { ...floor, pairs: 8000, contacts: 8192 }, LIMITS));
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, manifolds: 5000 }, LIMITS), 'manifolds');
  for (const bad of [NaN, Infinity, -1, 0, 1.5, 2 ** 53, '4096' as unknown as number]) {
    rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, pairs: bad }, LIMITS), 'pairs');
  }
  rejects(() => resolveFixedStorage({ maxBodies: 0 }, floor, LIMITS), 'bodies');
  rejects(() => resolveFixedStorage({ maxBodies: 33, maxContactEvents: 0 }, floor, LIMITS), 'watchEvents');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, { ...floor, hullVec4s: 2 ** 24 }, LIMITS), 'hullOffset');
});

test('device limits: binding size (not just buffer size), dispatch width and uniform alignment', () => {
  // The contacts binding (one ping-pong half) at 8192 × 64 B = 512 KiB
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, floor, { ...LIMITS, maxStorageBufferBindingSize: 512 * 1024 - 1 }), 'binding');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, floor, { ...LIMITS, maxBufferSize: 512 * 1024 - 1 }), 'binding');
  // Contacts: 8192 / 64 = 128 workgroups; the watch's 16384 slots / 64 = 256
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, floor, { ...LIMITS, maxComputeWorkgroupsPerDimension: 255 }), 'dispatch');
  rejects(() => resolveFixedStorage({ maxBodies: 33 }, floor, { ...LIMITS, minUniformBufferOffsetAlignment: 512 }), 'alignment');
  // A big watch: its derived set table must fit a binding too
  rejects(() => resolveFixedStorage({ maxBodies: 33, maxContactPairs: 2 ** 22 }, floor, { ...LIMITS, maxStorageBufferBindingSize: 2 ** 26 }), 'binding');
});

test('derived helpers: scan levels, watch slots and hull storage', () => {
  assert.equal(scanBytes(1), 16 + 16);
  assert.equal(scanBytes(512), 16 + 16);
  // 513 elements: 2 blocks (16 B, min 4 words) then 1
  assert.equal(scanBytes(513), 2 * (16 + 16));
  assert.equal(scanBytes(512 * 512 + 1), (513 * 4 + 16) + (16 + 16) + (16 + 16));
  assert.equal(watchSlots(1), 64);
  assert.equal(watchSlots(33), 128);
  const cube = convexHull([-1, -1, -1, 1, -1, -1, -1, 1, -1, 1, 1, -1, -1, -1, 1, 1, -1, 1, -1, 1, 1, 1, 1, 1])!;
  // 2 header + 8 vertices + 2 × 6 faces + ceil(24 / 4) + 12 edges
  assert.equal(hullVec4s(cube), 2 + 8 + 12 + 6 + 12);
});

test('bodyPooling is only for fixed-storage standard worlds with built-in shaders', () => {
  const device = deviceCapabilities({ limits: { maxStorageBuffersPerShaderStage: 9 } });
  for (const backend of ['standard', 'sdf', 'custom'] as const) for (const custom of [false, true]) for (const fixed of [false, true]) {
    assert.equal(worldCapabilities(device, backend, true, custom, fixed).bodyPooling, fixed && backend === 'standard' && !custom);
  }
});
