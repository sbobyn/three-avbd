// Private admission domain for the opt-in world-point policy; not a general solver guarantee.
import { PENALTY_MIN, PENALTY_MAX } from '../ref/body.ts';

export type WorldAnchorPolicy = 'legacy' | 'inertial-hard';
export interface WorldAnchorMaterial { mass: number; moments: ArrayLike<number> }
export function checkWorldAnchorPolicy(policy: unknown): asserts policy is WorldAnchorPolicy {
  if (policy !== 'legacy' && policy !== 'inertial-hard') throw new TypeError('Unknown world-anchor policy');
}
function positive(value: number): number {
  const f = Math.fround(value);
  if (!(f > 0 && Number.isFinite(f))) throw new RangeError('World-anchor policy requires positive finite f32 intermediates');
  return f;
}
// At 256 m an f32 ULP is 2^-15 m. Limit the combined authored position/lever/target
// extent to below 256, leaving >32 ULPs per millimetre. This is an admission accuracy
// domain, not a promise for arbitrary runtime poses, forces, conflicts or velocities.
export function checkWorldAnchorCoordinates(position: ArrayLike<number>, target: ArrayLike<number>, local: ArrayLike<number>): void {
  const extent = [position, target, local].map(v => Math.hypot(v[0], v[1], v[2])).reduce((a,b) => a+b, 0);
  if (!(Number.isFinite(extent) && extent < 256)) throw new RangeError('World-anchor policy exceeds authored f32 resolution domain (<256 m combined extent)');
}
export function worldAnchorFloor(material: WorldAnchorMaterial, dt: number, local: ArrayLike<number>): number {
  const h = positive(dt);
  if (material.mass === 0) return 0; // Fixed bodies bypass inertial divisions.
  const h2 = positive(h * h);
  positive(1 / h); positive(1 / h2);
  const mass = positive(material.mass);
  positive(1 / mass);
  const floor = Math.max(PENALTY_MIN, positive(mass / h2));
  // Compare the actual packed representation, including the f32-rounded cap.
  if (floor > Math.fround(PENALTY_MAX)) throw new RangeError('World-anchor inertial floor exceeds PENALTY_MAX');
  const r2 = local[0] ** 2 + local[1] ** 2 + local[2] ** 2;
  for (let i = 0; i < 3; i++) {
    const moment = positive(material.moments[i]);
    positive(1 / moment);
    const inertia = positive(moment / h2);
    // Leave room for angular residual products/norms and the existing LDL pivot floor.
    positive(inertia * inertia * 16);
    positive(1 / positive(inertia * 1e-5));
  }
  // Bound the linear/angular cross blocks and their squared norms before packing.
  for (const value of [floor * Math.sqrt(r2), floor * r2, 3 * floor * floor * 256 ** 2 * (1 + r2) ** 2]) {
    if (!Number.isFinite(Math.fround(value))) throw new RangeError('World-anchor lever/penalty product exceeds finite f32 domain');
    if (value > 0) positive(value);
  }
  return floor;
}
