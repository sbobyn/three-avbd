// The 3D AVBD iterations on the GPU: warm starts, one primal (6-DOF Newton) pass per colour,
// dual updates for joints and contacts, and the velocity update. The constraint math follows
// ../ref (forces.ts, manifold.ts, solver.ts); rows are folded into a register accumulator as
// outer products instead of the reference's 3x3 matrix products.

import { PRELUDE_3D } from './layout.ts';

export const solveWGSL = /* wgsl */ `
${PRELUDE_3D}

// Per-dispatch constants, selected with a dynamic uniform offset
struct PassConstants {
  color: u32,   // colour solved by this primal dispatch
  alpha: f32,   // stabilization for this iteration
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(2) var<storage, read_write> joints: array<Joint>;
@group(0) @binding(3) var<storage, read> info: array<vec4i>;  // type, bodyA (-1 = world), bodyB
@group(0) @binding(4) var<storage, read_write> contacts: array<Contact>;
@group(0) @binding(5) var<storage, read> adj: array<u32>;
@group(0) @binding(6) var<storage, read> color: array<u32>;
@group(0) @binding(7) var<storage, read> counters: array<u32>;
@group(1) @binding(0) var<uniform> pc: PassConstants;

fn contactCount() -> u32 {
  return min(counters[C_CONTACTS], params.contactCapacity);
}

/** outer(u, v): row i, column j = u[i] v[j] (WGSL matrices are column-major). */
fn outer(u: vec3f, v: vec3f) -> mat3x3f {
  return mat3x3f(u * v.x, u * v.y, u * v.z);
}

/**
 * One body's Newton system [lin crossᵀ; cross ang]·dx = rhs. cross holds row = angular
 * index, column = linear index.
 */
struct Acc {
  lin: mat3x3f,
  ang: mat3x3f,
  cross: mat3x3f,
  rLin: vec3f,
  rAng: vec3f,
}

/** Fold one constraint row in: Jacobian (l, a) w.r.t. the body, stiffness k and force f. */
fn addRow(acc: ptr<function, Acc>, l: vec3f, a: vec3f, k: f32, f: f32) {
  (*acc).lin += outer(l, l) * k;
  (*acc).ang += outer(a, a) * k;
  (*acc).cross += outer(a, l) * k;
  (*acc).rLin += l * f;
  (*acc).rAng += a * f;
}

// --- Joints and springs -----------------------------------------------------------------------

fn anchorA(k: Joint, a: i32) -> vec3f {
  if (a < 0) { return k.rA.xyz; }
  return qrotate(bodies[a].rot, k.rA.xyz) + bodies[a].pos.xyz;
}

fn rotA(a: i32) -> vec4f {
  if (a < 0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return bodies[a].rot;
}

fn jointLinC(k: Joint, a: i32, b: i32) -> vec3f {
  return anchorA(k, a) - (qrotate(bodies[b].rot, k.rB.xyz) + bodies[b].pos.xyz);
}

fn jointAngC(k: Joint, a: i32, b: i32) -> vec3f {
  return qsub(rotA(a), bodies[b].rot) * k.lamAng.w;
}

/** Stabilized linear / angular constraints (Eq. 18 on hard rows). */
fn jointLinRows(k: Joint, a: i32, b: i32, alpha: f32) -> vec3f {
  return jointLinC(k, a, b) - select(vec3f(0.0), k.c0Lin.xyz * alpha, k.penLin.w >= HARD);
}

fn jointAngRows(k: Joint, a: i32, b: i32, alpha: f32) -> vec3f {
  return jointAngC(k, a, b) - select(vec3f(0.0), k.c0Ang.xyz * alpha, k.penAng.w >= HARD);
}

fn addJoint(acc: ptr<function, Acc>, j: u32, alpha: f32, i: u32) {
  let t = info[j].x;
  let a = info[j].y;
  let b = info[j].z;
  let k = joints[j];
  let isA = i32(i) == a;
  let sg = select(-1.0, 1.0, isA);

  if (t == T_SPRING) {
    let rAW = qrotate(bodies[a].rot, k.rA.xyz);
    let rBW = qrotate(bodies[b].rot, k.rB.xyz);
    let d = (rAW + bodies[a].pos.xyz) - (rBW + bodies[b].pos.xyz);
    let len = length(d);
    if (len <= 1.0e-6) { return; }
    let n = d / len;
    let stiffness = k.penLin.w;
    let r = select(rBW, rAW, isA);
    addRow(acc, n * sg, cross(r, n) * sg, stiffness, stiffness * (len - k.rA.w));
    return;
  }

  // Ball-socket rows
  if (dot(k.penLin.xyz, k.penLin.xyz) > 0.0) {
    let F = k.penLin.xyz * jointLinRows(k, a, b, alpha) + k.lamLin.xyz;
    // Jacobian: sg·I (linear) and skew(-rA) for A, skew(rB) for B (angular); rows below
    var r: vec3f;
    if (isA) { r = qrotate(bodies[a].rot, k.rA.xyz); }
    else { r = -qrotate(bodies[b].rot, k.rB.xyz); }
    // Row m of skew(-r): (-r) × e_m... written out: skew(v) rows (0,-vz,vy), (vz,0,-vx), (-vy,vx,0)
    let v = -r;
    addRow(acc, vec3f(sg, 0.0, 0.0), vec3f(0.0, -v.z, v.y), k.penLin.x, F.x);
    addRow(acc, vec3f(0.0, sg, 0.0), vec3f(v.z, 0.0, -v.x), k.penLin.y, F.y);
    addRow(acc, vec3f(0.0, 0.0, sg), vec3f(-v.y, v.x, 0.0), k.penLin.z, F.z);
    // Diagonally lumped geometric stiffness (Sec. 3.5): column norms of -(r·F) I + r Fᵀ
    let rf = dot(r, F);
    let g = vec3f(
      length(r * F.x - vec3f(rf, 0.0, 0.0)),
      length(r * F.y - vec3f(0.0, rf, 0.0)),
      length(r * F.z - vec3f(0.0, 0.0, rf)));
    (*acc).ang += mat3x3f(vec3f(g.x, 0.0, 0.0), vec3f(0.0, g.y, 0.0), vec3f(0.0, 0.0, g.z));
  }

  // Angle-lock rows: Jacobian sg·torqueArm·I on the angular part
  if (dot(k.penAng.xyz, k.penAng.xyz) > 0.0) {
    let F = k.penAng.xyz * jointAngRows(k, a, b, alpha) + k.lamAng.xyz;
    let s = sg * k.lamAng.w;
    addRow(acc, vec3f(0.0), vec3f(s, 0.0, 0.0), k.penAng.x, F.x);
    addRow(acc, vec3f(0.0), vec3f(0.0, s, 0.0), k.penAng.y, F.y);
    addRow(acc, vec3f(0.0), vec3f(0.0, 0.0, s), k.penAng.z, F.z);
  }
}

// --- Contacts ---------------------------------------------------------------------------------

/** One contact evaluated at the current poses: Jacobians of both bodies, C and the force. */
struct ContactEval {
  basis: mat3x3f,  // columns: normal, tangent 1, tangent 2
  aA: mat3x3f,     // columns: angular Jacobian rows of body A
  aB: mat3x3f,
  C: vec3f,
  F: vec3f,        // cone-clamped force
  frictionScale: f32,
  bounds: f32,
}

fn evalContact(k: Contact, alpha: f32) -> ContactEval {
  let a = k.ids.x;
  let b = k.ids.y;
  let posA = bodies[a].pos.xyz;
  let rotAq = bodies[a].rot;
  let posB = bodies[b].pos.xyz;
  let rotBq = bodies[b].rot;
  let dALin = posA - bodies[a].initialPos.xyz;
  let dAAng = qsub(rotAq, bodies[a].initialRot);
  let dBLin = posB - bodies[b].initialPos.xyz;
  let dBAng = qsub(rotBq, bodies[b].initialRot);
  // Lever arms at the current rotation, as the reference does for boxes. Sphere contacts use
  // the step-start rotation instead (the Taylor point x-): a rolling sphere turns ~0.1 rad per
  // step, and a lever arm rotated with it puts a false separation into the normal row, so the
  // sphere sank through the ground while gaining energy.
  let atStart = k.ids.z == SPHERE_FEATURE;
  let rAW = qrotate(select(rotAq, bodies[a].initialRot, atStart), k.rA.xyz);
  let rBW = qrotate(select(rotBq, bodies[b].initialRot, atStart), k.rB.xyz);

  var e: ContactEval;
  e.basis = orthonormal(vec3f(k.rA.w, k.rB.w, k.c0.w));
  // Taylor series approximation of C(x) about x- (Sec. 4), one row per basis vector. Written
  // out rather than looped: dynamic indexing into matrices forces them into indexable
  // memory, which made these kernels slow to compile (seconds) and to run.
  let n = e.basis[0];
  let t1 = e.basis[1];
  let t2 = e.basis[2];
  e.aA = mat3x3f(cross(rAW, n), cross(rAW, t1), cross(rAW, t2));
  e.aB = mat3x3f(cross(rBW, -n), cross(rBW, -t1), cross(rBW, -t2));
  let keep = 1.0 - alpha;
  e.C = vec3f(
    k.c0.x * keep + dot(n, dALin) - dot(n, dBLin) + dot(e.aA[0], dAAng) + dot(e.aB[0], dBAng),
    k.c0.y * keep + dot(t1, dALin) - dot(t1, dBLin) + dot(e.aA[1], dAAng) + dot(e.aB[1], dBAng),
    k.c0.z * keep + dot(t2, dALin) - dot(t2, dBLin) + dot(e.aA[2], dAAng) + dot(e.aB[2], dBAng));
  var F = k.pen.xyz * e.C + k.lam.xyz;
  // Normal pushes only; friction is clamped to the cone
  F.x = min(F.x, 0.0);
  e.bounds = abs(F.x) * k.pen.w;
  e.frictionScale = length(F.yz);
  if (e.frictionScale > e.bounds && e.frictionScale > 0.0) {
    F = vec3f(F.x, F.yz * (e.bounds / e.frictionScale));
  }
  e.F = F;
  return e;
}

fn addContact(acc: ptr<function, Acc>, c: u32, alpha: f32, i: u32) {
  let k = contacts[c];
  let e = evalContact(k, alpha);
  let isA = i == k.ids.x;
  let sg = select(-1.0, 1.0, isA);
  var ang = e.aB;
  if (isA) { ang = e.aA; }
  addRow(acc, e.basis[0] * sg, ang[0], k.pen.x, e.F.x);
  addRow(acc, e.basis[1] * sg, ang[1], k.pen.y, e.F.y);
  addRow(acc, e.basis[2] * sg, ang[2], k.pen.z, e.F.z);
}

// --- Warm start -------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn warmStartJoints(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  if (j >= params.jointCount || info[j].x != T_JOINT) { return; }
  var k = joints[j];
  let a = info[j].y;
  let b = info[j].z;
  k.c0Lin = vec4f(jointLinC(k, a, b), 0.0);
  k.c0Ang = vec4f(jointAngC(k, a, b), 0.0);
  let decay = params.alpha * params.gamma;
  k.lamLin = vec4f(k.lamLin.xyz * decay, k.lamLin.w);
  k.lamAng = vec4f(k.lamAng.xyz * decay, k.lamAng.w);
  // Penalties decay, stay within bounds, and never exceed the material stiffness
  k.penLin = vec4f(min(clamp(k.penLin.xyz * params.gamma, vec3f(PENALTY_MIN), vec3f(PENALTY_MAX)), vec3f(k.penLin.w)), k.penLin.w);
  k.penAng = vec4f(min(clamp(k.penAng.xyz * params.gamma, vec3f(PENALTY_MIN), vec3f(PENALTY_MAX)), vec3f(k.penAng.w)), k.penAng.w);
  joints[j] = k;
}

@compute @workgroup_size(64)
fn warmStartBodies(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  var b = bodies[i];
  let dt = params.dt;
  let g = params.gravity;
  let dynamic = b.size.w > 0.0;

  // Inertial target (Eq. 2)
  b.inertialPos = vec4f(b.pos.xyz + b.vel.xyz * dt, 0.0);
  if (dynamic) { b.inertialPos.z += g * (dt * dt); }
  b.inertialRot = qadd(b.rot, b.angVel.xyz * dt);

  // Adaptive warm start (original VBD paper); vel.w holds last step's vel.z
  var w = 0.0;
  if (abs(g) > 0.0) { w = clamp((b.vel.z - b.vel.w) / dt * sign(g) / abs(g), 0.0, 1.0); }

  b.initialPos = b.pos;
  b.initialRot = b.rot;
  if (dynamic) {
    b.pos = vec4f(b.pos.xyz + b.vel.xyz * dt + vec3f(0.0, 0.0, g * (w * dt * dt)), b.pos.w);
    b.rot = qadd(b.rot, b.angVel.xyz * dt);
  }
  bodies[i] = b;
}

// --- Primal: one colour -----------------------------------------------------------------------

// Bodies of one colour share no constraint, so writing poses in place never races with a
// neighbour's read (bodies left clashing by the colouring are the only, counted, exception).
@compute @workgroup_size(64)
fn primal(@builtin(global_invocation_id) gid: vec3u) {
  let start = color[params.colorStartOffset + pc.color];
  if (gid.x >= color[params.colorStartOffset + pc.color + 1u] - start) { return; }
  solveBody(color[params.colorBodiesOffset + start + gid.x]);
}

fn solveBody(i: u32) {
  let pos = bodies[i].pos;
  let rot = bodies[i].rot;
  let dt2 = params.dt * params.dt;
  let m = bodies[i].size.w / dt2;
  let I = bodies[i].moment.xyz / dt2;
  var acc: Acc;
  acc.lin = mat3x3f(vec3f(m, 0.0, 0.0), vec3f(0.0, m, 0.0), vec3f(0.0, 0.0, m));
  acc.ang = mat3x3f(vec3f(I.x, 0.0, 0.0), vec3f(0.0, I.y, 0.0), vec3f(0.0, 0.0, I.z));
  acc.rLin = m * (pos.xyz - bodies[i].inertialPos.xyz);
  acc.rAng = I * qsub(rot, bodies[i].inertialRot);

  let end = adj[i + 1u];
  for (var e = adj[i]; e < end; e++) {
    let id = adj[params.adjListOffset + e];
    if (id < params.jointCount) { addJoint(&acc, id, pc.alpha, i); }
    else { addContact(&acc, id - params.jointCount, pc.alpha, i); }
  }

  // LDLᵀ solve of the 6x6 SPD system (maths.h solve), lower triangle only
  let A11 = acc.lin[0][0];
  let A21 = acc.lin[0][1]; let A22 = acc.lin[1][1];
  let A31 = acc.lin[0][2]; let A32 = acc.lin[1][2]; let A33 = acc.lin[2][2];
  let A41 = acc.cross[0][0]; let A42 = acc.cross[1][0]; let A43 = acc.cross[2][0]; let A44 = acc.ang[0][0];
  let A51 = acc.cross[0][1]; let A52 = acc.cross[1][1]; let A53 = acc.cross[2][1]; let A54 = acc.ang[0][1]; let A55 = acc.ang[1][1];
  let A61 = acc.cross[0][2]; let A62 = acc.cross[1][2]; let A63 = acc.cross[2][2]; let A64 = acc.ang[0][2]; let A65 = acc.ang[1][2]; let A66 = acc.ang[2][2];

  let D1 = A11;
  let L21 = A21 / D1;
  let L31 = A31 / D1;
  let L41 = A41 / D1;
  let L51 = A51 / D1;
  let L61 = A61 / D1;
  let D2 = A22 - L21 * L21 * D1;
  let L32 = (A32 - L21 * L31 * D1) / D2;
  let L42 = (A42 - L21 * L41 * D1) / D2;
  let L52 = (A52 - L21 * L51 * D1) / D2;
  let L62 = (A62 - L21 * L61 * D1) / D2;
  let D3 = A33 - (L31 * L31 * D1 + L32 * L32 * D2);
  let L43 = (A43 - L31 * L41 * D1 - L32 * L42 * D2) / D3;
  let L53 = (A53 - L31 * L51 * D1 - L32 * L52 * D2) / D3;
  let L63 = (A63 - L31 * L61 * D1 - L32 * L62 * D2) / D3;
  let D4 = A44 - (L41 * L41 * D1 + L42 * L42 * D2 + L43 * L43 * D3);
  let L54 = (A54 - L41 * L51 * D1 - L42 * L52 * D2 - L43 * L53 * D3) / D4;
  let L64 = (A64 - L41 * L61 * D1 - L42 * L62 * D2 - L43 * L63 * D3) / D4;
  let D5 = A55 - (L51 * L51 * D1 + L52 * L52 * D2 + L53 * L53 * D3 + L54 * L54 * D4);
  let L65 = (A65 - L51 * L61 * D1 - L52 * L62 * D2 - L53 * L63 * D3 - L54 * L64 * D4) / D5;
  let D6 = A66 - (L61 * L61 * D1 + L62 * L62 * D2 + L63 * L63 * D3 + L64 * L64 * D4 + L65 * L65 * D5);

  let y1 = acc.rLin.x;
  let y2 = acc.rLin.y - L21 * y1;
  let y3 = acc.rLin.z - L31 * y1 - L32 * y2;
  let y4 = acc.rAng.x - L41 * y1 - L42 * y2 - L43 * y3;
  let y5 = acc.rAng.y - L51 * y1 - L52 * y2 - L53 * y3 - L54 * y4;
  let y6 = acc.rAng.z - L61 * y1 - L62 * y2 - L63 * y3 - L64 * y4 - L65 * y5;

  let w3 = y6 / D6;
  let w2 = y5 / D5 - L65 * w3;
  let w1 = y4 / D4 - L54 * w2 - L64 * w3;
  let v3 = y3 / D3 - L43 * w1 - L53 * w2 - L63 * w3;
  let v2 = y2 / D2 - L32 * v3 - L42 * w1 - L52 * w2 - L62 * w3;
  let v1 = y1 / D1 - L21 * v2 - L31 * v3 - L41 * w1 - L51 * w2 - L61 * w3;

  // dx = -A⁻¹ rhs (Eq. 4)
  bodies[i].pos = vec4f(pos.xyz - vec3f(v1, v2, v3), pos.w);
  bodies[i].rot = qadd(rot, -vec3f(w1, w2, w3));
}

// --- Dual -------------------------------------------------------------------------------------

fn dualJoint(j: u32) {
  let t = info[j].x;
  if (t != T_JOINT) { return; }
  let a = info[j].y;
  let b = info[j].z;
  var k = joints[j];
  let alpha = pc.alpha;
  if (dot(k.penLin.xyz, k.penLin.xyz) > 0.0) {
    let C = jointLinRows(k, a, b, alpha);
    if (k.penLin.w >= HARD) { k.lamLin = vec4f(k.penLin.xyz * C + k.lamLin.xyz, k.lamLin.w); }
    k.penLin = vec4f(min(k.penLin.xyz + abs(C) * params.betaLin, vec3f(min(k.penLin.w, PENALTY_MAX))), k.penLin.w);
  }
  if (dot(k.penAng.xyz, k.penAng.xyz) > 0.0) {
    let C = jointAngRows(k, a, b, alpha);
    if (k.penAng.w >= HARD) { k.lamAng = vec4f(k.penAng.xyz * C + k.lamAng.xyz, k.lamAng.w); }
    k.penAng = vec4f(min(k.penAng.xyz + abs(C) * params.betaAng, vec3f(min(k.penAng.w, PENALTY_MAX))), k.penAng.w);
  }
  // Fracture: the joint stops acting for good (the CPU deletes it)
  let frac = k.lamLin.w;
  if (frac < BIG && dot(k.lamAng.xyz, k.lamAng.xyz) > frac * frac) {
    k.penLin = vec4f(0.0);
    k.penAng = vec4f(0.0);
    k.lamLin = vec4f(0.0, 0.0, 0.0, frac);
    k.lamAng = vec4f(0.0, 0.0, 0.0, k.lamAng.w);
  }
  joints[j] = k;
}

fn dualContact(c: u32) {
  let k = contacts[c];
  let e = evalContact(k, pc.alpha);
  // Write back only what changes (lambda, penalty, stick): the dual is bandwidth-bound
  contacts[c].lam = vec4f(e.F, k.lam.w);
  // Ramp the penalty where the force is within its bounds (Eq. 16)
  var pen = k.pen;
  if (e.F.x < 0.0) { pen.x = min(pen.x + params.betaLin * abs(e.C.x), PENALTY_MAX); }
  if (e.frictionScale <= e.bounds) {
    pen.y = min(pen.y + params.betaLin * abs(e.C.y), PENALTY_MAX);
    pen.z = min(pen.z + params.betaLin * abs(e.C.z), PENALTY_MAX);
    contacts[c].ids.w = select(0u, 1u, length(e.C.yz) < STICK_THRESH);
  }
  contacts[c].pen = pen;
}

/** Dual update of every constraint: joints first, then contacts (one dispatch). */
@compute @workgroup_size(64)
fn dual(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id < params.jointCount) { dualJoint(id); }
  else if (id - params.jointCount < contactCount()) { dualContact(id - params.jointCount); }
}

@compute @workgroup_size(64)
fn updateVelocities(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  var b = bodies[i];
  let prevZ = b.vel.z;
  if (b.size.w > 0.0) {
    b.vel = vec4f((b.pos.xyz - b.initialPos.xyz) / params.dt, prevZ);
    b.angVel = vec4f(qsub(b.rot, b.initialRot) / params.dt, b.angVel.w);
  } else {
    b.vel.w = prevZ;
  }
  bodies[i] = b;
}
`;
