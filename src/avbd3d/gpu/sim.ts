// Sim3D adapter over the WebGPU solver. Bodies live on the GPU, so the synchronous queries
// (poses for picking and the drag line, stats for the HUD) are served from a readback that
// is refreshed asynchronously every few steps; rendering reads the GPU body buffer directly.

import { Rigid } from '../ref/body.ts';
import { Spring } from '../ref/forces.ts';
import { Solver } from '../ref/solver.ts';
import { sphere } from '../shapes.ts';
import type { Emitter3D, SceneOptions } from '../bench-scenes.ts';
import { CANNONBALL, DRAG_STIFFNESS, type LabelView3D, type PickResult3D, type RopeView3D, type Sim3D, type SimStats3D, type SpringView3D, sceneByName3D } from '../sim.ts';
import { clothsOf, labelsOf, ropesOf, type Visual, visualOf } from '../visuals.ts';
import { B_ANGVEL, B_MOMENT, B_POS, B_ROT, B_SIZE, B_VEL, BODY_FLOATS, J_PEN_ANG, J_PEN_LIN, J_RA, J_RB, JOINT_FLOATS, T_JOINT } from './layout.ts';
import { type GpuParams3D, GpuSolver3D, type StepProfile } from './solver.ts';

/** Steps between asynchronous readbacks of body poses and stats. */
const READBACK_EVERY = 10;
/** Steps between GPU step timings. */
const TIME_EVERY = 30;

export interface GpuStats3D extends SimStats3D {
  colors: number;
  clashes: number;
  /** GPU time of one step (timestamp queries), when available. */
  gpuStepMs?: number;
}

/** What the viewer draws besides the bodies, in the GPU solver's body order. */
export interface GpuLooks3D {
  visuals: (Visual | undefined)[];
  /** Level (unrotated) as built, per body (bodies shot later are never the floor). */
  level: boolean[];
  springs: SpringView3D[];
  cloths: number[][][];
  ropes: RopeView3D[];
  labels: LabelView3D[];
}

/** No paint for this body (GpuSim3D.setPaint). */
export const NO_PAINT = 0xffffffff;

export class GpuSim3D implements Sim3D {
  readonly label = 'WebGPU';
  readonly solver: GpuSolver3D;
  private bodies: Float32Array = new Float32Array(0);
  private cachedStats: GpuStats3D = { joints: 0, contacts: 0, kineticEnergy: 0, maxJointError: 0, colors: 0, clashes: 0 };
  private steps = 0;
  private reading = false;
  private dragSlot = -1;
  private dragTarget = -1;
  /** Latest per-phase GPU timing, refreshed every TIME_EVERY steps. */
  profile: StepProfile | null = null;
  /** Keeps a scratch solver so shot boxes get the reference's mass properties. */
  private readonly scratch = new Solver();

  private readonly looks: GpuLooks3D;
  /** Adds the scene's bodies as it runs (Scene3D.emitter). */
  private readonly emitter: Emitter3D | null;
  /** Never adapt the solver's storage (its scene must run the same every time). */
  private readonly deterministic: boolean;
  /** Paint for bodies `paintFrom` on, in index order (a picture's colours; NO_PAINT: none). */
  private paint: Uint32Array | null = null;
  private paintFrom = 0;
  /** Index of the first emitted body. */
  readonly firstEmitted: number;

  /** Steps between readbacks of poses and stats: fewer where labels follow bodies. */
  readbackEvery = READBACK_EVERY;

  constructor(
    solver: GpuSolver3D,
    looks: GpuLooks3D = { visuals: [], level: [], springs: [], cloths: [], ropes: [], labels: [] },
    emitter: Emitter3D | null = null,
    deterministic = false,
  ) {
    this.solver = solver;
    this.looks = looks;
    this.emitter = emitter;
    this.deterministic = deterministic;
    this.firstEmitted = solver.bodyCount;
    this.refresh();
  }

  /** Steps taken so far. */
  get stepCount(): number {
    return this.steps;
  }

  /**
   * Paint bodies `from` on (by default the emitted ones, in the order they're added) with
   * `colors`, those there already and to come; NO_PAINT leaves a body as it was.
   */
  setPaint(colors: Uint32Array, from = this.firstEmitted): void {
    this.paint = colors;
    this.paintFrom = from;
    for (let i = from; i < Math.min(this.bodyCount, from + colors.length); i++) {
      if (colors[i - from] !== NO_PAINT) this.looks.visuals[i] = { ...this.looks.visuals[i], color: colors[i - from] };
    }
  }

  private paintOf(i: number): Visual | undefined {
    const k = i - this.paintFrom;
    return this.paint && k >= 0 && k < this.paint.length && this.paint[k] !== NO_PAINT ? { color: this.paint[k] } : undefined;
  }

  get params(): GpuParams3D {
    return this.solver.params;
  }
  get bodyCount(): number {
    return this.solver.bodyCount;
  }
  get dragBody(): number {
    return this.dragTarget;
  }

  /**
   * What the periodic readback copies besides the counters (which the solver's adapt needs):
   * poses (picking, the drag line, labels, kinetic energy) and joints (joint stats). A pose
   * readback is the whole body buffer (17.6 MB at 110k bodies), so the app asks only when it
   * needs them; poses and stats are then as old as the last readback that had them.
   */
  needPoses = true;
  needJoints = true;

  step(): void {
    if (this.emitter) {
      this.emitter.spawn(this.steps, this.scratch);
      if (this.scratch.bodies.length) {
        const first = this.solver.addBodies(this.scratch.bodies);
        if (first >= 0) for (let i = first; i < this.solver.bodyCount; i++) this.looks.visuals[i] = this.paintOf(i);
        this.scratch.clear();
      }
    }
    this.steps++;
    if (this.steps % TIME_EVERY === 0) this.solver.profileNextStep((p) => (this.profile = p));
    this.solver.step();
    if (this.steps % this.readbackEvery === 0) this.refresh();
  }

  /** Readback of bodies, joints and counters now (tests; the app relies on `step`'s refresh). */
  async sync(): Promise<void> {
    while (this.reading) await new Promise((r) => setTimeout(r, 1));
    this.refresh(true);
    while (this.reading) await new Promise((r) => setTimeout(r, 1));
  }

  private refresh(everything = false): void {
    if (this.reading) return;
    this.reading = true;
    const joints = everything || this.needJoints;
    const poses = joints || this.needPoses || this.bodies.length === 0;
    Promise.all([poses ? this.solver.readBodies() : null, joints ? this.solver.readJoints() : null, this.solver.readCounters()])
      .then(([bodies, jointData, counters]) => {
        if (bodies) this.bodies = bodies;
        const jointStats = bodies && jointData ? this.jointStats(bodies, jointData) : this.cachedStats;
        this.cachedStats = {
          joints: jointStats.joints,
          maxJointError: jointStats.maxJointError,
          contacts: counters.contacts,
          colors: counters.colors,
          clashes: counters.clashes,
          kineticEnergy: bodies ? this.kineticEnergy(bodies) : this.cachedStats.kineticEnergy,
        };
        if (!this.deterministic) this.solver.adapt(counters);
      })
      .catch((e) => {
        // A readback still in flight when the scene is torn down is expected to fail
        if (!this.destroyed) throw e;
      })
      .finally(() => (this.reading = false));
  }

  private kineticEnergy(b: Float32Array): number {
    let e = 0;
    for (let i = 0; i < b.length / BODY_FLOATS; i++) {
      const o = i * BODY_FLOATS;
      const m = b[o + B_SIZE + 3];
      if (m <= 0) continue;
      const v = b.subarray(o + B_VEL, o + B_VEL + 3);
      const w = b.subarray(o + B_ANGVEL, o + B_ANGVEL + 3);
      const I = b.subarray(o + B_MOMENT, o + B_MOMENT + 3);
      e += 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) + 0.5 * (I[0] * w[0] * w[0] + I[1] * w[1] * w[1] + I[2] * w[2] * w[2]);
    }
    return e;
  }

  /** Live joint count and the largest hard ball-socket anchor separation (as the CPU HUD). */
  private jointStats(b: Float32Array, j: Float32Array): { joints: number; maxJointError: number } {
    const info = this.solver.jointInfo();
    const world = (i: number, r: ArrayLike<number>): number[] => {
      const o = i * BODY_FLOATS;
      return rotate(b.subarray(o + B_ROT, o + B_ROT + 4), r).map((x, k) => x + b[o + B_POS + k]);
    };
    let joints = 0;
    let maxJointError = 0;
    for (let c = 0; c < this.solver.jointCount; c++) {
      const o = c * JOINT_FLOATS;
      const stiffLin = j[o + J_PEN_LIN + 3];
      // Joints only, as the CPU HUD counts them (springs live in the same records)
      if (info[c * 4] !== T_JOINT || (stiffLin === 0 && j[o + J_PEN_ANG + 3] === 0)) continue;
      joints++;
      if (c === this.dragSlot || stiffLin < 1e30) continue;
      const a = info[c * 4 + 1];
      const pa = a >= 0 ? world(a, j.subarray(o + J_RA, o + J_RA + 3)) : [...j.subarray(o + J_RA, o + J_RA + 3)];
      const pb = world(info[c * 4 + 2], j.subarray(o + J_RB, o + J_RB + 3));
      maxJointError = Math.max(maxJointError, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
    }
    return { joints, maxJointError };
  }

  position(i: number): ArrayLike<number> {
    return this.bodies.subarray(i * BODY_FLOATS + B_POS, i * BODY_FLOATS + B_POS + 3);
  }
  orientation(i: number): ArrayLike<number> {
    const o = i * BODY_FLOATS + B_ROT;
    return this.bodies.length > o ? this.bodies.subarray(o, o + 4) : [0, 0, 0, 1];
  }
  size(i: number): ArrayLike<number> {
    return this.solver.bodies[i].size;
  }
  isDynamic(i: number): boolean {
    return this.solver.bodies[i].dynamic;
  }
  isSphere(i: number): boolean {
    return this.solver.bodies[i].sphere;
  }
  isLevel(i: number): boolean {
    return this.looks.level[i] === true;
  }
  visual(i: number): Visual | undefined {
    return this.looks.visuals[i];
  }
  springs(): SpringView3D[] {
    return this.looks.springs;
  }
  cloths(): number[][][] {
    return this.looks.cloths;
  }
  ropes(): RopeView3D[] {
    return this.looks.ropes;
  }
  labels(): LabelView3D[] {
    return this.looks.labels;
  }
  stats(): GpuStats3D {
    return { ...this.cachedStats, gpuStepMs: this.profile?.total };
  }

  private radii = new Float32Array(0);
  private radiiKnown = 0;

  /** Bounding radius of each of the first `n` bodies, 0 for static ones (never picked). */
  private pickRadii(n: number): Float32Array {
    if (this.radii.length < n) {
      const radii = new Float32Array(Math.max(n, this.radii.length * 2));
      radii.set(this.radii);
      this.radii = radii;
    }
    for (; this.radiiKnown < n; this.radiiKnown++) {
      const info = this.solver.bodies[this.radiiKnown];
      this.radii[this.radiiKnown] = info.dynamic ? 0.5 * Math.hypot(info.size[0], info.size[1], info.size[2]) : 0;
    }
    return this.radii;
  }

  /** Ray-cast against the last readback (at most READBACK_EVERY steps old). */
  pick(origin: ArrayLike<number>, dir: ArrayLike<number>): PickResult3D | null {
    let best: PickResult3D | null = null;
    const b = this.bodies;
    const n = Math.min(this.bodyCount, b.length / BODY_FLOATS);
    const reach = this.pickRadii(n);
    const [ox, oy, oz, dx, dy, dz] = [origin[0], origin[1], origin[2], dir[0], dir[1], dir[2]];
    for (let i = n - 1; i >= 0; i--) {
      // Bounding sphere first (cheap, and most bodies are nowhere near the ray); static: 0
      const r = reach[i];
      if (r === 0) continue;
      const o0 = i * BODY_FLOATS + B_POS;
      const cx = b[o0] - ox;
      const cy = b[o0 + 1] - oy;
      const cz = b[o0 + 2] - oz;
      const along = cx * dx + cy * dy + cz * dz;
      if (cx * cx + cy * cy + cz * cz - along * along > r * r || along < -r || (best && along - r > best.t)) continue;
      const q = this.orientation(i);
      const p = this.position(i);
      const inv = [-q[0], -q[1], -q[2], q[3]];
      const o = rotate(inv, [origin[0] - p[0], origin[1] - p[1], origin[2] - p[2]]);
      const d = rotate(inv, dir);
      const s = this.size(i);
      let tEnter = 0;
      let tExit = Infinity;
      for (let k = 0; k < 3 && tEnter <= tExit; k++) {
        const half = s[k] * 0.5;
        if (Math.abs(d[k]) < 1e-6) {
          if (Math.abs(o[k]) > half) tEnter = Infinity;
          continue;
        }
        const t0 = (-half - o[k]) / d[k];
        const t1 = (half - o[k]) / d[k];
        tEnter = Math.max(tEnter, Math.min(t0, t1));
        tExit = Math.min(tExit, Math.max(t0, t1));
      }
      if (tEnter > tExit) continue;
      if (!best || tEnter < best.t) best = { body: i, local: [o[0] + d[0] * tEnter, o[1] + d[1] * tEnter, o[2] + d[2] * tEnter], t: tEnter };
    }
    return best;
  }

  addBox(size: ArrayLike<number>, density: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void {
    this.solver.addBody(new Rigid(this.scratch, size, density, friction, position, velocity));
    this.scratch.clear();
  }

  addBall(radius: number, mass: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void {
    const density = mass / ((4 / 3) * Math.PI * radius ** 3);
    const i = this.solver.addBody(sphere(this.scratch, radius, density, friction, position, velocity));
    if (i >= 0) this.looks.visuals[i] = CANNONBALL;
    this.scratch.clear();
  }

  startDrag(body: number, local: ArrayLike<number>, target: ArrayLike<number>): void {
    this.endDrag();
    this.dragSlot = this.solver.appendJoint(-1, body, target, local, DRAG_STIFFNESS, 0);
    this.dragTarget = body;
  }
  moveDrag(target: ArrayLike<number>): void {
    if (this.dragSlot >= 0) this.solver.setWorldAnchor(this.dragSlot, target);
  }
  endDrag(): void {
    if (this.dragSlot >= 0) this.solver.disableConstraint(this.dragSlot);
    this.dragSlot = -1;
    this.dragTarget = -1;
  }

  debugGeometry(): void {
    // Joint lines and contact points would need a readback per frame; the GPU path draws
    // bodies only.
  }

  private destroyed = false;

  destroy(): void {
    this.destroyed = true;
    this.solver.destroy();
  }
}

function rotate(q: ArrayLike<number>, v: ArrayLike<number>): number[] {
  const [x, y, z, w] = [q[0], q[1], q[2], q[3]];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** Scene `name` built into a reference solver (the CPU half of createGpuSim3D). */
export function buildScene3D(name: string, options?: SceneOptions): Solver {
  const ref = new Solver();
  sceneByName3D(name).build(ref, options);
  return ref;
}

/**
 * Build scene `name` for the GPU (from `ref`, if already built by buildScene3D).
 * `allocateBodyBuffer(capacity)` supplies the body buffer (e.g. one a renderer draws from);
 * the solver writes the initial state into it.
 */
export function createGpuSim3D(
  device: GPUDevice,
  name: string,
  params: Partial<GpuParams3D> = {},
  allocateBodyBuffer?: (capacity: number) => GPUBuffer,
  options?: SceneOptions,
  ref: Solver = buildScene3D(name, options),
): GpuSim3D {
  const scene = sceneByName3D(name);
  const opts = { ...scene.options, ...options };
  const emitter = scene.emitter?.(opts) ?? null;
  // Room for the scene's emitted bodies and bodies shot at runtime
  const capacity = ref.bodies.length + (emitter?.bodies ?? 0) + 4096;
  const solver = new GpuSolver3D(device, ref, { bodyBuffer: allocateBodyBuffer?.(capacity), bodyCapacity: capacity, capacity: scene.capacity?.(opts) });
  Object.assign(solver.params, params);
  // The viewer's tags, moved into the solver's (spatially sorted) body order
  const gpu = solver.refToGpu;
  const index = new Map(ref.bodies.map((b, i) => [b, gpu[i]]));
  const visuals: (Visual | undefined)[] = [];
  const level: boolean[] = [];
  ref.bodies.forEach((b, i) => {
    visuals[gpu[i]] = visualOf(b);
    level[gpu[i]] = Math.abs(b.positionAng[3]) > 0.9999;
  });
  const springs = ref.forces.filter((f): f is Spring => f instanceof Spring).map((f) => ({ a: index.get(f.bodyA!)!, b: index.get(f.bodyB)!, rA: f.rA, rB: f.rB }));
  const cloths = clothsOf(ref).map((grid) => grid.map((row) => row.map((b) => index.get(b)!)));
  const ropes = ropesOf(ref).map((r) => ({ ...r, links: r.links.map((b) => index.get(b)!) }));
  const labels = labelsOf(ref).map((l) => ({ bodies: l.bodies.map((b) => index.get(b)!), text: l.text }));
  return new GpuSim3D(solver, { visuals, level, springs, cloths, ropes, labels }, emitter, scene.capacity !== undefined);
}
