// Per-step topology on the GPU: per-body constraint adjacency (degree count with atomics,
// prefix scan, atomic scatter) and incremental Jones-Plassmann colouring, a port of
// ../soa/coloring.ts with the same hashed priorities, so it reproduces the CPU colouring.
//
// Constraint ids: joints (incl. springs, motors) are 0 .. jointCount-1, contacts follow.
// Colour state per body: colour in the low 8 bits (NO_COLOR = none) plus a PENDING bit.
// Rounds read one state buffer and write the other (Jacobi), so bodies never see a
// neighbour's colour from the same round.
//
// Dimension-agnostic: the 3D solver builds it from its own prelude and accessors.

import { COLOR_WG, PRELUDE } from './layout.ts';

/** 2D record accessors the topology kernels need (see makeTopologyWGSL). */
const ACCESSORS_2D = /* wgsl */ `
fn dynamicBody(i: i32) -> bool {
  return i >= 0 && bodies[i].shape.z > 0.0;
}

/** A joint takes part unless it was disabled (fracture, released drag). */
fn jointActive(j: u32) -> bool {
  let s = joints[j].stiff;
  return info[j].x != T_NONE && (s.x != 0.0 || s.y != 0.0 || s.z != 0.0);
}
`;

/**
 * Adjacency and colouring kernels over a prelude defining Params, Body, Joint and Contact
 * (with ids.xy = bodies), plus accessors defining dynamicBody(i32) and jointActive(u32).
 */
export const makeTopologyWGSL = (prelude: string, accessors: string): string => /* wgsl */ `
${prelude}
${accessors}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> joints: array<Joint>;
@group(0) @binding(3) var<storage, read> info: array<vec4i>;
@group(0) @binding(4) var<storage, read> contacts: array<Contact>;
@group(0) @binding(5) var<storage, read_write> counters: array<atomic<u32>>;
// Adjacency: degree -> start[bodies + 1] | fill[bodies] | list
@group(0) @binding(6) var<storage, read_write> adj: array<atomic<u32>>;
// Colours: stateA[bodies] | stateB[bodies] | start[65] | bodies[bodies] | hist[64 * groups + 1]
@group(0) @binding(7) var<storage, read_write> color: array<atomic<u32>>;

fn contactCount() -> u32 {
  return min(atomicLoad(&counters[C_CONTACTS]), params.contactCapacity);
}

fn endpoints(id: u32) -> vec2i {
  if (id < params.jointCount) { return info[id].yz; }
  let ids = contacts[id - params.jointCount].ids;
  return vec2i(i32(ids.x), i32(ids.y));
}

// --- Adjacency ----------------------------------------------------------------------------

fn countEndpoints(id: u32) {
  let e = endpoints(id);
  if (dynamicBody(e.x)) { atomicAdd(&adj[e.x], 1u); }
  if (dynamicBody(e.y)) { atomicAdd(&adj[e.y], 1u); }
}

fn fillEndpoints(id: u32) {
  let e = endpoints(id);
  for (var s = 0; s < 2; s++) {
    let x = e[s];
    if (!dynamicBody(x)) { continue; }
    let slot = atomicLoad(&adj[x]) + atomicAdd(&adj[params.adjFillOffset + u32(x)], 1u);
    atomicStore(&adj[params.adjListOffset + slot], id);
  }
}

@compute @workgroup_size(64)
fn degreeJoints(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.jointCount || !jointActive(gid.x)) { return; }
  countEndpoints(gid.x);
}

@compute @workgroup_size(64)
fn degreeContacts(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= contactCount()) { return; }
  countEndpoints(params.jointCount + gid.x);
}

@compute @workgroup_size(64)
fn fillJoints(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.jointCount || !jointActive(gid.x)) { return; }
  fillEndpoints(gid.x);
}

@compute @workgroup_size(64)
fn fillContacts(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= contactCount()) { return; }
  fillEndpoints(params.jointCount + gid.x);
}

// --- Colouring ----------------------------------------------------------------------------

fn priority(i: u32) -> u32 {
  return hash32(i + 0x9e3779b9u);
}

fn beats(i: u32, j: u32) -> bool {
  let pi = priority(i);
  let pj = priority(j);
  return pi > pj || (pi == pj && i > j);
}

fn neighbour(b: u32, e: u32) -> i32 {
  let ends = endpoints(atomicLoad(&adj[params.adjListOffset + e]));
  let other = select(ends.x, ends.y, ends.x == i32(b));
  return select(-1, other, dynamicBody(other));
}

fn state(offset: u32, i: u32) -> u32 {
  return atomicLoad(&color[offset + i]);
}

/** Smallest colour below colorCap not used by b's neighbours (optionally skipping pending ones). */
fn smallestFree(b: u32, src: u32, skipPending: bool) -> u32 {
  var lo = 0u;
  var hi = 0u;
  for (var e = atomicLoad(&adj[b]); e < atomicLoad(&adj[b + 1u]); e++) {
    let j = neighbour(b, e);
    if (j < 0) { continue; }
    let s = state(src, u32(j));
    if (skipPending && (s & PENDING) != 0u) { continue; }
    let col = s & 0xffu;
    if (col == NO_COLOR) { continue; }
    if (col < 32u) { lo |= 1u << col; } else { hi |= 1u << (col - 32u); }
  }
  var free = MAX_COLORS - 1u;
  if (~lo != 0u) { free = countTrailingZeros(~lo); }
  else if (~hi != 0u) { free = 32u + countTrailingZeros(~hi); }
  return min(free, params.colorCap - 1u);
}

// 1. Compaction: a body whose priority beats all neighbours may drop to a smaller free colour.
@compute @workgroup_size(64)
fn colorCompact(@builtin(global_invocation_id) gid: vec3u) {
  let b = gid.x;
  if (b >= params.bodyCount) { return; }
  let dst = params.stateBOffset;
  if (!dynamicBody(i32(b))) { atomicStore(&color[dst + b], NO_COLOR); return; }
  var col = state(0u, b) & 0xffu;
  if (col != NO_COLOR) {
    var isMax = true;
    for (var e = atomicLoad(&adj[b]); e < atomicLoad(&adj[b + 1u]) && isMax; e++) {
      let j = neighbour(b, e);
      if (j >= 0 && !beats(b, u32(j))) { isMax = false; }
    }
    if (isMax) { col = min(col, smallestFree(b, 0u, false)); }
  }
  atomicStore(&color[dst + b], col);
}

// 2. Pending: no colour, or the same colour as a higher-priority neighbour.
@compute @workgroup_size(64)
fn colorMark(@builtin(global_invocation_id) gid: vec3u) {
  let b = gid.x;
  if (b >= params.bodyCount) { return; }
  let src = params.stateBOffset;
  let col = state(src, b) & 0xffu;
  if (!dynamicBody(i32(b))) { atomicStore(&color[b], NO_COLOR); return; }
  var pending = col == NO_COLOR;
  for (var e = atomicLoad(&adj[b]); e < atomicLoad(&adj[b + 1u]) && !pending; e++) {
    let j = neighbour(b, e);
    if (j >= 0 && (state(src, u32(j)) & 0xffu) == col && beats(u32(j), b)) { pending = true; }
  }
  atomicStore(&color[b], col | select(0u, PENDING, pending));
}

// 3. Jones-Plassmann round: a pending body beating all pending neighbours takes the smallest
// colour its settled neighbours leave free. Winners are never adjacent.
fn round(b: u32, src: u32, dst: u32) {
  let s = state(src, b);
  if ((s & PENDING) == 0u) { atomicStore(&color[dst + b], s); return; }
  var isMax = true;
  for (var e = atomicLoad(&adj[b]); e < atomicLoad(&adj[b + 1u]) && isMax; e++) {
    let j = neighbour(b, e);
    if (j >= 0 && (state(src, u32(j)) & PENDING) != 0u && !beats(b, u32(j))) { isMax = false; }
  }
  if (isMax) { atomicStore(&color[dst + b], smallestFree(b, src, true)); }
  else { atomicStore(&color[dst + b], s); }
}

@compute @workgroup_size(64)
fn colorRoundAB(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.bodyCount) { return; }
  round(gid.x, 0u, params.stateBOffset);
}

@compute @workgroup_size(64)
fn colorRoundBA(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x >= params.bodyCount) { return; }
  round(gid.x, params.stateBOffset, 0u);
}

// 4-6. Bucket bodies by colour, keeping each colour's bodies in (chunked) index order so a
// colour's primal pass reads memory coherently (measured 4-21% faster than an atomic scatter).
// Each workgroup of COLOR_WG bodies counts its bodies per colour; a prefix scan over the
// colour-major (colour, workgroup) counts turns them into slot offsets and colour starts; then
// each workgroup writes its bodies contiguously.

var<workgroup> hist: array<atomic<u32>, 64>;
var<workgroup> chunkColors: array<u32, ${COLOR_WG}>;

// 4. Per-workgroup colour histogram; each body's rank within it goes to stateB. Bodies still
// pending keep a clashing colour (counted). Dispatched over the whole capacity so every
// histogram entry is rewritten each step.
@compute @workgroup_size(${COLOR_WG})
fn colorCount(@builtin(global_invocation_id) gid: vec3u, @builtin(local_invocation_id) lid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  if (lid.x < MAX_COLORS) { atomicStore(&hist[lid.x], 0u); }
  let b = gid.x;
  var col = NO_COLOR;
  if (b < params.bodyCount && dynamicBody(i32(b))) {
    let s = state(0u, b);
    col = s & 0xffu;
    if ((s & PENDING) != 0u) { atomicAdd(&counters[C_CLASHES], 1u); }
    if (col == NO_COLOR) { col = params.colorCap - 1u; }
    atomicStore(&color[b], col);
    atomicMax(&counters[C_NUM_COLORS], col + 1u);
  }
  chunkColors[lid.x] = col;
  workgroupBarrier();
  if (col != NO_COLOR) {
    // Stable rank: same-colour bodies earlier in this chunk (keeps index order in the bucket)
    var rank = 0u;
    for (var j = 0u; j < lid.x; j++) { rank += select(0u, 1u, chunkColors[j] == col); }
    atomicStore(&color[params.stateBOffset + b], rank);
    atomicAdd(&hist[col], 1u);
  }
  workgroupBarrier();
  if (lid.x < MAX_COLORS) {
    atomicStore(&color[params.colorHistOffset + lid.x * params.colorGroups + wid.x], atomicLoad(&hist[lid.x]));
  }
  // The entry after the last one becomes the total once scanned
  if (gid.x == 0u) { atomicStore(&color[params.colorHistOffset + MAX_COLORS * params.colorGroups], 0u); }
}

// 5. After the histogram scan: colour c starts at its first workgroup's offset.
@compute @workgroup_size(64)
fn colorStarts(@builtin(local_invocation_id) lid: vec3u) {
  let c = lid.x;
  atomicStore(&color[params.colorStartOffset + c], atomicLoad(&color[params.colorHistOffset + c * params.colorGroups]));
  if (c == 0u) {
    atomicStore(&color[params.colorStartOffset + MAX_COLORS], atomicLoad(&color[params.colorHistOffset + MAX_COLORS * params.colorGroups]));
  }
}

// 6. Scatter: workgroup offset for the body's colour plus its rank within the workgroup.
@compute @workgroup_size(${COLOR_WG})
fn colorScatter(@builtin(global_invocation_id) gid: vec3u, @builtin(workgroup_id) wid: vec3u) {
  let b = gid.x;
  if (b >= params.bodyCount || !dynamicBody(i32(b))) { return; }
  let col = state(0u, b) & 0xffu;
  let slot = atomicLoad(&color[params.colorHistOffset + col * params.colorGroups + wid.x]) + state(params.stateBOffset, b);
  atomicStore(&color[params.colorBodiesOffset + slot], b);
}
`;

export const topologyWGSL = makeTopologyWGSL(PRELUDE, ACCESSORS_2D);
