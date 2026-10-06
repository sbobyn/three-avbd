// three-avbd's world: rigid boxes and spheres, and joints between them, simulated on the GPU by
// the AVBD solver (../avbd3d/gpu). Bodies and joints are handles; the world batches what they
// add, change and remove into the solver before its next step, and reads poses back on request
// (a readback is an async buffer copy, so it's never implicit). With a renderer, the bodies
// live in a buffer Three.js draws from directly (BodyMesh): no copies, no readback to draw.

import * as THREE from 'three/webgpu';
import { B_ANGVEL, B_POS, B_ROT, B_VEL, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import { decodeJoint, type JointState } from '../avbd3d/gpu/joints.ts';
import { GpuSolver3D, gpuParams3D, unitRotation } from '../avbd3d/gpu/solver.ts';
import { Rigid } from '../avbd3d/ref/body.ts';
import { Solver } from '../avbd3d/ref/solver.ts';
import { convexHull, hull, type HullShape, sphere } from '../avbd3d/shapes.ts';
import { BEGIN, ContactWatch } from './contacts.ts';
import { addImpulse, noPush, Pusher, type Pushes } from './push.ts';
import { type Ray, Raycaster } from './raycast.ts';

export type Vec3 = [number, number, number];
/** A unit quaternion, x y z w (as THREE.Quaternion's toArray). */
export type Quat = [number, number, number, number];

export interface WorldOptions {
  /** Share the renderer's GPU device, so BodyMesh can draw the bodies with no copies. */
  renderer?: THREE.WebGPURenderer;
  /** Or a device of your own (headless: Node with Dawn, tests, workers). */
  device?: GPUDevice;
  /** Room for this many bodies at once (removed bodies' slots are reused). */
  maxBodies: number;
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
}

/** A body's starting state: where it is, how it's turned, how it moves. */
export interface BodyState {
  position?: Vec3;
  rotation?: Quat;
  velocity?: Vec3;
  angularVelocity?: Vec3;
}

export interface BodyOptions extends BodyState {
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
  /** The body hit (null if it was removed while the cast was on its way back). */
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
   * The force it takes to break the joint (N): measured on its torque, as in the paper, or
   * with `breakOnPull` on its pull too. None: it never breaks.
   */
  breakForce?: number;
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
   * this: to have a heavy load tear it too, add `breakOnPull`.
   */
  yieldForce?: number;
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

export class Body {
  readonly world: World;
  /** The body's slot in the GPU buffer (for custom shaders): stable for its life. */
  readonly index: number;
  readonly shape: 'box' | 'sphere' | 'hull';
  /** A hull body's shape (its vertices and faces in the body's own frame). */
  readonly hull: HullShape | null;
  /** Full widths (a sphere's: its diameter on every axis; a hull's: its bounds on its principal axes). */
  readonly size: Vec3;
  readonly density: number;
  readonly friction: number;
  /** @internal */
  state: Required<BodyState>;
  /** @internal The world's write count when this body was last written. */
  written = 0;
  /** @internal The first step it's in. */
  addedAt = 0;
  private reports: boolean;
  private groups: number;
  private mask: number;
  private isFixed: boolean;
  private isAlive = true;

  /** @internal Made by World.addBox / addSphere. */
  constructor(world: World, index: number, shape: 'box' | 'sphere' | 'hull', size: Vec3, options: BodyOptions, hullShape: HullShape | null = null) {
    this.world = world;
    this.index = index;
    this.shape = shape;
    this.hull = hullShape;
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
    this.groups = group;
    this.mask = collidesWith;
    this.world.refilter(this);
  }
  /** Whether it reports its contacts (World.onContact), from the next step. */
  get reportContacts(): boolean {
    return this.reports;
  }
  set reportContacts(on: boolean) {
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
   * as of the last readback. Its contacts start afresh.
   */
  set(state: BodyState): void {
    this.state = {
      position: state.position ?? this.position,
      rotation: state.rotation ?? this.rotation,
      velocity: state.velocity ?? this.velocity,
      angularVelocity: state.angularVelocity ?? this.angularVelocity,
    };
    this.world.write(this);
  }

  /**
   * Move a fixed body (a platform, a door, a hand) to a new pose over the next update's steps:
   * it slides there, pushing and carrying what it touches (call it every frame to animate it).
   * A moving body is set there instead (set: its contacts start afresh). For a fixed body that
   * keeps moving (a conveyor, a turntable), set its velocity: set({ velocity, angularVelocity }).
   */
  moveTo(position: Vec3, rotation?: Quat): void {
    if (!this.isAlive) return;
    if (!this.isFixed) return this.set({ position, rotation });
    this.world.move(this, position, rotation ?? this.state.rotation);
  }

  /** @internal Where a moved fixed body is going (World.flush turns it into a velocity). */
  target: { position: Vec3; rotation: Quat } | null = null;

  /** Pin it where it is (fixed) or let it go. */
  setFixed(fixed: boolean): void {
    if (fixed === this.isFixed) return;
    this.state = { position: this.position, rotation: this.rotation, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    this.isFixed = fixed;
    this.world.write(this);
  }

  /** A push (N·s) at a point in the world (none: through its centre of mass), at the next step. */
  applyImpulse(impulse: Vec3, point?: Vec3): void {
    if (this.isAlive) addImpulse(this.world.pushesOf(this, false), impulse, point);
  }

  /** A twist (N·m·s, about world axes through its centre of mass), at the next step. */
  applyAngularImpulse(impulse: Vec3): void {
    if (this.isAlive) this.world.pushesOf(this, false).moment.forEach((_, a, m) => (m[a] += impulse[a]));
  }

  /** A force (N) at a point in the world (none: through its centre of mass), every step until clearForces. */
  applyForce(force: Vec3, point?: Vec3): void {
    if (this.isAlive) addImpulse(this.world.pushesOf(this, true), force, point);
  }

  /** A torque (N·m, about world axes through its centre of mass), every step until clearForces. */
  applyTorque(torque: Vec3): void {
    if (this.isAlive) this.world.pushesOf(this, true).moment.forEach((_, a, m) => (m[a] += torque[a]));
  }

  /** Stop the forces and torques applied to it. */
  clearForces(): void {
    this.world.clearForces(this);
  }

  /** Take it out of the world, with its joints. Its slot is reused by later adds. */
  remove(): void {
    if (!this.isAlive) return;
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
   * the one it started with, as of the last readback that read joints. Zero for a joint that
   * never yielded.
   */
  get bend(): number {
    return this.bent;
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
  /** Still holding. */
  get holding(): boolean {
    return this.state === 'held';
  }

  /** Let go of the two bodies (they collide with each other again). */
  remove(): void {
    if (this.state !== 'held') return;
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
  private readonly free: number[] = [];
  private appends: Body[] = [];
  private readonly rewrites = new Set<Body>();
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
  private readonly rewatches = new Set<Body>();
  private readonly reporting = new Set<Body>();
  /** The pass ran last step (so it runs once more when the last reporting body goes, for the ends). */
  private contactsLive = false;
  private droppedEvents = 0;
  /** Each slot's last removed body (an event may come back after its slot was reused). */
  private readonly gone: (Body | null)[] = [];
  private readonly contactOptions: { pairs: number; events: number };
  /** Bodies whose collision groups go to the GPU at the next step (every new body, so a reused slot's are reset). */
  private readonly refilters = new Set<Body>();
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
  private reading: Promise<void> | null = null;
  /** The next read reads the joints (readJoints). */
  private jointsWanted = false;
  private adapting = false;
  private liveVersion = 0;

  /** Make a world: `World.create` (async, it may need the renderer's device). */
  private constructor(device: GPUDevice, options: WorldOptions, attribute: THREE.StorageInstancedBufferAttribute | null, buffer: GPUBuffer | undefined) {
    this.device = device;
    this.maxBodies = options.maxBodies;
    this.bodyAttribute = attribute;
    this.solver = new GpuSolver3D(device, this.scratch, { bodyBuffer: buffer, bodyCapacity: options.maxBodies });
    Object.assign(this.solver.params, gpuParams3D(), { dt: options.dt ?? 1 / 60, iterations: options.iterations ?? 10 });
    this.gravity = options.gravity ?? [0, -9.81, 0];
    this.pusher = new Pusher(device, this.solver.bodyBuffer);
    this.snapshot = new Float32Array(options.maxBodies * BODY_FLOATS);
    this.readAt = new Float64Array(options.maxBodies).fill(-1);
    this.contactOptions = { pairs: options.maxContactPairs ?? 8192, events: options.maxContactEvents ?? 4096 };
  }

  static async create(options: WorldOptions): Promise<World> {
    if (!(options.maxBodies > 0)) throw new Error('World.create: maxBodies must be positive');
    if (options.renderer) {
      const renderer = options.renderer;
      await renderer.init();
      const backend = renderer.backend as unknown as {
        device?: GPUDevice;
        createStorageAttribute(attribute: THREE.BufferAttribute): void;
        get(object: object): { buffer?: GPUBuffer };
      };
      if (!backend.device) throw new Error('World.create: the renderer has no WebGPU device (WebGPU unavailable, or the WebGL fallback in use)');
      // The attribute's buffer, made now on the renderer's device, so the solver writes the very
      // buffer Three.js draws from (it would otherwise be made at the first draw)
      const attribute = new THREE.StorageInstancedBufferAttribute(new Float32Array(options.maxBodies * BODY_FLOATS), 4);
      backend.createStorageAttribute(attribute);
      const buffer = backend.get(attribute).buffer;
      if (!buffer) throw new Error('World.create: Three.js made no GPU buffer for the bodies');
      return new World(backend.device, options, attribute, buffer);
    }
    if (!options.device) throw new Error('World.create: pass a renderer or a device');
    return new World(options.device, options, null, undefined);
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
    const shape = options.shape ?? (options.points ? convexHull(options.points) : null);
    if (!shape) throw new Error('addHull: no hull (pass a shape, or points that aren\'t flat or all in one place)');
    // The points' frame placed as asked; the body at the centre of mass, on the principal axes
    const q = options.rotation ?? [0, 0, 0, 1];
    const p = options.position ?? [0, 0, 0];
    const c = rotate(q, shape.center);
    const position: Vec3 = [p[0] + c[0], p[1] + c[1], p[2] + c[2]];
    const rotation = multiply(q, shape.rotation);
    return this.add('hull', shape.size, { ...options, position, rotation }, shape);
  }

  /** Whether hulls collide as hulls (the device allows a ninth storage buffer per shader stage). */
  get hullsEnabled(): boolean {
    return this.solver.hulls;
  }

  private add(shape: 'box' | 'sphere' | 'hull', size: Vec3, options: BodyOptions, hullShape: HullShape | null = null): Body | null {
    // A removed body's slot first, else the next one past the end
    const index = this.free.length ? this.free.pop()! : this.solver.bodyCount + this.appends.length;
    if (index >= this.maxBodies) return null;
    const body = new Body(this, index, shape, [size[0], size[1], size[2]], options, hullShape);
    // A slot freed since the last step: the old body's parking write is superseded
    for (const old of this.rewrites) if (old.index === index) this.rewrites.delete(old);
    this.slots[index] = body;
    body.written = ++this.writes;
    body.addedAt = this.steps + 1;
    if (body.reportContacts) this.rewatches.add(body);
    if (index >= this.solver.bodyCount) this.appends.push(body);
    else this.rewrites.add(body);
    this.refilters.add(body);
    this.liveVersion++;
    return body;
  }

  /** The bodies in the world, in slot order. */
  get bodies(): Body[] {
    return this.slots.filter((b): b is Body => b !== null && b !== undefined);
  }

  /** Bumped whenever bodies come or go (BodyMesh redraws its list then). */
  get version(): number {
    return this.liveVersion;
  }

  /** @internal Body.set / setFixed: rewrite it at the next step. */
  write(body: Body): void {
    if (!body.alive) return;
    body.written = ++this.writes;
    if (!this.appends.includes(body)) this.rewrites.add(body);
  }

  /** @internal Body.remove: its joints go, and it's parked out of the way. */
  removeBody(body: Body): void {
    for (const j of [...this.joints, ...this.pendingJoints]) if (j.a === body || j.b === body) j.remove();
    this.impulses.delete(body);
    this.forces.delete(body);
    this.slots[body.index] = null;
    this.gone[body.index] = body;
    this.free.push(body.index);
    if (body.reportContacts) this.rewatches.add(body);
    // Parked: fixed, small, far off, a slot of space each
    body.state = { position: [PARK + 2 * body.index, PARK, PARK], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    body.written = ++this.writes;
    this.rewrites.add(body);
    this.liveVersion++;
  }

  // --- Joints ----------------------------------------------------------------------------------

  /**
   * Join two bodies at their anchors, rigidly or (type 'ball') free to turn, until (optionally) it
   * breaks. A rigid joint holds the bodies' rotations equal unless told another turn to hold
   * (`rest`), and can bend for good under load (`yieldForce`).
   */
  addJoint(a: Body, b: Body, options: JointOptions = {}): Joint {
    this.checkPair(a, b, 'addJoint');
    const { rest, yieldForce, ...others } = options;
    if (options.type === 'ball' && (rest !== undefined || yieldForce !== undefined)) {
      throw new Error("addJoint: a ball joint has no angle lock to hold a turn or to bend: 'rest' and 'yieldForce' are for fixed joints");
    }
    if (yieldForce !== undefined && !(yieldForce >= 0)) throw new Error(`addJoint: yieldForce is a force of at least 0, not ${yieldForce}`);
    const breakForce = options.breakForce ?? Infinity;
    if (!(breakForce >= 0)) throw new Error(`addJoint: breakForce is a force of at least 0, not ${breakForce}`);
    if (yieldForce !== undefined && yieldForce < Infinity && breakForce < Infinity && yieldForce >= breakForce) {
      this.warnOnce('never yields', `addJoint: yieldForce (${yieldForce}) is not below breakForce (${breakForce}), so the joint breaks before it can yield and never bends: lower yieldForce, or raise breakForce`);
    }
    // The turn to hold: as given, or as the bodies are (by the poses the world knows). Everything
    // is checked here, at the call: a joint the solver would refuse must never wait in the queue
    const restRotation =
      rest == null ? undefined
      : rest === 'current' ? unitRotation(relativeRotation(a.rotation, b.rotation), "addJoint: rest 'current' (from the bodies' rotations)")
      : unitRotation(rest, 'addJoint: rest');
    const joint = new Joint(this, a, b, { ...others, restRotation, yieldForce });
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

  private checkPair(a: Body, b: Body, what: string): void {
    if (!a.alive || !b.alive) throw new Error(`${what}: both bodies must be in the world`);
    if (a.world !== this || b.world !== this) throw new Error(`${what}: bodies of another world`);
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

  /** @internal Body.reportContacts. */
  rewatch(body: Body): void {
    if (body.alive) this.rewatches.add(body);
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

  /** One fixed step (dt). */
  step(): void {
    this.flush();
    this.push();
    this.solver.step();
    this.steps++;
    if (this.contactWatch && (this.reporting.size || this.contactsLive)) {
      this.contactWatch.run(this.solver.contactStorage, this.solver.manifoldCapacity, this.steps, this.dt);
      this.contactsLive = this.reporting.size > 0;
    }
    if (this.steps % ADAPT_EVERY === 0 && !this.adapting) {
      this.adapting = true;
      this.solver
        .readCounters()
        .then((counters) => this.solver.adapt(counters))
        .finally(() => (this.adapting = false));
    }
    if (this.readbackEvery > 0 && this.steps % this.readbackEvery === 0 && !this.reading) void this.read(this.tracked ?? undefined);
  }

  /** @internal A body's pushes: this step's impulses, or its standing forces. */
  pushesOf(body: Body, standing: boolean): Pushes {
    const map = standing ? this.forces : this.impulses;
    let p = map.get(body);
    if (!p) map.set(body, (p = noPush()));
    return p;
  }

  /** @internal Body.moveTo on a fixed body. */
  move(body: Body, position: Vec3, rotation: Quat): void {
    if (this.appends.includes(body) || this.rewrites.has(body)) {
      // Waiting to be written whole: it's simply put there
      body.state = { ...body.state, position, rotation };
      body.written = ++this.writes;
      return;
    }
    body.target = { position, rotation: normalised(rotation) };
    this.moves.add(body);
  }

  /** @internal Body.setCollisionGroups. */
  refilter(body: Body): void {
    if (body.alive) this.refilters.add(body);
  }

  /** @internal Body.clearForces. */
  clearForces(body: Body): void {
    this.forces.delete(body);
  }

  /** This step's impulses and a step's worth of the forces, onto the bodies' velocities. */
  private push(): void {
    if (!this.impulses.size && !this.forces.size) return;
    const all = new Map<number, Pushes>();
    for (const [body, p] of this.impulses) all.set(body.index, p);
    const dt = this.dt;
    for (const [body, f] of this.forces) {
      const p = all.get(body.index) ?? noPush();
      for (let a = 0; a < 3; a++) {
        p.lin[a] += f.lin[a] * dt;
        p.offLin[a] += f.offLin[a] * dt;
        p.moment[a] += f.moment[a] * dt;
      }
      all.set(body.index, p);
    }
    this.pusher.apply(all);
    this.impulses.clear();
  }

  /** Send what bodies and joints were added, changed or removed since the last step. */
  private flush(): void {
    if (this.appends.length) {
      const first = this.solver.addBodies(this.appends.map((b) => this.rigid(b)));
      if (first !== this.appends[0].index) throw new Error('three-avbd: body slots out of step with the solver');
      this.appends = [];
    }
    if (this.rewrites.size) {
      const list = [...this.rewrites].sort((x, y) => x.index - y.index);
      this.solver.rewriteBodies(
        list.map((b) => b.index),
        list.map((b) => this.rigid(b)),
      );
      this.rewrites.clear();
    }
    this.slide();
    if (this.rewatches.size) {
      const list = [...this.rewatches];
      this.contactWatch ??= new ContactWatch(this.device, this.solver.bodyBuffer, this.maxBodies, this.contactOptions.pairs, this.contactOptions.events);
      const on = list.map((b) => b.alive && b.reportContacts);
      this.contactWatch.setWatched(
        list.map((b) => b.index),
        on,
      );
      list.forEach((b, k) => (on[k] ? this.reporting.add(b) : this.reporting.delete(b)));
      this.rewatches.clear();
    }
    if (this.refilters.size) {
      const list = [...this.refilters].filter((b) => b.alive).sort((x, y) => x.index - y.index);
      this.solver.setFilters(
        list.map((b) => b.index),
        list.map((b) => b.group),
        list.map((b) => b.collidesWith),
      );
      this.refilters.clear();
    }
    if (this.pendingJoints.length) {
      // Off the queue first, so that if the solver throws (addJoint checks what it would refuse, so
      // this is a failure of the solver's own) nothing is left queued to throw again at every flush
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
    const buffer = this.solver.bodyBuffer;
    const writeVelocity = (b: Body, v: ArrayLike<number>, w: ArrayLike<number>) => {
      const o = b.index * BODY_FLOATS;
      this.device.queue.writeBuffer(buffer, (o + B_VEL) * 4, new Float32Array([v[0], v[1], v[2]]));
      this.device.queue.writeBuffer(buffer, (o + B_ANGVEL) * 4, new Float32Array([w[0], w[1], w[2]]));
    };
    // Arrived: stop (unless moved again)
    for (const [b, left] of this.sliding) {
      if (left > 1) this.sliding.set(b, left - 1);
      else {
        this.sliding.delete(b);
        if (b.alive && !this.moves.has(b)) {
          writeVelocity(b, [0, 0, 0], [0, 0, 0]);
          b.state = { ...b.state, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
        }
      }
    }
    for (const b of this.moves) {
      if (!b.alive || !b.target) continue;
      const time = this.stepsThisUpdate * this.dt;
      const [p, q] = [b.state.position, b.state.rotation];
      const { position, rotation } = b.target;
      const v: Vec3 = [(position[0] - p[0]) / time, (position[1] - p[1]) / time, (position[2] - p[2]) / time];
      // The turn from q to the target, the short way: ω = 2 vec(target q⁻¹) / time
      let d = multiply(rotation, [-q[0], -q[1], -q[2], q[3]]);
      if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
      const w: Vec3 = [(2 * d[0]) / time, (2 * d[1]) / time, (2 * d[2]) / time];
      writeVelocity(b, v, w);
      b.state = { position, rotation, velocity: v, angularVelocity: w };
      b.written = ++this.writes;
      b.target = null;
      this.sliding.set(b, this.stepsThisUpdate);
    }
    this.moves.clear();
  }

  /** A body as the solver takes it (built in a scratch reference solver, then let go). */
  private rigid(body: Body): Rigid {
    const parked = !body.alive;
    const density = body.fixed || parked ? 0 : body.density;
    const { position, rotation, velocity, angularVelocity } = body.state;
    const r =
      parked ? new Rigid(this.scratch, [0.1, 0.1, 0.1], 0, 0, position)
      : body.shape === 'sphere' ? sphere(this.scratch, body.size[0] / 2, density, body.friction, position, velocity)
      : body.hull ? hull(this.scratch, body.hull, density, body.friction, position, rotation, velocity)
      : new Rigid(this.scratch, body.size, density, body.friction, position, velocity);
    r.positionAng.set(normalised(rotation));
    if (!parked) r.velocityAng.set(angularVelocity);
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

  /** Many rays at once (one GPU pass for all: up to 65,535). */
  async raycasts(rays: Ray[], options: { ignore?: Body[]; collidesWith?: number } = {}): Promise<(RayHit | null)[]> {
    this.flush();
    this.raycaster ??= new Raycaster(this.device);
    const raw = await this.raycaster.cast(
      this.solver.bodyBuffer,
      this.solver.hullStorage,
      this.solver.filterStorage,
      this.solver.bodyCount,
      rays,
      (options.ignore ?? []).map((b) => b.index),
      options.collidesWith ?? 0xffffffff,
    );
    return raw.map((h) => (h ? { body: this.slots[h.index] ?? null, distance: h.distance, point: h.point, normal: h.normal } : null));
  }

  // --- Reading back ------------------------------------------------------------------------------

  /**
   * Read the bodies' poses and velocities back from the GPU (and see which joints broke): after
   * it resolves, Body.position and the rest are as of now. `bodies`: only these (a body's record
   * is 160 bytes; all of them, at 100k bodies, 16 MB), the rest keeping their last readback. One
   * read at a time: a call while one is running waits for it. The joints are read too, when any
   * can break or yield: then Joint.force and Joint.bend are fresh (else, readJoints).
   */
  read(bodies?: Body[]): Promise<void> {
    if (this.reading) return this.reading;
    this.flush();
    const writes = this.writes;
    // Joints whose state changes by itself (they break, they bend), or that were asked for
    const watched = this.jointsWanted || [...this.joints].some((j) => j.breakForce < Infinity || j.yieldForce < Infinity);
    this.jointsWanted = false;
    // The joints this readback holds the records of: those placed by now
    const placed = this.placements;
    this.reading = (async () => {
      const [, joints, contacts] = await Promise.all([
        this.readBodies(bodies, writes),
        watched ? this.solver.readJoints() : Promise.resolve(null),
        this.contactWatch?.read() ?? Promise.resolve(null),
      ]);
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
          if (state.broken && j.breakForce < Infinity) broken.push(j);
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
        // A slot's body then: the one in it now, unless it came after (then the one removed from it)
        const at = (index: number, step: number) => {
          const now = this.slots[index];
          if (now && now.addedAt <= step) return now;
          const gone = this.gone[index];
          return gone && gone.addedAt <= step ? gone : null;
        };
        for (const e of contacts.events) {
          // (An end is of a pair that touched the step before: its bodies as they were then)
          const then = e.kind === BEGIN ? e.step : e.step - 1;
          const [a, b] = [at(e.a, then), at(e.b, then)];
          if (!a || !b) continue;
          const event: ContactEvent = { type: e.kind === BEGIN ? 'begin' : 'end', a, b, point: e.point, normal: e.normal, impulse: e.impulse, step: e.step };
          for (const listener of this.contactListeners) listener(event);
        }
      }
    })().finally(() => (this.reading = null));
    return this.reading;
  }

  /**
   * Read the joints back from the GPU, so Joint.force and Joint.bend are as of now (and any that
   * broke are seen, as in `read`): the bodies aren't read. `read` does this itself when any joint
   * can break or yield; this is for watching how hard the others work.
   */
  async readJoints(): Promise<void> {
    // A read already running may not include the joints: let it finish, then read with them
    while (this.reading) await this.reading;
    this.jointsWanted = true;
    await this.read([]);
  }

  /** Which bodies the automatic readback (readbackEvery) reads: these only, or (null) all. */
  track(bodies: Body[] | null): void {
    this.tracked = bodies;
  }

  /** Bodies' records into the snapshot: all of them, or runs of these copied out one by one. */
  private async readBodies(bodies: Body[] | undefined, writes: number): Promise<void> {
    if (!bodies) {
      const data = await this.solver.readBodies();
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
    await staging.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    indices.forEach((index, k) => {
      this.snapshot.set(data.subarray(k * BODY_FLOATS, (k + 1) * BODY_FLOATS), index * BODY_FLOATS);
      this.readAt[index] = writes;
    });
  }

  /** @internal A body's state: from the last readback, unless it was written since. */
  stateOf(body: Body, offset: number, n: number): number[] {
    if (this.readAt[body.index] >= body.written) {
      const o = body.index * BODY_FLOATS + offset;
      return Array.from(this.snapshot.subarray(o, o + n));
    }
    const { position, rotation, velocity, angularVelocity } = body.state;
    return [...(offset === B_POS ? position : offset === B_ROT ? rotation : offset === B_VEL ? velocity : angularVelocity)];
  }

  /** Free the GPU buffers (the world can't be used after). */
  destroy(): void {
    this.pusher.destroy();
    this.contactWatch?.destroy();
    this.solver.destroy();
  }
}
