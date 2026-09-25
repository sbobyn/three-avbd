// A real WebGPU device for the GPU tests, through Dawn (the `webgpu` devDependency): the same
// WGSL the browsers run, on this machine's GPU, with no browser. Without an adapter (CI, no
// GPU) `skip` holds the reason and gpuTest registers the test as skipped, never passed.
// Uncaptured device errors (WGSL compile or validation errors) fail the test.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create, globals } from 'webgpu';

Object.assign(globalThis, globals);
const errors: string[] = [];

export const { device, skip } = await (async (): Promise<{ device: GPUDevice | null; skip: string | false }> => {
  if (process.env.GPU_TESTS_SKIP) return { device: null, skip: 'GPU_TESTS_SKIP is set' };
  try {
    const gpu = create([]);
    const adapter = await gpu.requestAdapter();
    if (!adapter) return { device: null, skip: 'no WebGPU adapter available' };
    const requiredFeatures = (['timestamp-query'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
    // The solver's big scenes need more than the 128 MB default per storage binding; hull
    // contacts a ninth storage buffer per stage (GpuSolver3D.hulls)
    const requiredLimits = {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage,
    };
    const device = await adapter.requestDevice({ requiredFeatures, requiredLimits });
    // The binding's async runner can outlive these wrappers; keep them reachable
    (globalThis as { __dawn?: unknown }).__dawn = [gpu, adapter, device];
    device.onuncapturederror = (e) => errors.push(e.error.message);
    return { device, skip: false };
  } catch (e) {
    return { device: null, skip: `WebGPU unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
})();

export function gpuTest(name: string, fn: (device: GPUDevice) => Promise<void>): void {
  test(name, { skip }, async () => {
    errors.length = 0;
    await fn(device!);
    await device!.queue.onSubmittedWorkDone();
    assert.deepEqual(errors, [], 'uncaptured GPU errors');
  });
}
