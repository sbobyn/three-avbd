// Collision detection on the GPU, in two modules (each within the 8-storage-buffer limit):
//
// - broadphase: uniform grid (counting sort by atomics + prefix scan) and pair emission,
//   with oversized bodies tested brute-force and connected pairs skipped;
// - contacts: box-box narrowphase, warm-started from the matching contact of the previous
//   step, found through a hash table keyed on (bodyA, bodyB, feature).
//
// Same tests and merge rules as ../soa (broadphase.ts, collide.ts, solver.ts narrowphase).
// Pair and contact order is arbitrary (atomic appends); nothing downstream depends on it.

import { PRELUDE } from './layout.ts';

export const broadphaseWGSL = /* wgsl */ `
${PRELUDE}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
// Grid: bucketStart[tableMask + 2] | cursor[tableMask + 1] | sorted[bodies] | cell[2 * bodies]
@group(0) @binding(2) var<storage, read_write> grid: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> pairs: array<vec2u>;
@group(0) @binding(4) var<storage, read_write> counters: array<atomic<u32>>;
// Static: large body indices[largeCount] | noCollide (hi, lo, joint) triples, sorted by (hi, lo)
@group(0) @binding(5) var<storage, read> statics: array<u32>;
@group(0) @binding(6) var<storage, read> joints: array<Joint>;

// --- Frame start --------------------------------------------------------------------------

@compute @workgroup_size(1)
fn beginFrame() {
  // Last step's contacts become "previous" (they sit in the other ping-pong buffer)
  let prev = min(atomicLoad(&counters[C_CONTACTS]), params.contactCapacity);
  atomicStore(&counters[C_PREV_CONTACTS], prev);
  atomicStore(&counters[C_CONTACTS], 0u);
  atomicStore(&counters[C_PAIRS], 0u);
  atomicStore(&counters[C_OVERFLOW], 0u);
  atomicStore(&counters[C_CLASHES], 0u);
  atomicStore(&counters[C_NUM_COLORS], 0u);
}

// --- Broadphase ---------------------------------------------------------------------------

fn radius(i: u32) -> f32 {
  return 0.5 * length(bodies[i].shape.xy);
}

fn isLarge(i: u32) -> bool {
  return radius(i) > params.maxSmallRadius;
}

fn cellOf(i: u32) -> vec2i {
  return vec2i(floor(bodies[i].pose.xy / params.cellSize));
}

fn cellHash(c: vec2i) -> u32 {
  return ((u32(c.x) * 73856093u) ^ (u32(c.y) * 19349663u)) & params.tableMask;
}

@compute @workgroup_size(64)
fn gridCount(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= params.bodyCount || isLarge(i)) { return; }
  let c = cellOf(i);
  atomicStore(&grid[params.gridCellOffset + 2u * i], bitcast<u32>(c.x));
  atomicStore(&grid[params.gridCellOffset + 2u * i + 1u], bitcast<u32>(c.y));
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

/** Binary search of the (hi, lo) no-collide list; false if the pair's joint has broken. */
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
  // Several constraints can connect the same pair; any live one (or an IgnoreCollision)
  // keeps the pair from colliding.
  for (var k = first; k < params.noCollideCount; k++) {
    if (statics[base + 3u * k] != hi || statics[base + 3u * k + 1u] != lo) { break; }
    let j = statics[base + 3u * k + 2u];
    if (j == 0xffffffffu) { return true; }
    let s = joints[j].stiff;
    if (s.x != 0.0 || s.y != 0.0 || s.z != 0.0) { return true; }
  }
  return false;
}

fn testPair(i: u32, j: u32) {
  let a = max(i, j);
  let b = min(i, j);
  if (bodies[a].shape.z <= 0.0 && bodies[b].shape.z <= 0.0) { return; }
  let d = bodies[a].pose.xy - bodies[b].pose.xy;
  let r = radius(a) + radius(b);
  if (dot(d, d) > r * r) { return; }
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
    for (var oy = -1; oy <= 1; oy++) {
      for (var ox = -1; ox <= 1; ox++) {
        let cell = c + vec2i(ox, oy);
        let h = cellHash(cell);
        let end = atomicLoad(&grid[h + 1u]);
        for (var k = atomicLoad(&grid[h]); k < end; k++) {
          let j = atomicLoad(&grid[params.gridSortedOffset + k]);
          if (j >= i) { continue; }
          // Different cells can share a bucket; only accept bodies really in this cell
          let cj = vec2i(bitcast<i32>(atomicLoad(&grid[params.gridCellOffset + 2u * j])), bitcast<i32>(atomicLoad(&grid[params.gridCellOffset + 2u * j + 1u])));
          if (any(cj != cell)) { continue; }
          testPair(i, j);
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
${PRELUDE}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> pairs: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> contacts: array<Contact>;
@group(0) @binding(4) var<storage, read> prevContacts: array<Contact>;
@group(0) @binding(5) var<storage, read_write> table: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> counters: array<atomic<u32>>;

fn contactHash(a: u32, b: u32, feature: u32) -> u32 {
  return hash32((a * 0x9e3779b1u) ^ hash32(b ^ hash32(feature)));
}

/** Feature key used to look up a per-pair entry (real features are bytes <= 4). */
const PAIR_ENTRY = 0xffffffffu;

/** Slot values: contact index + 1, with PAIR_BIT set on per-pair entries. */
const PAIR_BIT = 0x80000000u;

// Slots are claimed by atomicExchange rather than compare-exchange (Safari's Metal backend
// fails to compile atomicCompareExchangeWeak, github issue 1): a taken slot's occupant is
// swapped out and carried on to the next slot, which keeps it on its own probe chain, with
// no empty slot before it for a lookup to stop at.
fn insert(a: u32, b: u32, feature: u32, first: u32) {
  var h = contactHash(a, b, feature) & params.hashMask;
  var value = first;
  for (var probe = 0u; probe <= params.hashMask; probe++) {
    value = atomicExchange(&table[h], value);
    if (value == 0u) { return; }
    h = (h + 1u) & params.hashMask;
  }
}

/**
 * Insert last step's contacts into the table (slot value = contact index + 1), plus one
 * pair-only entry per manifold for the matchNearest fallback. A pair's contacts are always
 * consecutive (narrowphase reserves them with one atomicAdd), so the entry points at the first.
 */
@compute @workgroup_size(64)
fn hashInsert(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= atomicLoad(&counters[C_PREV_CONTACTS])) { return; }
  let ids = prevContacts[k].ids;
  insert(ids.x, ids.y, ids.z, k + 1u);
  if ((params.flags & FLAG_MATCH_NEAREST) != 0u) {
    let first = k == 0u || prevContacts[k - 1u].ids.x != ids.x || prevContacts[k - 1u].ids.y != ids.y;
    if (first) { insert(ids.x, ids.y, PAIR_ENTRY, (k + 1u) | PAIR_BIT); }
  }
}

/** Index of last step's contact with this key, or -1. */
fn hashFind(a: u32, b: u32, feature: u32) -> i32 {
  var h = contactHash(a, b, feature) & params.hashMask;
  for (var probe = 0u; probe <= params.hashMask; probe++) {
    let v = atomicLoad(&table[h]);
    if (v == 0u) { return -1; }
    // Pair entries (PAIR_BIT) match on the pair alone, contact entries on the full key
    let isPair = (v & PAIR_BIT) != 0u;
    let index = (v & ~PAIR_BIT) - 1u;
    let ids = prevContacts[index].ids;
    if (isPair == (feature == PAIR_ENTRY) && ids.x == a && ids.y == b && (isPair || ids.z == feature)) { return i32(index); }
    h = (h + 1u) & params.hashMask;
  }
  return -1;
}

// --- Narrowphase (box2d-lite clipping, see ../soa/collide.ts) -----------------------------

struct ClipV {
  p: vec2f,
  f: vec4u,  // inEdge1, outEdge1, inEdge2, outEdge2
}

struct Clip {
  v: array<ClipV, 2>,
  n: u32,
}

fn clipSegment(src: array<ClipV, 2>, n: vec2f, offset: f32, clipEdge: u32) -> Clip {
  var o: Clip;
  let d0 = dot(n, src[0].p) - offset;
  let d1 = dot(n, src[1].p) - offset;
  if (d0 <= 0.0) { o.v[o.n] = src[0]; o.n++; }
  if (d1 <= 0.0) { o.v[o.n] = src[1]; o.n++; }
  if (d0 * d1 < 0.0 && o.n < 2u) {
    var cv: ClipV;
    cv.p = src[0].p + (src[1].p - src[0].p) * (d0 / (d0 - d1));
    if (d0 > 0.0) { cv.f = vec4u(clipEdge, src[0].f.y, 0u, src[0].f.w); }
    else { cv.f = vec4u(src[1].f.x, clipEdge, src[1].f.z, 0u); }
    o.v[o.n] = cv;
    o.n++;
  }
  return o;
}

fn incidentEdge(h: vec2f, pos: vec2f, c: f32, s: f32, fnrm: vec2f) -> array<ClipV, 2> {
  // Reference face normal in the incident box's frame, flipped
  let n = -vec2f(c * fnrm.x + s * fnrm.y, -s * fnrm.x + c * fnrm.y);
  var v: array<ClipV, 2>;
  if (abs(n.x) > abs(n.y)) {
    if (n.x > 0.0) {
      v[0] = ClipV(vec2f(h.x, -h.y), vec4u(0u, 0u, 3u, 4u));
      v[1] = ClipV(vec2f(h.x, h.y), vec4u(0u, 0u, 4u, 1u));
    } else {
      v[0] = ClipV(vec2f(-h.x, h.y), vec4u(0u, 0u, 1u, 2u));
      v[1] = ClipV(vec2f(-h.x, -h.y), vec4u(0u, 0u, 2u, 3u));
    }
  } else if (n.y > 0.0) {
    v[0] = ClipV(vec2f(h.x, h.y), vec4u(0u, 0u, 4u, 1u));
    v[1] = ClipV(vec2f(-h.x, h.y), vec4u(0u, 0u, 1u, 2u));
  } else {
    v[0] = ClipV(vec2f(-h.x, -h.y), vec4u(0u, 0u, 2u, 3u));
    v[1] = ClipV(vec2f(h.x, -h.y), vec4u(0u, 0u, 3u, 4u));
  }
  for (var i = 0; i < 2; i++) {
    let p = v[i].p;
    v[i].p = pos + vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
  }
  return v;
}

struct ContactOut {
  feature: u32,
  rA: vec2f,
  rB: vec2f,
  n: vec2f,  // B to A
}

struct Collision {
  count: u32,
  c: array<ContactOut, 2>,
}

fn collideBoxes(pa: vec3f, ha: vec2f, pb: vec3f, hb: vec2f) -> Collision {
  var out: Collision;
  let csA = cosSin(pa.z);
  let csB = cosSin(pb.z);
  let cA = csA.x;
  let sA = csA.y;
  let cB = csB.x;
  let sB = csB.y;
  let dp = pb.xy - pa.xy;
  let dA = vec2f(cA * dp.x + sA * dp.y, -sA * dp.x + cA * dp.y);
  let dB = vec2f(cB * dp.x + sB * dp.y, -sB * dp.x + cB * dp.y);
  let a00 = abs(cA * cB + sA * sB);
  let a01 = abs(cA * -sB + sA * cB);
  let a10 = abs(-sA * cB + cA * sB);
  let a11 = abs(-sA * -sB + cA * cB);

  let faceA = abs(dA) - ha - vec2f(a00 * hb.x + a01 * hb.y, a10 * hb.x + a11 * hb.y);
  if (faceA.x > 0.0 || faceA.y > 0.0) { return out; }
  let faceB = abs(dB) - vec2f(a00 * ha.x + a10 * ha.y, a01 * ha.x + a11 * ha.y) - hb;
  if (faceB.x > 0.0 || faceB.y > 0.0) { return out; }

  // Best separating axis, biased towards A's faces for coherence
  var axis = 0;
  var separation = faceA.x;
  var n = select(vec2f(-cA, -sA), vec2f(cA, sA), dA.x > 0.0);
  if (faceA.y > 0.95 * separation + 0.01 * ha.y) {
    axis = 1;
    separation = faceA.y;
    n = select(vec2f(sA, -cA), vec2f(-sA, cA), dA.y > 0.0);
  }
  if (faceB.x > 0.95 * separation + 0.01 * hb.x) {
    axis = 2;
    separation = faceB.x;
    n = select(vec2f(-cB, -sB), vec2f(cB, sB), dB.x > 0.0);
  }
  if (faceB.y > 0.95 * separation + 0.01 * hb.y) {
    axis = 3;
    separation = faceB.y;
    n = select(vec2f(sB, -cB), vec2f(-sB, cB), dB.y > 0.0);
  }

  var fnrm: vec2f;
  var front: f32;
  var sn: vec2f;
  var negSide: f32;
  var posSide: f32;
  var negEdge: u32;
  var posEdge: u32;
  var incident: array<ClipV, 2>;
  if (axis == 0) {
    fnrm = n;
    front = dot(pa.xy, fnrm) + ha.x;
    sn = vec2f(-sA, cA);
    let side = dot(pa.xy, sn);
    negSide = -side + ha.y;
    posSide = side + ha.y;
    negEdge = 3u;
    posEdge = 1u;
    incident = incidentEdge(hb, pb.xy, cB, sB, fnrm);
  } else if (axis == 1) {
    fnrm = n;
    front = dot(pa.xy, fnrm) + ha.y;
    sn = vec2f(cA, sA);
    let side = dot(pa.xy, sn);
    negSide = -side + ha.x;
    posSide = side + ha.x;
    negEdge = 2u;
    posEdge = 4u;
    incident = incidentEdge(hb, pb.xy, cB, sB, fnrm);
  } else if (axis == 2) {
    fnrm = -n;
    front = dot(pb.xy, fnrm) + hb.x;
    sn = vec2f(-sB, cB);
    let side = dot(pb.xy, sn);
    negSide = -side + hb.y;
    posSide = side + hb.y;
    negEdge = 3u;
    posEdge = 1u;
    incident = incidentEdge(ha, pa.xy, cA, sA, fnrm);
  } else {
    fnrm = -n;
    front = dot(pb.xy, fnrm) + hb.y;
    sn = vec2f(cB, sB);
    let side = dot(pb.xy, sn);
    negSide = -side + hb.x;
    posSide = side + hb.x;
    negEdge = 2u;
    posEdge = 4u;
    incident = incidentEdge(ha, pa.xy, cA, sA, fnrm);
  }

  let clip1 = clipSegment(incident, -sn, negSide, negEdge);
  if (clip1.n < 2u) { return out; }
  let clip2 = clipSegment(clip1.v, sn, posSide, posEdge);
  if (clip2.n < 2u) { return out; }

  for (var i = 0; i < 2; i++) {
    let v = clip2.v[i].p;
    let sep = dot(fnrm, v) - front;
    if (sep > 0.0) { continue; }
    // Slide the point onto the reference face; flip features when B is the reference
    let onRef = v - fnrm * sep;
    var f = clip2.v[i].f;
    var wa: vec2f;
    var wb: vec2f;
    if (axis >= 2) {
      f = vec4u(f.z, f.w, f.x, f.y);
      wa = v - pa.xy;
      wb = onRef - pb.xy;
    } else {
      wa = onRef - pa.xy;
      wb = v - pb.xy;
    }
    var c: ContactOut;
    c.feature = (f.x & 0xffu) | ((f.y & 0xffu) << 8u) | ((f.z & 0xffu) << 16u) | ((f.w & 0xffu) << 24u);
    c.rA = vec2f(cA * wa.x + sA * wa.y, -sA * wa.x + cA * wa.y);
    c.rB = vec2f(cB * wb.x + sB * wb.y, -sB * wb.x + cB * wb.y);
    c.n = -n;
    out.c[out.count] = c;
    out.count++;
  }
  return out;
}

@compute @workgroup_size(64)
fn narrowphase(@builtin(global_invocation_id) gid: vec3u) {
  let p = gid.x;
  if (p >= min(atomicLoad(&counters[C_PAIRS]), params.pairCapacity)) { return; }
  let a = pairs[p].x;
  let b = pairs[p].y;
  let A = bodies[a];
  let B = bodies[b];
  let col = collideBoxes(A.pose.xyz, A.shape.xy * 0.5, B.pose.xyz, B.shape.xy * 0.5);
  if (col.count == 0u) { return; }
  let base = atomicAdd(&counters[C_CONTACTS], col.count);
  let vbd = (params.flags & FLAG_VBD) != 0u;
  let postStabilize = (params.flags & FLAG_POST_STABILIZE) != 0u;

  for (var i = 0u; i < col.count; i++) {
    let k = base + i;
    if (k >= params.contactCapacity) {
      atomicOr(&counters[C_OVERFLOW], 2u);
      return;
    }
    let o = col.c[i];
    var rec: Contact;
    rec.ids = vec4u(a, b, o.feature, 0u);
    rec.anchors = vec4f(o.rA, o.rB);
    rec.misc = vec4f(sqrt(A.pose.w * B.pose.w), 0.0, 0.0, 0.0);

    // Warm start from the matching contact of last step (same pair, same feature); with
    // matchNearest, fall back to the pair's previous contact nearest in A-local anchor position
    var j = hashFind(a, b, o.feature);
    if (j < 0 && (params.flags & FLAG_MATCH_NEAREST) != 0u) {
      let first = hashFind(a, b, PAIR_ENTRY);
      if (first >= 0) {
        var best = NEAREST_FRACTION * min(min(A.shape.x, A.shape.y), min(B.shape.x, B.shape.y));
        let count = atomicLoad(&counters[C_PREV_CONTACTS]);
        for (var c = u32(first); c < min(u32(first) + 2u, count); c++) {
          let ids = prevContacts[c].ids;
          if (ids.x != a || ids.y != b) { break; }
          let dist = length(prevContacts[c].anchors.xy - o.rA);
          if (dist <= best) {
            best = dist;
            j = i32(c);
          }
        }
      }
    }
    if (j >= 0) {
      let prev = prevContacts[j];
      rec.pl = prev.pl;
      // Static friction last step: keep the old anchors
      if (prev.ids.w != 0u) { rec.anchors = prev.anchors; }
    }

    // C(x-) in the contact basis (normal, tangent)
    let rAW = rot(A.pose.z, rec.anchors.xy);
    let rBW = rot(B.pose.z, rec.anchors.zw);
    let d = A.pose.xy + rAW - B.pose.xy - rBW;
    rec.geo = vec4f(dot(o.n, d) + COLLISION_MARGIN, o.n.y * d.x - o.n.x * d.y, o.n);

    // Warm start the penalty and dual variables (Eq. 19); contacts are hard constraints
    if (vbd) {
      rec.pl = vec4f(params.vbdStiffness, params.vbdStiffness, rec.pl.zw);
    } else {
      if (!postStabilize) { rec.pl = vec4f(rec.pl.xy, rec.pl.zw * params.alpha * params.gamma); }
      rec.pl = vec4f(clamp(rec.pl.xy * params.gamma, vec2f(PENALTY_MIN), vec2f(PENALTY_MAX)), rec.pl.zw);
    }
    contacts[k] = rec;
  }
}
`;
