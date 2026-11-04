// Analytic checks do not use either engine's contact or constraint outputs.
import type { Scene } from './scenes.ts';
import { STATE_SIZE } from './quality.ts';
import { rotate, vec3 } from '../avbd3d/ref/math.ts';

export function invariants(scene: Scene, state: Float64Array) {
  const momentum = [0, 0, 0];
  let energy = 0;
  scene.bodies.forEach((body, i) => {
    if (!body.mass) return;
    const o = i * STATE_SIZE;
    const velocity = state.subarray(o + 7, o + 10);
    velocity.forEach((v, k) => { momentum[k] += body.mass * v; energy += 0.5 * body.mass * v * v; });
    const q = state.subarray(o + 3, o + 7);
    const localW = rotate(vec3(), [-q[0], -q[1], -q[2], q[3]], state.subarray(o + 10, o + 13));
    localW.forEach((w, k) => { energy += 0.5 * body.inertia[k] * w * w; });
    energy -= body.mass * scene.gravity * state[o + 2];
  });
  return { momentum, energy };
}

export function physicalQuality(scene: Scene, initial: Float64Array, state: Float64Array, time: number) {
  let maxJointError = 0;
  for (const j of scene.joints ?? []) {
    const anchor = (id: number, local: number[]) => {
      const o = id * STATE_SIZE;
      const r = rotate(vec3(), state.subarray(o + 3, o + 7), local);
      return Array.from(r, (v, k) => v + state[o + k]);
    };
    const a = anchor(j.a, j.anchorA), b = anchor(j.b, j.anchorB);
    maxJointError = Math.max(maxJointError, Math.hypot(...a.map((v, k) => v - b[k])));
  }
  const start = invariants(scene, initial), now = invariants(scene, state);
  const momentumChange = Math.hypot(...now.momentum.map((v, k) => v - start.momentum[k]));
  let trajectoryError: number | null = null;
  let velocityError: number | null = null;
  let angularError: number | null = null;
  const o = STATE_SIZE;
  if (scene.name === 'free-fall') {
    trajectoryError = Math.abs(state[o + 2] - (initial[o + 2] + 0.5 * scene.gravity * time * time));
    velocityError = Math.abs(state[o + 9] - scene.gravity * time);
  } else if (scene.name === 'slide') {
    const acceleration = Math.abs(scene.gravity) * Math.sqrt(scene.bodies[0].friction * scene.bodies[1].friction);
    const t = Math.min(time, initial[o + 7] / acceleration);
    trajectoryError = Math.abs(state[o] - initial[o] - (initial[o + 7] * t - 0.5 * acceleration * t * t));
    velocityError = Math.abs(state[o + 7] - Math.max(0, initial[o + 7] - acceleration * time));
  } else if (scene.name === 'spin') {
    // Isotropic inertia and a principal-axis spin: exact angle is omega * t.
    const half = initial[o + 12] * time / 2;
    const dot = state[o + 5] * Math.sin(half) + state[o + 6] * Math.cos(half);
    angularError = 2 * Math.acos(Math.min(1, Math.abs(dot) / Math.hypot(...state.subarray(o + 3, o + 7))));
  } else if (scene.name === 'impact-graze') {
    const i = 2 * STATE_SIZE;
    trajectoryError = Math.hypot(...[0, 1, 2].map(k => state[i + k] - initial[i + k] - initial[i + k + 7] * time));
    velocityError = Math.hypot(...[7, 8, 9].map(k => state[i + k] - initial[i + k]));
  }
  return { maxJointError, trajectoryError, velocityError, angularError, momentumChange,
    relativeMomentumChange: Math.hypot(...start.momentum) > 0 ? momentumChange / Math.hypot(...start.momentum) : null,
    energyChange: now.energy - start.energy,
    relativeEnergyChange: Math.abs(start.energy) > 0 ? (now.energy - start.energy) / Math.abs(start.energy) : null };
}
