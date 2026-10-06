// Reading a joint back: what GpuSolver3D.readJoints returns is the raw joint buffer, JOINT_FLOATS
// per slot (layout.ts says what each field holds). This decodes one slot's record into what
// users ask of it: how hard the joint is working, whether it has broken, how it has bent.

import { qangle } from '../ref/math.ts';
import { J_LAM_ANG, J_LAM_LIN, J_PEN_ANG, J_PEN_LIN, J_REST, J_REST_START, JOINT_FLOATS } from './layout.ts';

/** A joint as of a readback (the last iteration of the last step). */
export interface JointState {
  /** |λ_lin|: the force (N) its linear rows carry, holding the two anchors together. */
  linear: number;
  /**
   * |λ_ang|: the angular force its rigid angle lock carries, the number `fracture` and `yield`
   * limit (0 for a ball joint, which has no angle lock). The torque it makes is the joint's torque
   * arm, |size_a + size_b|², times this.
   */
  angular: number;
  /**
   * It broke (or was switched off): its stiffness is zeroed, at J_PEN_LIN + 3 and J_PEN_ANG + 3.
   * A ball joint's angle lock has none from the start, so only both being zero says it broke.
   */
  broken: boolean;
  /** The relative rotation its angle lock holds now: rotB = rotA·rest (x, y, z, w). A plastic joint moves it. */
  rest: [number, number, number, number];
  /**
   * How far it has bent (rad, 0 to π): the turn from the rest it started with to the one it holds
   * now. Exactly 0 for a joint that never yielded; the number `breakBend` limits.
   */
  bend: number;
}

/** How far the joint in slot `slot` of a `readJoints()` result has bent (rad): see JointState.bend. */
export function jointBend(joints: ArrayLike<number>, slot: number): number {
  const o = slot * JOINT_FLOATS;
  return qangle(joints, joints, o + J_REST_START, o + J_REST);
}

/**
 * Slot `slot` of a `readJoints()` result as a JointState (written into `into`, if given: decoding
 * a whole readback allocates nothing that way).
 */
export function decodeJoint(joints: ArrayLike<number>, slot: number, into?: JointState): JointState {
  const o = slot * JOINT_FLOATS;
  const state = into ?? { linear: 0, angular: 0, broken: false, rest: [0, 0, 0, 1], bend: 0 };
  state.linear = Math.hypot(joints[o + J_LAM_LIN], joints[o + J_LAM_LIN + 1], joints[o + J_LAM_LIN + 2]);
  state.angular = Math.hypot(joints[o + J_LAM_ANG], joints[o + J_LAM_ANG + 1], joints[o + J_LAM_ANG + 2]);
  state.broken = joints[o + J_PEN_LIN + 3] === 0 && joints[o + J_PEN_ANG + 3] === 0;
  for (let i = 0; i < 4; i++) state.rest[i] = joints[o + J_REST + i];
  state.bend = jointBend(joints, slot);
  return state;
}
