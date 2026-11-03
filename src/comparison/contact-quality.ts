// Independent geometric evaluator: sweep-and-prune candidates, exact box/sphere tests.
// No engine contacts or broadphase are reused. Dense scenes can still cost O(n²).
import type { Scene } from './scenes.ts';
import { STATE_SIZE } from './quality.ts';

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
export function axes(q: ArrayLike<number>): number[][] {
  const [x, y, z, w] = Array.from(q);
  return [
    [1 - 2 * (y*y + z*z), 2 * (x*y + z*w), 2 * (x*z - y*w)],
    [2 * (x*y - z*w), 1 - 2 * (x*x + z*z), 2 * (y*z + x*w)],
    [2 * (x*z + y*w), 2 * (y*z - x*w), 1 - 2 * (x*x + y*y)],
  ];
}
/** Minimum translation distance from the 15 OBB separating axes, including containment. */
export function boxDepth(a: number[], qa: number[], sa: number[],
  b: number[], qb: number[], sb: number[]): number {
  const aa = axes(qa), bb = axes(qb), delta = b.map((v, i) => v - a[i]);
  const candidates = [...aa, ...bb];
  for (const u of aa) for (const v of bb) candidates.push([
    u[1]*v[2] - u[2]*v[1], u[2]*v[0] - u[0]*v[2], u[0]*v[1] - u[1]*v[0],
  ]);
  let depth = Infinity;
  for (const axis of candidates) {
    const length = Math.hypot(...axis);
    if (length < 1e-10) continue;
    const n = axis.map(v => v / length);
    const radius = (basis: number[][], size: number[]) =>
      basis.reduce((s, v, i) => s + Math.abs(dot(v, n)) * size[i] / 2, 0);
    const overlap = radius(aa, sa) + radius(bb, sb) - Math.abs(dot(delta, n));
    if (overlap <= 0) return 0;
    depth = Math.min(depth, overlap);
  }
  return depth;
}

/** Sphere/OBB minimum translation, including a sphere center inside the box. */
export function sphereBoxDepth(center: number[], radius: number, position: number[],
  rotation: number[], size: number[]): number {
  const delta = center.map((v, i) => v - position[i]);
  const local = axes(rotation).map(axis => dot(delta, axis));
  const outside = local.map((v, i) => Math.max(0, Math.abs(v) - size[i] / 2));
  const distance = Math.hypot(...outside);
  if (distance > 0) return Math.max(0, radius - distance);
  return radius + Math.min(...local.map((v, i) => size[i] / 2 - Math.abs(v)));
}

export function contactQuality(scene: Scene, state: Float64Array) {
  if (state.length !== scene.bodies.length * STATE_SIZE) throw new Error('Snapshot body count mismatch');
  if (!state.every(Number.isFinite)) return null;
  const poses = scene.bodies.slice(1).map((body, index) => {
    const id = index + 1, offset = id * STATE_SIZE;
    const p = Array.from(state.subarray(offset, offset + 3));
    const q = Array.from(state.subarray(offset + 3, offset + 7));
    const basis = axes(q);
    const extent = [0, 1, 2].map(k => body.shape === 'sphere' ? body.size[0] / 2 :
      basis.reduce((sum, axis, i) => sum + Math.abs(axis[k]) * body.size[i] / 2, 0));
    return { id, body, p, q, min: p.map((v, i) => v - extent[i]), max: p.map((v, i) => v + extent[i]) };
  });
  if (poses.some(p => Math.abs(Math.hypot(...p.q) - 1) > 1e-4)) return null;
  const bounds = [0, 1, 2].map(axis => {
    let low = Infinity, high = -Infinity;
    for (const p of poses) { low = Math.min(low, p.min[axis]); high = Math.max(high, p.max[axis]); }
    return high - low;
  });
  const axis = bounds.indexOf(Math.max(...bounds));
  poses.sort((a, b) => a.min[axis] - b.min[axis] || a.id - b.id);
  let maxDepth = 0, maxRelativeDepth = 0, candidatePairs = 0;
  let worstPair: number[] | null = null;
  // Body 0 is the ground, measured separately by quality().
  for (let i = 0; i < poses.length; i++) {
    const a = poses[i];
    for (let j = i + 1; j < poses.length && poses[j].min[axis] < a.max[axis]; j++) {
      const b = poses[j];
      if ((!a.body.mass && !b.body.mass) ||
        [0, 1, 2].some(k => a.max[k] <= b.min[k] || b.max[k] <= a.min[k])) continue;
      candidatePairs++;
      let depth: number;
      if (a.body.shape === 'sphere' && b.body.shape === 'sphere') {
        depth = Math.max(0, (a.body.size[0] + b.body.size[0]) / 2 - Math.hypot(...a.p.map((v, k) => v - b.p[k])));
      } else if (a.body.shape === 'sphere') {
        depth = sphereBoxDepth(a.p, a.body.size[0] / 2, b.p, b.q, b.body.size);
      } else if (b.body.shape === 'sphere') {
        depth = sphereBoxDepth(b.p, b.body.size[0] / 2, a.p, a.q, a.body.size);
      } else {
        depth = boxDepth(a.p, a.q, a.body.size, b.p, b.q, b.body.size);
      }
      if (depth > maxDepth) { maxDepth = depth; worstPair = [a.id, b.id].sort((x, y) => x - y); }
      maxRelativeDepth = Math.max(maxRelativeDepth, depth / Math.min(...a.body.size, ...b.body.size));
    }
  }
  return { maxDepth, maxRelativeDepth, worstPair, candidatePairs };
}
