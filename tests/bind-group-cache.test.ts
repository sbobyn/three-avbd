// The SDF bridge's per-step bind groups (src/avbd3d/gpu/bind-group-cache.ts), on the CPU with a
// fake device that counts createBindGroup: ping-ponged buffers make their groups once, and a
// replaced buffer makes a new one. The GPU step count is in tests-gpu/step-allocations.gpu.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BindGroupCache } from '../src/avbd3d/gpu/bind-group-cache.ts';

function fakeDevice() {
  const made: GPUBindGroupDescriptor[] = [];
  const device = { createBindGroup: (d: GPUBindGroupDescriptor) => (made.push(d), { made: made.length } as unknown as GPUBindGroup) } as unknown as GPUDevice;
  return { device, made };
}
const buffer = (name: string) => ({ name }) as unknown as GPUBuffer;
const layout = {} as GPUBindGroupLayout;

test('bind-group cache: ping-ponged buffers make two groups, then none', () => {
  const { device, made } = fakeDevice();
  const cache = new BindGroupCache(device);
  const pipeline = {};
  const [fixed, x, y] = [buffer('fixed'), buffer('x'), buffer('y')];
  const groups = new Set<GPUBindGroup>();
  for (let step = 0; step < 10; step++) groups.add(cache.get(pipeline, () => layout, step % 2 ? [fixed, x, y] : [fixed, y, x]));
  assert.equal(made.length, 2);
  assert.equal(groups.size, 2);
  assert.deepEqual(made[0].entries, [fixed, y, x].map((b, binding) => ({ binding, resource: { buffer: b } })));
});

test('bind-group cache: a replaced buffer (grown, refreshed) misses; keys keep pipelines apart', () => {
  const { device, made } = fakeDevice();
  const cache = new BindGroupCache(device);
  const [p, q] = [{}, {}];
  const [a, b, grown] = [buffer('a'), buffer('b'), buffer('a grown')];
  const first = cache.get(p, () => layout, [a, b]);
  assert.strictEqual(cache.get(p, () => layout, [a, b]), first);
  assert.notStrictEqual(cache.get(q, () => layout, [a, b]), first, 'another pipeline: its own group');
  assert.notStrictEqual(cache.get(p, () => layout, [grown, b]), first, 'a new buffer: a new group');
  assert.notStrictEqual(cache.get(p, () => layout, [a]), first, 'fewer buffers: a new group');
  assert.equal(made.length, 4);
});

test('bind-group cache: bounded, least recently used go first; clear drops all', () => {
  const { device, made } = fakeDevice();
  const cache = new BindGroupCache(device, 2);
  const p = {};
  const [a, b, c] = [buffer('a'), buffer('b'), buffer('c')];
  cache.get(p, () => layout, [a]);
  cache.get(p, () => layout, [b]);
  cache.get(p, () => layout, [a]); // a used again: b is now the oldest
  cache.get(p, () => layout, [c]); // b goes
  assert.equal(made.length, 3);
  cache.get(p, () => layout, [a]);
  assert.equal(made.length, 3, 'a kept');
  cache.get(p, () => layout, [b]);
  assert.equal(made.length, 4, 'b was dropped');
  cache.clear();
  cache.get(p, () => layout, [b]);
  assert.equal(made.length, 5);
});
