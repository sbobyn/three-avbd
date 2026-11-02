import { copyBodyPatch, type BodyPatch } from './body-commands.ts';

export class BodyLifecycleError extends Error {
  constructor(message: string) { super(message); this.name = 'BodyLifecycleError'; }
}
export class BodyDisabledError extends BodyLifecycleError {
  constructor() { super('Body is disabled'); this.name = 'BodyDisabledError'; }
}
export class UnsupportedLifecycleError extends BodyLifecycleError {
  constructor() { super('Body activation/reset requires built-in standard collisions; SDF/custom backends are unsupported'); this.name = 'UnsupportedLifecycleError'; }
}
export function checkEnabled(enabled: boolean): void {
  if (typeof enabled !== 'boolean') throw new BodyLifecycleError('Body enabled must be boolean');
}
/** Reset assigns velocities at call time; later ordinary assignments may replace them. */
export function resetBodyPatch(input: BodyPatch): BodyPatch {
  return { velocity: [0, 0, 0], angularVelocity: [0, 0, 0], ...copyBodyPatch(input) };
}
