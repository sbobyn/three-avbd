import type { SdfBroadphaseOptions } from '../avbd3d/gpu/sdf-broadphase.ts';
import type { SdfCollisionBridge } from '../avbd3d/gpu/sdf-bridge.ts';
// three-avbd's world: rigid boxes and spheres, and joints between them, simulated on the GPU by
// the AVBD solver (../avbd3d/gpu). Bodies and joints are handles; the world batches what they
// add, change and remove into the solver before its next step, and reads poses back on request
// (a readback is an async buffer copy, so it's never implicit). With a renderer, the bodies
// live in a buffer Three.js draws from directly (BodyMesh): no copies, no readback to draw.

import * as THREE from 'three/webgpu';
import { releaseStorageAttribute } from './storage.ts';
import { bodyFields, copyBodyPatch, observedField, assignBodyPatch, type BodyField, type BodyPatch } from './body-commands.ts';
import { deviceCapabilities, worldCapabilities, checkRequiredHulls, type WorldCapabilities } from './capabilities.ts';
import { BodyReset } from '../avbd3d/gpu/body-reset.ts';
import { BodyDisabledError, BodyLifecycleError, UnsupportedLifecycleError, checkEnabled, resetBodyPatch } from './lifecycle.ts';
import { BodyMover } from '../avbd3d/gpu/body-mover.ts';
import { B_ANGVEL, B_POS, B_ROT, B_VEL, BODY_FLOATS, BODY_DISABLED, BODY_COLD } from '../avbd3d/gpu/layout.ts';
import { decodeJoint, type JointState } from '../avbd3d/gpu/joints.ts';
import { checkBreakBend, GpuSolver3D, gpuParams3D, unitRotation, type GpuCounters3D, type GpuStepOptions } from '../avbd3d/gpu/solver.ts';
import { Rigid } from '../avbd3d/ref/body.ts';
import { Solver } from '../avbd3d/ref/solver.ts';
import { convexHull, hull, type HullShape, sphere } from '../avbd3d/shapes.ts';
import { BodyIds, RetiredBodies, assertOwner, sameReadStep, orderedEvents } from './identity.ts';
import { BEGIN, ContactWatch } from './contacts.ts';
import { addImpulse, noPush, Pusher, type Pushes } from './push.ts';
import { type Ray, Raycaster } from './raycast.ts';
import { resolveFixedStorage, StorageCapacityError, type FixedStoragePlan, type WorldStorageOptions } from './storage-budget.ts';
import { AnalyticField, type Field } from '../avbd3d/ref/sdf/shapes.ts';
import { snapshotSdfField } from '../avbd3d/gpu/sdf-snapshot.ts';
import type { CollisionParams } from '../avbd3d/ref/sdf/manifold.ts';

export type Vec3 = [number, number, number];
/** A unit quaternion, x y z w (as THREE.Quaternion's toArray). */
export type Quat = [number, number, number, number];

/** Experimental SDF in the body's COM/principal-axis frame; inertia and rendering stay caller-owned. */
export interface SdfBodyBinding { body: Body; field: Field; scale?: number; /** Field frame to body principal frame. */ rotation?: Quat }
export type StepOptions = GpuStepOptions;

export interface WorldOptions {
  /** Share the renderer's GPU device, so BodyMesh can draw the bodies with no copies. */
  renderer?: THREE.WebGPURenderer;
  /** Or a device of your own (headless: Node with Dawn, tests, workers). */
  device?: GPUDevice;
  /** Room for this many bodies at once (removed bodies' slots are reused). */
  maxBodies: number;
  /** Reject before World GPU allocations unless the supplied device supports true convex hull collisions. */
  requireHulls?: boolean;
  /** m/s², y-up by default. */
  gravity?: Vec3;
  /** Seconds per step. */
  dt?: number;
  /** Solver iterations per step: more is stiffer and costs more. */
  iterations?: number;
  /** Contact events: pairs touching at once with a body that reports contacts (default 8192). */
  maxContactPairs?: number;
  /** Contact events kept between readbacks; more are dropped (default 4096). */
  maxContactEvents?: number;
  /**
   * Solver storage: grows on demand (default), or `growth: 'fixed'` with explicit capacities,
   * checked against the device before anything is allocated and never grown afterwards (what
   * body pools need: three-avbd/pool). A fixed World stays on built-in standard collisions.
   */
  storage?: WorldStorageOptions;
}

/** A body's starting state: where it is, how it's turned, how it moves. */
export interface BodyState {
  position?: Vec3;
  rotation?: Quat;
  velocity?: Vec3;
  angularVelocity?: Vec3;
}

export interface BodyOptions extends BodyState {
  /** Retain this life and GPU state without integration, collisions or rays. Default true. */
  enabled?: boolean;
  /** Override geometric density integration: mass in kg and principal moments in kg m².
   * Body rotation and rendering must use this principal frame. Fixed bodies stay static. */
  massProperties?: { mass: number; moments: Vec3 };
  /** kg/m³ (a 1 m cube of density 1 weighs 1 kg). */
  density?: number;
  friction?: number;
  /** Never moves (the ground, walls): infinite mass. */
  fixed?: boolean;
  /**
   * Collision groups (bitmasks, 32 groups): the groups it's in, and the groups it collides with.
   * Two bodies collide when each is in a group the other collides with. Default: in group 1,
   * colliding with every group.
   */
  group?: number;
  collidesWith?: number;
  /** Report when it starts and stops touching other bodies (World.onContact). */
  reportContacts?: boolean;
}

export interface BoxOptions extends BodyOptions {
  /** Full widths along the box's own axes (m). */
  size: Vec3;
}

export interface SphereOptions extends BodyOptions {
  radius: number;
}

/**
 * A convex hull: of `points` (x, y, z each: a mesh's vertices, say), or a `shape` made once with
 * convexHull and shared by many bodies. `position` and `rotation` place the points' own frame (as
 * you'd place the mesh they came from); the body itself sits at the hull's centre of mass, turned
 * to its principal axes (its `position` and `rotation` from then on).
 */
export interface HullOptions extends BodyOptions {
  points?: ArrayLike<number>;
  shape?: HullShape;
}

/** Where a ray first meets a body. */
export interface RayHit {
  /** The original body at submission, possibly since removed/disabled. Check alive/enabled before acting. */
  body: Body | null;
  /** How far along the ray (m): 0 when it starts inside the body. */
  distance: number;
  point: Vec3;
  /** The surface's outward normal there (against the ray when it starts inside). */
  normal: Vec3;
}

export interface RaycastOptions {
  /** Default: as far as it goes. */
  maxDistance?: number;
  /** Bodies it passes through (at most 16: the caster's own, say). */
  ignore?: Body[];
  /** Only bodies in these collision groups (a bitmask). Default: all. */
  collidesWith?: number;
}

export interface JointOptions {
  /** Where the joint holds, in each body's own frame (m). */
  anchorA?: Vec3;
  anchorB?: Vec3;
  /**
   * 'fixed' (the default): the bodies hold together as one. 'ball': they hold together at the
   * anchors but turn freely about them (ball and socket).
   */
  type?: 'fixed' | 'ball';
  /**
   * The force that breaks the joint, at least 0: it limits the angular force of its angle lock
   * (the number `Joint.force.angular` says: the torque over its torque arm), as in the paper, or
   * with `breakOnPull` its pull too. None: it never breaks.
   *
   * On a joint that yields (`yieldForce`) a breakForce above the yield only catches a sudden jump
   * of its torque: a joint that gives is cut back to its yield every iteration, so a load that
   * keeps bending it never asks more than that, and a joint set up so (finite `breakForce` above
   * `yieldForce`, no `breakOnPull`, no `breakBend`) warns once. To have a sustained overload tear
   * a plastic joint, use `breakBend` (how far it has bent) or `breakOnPull`.
   */
  breakForce?: number;
  /**
   * Also break on the joint's pull: `breakForce` then limits |λ_lin| as well, the force holding
   * its two anchors together, in **newtons** (a 1 kg box hanging from it pulls 9.81). It is one
   * number for both: choose it for the pull (a joint carrying a weight is what this is for), and
   * the angular force then breaks the joint at that same value.
   */
  breakOnPull?: boolean;
  /**
   * The turn a fixed joint holds between its bodies: b's orientation in a's frame (x, y, z, w),
   * so it holds b = a·rest, whatever frames the bodies have. Default: none, the bodies'
   * rotations held equal (which twists two bodies placed turned apart until they match).
   *
   * 'current' takes the turn the bodies have as the world knows it: their rotations as of the
   * last readback (`await world.read()`), or as set since (when added, `Body.set`). It does not
   * look at the GPU, so **the bodies must not have moved since that readback**: after steps
   * they may have fallen and turned, and the joint would hold the turn they had at the readback.
   * Read first, or add the joint before the bodies move.
   */
  rest?: Quat | 'current';
  /**
   * A fixed joint that bends: past this angular force (measured as `breakForce` is, so below it)
   * the joint gives, carries no more than this, and keeps the bend: a hinge that stays bent once
   * the load is gone, a beam that sags under a weight for good. None: it never yields. A joint
   * that gives is cut back every iteration, so `breakForce` on its torque seldom sees more than
   * this: to have a heavy load tear it too, add `breakBend` or `breakOnPull`.
   */
  yieldForce?: number;
  /**
   * How far a plastic joint may bend before it breaks (rad, 0 to π): the turn from the rest it
   * was made with to the one it holds now, which `Joint.bend` says. It is how a sustained
   * overload tears a joint that yields, which `breakForce` can't (see there): a load that keeps
   * bending it takes it past the limit, and it breaks then (a lighter one bends it less, and it
   * holds). A bend is at most π, so a larger limit could never be reached and `addJoint` throws
   * for it. Needs `yieldForce`: a joint that can't give can't bend. None (or Infinity): it never
   * breaks on its bend.
   */
  breakBend?: number;
}

export interface SpringOptions {
  /** Where the spring is fixed on each body, in its own frame (m). */
  anchorA?: Vec3;
  anchorB?: Vec3;
  /** N/m. */
  stiffness: number;
  /** Its length at rest (m). Default: how far apart the anchors are when it's added. */
  rest?: number;
}

/**
 * Two bodies starting or stopping touching, one of them reporting contacts. A begin says where
 * (the contact points' average), the normal (from b towards a) and how hard: the normal impulse
 * of the step they met in (N·s; a landing's is about its mass times its speed).
 */
export interface ContactEvent {
  type: 'begin' | 'end';
  a: Body;
  b: Body;
  point: Vec3;
  normal: Vec3;
  impulse: number;
  /** The step it happened in (World.stepCount). */
  step: number;
}

/** Steps between the solver's storage checks (contacts, pairs and colours grow as needed). */
const ADAPT_EVERY = 10;
/** Where removed bodies are parked, far from anything (a slot per body, so none overlap). */
const PARK = 1e5;

const DEFAULTS = { density: 1, friction: 0.5 };

/** q scaled to unit length. */
function normalised(q: ArrayLike<number>): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/** The quaternion product a·b (b first, then a), x y z w. */
function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** The turn from a to b, a⁻¹·b: the rest of a joint holding two bodies as they are. */
function relativeRotation(a: ArrayLike<number>, b: ArrayLike<number>): Quat {
  return normalised(multiply([-a[0], -a[1], -a[2], a[3]], b));
}

/** v turned by the unit quaternion q (x, y, z, w). */
function rotate(q: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  // t = 2 (u × v); v + w t + u × t
  const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
}

export interface ReadResult { step: number }

/**
 * @internal A reservation of body slots (a BodyPool's): the indices it owns, which of them are
 * vacant, and the live bodies in the rest. Ordinary adds never take its slots.
 */
export interface Reservation {
  readonly capacity: number;
  readonly indices: readonly number[];
  readonly vacant: number[];
  readonly live: Set<Body>;
  /** The solver hull it pins for its leases, or null. */
  readonly hull: HullShape | null;
  state: 'active' | 'disposed';
}

/** @internal Why World.reserveBodies could not reserve. */
export type ReserveFailure = 'capacity' | 'unsupported-backend' | 'resource-limit' | 'fixed-storage-required';

export class Body {
  /** Nonzero lifetime identity in this World; never reused (1..0x7fffffff). */
  readonly id: number;
  readonly world: World;
  /** The body's slot in the GPU buffer (for custom shaders): stable for its life. */
  readonly index: number;
  readonly shape: 'box' | 'sphere' | 'hull';
  /** A hull body's shape (its vertices and faces in the body's own frame). */
  readonly hull: HullShape | null;
  /** Full widths (a sphere's: its diameter on every axis; a hull's: its bounds on its principal axes). */
  readonly size: Vec3;
  readonly density: number;
  readonly massProperties?: Readonly<{ mass: number; moments: Readonly<Vec3> }>;
  readonly friction: number;
  /** @internal */
  state: Required<BodyState>;
  /** @internal The world's write count when this body was last written. */
  written = 0;
  /** @internal Per-field assignments, so late reads can update other fields. */
  revisions: Record<BodyField, number> = { position: 0, rotation: 0, velocity: 0, angularVelocity: 0 };
  /** @internal The first step it's in. */
  addedAt = 0;
  private reports: boolean;
  private groups: number;
  private mask: number;
  private isFixed: boolean;
  private isAlive = true;
  /** @internal CPU desired state, never a cached GPU pose. */
  enabledState = true;
  /** @internal Last known own observation, frozen before parking/reuse. */
  frozen: Required<BodyState> | null = null;
  /** @internal The shape the solver collides it as (a pool's private copy for pooled hulls). */
  solverHull: HullShape | null;
  /** @internal The reservation (pool) its slot belongs to; never changes for this handle. */
  owner: Reservation | null = null;

  /** @internal Made by World.addBox / addSphere. */
  constructor(world: World, index: number, shape: 'box' | 'sphere' | 'hull', size: Vec3, options: BodyOptions, hullShape: HullShape | null = null) {
    if (options.massProperties) {
      const { mass, moments } = options.massProperties;
      if (!Array.isArray(moments) || moments.length !== 3 || ![mass, ...moments].every(v => Math.fround(v) > 0 && Number.isFinite(Math.fround(v)))) throw new Error('Mass and principal moments must be finite and positive');
      this.massProperties = Object.freeze({ mass, moments: Object.freeze([...moments] as Vec3) });
    }
    this.world = world;
    this.enabledState = options.enabled ?? true;
    this.id = world.allocateBodyId();
    this.index = index;
    this.shape = shape;
    this.hull = hullShape;
    this.solverHull = hullShape;
    this.size = size;
    this.density = options.density ?? DEFAULTS.density;
    this.friction = options.friction ?? DEFAULTS.friction;
    this.isFixed = options.fixed ?? false;
    this.groups = options.group ?? 1;
    this.mask = options.collidesWith ?? 0xffffffff;
    this.reports = options.reportContacts ?? false;
    this.state = {
      position: options.position ?? [0, 0, 0],
      rotation: options.rotation ?? [0, 0, 0, 1],
      velocity: options.velocity ?? [0, 0, 0],
      angularVelocity: options.angularVelocity ?? [0, 0, 0],
    };
  }

  get enabled(): boolean { return this.alive && !this.world.isDestroyed && this.enabledState; }
  setEnabled(enabled: boolean): void { this.world.setEnabled(this, enabled); }
  reset(state: BodyState = {}): void { this.world.resetBody(this, state); }

  get fixed(): boolean {
    return this.isFixed;
  }
  /** Its collision groups, and the groups it collides with (bitmasks). */
  get group(): number {
    return this.groups;
  }
  get collidesWith(): number {
    return this.mask;
  }

  /** Put it in other collision groups (from the next step). */
  setCollisionGroups(group: number, collidesWith: number = this.mask): void {
    this.world.assertLive('Body.setCollisionGroups');
    this.groups = group;
    this.mask = collidesWith;
    this.world.refilter(this);
  }
  /** Whether it reports its contacts (World.onContact), from the next step. */
  get reportContacts(): boolean {
    return this.reports;
  }
  set reportContacts(on: boolean) {
    this.world.assertLive('Body.reportContacts');
    this.reports = on;
    this.world.rewatch(this);
  }
  get alive(): boolean {
    return this.isAlive;
  }

  /** As of the last readback (World.read), or as last set if set since. */
  get position(): Vec3 {
    return this.world.stateOf(this, B_POS, 3) as Vec3;
  }
  get rotation(): Quat {
    return this.world.stateOf(this, B_ROT, 4) as Quat;
  }
  get velocity(): Vec3 {
    return this.world.stateOf(this, B_VEL, 3) as Vec3;
  }
  get angularVelocity(): Vec3 {
    return this.world.stateOf(this, B_ANGVEL, 3) as Vec3;
  }

  /**
   * Move it, turn it or set it moving (from the next step). What's left out keeps its value
   * on the GPU. Its contacts start afresh.
   */
  set(state: BodyState): void {
    this.world.assertLive('Body.set');
    const patch = copyBodyPatch(state);
    if (!Object.keys(patch).length || !this.alive) return;
    this.world.write(this, patch);
  }

  /**
   * Move a fixed body (a platform, a door, a hand) to a new pose over the next update's steps:
   * it slides there, pushing and carrying what it touches (call it every frame to animate it).
   * A moving body is set there instead (set: its contacts start afresh). For a fixed body that
   * keeps moving (a conveyor, a turntable), set its velocity: set({ velocity, angularVelocity }).
   */
  moveTo(position: Vec3, rotation?: Quat): void {
    this.world.assertLive('Body.moveTo');
    if (!this.isAlive) return;
    if (!this.isFixed) return this.set({ position, rotation });
    if (!this.enabled) throw new BodyDisabledError();
    const patch = copyBodyPatch({ position, rotation });
    this.world.move(this, patch.position as Vec3, patch.rotation as Quat | undefined);
  }

  /** @internal Where a moved fixed body is going (consumed only by simulation steps). */
  target: { position: Vec3; rotation?: Quat } | null = null;

  /** Pin it where it is (fixed) or let it go. */
  setFixed(fixed: boolean): void {
    this.world.assertLive('Body.setFixed');
    if (fixed === this.isFixed) return;
    if (!this.alive) return;
    this.isFixed = fixed;
    this.world.write(this, { velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }, true);
  }

  /** A push (N·s) at a point in the world (none: through its centre of mass), at the next step. */
  applyImpulse(impulse: Vec3, point?: Vec3): void {
    this.world.assertLive('Body.applyImpulse');
    if (this.isAlive) addImpulse(this.world.pushesOf(this, false), impulse, point);
  }

  /** A twist (N·m·s, about world axes through its centre of mass), at the next step. */
  applyAngularImpulse(impulse: Vec3): void {
    this.world.assertLive('Body.applyAngularImpulse');
    if (this.isAlive) this.world.pushesOf(this, false).moment.forEach((_, a, m) => (m[a] += impulse[a]));
  }

  /** A force (N) at a point in the world (none: through its centre of mass), every step until clearForces. */
  applyForce(force: Vec3, point?: Vec3): void {
    this.world.assertLive('Body.applyForce');
    if (this.isAlive) addImpulse(this.world.pushesOf(this, true), force, point);
  }

  /** A torque (N·m, about world axes through its centre of mass), every step until clearForces. */
  applyTorque(torque: Vec3): void {
    this.world.assertLive('Body.applyTorque');
    if (this.isAlive) this.world.pushesOf(this, true).moment.forEach((_, a, m) => (m[a] += torque[a]));
  }

  /** Stop the forces and torques applied to it. */
  clearForces(): void {
    this.world.assertLive('Body.clearForces');
    this.world.clearForces(this);
  }

  /** Take it out of the world, with its joints. Its slot is reused by later adds. */
  remove(): void {
    if (!this.isAlive) return;
    this.world.assertMutableTopology();
    this.isAlive = false;
    this.world.removeBody(this);
  }
}

/** What World makes a Joint from: a joint's options (with its rest turn worked out), or a spring's. */
interface JointInit {
  spring?: boolean;
  anchorA?: Vec3;
  anchorB?: Vec3;
  type?: 'fixed' | 'ball';
  breakForce?: number;
  breakOnPull?: boolean;
  restRotation?: Quat;
  yieldForce?: number;
  breakBend?: number;
  stiffness?: number;
  /** A spring's rest length. */
  restLength?: number;
}

export class Joint {
  readonly world: World;
  readonly a: Body;
  readonly b: Body;
  readonly type: 'fixed' | 'ball' | 'spring';
  readonly anchorA: Vec3;
  readonly anchorB: Vec3;
  readonly breakForce: number;
  readonly breakOnPull: boolean;
  /** The turn a fixed joint holds when added (JointOptions.rest): b = a·restRotation. null: none. */
  readonly restRotation: Quat | null;
  /** The angular force past which a fixed joint yields (JointOptions.yieldForce). */
  readonly yieldForce: number;
  /** How far (rad) a plastic joint bends before it breaks (JointOptions.breakBend). */
  readonly breakBend: number;
  /** A spring's stiffness (N/m) and rest length (m). */
  readonly stiffness: number;
  readonly rest: number;
  /** @internal The solver's joint slot (-1 until the next step adds it). */
  slot = -1;
  /**
   * @internal The order it was placed in the solver in (World.flush): 1 for the first joint. A
   * readback speaks only for the joints placed before it began: a later joint may sit in the slot
   * of one removed since, where the readback holds that joint's record.
   */
  placed = 0;
  private state: 'held' | 'broken' | 'removed' = 'held';
  private pull = 0;
  private torque = 0;
  private bent = 0;

  /** @internal Made by World.addJoint and addSpring. */
  constructor(world: World, a: Body, b: Body, options: JointInit) {
    this.world = world;
    this.a = a;
    this.b = b;
    this.type = options.spring ? 'spring' : (options.type ?? 'fixed');
    this.anchorA = options.anchorA ?? [0, 0, 0];
    this.anchorB = options.anchorB ?? [0, 0, 0];
    this.breakForce = options.spring ? Infinity : (options.breakForce ?? Infinity);
    this.breakOnPull = options.breakOnPull ?? false;
    this.restRotation = options.restRotation ?? null;
    this.yieldForce = options.yieldForce ?? Infinity;
    this.breakBend = options.breakBend ?? Infinity;
    this.stiffness = options.stiffness ?? Infinity;
    this.rest = options.restLength ?? 0;
  }

  /**
   * What the joint carries, as of the last readback that read joints (World.readJoints; World.read
   * does when any joint can break or yield): `linear`, the force (N) holding its anchors together,
   * and `angular`, the angular force of a fixed joint, the number `breakForce` and `yieldForce`
   * limit. Zero before the first such readback, once it breaks, and for ball joints and springs
   * (a ball joint has no angle lock; a spring's force is its stiffness times its stretch).
   */
  get force(): { linear: number; angular: number } {
    return { linear: this.pull, angular: this.torque };
  }

  /**
   * How far a plastic joint has bent for good (rad): the turn between the rest it holds now and
   * the one it started with, as of the last readback that read joints (the number `breakBend`
   * limits). Zero for a joint that never yielded.
   */
  get bend(): number {
    return this.bent;
  }

  /** @internal It can break by itself, so a readback looks for it. */
  get breakable(): boolean {
    return this.breakForce < Infinity || this.breakBend < Infinity;
  }

  /** @internal The decoded record of a readback. */
  update(state: JointState): void {
    this.pull = state.linear;
    this.torque = state.angular;
    this.bent = state.bend;
  }

  /** It broke (seen at a readback: World.read). */
  get broken(): boolean {
    return this.state === 'broken';
  }
  /** Holding but neither endpoint may participate until both are enabled. */
  get suspended(): boolean { return this.holding && (!this.a.enabled || !this.b.enabled); }
  /** Still holding. */
  get holding(): boolean {
    return this.state === 'held';
  }

  /** Let go of the two bodies (they collide with each other again). */
  remove(): void {
    if (this.state !== 'held') return;
    this.world.assertLive('Joint.remove');
    this.state = 'removed';
    this.world.removeJoint(this);
  }

  /** @internal Seen broken at a readback. */
  markBroken(): void {
    this.state = 'broken';
  }
}

/**
 * The device limits the solver makes use of, as high as this machine's GPU goes: pass them to
 * the renderer (new WebGPURenderer({ requiredLimits: await recommendedLimits() })) so hulls
 * collide as hulls and big worlds fit. Empty without WebGPU.
 */
export async function recommendedLimits(): Promise<Record<string, number>> {
  const adapter = typeof navigator !== 'undefined' ? await navigator.gpu?.requestAdapter() : null;
  if (!adapter) return {};
  const { maxStorageBuffersPerShaderStage, maxStorageBufferBindingSize, maxBufferSize } = adapter.limits;
  return { maxStorageBuffersPerShaderStage, maxStorageBufferBindingSize, maxBufferSize };
}

export class World {
  /** The solver underneath (three-avbd/advanced): its parameters, buffers and counters. */
  readonly solver: GpuSolver3D;
  readonly device: GPUDevice;
  /** The bodies' buffer as a Three.js attribute (with a renderer): what BodyMesh draws from. */
  readonly bodyAttribute: THREE.StorageInstancedBufferAttribute | null;
  readonly maxBodies: number;
  /** The most fixed steps `update` runs in one call (time owed past them is dropped: no spiral). */
  maxSubsteps = 4;
  /** Keep a readback going every this many steps (0: only on request, World.read). */
  readbackEvery = 0;

  private readonly slots: (Body | null)[] = [];
  /** Unowned reusable slots (a reservation's vacant slots are on its own list). */
  private readonly free: number[] = [];
  /** Full records past the solver's count, by index − bodyCount (null: a vacant reserved slot). */
  private appends: (Body | null)[] = [];
  /** Full records for slots already in the solver, by slot (null: a vacant reserved slot). */
  private readonly rewrites = new Map<number, Body | null>();
  /** Reservation owning each slot (null: ordinary). */
  private readonly owners: (Reservation | null)[] = [];
  private readonly reservations = new Set<Reservation>();
  /** Vacant reserved slots whose parked, disabled, filterless metadata goes to the GPU next flush. */
  private readonly vacancies = new Set<number>();
  /** Fixed storage: hulls pinned when an ordinary hull body is added (its room is checked then). */
  private readonly hullPins = new Map<Body, HullShape>();
  private readonly fixed: FixedStoragePlan | null;
  private readonly patches = new Map<Body, { fields: Set<BodyField>; fixed: boolean }>();
  private mover: BodyMover | null = null;
  private resetter: BodyReset | null = null;
  private readonly resets = new Set<Body>();
  private readonly lifecycleDirty = new Set<Body>();
  private readonly coldBodies = new Set<Body>();
  private pendingJoints: Joint[] = [];
  private readonly joints = new Set<Joint>();
  /** Joints placed in the solver so far (Joint.placed). */
  private placements = 0;
  /** The kinds of warning already given (warnOnce). */
  private readonly warned = new Set<string>();
  private readonly scratch = new Solver();
  private readonly breakListeners = new Set<(joint: Joint) => void>();
  private readonly contactListeners = new Set<(event: ContactEvent) => void>();
  private contactWatch: ContactWatch | null = null;
  /** A watch replaced by a larger one (contact set overflow): its unread events go with the next read. */
  private retiredWatch: ContactWatch | null = null;
  /** Pairs to resize the watch to before the next step (0: none). */
  private contactGrowTo = 0;
  private contactOverflows = 0;
  /** Slots whose contact-report word goes to the GPU next flush (their occupant, or none). */
  private readonly rewatches = new Set<number>();
  private readonly reporting = new Set<Body>();
  /** The pass ran last step (so it runs once more when the last reporting body goes, for the ends). */
  private contactsLive = false;
  private droppedEvents = 0;
  private readonly bodyIds = new BodyIds();
  private readonly retiredBodies = new RetiredBodies<Body>();
  private readonly contactOptions: { pairs: number; events: number };
  /** Bodies whose collision groups go to the GPU at the next step (every new body, so a reused slot's are reset). */
  private readonly refilters = new Set<number>();
  /** Fixed bodies moved (moveTo) since the last step, and those still sliding there (steps left). */
  private readonly moves = new Set<Body>();
  private readonly sliding = new Map<Body, number>();
  /** Steps the current update is running (moveTo spreads a move over them). */
  private stepsThisUpdate = 1;
  /** Impulses for the next step, and forces for every step (per body, summed). */
  private readonly impulses = new Map<Body, Pushes>();
  private readonly forces = new Map<Body, Pushes>();
  private readonly pusher: Pusher;
  private raycaster: Raycaster | null = null;
  /** The last readback of each body's record, and the write count it was issued at (-1: never read). */
  private readonly snapshot: Float32Array;
  private readonly readAt: Float64Array;
  /** Which bodies the automatic readback reads (World.track; null: all). */
  private tracked: Body[] | null = null;
  private writes = 0;
  private steps = 0;
  private owed = 0;
  private reading: Promise<ReadResult> | null = null;
  /** What the read in flight holds: every body (null) or these slots, as of this write count. */
  private readingSlots: Set<number> | null = null;
  private readingWrites = 0;
  private readingStep = 0;
  /** The next read reads the joints (readJoints). */
  private jointsWanted = false;
  private adapting = false;
  private liveVersion = 0;
  private sdfBridge: SdfCollisionBridge | null = null;
  private sdfBindings=new Map<Body,{field:Field;scale?:number;rotation?:Quat}>();
  private sdfBroadphase:SdfBroadphaseOptions={};
  private sdfDirty=false;
  private sdfError:Error|null=null;
  private sdfState: 'off' | 'preparing' | 'on' = 'off';
  private destroyed = false;
  private gpuError: Error | null = null;
  private readonly storageReleases = new Set<() => void>();
  private readonly renderer: THREE.WebGPURenderer | undefined;

  /** Make a world: `World.create` (async, it may need the renderer's device). */
  private constructor(device: GPUDevice, options: WorldOptions, attribute: THREE.StorageInstancedBufferAttribute | null, buffer: GPUBuffer | undefined, fixed: FixedStoragePlan | null) {
    this.device = device;
    this.renderer = options.renderer;
    this.maxBodies = options.maxBodies;
    this.bodyAttribute = attribute;
    this.fixed = fixed;
    this.solver = new GpuSolver3D(device, this.scratch, { bodyBuffer: buffer, bodyCapacity: options.maxBodies, ...(fixed ? { fixed } : {}) });
    this.solver.lifecyclePending = () => this.resets.size > 0 || this.lifecycleDirty.size > 0;
    Object.assign(this.solver.params, gpuParams3D(), { dt: options.dt ?? 1 / 60, iterations: options.iterations ?? 10 });
    this.gravity = options.gravity ?? [0, -9.81, 0];
    this.contactOptions = { pairs: options.maxContactPairs ?? 8192, events: options.maxContactEvents ?? 4096 };
    let pusher: Pusher | undefined;
    try {
      this.pusher = pusher = new Pusher(device, this.solver.bodyBuffer, fixed ? fixed.bodies : undefined);
      // Fixed: every helper made now, at full size, so no step or command allocates later
      // (the ray pipeline too; each raycast still makes its own buffers and bind group)
      if (fixed) {
        this.raycaster = new Raycaster(device);
        this.mover = new BodyMover(device, this.solver.bodyBuffer, this.maxBodies);
        this.resetter = new BodyReset(device, this.solver.bodyBuffer, this.maxBodies);
        this.contactWatch = new ContactWatch(device, this.solver.bodyBuffer, this.maxBodies, this.contactOptions.pairs, this.contactOptions.events);
        this.contactWatch.prewarm(this.solver.contactStorages());
      }
    } catch (error) {
      for (const helper of [this.contactWatch, this.resetter, this.mover]) helper?.destroy();
      pusher?.destroy();
      this.solver.destroy();
      throw error;
    }
    this.snapshot = new Float32Array(options.maxBodies * BODY_FLOATS);
    this.readAt = new Float64Array(options.maxBodies).fill(-1);
    // A shared device may outlive many worlds. Its pending lost promise must not retain them.
    const weak = new WeakRef(this);
    void device.lost.then(info => {
      const world = weak.deref();
      if (world && !world.destroyed) world.gpuError ??= new Error(`WebGPU device lost (${info.reason}): ${info.message}. Recreate the device and World.`);
    });
  }

  static async create(options: WorldOptions): Promise<World> {
    if (!Number.isSafeInteger(options.maxBodies) || options.maxBodies <= 0) throw new Error('World.create: maxBodies must be a positive safe integer');
    const growth = options.storage?.growth ?? 'adaptive';
    if (growth !== 'adaptive' && growth !== 'fixed') throw new Error(`World.create: storage.growth must be 'adaptive' or 'fixed', not ${String(growth)}`);
    // Checked against the device's negotiated limits before any attribute or buffer is made
    const plan = (device: GPUDevice) => options.storage?.growth === 'fixed' ? resolveFixedStorage(options, options.storage, device.limits) : null;
    if (options.renderer) {
      const renderer = options.renderer;
      await renderer.init();
      const backend = renderer.backend as unknown as {
        device?: GPUDevice;
        createStorageAttribute(attribute: THREE.BufferAttribute): void;
        get(object: object): { buffer?: GPUBuffer };
      };
      if (!backend.device) throw new Error('World.create: the renderer has no WebGPU device (WebGPU unavailable, or the WebGL fallback in use)');
      checkRequiredHulls(deviceCapabilities(backend.device), options.requireHulls);
      const fixed = plan(backend.device);
      // The attribute's buffer, made now on the renderer's device, so the solver writes the very
      // buffer Three.js draws from (it would otherwise be made at the first draw)
      const attribute = new THREE.StorageInstancedBufferAttribute(new Float32Array(options.maxBodies * BODY_FLOATS), 4);
      try {
        backend.createStorageAttribute(attribute);
        const buffer = backend.get(attribute).buffer;
        if (!buffer) throw new Error('World.create: Three.js made no GPU buffer for the bodies');
        const world = new World(backend.device, options, attribute, buffer, fixed);
        world.ownStorageAttribute(attribute);
        return world;
      } catch (error) {
        releaseStorageAttribute(renderer, attribute);
        throw error;
      }
    }
    if (!options.device) throw new Error('World.create: pass a renderer or a device');
    checkRequiredHulls(deviceCapabilities(options.device), options.requireHulls);
    return new World(options.device, options, null, undefined, plan(options.device));
  }

  /** Snapshot of the installed backend; old snapshots do not change after SDF/custom transitions.
   * During asynchronous SDF preparation, this describes the previously installed backend.
   * Advanced custom backends have unknown shape support. */
  get capabilities(): Readonly<WorldCapabilities> {
    const backend = this.solver.activeCollisionBackend;
    return worldCapabilities(deviceCapabilities(this.device), backend ? backend === this.sdfBridge ? 'sdf' : 'custom' : 'standard', this.solver.hulls, this.solver.customShaders, this.fixed !== null && !this.destroyed && !this.gpuError);
  }

  /** The resolved storage plan: every fixed capacity and buffer size, or adaptive growth. */
  get storageInfo(): Readonly<FixedStoragePlan> | Readonly<{ growth: 'adaptive' }> {
    return this.fixed ?? Object.freeze({ growth: 'adaptive' as const });
  }

  // --- Parameters ------------------------------------------------------------------------------

  /** m/s² (the solver keeps it as up and a size: GpuParams3D.up, gravity). */
  get gravity(): Vec3 {
    const { up, gravity } = this.solver.params;
    return [up[0] * gravity, up[1] * gravity, up[2] * gravity];
  }
  set gravity(g: Vec3) {
    const size = Math.hypot(g[0], g[1], g[2]);
    const p = this.solver.params;
    p.gravity = -size;
    if (size > 0) p.up = [-g[0] / size, -g[1] / size, -g[2] / size];
  }
  get dt(): number {
    return this.solver.params.dt;
  }
  set dt(dt: number) {
    this.solver.params.dt = dt;
  }
  get iterations(): number {
    return this.solver.params.iterations;
  }
  set iterations(n: number) {
    this.solver.params.iterations = n;
  }

  /** Experimental spatial SDF collisions. Unassigned boxes/spheres
   * use analytic fields. Fields replace collision geometry only, not mass, inertia or meshes.
   * Automatic GPU bounds/mask/joint filtering; no per-frame pose readback.
   * Contact events aggregate per pair; raycasts query the SDF surface (bounded batches).
   */
  async enableSdfCollisions(bindings: readonly SdfBodyBinding[] = [], params: Partial<CollisionParams> = {}, broadphase: SdfBroadphaseOptions = {}): Promise<void> {
    if(this.destroyed || this.sdfState!=='off') throw new Error('SDF collisions already enabled/preparing, or World destroyed');
    if(this.fixed) throw new Error("SDF collisions need an adaptive-storage World: this one has storage.growth 'fixed'");
    this.solver.assertBackendSwitchAllowed();
    await this.installSdfCollisions(bindings,params,broadphase);
  }
  /** Apply new/replacement fields and commit body additions/removals. Omitted live bindings persist. */
  async updateSdfCollisions(bindings:readonly SdfBodyBinding[]=[],broadphase:SdfBroadphaseOptions={}):Promise<void> {
    if(this.destroyed||this.sdfState!=='on'||!this.sdfBridge)throw new Error('SDF collisions must be enabled and not preparing');
    await this.installSdfCollisions(bindings,{...this.sdfBridge.params},{...this.sdfBroadphase,...broadphase});
  }
  private async installSdfCollisions(bindings:readonly SdfBodyBinding[],params:Partial<CollisionParams>,broadphase:SdfBroadphaseOptions):Promise<void> {
    const previous=this.sdfBridge, options={...broadphase}, collision={...params};
    this.sdfState='preparing';
    try {
      if(options.maxPairs!==undefined&&(!Number.isSafeInteger(options.maxPairs)||options.maxPairs<1))throw new Error('Invalid SDF broadphase pair capacity');
      const assigned=new Map([...this.sdfBindings].filter(([body])=>body.alive));
      const seen=new Set<Body>(), snapshots=new Map<Field,Field>();
      for(const binding of bindings) {
        if(binding.body.world!==this || !binding.body.alive || seen.has(binding.body)) throw new Error('Invalid or duplicate SDF body binding');
        seen.add(binding.body);
        let field=snapshots.get(binding.field);
        if(!field){field=snapshotSdfField(binding.field,collision.meshVertexContacts);snapshots.set(binding.field,field);}
        assigned.set(binding.body,{field,scale:binding.scale,rotation:binding.rotation ? normalised(binding.rotation) : undefined});
      }
      this.flush();
      if(!this.solver.bodyCount)throw new Error('SDF collisions require at least one allocated body slot');
      const vacant=new AnalyticField({kind:'sphere',radius:.05});
      const retained:boolean[]=[],dead:number[]=[];
      const fields=Array.from({length:this.solver.bodyCount},(_,i)=>{
        const body=this.slots[i];
        retained.push(!!body&&assigned.has(body)&&assigned.get(body)===this.sdfBindings.get(body));
        if(!body){dead.push(i);return {field:vacant};}
        let binding=assigned.get(body);
        if(!binding) {
          if(body.shape==='sphere')binding={field:new AnalyticField({kind:'sphere',radius:body.size[0]/2})};
          else if(body.shape==='box')binding={field:new AnalyticField({kind:'box',halfExtents:body.size.map(v=>v/2) as Vec3})};
          else throw new Error('SDF mode requires an explicit field for each hull in its principal-axis frame');
          assigned.set(body,binding);
        }
        return binding;
      });
      const {SdfCollisionBridge}=await import('../avbd3d/gpu/sdf-bridge.ts');
      if(this.destroyed)throw new Error('World destroyed during SDF setup');
      const {sdfBroadphaseOptions}=await import('../avbd3d/gpu/sdf-broadphase.ts');
      // Size new topology normally, but never truncate the old compact history.
      const capacity=sdfBroadphaseOptions(this.device,fields,options).maxPairs;
      const setupOptions=previous?{...options,maxPairs:Math.max(capacity,previous.capacity)}:options;
      if(this.destroyed)throw new Error('World destroyed during SDF setup');
      const bridge=await SdfCollisionBridge.createAutomatic(this.solver,fields,collision,setupOptions);
      try {
        if(this.destroyed)throw new Error('World destroyed during SDF setup');
        if(previous)bridge.inheritHistory(previous,retained);
        if(dead.length)this.solver.setFilters(dead,dead.map(()=>0),dead.map(()=>0));
        this.solver.setCollisionBackend(bridge);this.sdfBridge=bridge;
        this.sdfBindings=assigned;this.sdfBroadphase=options;this.sdfDirty=false;this.sdfError=null;
      } catch(error){bridge.destroy();throw error;}
    } finally {this.sdfState=this.sdfBridge?'on':'off';}
  }
  /** Diagnostic readback; caller must avoid stepping/refresh while it is pending. */
  async readSdfResults() {
    this.assertSdfReady();
    if (!this.sdfBridge) throw new Error('SDF collisions are not enabled');
    return this.sdfBridge.readResults();
  }
  get sdfCollisionsEnabled(): boolean {return this.sdfBridge!==null&&!this.destroyed;}
  get sdfCollisionsNeedUpdate():boolean {return this.sdfDirty;}
  get sdfCollisionCapacity():number {return this.sdfBridge?.capacity??0;}
  /** Last automatic growth failure; explicit adaptation/update rejects instead. */
  get sdfCollisionError():Error|null {return this.sdfError;}
  /** Read counters and grow candidate/history buffers without a pose/contact readback. */
  async adaptSdfCollisions(read?:GpuCounters3D):Promise<boolean> {
    const bridge=this.sdfBridge;
    if(this.destroyed||!bridge||this.sdfState!=='on'||this.sdfDirty)return false;
    const counters=read??await this.solver.readCounters();
    if(this.destroyed||this.sdfBridge!==bridge||this.sdfState!=='on'||this.sdfDirty)return false;
    if(counters.pairs<=bridge.capacity)return false;
    const next=bridge.grown(counters.pairs);
    try {this.solver.setCollisionBackend(next);this.sdfBridge=next;this.sdfError=null;}
    catch(error){next.destroy();throw error;}
    return true;
  }
  disableSdfCollisions(): void {
    if(this.sdfState==='preparing')throw new Error('Await SDF setup before disabling it');
    if(this.sdfBridge)this.solver.setCollisionBackend(null);
    this.sdfBridge=null;this.sdfState='off';this.sdfBindings.clear();this.sdfDirty=false;this.sdfError=null;
  }
  /** @internal Mutations are staged while enabled; updateSdfCollisions commits their fields. */
  assertMutableTopology(): void {
    this.assertLive('adding or removing bodies');
    if(this.sdfState==='preparing')throw new Error('Await SDF setup before adding or removing bodies');
  }
  /** @internal Stepping, reading, queries and topology changes need the GPU buffers destroy() frees. */
  assertLive(what: string): void {
    if (this.destroyed) throw new Error(`World destroyed: ${what} after destroy()`);
    if (this.gpuError) throw this.gpuError;
  }

  get isDestroyed(): boolean { return this.destroyed; }

  /** Device loss or an automatic GPU read failure. Stop using this world and recreate it. */
  get error(): Error | null { return this.gpuError; }

  /** @internal Release mesh storage on geometry disposal or world destruction, in either order. */
  ownStorageAttribute(attribute: THREE.StorageInstancedBufferAttribute): () => void {
    this.assertLive('creating render storage');
    const renderer = this.renderer;
    if (!renderer) throw new Error('World has no renderer');
    const release = () => {
      if (!this.storageReleases.delete(release)) return;
      releaseStorageAttribute(renderer, attribute);
    };
    this.storageReleases.add(release);
    return release;
  }
  private assertSdfReady():void {
    if(this.sdfState==='preparing'||this.sdfDirty)throw new Error('Await updateSdfCollisions before stepping or querying changed SDF bodies');
  }

  // --- Bodies ----------------------------------------------------------------------------------

  /** Add a box; null when the world is full (maxBodies). */
  addBox(options: BoxOptions): Body | null {
    return this.add('box', options.size, options);
  }

  /** Add a sphere; null when the world is full (maxBodies). */
  addSphere(options: SphereOptions): Body | null {
    const d = 2 * options.radius;
    return this.add('sphere', [d, d, d], options);
  }

  /**
   * Add a convex hull (of points, or a shape from convexHull); null when the world is full. It
   * collides as a hull where the device allows (World.hullsEnabled), else as its bounding box.
   */
  addHull(options: HullOptions): Body | null {
    this.assertLive('addHull');
    const shape = options.shape ?? (options.points ? convexHull(options.points) : null);
    if (!shape) throw new Error('addHull: no hull (pass a shape, or points that aren\'t flat or all in one place)');
    // The points' frame placed as asked; the body at the centre of mass, on the principal axes
    const q = options.rotation ?? [0, 0, 0, 1];
    const p = options.position ?? [0, 0, 0];
    const c = rotate(q, shape.center);
    const position: Vec3 = [p[0] + c[0], p[1] + c[1], p[2] + c[2]];
    const rotation = multiply(q, shape.rotation);
    const body = this.add('hull', shape.size, { ...options, position, rotation }, shape);
    if (body && this.capabilities.hullCollisions === 'box-fallback') this.warnOnce('hull-fallback', 'addHull: this GPUDevice supports only bounding-box hull collisions; use requireHulls: true to reject this fallback at World.create');
    return body;
  }

  /** Whether hulls collide as hulls (the device allows a ninth storage buffer per shader stage). */
  get hullsEnabled(): boolean {
    return this.solver.hulls;
  }

  /** @internal */
  allocateBodyId(): number { return this.bodyIds.allocate(); }

  private add(shape: 'box' | 'sphere' | 'hull', size: Vec3, options: BodyOptions, hullShape: HullShape | null = null): Body | null {
    this.assertMutableTopology();
    if (options.enabled !== undefined) checkEnabled(options.enabled);
    if (options.enabled === false) this.assertLifecycle();
    const initial: BodyPatch = {};
    for (const field of bodyFields) if (options[field]) initial[field] = [...options[field]!];
    options = { ...options, ...initial } as BodyOptions;
    // A removed body's slot first, else the next one past the end (past any reserved tail)
    const index = this.free.length ? this.free[this.free.length - 1] : this.solver.bodyCount + this.appends.length;
    if (index >= this.maxBodies) return null;
    // Fixed storage: the hull's room is taken now (or refused) rather than at the next flush
    const pin = this.fixed && hullShape && this.solver.hulls ? hullShape : null;
    if (pin) this.solver.pinHull(pin);
    let body: Body;
    try {
      body = new Body(this, index, shape, [size[0], size[1], size[2]], options, hullShape);
    } catch (error) {
      if (pin) this.solver.unpinHull(pin);
      throw error;
    }
    if (pin) this.hullPins.set(body, pin);
    if (this.free.length) this.free.pop();
    this.occupy(body);
    return body;
  }

  /** Put a new body in its (free) slot: its full record, filters and report word go next flush. */
  private occupy(body: Body): void {
    const index = body.index;
    this.slots[index] = body;
    this.vacancies.delete(index);
    body.written = ++this.writes;
    for (const field of bodyFields) body.revisions[field] = body.written;
    body.addedAt = this.steps + 1;
    this.rewatches.add(index);
    // A slot freed since the last step: its parking write is superseded. Reuse an unflushed slot
    // in place; appending twice would shift GPU body IDs.
    this.stage(index, body);
    this.refilters.add(index);
    if (!body.enabledState) this.lifecycleDirty.add(body);
    if(this.sdfBridge)this.sdfDirty=true;
    this.liveVersion++;
  }

  /** A full record for a slot at the next flush (null: a vacant reserved slot's). */
  private stage(index: number, body: Body | null): void {
    if (index >= this.solver.bodyCount) this.appends[index - this.solver.bodyCount] = body;
    else this.rewrites.set(index, body);
  }

  /** The body's full record is staged (so later field writes ride on it). */
  private staged(body: Body): boolean {
    const i = body.index;
    return i >= this.solver.bodyCount ? this.appends[i - this.solver.bodyCount] === body : this.rewrites.get(i) === body;
  }

  // --- Reservations (three-avbd/pool) ------------------------------------------------------------

  /**
   * @internal Reserve `capacity` slots (free holes first, then the tail) and pin `hull`, all or
   * nothing, before any body or ID exists. Ordinary adds never take reserved slots.
   */
  reserveBodies(capacity: number, hull: HullShape | null): Reservation | ReserveFailure {
    this.assertLive('BodyPool.create');
    if (!this.fixed) return 'fixed-storage-required';
    if (this.sdfState !== 'off' || this.solver.activeCollisionBackend || this.solver.customShaders) return 'unsupported-backend';
    if (hull && !this.solver.hulls) return 'resource-limit';
    // Hull room held by removed bodies' records is freed when their parking writes are flushed
    if (hull && !this.solver.canPinHull(hull)) this.flush();
    const tail = this.maxBodies - (this.solver.bodyCount + this.appends.length);
    if (this.free.length + tail < capacity) return 'capacity';
    if (hull && !this.solver.canPinHull(hull)) return 'resource-limit';
    if (hull) this.solver.pinHull(hull);
    const indices: number[] = [];
    while (indices.length < capacity && this.free.length) indices.push(this.free.pop()!);
    while (indices.length < capacity) {
      indices.push(this.solver.bodyCount + this.appends.length);
      this.appends.push(null);
    }
    const reservation: Reservation = { capacity, indices: Object.freeze(indices), vacant: [...indices].reverse(), live: new Set(), hull, state: 'active' };
    for (const index of indices) {
      this.owners[index] = reservation;
      // A hole's parking write (if any) becomes the vacant record
      this.stage(index, null);
      this.vacancies.add(index);
      this.rewatches.add(index);
    }
    this.reservations.add(reservation);
    return reservation;
  }

  /**
   * @internal Submit a new reservation's vacant records (with whatever else is queued) and wait
   * for the GPU, checking for errors. A failure after submission invalidates the World.
   */
  async prewarmReservation(reservation: Reservation): Promise<void> {
    const device = this.device;
    device.pushErrorScope('out-of-memory');
    device.pushErrorScope('validation');
    try {
      this.flush();
    } catch (error) {
      // Pop the scopes anyway; nothing awaits them on this path
      void Promise.all([device.popErrorScope(), device.popErrorScope()]).catch(() => undefined);
      throw error;
    }
    const scopes = Promise.all([device.popErrorScope(), device.popErrorScope()]);
    const [errors] = await Promise.all([scopes, device.queue.onSubmittedWorkDone()]);
    const error = errors.find(e => e);
    if (error && !this.destroyed) this.gpuError ??= new Error(`three-avbd: GPU error preparing a body pool: ${error.message}. Recreate the World.`);
    if (this.destroyed || this.gpuError || reservation.state !== 'active') throw this.gpuError ?? new Error('World destroyed during BodyPool.create');
  }

  /** @internal A fresh enabled body in one of the reservation's vacant slots (or why not). */
  acquireReserved(reservation: Reservation, shape: 'box' | 'sphere' | 'hull', size: Vec3, options: BodyOptions, publicHull: HullShape | null): Body | 'capacity' | 'id-exhausted' | 'disposed' {
    if (reservation.state !== 'active' || this.destroyed || this.gpuError) return 'disposed';
    if (!reservation.vacant.length) return 'capacity';
    if (this.bodyIds.remaining < 1) return 'id-exhausted';
    const index = reservation.vacant[reservation.vacant.length - 1];
    const body = new Body(this, index, shape, [size[0], size[1], size[2]], { ...options, enabled: true }, publicHull);
    reservation.vacant.pop();
    body.solverHull = reservation.hull ?? publicHull;
    body.owner = reservation;
    reservation.live.add(body);
    this.occupy(body);
    return body;
  }

  /**
   * @internal Remove the reservation's live bodies and give its slots back to ordinary use, then
   * its hull pin. Idempotent; after destroy or device loss only the bookkeeping is dropped.
   */
  releaseReservation(reservation: Reservation): void {
    if (reservation.state !== 'active') return;
    const usable = !this.destroyed && !this.gpuError;
    if (usable) for (const body of [...reservation.live]) body.remove();
    reservation.state = 'disposed';
    reservation.live.clear();
    reservation.vacant.length = 0;
    this.reservations.delete(reservation);
    if (!usable) return;
    for (const index of reservation.indices) {
      this.owners[index] = null;
      this.free.push(index);
    }
    // Leases' records keep their solver references until their parking writes at the next flush
    if (reservation.hull) this.solver.unpinHull(reservation.hull);
  }

  /** The bodies in the world, in slot order. */
  get bodies(): Body[] {
    return this.slots.filter((b): b is Body => b !== null && b !== undefined);
  }

  /** Capacity is storage occupancy, not a dispatch or whole-engine GPU memory budget. */
  get bodyStats() {
    const bodies = this.bodies;
    const enabled = bodies.filter(body => body.enabled).length;
    let reserved = 0, reservedAvailable = 0, pooled = 0;
    for (const r of this.reservations) { reserved += r.capacity; reservedAvailable += r.vacant.length; pooled += r.live.size; }
    const ordinary = bodies.length - pooled;
    return Object.freeze({ capacity: this.maxBodies, live: bodies.length, enabled, disabled: bodies.length - enabled,
      available: this.maxBodies - ordinary - reserved, reserved, reservedAvailable,
      allocatedSlots: this.solver.bodyCount + this.appends.length, remainingBodyIds: this.bodyIds.remaining });
  }

  private assertLifecycle(body?: Body): void {
    this.assertLive('body lifecycle');
    if (body) {
      assertOwner(this, body);
      if (!body.alive) throw new BodyLifecycleError('Body was removed');
    }
    if (this.sdfState === 'preparing' || !this.capabilities.bodyActivation) throw new UnsupportedLifecycleError();
  }

  /** @internal Body lifecycle commands are validated atomically before CPU intent changes. */
  setEnabled(body: Body, enabled: boolean): void {
    checkEnabled(enabled);
    this.assertLifecycle(body);
    if (body.enabledState === enabled) return;
    body.enabledState = enabled;
    body.written = ++this.writes;
    this.coldBodies.add(body);
    this.lifecycleDirty.add(body);
    this.liveVersion++;
  }

  /** @internal Reset uses current GPU pose; explicit fields keep ordinary last-write ordering. */
  resetBody(body: Body, state: BodyState): void {
    this.assertLifecycle(body);
    const patch = resetBodyPatch(state);
    this.write(body, patch);
    this.impulses.delete(body);
    this.forces.delete(body);
    this.resets.add(body);
    this.coldBodies.add(body);
    this.lifecycleDirty.add(body);
    // New/reused full records also need explicit reset velocities restored AFTER the pass.
    const pending = this.patches.get(body) ?? { fields: new Set<BodyField>(), fixed: false };
    for (const field of bodyFields) if (patch[field]) pending.fields.add(field);
    this.patches.set(body, pending);
  }

  /** Bumped whenever bodies come or go (BodyMesh redraws its list then). */
  get version(): number {
    return this.liveVersion;
  }

  /** @internal Body.set / setFixed: merge masked assignments for the next flush. */
  write(body: Body, patch: BodyPatch, fixed = false): void {
    assertOwner(this, body);
    if (!body.alive) return;
    if (this.sliding.has(body)) patch = { velocity: [0, 0, 0], angularVelocity: [0, 0, 0], ...patch };
    this.moves.delete(body);
    this.sliding.delete(body);
    body.target = null;
    body.written = ++this.writes;
    assignBodyPatch(body.state, body.revisions, patch, body.written);
    if (this.staged(body)) return;
    const pending = this.patches.get(body) ?? { fields: new Set<BodyField>(), fixed: false };
    for (const field of bodyFields) if (patch[field]) pending.fields.add(field);
    pending.fixed ||= fixed;
    this.patches.set(body, pending);
  }

  /** @internal Body.remove: its joints go, and it's parked out of the way. */
  removeBody(body: Body): void {
    assertOwner(this, body);
    this.assertMutableTopology();
    body.frozen = { position: body.position, rotation: body.rotation, velocity: body.velocity, angularVelocity: body.angularVelocity };
    this.resets.delete(body);
    this.lifecycleDirty.delete(body);
    this.coldBodies.delete(body);
    for (const j of [...this.joints, ...this.pendingJoints]) if (j.a === body || j.b === body) j.remove();
    this.patches.delete(body);
    this.moves.delete(body);
    this.sliding.delete(body);
    body.target = null;
    this.impulses.delete(body);
    this.forces.delete(body);
    this.slots[body.index] = null;
    this.retiredBodies.retire(body, this.steps);
    this.reporting.delete(body);
    this.rewatches.add(body.index);
    const pin = this.hullPins.get(body);
    // Its record keeps the solver's reference until the parking write below is flushed
    if (pin) { this.hullPins.delete(body); this.solver.unpinHull(pin); }
    // Parked: fixed, small, far off, a slot of space each
    body.state = { position: [PARK + 2 * body.index, PARK, PARK], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    body.written = ++this.writes;
    const owner = body.owner;
    if (owner && owner.state === 'active' && this.owners[body.index] === owner) {
      // Back to its pool, as a vacant record: parked, disabled, no filters or report word
      owner.live.delete(body);
      owner.vacant.push(body.index);
      this.vacancies.add(body.index);
      this.stage(body.index, null);
    } else {
      this.free.push(body.index);
      this.stage(body.index, body);
    }
    if(this.sdfBridge)this.sdfDirty=true;
    this.liveVersion++;
  }

  // --- Joints ----------------------------------------------------------------------------------

  /**
   * Join two bodies at their anchors, rigidly or (type 'ball') free to turn, until (optionally) it
   * breaks. A rigid joint holds the bodies' rotations equal unless told another turn to hold
   * (`rest`), and can bend for good under load (`yieldForce`), and break once it has bent too far
   * (`breakBend`).
   */
  addJoint(a: Body, b: Body, options: JointOptions = {}): Joint {
    this.checkPair(a, b, 'addJoint');
    const { rest, yieldForce, breakBend, ...others } = options;
    if (options.type === 'ball' && (rest !== undefined || yieldForce !== undefined || breakBend !== undefined)) {
      throw new Error("addJoint: a ball joint has no angle lock to hold a turn or to bend: 'rest', 'yieldForce' and 'breakBend' are for fixed joints");
    }
    if (yieldForce !== undefined && !(yieldForce >= 0)) throw new Error(`addJoint: yieldForce is a force of at least 0, not ${yieldForce}`);
    if (breakBend !== undefined) {
      checkBreakBend(breakBend, 'addJoint');
      if (breakBend < Infinity && !(yieldForce !== undefined && yieldForce < Infinity)) throw new Error('addJoint: breakBend limits how far a plastic joint bends: it needs a yieldForce');
    }
    const breakForce = options.breakForce ?? Infinity;
    if (!(breakForce >= 0)) throw new Error(`addJoint: breakForce is a force of at least 0, not ${breakForce}`);
    // The turn to hold: as given, or as the bodies are (by the poses the world knows). Everything
    // is checked here, at the call: a joint the solver would refuse must never wait in the queue
    const restRotation =
      rest == null ? undefined
      : rest === 'current' ? unitRotation(relativeRotation(a.rotation, b.rotation), "addJoint: rest 'current' (from the bodies' rotations)")
      : unitRotation(rest, 'addJoint: rest');
    // Joints that will not do what their options say, for joints that are made
    if (yieldForce !== undefined && yieldForce < Infinity && breakForce < Infinity) {
      if (yieldForce >= breakForce) {
        this.warnOnce('never yields', `addJoint: yieldForce (${yieldForce}) is not below breakForce (${breakForce}), so the joint breaks before it can yield and never bends: lower yieldForce, or raise breakForce`);
      } else if (!options.breakOnPull && !(breakBend !== undefined && breakBend < Infinity)) {
        this.warnOnce('sudden jumps only', `addJoint: breakForce (${breakForce}) is above yieldForce (${yieldForce}), and a joint that yields is cut back to its yield every iteration: it breaks only on a sudden jump of its torque, never under a sustained overload. Add breakBend (the bend, in radians, past which it breaks) or breakOnPull (breakForce then limits its pull too, in newtons) to have a load tear it`);
      }
    }
    this.checkJointRoom();
    const joint = new Joint(this, a, b, { ...others, restRotation, yieldForce, breakBend });
    this.pendingJoints.push(joint);
    return joint;
  }

  /** A spring between two bodies' anchors, pulling (or pushing) them towards its rest length. */
  addSpring(a: Body, b: Body, options: SpringOptions): Joint {
    this.checkPair(a, b, 'addSpring');
    const anchorA = options.anchorA ?? [0, 0, 0];
    const anchorB = options.anchorB ?? [0, 0, 0];
    // At rest where it's added, unless told otherwise
    const at = (body: Body, anchor: Vec3) => {
      const r = rotate(body.rotation, anchor);
      const p = body.position;
      return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
    };
    const [pa, pb] = [at(a, anchorA), at(b, anchorB)];
    const rest = options.rest ?? Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]);
    this.checkJointRoom();
    const spring = new Joint(this, a, b, { anchorA, anchorB, stiffness: options.stiffness, restLength: rest, spring: true });
    this.pendingJoints.push(spring);
    return spring;
  }

  /** Warn about how joints are set up, once per world however many joints are (a scene adds hundreds). */
  private warnOnce(kind: string, message: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(`three-avbd: ${message}`);
  }

  /** Fixed storage: a joint slot for one more joint, counting those placed and those queued. */
  private checkJointRoom(): void {
    const used = this.pendingJoints.length + this.joints.size;
    if (this.fixed && used >= this.fixed.joints) throw new StorageCapacityError('joints', used + 1, this.fixed.joints);
  }

  private checkPair(a: Body, b: Body, what: string): void {
    this.assertLive(what);
    assertOwner(this, a);
    assertOwner(this, b);
    if (!a.alive || !b.alive) throw new Error(`${what}: both bodies must be in the world`);
  }

  /** Called with each joint seen broken (at a readback). Returns a function that unsubscribes. */
  onBreak(listener: (joint: Joint) => void): () => void {
    this.breakListeners.add(listener);
    return () => this.breakListeners.delete(listener);
  }

  /**
   * Called with each contact event (bodies starting or stopping touching, one of them with
   * reportContacts), in step order, when a readback lands (World.read or readbackEvery).
   * Returns a function that unsubscribes.
   */
  onContact(listener: (event: ContactEvent) => void): () => void {
    this.contactListeners.add(listener);
    return () => this.contactListeners.delete(listener);
  }

  /** Contact events lost since the world began, for want of room between readbacks (maxContactEvents). */
  get droppedContactEvents(): number {
    return this.droppedEvents;
  }

  /**
   * Readbacks that found the contact pair set had overflowed since the one before: more pairs
   * touching a reporting body at once than maxContactPairs allowed for. Those readbacks' events
   * are unreliable (pairs left out read as beginning or ending again). The world then resizes
   * the sets, up to the solver's pair capacity and the device's binding limit, before the next
   * step; the resize starts the sets afresh, so pairs already touching then begin again, and a
   * pair that stops touching at that step reports no end.
   */
  get contactSetOverflows(): number {
    return this.contactOverflows;
  }

  /** @internal Body.reportContacts. */
  rewatch(body: Body): void {
    assertOwner(this, body);
    if (body.alive) this.rewatches.add(body.index);
  }

  /** @internal Joint.remove. */
  removeJoint(joint: Joint): void {
    if (joint.slot < 0) {
      this.pendingJoints = this.pendingJoints.filter((j) => j !== joint);
      return;
    }
    this.joints.delete(joint);
    this.solver.releaseJoints([joint.slot]);
  }

  // --- Stepping ----------------------------------------------------------------------------------

  /** Steps taken so far. */
  get stepCount(): number {
    return this.steps;
  }

  /** Run the fixed steps `seconds` of time owes (at most maxSubsteps). Returns how many ran. */
  update(seconds: number): number {
    this.assertLive('update');
    this.owed += Math.max(0, seconds);
    // How many steps this call runs: fixed bodies moved with moveTo slide over all of them
    this.stepsThisUpdate = Math.max(1, Math.min(this.maxSubsteps, Math.floor(this.owed / this.dt)));
    let n = 0;
    while (this.owed >= this.dt && n < this.maxSubsteps) {
      this.step();
      this.owed -= this.dt;
      n++;
    }
    this.stepsThisUpdate = 1;
    // Behind by more than maxSubsteps allow: let the rest go rather than fall further behind
    this.owed = Math.min(this.owed, this.dt);
    return n;
  }

  /** One fixed step (dt). Detect contacts by default; optionally reuse within a frame. */
  step(options: StepOptions = {}): void {
    this.assertLive('step');
    this.assertSdfReady();
    const movingKinematics = [...this.moves, ...this.sliding.keys()].some(body => body.enabled);
    this.flush();
    this.slide();
    this.push();
    this.solver.step(movingKinematics ? {} : options);
    for (const body of this.coldBodies) if (body.enabled) {
      this.solver.lifecycle[body.index] = 0;
      this.coldBodies.delete(body);
    }
    this.arrive();
    this.steps++;
    if (this.contactGrowTo && !this.reading && !this.retiredWatch) this.growContactWatch();
    if (this.contactWatch && (this.reporting.size || this.contactsLive)) {
      this.contactWatch.run(this.sdfBridge?.contactEventStorage() ?? this.solver.contactStorage, this.solver.manifoldCapacity, this.steps, this.dt);
      this.contactsLive = this.reporting.size > 0;
    }
    if (this.steps % ADAPT_EVERY === 0 && !this.adapting) {
      this.adapting = true;
      const bridge=this.sdfBridge;
      const counters=this.solver.readCounters();
      void counters.catch(error=>{
        if(!this.destroyed)this.gpuError ??= error instanceof Error?error:new Error(String(error));
      });
      const adaptation=bridge
        ? counters.then(counters=>{
          if(this.destroyed||this.sdfBridge!==bridge)return false;
          // Colours adapt whatever the pair policy: a frozen cap shares colours Jacobi-style in dense piles.
          this.solver.adaptColors(counters);
          return this.sdfBroadphase.autoGrow!==false&&!this.sdfError ? this.adaptSdfCollisions(counters) : false;
        })
        : counters.then(counters=>{
          if(!this.destroyed&&!this.sdfBridge&&this.sdfState==='off')this.solver.adapt(counters);
        });
      const settled=adaptation.catch(error=>{
        if(this.destroyed || this.sdfBridge!==bridge)return;
        const failure=error instanceof Error?error:new Error(String(error));
        if(bridge)this.sdfError=failure;
        else this.gpuError ??= failure;
      });
      void settled.finally(()=>{this.adapting=false;});
    }
    if (this.readbackEvery > 0 && this.steps % this.readbackEvery === 0 && !this.reading) {
      void this.read(this.tracked ?? undefined).catch((error) => {
        if (!this.destroyed) this.gpuError ??= error instanceof Error ? error : new Error(String(error));
      });
    }
  }

  /**
   * A larger contact watch in place of the one that overflowed, its reporting bodies copied. The
   * old one is kept until a read has taken its unread events (never while a read is in flight).
   */
  private growContactWatch(): void {
    const old = this.contactWatch!;
    const pairs = this.contactGrowTo;
    this.contactGrowTo = 0;
    const next = new ContactWatch(this.device, this.solver.bodyBuffer, this.maxBodies, pairs, this.contactOptions.events);
    const bodies = this.bodies;
    next.setWatched(bodies.map(b => b.index), bodies.map(b => b.id), bodies.map(b => b.reportContacts));
    this.retiredWatch = old;
    this.contactWatch = next;
    this.contactOptions.pairs = pairs;
  }

  /** After a readback found `watch`'s sets full: the size to grow to, if it can grow. */
  private planContactGrowth(watch: ContactWatch): void {
    // Fixed storage never grows: overflow stays counted (contactSetOverflows) and unrepaired
    if (watch !== this.contactWatch || this.fixed) return;
    // A set never holds more pairs than the step has pair records (World passes manifoldCapacity
    // to run), so that many is enough; past the device's binding limit it stays saturated
    const limits = this.device.limits;
    const limit = ContactWatch.maxPairs(Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize));
    const target = Math.min(this.solver.manifoldCapacity, limit);
    if (target > watch.pairs) this.contactGrowTo = Math.max(this.contactGrowTo, target);
  }

  /** @internal A body's pushes: this step's impulses, or its standing forces. */
  pushesOf(body: Body, standing: boolean): Pushes {
    assertOwner(this, body);
    if (!body.enabled) throw new BodyDisabledError();
    const map = standing ? this.forces : this.impulses;
    let p = map.get(body);
    if (!p) map.set(body, (p = noPush()));
    return p;
  }

  /** @internal Body.moveTo on a fixed body. */
  move(body: Body, position: Vec3, rotation?: Quat): void {
    assertOwner(this, body);
    body.target = { position, rotation };
    this.moves.add(body);
  }

  /** @internal Body.setCollisionGroups. */
  refilter(body: Body): void {
    assertOwner(this, body);
    if (body.alive) this.refilters.add(body.index);
  }

  /** @internal Body.clearForces. */
  clearForces(body: Body): void {
    assertOwner(this, body);
    this.forces.delete(body);
  }

  /** This step's impulses and a step's worth of the forces, onto the bodies' velocities. */
  private push(): void {
    if (!this.impulses.size && !this.forces.size) return;
    const all = new Map<number, Pushes>();
    for (const [body, p] of this.impulses) if (body.enabled) all.set(body.index, p);
    const dt = this.dt;
    for (const [body, f] of this.forces) {
      if (!body.enabled) continue;
      const p = all.get(body.index) ?? noPush();
      for (let a = 0; a < 3; a++) {
        p.lin[a] += f.lin[a] * dt;
        p.offLin[a] += f.offLin[a] * dt;
        p.moment[a] += f.moment[a] * dt;
      }
      all.set(body.index, p);
    }
    this.pusher.apply(all);
    for (const body of this.impulses.keys()) if (body.enabled) this.impulses.delete(body);
  }

  /** Submit topology, absolute and lifecycle commands, without consuming simulation time. */
  flushCommands(): void { this.assertLive('flushCommands'); this.flush(); }

  private flush(): void {
    const full = [...this.appends, ...this.rewrites.values()].filter((b): b is Body => b !== null);
    if (this.appends.length) {
      const count = this.solver.bodyCount;
      const first = this.solver.addBodies(this.appends.map((b, k) => b ? this.rigid(b) : this.vacantRigid(count + k)));
      if (first !== count) throw new Error('three-avbd: body slots out of step with the solver');
      this.appends = [];
    }
    if (this.rewrites.size) {
      const list = [...this.rewrites].sort((x, y) => x[0] - y[0]);
      this.solver.rewriteBodies(
        list.map(([index]) => index),
        list.map(([index, b]) => b ? this.rigid(b) : this.vacantRigid(index)),
      );
      this.rewrites.clear();
    }
    // Full writes intentionally reset solver metadata; restore this life's desired flags below.
    for (const body of full) if (body.alive && (!body.enabledState || this.coldBodies.has(body))) this.lifecycleDirty.add(body);
    const resetting = [...this.resets].filter(body => body.alive);
    if (resetting.length) {
      this.resetter ??= new BodyReset(this.device, this.solver.bodyBuffer, this.maxBodies);
      this.resetter.apply(resetting.map(body => body.index));
    }
    this.resets.clear();
    for (const [body, patch] of this.patches) {
      if (body.alive) this.solver.patchBody(body.index, patch.fields, this.rigid(body), patch.fixed);
    }
    this.patches.clear();
    for (const body of this.lifecycleDirty) if (body.alive) {
      this.solver.setLifecycle(body.index, (body.enabledState ? 0 : BODY_DISABLED) | (this.coldBodies.has(body) ? BODY_COLD : 0));
    }
    this.lifecycleDirty.clear();
    if (this.vacancies.size) {
      // Vacant reserved slots: unused capacity, never a live body (no ID, filters or integration)
      const list = [...this.vacancies].filter(index => !this.slots[index]).sort((x, y) => x - y);
      for (const index of list) this.solver.setLifecycle(index, BODY_DISABLED);
      this.solver.setFilters(list, list.map(() => 0), list.map(() => 0));
      this.vacancies.clear();
    }
    if (this.rewatches.size) {
      const list = [...this.rewatches];
      for (const index of list) {
        const b = this.slots[index];
        if (b?.reportContacts) this.reporting.add(b);
        else if (b) this.reporting.delete(b);
      }
      const creating = !this.contactWatch && this.reporting.size > 0;
      if (creating) this.contactWatch = new ContactWatch(this.device, this.solver.bodyBuffer, this.maxBodies, this.contactOptions.pairs, this.contactOptions.events);
      if (this.contactWatch) {
        // Every partner needs an ID, including bodies that do not themselves report.
        const indices = creating ? this.bodies.map(b => b.index) : list;
        const bodies = indices.map(index => this.slots[index]);
        this.contactWatch.setWatched(indices, bodies.map(b => b?.id ?? 0), bodies.map(b => !!b?.reportContacts));
      }
      this.rewatches.clear();
    }
    if (this.refilters.size) {
      const list = [...this.refilters].map(index => this.slots[index]).filter((b): b is Body => !!b?.alive).sort((x, y) => x.index - y.index);
      this.solver.setFilters(
        list.map((b) => b.index),
        list.map((b) => b.group),
        list.map((b) => b.collidesWith),
      );
      this.refilters.clear();
    }
    if (this.pendingJoints.length) {
      // Off the queue first, so that if the solver throws (addJoint checks what the solver would
      // refuse, so this is the solver's own failure) nothing is left queued to throw at every flush
      const pending = this.pendingJoints;
      this.pendingJoints = [];
      try {
        // One upload for the joints, one for the springs: each joint carries its own thresholds
        const springs = pending.filter((j) => j.type === 'spring');
        const joints = pending.filter((j) => j.type !== 'spring');
        const placed = (list: Joint[], slots: number[]) =>
          list.forEach((j, k) => {
            j.slot = slots[k];
            j.placed = ++this.placements;
            this.joints.add(j);
          });
        if (joints.length) {
          placed(
            joints,
            this.solver.appendJoints(
              joints.map((j) => ({
                a: j.a.index,
                b: j.b.index,
                rA: j.anchorA,
                rB: j.anchorB,
                angular: j.type === 'ball' ? 0 : undefined,
                fracture: j.breakForce,
                linear: j.breakOnPull,
                rest: j.restRotation ?? undefined,
                yield: j.yieldForce < Infinity ? j.yieldForce : undefined,
                breakBend: j.breakBend < Infinity ? j.breakBend : undefined,
              })),
            ),
          );
        }
        if (springs.length) placed(springs, this.solver.appendSprings(springs.map((j) => ({ a: j.a.index, b: j.b.index, rA: j.anchorA, rB: j.anchorB, stiffness: j.stiffness, rest: j.rest }))));
      } finally {
        // What did not get placed lets go (its handle says so), as the joints that did stay placed
        for (const j of pending) if (j.slot < 0) j.remove();
      }
    }
  }

  /**
   * Fixed bodies moved with moveTo: a velocity that takes each from where it is to its target
   * over this update's steps (the solver moves a fixed body by its velocity, so what it touches
   * sees it slide); stopped again once there.
   */
  private slide(): void {
    for (const b of this.moves) {
      if (b.enabled && b.target) { this.sliding.set(b, this.stepsThisUpdate); this.moves.delete(b); }
    }
    if (!this.sliding.size) return;
    this.mover ??= new BodyMover(this.device, this.solver.bodyBuffer, this.maxBodies);
    this.mover.apply([...this.sliding].filter(([body]) => body.enabled).map(([body, left]) => ({ index: body.index, ...body.target!, left, dt: this.dt })));
  }

  /** Cleanup is queued after the arrival step, never before its contact response. */
  private arrive(): void {
    for (const [body, left] of this.sliding) {
      if (!body.enabled) continue;
      if (left > 1) { this.sliding.set(body, left - 1); continue; }
      const target = body.target!;
      const patch = { position: target.position, ...(target.rotation ? { rotation: target.rotation } : {}), velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
      const fields = new Set<BodyField>(['position', 'velocity', 'angularVelocity']);
      if (target.rotation) fields.add('rotation');
      // patchBody reads only the selected record fields; don't derive omitted pose from CPU state.
      body.state = { ...body.state, ...patch } as Required<BodyState>;
      this.solver.patchBody(body.index, fields, this.rigid(body), false, false);
      body.written = ++this.writes;
      for (const field of fields) body.revisions[field] = body.written;
      body.target = null;
      this.sliding.delete(body);
    }
  }

  /** A body as the solver takes it (built in a scratch reference solver, then let go). */
  private rigid(body: Body): Rigid {
    const parked = !body.alive;
    const density = body.fixed || parked ? 0 : body.density;
    const { position, rotation, velocity, angularVelocity } = body.state;
    const r =
      parked ? new Rigid(this.scratch, [0.1, 0.1, 0.1], 0, 0, position)
      : body.shape === 'sphere' ? sphere(this.scratch, body.size[0] / 2, density, body.friction, position, velocity)
      : body.solverHull ? hull(this.scratch, body.solverHull, density, body.friction, position, rotation, velocity)
      : new Rigid(this.scratch, body.size, density, body.friction, position, velocity);
    if (!parked && !body.fixed && body.massProperties) {
      r.mass = body.massProperties.mass; r.moment.set(body.massProperties.moments);
    }
    r.positionAng.set(normalised(rotation));
    if (!parked) r.velocityAng.set(angularVelocity);
    this.scratch.bodies.length = 0;
    return r;
  }

  /** A vacant reserved slot's record: parked as removed bodies are (the slot's own spot), fixed. */
  private vacantRigid(index: number): Rigid {
    const r = new Rigid(this.scratch, [0.1, 0.1, 0.1], 0, 0, [PARK + 2 * index, PARK, PARK]);
    this.scratch.bodies.length = 0;
    return r;
  }

  // --- Queries ---------------------------------------------------------------------------------

  /**
   * The first body along a ray, where the GPU has the bodies now (after the steps taken so far):
   * null if it hits nothing. Async, like a readback: it resolves a frame or two later.
   */
  async raycast(origin: Vec3, direction: Vec3, options: RaycastOptions = {}): Promise<RayHit | null> {
    return (await this.raycasts([{ origin, direction, maxDistance: options.maxDistance }], options))[0];
  }

  /** Many rays at once: up to 65,535 for standard shapes, 256 in SDF mode. */
  async raycasts(rays: Ray[], options: { ignore?: Body[]; collidesWith?: number } = {}): Promise<(RayHit | null)[]> {
    this.assertLive('raycasts');
    for (const body of options.ignore ?? []) assertOwner(this, body);
    this.assertSdfReady();
    this.flush();
    // A slot can be removed/reused while the query readback is pending.
    const queriedBodies=this.slots.slice(0,this.solver.bodyCount);
    const ignored = (options.ignore ?? []).filter(b => b.alive && queriedBodies[b.index] === b).map(b => b.index);
    if(!this.sdfBridge) this.raycaster ??= new Raycaster(this.device);
    const raw = await (this.sdfBridge ? this.sdfBridge.raycasts(rays, ignored, options.collidesWith ?? 0xffffffff) : this.raycaster!.cast(
      this.solver.bodyBuffer,
      this.solver.hullStorage,
      this.solver.filterStorage,
      this.solver.bodyCount,
      rays,
      ignored,
      options.collidesWith ?? 0xffffffff,
    ));
    return raw.map((h) => (h ? { body: queriedBodies[h.index] ?? null, distance: h.distance, point: h.point, normal: h.normal } : null));
  }

  // --- Reading back ------------------------------------------------------------------------------

  /**
   * Read the bodies' poses and velocities back from the GPU (and see which joints broke): after
   * it resolves, Body.position and the rest reflect its submitted `{ step }` boundary, overlaid
   * by newer field assignments. `bodies`: only these (a body's record
   * is 160 bytes; all of them, at 100k bodies, 16 MB), the rest keeping their last readback. One
   * read at a time: a call while one is running gets that read when it holds every body asked for
   * (as written by then, with no intervening step), else waits and reads them itself. The joints are read too,
   * when any can break or yield: then Joint.force and Joint.bend are fresh (else, readJoints).
   * Rejects once the world is destroyed, also for a read in flight when it is.
   */
  read(bodies?: Body[]): Promise<ReadResult> {
    for (const body of bodies ?? []) assertOwner(this, body);
    bodies = bodies?.slice();
    if (this.destroyed) return Promise.reject(new Error('World destroyed: read after destroy()'));
    if (this.gpuError) return Promise.reject(this.gpuError);
    if (this.reading) {
      if (this.readCovers(bodies)) return this.reading;
      // The read in flight does not hold these bodies (or holds them as they were before a write)
      return this.reading.catch(() => undefined).then(() => this.read(bodies));
    }
    this.flush();
    const writes = this.writes;
    this.readingSlots = bodies ? new Set(bodies.map((b) => b.index)) : null;
    this.readingWrites = writes;
    const step = this.readingStep = this.steps;
    // Joints whose state changes by itself (they break, they bend), or that were asked for
    const watched = this.jointsWanted || [...this.joints].some((j) => j.breakable || j.yieldForce < Infinity);
    this.jointsWanted = false;
    // The joints this readback holds the records of: those placed by now
    const placed = this.placements;
    const watch = this.contactWatch;
    const retired = this.retiredWatch;
    const identities = watch || retired ? this.retiredBodies.snapshot(this.bodies) : null;
    this.reading = (async () => {
      const [, joints, before, now] = await Promise.all([
        this.readBodies(bodies, writes),
        watched ? this.solver.readJoints() : Promise.resolve(null),
        // A replaced watch's last events come before the new one's
        retired?.read() ?? Promise.resolve(null),
        watch?.read() ?? Promise.resolve(null),
      ]);
      if (retired && this.retiredWatch === retired) {
        retired.destroy();
        this.retiredWatch = null;
      }
      // Destroyed meanwhile: nothing more is applied (the joints' buffers are gone)
      if (this.destroyed) throw new Error('World destroyed: read in flight at destroy()');
      const contacts = before && now ? { events: [...before.events, ...now.events], dropped: before.dropped + now.dropped, full: before.full || now.full } : (now ?? before);
      if (contacts?.full) {
        this.contactOverflows++;
        if (now?.full && watch) this.planContactGrowth(watch);
      }
      if (joints) {
        // A broken joint's penalties are zeroed (wgsl-solve.ts dualJoint): let it go properly
        const broken: Joint[] = [];
        const state: JointState = { linear: 0, angular: 0, broken: false, rest: [0, 0, 0, 1], bend: 0 };
        // Of the joints still in the world: one removed meanwhile is gone, and one placed after the
        // readback began may hold the slot of a joint that was removed: not its record to judge by
        for (const j of this.joints) {
          if (j.type === 'spring' || j.placed > placed) continue;
          decodeJoint(joints, j.slot, state);
          j.update(state);
          if (state.broken && j.breakable) broken.push(j);
        }
        if (broken.length) {
          for (const j of broken) {
            this.joints.delete(j);
            j.markBroken();
          }
          this.solver.releaseJoints(broken.map((j) => j.slot));
          for (const j of broken) for (const listener of this.breakListeners) listener(j);
        }
      }
      if (contacts) {
        this.droppedEvents += contacts.dropped;
        const events: ContactEvent[] = [];
        for (const e of orderedEvents(contacts.events)) {
          const a = identities?.get(e.a), b = identities?.get(e.b);
          if (!a || !b) { this.droppedEvents++; continue; }
          events.push({ type: e.kind === BEGIN ? 'begin' : 'end', a, b, point: e.point, normal: e.normal, impulse: e.impulse, step: e.step });
        }
        // Capture both identities and listeners before callbacks can mutate the world.
        const listeners = [...this.contactListeners];
        for (const event of events) for (const listener of listeners) listener(event);
      }
      this.retiredBodies.drain(step);
      return { step };
    })().finally(() => {
      this.reading = null;
      this.readingSlots = null;
    });
    return this.reading;
  }

  /** The read in flight holds `bodies` (all of them: undefined), each as of after its last write. */
  private readCovers(bodies: Body[] | undefined): boolean {
    if (!sameReadStep(this.steps, this.readingStep)) return false;
    if (!bodies) return this.readingSlots === null && this.readingWrites === this.writes;
    return bodies.every((b) => !b.alive || (b.written <= this.readingWrites && (this.readingSlots === null || this.readingSlots.has(b.index))));
  }

  /**
   * Read the joints back from the GPU, so Joint.force and Joint.bend are as of now (and any that
   * broke are seen, as in `read`): the bodies aren't read. `read` does this itself when any joint
   * can break or yield; this is for watching how hard the others work.
   */
  async readJoints(): Promise<void> {
    this.assertLive('readJoints');
    // A read already running may not include the joints: let it finish, then read with them
    while (this.reading) await this.reading;
    this.jointsWanted = true;
    await this.read([]);
  }

  /** Which bodies the automatic readback (readbackEvery) reads: these only, or (null) all. */
  track(bodies: Body[] | null): void {
    for (const body of bodies ?? []) assertOwner(this, body);
    this.tracked = bodies?.slice() ?? null;
  }

  /** Bodies' records into the snapshot: all of them, or runs of these copied out one by one. */
  private async readBodies(bodies: Body[] | undefined, writes: number): Promise<void> {
    if (!bodies) {
      const data = await this.solver.readBodies();
      if (this.destroyed) return;
      this.snapshot.set(data);
      this.readAt.fill(writes, 0, data.length / BODY_FLOATS);
      return;
    }
    const indices = [...new Set(bodies.filter((b) => b.alive && b.index < this.solver.bodyCount).map((b) => b.index))].sort((x, y) => x - y);
    if (!indices.length) return;
    const bytes = BODY_FLOATS * 4;
    const staging = this.device.createBuffer({ size: indices.length * bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder({ label: 'read bodies' });
    for (let k = 0; k < indices.length; ) {
      let e = k + 1;
      while (e < indices.length && indices[e] === indices[e - 1] + 1) e++;
      encoder.copyBufferToBuffer(this.solver.bodyBuffer, indices[k] * bytes, staging, k * bytes, (e - k) * bytes);
      k = e;
    }
    this.device.queue.submit([encoder.finish()]);
    let data: Float32Array;
    try {
      await staging.mapAsync(GPUMapMode.READ);
      data = new Float32Array(staging.getMappedRange().slice(0));
    } finally {
      staging.destroy();
    }
    if (this.destroyed) return;
    indices.forEach((index, k) => {
      this.snapshot.set(data.subarray(k * BODY_FLOATS, (k + 1) * BODY_FLOATS), index * BODY_FLOATS);
      this.readAt[index] = writes;
    });
  }

  /** @internal A body's state: from the last readback, unless it was written since. */
  stateOf(body: Body, offset: number, n: number): number[] {
    assertOwner(this, body);
    const field: BodyField = offset === B_POS ? 'position' : offset === B_ROT ? 'rotation' : offset === B_VEL ? 'velocity' : 'angularVelocity';
    if (body.frozen) return [...body.frozen[field]];
    const o = body.index * BODY_FLOATS + offset;
    return observedField(body.state[field], body.revisions[field], this.snapshot.subarray(o, o + n), this.readAt[body.index]);
  }

  /**
   * Free the GPU buffers (the world can't be used after: stepping, reading, queries and adding or
   * removing bodies and joints throw, and a read in flight rejects). Calling it again does nothing.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed=true;
    for (const reservation of [...this.reservations]) this.releaseReservation(reservation);
    this.hullPins.clear();
    this.pusher.destroy();
    this.mover?.destroy();
    this.resetter?.destroy();
    this.contactWatch?.destroy();
    this.retiredWatch?.destroy();
    this.retiredWatch = null;
    this.solver.destroy();
    for (const release of this.storageReleases) release();
  }
}
