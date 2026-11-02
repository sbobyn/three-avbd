// Fixed retained-storage plans: exact capacities for every buffer the standard solver and the
// World's helpers keep, worked out (and checked against the device's negotiated limits) before
// anything is allocated. A fixed World never grows them; work past a capacity is refused with a
// StorageCapacityError (topology) or dropped and counted (contacts, pairs, events) instead.
// Pure: no GPU calls, so the arithmetic is tested on the CPU. Fixed means bounded retained
// physics storage, not zero allocation: reads, rays, JS handles and renderer resources still
// allocate per call, and driver overhead is not included.

import { ARGS_WORDS, COLOR_WG, COUNTER_WORDS, MAX_COLORS, PASS_STRIDE, WORKGROUP_SIZE } from '../avbd2d/gpu/layout.ts';
import { BODY_FLOATS, CONTACT_WORDS, JOINT_FLOATS, MANIFOLD_WORDS, PARAM_WORDS } from '../avbd3d/gpu/layout.ts';

/** How a World's solver storage behaves: grows on demand (the default), or fixed at creation. */
export type WorldStorageOptions =
  | { growth: 'adaptive' }
  | {
      growth: 'fixed';
      /** Broadphase pairs per step (at least max(4096, 4 × maxBodies)). */
      pairs: number;
      /** Contact points per step (at least max(8192, 4 × maxBodies)). */
      contacts: number;
      /** Touching pairs per step (at least max(4096, maxBodies), at most `pairs`). */
      manifolds: number;
      /** Joint and spring slots, placed and pending together (at least 256). */
      joints: number;
      /** Hull geometry storage in vec4s (at least 4096). */
      hullVec4s: number;
    };

export type StorageResource = 'bodies' | 'pairs' | 'contacts' | 'manifolds' | 'joints' | 'hullVec4s' | 'statics' | 'watchPairs' | 'watchEvents' | 'buffer' | 'binding' | 'dispatch' | 'alignment' | 'hullOffset';

/** A fixed World was asked to hold more than its plan (it is left as it was). */
export class StorageCapacityError extends Error {
  readonly resource: StorageResource;
  readonly requested: number;
  readonly capacity: number;
  constructor(resource: StorageResource, requested: number, capacity: number) {
    super(`Fixed storage: ${resource} needs ${requested}, capacity is ${capacity}`);
    this.name = 'StorageCapacityError';
    this.resource = resource; this.requested = requested; this.capacity = capacity;
  }
}

/** A fixed plan is invalid, below a policy floor, or past what the device's limits allow. */
export class StorageLimitError extends Error {
  readonly resource: StorageResource;
  readonly requested: number;
  readonly limit: number;
  constructor(resource: StorageResource, requested: number, limit: number, detail = '') {
    super(`Fixed storage plan: ${resource} ${requested} exceeds limit ${limit}${detail ? ` (${detail})` : ''}`);
    this.name = 'StorageLimitError';
    this.resource = resource; this.requested = requested; this.limit = limit;
  }
}

/** P1 policy floors: the adaptive solver's own startup minimums, not numerical necessities. */
export const STORAGE_FLOORS = Object.freeze({ pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096, perBody: { pairs: 4, contacts: 4, manifolds: 1 } });
/** Retired identities kept per body slot for late contact events (identity.ts RetiredBodies). */
export const RETIRED_PER_SLOT = 8;
const SCAN_BLOCK = 512;
/** Hull header offsets travel in an f32 (SHAPE_HULL + offset), exact below 2^24. */
const HULL_OFFSET_LIMIT = 2 ** 24 - 8;

/** The limits a plan is checked against: the device's negotiated ones (never the adapter's). */
export type StorageLimits = Pick<GPUSupportedLimits, 'maxBufferSize' | 'maxStorageBufferBindingSize' | 'maxComputeWorkgroupsPerDimension' | 'minUniformBufferOffsetAlignment' | 'maxUniformBufferBindingSize'>;

/** A resolved fixed plan: exactly what was asked, plus every derived capacity and byte size. */
export interface FixedStoragePlan {
  readonly growth: 'fixed';
  readonly bodies: number;
  readonly pairs: number;
  readonly contacts: number;
  readonly manifolds: number;
  readonly joints: number;
  readonly hullVec4s: number;
  /** Contact-event pair sets (maxContactPairs) and events between reads (maxContactEvents). */
  readonly watchPairs: number;
  readonly watchEvents: number;
  /** Derived: hash slots per contact set, pow2ceil(max(64, 2 × watchPairs)). */
  readonly watchSlots: number;
  readonly retiredPerSlot: number;
  /** Colours allocated (the scheduling cap adapts within these). */
  readonly colors: number;
  /** Pass-constant entries (one per colour, plus one). */
  readonly passEntries: number;
  /** Statics/no-collide words: up to every body as a large body, plus one triple per joint. */
  readonly staticWords: number;
  /** Derived spatial-hash and manifold-hash sizes. */
  readonly gridTable: number;
  readonly manifoldHash: number;
  /** Bytes per retained buffer (scan buffers summed per scan). */
  readonly buffers: Readonly<Record<string, number>>;
  /** Their sum: retained GPU buffer bytes, excluding driver overhead, renderer meshes and staging. */
  readonly totalBytes: number;
}

const pow2AtLeast = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 1)));

/** Bytes of a PrefixScan's sums and params over n elements (avbd2d/gpu/scan.ts). */
export function scanBytes(n: number): number {
  let bytes = 0;
  for (let len = n; ; ) {
    const blocks = Math.max(1, Math.ceil(len / SCAN_BLOCK));
    bytes += Math.max(blocks, 4) * 4 + 16;
    if (blocks === 1) return bytes;
    len = blocks;
  }
}

/** Contact-watch hash slots for `pairs` (contacts.ts). */
export const watchSlots = (pairs: number) => 2 ** Math.ceil(Math.log2(Math.max(64, 2 * pairs)));

function count(name: StorageResource, value: unknown, floor: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new StorageLimitError(name, Number(value), Number.MAX_SAFE_INTEGER, 'must be a positive safe integer');
  if (value < floor) throw new StorageLimitError(name, value, floor, 'below the fixed-storage policy floor');
  return value;
}

/**
 * Resolve and check a fixed plan, before any attribute or buffer is made. Requested counts are
 * kept exactly (never rounded up); derived sizes are reported. Throws StorageLimitError.
 */
export function resolveFixedStorage(
  world: { maxBodies: number; maxContactPairs?: number; maxContactEvents?: number },
  storage: Extract<WorldStorageOptions, { growth: 'fixed' }>,
  limits: StorageLimits,
): FixedStoragePlan {
  const N = count('bodies', world.maxBodies, 1);
  const F = STORAGE_FLOORS;
  const P = count('pairs', storage.pairs, Math.max(F.pairs, F.perBody.pairs * N));
  const K = count('contacts', storage.contacts, Math.max(F.contacts, F.perBody.contacts * N));
  const M = count('manifolds', storage.manifolds, Math.max(F.manifolds, F.perBody.manifolds * N));
  if (M > P) throw new StorageLimitError('manifolds', M, P, 'every manifold comes from a broadphase pair');
  const J = count('joints', storage.joints, F.joints);
  const H = count('hullVec4s', storage.hullVec4s, F.hullVec4s);
  if (H > HULL_OFFSET_LIMIT) throw new StorageLimitError('hullOffset', H, HULL_OFFSET_LIMIT, 'hull offsets are stored in f32');
  const W = count('watchPairs', world.maxContactPairs ?? 8192, 1);
  const E = count('watchEvents', world.maxContactEvents ?? 4096, 1);
  const S = watchSlots(W);
  const T = pow2AtLeast(2 * N);
  const hash = pow2AtLeast(Math.max(2, 2 * M));
  const G = Math.ceil(N / COLOR_WG);
  const staticWords = Math.max(4, N + 3 * J);
  const adjacency = 2 * N + 1 + 2 * (J + M);
  const buffers: Record<string, number> = {
    bodies: N * BODY_FLOATS * 4,
    filters: N * 8,
    refs: N * 32,
    lifecycle: 0,
    joints: J * JOINT_FLOATS * 4,
    jointInfo: J * 16,
    pairs: P * 8,
    contacts: 2 * K * CONTACT_WORDS * 4,
    manifolds: 2 * M * MANIFOLD_WORDS * 4,
    manifoldHash: hash * 4,
    grid: (2 * T + 1 + 4 * N) * 4,
    gridScan: scanBytes(T + 1),
    adjacency: adjacency * 4,
    adjacencyScan: scanBytes(N + 1),
    statics: staticWords * 4,
    colors: (3 * N + 65 + MAX_COLORS * G + 1) * 4,
    colorScan: scanBytes(MAX_COLORS * G + 1),
    pass: (MAX_COLORS + 1) * PASS_STRIDE,
    hulls: H * 16,
    params: PARAM_WORDS * 4,
    counters: COUNTER_WORDS * 4,
    args: (ARGS_WORDS + 3) * 4,
    pusher: N * 48 + 16,
    mover: N * 48 + 16,
    reset: N * 4 + 16,
    watch: Math.max(16, 4 * N) + (4 + 4 * S) * 4 + 48 * E + 32,
  };
  delete buffers.lifecycle;
  const totalBytes = Object.values(buffers).reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(totalBytes)) throw new StorageLimitError('buffer', totalBytes, Number.MAX_SAFE_INTEGER, 'byte total is not a safe integer');
  // Each storage binding (the watch's are separate buffers: check its largest, the sets)
  const bound: Record<string, number> = { ...buffers, contacts: K * CONTACT_WORDS * 4, manifolds: M * MANIFOLD_WORDS * 4, watch: (4 + 4 * S) * 4, watchEvents: 48 * E };
  delete bound.gridScan; delete bound.adjacencyScan; delete bound.colorScan; delete bound.pass;
  const binding = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
  for (const [name, bytes] of Object.entries(bound)) {
    if (bytes > binding) throw new StorageLimitError('binding', bytes, binding, `${name} buffer`);
  }
  if (buffers.pass > limits.maxBufferSize) throw new StorageLimitError('buffer', buffers.pass, limits.maxBufferSize, 'pass constants');
  if (PASS_STRIDE % limits.minUniformBufferOffsetAlignment !== 0) throw new StorageLimitError('alignment', PASS_STRIDE, limits.minUniformBufferOffsetAlignment, 'pass-constant stride');
  if (PARAM_WORDS * 4 > limits.maxUniformBufferBindingSize) throw new StorageLimitError('binding', PARAM_WORDS * 4, limits.maxUniformBufferBindingSize, 'params');
  // Direct and indirect dispatch widths in their worst case
  const maxGroups = limits.maxComputeWorkgroupsPerDimension;
  const widths: Record<string, number> = {
    bodies: Math.ceil(N / WORKGROUP_SIZE), grid: Math.ceil((T + 1) / WORKGROUP_SIZE), pairs: Math.ceil(P / WORKGROUP_SIZE),
    contacts: Math.ceil(K / WORKGROUP_SIZE), manifolds: Math.ceil(hash / WORKGROUP_SIZE), joints: Math.ceil(J / WORKGROUP_SIZE),
    watch: Math.ceil(S / 64), colors: G, gridScan: Math.ceil((T + 1) / SCAN_BLOCK), adjacencyScan: Math.ceil((N + 1) / SCAN_BLOCK),
    colorScan: Math.ceil((MAX_COLORS * G + 1) / SCAN_BLOCK),
  };
  for (const [name, groups] of Object.entries(widths)) {
    if (groups > maxGroups) throw new StorageLimitError('dispatch', groups, maxGroups, `${name} workgroups`);
  }
  return Object.freeze({
    growth: 'fixed', bodies: N, pairs: P, contacts: K, manifolds: M, joints: J, hullVec4s: H,
    watchPairs: W, watchEvents: E, watchSlots: S, retiredPerSlot: RETIRED_PER_SLOT,
    colors: MAX_COLORS, passEntries: MAX_COLORS + 1, staticWords, gridTable: T, manifoldHash: hash,
    buffers: Object.freeze(buffers), totalBytes,
  });
}

/** Hull storage (vec4s) a cooked shape takes in the hull buffer (solver.ts packHull). */
export function hullVec4s(shape: { vertices: ArrayLike<number>; faces: readonly { verts: ArrayLike<number> }[]; edges: ArrayLike<unknown> }): number {
  let refs = 0;
  for (const face of shape.faces) refs += face.verts.length;
  return 2 + shape.vertices.length / 3 + 2 * shape.faces.length + Math.ceil(refs / 4) + shape.edges.length;
}
