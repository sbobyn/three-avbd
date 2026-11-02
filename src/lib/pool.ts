// three-avbd/pool: fixed-template body pools for churn (projectiles, debris, effects). A pool
// reserves its slots in a fixed-storage World (WorldOptions.storage) up front, uploads its
// template (and pins its hull) once, and then hands out fresh bodies: each acquire is a new Body
// handle with a new lifetime ID in one of its slots, released by `release` or `body.remove()`.
// Acquire and release only queue CPU commands; neither grows GPU storage nor compiles anything.

import { Body, World, type BodyOptions, type BodyState, type BoxOptions, type Quat, type Reservation, type SphereOptions, type Vec3 } from './world.ts';
import { BodyLifecycleError } from './lifecycle.ts';
import { MAX_HULL_VERTICES, type HullShape } from '../avbd3d/hull.ts';

type TemplateOptions<T> = Omit<T, keyof BodyState | 'enabled'>;

/** What every body of a pool is: its shape, mass, material, filters and reporting. */
export type BodyTemplate =
  | { kind: 'box'; options: TemplateOptions<BoxOptions> }
  | { kind: 'sphere'; options: TemplateOptions<SphereOptions> }
  /**
   * A cooked hull (convexHull). Spawn states place the body itself: its centre of mass, turned to
   * the hull's principal axes (as Body.position and Body.rotation read), not the points' frame.
   */
  | { kind: 'hull'; shape: HullShape; options?: TemplateOptions<BodyOptions> };

/** Where an acquired body starts: its full pose, and (default zero) how it moves. */
export type SpawnState = Pick<Required<BodyState>, 'position' | 'rotation'> & Pick<BodyState, 'velocity' | 'angularVelocity'>;

export type AcquireResult = { ok: true; body: Body } | { ok: false; reason: 'capacity' | 'id-exhausted' | 'disposed' };
export type PoolCreateResult = { ok: true; pool: BodyPool } | { ok: false; reason: 'capacity' | 'unsupported-backend' | 'resource-limit' | 'fixed-storage-required' };

export interface BodyPoolStats {
  capacity: number;
  leased: number;
  enabled: number;
  disabled: number;
  available: number;
}

/** A validated private copy of a template: later changes to the caller's objects don't reach it. */
interface Resolved {
  shape: 'box' | 'sphere' | 'hull';
  size: Vec3;
  options: BodyOptions;
  hull: HullShape | null;
}

const STATE_KEYS = ['position', 'rotation', 'velocity', 'angularVelocity', 'enabled'] as const;
const f32Finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(Math.fround(v));
const positive = (v: unknown): v is number => f32Finite(v) && Math.fround(v) > 0;

function vector(value: unknown, n: number, what: string, check: (v: unknown) => boolean = f32Finite): number[] {
  if (value == null || typeof (value as ArrayLike<number>).length !== 'number' || (value as ArrayLike<number>).length !== n) throw new TypeError(`${what} must have ${n} numbers`);
  const out = Array.from(value as ArrayLike<number>);
  if (!out.every(check)) throw new RangeError(`${what} must be finite${check === positive ? ' and positive' : ''} (as f32)`);
  return out;
}

function mask(value: unknown, what: string): void {
  if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff)) throw new RangeError(`${what} must be a 32-bit mask`);
}

function checkOptions(options: Record<string, unknown>): BodyOptions {
  for (const key of STATE_KEYS) if (key in options) throw new TypeError(`BodyPool template: '${key}' is per body: pass it to tryAcquire`);
  if (options.density !== undefined && !positive(options.density)) throw new RangeError('BodyPool template: density must be finite and positive');
  if (options.friction !== undefined && !(f32Finite(options.friction) && (options.friction as number) >= 0)) throw new RangeError('BodyPool template: friction must be finite and at least 0');
  for (const key of ['fixed', 'reportContacts'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new TypeError(`BodyPool template: ${key} must be boolean`);
  mask(options.group, 'BodyPool template: group');
  mask(options.collidesWith, 'BodyPool template: collidesWith');
  const copy = { ...options } as BodyOptions & Record<string, unknown>;
  if (options.massProperties !== undefined) {
    const m = options.massProperties as { mass: unknown; moments: unknown };
    if (!positive(m?.mass)) throw new RangeError('BodyPool template: massProperties.mass must be finite and positive');
    copy.massProperties = { mass: m.mass as number, moments: vector(m.moments, 3, 'BodyPool template: massProperties.moments', positive) as Vec3 };
  }
  delete copy.size; delete copy.radius;
  return copy;
}

/** A deep copy of a cooked hull, checked enough that packing it can't go out of bounds. */
function copyHull(shape: HullShape): HullShape {
  const n = shape?.vertices?.length;
  if (!(shape?.vertices instanceof Float32Array) || n % 3 !== 0 || n < 12 || n / 3 > MAX_HULL_VERTICES) throw new TypeError('BodyPool template: hull vertices must be a Float32Array of 4 to 32 points (a shape from convexHull)');
  if (!Array.from(shape.vertices).every(f32Finite)) throw new RangeError('BodyPool template: hull vertices must be finite');
  const count = n / 3;
  const index = (i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count;
  if (!Array.isArray(shape.faces) || shape.faces.length < 4) throw new TypeError('BodyPool template: hull faces missing');
  const faces = shape.faces.map(f => {
    if (!Array.isArray(f.verts) || f.verts.length < 3 || !f.verts.every(index) || !f32Finite(f.d)) throw new RangeError('BodyPool template: invalid hull face');
    return { ...f, normal: vector(f.normal, 3, 'BodyPool template: hull face normal') as Vec3, verts: [...f.verts] };
  });
  if (!Array.isArray(shape.edges) || !shape.edges.every(e => Array.isArray(e) && e.length === 4 && index(e[0]) && index(e[1]) && [e[2], e[3]].every(k => Number.isInteger(k) && k >= 0 && k < faces.length))) throw new RangeError('BodyPool template: invalid hull edges');
  if (!positive(shape.volume) || !positive(shape.radius)) throw new RangeError('BodyPool template: hull volume and radius must be positive');
  return {
    vertices: new Float32Array(shape.vertices), faces, edges: shape.edges.map(e => [...e] as [number, number, number, number]),
    volume: shape.volume, radius: shape.radius,
    moments: vector(shape.moments, 3, 'BodyPool template: hull moments', positive) as Vec3,
    size: vector(shape.size, 3, 'BodyPool template: hull size', positive) as Vec3,
    center: vector(shape.center, 3, 'BodyPool template: hull center') as Vec3,
    rotation: vector(shape.rotation, 4, 'BodyPool template: hull rotation') as Quat,
  };
}

function resolve(template: BodyTemplate): Resolved {
  switch (template?.kind) {
    case 'box': {
      const options = template.options as unknown as Record<string, unknown>;
      return { shape: 'box', size: vector(options?.size, 3, 'BodyPool template: size', positive) as Vec3, options: checkOptions(options), hull: null };
    }
    case 'sphere': {
      const options = template.options as unknown as Record<string, unknown>;
      if (!positive(options?.radius)) throw new RangeError('BodyPool template: radius must be finite and positive');
      const d = 2 * (options.radius as number);
      return { shape: 'sphere', size: [d, d, d], options: checkOptions(options), hull: null };
    }
    case 'hull': {
      const hull = copyHull(template.shape);
      return { shape: 'hull', size: [...hull.size] as Vec3, options: checkOptions((template.options ?? {}) as Record<string, unknown>), hull };
    }
    default:
      throw new TypeError("BodyPool template: kind must be 'box', 'sphere' or 'hull'");
  }
}

function spawn(state: SpawnState): BodyState {
  if (!state || typeof state !== 'object') throw new TypeError('BodyPool.tryAcquire: pass a spawn state');
  const position = vector(state.position, 3, 'tryAcquire: position') as Vec3;
  const q = vector(state.rotation, 4, 'tryAcquire: rotation');
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(length > 1e-6) || !Number.isFinite(length)) throw new RangeError('tryAcquire: rotation must be a nonzero quaternion');
  return {
    position,
    rotation: q.map(v => v / length) as Quat,
    velocity: state.velocity === undefined ? [0, 0, 0] : vector(state.velocity, 3, 'tryAcquire: velocity') as Vec3,
    angularVelocity: state.angularVelocity === undefined ? [0, 0, 0] : vector(state.angularVelocity, 3, 'tryAcquire: angularVelocity') as Vec3,
  };
}

export class BodyPool {
  readonly world: World;
  readonly capacity: number;
  private readonly reservation: Reservation;
  private readonly template: Resolved;

  private constructor(world: World, reservation: Reservation, template: Resolved) {
    this.world = world;
    this.capacity = reservation.capacity;
    this.reservation = reservation;
    this.template = template;
  }

  /**
   * Reserve `capacity` slots for bodies of `template`, upload it once (pinning a hull's geometry)
   * and wait for the GPU. A typed failure leaves the World as it was; an invalid template or
   * capacity throws, and a GPU failure during setup rejects and invalidates the World.
   */
  static async create(world: World, options: { capacity: number; template: BodyTemplate }): Promise<PoolCreateResult> {
    if (!(world instanceof World)) throw new TypeError('BodyPool.create: pass a World');
    const capacity = options?.capacity;
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('BodyPool.create: capacity must be a positive safe integer');
    const template = resolve(options.template);
    const reservation = world.reserveBodies(capacity, template.hull);
    if (typeof reservation === 'string') return { ok: false, reason: reservation };
    try {
      await world.prewarmReservation(reservation);
    } catch (error) {
      world.releaseReservation(reservation);
      throw error;
    }
    return { ok: true, pool: new BodyPool(world, reservation, template) };
  }

  /** A fresh enabled body of the template in a vacant slot, or why there is none. */
  tryAcquire(state: SpawnState): AcquireResult {
    const initial = spawn(state);
    const t = this.template;
    // A hull body's public shape is its own copy: changing it can't reach the pinned geometry
    const publicHull = t.hull ? copyHull(t.hull) : null;
    const options = t.options.massProperties ? { ...t.options, massProperties: { mass: t.options.massProperties.mass, moments: [...t.options.massProperties.moments] as Vec3 } } : { ...t.options };
    const result = this.world.acquireReserved(this.reservation, t.shape, t.size, { ...options, ...initial }, publicHull);
    return typeof result === 'string' ? { ok: false, reason: result } : { ok: true, body: result };
  }

  /** Give a body back (as `body.remove()`). Only this pool's bodies; a released one is ignored. */
  release(body: Body): void {
    if (!(body instanceof Body) || body.owner !== this.reservation) throw new BodyLifecycleError('BodyPool.release: body is not from this pool');
    if (!body.alive || this.reservation.state !== 'active' || this.world.isDestroyed || this.world.error) return;
    body.remove();
  }

  /** Whether the pool can still hand out bodies (not disposed, World alive). */
  get active(): boolean {
    return this.reservation.state === 'active' && !this.world.isDestroyed && !this.world.error;
  }

  get stats(): Readonly<BodyPoolStats> {
    if (!this.active) return Object.freeze({ capacity: this.capacity, leased: 0, enabled: 0, disabled: 0, available: 0 });
    let enabled = 0;
    for (const body of this.reservation.live) if (body.enabled) enabled++;
    const leased = this.reservation.live.size;
    return Object.freeze({ capacity: this.capacity, leased, enabled, disabled: leased - enabled, available: this.reservation.vacant.length });
  }

  /** Remove its live bodies and give its slots (and hull pin) back to the World. Idempotent. */
  dispose(): void {
    this.world.releaseReservation(this.reservation);
  }
}
