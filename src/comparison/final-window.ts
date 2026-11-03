// Resting quality: the same floor/pair measurements as the worst-over-window metrics, but over only
// the last N measured steps, so drop impacts and early transients do not dominate them.
import type { Scene } from './scenes.ts';
import type { contactQuality } from './contact-quality.ts';
import { FLOOR_TARGET, passesFloorTarget, percentile, type Quality, STATE_SIZE } from './quality.ts';

/** Default final-window length in steps (1 s at 60 Hz). */
export const FINAL_WINDOW = 60;
/** A body slower than this (linear speed, m/s) counts as at rest. */
export const REST_SPEED = 0.01;
/** `settled` also requires every body's linear speed at or below this (m/s) on every window step. */
export const SETTLED_MAX_SPEED = 0.05;

/** Fraction of dynamic bodies whose linear speed is below `restSpeed`; 1 when there are none. */
export function restFraction(scene: Scene, state: Float64Array, restSpeed = REST_SPEED): number {
  let dynamic = 0, resting = 0;
  for (let i = 0; i < scene.bodies.length; i++) {
    if (!scene.bodies[i].mass) continue;
    dynamic++;
    const o = i * STATE_SIZE;
    if (Math.hypot(state[o + 7], state[o + 8], state[o + 9]) < restSpeed) resting++;
  }
  return dynamic ? resting / dynamic : 1;
}

export interface WindowSample {
  step: number; quality: Quality; contacts: ReturnType<typeof contactQuality>;
  /** `restFraction` of this step's snapshot. */
  restFraction: number;
}
export interface FinalWindow {
  /** Steps actually used: min(requested window, measured steps). */
  steps: number; firstStep: number; lastStep: number;
  restSpeed: number; settledMaxSpeed: number;
  /** Max / p95 over the window's steps of each step's worst floor penetration (m). */
  maxFloorPenetration: number; p95FloorPenetration: number; maxRelativeFloorPenetration: number;
  /** Max / p95 over the window's steps of each step's worst body–body depth (m); null if any step was unmeasured. */
  maxContactDepth: number | null; p95ContactDepth: number | null; maxRelativeContactDepth: number | null;
  /** Fastest body (m/s) and largest total translational kinetic energy (J) on any window step. */
  maxSpeed: number; maxKineticEnergy: number;
  /** Kinetic energy and rest fraction on the last step. */
  finalKineticEnergy: number; restFraction: number;
  /** The contact target (floor and pair depth ≤ FLOOR_TARGET, full floor coverage) on every window step. */
  contactTargetMet: boolean | null;
  /** contactTargetMet and maxSpeed ≤ settledMaxSpeed. */
  settled: boolean | null;
}

/** Final-window metrics over the last `window` of the measured samples (steps after the lead-in). */
export function finalWindow(measured: WindowSample[], window = FINAL_WINDOW): FinalWindow {
  if (!Number.isInteger(window) || window < 1) throw new Error('Invalid final window');
  if (!measured.length) throw new Error('No measured samples');
  const w = measured.slice(-window), last = w[w.length - 1];
  const floor = w.map(s => s.quality.maxFloorPenetration);
  const measuredContacts = w.every(s => s.contacts !== null);
  const pair = measuredContacts ? w.map(s => s.contacts!.maxDepth) : null;
  const maxSpeed = Math.max(...w.map(s => s.quality.maxSpeed));
  const contactTargetMet = measuredContacts
    ? w.every(s => passesFloorTarget(s.quality) && s.contacts!.maxRelativeDepth <= FLOOR_TARGET) : null;
  return {
    steps: w.length, firstStep: w[0].step, lastStep: last.step, restSpeed: REST_SPEED, settledMaxSpeed: SETTLED_MAX_SPEED,
    maxFloorPenetration: Math.max(...floor), p95FloorPenetration: percentile(floor, 0.95),
    maxRelativeFloorPenetration: Math.max(...w.map(s => s.quality.maxRelativeFloorPenetration)),
    maxContactDepth: pair && Math.max(...pair), p95ContactDepth: pair && percentile(pair, 0.95),
    maxRelativeContactDepth: measuredContacts ? Math.max(...w.map(s => s.contacts!.maxRelativeDepth)) : null,
    maxSpeed, maxKineticEnergy: Math.max(...w.map(s => s.quality.translationalKineticEnergy)),
    finalKineticEnergy: last.quality.translationalKineticEnergy, restFraction: last.restFraction,
    contactTargetMet, settled: contactTargetMet === null ? null : contactTargetMet && maxSpeed <= SETTLED_MAX_SPEED,
  };
}
