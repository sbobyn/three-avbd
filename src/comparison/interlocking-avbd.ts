// AVBD SDF counterpart of interlocking-rapier.ts, built only from the public World/SDF entry points
// and the same authored specification. The caller owns the GPU device (or renderer).
import type * as THREE from 'three/webgpu';
import { World, type Body, type Quat, type Vec3 } from '../lib/index.ts';
import { AnalyticField, collisionParams, curvatureSeeds } from '../lib/sdf.ts';
import { INTERLOCKING, ringMassProperties } from './interlocking-scene.ts';

const S = Math.SQRT1_2;
/** Analytic torus/cylinder fields have their axis along y. The ring body's principal frame (and the
 * Three.js TorusGeometry) has the torus axis along z, so the binding maps field y onto body z. */
export const FIELD_Y_TO_BODY_Z: Quat = [S, 0, 0, S];
/** Matches the Rapier peg body rotation: the cylinder's y axis turned onto world z. */
export const PEG_ROTATION: Quat = [S, 0, 0, S];
/** Matches the Rapier lower ring: a quarter turn about y, so the two rings are orthogonal and linked. */
export const LOWER_RING_ROTATION: Quat = [0, S, 0, S];
export const RING_SEED_CANDIDATES = 500;

/** Device-free description of the matched scene: every body, its collision field and binding. */
export function avbdInterlockingPlan() {
  const { majorRadius: R, minorRadius: r, friction, floor, peg, positions } = INTERLOCKING;
  const props = ringMassProperties();
  const ringField = new AnalyticField({ kind: 'torus', majorRadius: R, minorRadius: r });
  const pegField = new AnalyticField({ kind: 'cylinder', radius: peg.radius, halfHeight: peg.halfLength });
  return {
    floor: { size: floor.halfExtents.map(v => v * 2) as Vec3, position: [...floor.position] as Vec3, friction, fixed: true as const },
    // Fixed proxy box whose collision geometry is replaced by the explicit cylinder field.
    peg: { size: [2 * peg.radius, 2 * peg.halfLength, 2 * peg.radius] as Vec3, position: [...peg.position] as Vec3,
      rotation: PEG_ROTATION, friction, fixed: true as const, field: pegField },
    // Dynamic proxy boxes: mass/moments come from the shared analytic torus, not the proxy's density.
    rings: positions.map((position, i) => ({
      size: [2 * (R + r), 2 * (R + r), 2 * r] as Vec3, position: [...position] as Vec3,
      rotation: (i === 1 ? LOWER_RING_ROTATION : [0, 0, 0, 1]) as Quat, friction,
      massProperties: { mass: props.mass, moments: [props.inertia.x, props.inertia.y, props.inertia.z] as Vec3 },
    })),
    ringField, ringBindingRotation: FIELD_Y_TO_BODY_Z,
  };
}

export interface AvbdInterlockingTarget { device?: GPUDevice; renderer?: THREE.WebGPURenderer }
export interface AvbdPose { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number; w: number } }

/** Builds a fresh World on the caller's device/renderer. SDF worlds cannot reset bodies, so reset by
 * disposing this model and creating another. dispose() destroys only the World, never the device. */
export async function createAvbdInterlocking(target: AvbdInterlockingTarget) {
  if (!target.device && !target.renderer) throw new Error('Pass the caller-owned device or renderer');
  const plan = avbdInterlockingPlan();
  const clock = () => performance.now();
  let t = clock();
  plan.ringField.seeds = curvatureSeeds(plan.ringField, { candidateCount: RING_SEED_CANDIDATES });
  const seedMs = clock() - t;
  t = clock();
  const world = await World.create({ ...(target.renderer ? { renderer: target.renderer } : { device: target.device }),
    maxBodies: 4, gravity: [...INTERLOCKING.gravity] as Vec3, dt: INTERLOCKING.dt, iterations: INTERLOCKING.iterations });
  const worldMs = clock() - t;
  try {
    const added = (body: Body | null) => { if (!body) throw new Error('World refused a study body'); return body; };
    const floor = added(world.addBox(plan.floor));
    const peg = added(world.addBox({ size: plan.peg.size, position: plan.peg.position, rotation: plan.peg.rotation, friction: plan.peg.friction, fixed: true }));
    const bodies = plan.rings.map(ring => added(world.addBox(ring)));
    t = clock();
    // Floor is unassigned: World gives boxes an analytic box field of their own size.
    await world.enableSdfCollisions([{ body: peg, field: plan.peg.field },
      ...bodies.map(body => ({ body, field: plan.ringField, rotation: plan.ringBindingRotation }))]);
    const sdfSetupMs = clock() - t;
    let disposed = false;
    const live = () => { if (disposed || world.isDestroyed) throw new Error('Study disposed'); };
    const metadata = Object.freeze({
      engine: 'three-avbd', representation: 'analytic SDF torus per ring (exact tube, open centre)',
      bodies: { floor: 'fixed box, automatic analytic box field', peg: 'fixed proxy box bound to analytic cylinder field',
        rings: 'dynamic proxy box bound to analytic torus field; massProperties override' },
      ringSeeds: plan.ringField.seeds.length, seedCandidates: RING_SEED_CANDIDATES,
      collisionParams: collisionParams(), sdfCapacity: world.sdfCollisionCapacity,
      sleeping: 'not available (nativeSleeping false)', ccd: 'not available', restitution: 'not modelled', frictionCombine: 'geometric mean (all 0.5)',
      setupMs: { seeds: seedMs, worldCreate: worldMs, sdfEnable: sdfSetupMs },
      renderFrame: 'ring body frame has the torus axis on z like THREE.TorusGeometry; BodyMesh multiplies geometry by Body.size, so divide custom geometry by the proxy size',
      limits: ['Wall-clock setup observations, not a benchmark', 'Poses require asynchronous GPU readback',
        'SDF worlds cannot reset bodies: recreate for reset', 'No graphics or physical-quality acceptance implied'],
    });
    return {
      world, bodies, floor, peg, metadata,
      step() { live(); world.step(); },
      push() { live(); bodies[1].applyImpulse([...INTERLOCKING.push] as Vec3); },
      /** Reads current GPU poses for both rings; resolves with the step they belong to. */
      async readPoses(): Promise<{ step: number; poses: AvbdPose[] }> {
        live();
        const { step } = await world.read(bodies);
        return { step, poses: bodies.map(b => {
          const [x, y, z] = b.position, [qx, qy, qz, qw] = b.rotation;
          return { position: { x, y, z }, rotation: { x: qx, y: qy, z: qz, w: qw } };
        }) };
      },
      dispose() { if (!disposed) { disposed = true; world.destroy(); } },
    };
  } catch (error) { world.destroy(); throw error; }
}
