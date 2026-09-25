// A common face over the 2D solvers so the app and the behaviour tests can drive any of them
// (reference CPU, GPU-shaped CPU, and later WebGPU). Scenes are always built with the
// reference builders, then loaded into the chosen backend.

import { Rigid } from './ref/body.ts';
import { Joint, Spring } from './ref/forces.ts';
import { Manifold } from './ref/manifold.ts';
import { countForces, kineticEnergy, maxJointError } from './ref/metrics.ts';
import { benchScenes, type SceneDef } from './bench-scenes.ts';
import { customScene2D } from './custom.ts';
import { scenes } from './ref/scenes.ts';
import { Solver, type SolverParams } from './ref/solver.ts';
import { CS, INFO_STRIDE, type JointHandle, RA, RB, SoaSolver2D, type SoaOptions, STIFF, T_CONTACT, T_JOINT, T_SPRING } from './soa/solver.ts';

export interface SimStats {
  joints: number;
  contacts: number;
  kineticEnergy: number;
  maxJointError: number;
  colors?: number;
  colorConflicts?: number;
  colorRounds?: number;
  /** GPU backends: wall time of one step on the GPU, measured asynchronously. */
  gpuStepMs?: number;
}

export interface Sim2D {
  readonly label: string;
  readonly params: SolverParams;
  readonly bodyCount: number;
  step(): void;
  /** Pose (x, y, angle) of body i. */
  pose(i: number): [number, number, number];
  velocity(i: number): [number, number, number];
  size(i: number): [number, number];
  isDynamic(i: number): boolean;
  stats(): SimStats;
  pick(x: number, y: number): { body: number; local: [number, number] } | null;
  addBox(size: [number, number], density: number, friction: number, pose: [number, number, number], velocity: [number, number, number]): void;
  /** Mouse drag: a soft world joint from `world` to the body-local point `local`. */
  startDrag(body: number, local: [number, number], world: [number, number]): void;
  moveDrag(x: number, y: number): void;
  endDrag(): void;
  readonly dragBody: number;
  /** World-space segments (x0, y0, x1, y1) for joints/springs and contact points (x, y). */
  debugGeometry(lines: number[], points: number[]): void;
}

export const DRAG_STIFFNESS: [number, number, number] = [1000, 1000, 0];

export class RefSim implements Sim2D {
  readonly label = 'Reference (CPU)';
  readonly solver: Solver;
  private drag: Joint | null = null;

  constructor(solver: Solver) {
    this.solver = solver;
  }

  get params(): SolverParams {
    return this.solver;
  }
  get bodyCount(): number {
    return this.solver.bodies.length;
  }
  get dragBody(): number {
    return this.drag ? this.solver.bodies.indexOf(this.drag.bodyB) : -1;
  }
  step(): void {
    this.solver.step();
  }
  pose(i: number): [number, number, number] {
    const p = this.solver.bodies[i].position;
    return [p[0], p[1], p[2]];
  }
  velocity(i: number): [number, number, number] {
    const v = this.solver.bodies[i].velocity;
    return [v[0], v[1], v[2]];
  }
  size(i: number): [number, number] {
    return this.solver.bodies[i].size;
  }
  isDynamic(i: number): boolean {
    return this.solver.bodies[i].mass > 0;
  }
  stats(): SimStats {
    const counts = countForces(this.solver);
    return {
      joints: counts.joints,
      contacts: counts.contacts,
      kineticEnergy: kineticEnergy(this.solver),
      maxJointError: maxJointError(this.solver),
    };
  }
  pick(x: number, y: number) {
    const hit = this.solver.pick(x, y);
    return hit ? { body: this.solver.bodies.indexOf(hit.body), local: hit.local } : null;
  }
  addBox(size: [number, number], density: number, friction: number, pose: [number, number, number], velocity: [number, number, number]): void {
    new Rigid(this.solver, size, density, friction, pose, velocity);
  }
  startDrag(body: number, local: [number, number], world: [number, number]): void {
    this.endDrag();
    this.drag = new Joint(this.solver, null, this.solver.bodies[body], world, local, DRAG_STIFFNESS);
  }
  moveDrag(x: number, y: number): void {
    if (this.drag) this.drag.rA = [x, y];
  }
  endDrag(): void {
    this.drag?.destroy();
    this.drag = null;
  }
  debugGeometry(lines: number[], points: number[]): void {
    for (const f of this.solver.forces) {
      if (f instanceof Joint || f instanceof Spring) {
        const a = f.bodyA ? worldPoint(f.bodyA.position, f.rA[0], f.rA[1]) : f.rA;
        const b = worldPoint(f.bodyB.position, f.rB[0], f.rB[1]);
        lines.push(a[0], a[1], b[0], b[1]);
      } else if (f instanceof Manifold) {
        for (const c of f.contacts) {
          const pa = worldPoint(f.bodyA!.position, c.rA[0], c.rA[1]);
          const pb = worldPoint(f.bodyB.position, c.rB[0], c.rB[1]);
          points.push(pa[0], pa[1], pb[0], pb[1]);
        }
      }
    }
  }
}

export class SoaSim implements Sim2D {
  readonly label: string;
  readonly solver: SoaSolver2D;
  private drag: JointHandle | null = null;
  private dragTarget = -1;

  constructor(solver: SoaSolver2D, label: string) {
    this.solver = solver;
    this.label = label;
  }

  get params(): SolverParams {
    return this.solver.params;
  }
  get bodyCount(): number {
    return this.solver.bodyCount;
  }
  get dragBody(): number {
    return this.drag?.alive ? this.dragTarget : -1;
  }
  step(): void {
    this.solver.step();
  }
  pose(i: number): [number, number, number] {
    const p = this.solver.pose;
    return [p[i * 4], p[i * 4 + 1], p[i * 4 + 2]];
  }
  velocity(i: number): [number, number, number] {
    const v = this.solver.velocity;
    return [v[i * 4], v[i * 4 + 1], v[i * 4 + 2]];
  }
  size(i: number): [number, number] {
    return [this.solver.shape[i * 4], this.solver.shape[i * 4 + 1]];
  }
  isDynamic(i: number): boolean {
    return this.solver.dynamic[i] === 1;
  }
  stats(): SimStats {
    const s = this.solver;
    let joints = 0;
    for (let c = 0; c < s.jointCount; c++) if (s.info[c * INFO_STRIDE] === T_JOINT) joints++;
    return {
      joints,
      contacts: s.contactCount,
      kineticEnergy: s.kineticEnergy(),
      maxJointError: s.maxJointError(),
      colors: s.options.order === 'colored' ? s.numColors : undefined,
      colorConflicts: s.options.order === 'colored' ? s.colorConflicts : undefined,
      colorRounds: s.options.order === 'colored' ? s.colorRounds : undefined,
    };
  }
  pick(x: number, y: number) {
    return this.solver.pick(x, y);
  }
  addBox(size: [number, number], density: number, friction: number, pose: [number, number, number], velocity: [number, number, number]): void {
    this.solver.addBody(size, density, friction, pose, velocity);
  }
  startDrag(body: number, local: [number, number], world: [number, number]): void {
    this.endDrag();
    this.drag = this.solver.addJoint(-1, body, world, local, DRAG_STIFFNESS);
    this.dragTarget = body;
  }
  moveDrag(x: number, y: number): void {
    if (this.drag) this.solver.setJointWorldAnchor(this.drag, x, y);
  }
  endDrag(): void {
    if (this.drag) this.solver.removeJoint(this.drag);
    this.drag = null;
    this.dragTarget = -1;
  }
  debugGeometry(lines: number[], points: number[]): void {
    const s = this.solver;
    const total = s.jointCount + s.contactCount;
    for (let c = 0; c < total; c++) {
      const type = s.info[c * INFO_STRIDE];
      const a = s.info[c * INFO_STRIDE + 1];
      const b = s.info[c * INFO_STRIDE + 2];
      const o = c * CS;
      if (type === T_JOINT || type === T_SPRING) {
        // Joints disabled this step (fractured, released drag) are dropped next step
        if (type === T_JOINT && s.data[o + STIFF] === 0 && s.data[o + STIFF + 1] === 0 && s.data[o + STIFF + 2] === 0) continue;
        const pa = a >= 0 ? worldPoint(s.pose.subarray(a * 4), s.data[o + RA], s.data[o + RA + 1]) : [s.data[o + RA], s.data[o + RA + 1]];
        const pb = worldPoint(s.pose.subarray(b * 4), s.data[o + RB], s.data[o + RB + 1]);
        lines.push(pa[0], pa[1], pb[0], pb[1]);
      } else if (type === T_CONTACT) {
        const pa = worldPoint(s.pose.subarray(a * 4), s.data[o + RA], s.data[o + RA + 1]);
        const pb = worldPoint(s.pose.subarray(b * 4), s.data[o + RB], s.data[o + RB + 1]);
        points.push(pa[0], pa[1], pb[0], pb[1]);
      }
    }
  }
}

function worldPoint(p: ArrayLike<number>, x: number, y: number): [number, number] {
  const c = Math.cos(p[2]);
  const s = Math.sin(p[2]);
  return [c * x - s * y + p[0], s * x + c * y + p[1]];
}

export type Backend2D = 'ref' | 'soa-seq' | 'soa-colored' | 'gpu';

export const BACKENDS: Record<Backend2D, string> = {
  ref: 'Reference (CPU, demo port)',
  'soa-seq': 'SoA CPU, sequential f64',
  'soa-colored': 'SoA CPU, coloured f32 (GPU order)',
  gpu: 'WebGPU (whole step on the GPU)',
};

/** The CPU backends (`gpu` is built by gpu/sim.ts createGpuSim, which needs a device). */
export type CpuBackend2D = Exclude<Backend2D, 'gpu'>;

/** Demo scenes followed by the scalable benchmark scenes. */
export const allScenes2D: SceneDef[] = [...scenes, ...benchScenes, customScene2D];

export function sceneByName(name: string): SceneDef {
  const scene = allScenes2D.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown scene ${name}`);
  return scene;
}

/** Build `sceneName` on a fresh CPU backend, applying `params` before the scene is built. */
export function createSim(backend: CpuBackend2D, sceneName: string, params: Partial<SolverParams> = {}): Sim2D {
  const scene = sceneByName(sceneName);
  const options: Partial<SoaOptions> = backend === 'soa-seq' ? { precision: 'f64', order: 'sequential' } : { precision: 'f32', order: 'colored' };
  if (!scene.build) {
    if (backend === 'ref') throw new Error(`${sceneName} has no reference build`);
    const soa = new SoaSolver2D(options);
    scene.buildSoa!(soa);
    Object.assign(soa.params, params);
    return new SoaSim(soa, BACKENDS[backend]);
  }
  const ref = new Solver();
  Object.assign(ref, params);
  scene.build(ref);
  if (backend === 'ref') return new RefSim(ref);
  const soa = new SoaSolver2D(options);
  soa.loadFromReference(ref);
  return new SoaSim(soa, BACKENDS[backend]);
}
