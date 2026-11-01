import { add, sub, mul, dot, cross, length, normal, closest, tolerance, type Vec3, type Triangle } from './geometry.ts';

/** Closest segment/triangle features, including an interior plane crossing. */
export function capsuleContact(start: Vec3, end: Vec3, t: Triangle) {
  let point = closest(start, t), axisPoint = start, distance = length(sub(start, point)), invalidArithmetic = !Number.isFinite(distance);
  const accept = (p: Vec3, q: Vec3) => {
    const d = length(sub(p, q));
    if (!Number.isFinite(d) || !p.every(Number.isFinite) || !q.every(Number.isFinite)) invalidArithmetic = true;
    if (d < distance) { distance = d; axisPoint = p; point = q; }
  };
  accept(end, closest(end, t));
  const u = sub(end, start), n = normal(t), denom = dot(u, n);
  if (denom !== 0) {
    const s = dot(sub(t[0], start), n) / denom;
    if (s >= 0 && s <= 1) {
      const p = add(start, mul(u, s));
      if (t.every((a, i) => dot(cross(sub(t[(i + 1) % 3], a), sub(p, a)), n) >= 0)) accept(p, p);
    }
  }
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const a = dot(u, u);
  const invalid = () => ({ point, normal: n, distance: NaN });
  if (!Number.isFinite(a)) return invalid();
  for (let i = 0; i < 3; i++) {
    const q = t[i], v = sub(t[(i + 1) % 3], q), w = sub(start, q);
    const b = dot(u, v), c = dot(v, v), d = dot(u, w), e = dot(v, w);
    if (![b, c, d, e].every(Number.isFinite)) return invalid();
    // Boundary minima of the parameter square, followed by its interior minimum.
    for (const s of [0, 1]) accept(add(start, mul(u, s)), add(q, mul(v, clamp((e + b * s) / c))));
    for (const r of [0, 1]) accept(add(start, mul(u, a === 0 ? 0 : clamp((b * r - d) / a))), add(q, mul(v, r)));
    // Cross-product determinant avoids cancellation for nearly parallel axes.
    const det = dot(cross(u, v), cross(u, v));
    if (!Number.isFinite(det)) return invalid();
    if (det > 0) {
      const s = dot(cross(v, w), cross(u, v)) / det, r = dot(cross(u, w), cross(u, v)) / det;
      if (![s, r].every(Number.isFinite)) return invalid();
      if (s >= 0 && s <= 1 && r >= 0 && r <= 1) accept(add(start, mul(u, s)), add(q, mul(v, r)));
    }
  }
  if (invalidArithmetic) return invalid();
  return { point, normal: distance > tolerance(t) ? mul(sub(axisPoint, point), 1 / distance) : n, distance };
}

export type CapsuleTriangleSweep =
  | { status: 'hit'; fraction: number; point: Vec3; normal: Vec3; startedOverlapping: boolean }
  | { status: 'miss' }
  | { status: 'indeterminate'; fraction: number };

export function sweepCapsuleTriangle(start: Vec3, end: Vec3, radius: number, translation: Vec3, t: Triangle, maxIterations: number): CapsuleTriangleSweep {
  const epsilon = tolerance(t, radius), speed = length(translation);
  let fraction = 0;
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const hit = capsuleContact(add(start, mul(translation, fraction)), add(end, mul(translation, fraction)), t);
    if (!Number.isFinite(hit.distance) || !hit.normal.every(Number.isFinite)) return { status: 'indeterminate', fraction };
    if (hit.distance <= radius + 2 * epsilon) return { status: 'hit', fraction, point: hit.point, normal: hit.normal, startedOverlapping: fraction === 0 };
    if (speed === 0) return { status: 'miss' };
    // Closest-point normal defines a separating support plane for this convex pair.
    const closing = -dot(translation, hit.normal);
    if (!(closing > 0)) return { status: 'miss' };
    const step = (hit.distance - radius - epsilon) / Math.min(speed, closing);
    if (step > 1 - fraction) return { status: 'miss' };
    const next = fraction + .9 * step;
    if (!(next > fraction)) return { status: 'indeterminate', fraction };
    fraction = next;
  }
  return { status: 'indeterminate', fraction };
}
