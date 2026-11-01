export type Vec3 = [number, number, number];
export type Triangle = [Vec3, Vec3, Vec3];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3) => Math.hypot(...a);
export const unit = (a: Vec3): Vec3 => mul(a, 1 / length(a));
export const normal = (t: Triangle) => unit(cross(sub(t[1], t[0]), sub(t[2], t[0])));
export function vector(a: ArrayLike<number>, name: string): Vec3 {
  if (a.length !== 3 || !Array.from(a).every(Number.isFinite)) throw new Error(`${name} must have three finite components`);
  return [a[0], a[1], a[2]];
}
export function tolerance(t: Triangle, radius = 0): number {
  return 1e-10 * Math.max(1, radius, length(sub(t[1], t[0])), length(sub(t[2], t[0]))) +
    64 * Number.EPSILON * Math.max(...t.flat().map(Math.abs));
}
function inside(p: Vec3, t: Triangle, n: Vec3): boolean {
  return t.every((a, i) => dot(cross(sub(t[(i + 1) % 3], a), sub(p, a)), n) >= 0);
}
export function closest(p: Vec3, t: Triangle): Vec3 {
  const n = normal(t), projected = sub(p, mul(n, dot(sub(p, t[0]), n)));
  if (inside(projected, t, n)) return projected;
  let best = Infinity, point = t[0];
  for (let i = 0; i < 3; i++) {
    const a = t[i], e = sub(t[(i + 1) % 3], a);
    const q = add(a, mul(e, Math.max(0, Math.min(1, dot(sub(p, a), e) / dot(e, e)))));
    const d = length(sub(p, q));
    if (d < best) { best = d; point = q; }
  }
  return point;
}
export function contact(center: Vec3, t: Triangle) {
  const point = closest(center, t), delta = sub(center, point), distance = length(delta);
  return { point, normal: distance > tolerance(t) ? mul(delta, 1 / distance) : normal(t), distance };
}
export function rayTriangle(o: Vec3, d: Vec3, t: Triangle, limit: number): number | null {
  const n = normal(t), denom = dot(d, n), epsilon = tolerance(t);
  if (Math.abs(denom) > 16 * Number.EPSILON) {
    const s = dot(sub(t[0], o), n) / denom;
    if (s < -epsilon || s > limit) return null;
    const p = add(o, mul(d, Math.max(0, s)));
    return length(sub(p, closest(p, t))) <= epsilon ? Math.max(0, s) : null;
  }
  if (Math.abs(dot(sub(o, t[0]), n)) > epsilon) return null;
  if (length(sub(o, closest(o, t))) <= epsilon) return 0;
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = t[i], e = sub(t[(i + 1) % 3], a), den = dot(cross(d, e), n);
    if (Math.abs(den) <= Number.EPSILON * length(e)) continue;
    const delta = sub(a, o), s = dot(cross(delta, e), n) / den, u = dot(cross(delta, d), n) / den;
    if (s >= 0 && s <= limit && u >= 0 && u <= 1) best = Math.min(best, s);
  }
  return Number.isFinite(best) ? best : null;
}
// Stable quadratic roots, including a tangent double root and parallel motion.
function roots(a: number, b: number, c: number): number[] {
  if (a === 0) return b === 0 ? [] : [-c / b];
  let disc = b * b - 4 * a * c;
  const roundoff = 64 * Number.EPSILON * (b * b + Math.abs(4 * a * c));
  if (disc < -roundoff) return [];
  disc = Math.max(0, disc);
  const q = -.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
  return q === 0 ? [-b / (2 * a)] : [q / a, c / q].sort((x, y) => x - y);
}
export function sweepTriangle(center: Vec3, radius: number, translation: Vec3, t: Triangle) {
  const epsilon = tolerance(t, radius), initial = contact(center, t);
  if (initial.distance <= radius + epsilon) return { fraction: 0, point: initial.point, normal: initial.normal, startedOverlapping: true };
  if (length(translation) === 0) return null;
  let fraction = Infinity;
  const accept = (s: number) => {
    if (s < 0 || s > 1 || s >= fraction) return;
    if (contact(add(center, mul(translation, s)), t).distance <= radius + epsilon) fraction = s;
  };
  const n = normal(t), distance = dot(sub(center, t[0]), n), speed = dot(translation, n);
  if (speed !== 0) for (const side of [-1, 1]) accept((side * radius - distance) / speed);
  for (let i = 0; i < 3; i++) {
    const a = t[i], e = sub(t[(i + 1) % 3], a), axis = unit(e), offset = sub(center, a);
    const p = sub(offset, mul(axis, dot(offset, axis))), v = sub(translation, mul(axis, dot(translation, axis)));
    for (const s of roots(dot(v, v), 2 * dot(p, v), dot(p, p) - radius * radius)) {
      const along = dot(add(offset, mul(translation, s)), axis);
      if (along >= -epsilon && along <= length(e) + epsilon) accept(s);
    }
    for (const s of roots(dot(translation, translation), 2 * dot(offset, translation), dot(offset, offset) - radius * radius)) accept(s);
  }
  if (!Number.isFinite(fraction)) return null;
  const hit = contact(add(center, mul(translation, fraction)), t);
  return { fraction, point: hit.point, normal: hit.normal, startedOverlapping: false };
}
