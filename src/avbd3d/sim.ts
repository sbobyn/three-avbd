// A common face over the 3D solvers (CPU reference, WebGPU in ./gpu) so the app and tests can
// drive either, and the scene registry: the demo's scenes plus the GPU-only showcase scenes.

import { gpuScenes3D, type Scene3D } from './bench-scenes.ts';
import { Rigid } from './ref/body.ts';
import { Joint, Spring } from './ref/forces.ts';
import { Manifold } from './ref/manifold.ts';
import { addScaled3, lengthSq, transform, vec3 } from './ref/math.ts';
import { scenes } from './ref/scenes.ts';
import { Solver, type SolverParams } from './ref/solver.ts';

export interface SimStats3D {
  joints: number;
  contacts: number;
  kineticEnergy: number;
  maxJointError: number;
}

export interface PickResult3D {
  body: number;
  /** Hit point in the body's local frame. */
  local: [number, number, number];
  /** Distance along the (unit) ray. */
  t: number;
}

export interface Sim3D {
  readonly label: string;
  readonly params: SolverParams;
  readonly bodyCount: number;
  step(): void;
  position(i: number): ArrayLike<number>;
  /** Orientation quaternion (x, y, z, w). */
  orientation(i: number): ArrayLike<number>;
  size(i: number): ArrayLike<number>;
  isDynamic(i: number): boolean;
  /** Spheres exist on the GPU solver only (../shapes.ts); everything else is a box. */
  isSphere?(i: number): boolean;
  stats(): SimStats3D;
  /** Ray-cast the dynamic bodies; `dir` must be unit length. */
  pick(origin: ArrayLike<number>, dir: ArrayLike<number>): PickResult3D | null;
  addBox(size: ArrayLike<number>, density: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void;
  /** Mouse drag: a soft world joint from `target` to the body-local point `local`. */
  startDrag(body: number, local: ArrayLike<number>, target: ArrayLike<number>): void;
  moveDrag(target: ArrayLike<number>): void;
  endDrag(): void;
  readonly dragBody: number;
  /** World-space segments (6 numbers each) for joints/springs, and contact points (3 each). */
  debugGeometry(lines: number[], points: number[]): void;
}

/** The demo's mouse spring: stiff linear rows, free rotation. */
export const DRAG_STIFFNESS = 5000;

export class RefSim3D implements Sim3D {
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
  position(i: number): ArrayLike<number> {
    return this.solver.bodies[i].positionLin;
  }
  orientation(i: number): ArrayLike<number> {
    return this.solver.bodies[i].positionAng;
  }
  size(i: number): ArrayLike<number> {
    return this.solver.bodies[i].size;
  }
  isDynamic(i: number): boolean {
    return this.solver.bodies[i].mass > 0;
  }

  stats(): SimStats3D {
    let joints = 0;
    let contacts = 0;
    let maxJointError = 0;
    const c = vec3();
    for (const f of this.solver.forces) {
      if (f instanceof Joint) {
        joints++;
        if (f !== this.drag && f.stiffnessLin === Infinity) maxJointError = Math.max(maxJointError, Math.sqrt(lengthSq(f.evaluateLin(c))));
      } else if (f instanceof Manifold) contacts += f.numContacts;
    }
    let kineticEnergy = 0;
    for (const b of this.solver.bodies) {
      if (b.mass <= 0) continue;
      const w = b.velocityAng;
      kineticEnergy += 0.5 * b.mass * lengthSq(b.velocityLin) + 0.5 * (b.moment[0] * w[0] * w[0] + b.moment[1] * w[1] * w[1] + b.moment[2] * w[2] * w[2]);
    }
    return { joints, contacts, kineticEnergy, maxJointError };
  }

  pick(origin: ArrayLike<number>, dir: ArrayLike<number>): PickResult3D | null {
    const hit = this.solver.pick(origin, dir);
    return hit ? { body: this.solver.bodies.indexOf(hit.body), local: [hit.local[0], hit.local[1], hit.local[2]], t: hit.t } : null;
  }

  addBox(size: ArrayLike<number>, density: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void {
    new Rigid(this.solver, size, density, friction, position, velocity);
  }

  startDrag(body: number, local: ArrayLike<number>, target: ArrayLike<number>): void {
    this.endDrag();
    this.drag = new Joint(this.solver, null, this.solver.bodies[body], target, local, DRAG_STIFFNESS, 0);
  }
  moveDrag(target: ArrayLike<number>): void {
    this.drag?.rA.set([target[0], target[1], target[2]]);
  }
  endDrag(): void {
    this.drag?.destroy();
    this.drag = null;
  }

  debugGeometry(lines: number[], points: number[]): void {
    const a = vec3();
    const b = vec3();
    for (const f of this.solver.forces) {
      if (f instanceof Joint || f instanceof Spring) {
        // Body centre to anchor on each side, so coincident joint anchors stay visible
        const bodyA = f.bodyA;
        if (bodyA) {
          transform(a, bodyA.positionLin, bodyA.positionAng, f.rA);
          lines.push(...bodyA.positionLin, ...a);
        } else a.set(f.rA);
        transform(b, f.bodyB.positionLin, f.bodyB.positionAng, f.rB);
        lines.push(...f.bodyB.positionLin, ...b);
        if (f instanceof Spring || !bodyA) lines.push(...a, ...b);
      } else if (f instanceof Manifold) {
        const bodyA = f.bodyA!;
        for (const c of f.contacts) {
          transform(a, bodyA.positionLin, bodyA.positionAng, c.rA);
          points.push(a[0], a[1], a[2]);
        }
      }
    }
  }
}

export const allScenes3D: Scene3D[] = [...scenes, ...gpuScenes3D];

export const sceneByName3D = (name: string): Scene3D => {
  const scene = allScenes3D.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown scene ${name}`);
  return scene;
};

export function createSim3D(scene: string, params: Partial<SolverParams> = {}): Sim3D {
  const def = sceneByName3D(scene);
  if (def.gpuOnly) throw new Error(`${scene} needs the WebGPU solver`);
  const solver = new Solver();
  def.build(solver);
  Object.assign(solver, params);
  return new RefSim3D(solver);
}

/** Point `distance` along a ray. */
export const along = (origin: ArrayLike<number>, dir: ArrayLike<number>, distance: number): Float64Array =>
  addScaled3(vec3(), origin, dir, distance);
