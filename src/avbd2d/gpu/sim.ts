// Sim2D adapter over the WebGPU solver. Bodies live on the GPU, so the synchronous Sim2D
// queries (poses for picking, stats for the HUD) are served from a readback that is refreshed
// asynchronously every few steps; rendering reads the GPU body buffer directly instead.

import type { SolverParams } from '../ref/solver.ts';
import { parallelParams, Solver } from '../ref/solver.ts';
import { DRAG_STIFFNESS, type Sim2D, type SimStats, sceneByName } from '../sim.ts';
import { SoaSolver2D } from '../soa/solver.ts';
import { BODY_FLOATS } from './layout.ts';
import { GpuSolver2D } from './solver.ts';

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
    if (this.steps % TIME_EVERY === 0) this.solver.timeNextStep((ms) => (this.gpuStepMs = ms));
    this.solver.step();
    if (this.steps % READBACK_EVERY === 0) this.refresh();
  }

  /** Kick off a readback of poses and stats unless one is already in flight. */
  private refresh(): void {
    if (this.reading) return;
    this.reading = true;
    Promise.all([this.solver.readBodies(), this.solver.readStats(), this.solver.readCounters()])
      .then(([bodies, stats, counters]) => {
        this.poses = bodies;
        this.cachedStats = {
          ...stats,
          contacts: counters.contacts,
          colors: counters.colors,
          colorConflicts: counters.clashes,
          colorRounds: this.solver.colorRounds,
        };
        // Grow the colour cap / contact storage if the GPU is getting close to the limits
        this.solver.adapt(counters);
      })
      .finally(() => (this.reading = false));
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

/**
 * Build `sceneName` for the GPU. `allocateBodyBuffer(capacity)` supplies the body buffer (e.g.
 * one a renderer draws from); the solver writes the initial state into it.
 */
export function createGpuSim(
  device: GPUDevice,
  sceneName: string,
  params: Partial<SolverParams>,
  allocateBodyBuffer?: (bodyCount: number) => GPUBuffer,
): GpuSim {
  const scene = sceneByName(sceneName);
  const mirror = new SoaSolver2D();
  if (scene.buildSoa) {
    scene.buildSoa(mirror);
  } else {
    const ref = new Solver();
    scene.build!(ref);
    mirror.loadFromReference(ref);
  }
  Object.assign(mirror.params, parallelParams(), params);
  // Room for bodies spawned at runtime
  const capacity = mirror.bodyCount + 4096;
  const solver = new GpuSolver2D(device, mirror, { bodyBuffer: allocateBodyBuffer?.(capacity), bodyCapacity: capacity });
  return new GpuSim(solver);
}
