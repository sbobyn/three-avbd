import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CHUNK_HEADER_BYTES, crc32, decodePoseCache, encodePoseCache, parsePoseCacheManifest, POSE_CACHE_CONVENTIONS, POSE_CACHE_DEFAULT_LIMITS,
  POSE_CACHE_HARD_LIMITS, POSE_CACHE_VALUE_LIMITS, POSE_CACHE_SCHEMA, poseBodyTableCrc32, poseCacheDuration, poseFrameBytes, PoseCacheError, POSE_FLOATS,
  recoverPoseCachePrefix, resolvePoseCacheLimits, samplePoseCache, validatePoseCache,
} from '../src/bake/pose-cache.ts';
import type { PoseCache, PoseCacheBody, PoseCacheErrorCode, PoseCacheInput } from '../src/bake/pose-cache.ts';
import { parsePoseTrack, POSE_TRACK_SCHEMA, POSE_TRACK_UNITS, PoseTrackError } from '../examples/pose-track.ts';

// ---- fixtures -----------------------------------------------------------------------------------

const DT = 0.25, FRAMES = 6, N = 4, FB = poseFrameBytes(N);
/** Slot order is deliberately not id order. Body 9 is born at frame 2, body 5 ends before frame 4. */
const bodies = (): PoseCacheBody[] => [
  { id: 1, shape: 'box', size: [10, 1, 10], fixed: true, firstFrame: 0, endFrame: 6 },
  { id: 20, shape: 'sphere', size: [1, 1, 1], fixed: false, firstFrame: 0, endFrame: 6 },
  { id: 9, shape: 'box', size: [0.5, 0.25, 2], fixed: false, firstFrame: 2, endFrame: 6 },
  { id: 5, shape: 'sphere', size: [2, 2, 2], fixed: false, firstFrame: 0, endFrame: 4 },
];
/** Frames read at steps 0 1 2 4 5 8, so at 0, 0.25, 0.5, 1, 1.25, 2 s. */
function makeCache(): PoseCache {
  const list = bodies(), steps = Uint32Array.from([0, 1, 2, 4, 5, 8]), poses = new Float32Array(FRAMES * N * POSE_FLOATS);
  for (let f = 0; f < FRAMES; f++) list.forEach((b, i) => {
    if (f < b.firstFrame || f >= b.endFrame) return;
    const o = (f * N + i) * POSE_FLOATS, angle = 0.3 * f + 0.1 * i;
    poses.set([i + f * 0.5, 10 - f * f * 0.25 + i, -0.125 * f * (i + 1), 0, Math.sin(angle / 2), 0, Math.cos(angle / 2)], o);
  });
  return { cacheId: 12345, dt: DT, termination: 'complete', bodies: list, steps, poses, provenance: null };
}
const bits = (a: Float32Array) => Array.from(new Uint32Array(a.buffer, a.byteOffset, a.length));
const summary = (c: PoseCache) => ({ ids: c.bodies.map(b => b.id), steps: Array.from(c.steps), bits: bits(c.poses) });
/** What a recovered prefix of `frames` frames of `c` must contain, derived independently of the codec. */
function prefixOf(c: PoseCache, frames: number) {
  const n = c.bodies.length, keep = c.bodies.map((_, i) => i).filter(i => c.bodies[i].firstFrame < frames), out: number[] = [];
  const all = bits(c.poses);
  for (let f = 0; f < frames; f++) for (const i of keep) for (let k = 0; k < POSE_FLOATS; k++) out.push(all[(f * n + i) * POSE_FLOATS + k]);
  return { ids: keep.map(i => c.bodies[i].id), steps: Array.from(c.steps.subarray(0, frames)), bits: out };
}
function throwsWith(fn: () => unknown, code: PoseCacheErrorCode, pattern?: RegExp, label?: string) {
  assert.throws(fn, (e: unknown) => e instanceof PoseCacheError && e.code === code && (pattern === undefined || pattern.test(e.message)), label ?? `${code} ${pattern ?? ''}`);
}
/** Edit a manifest as parsed JSON (key order is preserved, so the text stays canonical). */
function edit(text: string, change: (m: any) => void, fixCrc = false): string {
  const m = JSON.parse(text);
  change(m);
  if (fixCrc) m.bodyTableCrc32 = poseBodyTableCrc32(m.dt, m.bodies, m.cacheId);
  return JSON.stringify(m);
}
/** Copy `chunk`, change one frame in it and re-seal that frame's checksum, so only the content is wrong. */
function patchFrame(chunk: Uint8Array, frame: number, change: (v: DataView, at: number) => void): Uint8Array {
  const copy = chunk.slice(), v = new DataView(copy.buffer), at = CHUNK_HEADER_BYTES + frame * FB;
  change(v, at);
  v.setUint32(at + FB - 4, crc32(copy, at, at + FB - 4, v.getUint32(32, true)), true);
  return copy;
}
const slotAt = (at: number, slot: number, k = 0) => at + 4 + (slot * POSE_FLOATS + k) * 4;
const copyAll = (chunks: readonly Uint8Array[]) => chunks.map(c => c.slice());

// ---- format, round trip ---------------------------------------------------------------------------

test('crc32 is the standard IEEE CRC-32', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(Uint8Array.from([9, 1, 2, 3, 9]), 1, 4), crc32(Uint8Array.from([1, 2, 3])));
});

test('a cache round-trips bit for bit and re-encodes to the same bytes', () => {
  const cache = makeCache();
  // Represented float32 corner cases on live slots: negative zero, a subnormal, large and tiny magnitudes
  const o = (3 * N + 1) * POSE_FLOATS;
  cache.poses[o] = -0; cache.poses[o + 1] = 1e-45; cache.poses[o + 2] = Math.fround(999999.9375);
  cache.poses[o + 3] = Math.fround(1e-30);
  cache.poses.set([-0, -999999.5, 123456.789], (1 * N + 0) * POSE_FLOATS);
  const { manifest, chunks } = encodePoseCache(cache);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].length, CHUNK_HEADER_BYTES + FRAMES * FB);
  const back = decodePoseCache(manifest, chunks);
  assert.deepEqual(summary(back), summary(cache), 'poses, steps and body order identical');
  assert.deepEqual(back.bodies, cache.bodies);
  assert.equal(back.dt, DT);
  assert.equal(back.termination, 'complete');
  assert.equal(back.provenance, null);
  assert.ok(Object.is(back.poses[o], -0), 'negative zero survives');
  assert.equal(back.poses[o + 1], Math.fround(1e-45), 'subnormal survives');
  assert.ok(back.poses[o + 1] > 0 && back.poses[o + 1] < 1e-44);
  const again = encodePoseCache(back);
  assert.equal(again.manifest, manifest);
  assert.deepEqual(again.chunks.map(c => Array.from(c)), chunks.map(c => Array.from(c)), 'encoding is deterministic');
  assert.equal(poseCacheDuration(back), 2);
});

test('the byte layout is fixed: magic, little-endian fields and floats, per-frame checksum', () => {
  const one = { cacheId: 7, dt: 0.5, bodies: [{ id: 7, shape: 'box' as const, size: [1, 2, 3] as [number, number, number], fixed: false, firstFrame: 0, endFrame: 1 }], steps: Uint32Array.of(0x01020304), poses: Float32Array.of(1, 2, 3, 0, 0, 0, 1) };
  const { manifest, chunks } = encodePoseCache(one);
  const c = chunks[0], v = new DataView(c.buffer);
  assert.deepEqual(Array.from(c.subarray(0, 4)), [0x54, 0x41, 0x50, 0x43], 'TAPC');
  assert.deepEqual(Array.from(c.subarray(4, 8)), [1, 0, 36, 0], 'revision 1, header 36 bytes, little-endian u16');
  assert.equal(v.getUint32(8, true), parsePoseCacheManifest(manifest).bodyTableCrc32);
  assert.deepEqual([12, 16, 20, 24, 28].map(o => v.getUint32(o, true)), [0, 0, 1, 1, poseFrameBytes(1)], 'chunk 0, first frame 0, 1 frame, 1 body, payload');
  assert.equal(v.getUint32(32, true), crc32(c, 0, 32));
  assert.deepEqual(Array.from(c.subarray(36, 40)), [4, 3, 2, 1], 'step 0x01020304 little-endian');
  assert.deepEqual(Array.from(c.subarray(40, 44)), [0x00, 0x00, 0x80, 0x3f], '1.0f little-endian');
  assert.equal(v.getUint32(c.length - 4, true), crc32(c, 36, c.length - 4, v.getUint32(32, true)));
  assert.equal(c.length, 36 + poseFrameBytes(1));
  assert.deepEqual(Array.from(decodePoseCache(manifest, chunks).steps), [0x01020304]);
});

test('chunk boundaries: any chunk size decodes to the same cache', () => {
  const cache = makeCache(), want = summary(cache);
  for (const per of [1, 2, 3, 4, 5, 6, undefined]) {
    const { manifest, chunks } = encodePoseCache(cache, { framesPerChunk: per });
    const m = parsePoseCacheManifest(manifest);
    const expectedChunks = per === undefined ? 1 : Math.ceil(FRAMES / per);
    assert.equal(chunks.length, expectedChunks, `per ${per}`);
    assert.equal(m.chunks.reduce((s, c) => s + c.frameCount, 0), FRAMES);
    m.chunks.forEach((c, i) => { assert.equal(c.index, i); assert.equal(chunks[i].length, c.byteLength); assert.equal(c.byteLength, CHUNK_HEADER_BYTES + c.frameCount * FB); });
    assert.deepEqual(summary(decodePoseCache(manifest, chunks)), want, `per ${per}`);
  }
  // Lifetimes crossing chunk boundaries (body 9 is born inside chunk 1, body 5 ends at a chunk boundary) are unchanged
  const decoded = decodePoseCache(...(({ manifest, chunks }) => [manifest, chunks] as const)(encodePoseCache(cache, { framesPerChunk: 2 })));
  assert.deepEqual(decoded.bodies.map(b => [b.id, b.firstFrame, b.endFrame]), [[1, 0, 6], [20, 0, 6], [9, 2, 6], [5, 0, 4]]);
});

test('provenance and termination are carried, bounded and validated', () => {
  const provenance = { tool: 'unit test', gitHead: 'abc123', dirty: false, steps: 12.5, note: null };
  const cache = { ...makeCache(), termination: 'cancelled' as const, provenance };
  const { manifest, chunks } = encodePoseCache(cache);
  const back = decodePoseCache(manifest, chunks);
  assert.equal(back.termination, 'cancelled');
  assert.deepEqual({ ...back.provenance }, provenance);
  assert.equal(Object.getPrototypeOf(back.provenance), null, 'no prototype to pollute');
  assert.ok(Object.isFrozen(back.provenance));
  provenance.tool = 'changed after encoding';
  assert.equal(back.provenance!.tool, 'unit test', 'the cache copied the record');
  for (const bad of [{ __proto__x: 1 }, { 'a b': 1 }, { '1': 1 }, { a: { nested: 1 } }, { a: [1] }, { a: 'x'.repeat(257) }, { a: 'café' }, { a: 'tab\t' }, { a: NaN }, { a: Infinity }, { a: undefined },
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, i])), 'text', 5, []]) {
    throwsWith(() => encodePoseCache({ ...makeCache(), provenance: bad as never }), 'data', /provenance/, JSON.stringify(bad)?.slice(0, 40));
  }
  throwsWith(() => encodePoseCache({ ...makeCache(), provenance: JSON.parse('{"__proto__":{"x":1}}') }), 'data', /provenance/, 'an own __proto__ key');
  throwsWith(() => encodePoseCache({ ...makeCache(), termination: 'finished' as never }), 'data', /termination/);
});

// ---- manifest -----------------------------------------------------------------------------------

test('manifest: foreign, truncated and non-canonical text is refused', () => {
  const { manifest } = encodePoseCache(makeCache());
  const m = parsePoseCacheManifest(manifest);
  assert.equal(m.frameCount, FRAMES);
  assert.deepEqual(m.bodies.map(b => b.id), [1, 20, 9, 5]);
  throwsWith(() => parsePoseCacheManifest(manifest.slice(0, manifest.length >> 1)), 'manifest', /not valid JSON/, 'truncated');
  throwsWith(() => parsePoseCacheManifest(manifest.slice(0, -1)), 'manifest', /not valid JSON/);
  throwsWith(() => parsePoseCacheManifest(''), 'manifest', /not valid JSON/);
  for (const text of ['[]', 'null', '"x"', '3']) throwsWith(() => parsePoseCacheManifest(text), 'manifest', /expected a JSON object/, text);
  throwsWith(() => parsePoseCacheManifest(5 as never), 'argument', /expected text/);
  throwsWith(() => parsePoseCacheManifest('['.repeat(200000)), 'manifest', /not valid JSON/, 'absurd nesting is a parse failure, not a crash');
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.schema = 'three-avbd.pose-cache/v1'; })), 'schema', /Not a pose cache manifest/, 'a future or frozen schema is not this draft');
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.schema = 'three-avbd/interlocking-trial/v1'; })), 'schema');
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { delete x.schema; })), 'schema');
  throwsWith(() => parsePoseCacheManifest(`${manifest}\n`), 'manifest', /canonical/, 'trailing newline');
  throwsWith(() => parsePoseCacheManifest(` ${manifest}`), 'manifest', /canonical/, 'leading space');
  throwsWith(() => parsePoseCacheManifest(JSON.stringify(JSON.parse(manifest), null, 1)), 'manifest', /canonical/, 'pretty printed');
  const reordered = JSON.parse(manifest); const { dt, ...rest } = reordered;
  throwsWith(() => parsePoseCacheManifest(JSON.stringify({ dt, ...rest })), 'manifest', /canonical/, 'key order');
  throwsWith(() => parsePoseCacheManifest(manifest.replace('"frameCount":6', '"frameCount":7,"frameCount":6')), 'manifest', /canonical/, 'duplicate key: parsers disagree on which wins');
  throwsWith(() => parsePoseCacheManifest(manifest.replace('"dt":0.25', '"dt":2.5e-1')), 'manifest', /canonical/, 'another spelling of the same number');
  throwsWith(() => parsePoseCacheManifest(manifest.replace('"dt":0.25', '"dt":1e999')), 'manifest', /dt must be/, 'overflows to Infinity');
});

test('manifest: unknown fields and prototype tricks are refused', () => {
  const { manifest } = encodePoseCache(makeCache());
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.extra = 1; })), 'manifest', /unknown field "extra"/);
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.bodies[0].mass = 1; })), 'manifest', /unknown field "mass"/);
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.chunks[0].crc = 1; })), 'manifest', /unknown field "crc"/);
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.budget.extra = 1; })), 'manifest', /unknown field "extra"/);
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.conventions.extra = 1; })), 'manifest', /conventions/);
  // JSON.parse makes "__proto__" an own data property; it is an unknown field, never the object's prototype
  for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const text = manifest.replace(/^\{/, `{"${key}":{"polluted":true},`);
    assert.throws(() => parsePoseCacheManifest(text), (e: unknown) => e instanceof PoseCacheError && /unknown field|canonical|schema/.test(e.message), key);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  for (const [key, value] of [['length', 'foot'], ['time', 'ms'], ['handedness', 'left'], ['up', '+z'], ['rotation', 'quaternion-wxyz'], ['pose', 'x'], ['byteOrder', 'big'], ['floatFormat', 'float64']]) {
    throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { x.conventions[key] = value; })), 'manifest', /conventions must be exactly/, key);
  }
  throwsWith(() => parsePoseCacheManifest(edit(manifest, x => { delete x.conventions; })), 'manifest', /conventions/);
  assert.deepEqual(POSE_CACHE_CONVENTIONS.byteOrder, 'little');
});

test('manifest: dt, termination, body table, lifetimes and chunk table are semantically validated', () => {
  const { manifest } = encodePoseCache(makeCache(), { framesPerChunk: 4 });
  const bad = (change: (m: any) => void, pattern: RegExp, label: string, fixCrc = true) => throwsWith(() => parsePoseCacheManifest(edit(manifest, change, fixCrc)), 'manifest', pattern, label);
  for (const dt of [0, -0.25, 1.0000001, null, '0.25', true]) bad(m => { m.dt = dt; }, /dt must be/, `dt ${dt}`, false);
  for (const termination of ['finished', '', 5, null]) bad(m => { m.termination = termination; }, /termination/, `termination ${termination}`);
  for (const id of [0, -1, 1.5, 2 ** 31, '3', null]) bad(m => { m.bodies[0].id = id; }, /id must be an integer/, `id ${id}`);
  bad(m => { m.bodies[1].id = 1; }, /duplicate id 1/, 'duplicate ids');
  for (const shape of ['capsule', 'hull', 'Box', 1, undefined]) bad(m => { m.bodies[0].shape = shape; }, /shape must be/, `shape ${String(shape)}`);
  for (const size of [[1, 1], [1, 1, 1, 1], [0, 1, 1], [-1, 1, 1], [1, 1, 1001], ['1', 1, 1], [null, 1, 1], 'big']) bad(m => { m.bodies[0].size = size; }, /size must be three numbers/, `size ${JSON.stringify(size)}`);
  bad(m => { m.bodies[1].size = [1, 1, 2]; }, /sphere's size is its diameter/, 'non-uniform sphere');
  for (const fixed of [1, 'true', null]) bad(m => { m.bodies[0].fixed = fixed; }, /fixed must be/, `fixed ${fixed}`);
  bad(m => { m.bodies[0].firstFrame = 6; m.bodies[0].endFrame = 6; }, /firstFrame must be a frame index below 6/, 'born after the last frame');
  bad(m => { m.bodies[0].firstFrame = -1; }, /firstFrame/, 'negative start');
  bad(m => { m.bodies[0].firstFrame = 1.5; }, /firstFrame/, 'fractional start');
  bad(m => { m.bodies[0].endFrame = 7; }, /endFrame must be above firstFrame and at most 6/, 'ends after the last frame');
  bad(m => { m.bodies[2].endFrame = 2; }, /endFrame must be above firstFrame/, 'empty lifetime');
  bad(m => { m.bodies[2].endFrame = 1; }, /endFrame must be above firstFrame/, 'negative lifetime');
  bad(m => { m.bodies = []; }, /bodies must be a non-empty list/, 'no bodies', false);
  bad(m => { m.bodies = 'two'; }, /bodies must be a non-empty list/, 'bodies not a list', false);
  bad(m => { m.bodies[0] = null; }, /bodies\[0\]: expected an object/, 'null body', false);
  bad(m => { m.bodies[0].size[0] = 11; }, /bodyTableCrc32 does not match/, 'body table edited without its checksum', false);
  bad(m => { m.bodyTableCrc32 = 1.5; }, /bodyTableCrc32 must be/, 'checksum not an integer', false);
  bad(m => { m.dt = 0.5; }, /bodyTableCrc32 does not match/, 'dt edited without its checksum', false);
  for (const frameCount of [0, -1, 6.5, '6', null]) bad(m => { m.frameCount = frameCount; }, /frameCount must be/, `frameCount ${frameCount}`, false);
  bad(m => { m.frameCount = 7; }, /declared budget.maxFrames|chunks hold 6 frames/, 'frameCount above the chunk table', false);
  bad(m => { m.frameCount = 5; }, /frameCount|chunk|endFrame/, 'frameCount below the chunk table', false);
  bad(m => { m.chunks = []; }, /chunks must be a non-empty list/, 'no chunks', false);
  bad(m => { m.chunks[1].index = 5; }, /chunks\[1\]: index must be 1/, 'chunk index', false);
  bad(m => { m.chunks[1].firstFrame = 3; }, /chunks\[1\]: firstFrame must be 4/, 'gap between chunks', false);
  bad(m => { m.chunks[1].firstFrame = 3; m.chunks[1].frameCount = 3; }, /firstFrame must be 4/, 'overlapping chunks', false);
  bad(m => { m.chunks[0].frameCount = 0; }, /frameCount must be an integer from 1/, 'empty chunk', false);
  bad(m => { m.chunks[0].frameCount = 3; }, /byteLength must be/, 'chunk frame count and byte length disagree', false);
  bad(m => { m.chunks[1].byteLength += 1; }, /byteLength must be/, 'byte length not what the layout gives', false);
  bad(m => { m.chunks[1].frameCount = 3; }, /frameCount must be an integer from 1 to 2/, 'chunk past the last frame', false);
  bad(m => { m.budget.maxFrames = 5; }, /exceed the declared budget.maxFrames/, 'declared frame budget below actual', false);
  bad(m => { m.budget.maxBodies = 3; }, /declared budget.maxBodies/, 'declared body budget below actual', false);
  bad(m => { m.budget.maxBytes = 100; }, /declared budget.maxBytes/, 'declared byte budget below actual', false);
  bad(m => { m.budget.maxBytes = POSE_CACHE_HARD_LIMITS.maxTotalBytes + 1; }, /budget.maxBytes must be/, 'declared budget above the hard ceiling', false);
  bad(m => { m.budget = 5; }, /budget: expected an object/, 'budget not an object', false);
  bad(m => { m.provenance = 5; }, /provenance/, 'provenance not an object', false);
});

// ---- budgets before allocation ----------------------------------------------------------------------

/** Largest single typed-array / ArrayBuffer allocation (bytes) requested through the global constructors while `fn` runs. */
function maxAllocation(fn: () => void): number {
  const names = ['ArrayBuffer', 'Uint8Array', 'Uint32Array', 'Float32Array', 'Float64Array'];
  const g = globalThis as unknown as Record<string, any>, originals = names.map(n => g[n]);
  let max = 0;
  names.forEach((n, i) => {
    g[n] = new Proxy(originals[i], {
      construct(target, args) {
        if (typeof args[0] === 'number') max = Math.max(max, args[0] * (target.BYTES_PER_ELEMENT ?? 1));
        return Reflect.construct(target, args);
      },
    });
  });
  try { fn(); } finally { names.forEach((n, i) => { g[n] = originals[i]; }); }
  return max;
}

test('limits are validated and capped by hard ceilings', () => {
  assert.deepEqual(resolvePoseCacheLimits(), POSE_CACHE_DEFAULT_LIMITS);
  assert.equal(resolvePoseCacheLimits({ maxFrames: 10 }).maxFrames, 10);
  assert.equal(resolvePoseCacheLimits({ maxFrames: POSE_CACHE_HARD_LIMITS.maxFrames }).maxFrames, POSE_CACHE_HARD_LIMITS.maxFrames);
  for (const key of Object.keys(POSE_CACHE_HARD_LIMITS) as (keyof typeof POSE_CACHE_HARD_LIMITS)[]) {
    assert.ok(POSE_CACHE_DEFAULT_LIMITS[key] <= POSE_CACHE_HARD_LIMITS[key], key);
    for (const bad of [0, -1, 1.5, NaN, Infinity, '5', null, POSE_CACHE_HARD_LIMITS[key] + 1]) throwsWith(() => resolvePoseCacheLimits({ [key]: bad }), 'argument', /limits\./, `${key}=${String(bad)}`);
  }
  throwsWith(() => resolvePoseCacheLimits({ maxEverything: 1 } as never), 'argument', /unknown limit/);
  throwsWith(() => resolvePoseCacheLimits([] as never), 'argument', /plain object/);
  throwsWith(() => encodePoseCache(makeCache(), { limits: { maxFrames: 0 } }), 'argument');
  throwsWith(() => decodePoseCache('{}', [], { maxBodies: 2 ** 40 }), 'argument');
});

test('encode enforces body, frame, chunk and byte budgets', () => {
  const cache = makeCache();
  const enc = (options: object) => () => encodePoseCache(cache, options);
  throwsWith(enc({ limits: { maxFrames: 5 } }), 'budget', /6 frames exceed the limit of 5/);
  throwsWith(enc({ limits: { maxBodies: 3 } }), 'budget', /4 bodies exceed the limit of 3/);
  throwsWith(enc({ limits: { maxChunkBytes: FB } }), 'budget', /does not fit the chunk limit/, 'one frame is larger than a chunk may be');
  throwsWith(enc({ limits: { maxTotalBytes: CHUNK_HEADER_BYTES + FRAMES * FB - 1 } }), 'budget', /bytes exceed the limit/);
  throwsWith(enc({ limits: { maxManifestBytes: 100 } }), 'budget', /manifest is/);
  const twoFrames = { maxChunkBytes: CHUNK_HEADER_BYTES + 2 * FB };
  assert.equal(encodePoseCache(cache, { limits: twoFrames }).chunks.length, 3, 'chunks fill up to the chunk limit');
  throwsWith(enc({ limits: twoFrames, framesPerChunk: 3 }), 'argument', /framesPerChunk must be an integer from 1 to 2/);
  throwsWith(enc({ limits: { ...twoFrames, maxChunks: 2 } }), 'budget', /3 chunks exceed the limit of 2/);
  for (const framesPerChunk of [0, -1, 1.5, NaN, '2', 7]) throwsWith(enc({ framesPerChunk: framesPerChunk === 7 ? FRAMES + 1e6 : framesPerChunk }), 'argument', /framesPerChunk/, `per ${framesPerChunk}`);
  throwsWith(enc({ unknown: 1 }), 'argument', /unknown field/);
  throwsWith(() => encodePoseCache(cache, 5 as never), 'argument', /options/);
  // Declared maxima: not below the data, not above the ceilings; honoured by the reader
  const wide = encodePoseCache(cache, { budget: { maxBodies: 10, maxFrames: 100, maxBytes: 100000 } });
  assert.deepEqual(parsePoseCacheManifest(wide.manifest).budget, { maxBodies: 10, maxFrames: 100, maxBytes: 100000 });
  assert.deepEqual(summary(decodePoseCache(wide.manifest, wide.chunks)), summary(cache));
  throwsWith(enc({ budget: { maxFrames: 5 } }), 'argument', /budget.maxFrames/);
  throwsWith(enc({ budget: { maxBodies: 3 } }), 'argument', /budget.maxBodies/);
  throwsWith(enc({ budget: { maxBytes: 100 } }), 'argument', /budget.maxBytes/);
  throwsWith(enc({ budget: { maxBytes: POSE_CACHE_HARD_LIMITS.maxTotalBytes + 1 } }), 'argument', /budget.maxBytes/);
  throwsWith(enc({ budget: { maxFrames: 1.5 } }), 'argument');
  throwsWith(enc({ budget: { extra: 1 } }), 'argument', /unknown field/);
});

test('decode enforces the reader\'s limits on the manifest alone, before any chunk is read or array allocated', () => {
  const { manifest, chunks } = encodePoseCache(makeCache(), { framesPerChunk: 2 });
  const seen = (limits: object) => () => decodePoseCache(manifest, chunks, limits);
  throwsWith(seen({ maxFrames: 5 }), 'budget', /frames exceed/);
  throwsWith(seen({ maxBodies: 3 }), 'budget', /bodies exceed/);
  throwsWith(seen({ maxChunks: 2 }), 'budget', /chunks exceed/);
  throwsWith(seen({ maxChunkBytes: CHUNK_HEADER_BYTES + FB }), 'budget', /chunk limit/);
  throwsWith(seen({ maxTotalBytes: 2 * (CHUNK_HEADER_BYTES + 2 * FB) }), 'budget', /total more than/);
  throwsWith(seen({ maxManifestBytes: manifest.length - 1 }), 'budget', /manifest is/);
  decodePoseCache(manifest, chunks, { maxManifestBytes: manifest.length });
  throwsWith(() => recoverPoseCachePrefix(manifest, chunks, { maxFrames: 5 }), 'budget', undefined, 'recovery obeys the same limits');
  // A manifest claiming more than the default limits allows is refused without allocating anything large
  const hostile: [string, (m: any) => void, RegExp][] = [
    ['frames', m => { m.frameCount = POSE_CACHE_DEFAULT_LIMITS.maxFrames + 1; }, /frames exceed/],
    ['frames at the hard ceiling', m => { m.frameCount = POSE_CACHE_HARD_LIMITS.maxFrames; }, /frames exceed/],
    ['bodies', m => { m.bodies = Array.from({ length: POSE_CACHE_DEFAULT_LIMITS.maxBodies + 1 }, (_, i) => ({ ...m.bodies[0], id: i + 1 })); }, /bodies exceed/],
    ['chunks', m => { m.chunks = Array.from({ length: POSE_CACHE_DEFAULT_LIMITS.maxChunks + 1 }, (_, i) => ({ index: i, firstFrame: i, frameCount: 1, byteLength: 1 })); }, /chunks exceed/],
    ['chunk bytes', m => { m.chunks[0].byteLength = POSE_CACHE_DEFAULT_LIMITS.maxChunkBytes + 1; m.chunks[0].frameCount = 6; m.frameCount = 6; m.chunks.length = 1; }, /byteLength must be|chunk limit/],
  ];
  for (const [label, change, pattern] of hostile) {
    let text = '';
    const peak = maxAllocation(() => {
      try { decodePoseCache(edit(manifest, change), chunks); } catch (e) { text = e instanceof PoseCacheError ? e.message : String(e); }
    });
    assert.match(text, pattern, label);
    assert.ok(peak < 100_000, `${label}: largest allocation ${peak} bytes`);
  }
  // Oversized text is refused before JSON.parse
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => { parsed++; return parse(...args); }) as typeof JSON.parse;
  try { throwsWith(() => parsePoseCacheManifest('x'.repeat(POSE_CACHE_DEFAULT_LIMITS.maxManifestBytes + 1)), 'budget', /limit is/); assert.equal(parsed, 0); } finally { JSON.parse = parse; }
});

test('a large promise with little data allocates in proportion to the data, not the promise', () => {
  // 300 bodies × 1000 frames = 8.4 MB of chunk; keep a header and three frames of it
  const n = 300, f = 1000;
  const list: PoseCacheBody[] = Array.from({ length: n }, (_, i) => ({ id: i + 1, shape: 'sphere', size: [1, 1, 1], fixed: false, firstFrame: 0, endFrame: f }));
  const poses = new Float32Array(f * n * POSE_FLOATS);
  for (let i = 0; i < f * n; i++) poses[i * POSE_FLOATS + 6] = 1;
  const { manifest, chunks } = encodePoseCache({ cacheId: 7, dt: 0.01, bodies: list, steps: Uint32Array.from({ length: f }, (_, i) => i), poses });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0].length > 8_000_000);
  const cut = chunks[0].slice(0, CHUNK_HEADER_BYTES + 3 * poseFrameBytes(n) + 17);
  let result!: ReturnType<typeof recoverPoseCachePrefix>;
  const peak = maxAllocation(() => { result = recoverPoseCachePrefix(manifest, [cut]); });
  assert.equal(result.recoveredFrames, 3);
  assert.equal(result.complete, false);
  assert.ok(peak < 300_000, `largest allocation ${peak} bytes for a ${chunks[0].length}-byte promise`);
  const none = maxAllocation(() => { result = recoverPoseCachePrefix(manifest, []); });
  assert.equal(result.cache, null);
  assert.ok(none < 50_000, `no chunks: ${none} bytes`);
  const strict = maxAllocation(() => throwsWith(() => decodePoseCache(manifest, [cut]), 'chunk', /truncated after 3 of 1000 frames/));
  assert.ok(strict < 300_000, `strict decode of the truncated chunk: ${strict} bytes`);
});

// ---- chunk corruption, truncation ---------------------------------------------------------------

test('every truncation of a chunk is refused by decode and recovers exactly the whole verified frames before it', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache), full = chunks[0];
  for (let length = 0; length < full.length; length++) {
    const cut = [full.slice(0, length)];
    assert.throws(() => decodePoseCache(manifest, cut), PoseCacheError, `length ${length}`);
    const r = recoverPoseCachePrefix(manifest, cut);
    const want = length < CHUNK_HEADER_BYTES ? 0 : Math.floor((length - CHUNK_HEADER_BYTES) / FB);
    assert.equal(r.recoveredFrames, want, `length ${length}`);
    assert.equal(r.complete, false);
    assert.equal(r.declaredFrames, FRAMES);
    assert.ok(r.problem && r.problem.chunk === 0, `length ${length}`);
    if (want === 0) { assert.equal(r.cache, null); assert.deepEqual(r.omittedBodyIds, [1, 20, 9, 5]); } else {
      assert.deepEqual(summary(r.cache!), prefixOf(cache, want), `length ${length}`);
      assert.equal(r.cache!.termination, 'recovered');
      validatePoseCache(r.cache!);
    }
  }
  // The whole chunk is not a truncation
  const ok = recoverPoseCachePrefix(manifest, chunks);
  assert.equal(ok.complete, true);
  assert.equal(ok.problem, null);
  assert.deepEqual(ok.omittedBodyIds, []);
  assert.deepEqual(summary(ok.cache!), summary(decodePoseCache(manifest, chunks)), 'on an intact cache recovery is exactly decode');
  assert.equal(ok.cache!.termination, 'complete');
});

test('every single-byte corruption of a chunk is detected and recovery stops before the damaged frame', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache), full = chunks[0];
  for (let at = 0; at < full.length; at++) for (const flip of [0xff, 0x01, 0x80]) {
    const bad = full.slice(); bad[at] ^= flip;
    assert.throws(() => decodePoseCache(manifest, [bad]), PoseCacheError, `byte ${at} ^ ${flip}`);
    const r = recoverPoseCachePrefix(manifest, [bad]);
    const want = at < CHUNK_HEADER_BYTES ? 0 : Math.floor((at - CHUNK_HEADER_BYTES) / FB);
    assert.equal(r.complete, false, `byte ${at}`);
    assert.equal(r.recoveredFrames, want, `byte ${at} ^ ${flip}`);
    if (want > 0) assert.deepEqual(summary(r.cache!), prefixOf(cache, want), `byte ${at}`); else assert.equal(r.cache, null);
  }
});

test('frames that pass their checksum are still validated: values, lifetimes and step stamps', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache), chunk = chunks[0];
  const cases: [string, (v: DataView, at: number) => void, RegExp][] = [
    ['NaN position', (v, at) => v.setFloat32(slotAt(at, 0, 0), NaN, true), /position/],
    ['Infinity position', (v, at) => v.setFloat32(slotAt(at, 1, 1), Infinity, true), /position/],
    ['-Infinity position', (v, at) => v.setFloat32(slotAt(at, 1, 2), -Infinity, true), /position/],
    ['position beyond 1e6 m', (v, at) => v.setFloat32(slotAt(at, 0, 0), 1000001, true), /position/],
    ['float32 overflow bits (max float)', (v, at) => v.setFloat32(slotAt(at, 0, 1), 3.4028234663852886e38, true), /position/],
    ['NaN rotation', (v, at) => v.setFloat32(slotAt(at, 0, 4), NaN, true), /rotation must be finite/],
    ['Infinity rotation', (v, at) => v.setFloat32(slotAt(at, 0, 6), Infinity, true), /rotation must be finite/],
    ['zero quaternion on a live body', (v, at) => { for (let k = 3; k < 7; k++) v.setFloat32(slotAt(at, 1, k), 0, true); }, /unit quaternion/],
    ['quaternion of length 1.01', (v, at) => { v.setFloat32(slotAt(at, 0, 3), 0, true); v.setFloat32(slotAt(at, 0, 6), 1.01, true); }, /unit quaternion/],
    ['an all-zero live slot', (v, at) => { for (let k = 0; k < 7; k++) v.setFloat32(slotAt(at, 1, k), 0, true); }, /unit quaternion/],
    ['a dead slot (body 9, before its first frame) with data', (v, at) => v.setFloat32(slotAt(at, 2, 0), 1, true), /body 9: a slot outside its lifetime/],
    ['a dead slot with only a negative zero', (v, at) => v.setFloat32(slotAt(at, 2, 5), -0, true), /outside its lifetime/],
  ];
  // frame 1 is a frame where body 9 is not yet alive; bodies 1 and 20 are alive
  for (const [label, change, pattern] of cases) {
    const bad = patchFrame(chunk, 1, change);
    throwsWith(() => decodePoseCache(manifest, [bad]), 'data', pattern, label);
    const r = recoverPoseCachePrefix(manifest, [bad]);
    assert.equal(r.recoveredFrames, 1, label);
    assert.equal(r.problem!.code, 'data');
    assert.equal(r.problem!.frame, 1);
    assert.deepEqual(summary(r.cache!), prefixOf(cache, 1), label);
  }
  // A body that is alive per the manifest but whose slot is zero, and one that ended but still has data (frame 4, body 5)
  throwsWith(() => decodePoseCache(manifest, [patchFrame(chunk, 4, (v, at) => v.setFloat32(slotAt(at, 3, 1), 2, true))]), 'data', /body 5: a slot outside its lifetime/);
  // Step stamps: equal, going back, and the first frame's stamp is free
  const stepAt = (frame: number) => CHUNK_HEADER_BYTES + frame * FB;
  throwsWith(() => decodePoseCache(manifest, [patchFrame(chunk, 3, (v, at) => v.setUint32(at, 2, true))]), 'data', /steps must increase \(frame 3: 2 follows 2\)/);
  throwsWith(() => decodePoseCache(manifest, [patchFrame(chunk, 3, (v, at) => v.setUint32(at, 1, true))]), 'data', /steps must increase/);
  throwsWith(() => decodePoseCache(manifest, [patchFrame(chunk, 1, (v, at) => v.setUint32(at, 0xffffffff, true))]), 'data', /steps must increase \(frame 2/, 'a stamp at the u32 maximum leaves no room after it');
  assert.equal(new DataView(chunk.buffer).getUint32(stepAt(0), true), 0);
  const first = decodePoseCache(manifest, [patchFrame(chunk, 0, (v, at) => v.setUint32(at, 0, true))]);
  assert.deepEqual(Array.from(first.steps), [0, 1, 2, 4, 5, 8]);
});

test('chunk headers must match the manifest and the cache they belong to', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache, { framesPerChunk: 2 });
  const reseal = (chunk: Uint8Array, change: (v: DataView) => void) => { const c = chunk.slice(), v = new DataView(c.buffer); change(v); v.setUint32(32, crc32(c, 0, 32), true); return c; };
  const header = (index: number, change: (v: DataView) => void, pattern: RegExp, label: string) => {
    const list = copyAll(chunks); list[index] = reseal(list[index], change);
    throwsWith(() => decodePoseCache(manifest, list), 'chunk', pattern, label);
    const r = recoverPoseCachePrefix(manifest, list);
    assert.equal(r.recoveredFrames, 2 * index, label);
    assert.equal(r.problem!.chunk, index);
  };
  header(1, v => v.setUint32(12, 2, true), /header says chunk 2/, 'wrong chunk index');
  header(1, v => v.setUint32(16, 3, true), /first frame 3 differs/, 'wrong first frame');
  header(1, v => v.setUint32(20, 3, true), /3 frames differ/, 'wrong frame count');
  header(1, v => v.setUint32(24, 5, true), /5 bodies differ/, 'wrong body count');
  header(1, v => v.setUint32(28, 999, true), /payload size 999/, 'wrong payload size');
  header(1, v => v.setUint32(8, 0, true), /different cache/, 'body table checksum');
  header(2, v => v.setUint16(4, 2, true), /unsupported chunk revision 2/, 'unknown revision');
  header(0, v => v.setUint16(6, 40, true), /unexpected header size 40/, 'header size');
  const wrongMagic = copyAll(chunks); wrongMagic[0][0] = 0x50;
  throwsWith(() => decodePoseCache(manifest, wrongMagic), 'chunk', /bad magic/);
  // Chunks swapped, duplicated or from another cache
  throwsWith(() => decodePoseCache(manifest, [chunks[1], chunks[0], chunks[2]]), 'chunk', /header says chunk 1/);
  throwsWith(() => decodePoseCache(manifest, [chunks[0], chunks[0], chunks[2]]), 'chunk', /header says chunk 0/);
  assert.equal(recoverPoseCachePrefix(manifest, [chunks[0], chunks[0], chunks[2]]).recoveredFrames, 2);
  const other = makeCache(); other.bodies[0].size = [11, 1, 10];
  const otherEncoded = encodePoseCache(other, { framesPerChunk: 2 });
  throwsWith(() => decodePoseCache(manifest, [chunks[0], otherEncoded.chunks[1], chunks[2]]), 'chunk', /different cache/, 'a chunk from a cache with another body table');
  const otherDt = encodePoseCache({ ...makeCache(), dt: 0.5 }, { framesPerChunk: 2 });
  throwsWith(() => decodePoseCache(manifest, [otherDt.chunks[0], chunks[1], chunks[2]]), 'chunk', /different cache/, 'a chunk written at another dt');
  // Count mismatches between the chunk list and the manifest
  throwsWith(() => decodePoseCache(manifest, [...chunks, chunks[0]]), 'chunk', /4 chunks given; the manifest lists 3/);
  throwsWith(() => recoverPoseCachePrefix(manifest, [...chunks, chunks[0]]), 'chunk', /4 chunks given/, 'recovery will not guess which chunks to drop');
  throwsWith(() => decodePoseCache(manifest, chunks.slice(0, 2)), 'chunk', /chunk 2 of 3 is missing/);
  throwsWith(() => decodePoseCache(manifest, []), 'chunk', /chunk 0 of 3 is missing/);
  const extra = copyAll(chunks); extra[1] = Uint8Array.of(...extra[1], 0);
  throwsWith(() => decodePoseCache(manifest, extra), 'chunk', /1 unexpected bytes after its last frame/);
  const trailing = recoverPoseCachePrefix(manifest, extra);
  assert.equal(trailing.recoveredFrames, 4, 'the chunk with trailing bytes verified, but nothing after it is used');
  assert.equal(trailing.complete, false);
  assert.equal(trailing.problem!.chunk, 1);
  // Wrong container types
  throwsWith(() => decodePoseCache(manifest, 'chunks' as never), 'argument');
  throwsWith(() => decodePoseCache(manifest, [chunks[0].buffer as never, chunks[1], chunks[2]]), 'argument', /Uint8Array/);
  throwsWith(() => decodePoseCache(manifest, [Array.from(chunks[0]) as never, chunks[1], chunks[2]]), 'argument');
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new Uint8Array(new SharedArrayBuffer(chunks[0].length)); shared.set(chunks[0]);
    throwsWith(() => decodePoseCache(manifest, [shared, chunks[1], chunks[2]]), 'argument', /ordinary ArrayBuffer/, 'bytes another thread could change under the reader');
  }
});

test('recovery: a prefix of whole chunks, bodies not yet born are omitted, lifetimes are clipped, the damage is reported', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache, { framesPerChunk: 2 });
  // Drop the last chunk
  let r = recoverPoseCachePrefix(manifest, chunks.slice(0, 2));
  assert.equal(r.complete, false);
  assert.equal(r.recoveredFrames, 4);
  assert.match(r.problem!.reason, /chunk 2 of 3 is missing/);
  assert.deepEqual(summary(r.cache!), prefixOf(cache, 4));
  assert.deepEqual(r.cache!.bodies.map(b => [b.id, b.firstFrame, b.endFrame]), [[1, 0, 4], [20, 0, 4], [9, 2, 4], [5, 0, 4]], 'lifetimes clipped to the prefix');
  assert.equal(r.cache!.termination, 'recovered');
  // Keep one chunk: body 9 (born at frame 2) is not in the prefix
  r = recoverPoseCachePrefix(manifest, chunks.slice(0, 1));
  assert.equal(r.recoveredFrames, 2);
  assert.deepEqual(r.omittedBodyIds, [9]);
  assert.deepEqual(r.cache!.bodies.map(b => b.id), [1, 20, 5]);
  assert.deepEqual(summary(r.cache!), prefixOf(cache, 2));
  assert.equal(r.cache!.poses.length, 2 * 3 * POSE_FLOATS, 'slots repacked: no room kept for an omitted body');
  // A middle chunk damaged: later chunks are not used even though they are intact
  const damaged = copyAll(chunks); damaged[1][CHUNK_HEADER_BYTES + 10] ^= 0xff;
  r = recoverPoseCachePrefix(manifest, damaged);
  assert.equal(r.recoveredFrames, 2);
  assert.deepEqual(r.problem, { chunk: 1, frame: 2, code: 'data', reason: 'frame 2: checksum mismatch (corrupt data)' });
  // A last chunk cut anywhere keeps the whole frames of it
  for (let length = 0; length < chunks[2].length; length++) {
    const cut = [chunks[0], chunks[1], chunks[2].slice(0, length)];
    r = recoverPoseCachePrefix(manifest, cut);
    const want = 4 + (length < CHUNK_HEADER_BYTES ? 0 : Math.floor((length - CHUNK_HEADER_BYTES) / FB));
    assert.equal(r.recoveredFrames, want, `length ${length}`);
    assert.deepEqual(summary(r.cache!), prefixOf(cache, want), `length ${length}`);
    assert.throws(() => decodePoseCache(manifest, cut), PoseCacheError);
  }
  // A recovered cache is an ordinary valid cache: it validates, samples, and re-encodes to a file that decodes strictly
  const rec = recoverPoseCachePrefix(manifest, chunks.slice(0, 2)).cache!;
  validatePoseCache(rec);
  const again = encodePoseCache(rec);
  const strict = decodePoseCache(again.manifest, again.chunks);
  assert.deepEqual(summary(strict), summary(rec));
  assert.equal(strict.termination, 'recovered', 'the re-encoded file says it came from a recovery');
  // Without an authoritative manifest there is nothing to recover
  throwsWith(() => recoverPoseCachePrefix(manifest.slice(0, manifest.length - 10), chunks), 'manifest', /not valid JSON/);
  throwsWith(() => recoverPoseCachePrefix(edit(manifest, m => { m.bodies[0].size[0] = 3; }), chunks), 'manifest', /bodyTableCrc32/);
  throwsWith(() => recoverPoseCachePrefix('', chunks), 'manifest');
  // A cancelled bake's manifest is honest about it and still decodes strictly
  const cancelled = encodePoseCache({ ...makeCache(), termination: 'cancelled' });
  assert.equal(decodePoseCache(cancelled.manifest, cancelled.chunks).termination, 'cancelled');
  assert.equal(recoverPoseCachePrefix(cancelled.manifest, cancelled.chunks).cache!.termination, 'cancelled');
});

// ---- encode input validation ----------------------------------------------------------------------

test('encode refuses invalid caches before writing anything', () => {
  const fresh = (): PoseCache => makeCache();
  const bad = (change: (c: PoseCache) => void, pattern: RegExp, label: string, code: PoseCacheErrorCode = 'data') => {
    const c = fresh(); change(c);
    throwsWith(() => encodePoseCache(c), code, pattern, label);
    throwsWith(() => validatePoseCache(c), code, pattern, `validate: ${label}`);
  };
  const slot = (frame: number, body: number, k = 0) => (frame * N + body) * POSE_FLOATS + k;
  bad(c => { c.poses[slot(2, 0, 0)] = NaN; }, /frame 2, body 1: position/, 'NaN position');
  bad(c => { c.poses[slot(2, 1, 1)] = Infinity; }, /frame 2, body 20: position/, 'Infinity position');
  bad(c => { c.poses[slot(0, 0, 2)] = -1000001; }, /position/, 'position past the ceiling');
  bad(c => { c.poses[slot(0, 0, 0)] = 3e38; }, /position/, 'huge float32');
  bad(c => { c.poses[slot(1, 1, 3)] = NaN; }, /rotation must be finite/, 'NaN quaternion');
  bad(c => { c.poses.fill(0, slot(1, 1, 3), slot(1, 1, 7)); }, /unit quaternion/, 'zero quaternion');
  bad(c => { c.poses[slot(1, 1, 6)] = 1.01; }, /unit quaternion/, 'quaternion length 1.01');
  bad(c => { c.poses[slot(1, 1, 3)] = 1e20; }, /unit quaternion/, 'huge quaternion');
  bad(c => { c.poses[slot(0, 2, 0)] = 1; }, /body 9: a slot outside its lifetime/, 'data in a slot before the body exists');
  bad(c => { c.poses[slot(5, 3, 4)] = 0.5; }, /body 5: a slot outside its lifetime/, 'data in a slot after the body ended');
  bad(c => { c.poses[slot(0, 2, 6)] = -0; }, /outside its lifetime/, 'negative zero is not canonical empty');
  bad(c => { c.steps[3] = 2; }, /steps must increase \(frame 3: 2 follows 2\)/, 'equal stamps');
  bad(c => { c.steps[3] = 1; }, /steps must increase/, 'stamps going back');
  bad(c => { c.dt = NaN; }, /dt must be/, 'NaN dt');
  bad(c => { c.dt = 0; }, /dt must be/, 'zero dt');
  bad(c => { c.dt = 1.5; }, /dt must be/, 'dt above one second');
  bad(c => { c.dt = Infinity; }, /dt must be/, 'infinite dt');
  bad(c => { c.steps = new Uint32Array(0); c.poses = new Float32Array(0); }, /at least one frame/, 'no frames');
  bad(c => { c.poses = c.poses.slice(0, c.poses.length - 1); }, /poses must hold/, 'one number short');
  bad(c => { c.poses = new Float32Array(c.poses.length + 7); }, /poses must hold/, 'one slot too many');
  bad(c => { c.bodies = []; }, /bodies must be a non-empty list/, 'no bodies');
  bad(c => { (c.bodies as PoseCacheBody[])[1].id = 1; }, /duplicate id 1/, 'duplicate ids');
  bad(c => { (c.bodies as PoseCacheBody[])[2].endFrame = 9; }, /endFrame/, 'lifetime past the end');
  bad(c => { (c.bodies as PoseCacheBody[])[0].shape = 'capsule' as never; }, /nothing else is cached yet/, 'unsupported shape');
  bad(c => { (c.bodies[0] as unknown as Record<string, unknown>).mass = 1; }, /unknown field "mass"/, 'unknown body field');
  bad(c => { (c as unknown as Record<string, unknown>).velocities = new Float32Array(1); }, /unknown field "velocities"/, 'unknown cache field', 'argument');
  bad(c => { c.poses = new Float64Array(c.poses) as never; }, /Float32Array/, 'float64 poses would be silently rounded', 'argument');
  bad(c => { c.poses = Array.from(c.poses) as never; }, /Float32Array/, 'plain array poses', 'argument');
  bad(c => { c.steps = Array.from(c.steps) as never; }, /Uint32Array/, 'plain array steps', 'argument');
  bad(c => { c.steps = new Int32Array(c.steps) as never; }, /Uint32Array/, 'signed steps', 'argument');
  if (typeof SharedArrayBuffer !== 'undefined') bad(c => { const s = new Float32Array(new SharedArrayBuffer(c.poses.byteLength)); s.set(c.poses); c.poses = s; }, /ordinary ArrayBuffer/, 'memory another thread can change during validation', 'argument');
  class Cache { dt = DT; }
  throwsWith(() => encodePoseCache(new Cache() as never), 'argument', /plain object/, 'class instance');
  throwsWith(() => encodePoseCache(Object.create(makeCache()) as never), 'argument', /plain object/, 'inherited fields');
  for (const v of [null, undefined, 5, 'x', []]) throwsWith(() => encodePoseCache(v as never), 'argument', /plain object/, String(v));
  // Fixed bodies are allowed to be anything valid; sizes follow the example's ceilings
  bad(c => { (c.bodies as PoseCacheBody[])[0].size = [1001, 1, 1]; }, /size must be three numbers/, 'size above 1000 m');
  bad(c => { (c.bodies as PoseCacheBody[])[0].size = [NaN, 1, 1]; }, /size must be/, 'NaN size');
  bad(c => { (c.bodies as PoseCacheBody[])[1].size = [1, 1, 2]; }, /sphere's size/, 'non-uniform sphere');
  // A frame count over the 32-bit stamp domain cannot be expressed: a 1-frame cache with the maximum stamp is fine
  const maxStamp = encodePoseCache({ cacheId: 7, dt: 1, bodies: [{ id: 1, shape: 'box', size: [1, 1, 1], fixed: true, firstFrame: 0, endFrame: 1 }], steps: Uint32Array.of(0xffffffff), poses: Float32Array.of(0, 0, 0, 0, 0, 0, 1) });
  assert.deepEqual(Array.from(decodePoseCache(maxStamp.manifest, maxStamp.chunks).steps), [0xffffffff]);
});

// ---- ownership ---------------------------------------------------------------------------------

test('encode neither retains nor modifies its input; decode neither retains nor modifies its input', () => {
  const cache = makeCache(), before = { s: summary(cache), bodies: JSON.stringify(cache.bodies), dt: cache.dt };
  const { manifest, chunks } = encodePoseCache(cache);
  assert.deepEqual(summary(cache), before.s);
  assert.equal(JSON.stringify(cache.bodies), before.bodies);
  const snapshot = chunks.map(c => Array.from(c));
  // Changing the input afterwards changes nothing already encoded
  cache.poses.fill(0); cache.steps.fill(0); (cache.bodies as PoseCacheBody[]).length = 0;
  assert.deepEqual(chunks.map(c => Array.from(c)), snapshot);
  // Outputs are separate, tightly sized, zero-offset buffers
  assert.equal(new Set(chunks.map(c => c.buffer)).size, chunks.length);
  encodePoseCache(makeCache(), { framesPerChunk: 2 }).chunks.forEach(c => { assert.equal(c.byteOffset, 0); assert.equal(c.buffer.byteLength, c.length); assert.ok(c.buffer instanceof ArrayBuffer); });
  const manifestBefore = manifest, input = copyAll(chunks), inputSnapshot = input.map(c => Array.from(c));
  const decoded = decodePoseCache(manifest, input);
  assert.deepEqual(input.map(c => Array.from(c)), inputSnapshot, 'decode left its input alone');
  assert.equal(manifest, manifestBefore);
  // Decoded arrays do not share memory with the chunks, with each other, or with a second decode
  for (const c of input) assert.notEqual(decoded.poses.buffer, c.buffer);
  assert.notEqual(decoded.poses.buffer, decoded.steps.buffer);
  const want = summary(decoded);
  input.forEach(c => c.fill(0xee));
  assert.deepEqual(summary(decoded), want, 'overwriting the chunks after decoding does not change the cache');
  const second = decodePoseCache(manifest, chunks);
  decoded.poses.fill(7); decoded.steps.fill(7); decoded.bodies[0].size[0] = 99; (decoded.bodies as PoseCacheBody[])[0].id = 42;
  assert.equal(second.bodies[0].size[0], 10);
  assert.equal(second.bodies[0].id, 1);
  assert.deepEqual(summary(second).bits, bits(makeCache().poses));
  const third = decodePoseCache(manifest, chunks);
  assert.deepEqual(summary(third), summary(makeCache()), 'the encoded bytes are unchanged by all of that');
  // Recovery copies as well
  const rec = recoverPoseCachePrefix(manifest, chunks);
  chunks[0].fill(0);
  assert.deepEqual(summary(rec.cache!), summary(makeCache()));
  // decodePoseCache returns plain bodies: the manifest's own object is not exposed for mutation
  const parsed = parsePoseCacheManifest(manifest);
  const body = decodePoseCache(manifest, encodePoseCache(makeCache()).chunks).bodies[0];
  body.size[1] = 123;
  assert.equal(parsed.bodies[0].size[1], 1);
});

test('chunks that are views into larger or unaligned buffers decode correctly', () => {
  const cache = makeCache(), { manifest, chunks } = encodePoseCache(cache, { framesPerChunk: 4 });
  const arena = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0) + 64).fill(0xab), views: Uint8Array[] = [];
  let at = 3;
  for (const c of chunks) { arena.set(c, at); views.push(arena.subarray(at, at + c.length)); at += c.length + 5; }
  assert.ok(views.some(v => v.byteOffset % 4 !== 0), 'at least one chunk starts at an unaligned offset');
  assert.deepEqual(summary(decodePoseCache(manifest, views)), summary(cache));
  assert.deepEqual(summary(recoverPoseCachePrefix(manifest, views).cache!), summary(cache));
});

// ---- sampling ------------------------------------------------------------------------------------

function sampled(cache: PoseCache, time: number, out: Float32Array | Float64Array = new Float64Array(cache.bodies.length * POSE_FLOATS)) {
  const alive = new Uint8Array(cache.bodies.length);
  samplePoseCache(cache, time, out, alive);
  return { out, alive: Array.from(alive) };
}
const frameSlot = (cache: PoseCache, frame: number, slot: number) => Array.from(cache.poses.subarray((frame * cache.bodies.length + slot) * POSE_FLOATS, (frame * cache.bodies.length + slot + 1) * POSE_FLOATS));

test('sampling: frame times give the frame exactly; between frames positions are linear; times are clamped', () => {
  const cache = decodePoseCache(...(({ manifest, chunks }) => [manifest, chunks] as const)(encodePoseCache(makeCache())));
  const times = [0, 0.25, 0.5, 1, 1.25, 2];
  times.forEach((t, f) => {
    const { out, alive } = sampled(cache, t);
    const wantAlive = cache.bodies.map(b => (f >= b.firstFrame && f < b.endFrame ? 1 : 0));
    assert.deepEqual(alive, wantAlive, `alive at frame ${f}`);
    cache.bodies.forEach((_, i) => assert.deepEqual(Array.from(out.subarray(i * POSE_FLOATS, (i + 1) * POSE_FLOATS)), wantAlive[i] ? frameSlot(cache, f, i) : [0, 0, 0, 0, 0, 0, 0], `frame ${f} slot ${i}`));
  });
  // Half way between frames 2 and 3 (0.5 s and 1 s): every body is alive in both
  let { out, alive } = sampled(cache, 0.75);
  assert.deepEqual(alive, [1, 1, 1, 1]);
  for (let i = 0; i < N; i++) for (let k = 0; k < 3; k++) {
    const a = frameSlot(cache, 2, i)[k], b = frameSlot(cache, 3, i)[k];
    assert.equal(out[i * POSE_FLOATS + k], a + (b - a) * 0.5, `slot ${i} axis ${k}`);
  }
  ({ out } = sampled(cache, 0.625)); // a quarter of the way: the stamps 2 → 4 are one frame interval of 0.5 s
  assert.equal(out[1], frameSlot(cache, 2, 0)[1] + (frameSlot(cache, 3, 0)[1] - frameSlot(cache, 2, 0)[1]) * 0.25);
  // Out of range clamps; the result is that end frame exactly
  assert.deepEqual(sampled(cache, 99).alive, [1, 1, 1, 0]);
  assert.deepEqual(Array.from(sampled(cache, 99).out.subarray(0, 7)), frameSlot(cache, 5, 0));
  assert.deepEqual(Array.from(sampled(cache, -5).out.subarray(0, 7)), frameSlot(cache, 0, 0));
  assert.deepEqual(sampled(cache, Number.MAX_VALUE).alive, [1, 1, 1, 0]);
  // Float32 output works and rounds only at the end
  const f32 = sampled(cache, 0.75, new Float32Array(N * POSE_FLOATS));
  assert.equal(f32.out[0], Math.fround((frameSlot(cache, 2, 0)[0] + frameSlot(cache, 3, 0)[0]) / 2));
  for (const t of [NaN, Infinity, -Infinity]) assert.throws(() => sampled(cache, t), RangeError);
  assert.throws(() => samplePoseCache(cache, 0, new Float64Array(3), new Uint8Array(N)), RangeError);
  assert.throws(() => samplePoseCache(cache, 0, new Float64Array(N * 7), new Uint8Array(N - 1)), RangeError);
  assert.throws(() => samplePoseCache({ ...cache, poses: cache.poses.slice(1) }, 0, new Float64Array(N * 7), new Uint8Array(N)), RangeError);
  for (let t = -0.1; t < 2.2; t += 0.0371) { const s = sampled(cache, t); assert.ok(s.out.every(Number.isFinite), `t ${t}`); }
});

test('sampling follows step stamps, not frame indices, and a single frame holds', () => {
  const cache = makeCache(); // stamps 0 1 2 4 5 8 at dt 0.25: the 2→4 gap is 0.5 s, the 5→8 gap is 0.75 s
  // 1.5 s sits between frame 4 (1.25 s) and frame 5 (2 s): a third of the way, in time
  const { out } = sampled(cache, 1.5);
  const a = frameSlot(cache, 4, 1)[0], b = frameSlot(cache, 5, 1)[0];
  assert.ok(Math.abs(out[POSE_FLOATS] - (a + (b - a) / 3)) < 1e-12);
  const one = { cacheId: 7, dt: 0.5, termination: 'complete' as const, provenance: null, bodies: [{ id: 3, shape: 'box' as const, size: [1, 1, 1] as [number, number, number], fixed: false, firstFrame: 0, endFrame: 1 }], steps: Uint32Array.of(7), poses: Float32Array.of(1, 2, 3, 0, 0, 0, 1) };
  validatePoseCache(one);
  assert.equal(poseCacheDuration(one), 0);
  for (const t of [-1, 0, 0.3, 100]) { const s = sampled(one, t); assert.deepEqual(s.alive, [1]); assert.deepEqual(Array.from(s.out), [1, 2, 3, 0, 0, 0, 1]); }
});

test('sampling lifetimes: a body is present between frames only if alive in both, never extrapolated or held', () => {
  const cache = makeCache(); // body 9 (slot 2) alive from frame 2 (0.5 s); body 5 (slot 3) alive through frame 3 (1 s), dead from frame 4 (1.25 s)
  const at = (t: number) => sampled(cache, t);
  // Born: absent before its first frame, including between frames 1 and 2, present at it
  assert.deepEqual(at(0.25).alive, [1, 1, 0, 1]);
  assert.deepEqual(at(0.375).alive, [1, 1, 0, 1], 'between frames 1 and 2 the newborn is not blended with nothing');
  assert.deepEqual(Array.from(at(0.375).out.subarray(2 * POSE_FLOATS, 3 * POSE_FLOATS)), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(at(0.5).alive, [1, 1, 1, 1]);
  assert.deepEqual(frameSlot(cache, 2, 2), Array.from(at(0.5).out.subarray(2 * POSE_FLOATS, 3 * POSE_FLOATS)));
  assert.deepEqual(at(0.5000001).alive, [1, 1, 1, 1], 'once both neighbours have it, it blends');
  // Ended: alive at its last frame, absent in the interval after it (frames 3 → 4), absent at frame 4
  assert.deepEqual(at(1).alive, [1, 1, 1, 1]);
  assert.deepEqual(at(1.1).alive, [1, 1, 1, 0]);
  assert.deepEqual(at(1.25).alive, [1, 1, 1, 0]);
  assert.deepEqual(Array.from(at(1.1).out.subarray(3 * POSE_FLOATS, 4 * POSE_FLOATS)), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(at(1.9).alive, [1, 1, 1, 0]);
  // The fixed floor and the always-alive sphere never drop out
  for (let t = 0; t <= 2; t += 0.01) assert.deepEqual(at(t).alive.slice(0, 2), [1, 1]);
});

test('sampling rotations: shortest arc, unit length, q and -q are one rotation', () => {
  const body = { id: 1, shape: 'box' as const, size: [1, 1, 1] as [number, number, number], fixed: false, firstFrame: 0, endFrame: 2 };
  const two = (q0: number[], q1: number[]): PoseCacheInput => ({ cacheId: 7, dt: 0.5, bodies: [body], steps: Uint32Array.of(0, 1), poses: Float32Array.of(0, 0, 0, ...q0, 0, 0, 0, ...q1) });
  const s = Math.SQRT1_2, qOf = (c: PoseCacheInput, t: number) => Array.from(sampled(c as PoseCache, t).out.subarray(3, 7));
  const quarter = two([0, 0, 0, 1], [0, s, 0, s]);
  const half = qOf(quarter, 0.25), eighth = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  half.forEach((v, i) => assert.ok(Math.abs(v - eighth[i]) < 0.02, `component ${i}: ${v}`));
  assert.ok(Math.abs(Math.hypot(...half) - 1) < 1e-12);
  // q and -q are the same rotation: no collapse through zero, and the blend stays on the short side
  const flipped = qOf(two([0, 0, 0, 1], [0, 0, 0, -1]), 0.25);
  assert.ok(Math.abs(Math.hypot(...flipped) - 1) < 1e-12);
  assert.ok(Math.abs(Math.abs(flipped[3]) - 1) < 1e-12);
  const viaNegative = qOf(two([0, 0, 0, 1], [0, -s, 0, -s]), 0.25);
  viaNegative.forEach((v, i) => assert.ok(Math.abs(v - eighth[i]) < 0.02, `negated target, component ${i}: ${v}`));
  // 180° apart (orthogonal quaternions): finite and unit
  const opposite = qOf(two([0, 0, 0, 1], [1, 0, 0, 0]), 0.25);
  assert.ok(opposite.every(Number.isFinite) && Math.abs(Math.hypot(...opposite) - 1) < 1e-12);
  // Endpoints are the stored float32 values exactly, including a stored -q
  assert.deepEqual(qOf(two([0, 0, 0, 1], [0, 0, 0, -1]), 0.5), [0, 0, 0, -1]);
  for (let t = 0; t <= 0.5; t += 0.013) assert.ok(Math.abs(Math.hypot(...qOf(quarter, t)) - 1) < 1e-9);
});

// ---- cross-format and example ---------------------------------------------------------------------

test('the example-local pose-track schema and the cache manifest refuse each other and stay separate', () => {
  const track = { schema: POSE_TRACK_SCHEMA, units: { ...POSE_TRACK_UNITS }, dt: 0.5, bodies: [{ id: 1, shape: 'box', size: [1, 1, 1], fixed: true }], frames: [{ step: 0, poses: [[0, 0, 0, 0, 0, 0, 1]] }] };
  const trackText = JSON.stringify(track);
  assert.equal(parsePoseTrack(trackText).bodies.length, 1, 'the example still reads its own schema through its own code');
  throwsWith(() => parsePoseCacheManifest(trackText), 'schema', /Not a pose cache manifest/);
  throwsWith(() => decodePoseCache(trackText, []), 'schema');
  throwsWith(() => recoverPoseCachePrefix(trackText, []), 'schema');
  const { manifest } = encodePoseCache(makeCache());
  assert.throws(() => parsePoseTrack(manifest), (e: unknown) => e instanceof PoseTrackError && /Not a pose track/.test(e.message));
  assert.notEqual(POSE_CACHE_SCHEMA, POSE_TRACK_SCHEMA);
  assert.match(POSE_CACHE_SCHEMA, /v0-draft$/, 'the schema name says it is a draft');
});


test('review regression: a prefix before the first body is born returns no invalid zero-body cache', () => {
  const input = { ...makeCache(), bodies: [{ id: 1, shape: 'box' as const, size: [1, 1, 1] as [number, number, number], fixed: false, firstFrame: 1, endFrame: 2 }], steps: Uint32Array.of(0, 1), poses: Float32Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1) };
  const encoded = encodePoseCache(input, { framesPerChunk: 1 });
  const recovered = recoverPoseCachePrefix(encoded.manifest, encoded.chunks.slice(0, 1));
  assert.equal(recovered.complete, false);
  assert.equal(recovered.recoveredFrames, 1);
  assert.deepEqual(recovered.omittedBodyIds, [1]);
  assert.equal(recovered.cache, null);
});

test('review regression: format and value constants cannot be mutated to admit nonfinite data', () => {
  assert.equal(Object.isFrozen(POSE_CACHE_VALUE_LIMITS), true);
  assert.equal(Object.isFrozen(POSE_CACHE_CONVENTIONS), true);
  assert.equal(Reflect.set(POSE_CACHE_VALUE_LIMITS, 'maxCoordinate', Infinity), false);
  assert.equal(Reflect.set(POSE_CACHE_CONVENTIONS, 'up', '+z'), false);
  const input = makeCache(); input.poses[0] = Infinity;
  throwsWith(() => encodePoseCache(input), 'data', /finite/);
});


test('review regression: caller bake identity and header-bound frame checksums refuse mixed or torn caches', () => {
  const a = makeCache(), b = makeCache(); b.cacheId = a.cacheId + 1;
  for (let f = 0; f < FRAMES; f++) b.poses[(f * N + 1) * POSE_FLOATS] += 1;
  const aa = encodePoseCache(a, { framesPerChunk: 2 }), bb = encodePoseCache(b, { framesPerChunk: 2 });
  throwsWith(() => decodePoseCache(aa.manifest, [aa.chunks[0], bb.chunks[1], aa.chunks[2]]), 'chunk', /different cache/);
  const mixed = recoverPoseCachePrefix(aa.manifest, [aa.chunks[0], bb.chunks[1], aa.chunks[2]]);
  assert.equal(mixed.complete, false); assert.equal(mixed.recoveredFrames, 2);
  assert.equal(mixed.cache?.cacheId, a.cacheId); validatePoseCache(mixed.cache);
  // New bake's header and first 3 frames, followed by stale frames from the prior bake.
  const oneA = encodePoseCache(a), oneB = encodePoseCache(b), torn = oneB.chunks[0].slice();
  const cut = CHUNK_HEADER_BYTES + 3 * FB; torn.set(oneA.chunks[0].subarray(cut), cut);
  throwsWith(() => decodePoseCache(oneB.manifest, [torn]), 'data', /checksum/);
  const prefix = recoverPoseCachePrefix(oneB.manifest, [torn]);
  assert.equal(prefix.complete, false); assert.equal(prefix.recoveredFrames, 3); validatePoseCache(prefix.cache);
  // Right bake, wrong chunk's frames: monotonically increasing steps alone are insufficient.
  const splice = aa.chunks[1].slice(); splice.set(aa.chunks[2].subarray(CHUNK_HEADER_BYTES), CHUNK_HEADER_BYTES);
  const chunkPrefix = recoverPoseCachePrefix(aa.manifest, [aa.chunks[0], splice]);
  assert.equal(chunkPrefix.complete, false); assert.equal(chunkPrefix.recoveredFrames, 2);
  assert.deepEqual(Array.from(chunkPrefix.cache!.steps), [0, 1]);
  assert.match(chunkPrefix.problem!.reason, /checksum/);
});

test('review regression: cache identity is required and running CRC binds frame payload to its header', () => {
  const input = makeCache();
  for (const cacheId of [undefined, -1, 2 ** 32, 1.5, NaN, Infinity, '7']) {
    throwsWith(() => encodePoseCache({ ...input, cacheId } as unknown as PoseCacheInput), 'data', /cacheId/);
  }
  for (const cacheId of [0, 0xffffffff]) {
    const encoded = encodePoseCache({ ...input, cacheId });
    assert.equal(decodePoseCache(encoded.manifest, encoded.chunks).cacheId, cacheId);
    throwsWith(() => parsePoseCacheManifest(edit(encoded.manifest, m => { delete m.cacheId; })), 'manifest', /cacheId/);
  }
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes, 4, bytes.length, crc32(bytes, 0, 4)), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(), 0, 0, 0xcbf43926), 0xcbf43926);
});


test('review regression: in-memory validation refuses impossible byte/chunk budgets before scanning poses', () => {
  const input = makeCache();
  throwsWith(() => validatePoseCache(input, { maxTotalBytes: 100 }), 'budget', /bytes/);
  throwsWith(() => validatePoseCache(input, { maxChunkBytes: CHUNK_HEADER_BYTES + FB - 1 }), 'budget', /frame/);
  throwsWith(() => validatePoseCache(input, { maxChunkBytes: CHUNK_HEADER_BYTES + 2 * FB, maxChunks: 1 }), 'budget', /chunks/);
  input.poses[0] = NaN;
  throwsWith(() => encodePoseCache(input, { limits: { maxTotalBytes: 100 } }), 'budget', /bytes/);
});
