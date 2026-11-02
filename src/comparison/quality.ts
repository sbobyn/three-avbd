import { rotate, vec3 } from '../avbd3d/ref/math.ts';
import type { Scene } from './scenes.ts';

// Common snapshot: position (3), quaternion (4), linear velocity (3), angular velocity (3).
export const STATE_SIZE = 13;
export function quality(scene: Scene, state: Float64Array) {
  if (state.length !== scene.bodies.length * STATE_SIZE) throw new Error('Snapshot body count mismatch');
  let nonFiniteBodies = 0;
  let maxFloorPenetration = 0;
  let maxSpeed = 0;
  let translationalKineticEnergy = 0;
  let worstBody: number | null = null;
  let maxRelativeFloorPenetration = 0;
  let maxBoxFloorPenetration = 0;
  let maxSphereFloorPenetration = 0;
  let outsideFloorBodies = 0;
  let invalidRotations = 0;
  const floor = scene.bodies[0];
  if (floor.shape !== 'box' || floor.mass !== 0 || floor.rotation.some((v, i) => v !== (i === 3 ? 1 : 0))) {
    throw new Error('Quality metric requires an axis-aligned ground box as body 0');
  }
  for (let i = 0; i < scene.bodies.length; i++) {
    const b = scene.bodies[i];
    if (!b.mass) continue;
    const s = state.subarray(i * STATE_SIZE, (i + 1) * STATE_SIZE);
    if (!s.every(Number.isFinite)) { nonFiniteBodies++; continue; }
    const q = s.subarray(3, 7);
    if (Math.abs(Math.hypot(...q) - 1) > 1e-4) invalidRotations++;
    const extentAt = (worldAxis: number) => b.shape === 'sphere' ? b.size[0] / 2 :
      b.size.reduce((sum, width, axis) => {
        const v = [0, 0, 0];
        v[axis] = width / 2;
        return sum + Math.abs(rotate(vec3(), q, v)[worldAxis]);
      }, 0);
    // The plane metric is exact only while the complete footprint lies over the ground.
    // Exclude edge/off-floor bodies and report the loss of coverage; never call them passing.
    if ([0, 1].some((axis) => Math.abs(s[axis] - floor.position[axis]) + extentAt(axis) > floor.size[axis] / 2)) {
      outsideFloorBodies++;
    } else {
      const depth = Math.max(0, scene.groundTop - (s[2] - extentAt(2)));
      if (depth > maxFloorPenetration) { maxFloorPenetration = depth; worstBody = i; }
      maxRelativeFloorPenetration = Math.max(maxRelativeFloorPenetration, depth / Math.min(...b.size));
      if (b.shape === 'box') maxBoxFloorPenetration = Math.max(maxBoxFloorPenetration, depth);
      else maxSphereFloorPenetration = Math.max(maxSphereFloorPenetration, depth);
    }
    const speed = Math.hypot(s[7], s[8], s[9]);
    maxSpeed = Math.max(maxSpeed, speed);
    translationalKineticEnergy += 0.5 * b.mass * speed * speed;
  }
  return { nonFiniteBodies, invalidRotations, outsideFloorBodies, maxFloorPenetration, maxRelativeFloorPenetration,
    maxBoxFloorPenetration, maxSphereFloorPenetration, worstBody, maxSpeed, translationalKineticEnergy };
}

export type Quality = ReturnType<typeof quality>;
/** A narrow, predeclared floor-contact criterion; not overall physical accuracy. */
export const FLOOR_TARGET = 0.01;
export function passesFloorTarget(q: Quality): boolean {
  return q.nonFiniteBodies === 0 && q.invalidRotations === 0 && q.outsideFloorBodies === 0 &&
    q.maxRelativeFloorPenetration <= FLOOR_TARGET;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) throw new Error('No timing samples');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
