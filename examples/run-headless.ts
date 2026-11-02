// Runs a headless example (one that takes a GPUDevice and returns plain data) in the browser and
// prints its result. The examples themselves do not touch the DOM or a renderer.
import { recommendedLimits } from '../src/lib/index.ts';

export async function runHeadless(example: (device: GPUDevice) => Promise<unknown>) {
  const output = document.getElementById('output')!;
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error('WebGPU is unavailable in this browser.');
    // The application owns the device: World.create({ device }) uses it and never destroys it.
    const device = await adapter.requestDevice({ requiredLimits: await recommendedLimits() });
    try {
      const started = performance.now();
      const result = await example(device);
      output.textContent = `Finished in ${(performance.now() - started).toFixed(0)} ms\n\n${JSON.stringify(result, null, 2)}`;
    } finally {
      device.destroy();
    }
  } catch (error) {
    output.textContent = `Failed: ${String(error)}`;
    console.error(error);
  }
}
