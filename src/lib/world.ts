// three-avbd's world: rigid boxes and spheres, and joints between them, simulated on the GPU by
// the AVBD solver (../avbd3d/gpu). Bodies and joints are handles; the world batches what they
// add, change and remove into the solver before its next step, and reads poses back on request
// (a readback is an async buffer copy, so it's never implicit). With a renderer, the bodies
// live in a buffer Three.js draws from directly (BodyMesh): no copies, no readback to draw.

import * as THREE from 'three/webgpu';
import { B_ANGVEL, B_POS, B_ROT, B_VEL, BODY_FLOATS, J_PEN_LIN, JOINT_FLOATS } from '../avbd3d/gpu/layout.ts';
import { GpuSolver3D, gpuParams3D } from '../avbd3d/gpu/solver.ts';
import { Rigid } from '../avbd3d/ref/body.ts';
import { Solver } from '../avbd3d/ref/solver.ts';
import { sphere } from '../avbd3d/shapes.ts';

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
}

export interface BoxOptions extends BodyOptions {
  /** Full widths along the box's own axes (m). */
  size: Vec3;
}

export interface SphereOptions extends BodyOptions {
  radius: number;
}

export interface JointOptions {
  /** Where the joint holds, in each body's own frame (m). */
  anchorA?: Vec3;
  anchorB?: Vec3;
  /**
   * The force it takes to break the joint (N): measured on its torque, as in the paper, or
   * with `breakOnPull` on its pull too. None: it never breaks.
   */
  breakForce?: number;
  breakOnPull?: boolean;
}

/** Steps between the solver's storage checks (contacts, pairs and colours grow as needed). */
const ADAPT_EVERY = 10;
/** Where removed bodies are parked, far from anything (a slot per body, so none overlap). */
const PARK = 1e5;

const DEFAULTS = { density: 1, friction: 0.5 };

export class Body {
  readonly world: World;
  /** The body's slot in the GPU buffer (for custom shaders): stable for its life. */
  readonly index: number;
  readonly shape: 'box' | 'sphere';
  /** Full widths (a sphere's: its diameter on every axis). */
  readonly size: Vec3;
  readonly density: number;
  readonly friction: number;
  /** @internal */
  state: Required<BodyState>;
  /** @internal The world's write count when this body was last written. */
  written = 0;
  private isFixed: boolean;
  private isAlive = true;

  /** @internal Made by World.addBox / addSphere. */
  constructor(world: World, index: number, shape: 'box' | 'sphere', size: Vec3, options: BodyOptions) {
    this.world = world;
    this.index = index;
    this.shape = shape;
    this.size = size;
    this.density = options.density ?? DEFAULTS.density;
    this.friction = options.friction ?? DEFAULTS.friction;
    this.isFixed = options.fixed ?? false;
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

  /** Pin it where it is (fixed) or let it go. */
  setFixed(fixed: boolean): void {
    if (fixed === this.isFixed) return;
    this.state = { position: this.position, rotation: this.rotation, velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    this.isFixed = fixed;
    this.world.write(this);
  }

  /** Take it out of the world, with its joints. Its slot is reused by later adds. */
  remove(): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    this.world.removeBody(this);
  }
}

export class Joint {
  readonly world: World;
  readonly a: Body;
  readonly b: Body;
  readonly anchorA: Vec3;
  readonly anchorB: Vec3;
  readonly breakForce: number;
  readonly breakOnPull: boolean;
  /** @internal The solver's joint slot (-1 until the next step adds it). */
  slot = -1;
  private state: 'held' | 'broken' | 'removed' = 'held';

  /** @internal Made by World.addJoint. */
  constructor(world: World, a: Body, b: Body, options: JointOptions) {
    this.world = world;
    this.a = a;
    this.b = b;
    this.anchorA = options.anchorA ?? [0, 0, 0];
    this.anchorB = options.anchorB ?? [0, 0, 0];
    this.breakForce = options.breakForce ?? Infinity;
    this.breakOnPull = options.breakOnPull ?? false;
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
  private readonly scratch = new Solver();
  private readonly breakListeners = new Set<(joint: Joint) => void>();
  private snapshot: { data: Float32Array; writes: number } | null = null;
  private writes = 0;
  private steps = 0;
  private owed = 0;
  private reading: Promise<void> | null = null;
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

  private add(shape: 'box' | 'sphere', size: Vec3, options: BodyOptions): Body | null {
    // A removed body's slot first, else the next one past the end
    const index = this.free.length ? this.free.pop()! : this.solver.bodyCount + this.appends.length;
    if (index >= this.maxBodies) return null;
    const body = new Body(this, index, shape, [size[0], size[1], size[2]], options);
    // A slot freed since the last step: the old body's parking write is superseded
    for (const old of this.rewrites) if (old.index === index) this.rewrites.delete(old);
    this.slots[index] = body;
    body.written = ++this.writes;
    if (index >= this.solver.bodyCount) this.appends.push(body);
    else this.rewrites.add(body);
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
    this.slots[body.index] = null;
    this.free.push(body.index);
    // Parked: fixed, small, far off, a slot of space each
    body.state = { position: [PARK + 2 * body.index, PARK, PARK], rotation: [0, 0, 0, 1], velocity: [0, 0, 0], angularVelocity: [0, 0, 0] };
    body.written = ++this.writes;
    this.rewrites.add(body);
    this.liveVersion++;
  }

  // --- Joints ----------------------------------------------------------------------------------

  /** Join two bodies rigidly at their anchors, until (optionally) it breaks. */
  addJoint(a: Body, b: Body, options: JointOptions = {}): Joint {
    if (!a.alive || !b.alive) throw new Error('addJoint: both bodies must be in the world');
    if (a.world !== this || b.world !== this) throw new Error('addJoint: bodies of another world');
    const joint = new Joint(this, a, b, options);
    this.pendingJoints.push(joint);
    return joint;
  }

  /** Called with each joint seen broken (at a readback). Returns a function that unsubscribes. */
  onBreak(listener: (joint: Joint) => void): () => void {
    this.breakListeners.add(listener);
    return () => this.breakListeners.delete(listener);
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
    let n = 0;
    while (this.owed >= this.dt && n < this.maxSubsteps) {
      this.step();
      this.owed -= this.dt;
      n++;
    }
    // Behind by more than maxSubsteps allow: let the rest go rather than fall further behind
    this.owed = Math.min(this.owed, this.dt);
    return n;
  }

  /** One fixed step (dt). */
  step(): void {
    this.flush();
    this.solver.step();
    this.steps++;
    if (this.steps % ADAPT_EVERY === 0 && !this.adapting) {
      this.adapting = true;
      this.solver
        .readCounters()
        .then((counters) => this.solver.adapt(counters))
        .finally(() => (this.adapting = false));
    }
    if (this.readbackEvery > 0 && this.steps % this.readbackEvery === 0 && !this.reading) void this.read();
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
    if (this.pendingJoints.length) {
      // One upload per kind of fracture
      const groups = new Map<string, Joint[]>();
      for (const j of this.pendingJoints) {
        const key = `${j.breakForce} ${j.breakOnPull}`;
        groups.set(key, [...(groups.get(key) ?? []), j]);
      }
      for (const list of groups.values()) {
        const slots = this.solver.appendJoints(
          list.map((j) => ({ a: j.a.index, b: j.b.index, rA: j.anchorA, rB: j.anchorB })),
          list[0].breakForce,
          list[0].breakOnPull,
        );
        list.forEach((j, k) => {
          j.slot = slots[k];
          this.joints.add(j);
        });
      }
      this.pendingJoints = [];
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
      : new Rigid(this.scratch, body.size, density, body.friction, position, velocity);
    const q = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]) || 1;
    r.positionAng.set([rotation[0] / q, rotation[1] / q, rotation[2] / q, rotation[3] / q]);
    if (!parked) r.velocityAng.set(angularVelocity);
    this.scratch.bodies.length = 0;
    return r;
  }

  // --- Reading back ------------------------------------------------------------------------------

  /**
   * Read the bodies' poses and velocities back from the GPU (and see which joints broke): after
   * it resolves, Body.position and the rest are as of now. One read at a time: a call while one
   * is running waits for it.
   */
  read(): Promise<void> {
    if (this.reading) return this.reading;
    this.flush();
    const writes = this.writes;
    const breakable = [...this.joints].filter((j) => j.breakForce < Infinity);
    this.reading = (async () => {
      const [data, joints] = await Promise.all([this.solver.readBodies(), breakable.length ? this.solver.readJoints() : Promise.resolve(null)]);
      this.snapshot = { data, writes };
      if (joints) {
        // A broken joint's penalties are zeroed (wgsl-solve.ts dualJoint): let it go properly
        const broken = breakable.filter((j) => this.joints.has(j) && j.slot * JOINT_FLOATS < joints.length && joints[j.slot * JOINT_FLOATS + J_PEN_LIN + 3] === 0);
        if (broken.length) {
          for (const j of broken) {
            this.joints.delete(j);
            j.markBroken();
          }
          this.solver.releaseJoints(broken.map((j) => j.slot));
          for (const j of broken) for (const listener of this.breakListeners) listener(j);
        }
      }
    })().finally(() => (this.reading = null));
    return this.reading;
  }

  /** @internal A body's state: from the last readback, unless it was written since. */
  stateOf(body: Body, offset: number, n: number): number[] {
    const s = this.snapshot;
    if (s && s.writes >= body.written && (body.index + 1) * BODY_FLOATS <= s.data.length) {
      const o = body.index * BODY_FLOATS + offset;
      return Array.from(s.data.subarray(o, o + n));
    }
    const { position, rotation, velocity, angularVelocity } = body.state;
    return [...(offset === B_POS ? position : offset === B_ROT ? rotation : offset === B_VEL ? velocity : angularVelocity)];
  }

  /** Free the GPU buffers (the world can't be used after). */
  destroy(): void {
    this.solver.destroy();
  }
}
