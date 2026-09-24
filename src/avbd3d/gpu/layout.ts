// Buffer layouts shared by the 3D GPU host code and its WGSL. Counters, indirect-argument
// slots, colouring and the Params fields read by the shared kernels (topology, args) are the
// 2D pipeline's (../../avbd2d/gpu/layout.ts). As there, Infinity is never stored on the GPU:
// unbounded stiffness is BIG and a row is hard when its stiffness is >= HARD.

import { CORE_WGSL } from '../../avbd2d/gpu/layout.ts';

/**
 * Floats per body, 10 vec4. Everything a contact reads comes first (one 64-byte span):
 * pos (xyz, friction), rot (quaternion), initialPos, initialRot; then size (xyz, mass),
 * moment (xyz, bounding radius), inertialPos, inertialRot, vel (xyz, previous vel.z),
 * angVel (xyz, shape: SHAPE_BOX / SHAPE_SPHERE). Rendering reads pos, rot, size and shape.
 */
export const BODY_FLOATS = 40;
export const B_POS = 0;
export const B_ROT = 4;
export const B_INITIAL_POS = 8;
export const B_INITIAL_ROT = 12;
export const B_SIZE = 16;
export const B_MOMENT = 20;
export const B_INERTIAL_POS = 24;
export const B_INERTIAL_ROT = 28;
export const B_VEL = 32;
export const B_ANGVEL = 36;

/** Floats per joint record (joints and springs): 8 vec4. */
export const JOINT_FLOATS = 32;
export const J_PEN_LIN = 0; // xyz, w: stiffness (joint lin; spring: its stiffness)
export const J_PEN_ANG = 4; // xyz, w: angular stiffness
export const J_LAM_LIN = 8; // xyz, w: fracture threshold on |lambdaAng|
export const J_LAM_ANG = 12; // xyz, w: torque arm
export const J_C0_LIN = 16;
export const J_C0_ANG = 20;
export const J_RA = 24; // xyz (world point for world joints), w: spring rest length
export const J_RB = 28;

/**
 * Contacts come in pairs' manifolds: a 32-byte pair record (bodies, first contact, contact
 * count, normal, friction) and 64 bytes per contact point, stored consecutively per pair.
 * Loading both bodies and the basis once per pair instead of once per point is most of the
 * solve's memory traffic.
 */
export const MANIFOLD_WORDS = 8;
export const M_IDS = 0; // a, b (a > b), first contact, count | generation step << 4 (u32)
export const M_GEO = 4; // normal (B to A) xyz, friction

/** 32-bit words per contact point: 4 vec4, the w's carrying the key and C0. */
export const CONTACT_WORDS = 16;
export const K_RA = 0; // body-local anchor on A, w: key (feature | STICK_BIT, u32)
export const K_RB = 4; // body-local anchor on B, w: C0 normal
export const K_PEN = 8; // penalty xyz, w: C0 tangent 1
export const K_LAM = 12; // lambda xyz, w: C0 tangent 2
/** Static friction held last step (features use bits 0-25). */
export const STICK_BIT = 0x80000000;

// Counter words beyond the shared ones (../../avbd2d/gpu/layout.ts uses 0-5)
export const C_MANIFOLDS = 6;
export const C_PREV_MANIFOLDS = 7;

/** Shape codes in angVel.w (spheres: see ../shapes.ts; radius = size.x / 2). */
export const SHAPE_BOX = 0;
export const SHAPE_SPHERE = 1;

export const T_JOINT = 1;
export const T_SPRING = 2;

export const FLAG_MATCH_NEAREST = 1;
/** Prefer face axes over edge axes the way Box2D does (see wgsl-collision.ts collide). */
export const FLAG_FACE_BIAS = 2;
/** Reuse a pair's contact points while neither body has moved (wgsl-collision.ts). */
export const FLAG_REUSE_CONTACTS = 4;
/**
 * A body counts as still while within this distance (m) and rotation (rad) of its reference
 * pose; its pairs then keep their contact points instead of re-running the narrowphase.
 */
export const REUSE_LIN_TOL = 0.002;
export const REUSE_ANG_TOL = 0.002;
/** matchNearest tolerance, as a fraction of the smaller box's smallest side. */
export const NEAREST_FRACTION = 0.05;

/** Words in the Params uniform (see the struct in PRELUDE_3D). */
export const PARAM_WORDS = 32;

export const PRELUDE_3D = /* wgsl */ `
// Shared by every 3D module (avbd3d/gpu/layout.ts)
${CORE_WGSL}
const T_JOINT = ${T_JOINT};
const T_SPRING = ${T_SPRING};

const PENALTY_MIN = 1.0;
const PENALTY_MAX = 1e10;
const COLLISION_MARGIN = 0.01;
const STICK_THRESH = 0.00001;

const SHAPE_SPHERE = ${SHAPE_SPHERE}.0;
const STICK_BIT = ${STICK_BIT}u;
const C_MANIFOLDS = ${C_MANIFOLDS}u;
const C_PREV_MANIFOLDS = ${C_PREV_MANIFOLDS}u;
/** Feature key of every contact involving a sphere (one contact per pair). */
const SPHERE_FEATURE = 3u << 24u;

const FLAG_MATCH_NEAREST = ${FLAG_MATCH_NEAREST}u;
const FLAG_FACE_BIAS = ${FLAG_FACE_BIAS}u;
const FLAG_REUSE_CONTACTS = ${FLAG_REUSE_CONTACTS}u;
const NEAREST_FRACTION = ${NEAREST_FRACTION};

struct Body {
  pos: vec4f,          // xyz, w: friction
  rot: vec4f,          // orientation quaternion (x, y, z, w)
  initialPos: vec4f,   // pose at the start of the step (x-)
  initialRot: vec4f,
  size: vec4f,         // full widths, w: mass (0 = static)
  moment: vec4f,       // principal moments, w: bounding radius
  inertialPos: vec4f,  // inertial target y, w: step it last moved from its reference pose (u32)
  inertialRot: vec4f,
  vel: vec4f,          // xyz, w: previous step's vel.z (adaptive warm start)
  angVel: vec4f,       // xyz, w: shape (SHAPE_BOX, SHAPE_SPHERE)
}

struct Joint {
  penLin: vec4f,  // xyz, w: linear stiffness (>= HARD: hard); spring: its stiffness
  penAng: vec4f,  // xyz, w: angular stiffness
  lamLin: vec4f,  // xyz, w: fracture threshold on |lamAng|
  lamAng: vec4f,  // xyz, w: torque arm
  c0Lin: vec4f,   // C(x-)
  c0Ang: vec4f,
  rA: vec4f,      // xyz: anchor on A (world point when A is the world), w: spring rest length
  rB: vec4f,      // xyz: anchor on B
}

struct Manifold {
  ids: vec4u,     // bodyA, bodyB (A > B), first contact, count | generation step << 4
  geo: vec4f,     // normal (B to A), friction
}

fn pairCount(m: Manifold) -> u32 {
  return m.ids.w & 15u;
}

struct Contact {
  rA: vec3f,      // body-local anchors
  key: u32,       // feature | STICK_BIT
  rB: vec3f,
  c0x: f32,       // C(x-) in the pair's basis, including the collision margin
  pen: vec3f,     // normal, tangent, tangent
  c0y: f32,
  lam: vec3f,
  c0z: f32,
}

struct Params {
  dt: f32,
  gravity: f32,
  betaLin: f32,
  betaAng: f32,
  gamma: f32,
  alpha: f32,
  flags: u32,
  bodyCount: u32,
  jointCount: u32,
  colorCap: u32,
  cellSize: f32,
  tableMask: u32,
  maxSmallRadius: f32,
  largeCount: u32,
  noCollideCount: u32,
  pairCapacity: u32,
  contactCapacity: u32,
  hashMask: u32,
  adjFillOffset: u32,
  adjListOffset: u32,
  gridCursorOffset: u32,
  gridSortedOffset: u32,
  gridCellOffset: u32,
  stateBOffset: u32,
  colorHistOffset: u32,
  colorStartOffset: u32,
  colorGroups: u32,
  colorBodiesOffset: u32,
  rounds: u32,
  manifoldCapacity: u32,
  step: u32,           // steps since the solver was created (from 1)
  pad2: u32,
}

fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(
    a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z);
}

fn qconj(q: vec4f) -> vec4f {
  return vec4f(-q.xyz, q.w);
}

/** The demo's quat - quat: 2·vec(a·b⁻¹), a small-angle rotation vector. */
fn qsub(a: vec4f, b: vec4f) -> vec3f {
  return qmul(a, qconj(b) / dot(b, b)).xyz * 2.0;
}

/** The demo's quat + float3: integrate a rotation vector, normalize(a + (v, 0)·a·½). */
fn qadd(a: vec4f, v: vec3f) -> vec4f {
  return normalize(a + qmul(vec4f(v, 0.0), a) * 0.5);
}

fn qrotate(q: vec4f, v: vec3f) -> vec3f {
  let t = cross(q.xyz, v) * 2.0;
  return v + t * q.w + cross(q.xyz, t);
}

/** Contact basis rows (n, t1, t2), as maths.h orthonormal(). */
fn orthonormal(n: vec3f) -> mat3x3f {
  var t1 = select(vec3f(0.0, -n.z, n.y), vec3f(-n.y, n.x, 0.0), abs(n.x) > abs(n.z));
  t1 = normalize(t1);
  // Columns of the WGSL matrix are the basis rows
  return mat3x3f(n, t1, cross(n, t1));
}
`;

/** 3D record accessors for the shared topology kernels (../../avbd2d/gpu/wgsl-topology.ts). */
export const TOPOLOGY_ACCESSORS_3D = /* wgsl */ `
alias TopoItem = Manifold;

fn topoCount() -> u32 {
  return min(atomicLoad(&counters[C_MANIFOLDS]), params.manifoldCapacity);
}

fn dynamicBody(i: i32) -> bool {
  return i >= 0 && bodies[i].size.w > 0.0;
}

/** A joint or spring takes part unless disabled (fracture, released drag): stiffness zeroed. */
fn jointActive(j: u32) -> bool {
  let k = joints[j];
  return info[j].x != T_NONE && (k.penLin.w != 0.0 || k.penAng.w != 0.0);
}
`;

/** Indirect-argument items for the shared args kernels: contact pairs. */
export const ARGS_ITEMS_3D = { counter: 'C_MANIFOLDS', prevCounter: 'C_PREV_MANIFOLDS', capacity: 'params.manifoldCapacity' };
