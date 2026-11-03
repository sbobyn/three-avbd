// Diagnostic dump (--dump-movers N): which bodies are still moving, and which pairs are deepest,
// in the final window. Geometric and engine-independent, like contact-quality.ts: it reads only
// snapshots, so it says where the outliers are, not what either solver did with them.
import type { Scene } from './scenes.ts';
import { axes, boxDepth, sphereBoxDepth } from './contact-quality.ts';
import { STATE_SIZE } from './quality.ts';

/** Two bodies (or a body and the floor) closer than this (m) count as touching. */
export const TOUCH_TOLERANCE = 0.02;
/** A neighbour whose centre is this much (m) higher or lower counts as above or below. */
const LAYER = 0.1;

export interface MoverBody {
  id: number; size: number[];
  position: number[]; speed: number; angularSpeed: number;
  /** Fastest linear speed (m/s) on any window step, the step it occurred, and steps above `settledMaxSpeed`. */
  maxSpeed: number; maxSpeedStep: number; stepsAboveSettled: number;
  /** Centre displacement (m) from the first to the last window step. */
  displacement: number;
  /** Dynamic bodies within TOUCH_TOLERANCE (the floor is `onFloor`), and how many of those have their centre above / below this one's. */
  contacts: number; above: number; below: number;
  onFloor: boolean;
  /** Horizontal distance (m) from the centre to the edge of the dynamic bodies' xy bounding box. */
  pileEdgeDistance: number;
  /** Centre height above the floor top, as a fraction of the highest dynamic centre's. */
  heightFraction: number;
  /** Angle (degrees) from world up to the nearest body axis: 0 is flat on a face, ~35-55 is an edge or a corner down. */
  tilt: number;
}
export interface DeepPair {
  a: number; b: number; depth: number; relativeDepth: number;
  /** The pair's depth on the first window step (m). */
  firstDepth: number;
  /** Box-box only: least overlap over the 6 face axes and over the 9 edge axes (m). */
  faceOverlap: number | null; edgeOverlap: number | null;
  bodies: [MoverBody, MoverBody];
}
export interface MoverDump { step: number; settledMaxSpeed: number; movers: MoverBody[]; deepestPairs: DeepPair[]; }

/** Per-body window statistics, updated on every window step. */
export class MoverTracker {
  readonly maxSpeed: Float64Array; readonly maxSpeedStep: Int32Array; readonly stepsAbove: Int32Array;
  readonly scene: Scene; readonly threshold: number;
  first?: Float64Array;
  constructor(scene: Scene, threshold: number) {
    this.scene = scene; this.threshold = threshold;
    const n = scene.bodies.length;
    this.maxSpeed = new Float64Array(n); this.maxSpeedStep = new Int32Array(n); this.stepsAbove = new Int32Array(n);
  }
  add(step: number, state: Float64Array): void {
    this.first ??= state.slice();
    for (let i = 0; i < this.scene.bodies.length; i++) {
      if (!this.scene.bodies[i].mass) continue;
      const o = i * STATE_SIZE, speed = Math.hypot(state[o + 7], state[o + 8], state[o + 9]);
      if (speed > this.maxSpeed[i]) { this.maxSpeed[i] = speed; this.maxSpeedStep[i] = step; }
      if (speed > this.threshold) this.stepsAbove[i]++;
    }
  }
}

const pose = (state: Float64Array, i: number) => {
  const o = i * STATE_SIZE;
  return { p: Array.from(state.subarray(o, o + 3)), q: Array.from(state.subarray(o + 3, o + 7)) };
};

/** Exact depth of pair (i, j) with each body grown by `pad` per side (pad 0: the plain depth). */
function pairDepth(scene: Scene, state: Float64Array, i: number, j: number, pad = 0): number {
  const A = scene.bodies[i], B = scene.bodies[j], a = pose(state, i), b = pose(state, j);
  const grow = (s: number[]) => s.map(v => v + 2 * pad);
  if (A.shape === 'sphere' && B.shape === 'sphere') {
    return Math.max(0, (A.size[0] + B.size[0]) / 2 + 2 * pad - Math.hypot(...a.p.map((v, k) => v - b.p[k])));
  }
  if (A.shape === 'sphere') return sphereBoxDepth(a.p, A.size[0] / 2 + pad, b.p, b.q, grow(B.size));
  if (B.shape === 'sphere') return sphereBoxDepth(b.p, B.size[0] / 2 + pad, a.p, a.q, grow(A.size));
  return boxDepth(a.p, a.q, grow(A.size), b.p, b.q, grow(B.size));
}

/** Least overlap over face axes and over edge axes (the narrowphase picks between these). */
export function satOverlaps(a: number[], qa: number[], sa: number[], b: number[], qb: number[], sb: number[]) {
  const aa = axes(qa), bb = axes(qb), delta = b.map((v, i) => v - a[i]);
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const overlap = (axis: number[]) => {
    const length = Math.hypot(...axis);
    if (length < 1e-10) return Infinity;
    const n = axis.map(v => v / length);
    const radius = (basis: number[][], size: number[]) => basis.reduce((s, v, k) => s + Math.abs(dot(v, n)) * size[k] / 2, 0);
    return radius(aa, sa) + radius(bb, sb) - Math.abs(dot(delta, n));
  };
  const face = Math.min(...[...aa, ...bb].map(overlap));
  const edges: number[] = [];
  for (const u of aa) for (const v of bb) edges.push(overlap([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]));
  return { face, edge: Math.min(...edges) };
}

/** World-axis half extents of body i. */
function extents(scene: Scene, state: Float64Array, i: number): number[] {
  const b = scene.bodies[i];
  if (b.shape === 'sphere') return [0, 1, 2].map(() => b.size[0] / 2);
  const basis = axes(pose(state, i).q);
  return [0, 1, 2].map(k => basis.reduce((s, axis, m) => s + Math.abs(axis[k]) * b.size[m] / 2, 0));
}

/**
 * Top `count` bodies by final-window max speed and top `count` pairs by depth on the last window
 * step, with where each body sits in the pile. Neighbour search is a sweep on x; O(n log n + k).
 */
export function dumpMovers(scene: Scene, tracker: MoverTracker, last: Float64Array, step: number, count: number): MoverDump {
  if (last.length !== scene.bodies.length * STATE_SIZE) throw new Error('Snapshot body count mismatch');
  const dynamic = scene.bodies.map((_, i) => i).filter(i => scene.bodies[i].mass > 0);
  const ext = scene.bodies.map((_, i) => extents(scene, last, i)), pos = (i: number) => pose(last, i).p;
  // Neighbour lists from a sweep over x on world AABBs padded by the touch tolerance (body 0, the floor, is separate).
  const order = dynamic.slice().sort((i, j) => (pos(i)[0] - ext[i][0]) - (pos(j)[0] - ext[j][0]));
  const neighbours = new Map<number, number[]>(dynamic.map(i => [i, []]));
  const deep: { a: number; b: number; depth: number }[] = [];
  const t = TOUCH_TOLERANCE;
  for (let x = 0; x < order.length; x++) {
    const i = order[x], pi = pos(i);
    for (let y = x + 1; y < order.length; y++) {
      const j = order[y], pj = pos(j);
      if (pj[0] - ext[j][0] > pi[0] + ext[i][0] + 2 * t) break;
      if ([0, 1, 2].some(k => Math.abs(pi[k] - pj[k]) > ext[i][k] + ext[j][k] + 2 * t)) continue;
      if (pairDepth(scene, last, i, j, t / 2) <= 0) continue;
      neighbours.get(i)!.push(j); neighbours.get(j)!.push(i);
      const depth = pairDepth(scene, last, i, j);
      if (depth > 0) deep.push({ a: Math.min(i, j), b: Math.max(i, j), depth });
    }
  }
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity], top = 0;
  for (const i of dynamic) {
    const p = pos(i);
    lo = lo.map((v, k) => Math.min(v, p[k])); hi = hi.map((v, k) => Math.max(v, p[k]));
    top = Math.max(top, p[2] - scene.groundTop);
  }
  const describe = (i: number): MoverBody => {
    const p = pos(i), o = i * STATE_SIZE, near = neighbours.get(i) ?? [];
    const up = axes(pose(last, i).q).map(axis => Math.abs(axis[2]));
    const first = tracker.first ? Array.from(tracker.first.subarray(o, o + 3)) : p;
    return { id: i, size: scene.bodies[i].size, position: p,
      speed: Math.hypot(last[o + 7], last[o + 8], last[o + 9]), angularSpeed: Math.hypot(last[o + 10], last[o + 11], last[o + 12]),
      maxSpeed: tracker.maxSpeed[i], maxSpeedStep: tracker.maxSpeedStep[i], stepsAboveSettled: tracker.stepsAbove[i],
      displacement: Math.hypot(...p.map((v, k) => v - first[k])),
      contacts: near.length, above: near.filter(j => pos(j)[2] > p[2] + LAYER).length, below: near.filter(j => pos(j)[2] < p[2] - LAYER).length,
      onFloor: p[2] - ext[i][2] <= scene.groundTop + t,
      pileEdgeDistance: Math.min(p[0] - lo[0], hi[0] - p[0], p[1] - lo[1], hi[1] - p[1]),
      heightFraction: top > 0 ? (p[2] - scene.groundTop) / top : 0,
      tilt: scene.bodies[i].shape === 'sphere' ? 0 : Math.acos(Math.min(1, Math.max(...up))) * 180 / Math.PI };
  };
  const movers = dynamic.slice().sort((i, j) => tracker.maxSpeed[j] - tracker.maxSpeed[i] || i - j).slice(0, count).map(describe);
  const deepestPairs = deep.sort((x, y) => y.depth - x.depth || x.a - y.a).slice(0, count).map(({ a, b, depth }): DeepPair => {
    const A = scene.bodies[a], B = scene.bodies[b];
    const boxes = A.shape === 'box' && B.shape === 'box';
    const sat = boxes ? satOverlaps(pos(a), pose(last, a).q, A.size, pos(b), pose(last, b).q, B.size) : null;
    return { a, b, depth, relativeDepth: depth / Math.min(...A.size, ...B.size),
      firstDepth: tracker.first ? pairDepth(scene, tracker.first, a, b) : depth,
      faceOverlap: sat?.face ?? null, edgeOverlap: sat?.edge ?? null, bodies: [describe(a), describe(b)] };
  });
  return { step, settledMaxSpeed: tracker.threshold, movers, deepestPairs };
}
