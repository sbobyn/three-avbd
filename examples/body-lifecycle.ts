// Installed projects import this same public entry from 'three-avbd'.
import { World } from '../src/lib/index.ts';

/** Call with an application-owned WebGPU device; no renderer or internal solver imports. */
export async function bodyLifecycle(device: GPUDevice) {
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0] });
  try {
    const body = world.addBox({ size: [1, 1, 1], velocity: [1, 0, 0] })!;
    world.step();
    body.setEnabled(false);
    await world.read([body]); // observes the retained GPU pose; does not step
    const paused = body.position;
    body.reset({ velocity: [2, 0, 0] });
    body.setEnabled(true);
    world.step();
    await world.read([body]);
    const resumed = body.position;
    const originalId = body.id;
    body.remove();
    const replacement = world.addSphere({ radius: .5 })!;
    return { originalId, replacementId: replacement.id, paused, resumed, stats: world.bodyStats };
  } finally { world.destroy(); }
}
