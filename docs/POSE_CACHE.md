# Pose cache (experimental draft)

**Status: draft schema `three-avbd.pose-cache/v0-draft`, STE-3349 (roadmap B1, AD-8).** Internal module
`src/bake/pose-cache.ts`, covered by `tests/pose-cache.test.ts`. It is **not** a supported package format: there is no
package export, nothing writes it yet (the recorder is B2), and the layout may still change without a migration. It is
not a World snapshot, checkpoint, replay or interchange file (no glTF/DCC, no velocities, joints, contacts or events).
Initial draft source: `0b48ebf`; lead-reviewed integration base: `8d77623`,2026-11-10, plus the draft-only files. No package export or user-file migration.

The example-local `examples/pose-track.ts` (`three-avbd.example.pose-track/v0-provisional`, JSON, ≤ 300 steps) is
untouched. It keeps reading and writing its own schema through its own code. The two parsers refuse each other's files
by schema, and nothing is migrated implicitly.

## What a cache is

One **manifest** (UTF-8 JSON text) plus one or more **chunks** (little-endian binary). Caller code decides where the
bytes live (files, memory, network); the module takes strings and `Uint8Array`s.

Conventions, written into every manifest and required to match exactly: metres, seconds, right-handed, +y up,
position `x y z` then unit quaternion `x y z w`, little-endian, float32.

Shapes: `box` and `sphere` only (a sphere's `size` is its diameter on all three axes). Anything else is refused
explicitly, on encode and on read.

## API (internal, proposal pending lead review)

| Function | Purpose |
|---|---|
| `encodePoseCache(cache, { framesPerChunk?, limits?, budget? })` → `{ manifest, chunks }` | validate everything, then allocate and write |
| `decodePoseCache(manifest, chunks, limits?)` → `PoseCache` | strict: any deviation throws `PoseCacheError` |
| `recoverPoseCachePrefix(manifest, chunks, limits?)` → `PoseCacheRecovery` | verified prefix only, always says what was lost |
| `validatePoseCache(cache, limits?)` | throws unless the in-memory cache is consistent and in budget |
| `parsePoseCacheManifest(text, limits?)` | the manifest alone |
| `samplePoseCache(cache, time, out, alive)` / `poseCacheDuration(cache)` | playback sampling, allocation-free |
| `resolvePoseCacheLimits`, `crc32`, `poseBodyTableCrc32(dt, bodies, cacheId)` | limits, checksums (exported for tests and tools) |

`PoseCache` = `{ cacheId, dt, termination, bodies, steps: Uint32Array, poses: Float32Array, provenance }`, frame-major
`poses[((frame * bodies.length) + slot) * 7 + k]`.

## Manifest

Canonical text only: compact JSON, this key order, no whitespace, no duplicate keys, JS number spelling. A reader
re-serializes what it validated and refuses any text that differs, so duplicate-key, key-order and number-spelling
ambiguity cannot exist, and unknown or `__proto__`-style fields are refused by a closed key list.

| Field | Meaning |
|---|---|
| `schema` | `three-avbd.pose-cache/v0-draft` |
| `conventions` | the eight fixed strings above |
| `cacheId` | Required caller-assigned u32, unique per bake within its collection; not authentication |
| `termination` | `complete`, `cancelled`, `budget` or `recovered` (informational and honest; a recovered cache re-encodes as `recovered`) |
| `dt` | seconds per simulation step, `0 < dt ≤ 1` |
| `bodyTableCrc32` | CRC-32 of `cacheId`, `dt` and every body's id, shape, fixed flag and size (lifetimes excluded), also written in every chunk header |
| `bodies[]` | `id`, `shape`, `size`, `fixed`, `firstFrame`, `endFrame` (slot order = array order) |
| `frameCount` | total frames |
| `chunks[]` | `index`, `firstFrame`, `frameCount`, `byteLength` (recomputed and checked) |
| `budget` | declared maxima `maxBodies`, `maxFrames`, `maxBytes` (chunk bytes); the data may not exceed them |
| `provenance` | optional flat record: ≤ 32 entries, ASCII keys, printable-ASCII strings ≤ 256, finite numbers, booleans, null |

The sample rate is not stored: it is implied by `dt` and the per-frame step stamps, and a second copy could disagree
(AD-8 listed one; see open decisions).

## Chunk layout (revision 1)

Header, 36 bytes, all little-endian: `"TAPC"`, u16 revision (1), u16 header bytes (36), u32 `bodyTableCrc32`, u32 chunk
index, u32 first frame, u32 frame count, u32 body count, u32 payload bytes, u32 CRC-32 of header bytes 0–31.

Then `frameCount` frame records of `8 + 28 * bodies` bytes: u32 step stamp, `bodies` slots of 7 float32, u32 CRC-32 of
the step and slots. One frame record is the smallest unit that can be checked on its own. A chunk is exactly
`36 + frameCount * frameBytes` bytes; trailing bytes are an error.

Slots are fixed: every body has a slot in every frame. A slot outside the body's lifetime must be exactly **+0** in all
seven floats (not `-0`, not stale data), so the lifetime ranges in the manifest and the bytes in the chunks check each
other: a corrupted range makes a live slot all-zero (not a unit quaternion) or a dead slot non-zero.

## Order of checks (nothing large is allocated before its size is bounded)

1. Manifest text length against `maxManifestBytes`, then `JSON.parse`, then schema, then closed key lists.
2. Counts against the limits (frames, chunks, bodies) before any per-element loop.
3. Body table, lifetimes, chunk table arithmetic (`byteLength`, contiguity, totals vs `maxChunkBytes`, `maxTotalBytes`
   and the declared budget), body-table checksum, canonical form.
4. Per chunk: header (magic, header CRC, revision, manifest agreement) for every supplied chunk.
5. Only then the typed arrays, sized by the frames that fit in the bytes actually supplied and never above the
   manifest's validated count (a manifest that promises 8 MB and arrives with 3 frames allocates for 3 frames).
6. Per frame: CRC, strictly increasing step, finite positions within ±1e6 m, finite rotation with length within 1e-3 of
   1, dead slots all +0.

Limits (`resolvePoseCacheLimits`): defaults 4096 bodies, 36 000 frames, 1024 chunks, 16 MiB per chunk, 256 MiB of
chunks, 1 MiB manifest. Callers may pass other values up to the hard ceilings (65 536 bodies, 1 000 000 frames, 65 536
chunks, 64 MiB per chunk, 1 GiB total, 16 MiB manifest). These are conservative draft bounds, not measured results.

## Body ids and lifetimes

`id` is a stable positive integer (1 to 2³¹−1), unique across the whole cache. A body is alive in frames
`[firstFrame, endFrame)`; there is exactly one range per id, at least one frame long. A body that disappears and later
returns must be given a new id (a possible v1 extension is several ranges; see open decisions). The in-memory body
table is copied on encode and decode; no object is shared with the caller.

## Sampling and interpolation

`samplePoseCache(cache, time, out, alive)` writes bodies × 7 numbers and one 0/1 per body, nothing else, and allocates
nothing. Time is seconds from the first frame (`(step − firstStep) * dt`) and is clamped into the cache; a non-finite
time or a wrong-sized array throws `RangeError`.

- At a frame's own time the result is that frame exactly (same float32 values, that frame's alive set).
- Between two frames a body is present **only if alive in both**: position linear, rotation the normalized
  shortest-arc blend (the second quaternion is negated when the dot product is negative, so `q` and `−q` are one
  rotation). A body that is born or ends inside an interval is absent for that interval: no extrapolation, no holding,
  no blending across a lifetime boundary.
- A body that is not alive reads as all zeros with `alive = 0`.
- There is no cap on the step gap between two frames. Normalized linear blending approximates the rotation path
  increasingly poorly for large angles, so a recorder should sample often enough; this draft makes no accuracy claim.

## Truncation, cancel and recovery: where the boundary is

`decodePoseCache` is strict for one declared cache: missing/truncated/extra/reordered chunks,
checksum failures or invalid frames throw. Accidental-integrity checks have CRC-32 strength;
they do not detect deliberate tampering or guarantee collision-free detection of every edit.
Fields such as provenance and budgets are not authenticated.

`recoverPoseCachePrefix` is not a lenient decode. It reads chunks in order and stops at the first problem; nothing
after that point is used even if it looks intact. Its result is a plain object:

- `complete: true` only when nothing was lost, and then `cache` equals what `decodePoseCache` returns.
- Otherwise `complete: false`, `problem` (chunk, frame, code, reason), `declaredFrames` versus `recoveredFrames`, and
  `cache`, a valid `PoseCache` of the individually verified prefix, or `null` if no frames survived or
  no body has yet been born in that prefix (the verified-frame count is still reported).
  Its `termination` is `recovered`. Bodies with no alive frame in the prefix are listed in `omittedBodyIds` and
  removed (slots repacked); remaining lifetimes are clipped to the prefix.
- The manifest is the only authority on `dt`, the body table and the chunk layout. A missing, truncated or corrupt
  manifest throws; there is nothing to recover from the chunks alone. A chunk whose header does not verify is lost
  entirely, along with everything after it, even if its frames are fine, because the header is the only thing that ties
  the frames to this cache and position.
- Within a truncated chunk, the frames whose record is fully present, CRC-correct and valid survive.

So "a cancelled bake leaves a valid prefix" holds under one condition the future recorder must keep: it writes a final
manifest (`termination: "cancelled"`, lifetimes closed, chunk table listing the chunks actually flushed) at cancel
time, and each flushed chunk is complete. A crash before any manifest is written is not recoverable by this codec.

## Ownership

No input is retained or modified (`cache`, its arrays and bodies on encode; the manifest string and chunk bytes on
decode and recover). Returned `chunks` are separate tightly sized zero-offset `ArrayBuffer`s; decoded arrays do not alias
the chunk bytes, each other, or another decode. Chunks may be views at any byte offset. Typed arrays on a
`SharedArrayBuffer` are refused, so memory cannot change between validation and use. `provenance` is copied into a
frozen null-prototype record. Endianness is explicit (`DataView`), so the output does not depend on the host.

## What this does not detect (known limits)

- Callers must assign a different `cacheId` for each bake in their collection. Reusing one can
  permit mixed files with matching metadata. IDs are only32bits and not globally unique; CRC-32
  collisions remain possible. A stable public format may need a stronger identifier/checksum.
- CRC-32 detects accidental damage only, not tampering.
- The manifest has no checksum of its own beyond the body-table checksum and the cross-checks above; a change to a
  lifetime range is caught by the slot rule, a change to `termination` or `provenance`, or raising `budget`, is not.
- Interpolation accuracy for large rotation steps is not bounded (above).

## Freezing into v1

A v1 should only be cut after these are done, each with its evidence:

1. B2's recorder has produced and read back real caches (including a cancel), and any layout change that taught is
   folded in.
2. The open decisions below are settled.
3. Schema string changes to `three-avbd.pose-cache/v1`, the chunk revision is reset or bumped deliberately, and the
   golden byte-layout test is replaced by committed fixture files with their CRCs.
4. The reader refuses `v0-draft` explicitly with a message naming the migration (or accepts it through one named
   function; never silently).
5. A published reader exists for at least one non-JS consumer so the canonical-text and CRC rules are shown to be
   implementable elsewhere.
6. Public entry (`three-avbd/bake`), `docs/API.md` map and the example's migrate-or-label-legacy decision are made by
   the parent, with a stated support policy (one version back).

## Draft choices and remaining v1 design gates

1. **Canonical-text strictness.** Requiring byte-identical canonical JSON makes duplicate-key and number-spelling
   ambiguity impossible, but a foreign writer must reproduce JS number formatting and key order. Alternative: parse
   leniently and add a duplicate-key scan.
2. **Chunk binding (resolved for this draft).** Required caller-assigned `cacheId`, included in
   the existing binding checksum; frame CRC seeded by its own header CRC. Distinct IDs are
   caller responsibility, with CRC-32 collision/security limitations. See lead resolutions.
3. **Sample rate field.** AD-8 says the file stores `dt` and the sample rate; this draft stores `dt` and per-frame step
   stamps only.
4. **Lifetime model.** One range per id versus several ranges per id (return of a body).
5. **Interpolation policy at lifetime edges.** Present-only-if-alive-at-both-frames (chosen, conservative) versus
   hold-until-the-next-frame for a body that ends.
6. **Interpolation gap cap.** A manifest field bounding the step gap across which blending is allowed.
7. **Optional velocity and event track** from AD-8 are not in this slice.
8. **Fixed slots versus packed live bodies.** Dead slots cost 28 bytes a frame each; fine for the bounded draft
   budgets, wasteful for a bake with heavy churn.
9. **Recovery needs a last-written manifest.** If the recorder cannot guarantee that at cancel, an append-friendly
   chunk-local body table would be needed.

## Verification

`tests/pose-cache.test.ts` (CPU only): known CRC vector and exact byte layout; lossless float32 round trip including
−0 and subnormals; chunk sizes 1 to 6 frames; exhaustive truncation of every chunk length and every single-byte
corruption (three bit patterns), each checked against the independently computed expected prefix; CRC-valid frames with
bad values, lifetimes and step stamps; header and manifest disagreement; budgets (including allocation-size spying on
the global typed-array constructors for hostile and truncated-large inputs); manifest canonical-form, unknown-field and
prototype refusals; ownership and unaligned chunk views; sampling at frame times, between, outside, with absent bodies,
and shortest-arc rotations; cross-refusal with the example pose-track schema. Eight mutations of the source (frame CRC,
step order, dead-slot check, allocation bound, canonical form, trailing bytes, lifetime sampling, shortest arc) were each
caught by at least one test, then reverted. No performance, determinism or physical claim is made.


## Lead review resolutions — 2026-11-10

The independent [integrity/recovery review](audits/pose-cache-review-20261110.md) identified
invalid zero-body recovery, mutable validation constants and overstated integrity wording.
The lead reproduced the first two with failing regressions, then fixed them and froze both
flat constants. Recovery before any birth returns `cache: null`, with explicit omitted IDs and
verified-frame count; it never returns a cache its validator rejects.

The pre-recorder binding risks were also addressed now: `cacheId` is required, participates in
the existing body-table binding checksum, and every frame CRC continues from its own header's
CRC (the zlib running-CRC convention). This binds frames to the bake identity **and** chunk
index/range. Header size stays36bytes. Regressions cover whole-chunk mixes, a torn overwrite
with stale frames, and frames transplanted between chunks. This is the first uncommitted draft,
with no published format or existing writer; no user file is migrated or overwritten.

Current bounded choices: canonical JSON stays draft-only; `dt` plus step stamps are timing
authority (no redundant sample-rate field); one alive interval per ID; no interpolation across
a lifetime boundary; no velocity/event tracks or DCC interchange. These are not v1 promises.
B2 must allocate distinct IDs, persist authoritative cancellation metadata and define crash-safe
writing before its first saved cache. Public exports/build entry and v1 freezing remain gated.

The lead also added a minimum encoded-byte/chunk-budget preflight to in-memory validation,
before pose scanning. Encoding still validates its actual chosen chunk layout and manifest
size separately. A failing regression demonstrated that an otherwise valid in-memory cache
could previously pass validation under an impossible total-byte budget.
