import { ContactWatch } from '../lib/contacts.ts';
import { Raycaster, type Ray } from '../lib/raycast.ts';
import RAPIER from '@dimforge/rapier3d-compat';
import { GpuSolver3D } from '../avbd3d/gpu/solver.ts';
import { B_POS, B_ROT, B_VEL, B_ANGVEL, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import { referenceFromScene, type Scene } from './scenes.ts';
import { STATE_SIZE } from './quality.ts';

export type Engine = 'rapier' | 'avbd';
export interface Settings {
  dt: number;
  avbdIterations: number;
  rapierIterations: number;
  rapierPgsIterations: number;
  rapierSleeping: boolean;
  rapierCcd: boolean;
  rapierCcdSubsteps: number;
  /** AVBD's contact margin (m); 0.01 is its default. */
  avbdMargin: number;
}
export interface Adapter {
  settings: object;
  gpuIndices?: number[];
  watchContacts?(): void;
  readContactEvents?(): Promise<number>;
  raycasts?(rays: Ray[]): Promise<(number | null)[]>;
  step(): void;
  complete(): Promise<void>;
  inspect(): Promise<object>;
  snapshot(): Promise<Float64Array>;
  destroy(): void;
}
let initialization: Promise<void> | undefined;
export async function initializeRapier(): Promise<string> {
  await (initialization ??= RAPIER.init());
  return RAPIER.version();
}
const vector = (a: number[]) => ({ x: a[0], y: a[1], z: a[2] });
const rotation = (a: number[]) => ({ ...vector(a), w: a[3] });

export async function createAdapter(engine: Engine, scene: Scene, config: Settings, device: GPUDevice, bodyBuffer?: GPUBuffer): Promise<Adapter> {
  if (engine === 'rapier') {
    await initializeRapier();
    const world = new RAPIER.World({ x: 0, y: 0, z: scene.gravity });
    world.timestep = config.dt;
    world.numSolverIterations = config.rapierIterations;
    world.numInternalPgsIterations = config.rapierPgsIterations;
    world.integrationParameters.maxCcdSubsteps = config.rapierCcdSubsteps;
    try {
      const bodies = scene.bodies.map((b) => {
        const desc = (b.mass > 0 ? RAPIER.RigidBodyDesc.dynamic() : RAPIER.RigidBodyDesc.fixed())
          .setTranslation(...b.position as [number, number, number]).setRotation(rotation(b.rotation))
          .setLinvel(...b.velocity as [number, number, number]).setAngvel(vector(b.angularVelocity))
          .setCanSleep(config.rapierSleeping).setCcdEnabled(config.rapierCcd);
        const body = world.createRigidBody(desc);
        // sqrt(mu) with Multiply gives sqrt(muA * muB), as in the AVBD shader.
        const collider = (b.shape === 'sphere' ? RAPIER.ColliderDesc.ball(b.size[0] / 2)
          : RAPIER.ColliderDesc.cuboid(b.size[0] / 2, b.size[1] / 2, b.size[2] / 2))
          .setMassProperties(b.mass, { x: 0, y: 0, z: 0 }, vector(b.inertia), { x: 0, y: 0, z: 0, w: 1 })
          .setFriction(Math.sqrt(b.friction)).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Multiply)
          .setRestitution(0);
        world.createCollider(collider, body);
        return body;
      });
      for (const j of scene.joints ?? []) {
        const joint = world.createImpulseJoint(RAPIER.JointData.spherical(vector(j.anchorA), vector(j.anchorB)),
          bodies[j.a], bodies[j.b], true);
        joint.setContactsEnabled(false);
      }
      let events: RAPIER.EventQueue | undefined;
      const p = world.integrationParameters;
      return {
        settings: { version: RAPIER.version(), package: '@dimforge/rapier3d-compat', sleeping: config.rapierSleeping,
          dt: p.dt, iterations: p.numSolverIterations, internalPgsIterations: p.numInternalPgsIterations,
          maxCcdSubsteps: p.maxCcdSubsteps, ccdRequested: config.rapierCcd, contactErp: p.contact_erp,
          allowedLinearError: p.normalizedAllowedLinearError, predictionDistance: p.normalizedPredictionDistance,
          restitution: 0, friction: 'sqrt(input) with Multiply', otherSettings: 'pinned package defaults' },
        watchContacts: () => {
          events ??= new RAPIER.EventQueue(true);
          world.forEachCollider(c => c.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS));
        },
        readContactEvents: async () => {
          let count = 0;
          events?.drainCollisionEvents(() => { count++; });
          return count;
        },
        raycasts: async (rays) => rays.map(r => {
          const direction = Array.from(r.direction);
          const length = Math.hypot(...direction);
          const hit = world.castRay(new RAPIER.Ray(vector(Array.from(r.origin)), vector(direction.map(v => v / length))),
            r.maxDistance ?? 1e30, true);
          return hit?.timeOfImpact ?? null;
        }),
        step: () => world.step(events), complete: async () => {},
        inspect: async () => ({ activeBodies: bodies.filter((b) => b.isDynamic() && !b.isSleeping()).length }),
        snapshot: async () => {
          const out = new Float64Array(bodies.length * STATE_SIZE);
          bodies.forEach((b, i) => {
            const p = b.translation(), q = b.rotation(), v = b.linvel(), w = b.angvel();
            out.set([p.x, p.y, p.z, q.x, q.y, q.z, q.w, v.x, v.y, v.z, w.x, w.y, w.z], i * STATE_SIZE);
          });
          return out;
        },
        destroy: () => { events?.free(); world.free(); },
      };
    } catch (error) { world.free(); throw error; }
  }
  const ref = referenceFromScene(scene, config.dt, config.avbdIterations);
  const n = scene.bodies.length;
  const capacity = { contacts: n * 32, manifolds: n * 8, pairs: n * 32, colors: 32 };
  const solver = new GpuSolver3D(device, ref, { bodyCapacity: n, capacity, bodyBuffer });
  solver.params.contactMargin = config.avbdMargin;
  let raycaster: Raycaster | undefined;
  let contactWatch: ContactWatch | undefined;
  let stepCount = 0;
  return {
    watchContacts: () => {
      contactWatch ??= new ContactWatch(device, solver.bodyBuffer, n, capacity.manifolds, n * 8);
      // IDs are nonzero; the harness only counts events, so manifest order + 1 will do
      contactWatch.setWatched(scene.bodies.map((_, i) => solver.gpuIndex(i)), scene.bodies.map((_, i) => i + 1), scene.bodies.map(() => true));
    },
    readContactEvents: async () => {
      if (!contactWatch) return 0;
      const result = await contactWatch.read();
      if (result.dropped || result.full) throw new Error('Contact event capacity exceeded');
      return result.events.length;
    },
    gpuIndices: scene.bodies.map((_, i) => solver.gpuIndex(i)),
    raycasts: async (rays) => {
      raycaster ??= new Raycaster(device);
      return (await raycaster.cast(solver.bodyBuffer, solver.hullStorage, solver.filterStorage, n, rays))
        .map(hit => hit?.distance ?? null);
    },
    settings: { params: { ...solver.params }, capacity, adapt: false, sleeping: false },
    step: () => {
      solver.step();
      contactWatch?.run(solver.contactStorage, solver.manifoldCapacity, ++stepCount, config.dt);
    }, complete: () => device.queue.onSubmittedWorkDone(),
    inspect: async () => {
      const c = await solver.readCounters();
      if (c.overflow || c.clashes) throw new Error(`Invalid GPU step: overflow=${c.overflow}, clashes=${c.clashes}`);
      return c;
    },
    snapshot: async () => {
      const raw = await solver.readBodies();
      const out = new Float64Array(n * STATE_SIZE);
      for (let i = 0; i < n; i++) {
        const o = solver.gpuIndex(i) * BODY_FLOATS;
        out.set([...raw.subarray(o + B_POS, o + B_POS + 3), ...raw.subarray(o + B_ROT, o + B_ROT + 4),
          ...raw.subarray(o + B_VEL, o + B_VEL + 3), ...raw.subarray(o + B_ANGVEL, o + B_ANGVEL + 3)], i * STATE_SIZE);
      }
      return out;
    },
    destroy: () => { contactWatch?.destroy(); solver.destroy(); },
  };
}
