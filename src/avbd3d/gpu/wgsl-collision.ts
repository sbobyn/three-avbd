// 3D collision detection on the GPU, structured like the 2D pipeline
// (../../avbd2d/gpu/wgsl-collision.ts):
//
// - broadphase: uniform 3D grid (counting sort by atomics + prefix scan) and pair emission,
//   oversized bodies (the ground) tested brute-force, connected pairs skipped;
// - contacts: box-box SAT with face clipping (up to 8 contacts, a port of ../ref/collide.ts)
//   and sphere contacts, written as a pair record plus its contact points. Each point is
//   warm-started from last step's point with the same feature in the same pair, found
//   through a hash table of last step's pairs.

import { PRELUDE_3D, REUSE_ANG_TOL, REUSE_LIN_TOL } from './layout.ts';

/**
 * Per-body reference poses for contact reuse: a body that has moved or turned beyond the
 * tolerance since its reference pose takes its current pose as the new reference and records
 * the step in inertialPos.w. A pair whose contact points were computed no earlier than both
 * bodies' last move can keep them (narrowphase, FLAG_REUSE_CONTACTS).
 */
export const refsWGSL = /* wgsl */ `
${PRELUDE_3D}

struct RefPose {
  pos: vec4f,
  rot: vec4f,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(2) var<storage, read_write> refs: array<RefPose>;

@compute @workgroup_size(64)
fn updateRefs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  let pos = bodies[i].pos.xyz;
  let rot = bodies[i].rot;
  let last = refs[i];
  // A zero quaternion marks a body without a reference yet
  let moved = dot(last.rot, last.rot) == 0.0
    || length(pos - last.pos.xyz) > ${REUSE_LIN_TOL}
    || length(qsub(rot, last.rot)) > ${REUSE_ANG_TOL};
  if (moved) {
    refs[i] = RefPose(vec4f(pos, 0.0), rot);
    bodies[i].inertialPos.w = bitcast<f32>(params.step);
  }
}
`;

export const broadphaseWGSL = /* wgsl */ `
${PRELUDE_3D}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
// Grid: bucketStart[tableMask + 2] | cursor[tableMask + 1] | sorted[bodies] | cell[3 * bodies]
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> pairs: array<vec2u>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
// Static: large body indices[largeCount] | noCollide (hi, lo, joint) triples, sorted by (hi, lo)
@group(0) @binding(5) var<storage, read> statics: array<u32>;
@group(0) @binding(6) var<storage, read> joints: array<Joint>;

@compute @workgroup_size(1)
fn beginFrame() {
  // Last step's pairs and contacts become "previous" (they sit in the other ping-pong buffers)
  atomicStore(&counters[C_PREV_MANIFOLDS], min(atomicLoad(&counters[C_MANIFOLDS]), params.manifoldCapacity));
  atomicStore(&counters[C_PREV_CONTACTS], min(atomicLoad(&counters[C_CONTACTS]), params.contactCapacity));
  atomicStore(&counters[C_MANIFOLDS], 0u);
  atomicStore(&counters[C_CONTACTS], 0u);
  atomicStore(&counters[C_PAIRS], 0u);
  atomicStore(&counters[C_OVERFLOW], 0u);
  atomicStore(&counters[C_CLASHES], 0u);
  atomicStore(&counters[C_NUM_COLORS], 0u);
}

fn radius(i: u32) -> f32 {
  return bodies[i].moment.w;
}

fn isLarge(i: u32) -> bool {
  return radius(i) > params.maxSmallRadius;
}

fn cellOf(i: u32) -> vec3i {
  return vec3i(floor(bodies[i].pos.xyz / params.cellSize));
}

fn cellHash(c: vec3i) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u) ^ (u32(c.z) * 83492791u)) & params.tableMask;
}

@compute @workgroup_size(64)
fn gridCount(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount || isLarge(i)) { return; }
  let c = cellOf(i);
  for (var k = 0u; k < 3u; k++) { atomicStore(&grid[params.gridCellOffset + 3u * i + k], bitcast<u32>(c[k])); }
  atomicAdd(&grid[cellHash(c)], 1u);
}

@compute @workgroup_size(64)
fn gridScatter(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount || isLarge(i)) { return; }
  let h = cellHash(cellOf(i));
  let slot = atomicLoad(&grid[h]) + atomicAdd(&grid[params.gridCursorOffset + h], 1u);
  atomicStore(&grid[params.gridSortedOffset + slot], i);
}

/** Binary search of the (hi, lo) no-collide list; false if every connecting joint has broken. */
fn ignored(hi: u32, lo: u32) -> bool {
  let base = params.largeCount;
  var first = 0u;
  var count = params.noCollideCount;
  while (count > 0u) {
    let step = count / 2u;
    let mid = first + step;
    let mh = statics[base + 3u * mid];
    let ml = statics[base + 3u * mid + 1u];
    if (mh < hi || (mh == hi && ml < lo)) {
      first = mid + 1u;
      count -= step + 1u;
    } else {
      count = step;
    }
  }
  for (var k = first; k < params.noCollideCount; k++) {
    if (statics[base + 3u * k] != hi || statics[base + 3u * k + 1u] != lo) { break; }
    let j = statics[base + 3u * k + 2u];
    if (j == 0xffffffffu) { return true; }
    if (joints[j].penLin.w != 0.0 || joints[j].penAng.w != 0.0) { return true; }
  }
  return false;
}

/** Half extents of body i's world-space bounding box: |R|·h (a sphere's: its radius). */
fn aabbHalf(i: u32) -> vec3f {
  let h = bodies[i].size.xyz * 0.5;
  if (bodies[i].angVel.w == SHAPE_SPHERE) { return vec3f(h.x); }
  let q = bodies[i].rot;
  let ax = abs(qrotate(q, vec3f(h.x, 0.0, 0.0)));
  let ay = abs(qrotate(q, vec3f(0.0, h.y, 0.0)));
  let az = abs(qrotate(q, vec3f(0.0, 0.0, h.z)));
  return ax + ay + az;
}

fn testPair(i: u32, j: u32) {
  let a = max(i, j);
  let b = min(i, j);
  if (bodies[a].size.w <= 0.0 && bodies[b].size.w <= 0.0) { return; }
  let d = bodies[a].pos.xyz - bodies[b].pos.xyz;
  let r = radius(a) + radius(b);
  if (dot(d, d) > r * r) { return; }
  // Bounding spheres of boxes overlap far more often than the boxes do (neighbouring
  // columns, rows of bricks); world AABBs are a cheap, conservative second test (with a
  // small pad for f32 round-off), so the narrowphase sees fewer pairs it would reject.
  if (any(abs(d) > aabbHalf(a) + aabbHalf(b) + vec3f(1e-4))) { return; }
  if (ignored(a, b)) { return; }
  let slot = atomicAdd(&counters[C_PAIRS], 1u);
  if (slot >= params.pairCapacity) {
    atomicOr(&counters[C_OVERFLOW], 1u);
    return;
  }
  pairs[slot] = vec2u(a, b);
}

@compute @workgroup_size(64)
fn findPairs(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount) { return; }
  let small = !isLarge(i);
  if (small) {
    // Every overlapping small pair is in the same or an adjacent cell; emit from the higher index
    let c = cellOf(i);
    for (var oz = -1; oz <= 1; oz++) {
      for (var oy = -1; oy <= 1; oy++) {
        for (var ox = -1; ox <= 1; ox++) {
          let cell = c + vec3i(ox, oy, oz);
          let h = cellHash(cell);
          let end = atomicLoad(&grid[h + 1u]);
          for (var k = atomicLoad(&grid[h]); k < end; k++) {
            let j = atomicLoad(&grid[params.gridSortedOffset + k]);
            if (j >= i) { continue; }
            // Different cells can share a bucket; only accept bodies really in this cell
            let o = params.gridCellOffset + 3u * j;
            let cj = vec3i(bitcast<i32>(atomicLoad(&grid[o])), bitcast<i32>(atomicLoad(&grid[o + 1u])), bitcast<i32>(atomicLoad(&grid[o + 2u])));
            if (any(cj != cell)) { continue; }
            testPair(i, j);
          }
        }
      }
    }
  }
  // Large bodies against everything (large-large pairs once, from the larger index)
  for (var k = 0u; k < params.largeCount; k++) {
    let l = statics[k];
    if (l == i || (!small && l < i)) { continue; }
    testPair(l, i);
  }
}
`;

export const contactsWGSL = /* wgsl */ `
${PRELUDE_3D}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> contacts: array<Contact>;
@group(0) @binding(4) var<storage, read> prevContacts: array<Contact>;
@group(0) @binding(5) var<storage, read_write> manifolds: array<Manifold>;
@group(0) @binding(6) var<storage, read> prevManifolds: array<Manifold>;
@group(0) @binding(7) var<storage, read_write> table: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> counters: array<atomic<u32>>;

fn pairHash(a: u32, b: u32) -> u32 {
  return hash32((a * 0x9e3779b1u) ^ hash32(b));
}

/** Last step's pairs into the table (slot value = pair index + 1), linear probing. */
@compute @workgroup_size(64)
fn hashInsert(@builtin(global_invocation_id) gid: vec3u) {
  let m = gid.x;
  if (m >= atomicLoad(&counters[C_PREV_MANIFOLDS])) { return; }
  let ids = prevManifolds[m].ids;
  var h = pairHash(ids.x, ids.y) & params.hashMask;
  var probe = 0u;
  while (probe <= params.hashMask) {
    let r = atomicCompareExchangeWeak(&table[h], 0u, m + 1u);
    if (r.exchanged) { return; }
    // A weak exchange may fail spuriously on an empty slot: retry rather than skip it
    if (r.old_value != 0u) {
      h = (h + 1u) & params.hashMask;
      probe++;
    }
  }
}

/** Index of last step's pair (a, b), or -1. */
fn hashFind(a: u32, b: u32) -> i32 {
  var h = pairHash(a, b) & params.hashMask;
  for (var probe = 0u; probe <= params.hashMask; probe++) {
    let v = atomicLoad(&table[h]);
    if (v == 0u) { return -1; }
    let ids = prevManifolds[v - 1u].ids;
    if (ids.x == a && ids.y == b) { return i32(v - 1u); }
    h = (h + 1u) & params.hashMask;
  }
  return -1;
}

// --- Narrowphase: OBB SAT + clipping (../ref/collide.ts) -----------------------------------

const MAX_CONTACTS = 8u;
const MAX_POLY = 8u;
const SAT_AXIS_EPSILON = 1.0e-6;
const PLANE_EPSILON = 1.0e-5;
const CONTACT_MERGE_DIST_SQ = 1.0e-6;
const AXIS_FACE_A = 0u;
const AXIS_FACE_B = 1u;
const AXIS_EDGE = 2u;

struct Box {
  c: vec3f,
  h: vec3f,
  ax: array<vec3f, 3>,
}

struct Sat {
  kind: u32,
  ia: u32,
  ib: u32,
  sep: f32,
  n: vec3f,  // from A towards B
  valid: bool,
}

struct Found {
  feature: array<u32, 8>,
  xA: array<vec3f, 8>,
  xB: array<vec3f, 8>,
  count: u32,
}

fn makeBox(i: u32) -> Box {
  let q = bodies[i].rot;
  var b: Box;
  b.c = bodies[i].pos.xyz;
  b.h = bodies[i].size.xyz * 0.5;
  b.ax[0] = qrotate(q, vec3f(1.0, 0.0, 0.0));
  b.ax[1] = qrotate(q, vec3f(0.0, 1.0, 0.0));
  b.ax[2] = qrotate(q, vec3f(0.0, 0.0, 1.0));
  return b;
}

fn projRadius(b: Box, n: vec3f) -> f32 {
  return b.h.x * abs(dot(n, b.ax[0])) + b.h.y * abs(dot(n, b.ax[1])) + b.h.z * abs(dot(n, b.ax[2]));
}

/** SAT test of one axis; false when it separates the boxes. Tracks the least-separated axis. */
fn testAxis(A: Box, B: Box, delta: vec3f, axis: vec3f, kind: u32, ia: u32, ib: u32, best: ptr<function, Sat>) -> bool {
  let lenSq = dot(axis, axis);
  if (lenSq < SAT_AXIS_EPSILON) { return true; }
  var n = axis * inverseSqrt(lenSq);
  if (dot(n, delta) < 0.0) { n = -n; }
  let sep = abs(dot(delta, n)) - (projRadius(A, n) + projRadius(B, n));
  if (sep > 0.0) { return false; }
  if (!(*best).valid || sep > (*best).sep) { *best = Sat(kind, ia, ib, sep, n, true); }
  return true;
}

fn support(b: Box, dir: vec3f) -> vec3f {
  let s = select(vec3f(-1.0), vec3f(1.0), vec3f(dot(dir, b.ax[0]), dot(dir, b.ax[1]), dot(dir, b.ax[2])) >= vec3f(0.0));
  return b.c + b.ax[0] * (b.h.x * s.x) + b.ax[1] * (b.h.y * s.y) + b.ax[2] * (b.h.z * s.z);
}

fn addFound(f: ptr<function, Found>, xA: vec3f, xB: vec3f, feature: u32) {
  let mid = (xA + xB) * 0.5;
  for (var i = 0u; i < (*f).count; i++) {
    let d = mid - ((*f).xA[i] + (*f).xB[i]) * 0.5;
    if (dot(d, d) < CONTACT_MERGE_DIST_SQ) { return; }
  }
  if ((*f).count >= MAX_CONTACTS) { return; }
  (*f).feature[(*f).count] = feature;
  (*f).xA[(*f).count] = xA;
  (*f).xB[(*f).count] = xB;
  (*f).count++;
}

/**
 * Sutherland-Hodgman: clip src (n verts) against dot(pn, x) <= offset into dst. A quad
 * clipped by four planes has at most 8 vertices (the reference allows 16 but never needs them),
 * and the vertex order is the reference's, so contact indices (feature keys) match.
 */
fn clipPlane(src: ptr<function, array<vec3f, 8>>, n: u32, dst: ptr<function, array<vec3f, 8>>, pn: vec3f, offset: f32) -> u32 {
  if (n == 0u) { return 0u; }
  var count = 0u;
  var a = (*src)[n - 1u];
  var da = dot(pn, a) - offset;
  for (var i = 0u; i < n; i++) {
    let b = (*src)[i];
    let db = dot(pn, b) - offset;
    let aIn = da <= PLANE_EPSILON;
    let bIn = db <= PLANE_EPSILON;
    if (aIn != bIn) {
      var t = 0.0;
      let denom = da - db;
      if (abs(denom) > SAT_AXIS_EPSILON) { t = clamp(da / denom, 0.0, 1.0); }
      if (count < MAX_POLY) { (*dst)[count] = a + (b - a) * t; count++; }
    }
    if (bIn && count < MAX_POLY) { (*dst)[count] = b; count++; }
    a = b;
    da = db;
  }
  return count;
}

/** Face-axis (u, v) extents: axis 0 -> (1, 2), 1 -> (0, 2), 2 -> (0, 1). */
fn faceU(k: u32) -> u32 { return select(0u, 1u, k == 0u); }
fn faceV(k: u32) -> u32 { return select(1u, 2u, k != 2u); }

fn faceManifold(A: Box, B: Box, refIsA: bool, refAxis: u32, nAB: vec3f) -> Found {
  var found: Found;
  var R = B;
  var I = A;
  if (refIsA) {
    R = A;
    I = B;
  }
  let outward = select(-nAB, nAB, refIsA);

  // Reference face
  let rs = select(-1.0, 1.0, dot(outward, R.ax[refAxis]) >= 0.0);
  let rn = R.ax[refAxis] * rs;
  let rc = R.c + rn * R.h[refAxis];
  let ru = R.ax[faceU(refAxis)];
  let rv = R.ax[faceV(refAxis)];
  let eu = R.h[faceU(refAxis)];
  let ev = R.h[faceV(refAxis)];

  // Incident face: the incident box's face most anti-parallel to the reference normal
  var incAxis = 0u;
  var bestDot = -1.0;
  for (var k = 0u; k < 3u; k++) {
    let d = abs(dot(I.ax[k], rn));
    if (d > bestDot) { bestDot = d; incAxis = k; }
  }
  let is = select(1.0, -1.0, dot(I.ax[incAxis], rn) > 0.0);
  let ic = I.c + I.ax[incAxis] * (is * I.h[incAxis]);
  let iu = I.ax[faceU(incAxis)] * I.h[faceU(incAxis)];
  let iv = I.ax[faceV(incAxis)] * I.h[faceV(incAxis)];
  var poly: array<vec3f, 8>;
  var tmp: array<vec3f, 8>;
  poly[0] = ic + iu + iv;
  poly[1] = ic - iu + iv;
  poly[2] = ic - iu - iv;
  poly[3] = ic + iu - iv;
  var n = 4u;
  n = clipPlane(&poly, n, &tmp, ru, dot(ru, rc) + eu);
  n = clipPlane(&tmp, n, &poly, -ru, dot(-ru, rc) + eu);
  n = clipPlane(&poly, n, &tmp, rv, dot(rv, rc) + ev);
  n = clipPlane(&tmp, n, &poly, -rv, dot(-rv, rc) + ev);
  if (n == 0u) { return found; }

  let prefix = (select(AXIS_FACE_B, AXIS_FACE_A, refIsA) << 24u) | (refAxis << 16u) | (incAxis << 8u);
  for (var i = 0u; i < n && found.count < MAX_CONTACTS; i++) {
    let p = poly[i];
    let dist = dot(p - rc, rn);
    if (dist > PLANE_EPSILON) { continue; }
    let onRef = p - rn * dist;
    addFound(&found, select(p, onRef, refIsA), select(onRef, p, refIsA), prefix | i);
  }
  if (found.count == 0u) { addFound(&found, support(A, nAB), support(B, -nAB), prefix); }
  return found;
}

fn supportEdge(b: Box, k: u32, dir: vec3f) -> array<vec3f, 2> {
  let k1 = (k + 1u) % 3u;
  let k2 = (k + 2u) % 3u;
  let s1 = select(-1.0, 1.0, dot(dir, b.ax[k1]) >= 0.0);
  let s2 = select(-1.0, 1.0, dot(dir, b.ax[k2]) >= 0.0);
  let c = b.c + b.ax[k1] * (b.h[k1] * s1) + b.ax[k2] * (b.h[k2] * s2);
  let e = b.ax[k] * b.h[k];
  return array<vec3f, 2>(c - e, c + e);
}

fn edgeContact(A: Box, B: Box, ia: u32, ib: u32, nAB: vec3f) -> Found {
  var found: Found;
  let ea = supportEdge(A, ia, nAB);
  let eb = supportEdge(B, ib, -nAB);
  // Closest points between the two segments
  let p0 = ea[0];
  let q0 = eb[0];
  let d1 = ea[1] - p0;
  let d2 = eb[1] - q0;
  let r = p0 - q0;
  let a = dot(d1, d1);
  let e = dot(d2, d2);
  let f = dot(d2, r);
  var s = 0.0;
  var t = 0.0;
  if (a <= SAT_AXIS_EPSILON && e <= SAT_AXIS_EPSILON) {
    // both degenerate: s = t = 0
  } else if (a <= SAT_AXIS_EPSILON) {
    t = clamp(f / e, 0.0, 1.0);
  } else {
    let c = dot(d1, r);
    if (e <= SAT_AXIS_EPSILON) {
      s = clamp(-c / a, 0.0, 1.0);
    } else {
      let b = dot(d1, d2);
      let denom = a * e - b * b;
      if (abs(denom) > SAT_AXIS_EPSILON) { s = clamp((b * f - c * e) / denom, 0.0, 1.0); }
      t = (b * s + f) / e;
      if (t < 0.0) {
        t = 0.0;
        s = clamp(-c / a, 0.0, 1.0);
      } else if (t > 1.0) {
        t = 1.0;
        s = clamp((b - c) / a, 0.0, 1.0);
      }
    }
  }
  let key = (AXIS_EDGE << 24u) | (ia << 8u) | ib;
  addFound(&found, p0 + d1 * s, q0 + d2 * t, key);
  if (found.count == 0u) { addFound(&found, support(A, nAB), support(B, -nAB), key); }
  return found;
}

// --- Spheres (GPU-only extension, ../shapes.ts) -------------------------------------------

/** Sphere against sphere: one contact, normal along the centre line. */
fn sphereSphere(A: Box, B: Box, sat: ptr<function, Sat>) -> Found {
  var found: Found;
  let d = B.c - A.c;
  let dist = length(d);
  if (dist > A.h.x + B.h.x) { return found; }
  var n = vec3f(0.0, 0.0, 1.0);
  if (dist > 0.0) { n = d / dist; }
  (*sat).n = n;
  addFound(&found, A.c + n * A.h.x, B.c - n * B.h.x, SPHERE_FEATURE);
  return found;
}

struct SphereBoxHit {
  hit: bool,
  onSphere: vec3f,
  onBox: vec3f,
  n: vec3f,  // from the sphere towards the box
}

/** Sphere S against box X: closest point of the box, or the shallowest face when inside. */
fn sphereBox(S: Box, X: Box, qX: vec4f) -> SphereBoxHit {
  var out: SphereBoxHit;
  let p = qrotate(qconj(qX), S.c - X.c);
  let q = clamp(p, -X.h, X.h);
  let r = S.h.x;
  var nLocal: vec3f;  // from the box towards the sphere, box frame
  var onBox = q;
  if (any(p != q)) {
    let d = p - q;
    let dist = length(d);
    if (dist > r) { return out; }
    nLocal = d / dist;
  } else {
    // Centre inside the box: push out through the face of least penetration
    let depth = X.h - abs(p);
    var k = 0u;
    if (depth.y < depth[k]) { k = 1u; }
    if (depth.z < depth[k]) { k = 2u; }
    let s = select(-1.0, 1.0, p[k] >= 0.0);
    nLocal = vec3f(0.0);
    nLocal[k] = s;
    onBox[k] = s * X.h[k];
  }
  let n = qrotate(qX, nLocal);
  out.hit = true;
  out.n = -n;
  out.onBox = X.c + qrotate(qX, onBox);
  out.onSphere = S.c - n * r;
  return out;
}

/** Collide boxes a and b; the contact normal (B to A) is -sat.n. */
fn collide(A: Box, B: Box, sat: ptr<function, Sat>) -> Found {
  var none: Found;
  let delta = B.c - A.c;
  var face: Sat;
  var edge: Sat;
  for (var i = 0u; i < 3u; i++) { if (!testAxis(A, B, delta, A.ax[i], AXIS_FACE_A, i, 0u, &face)) { return none; } }
  for (var i = 0u; i < 3u; i++) { if (!testAxis(A, B, delta, B.ax[i], AXIS_FACE_B, 0u, i, &face)) { return none; } }
  for (var i = 0u; i < 3u; i++) {
    for (var j = 0u; j < 3u; j++) {
      if (!testAxis(A, B, delta, cross(A.ax[i], B.ax[j]), AXIS_EDGE, i, j, &edge)) { return none; }
    }
  }
  if (!face.valid) { return none; }
  // Prefer a face axis unless an edge axis is clearly better (stabler manifolds). The demo
  // scales the edge separation by 0.95, which for penetrating boxes (negative separations)
  // favours the edge: a box sunk 0.7 into another, faces aligned, gets a single edge contact
  // and never recovers (docs/FINDINGS.md). FLAG_FACE_BIAS scales the face separation instead
  // (as Box2D does), so an edge must beat the face by a margin that grows with penetration.
  var best = face;
  if (edge.valid) {
    var edgeWins = 0.95 * edge.sep > face.sep + 0.01;
    if ((params.flags & FLAG_FACE_BIAS) != 0u) { edgeWins = edge.sep > 0.95 * face.sep + 0.01; }
    if (edgeWins) { best = edge; }
  }
  *sat = best;
  if (best.kind == AXIS_EDGE) { return edgeContact(A, B, best.ia, best.ib, best.n); }
  return faceManifold(A, B, best.kind == AXIS_FACE_A, select(best.ib, best.ia, best.kind == AXIS_FACE_A), best.n);
}

/**
 * Keep pair (a, b)'s contact points from last step, skipping SAT and clipping, when they were
 * computed no earlier than both bodies last moved beyond the reuse tolerance (refsWGSL). The
 * points keep their warm-start data; C(x-) is recomputed from the current poses. Returns
 * false when the pair must go through the narrowphase.
 */
fn reuseContacts(a: u32, b: u32) -> bool {
  let pm = hashFind(a, b);
  if (pm < 0) { return false; }
  let prev = prevManifolds[pm];
  let count = pairCount(prev);
  let generated = prev.ids.w >> 4u;
  let moved = max(bitcast<u32>(bodies[a].inertialPos.w), bitcast<u32>(bodies[b].inertialPos.w));
  if (count == 0u || generated < moved) { return false; }

  let m = atomicAdd(&counters[C_MANIFOLDS], 1u);
  if (m >= params.manifoldCapacity) {
    atomicOr(&counters[C_OVERFLOW], 4u);
    return true;
  }
  let base = atomicAdd(&counters[C_CONTACTS], count);
  if (base + count > params.contactCapacity) {
    atomicOr(&counters[C_OVERFLOW], 2u);
    manifolds[m] = Manifold(vec4u(a, b, base, prev.ids.w & ~15u), prev.geo);
    return true;
  }
  manifolds[m] = Manifold(vec4u(a, b, base, prev.ids.w), prev.geo);

  let pA = bodies[a].pos.xyz;
  let qA = bodies[a].rot;
  let pB = bodies[b].pos.xyz;
  let qB = bodies[b].rot;
  let basis = orthonormal(prev.geo.xyz);
  for (var i = 0u; i < count; i++) {
    var k = prevContacts[prev.ids.z + i];
    // C(x-) at the current poses, then the usual warm start (Eq. 19)
    let d = (qrotate(qA, k.rA) + pA) - (qrotate(qB, k.rB) + pB);
    k.c0x = dot(basis[0], d) + COLLISION_MARGIN;
    k.c0y = dot(basis[1], d);
    k.c0z = dot(basis[2], d);
    k.lam = k.lam * params.alpha * params.gamma;
    k.pen = clamp(k.pen * params.gamma, vec3f(PENALTY_MIN), vec3f(PENALTY_MAX));
    contacts[base + i] = k;
  }
  return true;
}

@compute @workgroup_size(64)
fn narrowphase(@builtin(global_invocation_id) gid: vec3u) {
  let p = gid.x;
  if (p >= min(atomicLoad(&counters[C_PAIRS]), params.pairCapacity)) { return; }
  let a = pairs[p].x;
  let b = pairs[p].y;
  if ((params.flags & FLAG_REUSE_CONTACTS) != 0u && reuseContacts(a, b)) { return; }
  let A = makeBox(a);
  let B = makeBox(b);
  var sat: Sat;
  var found: Found;
  let sphereA = bodies[a].angVel.w == SHAPE_SPHERE;
  let sphereB = bodies[b].angVel.w == SHAPE_SPHERE;
  if (sphereA && sphereB) {
    found = sphereSphere(A, B, &sat);
  } else if (sphereA || sphereB) {
    // sat.n points from A towards B
    var h: SphereBoxHit;
    if (sphereA) {
      h = sphereBox(A, B, bodies[b].rot);
      sat.n = h.n;
      if (h.hit) { addFound(&found, h.onSphere, h.onBox, SPHERE_FEATURE); }
    } else {
      h = sphereBox(B, A, bodies[a].rot);
      sat.n = -h.n;
      if (h.hit) { addFound(&found, h.onBox, h.onSphere, SPHERE_FEATURE); }
    }
  } else {
    found = collide(A, B, &sat);
  }
  if (found.count == 0u) { return; }

  // Reserve the pair record and its consecutive contact points
  let m = atomicAdd(&counters[C_MANIFOLDS], 1u);
  if (m >= params.manifoldCapacity) {
    atomicOr(&counters[C_OVERFLOW], 4u);
    return;
  }
  let base = atomicAdd(&counters[C_CONTACTS], found.count);
  var count = found.count;
  if (base + count > params.contactCapacity) {
    atomicOr(&counters[C_OVERFLOW], 2u);
    count = 0u;
  }
  let n = -sat.n;
  manifolds[m] = Manifold(vec4u(a, b, base, count | (params.step << 4u)), vec4f(n, sqrt(bodies[a].pos.w * bodies[b].pos.w)));
  if (count == 0u) { return; }

  let qA = bodies[a].rot;
  let qB = bodies[b].rot;
  let basis = orthonormal(n);
  let anySphere = sphereA || sphereB;
  // Last step's contacts of this pair (at most 8, consecutive)
  var prevFirst = 0u;
  var prevCount = 0u;
  let pm = hashFind(a, b);
  if (pm >= 0) {
    prevFirst = prevManifolds[pm].ids.z;
    prevCount = pairCount(prevManifolds[pm]);
  }
  let matchNearest = (params.flags & FLAG_MATCH_NEAREST) != 0u;
  let minSide = min(min(min(A.h.x, A.h.y), A.h.z), min(min(B.h.x, B.h.y), B.h.z)) * 2.0;

  for (var i = 0u; i < count; i++) {
    var rA = qrotate(qconj(qA), found.xA[i] - A.c);
    var rB = qrotate(qconj(qB), found.xB[i] - B.c);
    var pen = vec3f(0.0);
    var lam = vec3f(0.0);
    var stick = 0u;

    // Warm start from last step's point with this feature; with matchNearest, fall back to
    // the pair's previous point nearest in A-local anchor position
    var j = -1;
    for (var c = prevFirst; c < prevFirst + prevCount; c++) {
      if ((prevContacts[c].key & ~STICK_BIT) == found.feature[i]) { j = i32(c); break; }
    }
    if (j < 0 && matchNearest) {
      var bestDist = NEAREST_FRACTION * minSide;
      for (var c = prevFirst; c < prevFirst + prevCount; c++) {
        let dist = length(prevContacts[c].rA - rA);
        if (dist <= bestDist) {
          bestDist = dist;
          j = i32(c);
        }
      }
    }
    if (j >= 0) {
      let prev = prevContacts[j];
      pen = prev.pen;
      lam = prev.lam;
      stick = prev.key & STICK_BIT;
      // Static friction last step: keep the old anchors. Not for spheres: their contact point
      // moves over both surfaces as they roll, and pinned anchors would rotate away with them
      if (stick != 0u && !anySphere) {
        rA = prev.rA;
        rB = prev.rB;
      }
    }

    // C(x-) in the contact basis, plus the collision margin on the normal row
    let d = (qrotate(qA, rA) + A.c) - (qrotate(qB, rB) + B.c);
    let c0 = vec3f(dot(basis[0], d) + COLLISION_MARGIN, dot(basis[1], d), dot(basis[2], d));

    // Warm start the dual variables and penalty parameters (Eq. 19)
    lam = lam * params.alpha * params.gamma;
    pen = clamp(pen * params.gamma, vec3f(PENALTY_MIN), vec3f(PENALTY_MAX));

    contacts[base + i] = Contact(rA, found.feature[i] | stick, rB, c0.x, pen, c0.y, lam, c0.z);
  }
}
`;
