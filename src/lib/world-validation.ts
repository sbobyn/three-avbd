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
