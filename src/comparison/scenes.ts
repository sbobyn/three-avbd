// A serializable scene shared by both engines. Existing showcase builders only supply initial
// conditions; neither engine's stepping or collision code is used to generate the other input.
import { boxPile, brickRing } from '../avbd3d/bench-scenes.ts';
import { Joint, IgnoreCollision } from '../avbd3d/ref/forces.ts';
import { Rigid } from '../avbd3d/ref/body.ts';
import { Solver } from '../avbd3d/ref/solver.ts';
import { isSphere, sphere } from '../avbd3d/shapes.ts';

export interface BodySpec {
  shape: 'box' | 'sphere';
  size: number[];
  position: number[];
  rotation: number[];
  velocity: number[];
  angularVelocity: number[];
  mass: number;
  inertia: number[];
  friction: number;
}
export interface JointSpec { a: number; b: number; anchorA: number[]; anchorB: number[]; }
export interface Scene {
  joints?: JointSpec[];
  name: string;
  seed: number | null;
  up: 'z';
  gravity: number;
  groundTop: number;
  bodies: BodySpec[];
}
export const CASES = ['impact-train', 'free-fall', 'slide', 'spin', 'rest-grid-100', 'rest-grid-1k', 'rest-grid-10k', 'stack-50', 'stack-heavy', 'chain-20', 'chain-heavy', 'sphere-pile-100', 'sphere-pile-hcp-100', 'impact-graze', 'impact-rotate', 'impact-1', 'impact-100', 'impact-1000', 'drop-box', 'rest-stack', 'pile-100', 'pile-1k', 'pile-10k', 'pile-1k-settled', 'pile-10k-settled', 'ring-9k', 'ring-110k'] as const;
export type CaseName = (typeof CASES)[number];

/**
 * What a resting or pile scene can support. `valid` scenes start with no interpenetration and
 * have a stable rest state, reached as built or (Rapier, CPU) within `lead` steps at 1/60 s;
 * only they back resting-quality claims. Whether an engine settles one is the measurement. `sphere-pile-100` is 25 single-file sphere columns, an unstable equilibrium that any
 * perturbation topples. The original piles start overlapping and their default 60 + 120 step
 * window ends mid-collapse in both engines. Both stay for continuity with earlier reports.
 */
export const SCENE_VALIDITY: Partial<Record<CaseName, {
  kind: 'rest' | 'pile'; status: 'valid' | 'unstable equilibrium' | 'mid-collapse window'; lead?: number; steps?: number;
}>> = {
  'rest-stack': { kind: 'rest', status: 'valid' },
  'rest-grid-100': { kind: 'rest', status: 'valid' },
  'rest-grid-1k': { kind: 'rest', status: 'valid' },
  'rest-grid-10k': { kind: 'rest', status: 'valid' },
  'sphere-pile-100': { kind: 'rest', status: 'unstable equilibrium' },
  'sphere-pile-hcp-100': { kind: 'rest', status: 'valid' },
  'pile-100': { kind: 'pile', status: 'mid-collapse window' },
  'pile-1k': { kind: 'pile', status: 'mid-collapse window' },
  'pile-10k': { kind: 'pile', status: 'mid-collapse window' },
  'pile-1k-settled': { kind: 'pile', status: 'valid', lead: 600, steps: 600 },
  'pile-10k-settled': { kind: 'pile', status: 'valid', lead: 600, steps: 600 },
};

export function makeScene(name: string, impactOffset = 0): Scene {
  const ref = new Solver();
  const joints: JointSpec[] = [];
  switch (name) {
    case 'impact-train': {
      boxPile(ref, 5, 4);
      for (let i = 0; i < 5; i++) sphere(ref, 1, 100 / ((4 / 3) * Math.PI), 0.5,
        [-10 - i * 5, 0, 3], [10, 0, 0]);
      break;
    }
    case 'free-fall':
    case 'slide':
    case 'spin': {
      new Rigid(ref, [200, 200, 1], 0, 0.5, [0, 0, 0]);
      const body = new Rigid(ref, [1, 1, 1], 1, 0.5,
        [0, 0, name === 'slide' ? 1 : 100], name === 'slide' ? [5, 0, 0] : [0, 0, 0]);
      if (name === 'spin') { ref.gravity = 0; body.velocityAng[2] = 2; }
      break;
    }
    case 'rest-grid-100':
    case 'rest-grid-1k':
    case 'rest-grid-10k': {
      new Rigid(ref, [400, 400, 1], 0, 0.5, [0, 0, 0]);
      const count = name === 'rest-grid-100' ? 100 : name === 'rest-grid-1k' ? 1000 : 10000;
      const width = Math.ceil(Math.sqrt(count / 10));
      for (let i = 0; i < count; i++) {
        const column = Math.floor(i / 10);
        new Rigid(ref, [1, 1, 1], 1, 0.5,
          [(column % width - width / 2) * 2, (Math.floor(column / width) - width / 2) * 2, 1 + i % 10]);
      }
      break;
    }
    case 'stack-50':
    case 'stack-heavy': {
      new Rigid(ref, [200, 200, 1], 0, 0.5, [0, 0, 0]);
      const count = name === 'stack-50' ? 50 : 10;
      for (let i = 0; i < count; i++) new Rigid(ref, [1, 1, 1],
        name === 'stack-heavy' && i === count - 1 ? 1000 : 1, 0.5, [0, 0, 1 + i]);
      break;
    }
    case 'chain-20':
    case 'chain-heavy': {
      new Rigid(ref, [200, 200, 1], 0, 0, [0, 0, 0]);
      new Rigid(ref, [0.2, 0.2, 0.2], 0, 0, [0, 0, 50.1]);
      for (let i = 0; i < 20; i++) {
        new Rigid(ref, [0.2, 0.2, 1], name === 'chain-heavy' && i === 19 ? 1000 : 1,
          0, [0, 0, 49.5 - i]);
        joints.push({ a: i + 1, b: i + 2, anchorA: [0, 0, i === 0 ? -0.1 : -0.5], anchorB: [0, 0, 0.5] });
      }
      break;
    }
    case 'sphere-pile-100': {
      new Rigid(ref, [200, 200, 1], 0, 0.5, [0, 0, 0]);
      for (let i = 0; i < 100; i++) sphere(ref, 0.5, 1, 0.5,
        [i % 5, Math.floor(i / 5) % 5, 1 + Math.floor(i / 25)]);
      break;
    }
    case 'sphere-pile-hcp-100': {
      // A 100-sphere close-packed stack: triangular layers of side 8, 7, 6, 5, each sphere in a
      // pocket of three below (ABC stacking). Fixed walls 1 mm outside the base hold its
      // perimeter, as a cannonball stack's frame does; every upper sphere is then cradled.
      new Rigid(ref, [200, 200, 1], 0, 0.5, [0, 0, 0]);
      const side = 8, h = Math.sqrt(3) / 2, cx = (side - 1) / 2, cy = (side - 1) * h / 3;
      for (let k = 0; k < 4; k++) for (let j = 0; j < side - k; j++) for (let i = 0; i < side - k - j; i++) {
        sphere(ref, 0.5, 1, 0.5, [i + j / 2 + k / 2 - cx, j * h + k * h / 3 - cy, 1 + k * Math.sqrt(2 / 3)]);
      }
      // Each wall's inner face lies 0.501 m outside a base edge's line of centres.
      const offset = 0.501, thickness = 0.5, length = side - 1 + 2 * Math.sqrt(3) * offset + 2 * thickness;
      for (let e = 0; e < 3; e++) {
        const angle = (2 * Math.PI * e) / 3, nx = Math.sin(angle), ny = -Math.cos(angle);
        // Distance from the base centroid to an edge's line of centres is the inradius.
        const d = (side - 1) / (2 * Math.sqrt(3)) + offset + thickness / 2;
        const wall = new Rigid(ref, [length, thickness, 1], 0, 0.5, [nx * d, ny * d, 1]);
        wall.positionAng.set([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
      }
      break;
    }
    case 'impact-graze': {
      ref.gravity = 0;
      new Rigid(ref, [200, 200, 1], 0, 0, [0, 0, 0]);
      new Rigid(ref, [1, 1, 1], 0, 0, [0, 0, 10]);
      // The entire straight path clears the box by 0.01 m.
      sphere(ref, 0.2, 1, 0, [0.71, -2, 10], [0, 240, 0]);
      break;
    }
    case 'impact-rotate': {
      ref.gravity = 0;
      new Rigid(ref, [200, 200, 1], 0, 0, [0, 0, 0]);
      const blade = new Rigid(ref, [4, 0.2, 0.2], 1, 0, [0, 0, 10]);
      blade.velocityAng[2] = 120 * Math.tan(Math.PI / 8);
      // No linear closing speed; the blade sweeps toward the stationary sphere.
      sphere(ref, 0.2, 1, 0, [1, 1, 10], [0, 0, 0]);
      break;
    }
    case 'impact-1':
    case 'impact-100':
    case 'impact-1000': {
      ref.gravity = 0;
      new Rigid(ref, [200, 200, 1], 0, 0, [0, 0, 0]);
      const brick = new Rigid(ref, [1, 0.5, 0.5], 1, 0, [0, 0, 10]);
      const ratio = Number(name.split('-')[1]);
      sphere(ref, 4, ratio * brick.mass / ((4 / 3) * Math.PI * 4 ** 3), 0, [0, -6 - impactOffset, 10], [0, 30, 0]);
      break;
    }
    case 'drop-box':
    case 'rest-stack':
      new Rigid(ref, [200, 200, 1], 0, 0.5, [0, 0, 0]);
      for (let i = 0; i < (name === 'drop-box' ? 1 : 10); i++) {
        new Rigid(ref, [1, 1, 1], 1, 0.5, [0, 0, name === 'drop-box' ? 3 : 1 + i]);
      }
      break;
    case 'pile-100': boxPile(ref, 5, 4); break;
    case 'pile-1k': boxPile(ref, 10, 10); break;
    case 'pile-10k': boxPile(ref, 25, 16); break;
    // 2.1 m spacing clears the largest box's diagonal (2 × 1.04 m): no initial overlap.
    case 'pile-1k-settled': boxPile(ref, 10, 10, 2.1); break;
    case 'pile-10k-settled': boxPile(ref, 25, 16, 2.1); break;
    case 'ring-9k': brickRing(ref, 12, 20, 2, 10); break;
    case 'ring-110k': brickRing(ref); break;
    default: throw new Error(`Unknown case ${name}; choose ${CASES.join(', ')}`);
  }
  return {
    ...(joints.length ? { joints } : {}),
    name, seed: name.startsWith('pile') ? 12345 : null, up: 'z', gravity: ref.gravity, groundTop: 0.5,
    bodies: ref.bodies.map((b) => ({
      shape: isSphere(b) ? 'sphere' : 'box', size: [...b.size], position: [...b.positionLin],
      rotation: [...b.positionAng], velocity: [...b.velocityLin], angularVelocity: [...b.velocityAng],
      mass: b.mass, inertia: [...b.moment], friction: b.friction,
    })),
  };
}

/**
 * A copy with every dynamic body moved horizontally by up to `amount` m per axis (uniform,
 * seeded): enough to break a symmetric equilibrium that a symmetric solve would keep.
 */
export function jitterScene(scene: Scene, amount: number, seed = 1): Scene {
  if (!amount) return scene;
  let s = seed >>> 0;
  const random = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  return { ...scene, bodies: scene.bodies.map((b) => b.mass > 0 ? {
    ...b, position: [b.position[0] + (2 * random() - 1) * amount, b.position[1] + (2 * random() - 1) * amount, b.position[2]],
  } : b) };
}

/** Rebuild from the manifest, including explicitly shared mass properties. */
export function referenceFromScene(scene: Scene, dt: number, iterations: number): Solver {
  const ref = new Solver();
  Object.assign(ref, { dt, iterations, gravity: scene.gravity });
  for (const b of scene.bodies) {
    const body = b.shape === 'sphere'
      ? sphere(ref, b.size[0] / 2, 1, b.friction, b.position, b.velocity)
      : new Rigid(ref, b.size, 1, b.friction, b.position, b.velocity);
    body.mass = b.mass;
    body.moment.set(b.inertia);
    body.positionAng.set(b.rotation);
    body.velocityAng.set(b.angularVelocity);
  }
  for (const j of scene.joints ?? []) {
    new Joint(ref, ref.bodies[j.a], ref.bodies[j.b], j.anchorA, j.anchorB);
    new IgnoreCollision(ref, ref.bodies[j.a], ref.bodies[j.b]);
  }
  return ref;
}

/** Deterministic identity for accidental scene differences, not a cryptographic signature. */
export function sceneHash(scene: Scene): string {
  let h = 2166136261;
  for (const c of JSON.stringify(scene)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0');
}
