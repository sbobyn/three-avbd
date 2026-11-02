// Installed projects import these same public entries from 'three-avbd' and 'three-avbd/pool'.
import { World } from '../src/lib/index.ts';
import { BodyPool } from '../src/lib/pool.ts';

/** Call with an application-owned WebGPU device: a fixed-storage World, a pool, churn. */
export async function bodyPool(device: GPUDevice) {
  const world = await World.create({ device, maxBodies: 33, storage: {
    growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } });
  try {
    world.addBox({ size: [20, 1, 20], fixed: true, position: [0, -0.5, 0] });
    const created = await BodyPool.create(world, { capacity: 32, template: { kind: 'sphere', options: { radius: 0.2, density: 1000 } } });
    if (!created.ok) throw new Error(`BodyPool.create: ${created.reason}`);
    const pool = created.pool;
    const ids: number[] = [];
    for (let round = 0; round < 4; round++) {
      const shots = [];
      for (let k = 0; k < 8; k++) {
        const shot = pool.tryAcquire({ position: [k - 4, 2, 0], rotation: [0, 0, 0, 1], velocity: [0, -2, 0] });
        if (shot.ok) { shots.push(shot.body); ids.push(shot.body.id); }
      }
      world.step(); world.step();
      for (const body of shots) pool.release(body);
    }
    await world.read();
    return { ids, stats: pool.stats, world: world.bodyStats, storageBytes: (world.storageInfo as { totalBytes?: number }).totalBytes };
  } finally { world.destroy(); }
}
