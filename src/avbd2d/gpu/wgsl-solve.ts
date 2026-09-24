// The AVBD iterations on the GPU: warm starts, one primal (Newton) pass per colour, dual
// updates for joints and contacts, and the velocity update. Constraint math is a line-for-line
// port of ../soa/solver.ts evalConstraint / solveBody / dual.

import { PRELUDE } from './layout.ts';

export const solveWGSL = /* wgsl */ `
${PRELUDE}

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

fn rowCount(t: i32) -> u32 {
  switch t {
    case T_JOINT: { return 3u; }
    case T_SPRING, T_MOTOR: { return 1u; }
    default: { return 0u; }
  }
}

/** Raw joint constraint: anchor separation and scaled relative angle. */
fn jointC(k: Joint, a: i32, b: i32) -> vec3f {
  var pa = k.anchors.xy;
  var angA = 0.0;
  if (a >= 0) {
    let p = bodies[a].pose;
    pa = rot(p.z, k.anchors.xy) + p.xy;
    angA = p.z;
  }
  let pb = bodies[b].pose;
  let d = pa - (rot(pb.z, k.anchors.zw) + pb.xy);
  return vec3f(d, (angA - pb.z - k.param.x) * k.param.y);
}

// Constraint rows are evaluated by small typed helpers and folded straight into a register
// accumulator with explicit per-row calls: no arrays and no dynamic indexing, which Metal
// and friends would otherwise keep in (slow) memory.

/** Accumulated 3x3 Hessian (lower triangle) and right-hand side of one body's Newton step. */
struct Acc {
  h00: f32,
  h10: f32,
  h11: f32,
  h20: f32,
  h21: f32,
  h22: f32,
  rhs: vec3f,
}

/**
 * Fold one constraint row into the accumulator: J the row's Jacobian w.r.t. the body, g its
 * diagonal geometric-stiffness weights (Sec. 3.5), then the row's state.
 */
fn addRow(acc: ptr<function, Acc>, j: vec3f, g: vec3f, C: f32, pen0: f32, lam: f32, stiff: f32, fmin: f32, fmax: f32) {
  let vbd = (params.flags & FLAG_VBD) != 0u;
  let lambda = select(0.0, lam, !vbd && stiff >= HARD);
  var pen = pen0;
  let fRaw = pen * C + lambda;
  let f = clamp(fRaw, fmin, fmax);
  let af = abs(f);
  // Stiffness rescaling for clamped forces (Eq. 14), Hessian only
  if ((params.flags & FLAG_RESCALE) != 0u && C != 0.0) {
    if (fRaw < fmin) { pen = abs((fmin - lambda) / C); }
    else if (fRaw > fmax) { pen = abs((fmax - lambda) / C); }
  }
  (*acc).rhs += j * f;
  (*acc).h00 += j.x * j.x * pen + g.x * af;
  (*acc).h10 += j.y * j.x * pen;
  (*acc).h11 += j.y * j.y * pen + g.y * af;
  (*acc).h20 += j.z * j.x * pen;
  (*acc).h21 += j.z * j.y * pen;
  (*acc).h22 += j.z * j.z * pen + g.z * af;
}

/** Per-row constraint values of joint/spring/motor j (rows beyond its count are unused). */
fn jointRowsC(j: u32, alpha: f32) -> vec3f {
  let t = info[j].x;
  let a = info[j].y;
  let b = info[j].z;
  let k = joints[j];
  if (t == T_JOINT) {
    // Hard rows are stabilized (Eq. 18)
    return jointC(k, a, b) - select(vec3f(0.0), k.c0.xyz * alpha, k.stiff.xyz >= vec3f(HARD));
  }
  if (t == T_SPRING) {
    let pa4 = bodies[a].pose;
    let pb4 = bodies[b].pose;
    let d = (rot(pa4.z, k.anchors.xy) + pa4.xy) - (rot(pb4.z, k.anchors.zw) + pb4.xy);
    return vec3f(length(d) - k.param.x, 0.0, 0.0);
  }
  if (t == T_MOTOR) {
    var dA = 0.0;
    if (a >= 0) { dA = bodies[a].pose.z - bodies[a].initial.z; }
    let dB = bodies[b].pose.z - bodies[b].initial.z;
    return vec3f(dA - dB - k.param.x * params.dt, 0.0, 0.0);
  }
  return vec3f(0.0);
}

/** Add the rows of joint/spring/motor j, differentiated w.r.t. body i. */
fn addJoint(acc: ptr<function, Acc>, j: u32, alpha: f32, i: u32) {
  let t = info[j].x;
  let a = info[j].y;
  let b = info[j].z;
  let k = joints[j];
  let isA = i32(i) == a;
  let sg = select(-1.0, 1.0, isA);
  let C = jointRowsC(j, alpha);

  if (t == T_JOINT) {
    let r = rot(bodies[i].pose.z, select(k.anchors.zw, k.anchors.xy, isA));
    addRow(acc, vec3f(sg, 0.0, -sg * r.y), vec3f(0.0, 0.0, abs(r.x)), C.x, k.pen.x, k.lam.x, k.stiff.x, k.fmin.x, k.fmax.x);
    addRow(acc, vec3f(0.0, sg, sg * r.x), vec3f(0.0, 0.0, abs(r.y)), C.y, k.pen.y, k.lam.y, k.stiff.y, k.fmin.y, k.fmax.y);
    addRow(acc, vec3f(0.0, 0.0, sg * k.param.y), vec3f(0.0), C.z, k.pen.z, k.lam.z, k.stiff.z, k.fmin.z, k.fmax.z);
  } else if (t == T_SPRING) {
    let pa4 = bodies[a].pose;
    let pb4 = bodies[b].pose;
    let d = (rot(pa4.z, k.anchors.xy) + pa4.xy) - (rot(pb4.z, k.anchors.zw) + pb4.xy);
    let len2 = dot(d, d);
    // A degenerate spring contributes nothing (the CPU zeroes its Jacobian the same way)
    var J = vec3f(0.0);
    var G = vec3f(0.0);
    if (len2 != 0.0) {
      let len = sqrt(len2);
      let n = d / len;
      let d00 = (1.0 - n.x * n.x) / len;
      let d01 = -n.x * n.y / len;
      let d11 = (1.0 - n.y * n.y) / len;
      let ang = bodies[i].pose.z;
      let lr = select(k.anchors.zw, k.anchors.xy, isA);
      let sr = rot(ang, vec2f(-lr.y, lr.x));
      let r = rot(ang, lr);
      let dxr0 = d00 * sr.x + d01 * sr.y;
      let dxr1 = d01 * sr.x + d11 * sr.y;
      let nr = dot(n, r);
      J = sg * vec3f(n, dot(n, sr));
      let drr = select(nr + nr, -nr - nr, isA);
      G = vec3f(length(vec3f(d00, d01, dxr0)), length(vec3f(d01, d11, dxr1)), length(vec3f(dxr0, dxr1, drr)));
    }
    addRow(acc, J, G, C.x, k.pen.x, k.lam.x, k.stiff.x, k.fmin.x, k.fmax.x);
  } else if (t == T_MOTOR) {
    addRow(acc, vec3f(0.0, 0.0, sg), vec3f(0.0), C.x, k.pen.x, k.lam.x, k.stiff.x, k.fmin.x, k.fmax.x);
  }
}

/** Contact geometry: Taylor-expanded C about x- (Sec. 4) and the Jacobians of both bodies. */
struct ContactRows {
  C: vec2f,  // normal, tangent
  jAn: vec3f,
  jAt: vec3f,
  jBn: vec3f,
  jBt: vec3f,
}

fn contactRows(k: Contact, alpha: f32) -> ContactRows {
  let a = k.ids.x;
  let b = k.ids.y;
  let n = k.geo.zw;
  let tg = vec2f(n.y, -n.x);
  // Only the poses are needed: load those fields, not the whole 96-byte body records
  let poseA = bodies[a].pose.xyz;
  let initA = bodies[a].initial.xyz;
  let poseB = bodies[b].pose.xyz;
  let initB = bodies[b].initial.xyz;
  let rA = rot(initA.z, k.anchors.xy);
  let rB = rot(initB.z, k.anchors.zw);
  var r: ContactRows;
  r.jAn = vec3f(n, rA.x * n.y - rA.y * n.x);
  r.jBn = -vec3f(n, rB.x * n.y - rB.y * n.x);
  r.jAt = vec3f(tg, rA.x * tg.y - rA.y * tg.x);
  r.jBt = -vec3f(tg, rB.x * tg.y - rB.y * tg.x);
  let dA = poseA - initA;
  let dB = poseB - initB;
  r.C = vec2f(
    k.geo.x * (1.0 - alpha) + dot(r.jAn, dA) + dot(r.jBn, dB),
    k.geo.y * (1.0 - alpha) + dot(r.jAt, dA) + dot(r.jBt, dB));
  return r;
}

/** Add contact c's normal and friction rows, differentiated w.r.t. body i. */
fn addContact(acc: ptr<function, Acc>, c: u32, alpha: f32, i: u32) {
  let k = contacts[c];
  let r = contactRows(k, alpha);
  let isA = i == k.ids.x;
  // Normal pushes only; friction is bounded by the current normal force
  let bound = abs(k.pl.z) * k.misc.x;
  addRow(acc, select(r.jBn, r.jAn, isA), vec3f(0.0), r.C.x, k.pl.x, k.pl.z, BIG, -BIG, 0.0);
  addRow(acc, select(r.jBt, r.jAt, isA), vec3f(0.0), r.C.y, k.pl.y, k.pl.w, BIG, -bound, bound);
}

// --- Warm start ---------------------------------------------------------------------------

@compute @workgroup_size(64)
fn warmStartJoints(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  if (j >= params.jointCount) { return; }
  let t = info[j].x;
  if (t == T_NONE) { return; }
  var k = joints[j];
  if (t == T_JOINT) { k.c0 = vec4f(jointC(k, info[j].y, info[j].z), 0.0); }
  let vbd = (params.flags & FLAG_VBD) != 0u;
  let postStabilize = (params.flags & FLAG_POST_STABILIZE) != 0u;
  for (var r = 0u; r < rowCount(t); r++) {
    if (vbd) {
      k.pen[r] = min(k.stiff[r], params.vbdStiffness);
      continue;
    }
    if (!postStabilize) { k.lam[r] = k.lam[r] * params.alpha * params.gamma; }
    k.pen[r] = min(clamp(k.pen[r] * params.gamma, PENALTY_MIN, PENALTY_MAX), k.stiff[r]);
  }
  joints[j] = k;
}

@compute @workgroup_size(64)
fn warmStartBodies(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  var b = bodies[i];
  let dt = params.dt;
  let g = params.gravity;
  b.vel.z = clamp(b.vel.z, -50.0, 50.0);

  // Inertial target (Eq. 2)
  b.inertial = vec4f(b.pose.xyz + b.vel.xyz * dt, 0.0);
  if (b.shape.z > 0.0) { b.inertial.y += g * dt * dt; }

  // Adaptive warm start (original VBD paper)
  var w = 0.0;
  if (abs(g) > 0.0) { w = clamp(((b.vel.y - b.prevVel.y) / dt) * sign(g) / abs(g), 0.0, 1.0); }

  b.initial = b.pose;
  b.pose = vec4f(b.pose.x + b.vel.x * dt, b.pose.y + b.vel.y * dt + g * w * dt * dt, b.pose.z + b.vel.z * dt, b.pose.w);
  bodies[i] = b;
}

// --- Primal: one colour ---------------------------------------------------------------------

// Bodies of one colour share no constraint, so writing poses in place never races with a
// neighbour's read (bodies left clashing by the colouring are the only, counted, exception).
@compute @workgroup_size(64)
fn primal(@builtin(global_invocation_id) gid: vec3u) {
  let start = color[params.colorStartOffset + pc.color];
  if (gid.x >= color[params.colorStartOffset + pc.color + 1u] - start) { return; }
  solveBody(color[params.colorBodiesOffset + start + gid.x]);
}

// Variant for comparison: one thread per body in index order, skipping other colours. More
// threads, but neighbouring threads touch neighbouring memory.
@compute @workgroup_size(64)
fn primalScan(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount || color[i] != pc.color || bodies[i].shape.z <= 0.0) { return; }
  solveBody(i);
}

fn solveBody(i: u32) {
  let pose = bodies[i].pose;
  let inertial = bodies[i].inertial.xyz;
  let shape = bodies[i].shape;
  let dt2 = params.dt * params.dt;
  let mdt = shape.z / dt2;
  let idt = shape.w / dt2;
  var acc = Acc(mdt, 0.0, mdt, 0.0, 0.0, idt, vec3f(mdt * (pose.x - inertial.x), mdt * (pose.y - inertial.y), idt * (pose.z - inertial.z)));

  let end = adj[i + 1u];
  for (var e = adj[i]; e < end; e++) {
    let id = adj[params.adjListOffset + e];
    if (id < params.jointCount) { addJoint(&acc, id, pc.alpha, i); }
    else { addContact(&acc, id - params.jointCount, pc.alpha, i); }
  }

  // LDLᵀ solve of the 3x3 SPD system
  let D1 = acc.h00;
  let L21 = acc.h10 / acc.h00;
  let L31 = acc.h20 / acc.h00;
  let D2 = acc.h11 - L21 * L21 * D1;
  let L32 = (acc.h21 - L21 * L31 * D1) / D2;
  let D3 = acc.h22 - (L31 * L31 * D1 + L32 * L32 * D2);
  let rhs = acc.rhs;
  let y2 = rhs.y - L21 * rhs.x;
  let y3 = rhs.z - L31 * rhs.x - L32 * y2;
  let x2 = y3 / D3;
  let x1 = y2 / D2 - L32 * x2;
  let x0 = rhs.x / D1 - L21 * x1 - L31 * x2;
  bodies[i].pose = vec4f(pose.xyz - vec3f(x0, x1, x2), pose.w);
}

// --- Dual -----------------------------------------------------------------------------------

fn dualJoint(j: u32) {
  let t = info[j].x;
  if (t == T_NONE) { return; }
  let C = jointRowsC(j, pc.alpha);
  var k = joints[j];
  let vbd = (params.flags & FLAG_VBD) != 0u;
  for (var r = 0u; r < rowCount(t); r++) {
    let lambda = select(0.0, k.lam[r], !vbd && k.stiff[r] >= HARD);
    let lam = clamp(k.pen[r] * C[r] + lambda, k.fmin[r], k.fmax[r]);
    let lo = k.fmin[r];
    let hi = k.fmax[r];
    k.lam[r] = lam;
    if (abs(lam) >= k.frac[r]) {
      // Fracture: the joint stops acting (and stays zero from now on)
      k.pen = vec4f(0.0);
      k.lam = vec4f(0.0);
      k.stiff = vec4f(0.0);
    }
    if (!vbd && lam > lo && lam < hi) {
      k.pen[r] = min(k.pen[r] + params.beta * abs(C[r]), min(PENALTY_MAX, k.stiff[r]));
    }
  }
  joints[j] = k;
}

fn dualContact(c: u32) {
  var k = contacts[c];
  let r = contactRows(k, pc.alpha);
  let vbd = (params.flags & FLAG_VBD) != 0u;
  // Friction bounds (and the stick test) use the normal force from before this update
  let bound = abs(k.pl.z) * k.misc.x;
  k.ids.w = select(0u, 1u, abs(k.pl.w) < bound && abs(k.geo.y) < STICK_THRESH);
  // Normal row: bounds (-BIG, 0]
  let lamN = clamp(k.pl.x * r.C.x + select(k.pl.z, 0.0, vbd), -BIG, 0.0);
  var penN = k.pl.x;
  if (!vbd && lamN > -BIG && lamN < 0.0) { penN = min(penN + params.beta * abs(r.C.x), PENALTY_MAX); }
  // Friction row: bounds [-bound, bound]
  let lamT = clamp(k.pl.y * r.C.y + select(k.pl.w, 0.0, vbd), -bound, bound);
  var penT = k.pl.y;
  if (!vbd && lamT > -bound && lamT < bound) { penT = min(penT + params.beta * abs(r.C.y), PENALTY_MAX); }
  k.pl = vec4f(penN, penT, lamN, lamT);
  contacts[c] = k;
}

/** Dual update of every constraint: joints first, then contacts (one dispatch). */
@compute @workgroup_size(64)
fn dual(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id < params.jointCount) { dualJoint(id); }
  else if (id - params.jointCount < contactCount()) { dualContact(id - params.jointCount); }
}

/** With post stabilization the stick flags come from the final lambdas (see soa refreshStick). */
@compute @workgroup_size(64)
fn refreshStick(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  if (c >= contactCount()) { return; }
  let k = contacts[c];
  let bound = abs(k.pl.z) * k.misc.x;
  contacts[c].ids.w = select(0u, 1u, abs(k.pl.w) < bound && abs(k.geo.y) < STICK_THRESH);
}

@compute @workgroup_size(64)
fn updateVelocities(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  var b = bodies[i];
  b.prevVel = b.vel;
  if (b.shape.z > 0.0) { b.vel = vec4f((b.pose.xyz - b.initial.xyz) / params.dt, 0.0); }
  bodies[i] = b;
}
`;
