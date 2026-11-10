// Pose cache codec: a JSON manifest plus little-endian binary pose chunks.
//
// EXPERIMENTAL DRAFT (schema `three-avbd.pose-cache/v0-draft`). Internal module: not exported from the package, not
// a supported public format, and NOT a World snapshot, checkpoint, recorder or input replay. It holds, per sampled
// step, each live body's position (m) and unit quaternion (x y z w) as float32; no velocities, joints, contacts or
// events. Existing boxes and spheres only. docs/POSE_CACHE.md is the format description and the path to freezing a v1.
//
// Pure CPU code: no Three.js, GPU, DOM or Node import. Input text and bytes are never retained or mutated and every
// returned array is freshly allocated. Order of work everywhere: argument and budget checks on counts and byte sizes,
// then structure, then values, and typed arrays are allocated only once their size is bounded by both the limits and
// the bytes the caller actually supplied.

export const POSE_CACHE_SCHEMA = 'three-avbd.pose-cache/v0-draft';
/** Revision of the binary chunk layout, written in every chunk header. */
export const POSE_CACHE_CHUNK_REVISION = 1;
export const POSE_CACHE_CONVENTIONS = Object.freeze({
  length: 'metre', time: 'second', handedness: 'right', up: '+y', rotation: 'quaternion-xyzw',
  pose: 'position-xyz-then-rotation-xyzw', byteOrder: 'little', floatFormat: 'float32',
} as const);
/** Numbers per body slot: position x y z, then quaternion x y z w. */
export const POSE_FLOATS = 7;
export const POSE_SLOT_BYTES = POSE_FLOATS * 4;
export const CHUNK_HEADER_BYTES = 36;
/** Bytes of one frame record: u32 step, one slot per body, u32 CRC-32 of the step and slots. */
export const poseFrameBytes = (bodyCount: number): number => 8 + POSE_SLOT_BYTES * bodyCount;

export interface PoseCacheLimits {
  maxBodies: number;
  maxFrames: number;
  maxChunks: number;
  maxChunkBytes: number;
  /** Sum of all chunk byte lengths (headers included), manifest excluded. */
  maxTotalBytes: number;
  maxManifestBytes: number;
}
/** What a reader applies when the caller passes nothing. */
export const POSE_CACHE_DEFAULT_LIMITS: Readonly<PoseCacheLimits> = Object.freeze({
  maxBodies: 4096, maxFrames: 36_000, maxChunks: 1024, maxChunkBytes: 16 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024, maxManifestBytes: 1024 * 1024,
});
/** Ceilings no caller-supplied limit may exceed; a bigger scene is a different tool, not a bigger number. */
export const POSE_CACHE_HARD_LIMITS: Readonly<PoseCacheLimits> = Object.freeze({
  maxBodies: 65_536, maxFrames: 1_000_000, maxChunks: 65_536, maxChunkBytes: 64 * 1024 * 1024, maxTotalBytes: 1024 * 1024 * 1024, maxManifestBytes: 16 * 1024 * 1024,
});
/** Value ranges (not budgets). They match the example-local pose track. */
export const POSE_CACHE_VALUE_LIMITS = Object.freeze({
  maxCoordinate: 1e6, maxSize: 1e3, maxDt: 1, quaternionTolerance: 1e-3, maxId: 0x7fffffff,
  provenanceKeys: 32, provenanceStringLength: 256,
} as const);

export type PoseCacheErrorCode = 'argument' | 'schema' | 'manifest' | 'budget' | 'chunk' | 'data';
export class PoseCacheError extends Error {
  code: PoseCacheErrorCode;
  constructor(code: PoseCacheErrorCode, message: string) { super(message); this.name = 'PoseCacheError'; this.code = code; }
}

export type PoseCacheTermination = 'complete' | 'cancelled' | 'budget' | 'recovered';
const TERMINATIONS: readonly string[] = ['complete', 'cancelled', 'budget', 'recovered'];
export type PoseCacheProvenance = Readonly<Record<string, string | number | boolean | null>>;

export interface PoseCacheBody {
  /** Stable, unique across the cache. A body that disappears and returns is a different id (one lifetime range per id). */
  id: number;
  shape: 'box' | 'sphere';
  /** Full widths (m); a sphere's diameter on every axis. */
  size: [number, number, number];
  fixed: boolean;
  /** Alive in frames [firstFrame, endFrame). endFrame === frameCount means alive to the end. */
  firstFrame: number;
  endFrame: number;
}

/** A validated cache. `poses` is frame-major: ((frame * bodies.length) + slot) * 7 + [px py pz qx qy qz qw]; a slot outside its body's lifetime is all +0. */
export interface PoseCache {
  /** Caller-assigned u32, unique for each bake in its collection (not authentication). */
  cacheId: number;
  dt: number;
  termination: PoseCacheTermination;
  bodies: readonly PoseCacheBody[];
  /** The World step each frame was read at, strictly increasing. */
  steps: Uint32Array;
  poses: Float32Array;
  provenance: PoseCacheProvenance | null;
}
export type PoseCacheInput = Omit<PoseCache, 'termination' | 'provenance'> & Partial<Pick<PoseCache, 'termination' | 'provenance'>>;

export interface PoseCacheChunkEntry { index: number; firstFrame: number; frameCount: number; byteLength: number }
export interface PoseCacheBudget { maxBodies: number; maxFrames: number; maxBytes: number }
export interface PoseCacheManifest {
  cacheId: number;
  termination: PoseCacheTermination;
  dt: number;
  /** CRC-32 of cacheId, dt and the immutable body table (id, shape, fixed, size), bound into every chunk header. */
  bodyTableCrc32: number;
  bodies: readonly PoseCacheBody[];
  frameCount: number;
  chunks: readonly PoseCacheChunkEntry[];
  budget: PoseCacheBudget;
  provenance: PoseCacheProvenance | null;
}

export interface PoseCacheProblem { chunk: number | null; frame: number | null; code: PoseCacheErrorCode; reason: string }
export interface PoseCacheRecovery {
  /** A fully valid cache of the recovered prefix, or null when not even one frame survived. */
  cache: PoseCache | null;
  /** True only when nothing was lost; then `cache` equals what decodePoseCache returns. */
  complete: boolean;
  declaredFrames: number;
  recoveredFrames: number;
  /** Bodies with no alive frame inside the recovered prefix; they are not in `cache`. */
  omittedBodyIds: number[];
  /** Why recovery stopped; null exactly when complete. */
  problem: PoseCacheProblem | null;
}

// ---- small helpers ------------------------------------------------------------------------------

function fail(code: PoseCacheErrorCode, message: string): never { throw new PoseCacheError(code, message); }
const isRecord = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function checkKeys(value: Record<string, unknown>, allowed: readonly string[], what: string, code: PoseCacheErrorCode) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(code, `${what}: unknown field "${key.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}"`);
}
const isShared = (b: ArrayBufferLike) => typeof SharedArrayBuffer !== 'undefined' && b instanceof SharedArrayBuffer;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
/** CRC-32 (IEEE, as zlib) of bytes[start, end), continuing a finalized prior CRC when supplied. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Validate caller limits against the hard ceilings and return a complete set. Unknown keys and non-integers are refused. */
export function resolvePoseCacheLimits(partial?: Partial<PoseCacheLimits>): PoseCacheLimits {
  const out: PoseCacheLimits = { ...POSE_CACHE_DEFAULT_LIMITS };
  if (partial === undefined) return out;
  if (!isRecord(partial)) fail('argument', 'limits must be a plain object');
  for (const key of Object.keys(partial)) {
    if (!Object.hasOwn(POSE_CACHE_HARD_LIMITS, key)) fail('argument', `limits: unknown limit "${key.replace(/[^\x20-\x7e]/g, '?').slice(0, 40)}"`);
    const k = key as keyof PoseCacheLimits, v = partial[k];
    if (!isInt(v, 1, POSE_CACHE_HARD_LIMITS[k])) fail('argument', `limits.${k} must be an integer from 1 to ${POSE_CACHE_HARD_LIMITS[k]}`);
    out[k] = v;
  }
  return out;
}

// ---- bodies, provenance, values -----------------------------------------------------------------

const BODY_KEYS = ['id', 'shape', 'size', 'fixed', 'firstFrame', 'endFrame'] as const;

/** Copy and validate one body table entry; `frameCount` bounds the lifetime range. */
function normalizeBody(b: unknown, at: string, frameCount: number, code: PoseCacheErrorCode): PoseCacheBody {
  if (!isRecord(b)) fail(code, `${at}: expected an object`);
  checkKeys(b, BODY_KEYS, at, code);
  const { id, shape, size, fixed, firstFrame, endFrame } = b;
  if (!isInt(id, 1, POSE_CACHE_VALUE_LIMITS.maxId)) fail(code, `${at}: id must be an integer from 1 to ${POSE_CACHE_VALUE_LIMITS.maxId}`);
  if (shape !== 'box' && shape !== 'sphere') fail(code, `${at}: shape must be "box" or "sphere" (nothing else is cached yet)`);
  if (!Array.isArray(size) || size.length !== 3 || !size.every(v => finite(v) && v > 0 && v <= POSE_CACHE_VALUE_LIMITS.maxSize)) {
    fail(code, `${at}: size must be three numbers above 0 and at most ${POSE_CACHE_VALUE_LIMITS.maxSize}`);
  }
  const s = size as number[];
  if (shape === 'sphere' && !(s[0] === s[1] && s[1] === s[2])) fail(code, `${at}: a sphere's size is its diameter on all three axes`);
  if (typeof fixed !== 'boolean') fail(code, `${at}: fixed must be true or false`);
  if (!isInt(firstFrame, 0, frameCount - 1)) fail(code, `${at}: firstFrame must be a frame index below ${frameCount}`);
  if (!isInt(endFrame, firstFrame + 1, frameCount)) fail(code, `${at}: endFrame must be above firstFrame and at most ${frameCount}`);
  return { id, shape, size: [s[0], s[1], s[2]], fixed, firstFrame, endFrame };
}

function normalizeBodies(list: unknown, frameCount: number, limits: PoseCacheLimits, code: PoseCacheErrorCode): PoseCacheBody[] {
  if (!Array.isArray(list) || list.length < 1) fail(code, 'bodies must be a non-empty list');
  if (list.length > limits.maxBodies) fail('budget', `${list.length} bodies exceed the limit of ${limits.maxBodies}`);
  const seen = new Set<number>(), bodies: PoseCacheBody[] = [];
  for (let i = 0; i < list.length; i++) {
    const body = normalizeBody(list[i], `bodies[${i}]`, frameCount, code);
    if (seen.has(body.id)) fail(code, `bodies[${i}]: duplicate id ${body.id}`);
    seen.add(body.id);
    bodies.push(body);
  }
  return bodies;
}

const PROVENANCE_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PROVENANCE_TEXT = /^[\x20-\x7e]*$/;
/** Provenance is a flat, bounded record of printable-ASCII strings, finite numbers, booleans and nulls; `undefined` and `null` mean none. */
function normalizeProvenance(v: unknown, code: PoseCacheErrorCode): PoseCacheProvenance | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) fail(code, 'provenance must be an object when present');
  const keys = Object.keys(v);
  if (keys.length > POSE_CACHE_VALUE_LIMITS.provenanceKeys) fail(code, `provenance may hold at most ${POSE_CACHE_VALUE_LIMITS.provenanceKeys} entries`);
  const out: Record<string, string | number | boolean | null> = Object.create(null);
  for (const key of keys) {
    if (!PROVENANCE_KEY.test(key)) fail(code, 'provenance: keys must start with a letter and use letters, digits, "_", "." or "-" (64 at most)');
    const value = v[key];
    const okText = typeof value === 'string' && value.length <= POSE_CACHE_VALUE_LIMITS.provenanceStringLength && PROVENANCE_TEXT.test(value);
    if (!(okText || finite(value) || typeof value === 'boolean' || value === null)) fail(code, `provenance.${key}: expected printable ASCII text (${POSE_CACHE_VALUE_LIMITS.provenanceStringLength} at most), a finite number, a boolean or null`);
    out[key] = value as string | number | boolean | null;
  }
  return Object.freeze(out);
}

/** CRC-32 over a fixed little-endian encoding of cacheId, dt and each body's id, shape, fixed flag and size (lifetimes excluded). */
export function poseBodyTableCrc32(dt: number, bodies: readonly PoseCacheBody[], cacheId: number): number {
  const bytes = new Uint8Array(16 + 30 * bodies.length), v = new DataView(bytes.buffer);
  v.setUint32(0, cacheId, true); v.setUint32(4, bodies.length, true); v.setFloat64(8, dt, true);
  bodies.forEach((b, i) => {
    const o = 16 + 30 * i;
    v.setUint32(o, b.id, true); v.setUint8(o + 4, b.shape === 'box' ? 1 : 2); v.setUint8(o + 5, b.fixed ? 1 : 0);
    for (let k = 0; k < 3; k++) v.setFloat64(o + 6 + 8 * k, b.size[k], true);
  });
  return crc32(bytes);
}

/** Why a body's slot is wrong at a frame, or null. Alive: finite, bounded position, unit quaternion. Not alive: exactly +0 everywhere. */
function slotProblem(p: Float32Array, o: number, alive: boolean): string | null {
  if (!alive) {
    for (let k = 0; k < POSE_FLOATS; k++) if (!Object.is(p[o + k], 0)) return 'a slot outside its lifetime must be all +0';
    return null;
  }
  for (let k = 0; k < 3; k++) if (!(Math.abs(p[o + k]) <= POSE_CACHE_VALUE_LIMITS.maxCoordinate)) return `position must be finite and within ±${POSE_CACHE_VALUE_LIMITS.maxCoordinate} m`;
  for (let k = 3; k < 7; k++) if (!Number.isFinite(p[o + k])) return 'rotation must be finite';
  const length = Math.hypot(p[o + 3], p[o + 4], p[o + 5], p[o + 6]);
  if (!(Math.abs(length - 1) <= POSE_CACHE_VALUE_LIMITS.quaternionTolerance)) return `rotation must be a unit quaternion (length ${length.toPrecision(4)})`;
  return null;
}
/** Check one frame's slots (frame-local array `p` starting at `base`). */
function frameProblem(p: Float32Array, base: number, bodies: readonly PoseCacheBody[], frame: number): string | null {
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i], problem = slotProblem(p, base + i * POSE_FLOATS, frame >= b.firstFrame && frame < b.endFrame);
    if (problem) return `frame ${frame}, body ${b.id}: ${problem}`;
  }
  return null;
}

// ---- manifest -----------------------------------------------------------------------------------

const TOP_KEYS = ['schema', 'conventions', 'cacheId', 'termination', 'dt', 'bodyTableCrc32', 'bodies', 'frameCount', 'chunks', 'budget', 'provenance'];
const CHUNK_KEYS = ['index', 'firstFrame', 'frameCount', 'byteLength'];
const BUDGET_KEYS = ['maxBodies', 'maxFrames', 'maxBytes'];

/** The one accepted text form: compact JSON, fixed key order, no surrounding whitespace. Writers and readers agree on it byte for byte. */
function serializeManifest(m: PoseCacheManifest): string {
  const value: Record<string, unknown> = {
    schema: POSE_CACHE_SCHEMA, conventions: POSE_CACHE_CONVENTIONS, cacheId: m.cacheId, termination: m.termination, dt: m.dt, bodyTableCrc32: m.bodyTableCrc32,
    bodies: m.bodies.map(b => ({ id: b.id, shape: b.shape, size: b.size, fixed: b.fixed, firstFrame: b.firstFrame, endFrame: b.endFrame })),
    frameCount: m.frameCount,
    chunks: m.chunks.map(c => ({ index: c.index, firstFrame: c.firstFrame, frameCount: c.frameCount, byteLength: c.byteLength })),
    budget: { maxBodies: m.budget.maxBodies, maxFrames: m.budget.maxFrames, maxBytes: m.budget.maxBytes },
  };
  if (m.provenance) value.provenance = { ...m.provenance };
  return JSON.stringify(value);
}

function readBudget(v: unknown): PoseCacheBudget {
  if (!isRecord(v)) fail('manifest', 'budget: expected an object');
  checkKeys(v, BUDGET_KEYS, 'budget', 'manifest');
  const { maxBodies, maxFrames, maxBytes } = v;
  if (!isInt(maxBodies, 1, POSE_CACHE_HARD_LIMITS.maxBodies)) fail('manifest', `budget.maxBodies must be an integer from 1 to ${POSE_CACHE_HARD_LIMITS.maxBodies}`);
  if (!isInt(maxFrames, 1, POSE_CACHE_HARD_LIMITS.maxFrames)) fail('manifest', `budget.maxFrames must be an integer from 1 to ${POSE_CACHE_HARD_LIMITS.maxFrames}`);
  if (!isInt(maxBytes, 1, POSE_CACHE_HARD_LIMITS.maxTotalBytes)) fail('manifest', `budget.maxBytes must be an integer from 1 to ${POSE_CACHE_HARD_LIMITS.maxTotalBytes}`);
  return { maxBodies, maxFrames, maxBytes };
}

function readManifest(text: unknown, limits: PoseCacheLimits): PoseCacheManifest {
  if (typeof text !== 'string') fail('argument', 'Pose cache manifest: expected text');
  // The canonical form is ASCII, so a text longer than the limit is refused before it is parsed
  if (text.length > limits.maxManifestBytes) fail('budget', `Pose cache manifest is ${text.length} characters; the limit is ${limits.maxManifestBytes}`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail('manifest', 'Pose cache manifest is not valid JSON (truncated or corrupt?)'); }
  if (!isRecord(value)) return fail('manifest', 'Pose cache manifest: expected a JSON object');
  if (value.schema !== POSE_CACHE_SCHEMA) return fail('schema', `Not a pose cache manifest: schema is not ${POSE_CACHE_SCHEMA}`);
  checkKeys(value, TOP_KEYS, 'Pose cache manifest', 'manifest');

  const conventions = value.conventions, wanted = Object.entries(POSE_CACHE_CONVENTIONS);
  if (!isRecord(conventions) || Object.keys(conventions).length !== wanted.length || wanted.some(([k, v]) => conventions[k] !== v)) {
    fail('manifest', 'conventions must be exactly metres, seconds, right-handed, y-up, [x, y, z, w] quaternions, little-endian float32');
  }
  const cacheId = value.cacheId;
  if (!isInt(cacheId, 0, 0xffffffff)) fail('manifest', 'cacheId must be a caller-assigned unsigned 32-bit integer');
  const termination = value.termination;
  if (typeof termination !== 'string' || !TERMINATIONS.includes(termination)) fail('manifest', `termination must be one of ${TERMINATIONS.join(', ')}`);
  const dt = value.dt;
  if (!finite(dt) || dt <= 0 || dt > POSE_CACHE_VALUE_LIMITS.maxDt) fail('manifest', `dt must be a number above 0 and at most ${POSE_CACHE_VALUE_LIMITS.maxDt}`);
  if (!isInt(value.bodyTableCrc32, 0, 0xffffffff)) fail('manifest', 'bodyTableCrc32 must be an unsigned 32-bit integer');

  // Counts before any per-element work
  const frameCount = value.frameCount;
  if (!isInt(frameCount, 1, POSE_CACHE_HARD_LIMITS.maxFrames)) fail('manifest', `frameCount must be an integer from 1 to ${POSE_CACHE_HARD_LIMITS.maxFrames}`);
  if (frameCount > limits.maxFrames) fail('budget', `${frameCount} frames exceed the limit of ${limits.maxFrames}`);
  const budget = readBudget(value.budget);
  const chunksIn = value.chunks;
  if (!Array.isArray(chunksIn) || chunksIn.length < 1) fail('manifest', 'chunks must be a non-empty list');
  if (chunksIn.length > limits.maxChunks) fail('budget', `${chunksIn.length} chunks exceed the limit of ${limits.maxChunks}`);
  const bodies = normalizeBodies(value.bodies, frameCount, limits, 'manifest');
  if (bodies.length > budget.maxBodies) fail('manifest', `${bodies.length} bodies exceed the declared budget.maxBodies ${budget.maxBodies}`);
  if (frameCount > budget.maxFrames) fail('manifest', `${frameCount} frames exceed the declared budget.maxFrames ${budget.maxFrames}`);
  if (poseBodyTableCrc32(dt, bodies, cacheId) !== value.bodyTableCrc32) fail('manifest', 'bodyTableCrc32 does not match cacheId, dt and the body table (edited or corrupt?)');

  const frameBytes = poseFrameBytes(bodies.length), chunks: PoseCacheChunkEntry[] = [];
  let nextFrame = 0, totalBytes = 0;
  for (let i = 0; i < chunksIn.length; i++) {
    const at = `chunks[${i}]`, c = chunksIn[i];
    if (!isRecord(c)) fail('manifest', `${at}: expected an object`);
    checkKeys(c, CHUNK_KEYS, at, 'manifest');
    if (c.index !== i) fail('manifest', `${at}: index must be ${i}`);
    if (c.firstFrame !== nextFrame) fail('manifest', `${at}: firstFrame must be ${nextFrame} (chunks are contiguous and in order)`);
    if (!isInt(c.frameCount, 1, frameCount - nextFrame)) fail('manifest', `${at}: frameCount must be an integer from 1 to ${frameCount - nextFrame}`);
    const byteLength = CHUNK_HEADER_BYTES + c.frameCount * frameBytes;
    if (c.byteLength !== byteLength) fail('manifest', `${at}: byteLength must be ${byteLength} (header + ${c.frameCount} frames of ${frameBytes} bytes)`);
    if (byteLength > limits.maxChunkBytes) fail('budget', `${at}: ${byteLength} bytes exceed the chunk limit of ${limits.maxChunkBytes}`);
    totalBytes += byteLength;
    if (totalBytes > limits.maxTotalBytes) fail('budget', `chunks total more than the limit of ${limits.maxTotalBytes} bytes`);
    chunks.push({ index: i, firstFrame: nextFrame, frameCount: c.frameCount, byteLength });
    nextFrame += c.frameCount;
  }
  if (nextFrame !== frameCount) fail('manifest', `chunks hold ${nextFrame} frames; frameCount is ${frameCount}`);
  if (totalBytes > budget.maxBytes) fail('manifest', `chunks total ${totalBytes} bytes, above the declared budget.maxBytes ${budget.maxBytes}`);

  const provenance = normalizeProvenance(value.provenance, 'manifest');
  const manifest: PoseCacheManifest = { cacheId, termination: termination as PoseCacheTermination, dt, bodyTableCrc32: value.bodyTableCrc32, bodies, frameCount, chunks, budget, provenance };
  // Duplicate keys, other number spellings, whitespace and key order are all rejected here: one text per manifest
  if (serializeManifest(manifest) !== text) fail('manifest', 'Pose cache manifest is not in canonical form (compact JSON, fixed key order, no duplicate keys, no surrounding whitespace)');
  return manifest;
}

/** Parse and validate a manifest alone (for tools that only read the body table or budgets). */
export function parsePoseCacheManifest(text: string, limits?: Partial<PoseCacheLimits>): PoseCacheManifest {
  return readManifest(text, resolvePoseCacheLimits(limits));
}

// ---- in-memory cache validation -----------------------------------------------------------------

interface NormalizedCache { cacheId: number; dt: number; termination: PoseCacheTermination; bodies: PoseCacheBody[]; steps: Uint32Array; poses: Float32Array; provenance: PoseCacheProvenance | null }
const CACHE_KEYS = ['cacheId', 'dt', 'termination', 'bodies', 'steps', 'poses', 'provenance'];

function normalizeCache(cache: unknown, limits: PoseCacheLimits): NormalizedCache {
  if (!isRecord(cache)) fail('argument', 'Pose cache: expected a plain object');
  checkKeys(cache, CACHE_KEYS, 'Pose cache', 'argument');
  // Each property is read exactly once
  const { cacheId, dt, termination = 'complete', bodies: bodiesIn, steps, poses, provenance: provenanceIn } = cache;
  if (!isInt(cacheId, 0, 0xffffffff)) fail('data', 'cacheId must be a caller-assigned unsigned 32-bit integer');
  if (!finite(dt) || dt <= 0 || dt > POSE_CACHE_VALUE_LIMITS.maxDt) fail('data', `dt must be a number above 0 and at most ${POSE_CACHE_VALUE_LIMITS.maxDt}`);
  if (typeof termination !== 'string' || !TERMINATIONS.includes(termination)) fail('data', `termination must be one of ${TERMINATIONS.join(', ')}`);
  if (!(steps instanceof Uint32Array) || isShared(steps.buffer)) fail('argument', 'steps must be a Uint32Array on an ordinary ArrayBuffer');
  if (!(poses instanceof Float32Array) || isShared(poses.buffer)) fail('argument', 'poses must be a Float32Array on an ordinary ArrayBuffer (float32 is what the cache stores)');
  const frames = steps.length;
  if (frames < 1) fail('data', 'a cache needs at least one frame');
  if (frames > limits.maxFrames) fail('budget', `${frames} frames exceed the limit of ${limits.maxFrames}`);
  const bodies = normalizeBodies(bodiesIn, frames, limits, 'data');
  if (poses.length !== frames * bodies.length * POSE_FLOATS) fail('data', `poses must hold frames × bodies × 7 = ${frames * bodies.length * POSE_FLOATS} numbers, found ${poses.length}`);
  // Refuse an impossible encoding budget before scanning potentially large pose arrays.
  const frameBytes = poseFrameBytes(bodies.length);
  const perChunk = Math.floor((limits.maxChunkBytes - CHUNK_HEADER_BYTES) / frameBytes);
  if (perChunk < 1) fail('budget', `one frame of ${bodies.length} bodies (${frameBytes} bytes) does not fit the chunk limit of ${limits.maxChunkBytes} bytes`);
  const chunks = Math.ceil(frames / perChunk);
  if (chunks > limits.maxChunks) fail('budget', `${chunks} chunks exceed the limit of ${limits.maxChunks}`);
  const bytes = frames * frameBytes + chunks * CHUNK_HEADER_BYTES;
  if (bytes > limits.maxTotalBytes) fail('budget', `${bytes} minimum encoded bytes exceed the limit of ${limits.maxTotalBytes}`);
  const provenance = normalizeProvenance(provenanceIn, 'data');
  for (let f = 1; f < frames; f++) if (steps[f] <= steps[f - 1]) fail('data', `steps must increase (frame ${f}: ${steps[f]} follows ${steps[f - 1]})`);
  const stride = bodies.length * POSE_FLOATS;
  for (let f = 0; f < frames; f++) {
    const problem = frameProblem(poses, f * stride, bodies, f);
    if (problem) fail('data', problem);
  }
  return { cacheId, dt, termination: termination as PoseCacheTermination, bodies, steps, poses, provenance };
}

/** Throw PoseCacheError unless `cache` is a complete, consistent, in-budget cache. Allocates nothing proportional to the data. */
export function validatePoseCache(cache: unknown, limits?: Partial<PoseCacheLimits>): void {
  normalizeCache(cache, resolvePoseCacheLimits(limits));
}

// ---- encode -------------------------------------------------------------------------------------

export interface EncodePoseCacheOptions {
  /** Frames per chunk; default fills each chunk up to limits.maxChunkBytes. */
  framesPerChunk?: number;
  limits?: Partial<PoseCacheLimits>;
  /** Declared maxima written to the manifest; default the cache's own counts. Must not be below them. */
  budget?: Partial<PoseCacheBudget>;
}
export interface EncodedPoseCache { manifest: string; chunks: Uint8Array[] }

/**
 * Validate everything first, then allocate. Neither `cache` nor its arrays are retained or modified, and the returned
 * chunks are fresh, separate buffers.
 */
export function encodePoseCache(cache: PoseCacheInput, options: EncodePoseCacheOptions = {}): EncodedPoseCache {
  if (!isRecord(options)) fail('argument', 'options must be a plain object');
  checkKeys(options, ['framesPerChunk', 'limits', 'budget'], 'options', 'argument');
  const { framesPerChunk, limits: limitsIn, budget: budgetIn } = options as EncodePoseCacheOptions;
  const limits = resolvePoseCacheLimits(limitsIn);
  const c = normalizeCache(cache, limits);
  const frames = c.steps.length, n = c.bodies.length, frameBytes = poseFrameBytes(n);
  const mostPerChunk = Math.floor((limits.maxChunkBytes - CHUNK_HEADER_BYTES) / frameBytes);
  if (mostPerChunk < 1) fail('budget', `one frame of ${n} bodies (${frameBytes} bytes) does not fit the chunk limit of ${limits.maxChunkBytes} bytes`);
  const per = framesPerChunk ?? mostPerChunk;
  if (!isInt(per, 1, mostPerChunk)) fail('argument', `framesPerChunk must be an integer from 1 to ${mostPerChunk}`);
  const chunkCount = Math.ceil(frames / per);
  if (chunkCount > limits.maxChunks) fail('budget', `${chunkCount} chunks exceed the limit of ${limits.maxChunks}`);
  const totalBytes = chunkCount * CHUNK_HEADER_BYTES + frames * frameBytes;
  if (totalBytes > limits.maxTotalBytes) fail('budget', `${totalBytes} bytes exceed the limit of ${limits.maxTotalBytes}`);

  const given: unknown = budgetIn ?? {};
  if (!isRecord(given)) fail('argument', 'budget must be a plain object');
  checkKeys(given, BUDGET_KEYS, 'budget', 'argument');
  const budget = { maxBodies: given.maxBodies ?? n, maxFrames: given.maxFrames ?? frames, maxBytes: given.maxBytes ?? totalBytes };
  if (!isInt(budget.maxBodies, n, POSE_CACHE_HARD_LIMITS.maxBodies)) fail('argument', `budget.maxBodies must be an integer from ${n} (the bodies) to ${POSE_CACHE_HARD_LIMITS.maxBodies}`);
  if (!isInt(budget.maxFrames, frames, POSE_CACHE_HARD_LIMITS.maxFrames)) fail('argument', `budget.maxFrames must be an integer from ${frames} (the frames) to ${POSE_CACHE_HARD_LIMITS.maxFrames}`);
  if (!isInt(budget.maxBytes, totalBytes, POSE_CACHE_HARD_LIMITS.maxTotalBytes)) fail('argument', `budget.maxBytes must be an integer from ${totalBytes} (the chunk bytes) to ${POSE_CACHE_HARD_LIMITS.maxTotalBytes}`);

  const entries: PoseCacheChunkEntry[] = [];
  for (let i = 0, first = 0; i < chunkCount; i++, first += per) {
    const frameCount = Math.min(per, frames - first);
    entries.push({ index: i, firstFrame: first, frameCount, byteLength: CHUNK_HEADER_BYTES + frameCount * frameBytes });
  }
  const bodyTableCrc32 = poseBodyTableCrc32(c.dt, c.bodies, c.cacheId);
  const manifestObject: PoseCacheManifest = { cacheId: c.cacheId, termination: c.termination, dt: c.dt, bodyTableCrc32, bodies: c.bodies, frameCount: frames, chunks: entries, budget: { maxBodies: budget.maxBodies, maxFrames: budget.maxFrames, maxBytes: budget.maxBytes }, provenance: c.provenance };
  const manifest = serializeManifest(manifestObject);
  // The encoder must never emit what its own reader refuses, including a manifest over the manifest limit
  readManifest(manifest, limits);

  const stride = n * POSE_FLOATS, chunks: Uint8Array[] = [];
  for (const e of entries) {
    const bytes = new Uint8Array(e.byteLength), v = new DataView(bytes.buffer);
    bytes.set([0x54, 0x41, 0x50, 0x43], 0);
    v.setUint16(4, POSE_CACHE_CHUNK_REVISION, true); v.setUint16(6, CHUNK_HEADER_BYTES, true);
    v.setUint32(8, bodyTableCrc32, true); v.setUint32(12, e.index, true); v.setUint32(16, e.firstFrame, true);
    v.setUint32(20, e.frameCount, true); v.setUint32(24, n, true); v.setUint32(28, e.frameCount * frameBytes, true);
    v.setUint32(32, crc32(bytes, 0, 32), true);
    for (let j = 0; j < e.frameCount; j++) {
      const frame = e.firstFrame + j, at = CHUNK_HEADER_BYTES + j * frameBytes;
      v.setUint32(at, c.steps[frame], true);
      for (let k = 0; k < stride; k++) v.setFloat32(at + 4 + 4 * k, c.poses[frame * stride + k], true);
      v.setUint32(at + frameBytes - 4, crc32(bytes, at, at + frameBytes - 4, v.getUint32(32, true)), true);
    }
    chunks.push(bytes);
  }
  return { manifest, chunks };
}

// ---- decode and recovery ------------------------------------------------------------------------

interface ChunkHeader { headerCrc: number; frameCount: number; firstFrame: number; payloadBytes: number }
/** Check a chunk header against its manifest entry; returns the header or a reason string. */
function readChunkHeader(c: Uint8Array, entry: PoseCacheChunkEntry, manifest: PoseCacheManifest): ChunkHeader | string {
  const at = `chunk ${entry.index}`;
  if (c.length < CHUNK_HEADER_BYTES) return `${at}: ends inside its ${CHUNK_HEADER_BYTES}-byte header (${c.length} bytes)`;
  const v = new DataView(c.buffer, c.byteOffset, c.byteLength);
  if (c[0] !== 0x54 || c[1] !== 0x41 || c[2] !== 0x50 || c[3] !== 0x43) return `${at}: not a pose cache chunk (bad magic)`;
  if (v.getUint32(32, true) !== crc32(c, 0, 32)) return `${at}: header checksum mismatch (corrupt header)`;
  if (v.getUint16(4, true) !== POSE_CACHE_CHUNK_REVISION) return `${at}: unsupported chunk revision ${v.getUint16(4, true)}`;
  if (v.getUint16(6, true) !== CHUNK_HEADER_BYTES) return `${at}: unexpected header size ${v.getUint16(6, true)}`;
  if (v.getUint32(8, true) !== manifest.bodyTableCrc32) return `${at}: belongs to a different cache (body table checksum differs from the manifest)`;
  if (v.getUint32(12, true) !== entry.index) return `${at}: header says chunk ${v.getUint32(12, true)}`;
  if (v.getUint32(16, true) !== entry.firstFrame) return `${at}: first frame ${v.getUint32(16, true)} differs from the manifest's ${entry.firstFrame}`;
  if (v.getUint32(20, true) !== entry.frameCount) return `${at}: ${v.getUint32(20, true)} frames differ from the manifest's ${entry.frameCount}`;
  if (v.getUint32(24, true) !== manifest.bodies.length) return `${at}: ${v.getUint32(24, true)} bodies differ from the manifest's ${manifest.bodies.length}`;
  const payloadBytes = entry.frameCount * poseFrameBytes(manifest.bodies.length);
  if (v.getUint32(28, true) !== payloadBytes) return `${at}: payload size ${v.getUint32(28, true)} differs from ${payloadBytes}`;
  return { headerCrc: v.getUint32(32, true), frameCount: entry.frameCount, firstFrame: entry.firstFrame, payloadBytes };
}

/** The array itself when it is already exactly `length` long (it is fresh, so no copy is needed), else a right-sized copy. */
function trim<T extends Uint32Array | Float32Array>(a: T, length: number): T { return a.length === length ? a : a.slice(0, length) as T; }

interface Walked { steps: Uint32Array; poses: Float32Array; frames: number; problem: PoseCacheProblem | null }

/**
 * Read chunks in order until the first thing that is not exactly what the manifest promised. Allocation is bounded by
 * the bytes the caller supplied (frames that fit in them, never more than the manifest's validated count), so a
 * manifest that promises a lot and arrives with little allocates little.
 */
function walkChunks(manifest: PoseCacheManifest, chunks: unknown): Walked {
  if (!Array.isArray(chunks)) fail('argument', 'chunks must be an array of Uint8Array');
  if (chunks.length > manifest.chunks.length) fail('chunk', `${chunks.length} chunks given; the manifest lists ${manifest.chunks.length}`);
  const n = manifest.bodies.length, frameBytes = poseFrameBytes(n), stride = n * POSE_FLOATS;
  for (const c of chunks) if (!(c instanceof Uint8Array) || isShared(c.buffer)) fail('argument', 'every chunk must be a Uint8Array on an ordinary ArrayBuffer');
  const list = chunks as Uint8Array[];

  const headers: ChunkHeader[] = [];
  let problem: PoseCacheProblem | null = null, upper = 0;
  for (let i = 0; i < list.length; i++) {
    const header = readChunkHeader(list[i], manifest.chunks[i], manifest);
    if (typeof header === 'string') { problem = { chunk: i, frame: manifest.chunks[i].firstFrame, code: 'chunk', reason: header }; break; }
    headers.push(header);
    upper += Math.min(header.frameCount, Math.floor((list[i].length - CHUNK_HEADER_BYTES) / frameBytes));
  }

  const steps = new Uint32Array(upper), poses = new Float32Array(upper * stride), scratch = new Float32Array(stride);
  let frames = 0, last = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i], c = list[i], v = new DataView(c.buffer, c.byteOffset, c.byteLength);
    const available = Math.min(h.frameCount, Math.floor((c.length - CHUNK_HEADER_BYTES) / frameBytes));
    let broke: PoseCacheProblem | null = null;
    for (let j = 0; j < available && !broke; j++) {
      const at = CHUNK_HEADER_BYTES + j * frameBytes, frame = frames;
      if (v.getUint32(at + frameBytes - 4, true) !== crc32(c, at, at + frameBytes - 4, h.headerCrc)) { broke = { chunk: i, frame, code: 'data', reason: `frame ${frame}: checksum mismatch (corrupt data)` }; break; }
      const step = v.getUint32(at, true);
      if (step <= last) { broke = { chunk: i, frame, code: 'data', reason: `steps must increase (frame ${frame}: ${step} follows ${last})` }; break; }
      for (let k = 0; k < stride; k++) scratch[k] = v.getFloat32(at + 4 + 4 * k, true);
      const bad = frameProblem(scratch, 0, manifest.bodies, frame);
      if (bad) { broke = { chunk: i, frame, code: 'data', reason: bad }; break; }
      steps[frames] = step; poses.set(scratch, frames * stride); last = step; frames++;
    }
    if (broke) { problem = broke; break; }
    if (available < h.frameCount) { problem = { chunk: i, frame: frames, code: 'chunk', reason: `chunk ${i}: truncated after ${available} of ${h.frameCount} frames` }; break; }
    if (c.length > CHUNK_HEADER_BYTES + h.payloadBytes) { problem = { chunk: i, frame: null, code: 'chunk', reason: `chunk ${i}: ${c.length - CHUNK_HEADER_BYTES - h.payloadBytes} unexpected bytes after its last frame` }; break; }
  }
  // A problem found while reading headers can only be at or after the frames read above, so the earlier problem wins
  if (!problem && list.length < manifest.chunks.length) {
    problem = { chunk: list.length, frame: manifest.chunks[list.length].firstFrame, code: 'chunk', reason: `chunk ${list.length} of ${manifest.chunks.length} is missing` };
  }
  return { steps, poses, frames, problem };
}

/**
 * Decode a complete cache. Anything the manifest did not promise, or that does not verify, throws PoseCacheError;
 * there is no partial result (see recoverPoseCachePrefix). Returned arrays do not alias the input.
 */
export function decodePoseCache(manifestText: string, chunks: readonly Uint8Array[], limits?: Partial<PoseCacheLimits>): PoseCache {
  const manifest = readManifest(manifestText, resolvePoseCacheLimits(limits));
  const { steps, poses, frames, problem } = walkChunks(manifest, chunks);
  if (problem) fail(problem.code, problem.reason);
  return { cacheId: manifest.cacheId, dt: manifest.dt, termination: manifest.termination, bodies: manifest.bodies.map(b => ({ ...b, size: [...b.size] as [number, number, number] })), steps: trim(steps, frames), poses: trim(poses, frames * manifest.bodies.length * POSE_FLOATS), provenance: manifest.provenance };
}

/**
 * Recover the longest prefix that verifies. This is NOT a lenient decode: the result says `complete: false` and why it
 * stopped, the prefix is a whole number of CRC-verified, fully validated frames, and nothing after the first problem
 * is used. A damaged or missing manifest, or a chunk whose header cannot be verified, leaves nothing to trust: the
 * manifest is the only authority on the body table, dt and chunk layout, so an unreadable manifest throws.
 * The recovered cache keeps only bodies that are alive in the prefix, with lifetimes clipped to it.
 */
export function recoverPoseCachePrefix(manifestText: string, chunks: readonly Uint8Array[], limits?: Partial<PoseCacheLimits>): PoseCacheRecovery {
  const manifest = readManifest(manifestText, resolvePoseCacheLimits(limits));
  const { steps, poses, frames, problem } = walkChunks(manifest, chunks);
  const declaredFrames = manifest.frameCount;
  if (frames === 0) return { cache: null, complete: false, declaredFrames, recoveredFrames: 0, omittedBodyIds: manifest.bodies.map(b => b.id), problem };
  const n = manifest.bodies.length, stride = n * POSE_FLOATS;
  const keep: number[] = [];
  manifest.bodies.forEach((b, i) => { if (b.firstFrame < frames) keep.push(i); });
  if (keep.length === 0) return { cache: null, complete: false, declaredFrames, recoveredFrames: frames, omittedBodyIds: manifest.bodies.map(b => b.id), problem };
  const kept = keep.length === n ? trim(poses, frames * stride) : new Float32Array(frames * keep.length * POSE_FLOATS);
  if (keep.length !== n) {
    for (let f = 0; f < frames; f++) keep.forEach((slot, s) => kept.set(poses.subarray(f * stride + slot * POSE_FLOATS, f * stride + (slot + 1) * POSE_FLOATS), (f * keep.length + s) * POSE_FLOATS));
  }
  const cache: PoseCache = {
    cacheId: manifest.cacheId, dt: manifest.dt, termination: problem ? 'recovered' : manifest.termination,
    bodies: keep.map(i => { const b = manifest.bodies[i]; return { ...b, size: [...b.size] as [number, number, number], endFrame: Math.min(b.endFrame, frames) }; }),
    steps: trim(steps, frames), poses: kept, provenance: manifest.provenance,
  };
  return { cache, complete: problem === null, declaredFrames, recoveredFrames: frames, omittedBodyIds: manifest.bodies.filter(b => b.firstFrame >= frames).map(b => b.id), problem };
}

// ---- sampling -----------------------------------------------------------------------------------

/** Seconds from the first frame to the last, by the step stamps. */
export function poseCacheDuration(cache: Pick<PoseCache, 'dt' | 'steps'>): number {
  return (cache.steps[cache.steps.length - 1] - cache.steps[0]) * cache.dt;
}

/**
 * Write the poses at `time` (seconds from the first frame, clamped into the cache) into `out` (bodies × 7) and, for every
 * body, 1 or 0 into `alive`. Allocates nothing. `cache` must be one this module returned or validated.
 *
 * - At a frame's own time the result is that frame exactly (float32 values, that frame's alive set).
 * - Between two frames a body is present only if it is alive in BOTH; then position is linear and rotation the
 *   normalized shortest-arc blend (q and -q are the same rotation; an exact cancellation keeps the earlier frame's
 *   rotation). A body that is born or ends between two frames is absent in between: no extrapolation, no holding,
 *   no blending across a lifetime boundary. No cap is placed on the step gap between frames.
 * - A body that is not alive reads as all +0 with alive = 0.
 * Throws RangeError on a non-finite time or wrong-sized arrays.
 */
export function samplePoseCache(cache: PoseCache, time: number, out: Float32Array | Float64Array, alive: Uint8Array): void {
  const n = cache.bodies.length, steps = cache.steps, frames = steps.length, p = cache.poses;
  if (!Number.isFinite(time)) throw new RangeError('samplePoseCache: time must be finite');
  if (out.length !== n * POSE_FLOATS) throw new RangeError('samplePoseCache: out must hold bodies × 7 numbers');
  if (alive.length !== n) throw new RangeError('samplePoseCache: alive must hold one byte per body');
  if (frames < 1 || p.length !== frames * n * POSE_FLOATS) throw new RangeError('samplePoseCache: not a valid cache');
  const first = steps[0], dt = cache.dt, at = (k: number) => (steps[k] - first) * dt;
  const t = Math.min(Math.max(time, 0), at(frames - 1));
  // Last frame whose time is <= t, compared in the same expression frame times are written in, so a frame's own time finds it exactly
  let lo = 0, hi = frames - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (at(mid) <= t) lo = mid; else hi = mid - 1; }
  const span = lo === frames - 1 ? 0 : at(lo + 1) - at(lo);
  const exact = !(span > 0) || t <= at(lo), f = exact ? 0 : (t - at(lo)) / span;
  const stride = n * POSE_FLOATS, a = lo * stride, b = a + stride;
  for (let i = 0; i < n; i++) {
    const body = cache.bodies[i], o = i * POSE_FLOATS, x = a + o, y = b + o;
    const inLo = lo >= body.firstFrame && lo < body.endFrame;
    const live = exact ? inLo : inLo && lo + 1 >= body.firstFrame && lo + 1 < body.endFrame;
    alive[i] = live ? 1 : 0;
    if (!live) { for (let k = 0; k < POSE_FLOATS; k++) out[o + k] = 0; continue; }
    if (exact) { for (let k = 0; k < POSE_FLOATS; k++) out[o + k] = p[x + k]; continue; }
    for (let k = 0; k < 3; k++) out[o + k] = p[x + k] + (p[y + k] - p[x + k]) * f;
    const dot = p[x + 3] * p[y + 3] + p[x + 4] * p[y + 4] + p[x + 5] * p[y + 5] + p[x + 6] * p[y + 6], s = dot < 0 ? -1 : 1;
    // Blend into `out`, then normalize in place
    let length = 0;
    for (let k = 3; k < 7; k++) { out[o + k] = p[x + k] + (s * p[y + k] - p[x + k]) * f; length += out[o + k] * out[o + k]; }
    length = Math.sqrt(length);
    for (let k = 3; k < 7; k++) out[o + k] = length > 1e-9 ? out[o + k] / length : p[x + k];
  }
}
