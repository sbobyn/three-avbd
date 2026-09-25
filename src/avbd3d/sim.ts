// A common face over the 3D solvers (CPU reference, WebGPU in ./gpu) so the app and tests can
// drive either, and the scene registry: the demo's scenes plus the GPU-only showcase scenes.

import { type CameraView, gpuScenes3D, hangingRope, type Scene3D, type SceneOptions } from './bench-scenes.ts';
import { CUSTOM_3D } from './custom.ts';
import { Rigid } from './ref/body.ts';
import { Joint, Spring } from './ref/forces.ts';
import { Manifold } from './ref/manifold.ts';
import { addScaled3, lengthSq, transform, vec3 } from './ref/math.ts';
import { scenes } from './ref/scenes.ts';
import { Solver, type SolverParams } from './ref/solver.ts';
import { addLabel, clothsOf, labelsOf, type RopeStyle, ropesOf, setVisual, type Visual, visualOf } from './visuals.ts';

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

/** A rope through a chain of bodies (for drawing). */
export interface RopeView3D extends RopeStyle {
  links: number[];
  color: number;
}

/** A caption over body `bodies[0]`, or the midpoint of two (for drawing). */
export interface LabelView3D {
  bodies: number[];
  text: string;
}

/** A spring between bodies `a` and `b`, anchored at body-local points (for drawing). */
export interface SpringView3D {
  a: number;
  b: number;
  rA: ArrayLike<number>;
  rB: ArrayLike<number>;
}

/** Paint of shot cannonballs. */
export const CANNONBALL: Visual = { color: 0x3a3d42 };

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
  /** Level (unrotated) as built: a static slab that is can be the floor (a ramp can't). */
  isLevel(i: number): boolean;
  /** How the scene asked for body `i` to be drawn (./visuals.ts). */
  visual(i: number): Visual | undefined;
  springs(): SpringView3D[];
  /** Cloth sheets: grids of body indices. */
  cloths(): number[][][];
  ropes(): RopeView3D[];
  labels(): LabelView3D[];
  stats(): SimStats3D;
  /** Ray-cast the dynamic bodies; `dir` must be unit length. */
  pick(origin: ArrayLike<number>, dir: ArrayLike<number>): PickResult3D | null;
  addBox(size: ArrayLike<number>, density: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void;
  /** A cannonball: a sphere where the solver has them, else a box as wide. */
  /** A cannonball of `mass` kg. */
  addBall(radius: number, mass: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void;
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
  isLevel(i: number): boolean {
    return Math.abs(this.solver.bodies[i].positionAng[3]) > 0.9999;
  }
  visual(i: number): Visual | undefined {
    return visualOf(this.solver.bodies[i]);
  }
  springs(): SpringView3D[] {
    const index = new Map(this.solver.bodies.map((b, i) => [b, i]));
    return this.solver.forces.filter((f): f is Spring => f instanceof Spring).map((f) => ({ a: index.get(f.bodyA!)!, b: index.get(f.bodyB)!, rA: f.rA, rB: f.rB }));
  }
  cloths(): number[][][] {
    const index = new Map(this.solver.bodies.map((b, i) => [b, i]));
    return clothsOf(this.solver).map((grid) => grid.map((row) => row.map((b) => index.get(b)!)));
  }
  ropes(): RopeView3D[] {
    const index = new Map(this.solver.bodies.map((b, i) => [b, i]));
    return ropesOf(this.solver).map((r) => ({ ...r, links: r.links.map((b) => index.get(b)!) }));
  }
  labels(): LabelView3D[] {
    const index = new Map(this.solver.bodies.map((b, i) => [b, i]));
    return labelsOf(this.solver).map((l) => ({ bodies: l.bodies.map((b) => index.get(b)!), text: l.text }));
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
  addBall(radius: number, mass: number, friction: number, position: ArrayLike<number>, velocity: ArrayLike<number>): void {
    // The reference has boxes only
    const d = 2 * radius;
    setVisual(new Rigid(this.solver, [d, d, d], mass / d ** 3, friction, position, velocity), CANNONBALL);
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

const dynamic = (solver: Solver) => solver.bodies.filter((b) => b.mass > 0);
/** Two significant digits at most: 0.275 → 0.28, 5 → 5. */
const short = (x: number) => Number(x.toPrecision(2)).toString();
/** Captions for what the demo's scenes vary: friction, mass, stiffness. */
const LOOKS: Record<string, (solver: Solver) => void> = {
  'Dynamic Friction': (solver) => dynamic(solver).forEach((b) => addLabel(solver, [b], `μ ${short(b.friction)}`)),
  'Static Friction': (solver) => dynamic(solver).forEach((b) => addLabel(solver, [b], `μ ${short(b.friction)}`)),
  'Stack Ratio': (solver) => dynamic(solver).forEach((b) => addLabel(solver, [b], `${b.mass.toLocaleString('en')} kg`)),
  'Spring Ratio': (solver) => {
    for (const f of solver.forces) if (f instanceof Spring) addLabel(solver, [f.bodyA!, f.bodyB], `k ${f.stiffness.toLocaleString('en')}`);
  },
};
/** Closer framings than the demo's one camera for its small scenes. */
const CAMERAS: Record<string, CameraView> = {
  Rope: { distance: 48, target: [0.5, 0, 0] },
  'Heavy Rope': { distance: 58, target: [0.5, 0, -3] },
  Spring: { distance: 18, target: [0, 0, 10] },
  Pyramid: { distance: 30, target: [0, 0, 5], elevation: 0.25 },
  Stack: { distance: 26, target: [0, 0, 7], elevation: 0.3 },
  'Stack Ratio': { distance: 34, target: [0, 0, 7], elevation: 0.3 },
  'Static Friction': { distance: 36, target: [-9, 0, 7], azimuth: 20, elevation: 0.35 },
  Bridge: { distance: 40, target: [0, 0, 8] },
  Breakable: { distance: 18, target: [0, 0, 4] },
  'Soft Body': { distance: 20, target: [0, 0, 6] },
  Ground: { distance: 14, target: [0, 0, 1.5] },
  'Dynamic Friction': { distance: 34, target: [8, -20, 0], azimuth: -150, elevation: 0.55 },
  'Spring Ratio': { distance: 30, target: [0, 0, 7] },
};

export const allScenes3D: Scene3D[] = [
  ...scenes.map((s): Scene3D => {
    // The rope, adjustable, built by the viewer (at its defaults, the demo's with one more link)
    if (s.name === 'Rope') {
      return { ...s, build: (solver, o) => hangingRope(solver, o?.length, o?.links, o?.weight), options: { length: 20, links: 20, weight: 0 }, camera: CAMERAS[s.name] };
    }
    // The demo's heavy rope: 18 links of 1 m and a 5 m block 500 times a link's mass
    if (s.name === 'Heavy Rope') return { ...s, build: (solver) => hangingRope(solver, 18, 18, 500, 5), camera: CAMERAS[s.name] };
    const look = LOOKS[s.name];
    return { ...s, build: look ? (solver: Solver) => (s.build(solver), look(solver)) : s.build, camera: CAMERAS[s.name] };
  }),
  ...gpuScenes3D,
  {
    // Any showcase scene at a chosen size (./custom.ts; the viewer's panel sets the options)
    name: 'Custom',
    build: (solver, o) => CUSTOM_3D[o?.kind ?? 0].build(solver, o?.bodies ?? 20_000),
    options: { kind: 0, bodies: 20_000 },
    camera: (o) => CUSTOM_3D[o.kind].camera(o.bodies),
    params: (o) => CUSTOM_3D[o.kind].params ?? {},
    gpuOnly: true,
  },
];

export const sceneByName3D = (name: string): Scene3D => {
  const scene = allScenes3D.find((s) => s.name === name);
  if (!scene) throw new Error(`unknown scene ${name}`);
  return scene;
};

export function createSim3D(scene: string, params: Partial<SolverParams> = {}, options?: SceneOptions): Sim3D {
  const def = sceneByName3D(scene);
  if (def.gpuOnly) throw new Error(`${scene} needs the WebGPU solver`);
  const solver = new Solver();
  def.build(solver, options);
  Object.assign(solver, params);
  return new RefSim3D(solver);
}

/** Point `distance` along a ray. */
export const along = (origin: ArrayLike<number>, dir: ArrayLike<number>, distance: number): Float64Array =>
  addScaled3(vec3(), origin, dir, distance);
