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

/** Rows of one constraint at the current poses, with derivatives w.r.t. \`body\` (if >= 0). */
struct Rows {
  C: vec3f,
  fmin: vec3f,
  fmax: vec3f,
  pen: vec3f,
  lam: vec3f,
  stiff: vec3f,
  J: array<vec3f, 3>,  // Jacobian rows w.r.t. the solved body
  G: array<vec3f, 3>,  // diagonal geometric-stiffness weights per row (Sec. 3.5)
  n: u32,
}

fn evalJoint(j: u32, alpha: f32, body: i32) -> Rows {
  let t = info[j].x;
  let a = info[j].y;
  let b = info[j].z;
  let k = joints[j];
  var e: Rows;
  e.n = rowCount(t);
  e.fmin = k.fmin.xyz;
  e.fmax = k.fmax.xyz;
  e.pen = k.pen.xyz;
  e.lam = k.lam.xyz;
  e.stiff = k.stiff.xyz;
  let isA = body == a;
  let sg = select(-1.0, 1.0, isA);

  if (t == T_JOINT) {
    e.C = jointC(k, a, b);
    for (var r = 0; r < 3; r++) {
      if (k.stiff[r] >= HARD) { e.C[r] -= k.c0[r] * alpha; }
    }
    if (body >= 0) {
      let r = rot(bodies[body].pose.z, select(k.anchors.zw, k.anchors.xy, isA));
      e.J[0] = vec3f(sg, 0.0, -sg * r.y);
      e.J[1] = vec3f(0.0, sg, sg * r.x);
      e.J[2] = vec3f(0.0, 0.0, sg * k.param.y);
      e.G[0] = vec3f(0.0, 0.0, abs(r.x));
      e.G[1] = vec3f(0.0, 0.0, abs(r.y));
    }
  } else if (t == T_SPRING) {
    let pa4 = bodies[a].pose;
    let pb4 = bodies[b].pose;
    let d = (rot(pa4.z, k.anchors.xy) + pa4.xy) - (rot(pb4.z, k.anchors.zw) + pb4.xy);
    let len2 = dot(d, d);
    let len = sqrt(len2);
    e.C = vec3f(len - k.param.x, 0.0, 0.0);
    if (body >= 0 && len2 != 0.0) {
      let n = d / len;
      let d00 = (1.0 - n.x * n.x) / len;
      let d01 = -n.x * n.y / len;
      let d11 = (1.0 - n.y * n.y) / len;
      let ang = bodies[body].pose.z;
      let lr = select(k.anchors.zw, k.anchors.xy, isA);
      let sr = rot(ang, vec2f(-lr.y, lr.x));
      let r = rot(ang, lr);
      let dxr0 = d00 * sr.x + d01 * sr.y;
      let dxr1 = d01 * sr.x + d11 * sr.y;
      let nr = dot(n, r);
      e.J[0] = sg * vec3f(n, dot(n, sr));
      let drr = select(nr + nr, -nr - nr, isA);
      e.G[0] = vec3f(length(vec3f(d00, d01, dxr0)), length(vec3f(d01, d11, dxr1)), length(vec3f(dxr0, dxr1, drr)));
    }
  } else if (t == T_MOTOR) {
    var dA = 0.0;
    if (a >= 0) { dA = bodies[a].pose.z - bodies[a].initial.z; }
    let dB = bodies[b].pose.z - bodies[b].initial.z;
    e.C = vec3f(dA - dB - k.param.x * params.dt, 0.0, 0.0);
    if (body >= 0) { e.J[0] = vec3f(0.0, 0.0, sg); }
  }
  return e;
}

fn evalContact(c: u32, alpha: f32, body: i32) -> Rows {
  let k = contacts[c];
  let a = i32(k.ids.x);
  let b = i32(k.ids.y);
  var e: Rows;
  e.n = 2u;
  e.pen = vec3f(k.pl.xy, 0.0);
  e.lam = vec3f(k.pl.zw, 0.0);
  e.stiff = vec3f(BIG);
  // Normal pushes only; friction bounded by the current normal force
  let bound = abs(k.pl.z) * k.misc.x;
  e.fmin = vec3f(-BIG, -bound, -BIG);
  e.fmax = vec3f(0.0, bound, BIG);

  // Taylor expansion about x- (Sec. 4): C = (1 - alpha) C0 + J (x - x-)
  let n = k.geo.zw;
  let tg = vec2f(n.y, -n.x);
  let A = bodies[a];
  let B = bodies[b];
  let rA = rot(A.initial.z, k.anchors.xy);
  let rB = rot(B.initial.z, k.anchors.zw);
  let jAn = vec3f(n, rA.x * n.y - rA.y * n.x);
  let jBn = -vec3f(n, rB.x * n.y - rB.y * n.x);
  let jAt = vec3f(tg, rA.x * tg.y - rA.y * tg.x);
  let jBt = -vec3f(tg, rB.x * tg.y - rB.y * tg.x);
  let dA = A.pose.xyz - A.initial.xyz;
  let dB = B.pose.xyz - B.initial.xyz;
  e.C = vec3f(
    k.geo.x * (1.0 - alpha) + dot(jAn, dA) + dot(jBn, dB),
    k.geo.y * (1.0 - alpha) + dot(jAt, dA) + dot(jBt, dB),
    0.0);
  if (body >= 0) {
    let isA = body == a;
    e.J[0] = select(jBn, jAn, isA);
    e.J[1] = select(jBt, jAt, isA);
  }
  return e;
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
  let i = color[params.colorBodiesOffset + start + gid.x];
  let b = bodies[i];
  let dt2 = params.dt * params.dt;
  let mdt = b.shape.z / dt2;
  let idt = b.shape.w / dt2;
  var h00 = mdt;
  var h10 = 0.0;
  var h11 = mdt;
  var h20 = 0.0;
  var h21 = 0.0;
  var h22 = idt;
  var rhs = vec3f(mdt * (b.pose.x - b.inertial.x), mdt * (b.pose.y - b.inertial.y), idt * (b.pose.z - b.inertial.z));
  let vbd = (params.flags & FLAG_VBD) != 0u;
  let rescale = (params.flags & FLAG_RESCALE) != 0u;

  let end = adj[i + 1u];
  for (var e = adj[i]; e < end; e++) {
    let id = adj[params.adjListOffset + e];
    var ev: Rows;
    if (id < params.jointCount) { ev = evalJoint(id, pc.alpha, i32(i)); }
    else { ev = evalContact(id - params.jointCount, pc.alpha, i32(i)); }
    for (var r = 0u; r < ev.n; r++) {
      let lambda = select(0.0, ev.lam[r], !vbd && ev.stiff[r] >= HARD);
      var pen = ev.pen[r];
      let C = ev.C[r];
      let fRaw = pen * C + lambda;
      let f = clamp(fRaw, ev.fmin[r], ev.fmax[r]);
      let af = abs(f);
      // Stiffness rescaling for clamped forces (Eq. 14), Hessian only
      if (rescale && C != 0.0) {
        if (fRaw < ev.fmin[r]) { pen = abs((ev.fmin[r] - lambda) / C); }
        else if (fRaw > ev.fmax[r]) { pen = abs((ev.fmax[r] - lambda) / C); }
      }
      let j = ev.J[r];
      let g = ev.G[r];
      rhs += j * f;
      h00 += j.x * j.x * pen + g.x * af;
      h10 += j.y * j.x * pen;
      h11 += j.y * j.y * pen + g.y * af;
      h20 += j.z * j.x * pen;
      h21 += j.z * j.y * pen;
      h22 += j.z * j.z * pen + g.z * af;
    }
  }

  // LDLᵀ solve of the 3x3 SPD system
  let D1 = h00;
  let L21 = h10 / h00;
  let L31 = h20 / h00;
  let D2 = h11 - L21 * L21 * D1;
  let L32 = (h21 - L21 * L31 * D1) / D2;
  let D3 = h22 - (L31 * L31 * D1 + L32 * L32 * D2);
  let y2 = rhs.y - L21 * rhs.x;
  let y3 = rhs.z - L31 * rhs.x - L32 * y2;
  let x2 = y3 / D3;
  let x1 = y2 / D2 - L32 * x2;
  let x0 = rhs.x / D1 - L21 * x1 - L31 * x2;
  bodies[i].pose = vec4f(b.pose.xyz - vec3f(x0, x1, x2), b.pose.w);
}

// --- Dual -----------------------------------------------------------------------------------

@compute @workgroup_size(64)
fn dualJoints(@builtin(global_invocation_id) gid: vec3u) {
  let j = gid.x;
  if (j >= params.jointCount || info[j].x == T_NONE) { return; }
  let ev = evalJoint(j, pc.alpha, -1);
  var k = joints[j];
  let vbd = (params.flags & FLAG_VBD) != 0u;
  for (var r = 0u; r < ev.n; r++) {
    let lambda = select(0.0, k.lam[r], !vbd && k.stiff[r] >= HARD);
    let lam = clamp(k.pen[r] * ev.C[r] + lambda, ev.fmin[r], ev.fmax[r]);
    k.lam[r] = lam;
    if (abs(lam) >= k.frac[r]) {
      // Fracture: the joint stops acting (and stays zero from now on)
      k.pen = vec4f(0.0);
      k.lam = vec4f(0.0);
      k.stiff = vec4f(0.0);
    }
    if (!vbd && lam > ev.fmin[r] && lam < ev.fmax[r]) {
      k.pen[r] = min(k.pen[r] + params.beta * abs(ev.C[r]), min(PENALTY_MAX, k.stiff[r]));
    }
  }
  joints[j] = k;
}

@compute @workgroup_size(64)
fn dualContacts(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  if (c >= contactCount()) { return; }
  let ev = evalContact(c, pc.alpha, -1);
  var k = contacts[c];
  let vbd = (params.flags & FLAG_VBD) != 0u;
  // Stick test with the bounds from before this update, like the reference
  k.ids.w = select(0u, 1u, abs(k.pl.w) < ev.fmax.y && abs(k.geo.y) < STICK_THRESH);
  var pen = k.pl.xy;
  var lamv = k.pl.zw;
  for (var r = 0; r < 2; r++) {
    let lambda = select(0.0, lamv[r], !vbd);
    let lam = clamp(pen[r] * ev.C[r] + lambda, ev.fmin[r], ev.fmax[r]);
    lamv[r] = lam;
    if (!vbd && lam > ev.fmin[r] && lam < ev.fmax[r]) {
      pen[r] = min(pen[r] + params.beta * abs(ev.C[r]), PENALTY_MAX);
    }
  }
  k.pl = vec4f(pen, lamv);
  contacts[c] = k;
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
