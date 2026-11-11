// Pure checks for World inputs (body creation, stepping parameters), run before any slot, ID,
// pin, accumulator or solver parameter changes. The GPU holds these values as f32, so finite
// means finite after rounding to f32. A body's initial state is checked by copyBodyPatch
// (body-commands.ts), as Body.set checks it.

const f32Finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(Math.fround(v));
const f32Positive = (v: unknown): v is number => f32Finite(v) && Math.fround(v) > 0;
const f32NonNegative = (v: unknown): v is number => f32Finite(v) && v >= 0;

function vector(value: unknown, n: number, what: string, check: (v: unknown) => boolean, rule: string): number[] {
  if (value == null || typeof (value as ArrayLike<number>).length !== 'number' || (value as ArrayLike<number>).length !== n) throw new TypeError(`${what} must have ${n} numbers`);
  const out = Array.from(value as ArrayLike<number>);
  if (!out.every(check)) throw new RangeError(`${what} must be ${rule} (as f32)`);
  return out;
}

/** A box's or hull's full widths: three positive f32-finite numbers, copied. */
export function checkBodySize(size: unknown, what: string): [number, number, number] {
  return vector(size, 3, `${what}: size`, f32Positive, 'finite and positive') as [number, number, number];
}

/** A sphere's radius: positive and f32-finite, as is its diameter. Returns the diameter. */
export function checkRadius(radius: unknown, what: string): number {
  if (!f32Positive(radius) || !f32Positive(2 * radius)) throw new RangeError(`${what}: radius must be finite and positive (as f32)`);
  return 2 * radius;
}

export interface BodyMaterialInput { density?: unknown; friction?: unknown; group?: unknown; collidesWith?: unknown }

/** Density and friction finite and at least 0; masks include signed JavaScript bitwise results. */
export function checkBodyMaterial(options: BodyMaterialInput, what: string): void {
  if (options.density !== undefined && !f32NonNegative(options.density)) throw new RangeError(`${what}: density must be finite and at least 0 (as f32)`);
  if (options.friction !== undefined && !f32NonNegative(options.friction)) throw new RangeError(`${what}: friction must be finite and at least 0 (as f32)`);
  for (const key of ['group', 'collidesWith'] as const) {
    const value = options[key];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= -0x80000000 && (value as number) <= 0xffffffff)) throw new RangeError(`${what}: ${key} must be a 32-bit mask`);
  }
}

/** Seconds per step: positive and f32-finite. */
export function checkDt(dt: unknown, what = 'World.dt'): number {
  if (!f32Positive(dt)) throw new RangeError(`${what} must be finite and positive (as f32), not ${String(dt)}`);
  return dt;
}

/** Solver iterations per step: an integer, at least 0 (0 integrates without solving). */
export function checkIterations(n: unknown, what = 'World.iterations'): number {
  if (!Number.isSafeInteger(n) || (n as number) < 0) throw new RangeError(`${what} must be a nonnegative integer, not ${String(n)}`);
  return n as number;
}

/** The most fixed steps one update runs: an integer, at least 1. */
export function checkMaxSubsteps(n: unknown, what = 'World.maxSubsteps'): number {
  if (!Number.isSafeInteger(n) || (n as number) < 1) throw new RangeError(`${what} must be a positive integer, not ${String(n)}`);
  return n as number;
}

/** Gravity: three f32-finite numbers whose magnitude is f32-finite too. Copied. */
export function checkGravity(g: unknown, what = 'World.gravity'): [number, number, number] {
  const out = vector(g, 3, what, f32Finite, 'finite') as [number, number, number];
  if (!f32Finite(Math.hypot(...out))) throw new RangeError(`${what} must have a finite magnitude (as f32)`);
  return out;
}

/** The time update() is given: finite (negative counts as 0, as before). */
export function checkDelta(seconds: unknown): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) throw new RangeError(`World.update: seconds must be a finite number, not ${String(seconds)}`);
  return Math.max(0, seconds);
}

/** The largest |gravityScale| (an API bound for a dimensionless multiplier, not a stability qualification). */
export const MAX_GRAVITY_SCALE = 1000;

/**
 * A body's gravity scale: a number, finite as f32 and within ±MAX_GRAVITY_SCALE (0: no gravity,
 * negative: reversed). Returns it unchanged.
 */
export function checkGravityScale(scale: unknown, what: string): number {
  if (typeof scale !== 'number' || !f32Finite(scale) || Math.abs(Math.fround(scale)) > MAX_GRAVITY_SCALE) {
    throw new RangeError(`${what}: gravityScale must be a finite number (as f32) within [-${MAX_GRAVITY_SCALE}, ${MAX_GRAVITY_SCALE}], not ${String(scale)}`);
  }
  return scale;
}

/**
 * The gravity a body falls with, as the solver computes it in f32: the stored gravity size times
 * its scale. The product of two f32 values is exact in f64, so rounding it once to f32 is the f32
 * product; it must be finite, which a finite gravity and a finite scale alone do not guarantee.
 */
export function checkEffectiveGravity(gravitySize: number, scale: number, what: string): void {
  if (!Number.isFinite(Math.fround(Math.fround(gravitySize) * Math.fround(scale)))) {
    throw new RangeError(`${what}: gravity ${String(gravitySize)} m/s² times gravityScale ${String(scale)} is not finite (as f32)`);
  }
}

/** The largest damping rate, 1/s (an API bound, not a stability or physical qualification). */
export const MAX_DAMPING_RATE = 1000;

/** A body's damping rates (1/s): how fast its linear and angular velocities decay. */
export interface BodyDamping {
  readonly linear: number;
  readonly angular: number;
}

/** BodyOptions.damping: either rate may be left out (0). */
export interface DampingOptions {
  linear?: number;
  angular?: number;
}

const DAMPING_KEYS = new Set(['linear', 'angular']);

function dampingRate(rate: unknown, key: string, what: string): number {
  if (typeof rate !== 'number' || !f32Finite(rate) || !(rate >= 0) || Math.fround(rate) > MAX_DAMPING_RATE) {
    throw new RangeError(`${what}: damping.${key} must be a finite number (as f32) within [0, ${MAX_DAMPING_RATE}] 1/s, not ${String(rate)}`);
  }
  return rate;
}

/**
 * A damping pair, read once and copied into a frozen object the caller cannot change. `full`
 * (Body.setDamping) needs both rates; otherwise (BodyOptions.damping) a missing rate, or a missing
 * pair, is 0. Unknown keys are refused, so a misspelt rate is not silently 0. Throws TypeError
 * for a value that is not a plain pair and RangeError for a rate outside [0, MAX_DAMPING_RATE].
 */
export function checkDamping(value: unknown, what: string, full = false): BodyDamping {
  if (value === undefined && !full) return Object.freeze({ linear: 0, angular: 0 });
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${what}: damping must be an object { linear, angular }, not ${String(value)}`);
  for (const key of Object.keys(value)) if (!DAMPING_KEYS.has(key)) throw new TypeError(`${what}: damping has no '${key}' (only linear and angular)`);
  const { linear, angular } = value as { linear?: unknown; angular?: unknown };
  if (full && (linear === undefined || angular === undefined)) throw new TypeError(`${what}: damping needs both linear and angular`);
  return Object.freeze({ linear: linear === undefined ? 0 : dampingRate(linear, 'linear', what), angular: angular === undefined ? 0 : dampingRate(angular, 'angular', what) });
}

/**
 * The exponent a damped body decays with each step, as the solver computes it in f32: rate × dt.
 * It must be finite, which a finite rate and a finite dt alone do not guarantee.
 */
export function checkEffectiveDamping(rate: number, dt: number, what: string): void {
  if (!Number.isFinite(Math.fround(Math.fround(rate) * Math.fround(dt)))) {
    throw new RangeError(`${what}: damping ${String(rate)} 1/s times dt ${String(dt)} s is not finite (as f32)`);
  }
}

/** Strict sensor intent; only an omitted creation option defaults to false. */
export function checkSensor(value: unknown, what: string, optional = false): boolean {
  if (optional && value === undefined) return false;
  if (typeof value !== 'boolean') throw new TypeError(`${what}: sensor must be boolean`);
  return value;
}
