// Buffer layouts shared by the 2D GPU host code and its WGSL, plus the WGSL prelude every
// module starts with. Infinity is never stored on the GPU: WGSL implementations may assume
// finite floats (Metal compiles with fast math), so unbounded values are ±BIG and a row is
// hard when its stiffness is >= HARD.

export const WORKGROUP_SIZE = 64;
/** Bodies per workgroup in the colour bucketing kernels (one histogram per workgroup). */
export const COLOR_WG = 256;
export const BIG = 3.0e38;

/** Floats per body: pose (x, y, angle, friction), initial, inertial, vel, prevVel, shape. */
export const BODY_FLOATS = 24;
/** Floats per joint record (joints, springs, motors): 9 vec4. */
export const JOINT_FLOATS = 36;
// vec4 slots within a joint record
export const J_PEN = 0;
export const J_LAM = 4;
export const J_STIFF = 8;
export const J_FMIN = 12;
export const J_FMAX = 16;
export const J_FRAC = 20;
export const J_C0 = 24;
export const J_ANCHORS = 28; // rA.xy (world point for world joints), rB.xy
export const J_PARAM = 32; // joint: restAngle, torqueArm; spring: rest; motor: speed

/** 32-bit words per contact record: 5 vec4. */
export const CONTACT_WORDS = 20;
// Word offsets within a contact record
export const K_IDS = 0; // a, b, feature, stick (u32)
export const K_PL = 4; // pen.n, pen.t, lam.n, lam.t
export const K_ANCHORS = 8; // rA.xy, rB.xy (body-local)
export const K_GEO = 12; // c0.n, c0.t, normal.xy
export const K_MISC = 16; // friction

export const FLAG_VBD = 1;
export const FLAG_RESCALE = 2;
export const FLAG_POST_STABILIZE = 4;
export const FLAG_MATCH_NEAREST = 8;
/** matchNearest tolerance, as a fraction of the smaller box's smallest side (as on the CPU). */
export const NEAREST_FRACTION = 0.05;

export const MAX_COLORS = 64;
export const NO_COLOR = 255;

// Counter words (atomic u32)
export const C_PAIRS = 0;
export const C_CONTACTS = 1;
export const C_PREV_CONTACTS = 2;
export const C_OVERFLOW = 3; // bit 0: pairs dropped, bit 1: contacts dropped
export const C_CLASHES = 4;
export const C_NUM_COLORS = 5;
export const COUNTER_WORDS = 16;

// Indirect dispatch argument triples (u32 x, y, z) in the args buffer. That buffer is written
// only by the args module, never bound by a kernel dispatched from it: WebGPU forbids a
// buffer being both the indirect source and a writable binding of the same dispatch.
export const IA_PAIRS = 0;
export const IA_CONTACTS = 3;
export const IA_PREV = 6;
export const IA_CONSTRAINTS = 9; // joints + contacts (the dual pass)
export const IA_COLOR = 12; // + 3 * colour
export const ARGS_WORDS = IA_COLOR + 3 * MAX_COLORS;

/** Words in the Params uniform (see the struct in PRELUDE). */
export const PARAM_WORDS = 32;
/** Bytes per per-dispatch uniform entry (dynamic offset alignment). */
export const PASS_STRIDE = 256;

/**
 * WGSL shared by the 2D and 3D pipelines: counters, indirect-argument slots, colouring and
 * hashing constants. Each dimension's prelude starts with it and adds its own structs.
 */
/** Constraint slot types (the joint info's first word): none (released or unused), a joint, a spring. */
export const T_NONE = 0;

export const CORE_WGSL = /* wgsl */ `
const T_NONE = ${T_NONE};

const MAX_COLORS = ${MAX_COLORS}u;
const NO_COLOR = ${NO_COLOR}u;
const PENDING = 256u;

const C_PAIRS = ${C_PAIRS}u;
const C_CONTACTS = ${C_CONTACTS}u;
const C_PREV_CONTACTS = ${C_PREV_CONTACTS}u;
const C_OVERFLOW = ${C_OVERFLOW}u;
const C_CLASHES = ${C_CLASHES}u;
const C_NUM_COLORS = ${C_NUM_COLORS}u;

const IA_PAIRS = ${IA_PAIRS}u;
const IA_CONTACTS = ${IA_CONTACTS}u;
const IA_PREV = ${IA_PREV}u;
const IA_CONSTRAINTS = ${IA_CONSTRAINTS}u;
const IA_COLOR = ${IA_COLOR}u;

const WG = ${WORKGROUP_SIZE}u;
const COLOR_WG = ${COLOR_WG}u;

const BIG = 3e38;
const HARD = 1e30;

fn groupsFor(n: u32) -> u32 {
  return (n + WG - 1u) / WG;
}

/** lowbias32 integer hash (same as the CPU colouring priorities). */
fn hash32(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
`;

export const PRELUDE = /* wgsl */ `
// Shared by every 2D module (layout.ts)
${CORE_WGSL}
const T_JOINT = 1;
const T_SPRING = 2;
const T_MOTOR = 3;

const PENALTY_MIN = 1.0;
const PENALTY_MAX = 1e9;
const STICK_THRESH = 0.01;
const COLLISION_MARGIN = 0.0005;

const FLAG_VBD = ${FLAG_VBD}u;
const FLAG_RESCALE = ${FLAG_RESCALE}u;
const FLAG_POST_STABILIZE = ${FLAG_POST_STABILIZE}u;
const FLAG_MATCH_NEAREST = ${FLAG_MATCH_NEAREST}u;
const NEAREST_FRACTION = ${NEAREST_FRACTION};

struct Body {
  pose: vec4f,      // x, y, angle, friction
  initial: vec4f,   // pose at the start of the step (x-)
  inertial: vec4f,  // inertial target y
  vel: vec4f,
  prevVel: vec4f,
  shape: vec4f,     // width, height, mass, moment
}

struct Joint {
  pen: vec4f,       // per-row penalty (stiffness parameter k)
  lam: vec4f,       // per-row dual variable
  stiff: vec4f,     // per-row material stiffness (>= HARD: hard constraint)
  fmin: vec4f,
  fmax: vec4f,
  frac: vec4f,      // per-row fracture threshold on |lambda|
  c0: vec4f,        // C(x-)
  anchors: vec4f,   // rA.xy (world point for world joints), rB.xy
  param: vec4f,     // joint: restAngle, torqueArm; spring: rest; motor: speed
}

struct Contact {
  ids: vec4u,       // bodyA, bodyB (A > B), feature key, stick flag
  pl: vec4f,        // penalty normal/tangent, lambda normal/tangent
  anchors: vec4f,   // rA.xy, rB.xy in body-local space
  geo: vec4f,       // C0 normal, C0 tangent, normal.xy (B to A)
  misc: vec4f,      // friction
}

struct Params {
  dt: f32,
  gravity: f32,
  beta: f32,
  gamma: f32,
  alpha: f32,
  vbdStiffness: f32,
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
  colorHistOffset: u32,   // per (colour, workgroup) body counts, scanned into slot offsets
  colorStartOffset: u32,
  colorGroups: u32,       // workgroups of COLOR_WG bodies covering the body capacity
  colorBodiesOffset: u32,
  rounds: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}

/**
 * (cos x, sin x) to ~1e-7. WGSL promises the built-ins only to 2^-11 absolute and GPUs differ:
 * on an M1 Pro, stiff springs (Spring Ratio) drifted 9 cm from the CPU in 60 steps and a
 * single friction step missed by 1.2e-4, where the M4 Max tracked to 1.6e-4 and 4e-6; rounding
 * the built-ins to 2^-13 on the M4 reproduced it. Cody-Waite reduction by pi/2 (three-part
 * constant) and the Cephes single-precision polynomials on [-pi/4, pi/4].
 */
fn cosSin(x: f32) -> vec2f {
  let q = floor(x * 0.63661977236 + 0.5);
  // fma keeps the three parts apart: written as subtractions, fast math folded them back into
  // one rounded pi/2 and the error grew with the angle (2.8e-6 at 100 rad)
  let r = fma(-q, 7.549789954891882e-8, fma(-q, 4.837512969970703e-4, fma(-q, 1.5703125, x)));
  let z = r * r;
  let s = r + r * z * (-1.6666654611e-1 + z * (8.3321608736e-3 + z * -1.9515295891e-4));
  let c = 1.0 - 0.5 * z + z * z * (4.1666645683e-2 + z * (-1.3887316255e-3 + z * 2.4433157468e-5));
  switch (u32(i32(q)) & 3u) {
    case 0u: { return vec2f(c, s); }
    case 1u: { return vec2f(-s, c); }
    case 2u: { return vec2f(-c, -s); }
    default: { return vec2f(s, -c); }
  }
}

fn rot(angle: f32, v: vec2f) -> vec2f {
  let cs = cosSin(angle);
  return vec2f(cs.x * v.x - cs.y * v.y, cs.y * v.x + cs.x * v.y);
}

`;

/**
 * Writes the indirect dispatch arguments from the counters and colour counts. Works with
 * either dimension's prelude (it only reads the shared Params fields). The per-step
 * constraint records after the joints (IA_CONTACTS, and with the joints IA_CONSTRAINTS) and
 * last step's records (IA_PREV) are contacts by default; 3D passes its contact pairs.
 */
export const makeArgsWGSL = (
  prelude: string,
  items: {
    counter: string;
    prevCounter: string;
    capacity: string;
    /** WGSL defining fn colorThreads(bodies: u32) -> u32, when a colour's primal runs several threads per body. */
    colorThreads?: string;
  } = { counter: 'C_CONTACTS', prevCounter: 'C_PREV_CONTACTS', capacity: 'params.contactCapacity' },
): string => /* wgsl */ `
${prelude}
${items.colorThreads ?? 'fn colorThreads(bodies: u32) -> u32 { return bodies; }'}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> counters: array<u32>;
@group(0) @binding(2) var<storage, read> color: array<u32>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;

fn setArgs(at: u32, count: u32) {
  args[at] = groupsFor(count);
  args[at + 1u] = 1u;
  args[at + 2u] = 1u;
}

@compute @workgroup_size(1)
fn argsPrev() {
  setArgs(IA_PREV, counters[${items.prevCounter}]);
}

@compute @workgroup_size(1)
fn argsPairs() {
  setArgs(IA_PAIRS, min(counters[C_PAIRS], params.pairCapacity));
}

@compute @workgroup_size(1)
fn argsContacts() {
  let items = min(counters[${items.counter}], ${items.capacity});
  setArgs(IA_CONTACTS, items);
  setArgs(IA_CONSTRAINTS, params.jointCount + items);
}

@compute @workgroup_size(64)
fn argsColors(@builtin(local_invocation_id) lid: vec3u) {
  let c = lid.x;
  setArgs(IA_COLOR + 3u * c, colorThreads(color[params.colorStartOffset + c + 1u] - color[params.colorStartOffset + c]));
}
`;

export const argsWGSL = makeArgsWGSL(PRELUDE);

/** The step's phases, each encoded as its own compute pass (so each can be timestamped). */
export const PHASES = ['collision', 'adjacency', 'coloring', 'solve'] as const;
export type Phase = (typeof PHASES)[number];

/** GPU milliseconds per phase, and from the first phase's start to the last one's end. */
export type StepProfile = Record<Phase, number> & { total: number };

export interface GpuCounters {
  pairs: number;
  contacts: number;
  overflow: number;
  clashes: number;
  colors: number;
}
