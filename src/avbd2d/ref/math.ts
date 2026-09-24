// Scalar helpers matching avbd-demo2d's maths.h semantics (including NaN/Inf behaviour of
// min/max/clamp, which the solver relies on for infinite force bounds).

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export const sign = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);
export const min = (a: number, b: number): number => (a < b ? a : b);
export const max = (a: number, b: number): number => (a > b ? a : b);
export const clamp = (x: number, a: number, b: number): number => max(a, min(b, x));

/** Rotate v by angle (rotation matrix rows: [c, -s], [s, c]). */
export function rotate(angle: number, x: number, y: number): Vec2 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x - s * y, s * x + c * y];
}

/** Transform a body-local point by pose q = (x, y, angle). */
export function transform(q: ArrayLike<number>, x: number, y: number): Vec2 {
  const c = Math.cos(q[2]);
  const s = Math.sin(q[2]);
  return [c * x - s * y + q[0], s * x + c * y + q[1]];
}

/**
 * Solve the 3x3 SPD system a·x = b with an LDLᵀ decomposition (maths.h `solve`).
 * `a` is row-major (9 entries); only the lower triangle is read. Result written to `out`.
 */
export function solve3(a: ArrayLike<number>, b0: number, b1: number, b2: number, out: Float64Array): void {
  const D1 = a[0];
  const L21 = a[3] / a[0];
  const L31 = a[6] / a[0];
  const D2 = a[4] - L21 * L21 * D1;
  const L32 = (a[7] - L21 * L31 * D1) / D2;
  const D3 = a[8] - (L31 * L31 * D1 + L32 * L32 * D2);

  const y1 = b0;
  const y2 = b1 - L21 * y1;
  const y3 = b2 - L31 * y1 - L32 * y2;

  const z1 = y1 / D1;
  const z2 = y2 / D2;
  const z3 = y3 / D3;

  out[2] = z3;
  out[1] = z2 - L32 * out[2];
  out[0] = z1 - L21 * out[1] - L31 * out[2];
}
