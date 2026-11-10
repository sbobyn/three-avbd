// Rapier-first application code. The AVBD counterpart must reuse this authored specification.
import RAPIER from '@dimforge/rapier3d-compat';

import { INTERLOCKING, ringMassProperties, torusSectors, type RingPieces } from './interlocking-scene.ts';

let initialized: Promise<void> | undefined;
// Concurrent callers share one pending init; a rejected attempt is evicted so a later model can retry.
function initialize() {
  const attempt: Promise<void> = initialized ??= RAPIER.init().catch(error => {
    if (initialized === attempt) initialized = undefined;
    throw error;
  });
  return attempt;
}
export async function createRapierInterlocking(pieces: RingPieces = 32) {
  const sectors = torusSectors(pieces);
  await initialize();
  const world = new RAPIER.World({ x: INTERLOCKING.gravity[0], y: INTERLOCKING.gravity[1], z: INTERLOCKING.gravity[2] });
  try {
    world.timestep = INTERLOCKING.dt;
    world.numSolverIterations = INTERLOCKING.iterations;
    const floor = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...INTERLOCKING.floor.position));
    world.createCollider(RAPIER.ColliderDesc.cuboid(...INTERLOCKING.floor.halfExtents).setFriction(INTERLOCKING.friction), floor);
    const peg = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...INTERLOCKING.peg.position)
      .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 }));
    world.createCollider(RAPIER.ColliderDesc.cylinder(INTERLOCKING.peg.halfLength, INTERLOCKING.peg.radius).setFriction(INTERLOCKING.friction), peg);
    const props = ringMassProperties();
    const bodies = INTERLOCKING.positions.map((position, i) => {
      const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(position[0], position[1], position[2])
        .setCanSleep(false).setCcdEnabled(false)
        .setAdditionalMassProperties(props.mass, { x: 0, y: 0, z: 0 }, props.inertia, { x: 0, y: 0, z: 0, w: 1 });
      if (i === 1) desc.setRotation({ x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
      const body = world.createRigidBody(desc);
      for (const points of sectors) {
        const collider = RAPIER.ColliderDesc.convexHull(points);
        if (!collider) throw new Error('Rapier rejected a torus sector');
        world.createCollider(collider.setDensity(0).setFriction(INTERLOCKING.friction).setRestitution(0), body);
      }
      return body;
    });
    let disposed = false;
    return {
      world, bodies, floor, peg, pieces, version: RAPIER.version(),
      step() { if (disposed) throw new Error('Study disposed'); world.step(); },
      push() { if (disposed) throw new Error('Study disposed'); bodies[1].applyImpulse({ x: INTERLOCKING.push[0], y: 0, z: 0 }, true); },
      poses() { return bodies.map(b => ({ position: b.translation(), rotation: b.rotation() })); },
      dispose() { if (!disposed) { disposed = true; world.free(); } },
    };
  } catch (error) { world.free(); throw error; }
}
