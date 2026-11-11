// Private pass: ordinary warm-start history first, current-error hard rows second.
// Uses the existing solve layout/group; no new resource, optional feature or solver variant.
import { PRELUDE_3D, BODY_LIFECYCLE_WGSL, WORLD_ANCHOR_INERTIAL_HARD } from './layout.ts';
export const worldAnchorPolicyWGSL = /* wgsl */ `
${PRELUDE_3D}
${BODY_LIFECYCLE_WGSL}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(2) var<storage, read_write> joints: array<Joint>;
@group(0) @binding(3) var<storage, read> info: array<vec4i>;
@compute @workgroup_size(64)
fn prepareWorldAnchors(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  if (j >= params.jointCount) { return; }
  let row = info[j];
  if (row.w != ${WORLD_ANCHOR_INERTIAL_HARD} || row.x != T_JOINT || row.y != -1 || row.z < 0) { return; }
  let b = u32(row.z);
  if (!bodyEnabled(b) || bodies[b].size.w <= 0.0) { return; }
  let k = joints[j];
  if (k.penLin.w < HARD || k.penAng.w != 0.0) { return; }
  let floor = max(PENALTY_MIN, bodies[b].size.w / (params.dt * params.dt));
  joints[j].c0Lin = vec4f(vec3f(0.0), k.c0Lin.w);
  joints[j].penLin = vec4f(max(k.penLin.xyz, vec3f(floor)), k.penLin.w);
}
`;
