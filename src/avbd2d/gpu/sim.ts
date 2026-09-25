// Sim2D adapter over the WebGPU solver. Bodies live on the GPU, so the synchronous Sim2D
// queries (poses for picking, stats for the HUD) are served from a readback that is refreshed
// asynchronously every few steps; rendering reads the GPU body buffer directly instead.

import type { SolverParams } from '../ref/solver.ts';
import { parallelParams, Solver } from '../ref/solver.ts';
import { DRAG_STIFFNESS, type Sim2D, type SimStats, sceneByName } from '../sim.ts';
import { SoaSolver2D } from '../soa/solver.ts';
import { BODY_FLOATS } from './layout.ts';
import { GpuSolver2D, type StepProfile } from './solver.ts';

/** Steps between asynchronous readbacks of body poses and stats. */
const READBACK_EVERY = 10;
/** Steps between GPU step timings. */
const TIME_EVERY = 30;

export class GpuSim implements Sim2D {
  readonly label = 'WebGPU';
  readonly solver: GpuSolver2D;
  private poses: Float32Array = new Float32Array(0);
  private cachedStats: SimStats = { joints: 0, contacts: 0, kineticEnergy: 0, maxJointError: 0 };
  private steps = 0;
  private reading = false;
  private dragSlot = -1;
  private dragTarget = -1;
  private gpuStepMs: number | undefined;
  /** Latest per-phase GPU timing (timestamp queries), refreshed every TIME_EVERY steps. */
  profile: StepProfile | null = null;

  constructor(solver: GpuSolver2D) {
    this.solver = solver;
    this.refresh();
  }

  get params(): SolverParams {
    return this.solver.params;
  }
  get bodyCount(): number {
    return this.solver.bodyCount;
  }
  get dragBody(): number {
    return this.dragTarget;
  }

  step(): void {
    this.steps++;
    if (this.steps % TIME_EVERY === 0) {
      this.solver.profileNextStep((profile) => {
        this.gpuStepMs = profile.total;
        this.profile = profile;
      });
    }
    this.solver.step();
    if (this.steps % READBACK_EVERY === 0) this.refresh();
  }

  /**
   * What the periodic readback copies besides the counters (which the solver's adapt needs):
   * poses (picking) and stats (kinetic energy, joint error: the detailed HUD). Poses are the
   * whole body buffer (25 MB at 262k bodies), so the app asks only when it needs them.
   */
  needPoses = true;
  needStats = true;

  /** Kick off a readback of poses and stats unless one is already in flight. */
  private refresh(): void {
    if (this.reading) return;
    this.reading = true;
    const poses = this.needPoses || this.needStats || this.poses.length === 0;
    Promise.all([poses ? this.solver.readBodies() : null, this.solver.readCounters()])
      .then(async ([bodies, counters]) => {
        if (bodies) this.poses = bodies;
        const stats = this.needStats && bodies ? await this.solver.readStats(bodies) : this.cachedStats;
        this.cachedStats = {
          kineticEnergy: stats.kineticEnergy,
          maxJointError: stats.maxJointError,
          joints: stats.joints,
          contacts: counters.contacts,
          colors: counters.colors,
          colorConflicts: counters.clashes,
          colorRounds: this.solver.colorRounds,
        };
        // Grow the colour cap / contact storage if the GPU is getting close to the limits
        this.solver.adapt(counters);
      })
      .catch((e) => {
        // A readback still in flight when the scene is torn down is expected to fail
        if (!this.destroyed) throw e;
      })
      .finally(() => (this.reading = false));
  }

  private destroyed = false;

  /** Free the solver's GPU buffers (the scene is being replaced). */
  destroy(): void {
    this.destroyed = true;
    this.solver.destroy();
  }

  pose(i: number): [number, number, number] {
    const o = i * BODY_FLOATS;
    return [this.poses[o] ?? 0, this.poses[o + 1] ?? 0, this.poses[o + 2] ?? 0];
  }
  velocity(i: number): [number, number, number] {
    const o = i * BODY_FLOATS + 12;
    return [this.poses[o] ?? 0, this.poses[o + 1] ?? 0, this.poses[o + 2] ?? 0];
  }
  size(i: number): [number, number] {
    const shape = this.solver.topology.shape;
    return [shape[i * 4], shape[i * 4 + 1]];
  }
  isDynamic(i: number): boolean {
    return this.solver.topology.dynamic[i] === 1;
  }
  stats(): SimStats {
    return { ...this.cachedStats, gpuStepMs: this.gpuStepMs };
  }

  /** Picks against the last readback (at most READBACK_EVERY steps old). */
  pick(x: number, y: number): { body: number; local: [number, number] } | null {
    for (let i = this.bodyCount - 1; i >= 0; i--) {
      const [px, py, a] = this.pose(i);
      const c = Math.cos(-a);
      const s = Math.sin(-a);
      const lx = c * (x - px) - s * (y - py);
      const ly = s * (x - px) + c * (y - py);
      const [w, h] = this.size(i);
      if (Math.abs(lx) <= w * 0.5 && Math.abs(ly) <= h * 0.5) return { body: i, local: [lx, ly] };
    }
    return null;
  }

  addBox(size: [number, number], density: number, friction: number, pose: [number, number, number], velocity: [number, number, number]): void {
    this.solver.addBody(size, density, friction, pose, velocity);
  }

  startDrag(body: number, local: [number, number], world: [number, number]): void {
    this.endDrag();
    this.dragSlot = this.solver.appendJoint(-1, body, world, local, DRAG_STIFFNESS);
    this.dragTarget = body;
  }
  moveDrag(x: number, y: number): void {
    if (this.dragSlot >= 0) this.solver.setWorldAnchor(this.dragSlot, x, y);
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
}

/** `sceneName` built into the CPU mirror the GPU solver starts from (createGpuSim's CPU half). */
export function buildScene2D(sceneName: string): SoaSolver2D {
  const scene = sceneByName(sceneName);
  const mirror = new SoaSolver2D();
  if (scene.buildSoa) {
    scene.buildSoa(mirror);
  } else {
    const ref = new Solver();
    scene.build!(ref);
    mirror.loadFromReference(ref);
  }
  return mirror;
}

/**
 * Build `sceneName` for the GPU (from `mirror`, if already built by buildScene2D).
 * `allocateBodyBuffer(capacity)` supplies the body buffer (e.g. one a renderer draws from); the
 * solver writes the initial state into it.
 */
export function createGpuSim(
  device: GPUDevice,
  sceneName: string,
  params: Partial<SolverParams>,
  allocateBodyBuffer?: (bodyCount: number) => GPUBuffer,
  mirror: SoaSolver2D = buildScene2D(sceneName),
): GpuSim {
  Object.assign(mirror.params, parallelParams(), params);
  // Room for bodies spawned at runtime
  const capacity = mirror.bodyCount + 4096;
  const solver = new GpuSolver2D(device, mirror, { bodyBuffer: allocateBodyBuffer?.(capacity), bodyCapacity: capacity });
  return new GpuSim(solver);
}
