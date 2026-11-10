# Pose cache codec — bounded independent review (STE-3349 / B1, 2026-11-10)

One read-only review of the draft codec for the named risk: silent acceptance of cross-cache or
corrupt input, allocation bounds, and recovery and ownership correctness. Not a v1 approval, a
redesign or an implementation. The lead owns fixes and delivery.

Reviewed at HEAD `a133d8579e5b5f64d7c214775cff2e5493495a4c`. During the review another session
switched this worktree to `feat/ste-3328-gravity-scale-20261110` at `31bb39b` (same committed tree).
The three untracked files are unaffected: SHA-256 identical before and after the review:

| File | SHA-256 |
|---|---|
| `src/bake/pose-cache.ts` | `d63bbc6bc3f15c54118d4c97ad89072060359ed86b7b6827cbd0401a4fd33ad8` |
| `tests/pose-cache.test.ts` | `136cd4494eeaae6ca6a6bc63af206b87fdde47896e2fc025ffbaded3aa582640` |
| `docs/POSE_CACHE.md` | `75bc8fdf7bfd58e96fd43899737bd4caf67822243c2dc96f9abbb3c06aa34a4e` |

## Verdict for the internal-draft merge

**Mergeable as an internal draft after three small fixes (F1–F3).** No allocation-bound bypass,
non-finite output, input aliasing or false result from single-fault damage inside one cache was
found. The per-bake binding (R1, R2) does not have to block this merge, because nothing writes a
cache yet, but it must land before B2 persists its first file, and it is cheapest now.

| # | Kind | Summary | Before merge? |
|---|---|---|---|
| F1 | Confirmed bug | Recovery can return a cache with zero bodies, which the module's own validator and encoder refuse | Yes |
| F2 | Confirmed doc overstatement | "Any … swapped or damaged byte … throws" is false in three stated ways | Yes |
| F3 | Confirmed, low | Two exported constant objects are mutable at run time and change later validation | Yes (two lines) |
| R1 | Concrete risk, disclosed | Whole chunks from another bake with the same `dt` and body table decode as complete | Before B2 |
| R2 | Concrete risk, not disclosed | Frames are not bound to their chunk header, so a torn in-place overwrite decodes as complete | Before B2 |
| R3 | Concrete risk, low | Header of one chunk plus frame records of another: recovery returns a prefix with a silent gap | Fixed by the R2 remedy |

## Confirmed

### F1 — recovery returns an invalid, zero-body cache

`recoverPoseCachePrefix` (`pose-cache.ts:536-546`) keeps only bodies with `firstFrame < frames`.
A cache may legitimately start with frames in which no body is alive yet (a scene that spawns
later). If the verified prefix ends before any body is born, `keep` is empty and the result is
`cache: { bodies: [], poses: Float32Array(0), steps: [..] }`.

Repro (run): one body with `firstFrame: 1, endFrame: 2`, two frames, `framesPerChunk: 1`, recover
with chunk 0 only. Result: `recoveredFrames: 1`, `cache.bodies.length === 0`, and both
`validatePoseCache(cache)` and `encodePoseCache(cache)` throw `data: bodies must be a non-empty list`.
This contradicts `PoseCacheRecovery.cache` ("a fully valid cache", line 100) and `POSE_CACHE.md:121-122`.

Smallest fix: when `keep.length === 0`, return `cache: null` with `recoveredFrames: frames`,
`omittedBodyIds` = all ids and the same `problem`; reword the two doc lines to "`null` when no frame
survived or no body is alive in the prefix". One test with the repro above.

### F2 — the strict-decode sentence overstates

`POSE_CACHE.md:114-115` says any missing, truncated, extra, reordered, swapped or damaged byte
throws. Three cases are accepted today:

1. A chunk, or part of one, from another bake with the same `dt` and body table (R1, R2 below). The
   file's own "What this does not detect" section already says the first half of this.
2. A changed `provenance` value, or a raised `budget`, in the manifest (also already listed there).
3. Damage that collides in CRC-32 (about 2⁻³² per frame record; accidental-integrity level only).

Reword to scope the claim to "within one cache and its own manifest, to CRC-32 strength", and point
at the limits section. `POSE_CACHE.md:126-128` ("the header is the only thing that ties the frames
to this cache and position") is accurate and is exactly the cause of R2; say there that frame
records carry no cache or position binding of their own.

### F3 — `POSE_CACHE_VALUE_LIMITS` and `POSE_CACHE_CONVENTIONS` are not frozen

`pose-cache.ts:16-19` and `45-48` are `as const` only; `POSE_CACHE_DEFAULT_LIMITS` and
`POSE_CACHE_HARD_LIMITS` are frozen. `as const` stops TypeScript callers, not JavaScript callers or
a cast. Repro (run):

- `POSE_CACHE_VALUE_LIMITS.maxCoordinate = Infinity` → a cache with an `Infinity` position encodes,
  and decodes back as `Infinity` (the bound check at line 225 is `Math.abs(x) <= limit`).
- `POSE_CACHE_CONVENTIONS.up = '+z'` → the writer emits `"up":"+z"` and every previously valid
  manifest is refused.

Fix: wrap both literals in `Object.freeze`. One test: all four exported objects are frozen. The
other validation tables (`TERMINATIONS`, key lists, `CRC_TABLE`) are module-private and not reachable.

## Concrete risks (accidental integrity, not tampering)

Safety properties hold even against deliberately re-sealed bytes: every decoded value is range-,
finiteness- and lifetime-checked independently of its checksum, and sizes are bounded before
allocation. What CRC-32 cannot give is identity ("this is the bake you think it is"); anyone can
re-seal, as the tests do. The risks below need no attacker.

### R1 — whole-chunk mix between two bakes of one scene (disclosed)

Two bakes of the same scene with the same `dt`, body table, frame count, chunking and sample
stride produce **byte-identical manifests and chunk headers**. Repro (run): bakes A and B, 6 frames,
2 per chunk. `decodePoseCache(A.manifest, [A0, B1, A2])` succeeds with body 1's x per frame
`0,1,102,103,4,5`; `recoverPoseCachePrefix` reports `complete: true, problem: null`. A stale chunk
file left by an earlier bake under the same name is enough. A stale manifest with new chunks is the
same case.

### R2 — torn in-place overwrite (not disclosed)

Each frame record's CRC covers only its own step and slots (`pose-cache.ts:430`, `493`); nothing
ties a record to its header, its cache or its position except the increasing step. Repro (run):
one chunk file of bake A, overwritten in place by bake B's header and first three frames, write
stopped. Strict decode accepts it (`100,101,102,3,4,5`) and recovery says `complete: true`.

This matters because **a `cacheId` in the header alone does not fix it**: the header would be B's
and valid, and A's stale records still verify. Whether it can happen depends on how B2 writes
(truncate-then-write or write-new-then-rename cannot produce it; fixed-size or in-place writes can).

### R3 — header and frame records from different chunks of one cache (low)

Repro (run): `[A0, header(A1) + records(A2)]`, chunk 2 absent. Strict decode of the three-chunk
variant throws (`steps must increase`), but recovery returns 4 frames with steps `0,1,4,5` and
reports only "chunk 2 of 3 is missing". Each (step, pose) pair is true, but frame indices shift, so
lifetimes are applied to the wrong frames. It needs a splice, not a single fault.

### Smallest remedy for R1–R3 (proposal; about 25 source lines, header stays 36 bytes)

1. **`cacheId`** — required u32 (1 to 2³²−1) on `PoseCacheInput`, supplied by the caller (the codec
   stays pure; B2's recorder draws it). Add it to `CACHE_KEYS`, `TOP_KEYS`, `serializeManifest`
   (after `dt`), `readManifest`, and the decoded and recovered `PoseCache`.
2. **Fold it into the existing binding** — `poseBodyTableCrc32(dt, bodies, cacheId)` writes the id
   as one more u32. The header field at offset 8 becomes "cache binding"; no layout change. CRC-32
   detects every burst of 32 bits or fewer, so two ids over the same `dt` and table always give
   different bindings, not just probably.
3. **Chain each frame CRC from its header CRC** — give `crc32` an optional running-CRC seed
   (zlib's `crc32(seed, buf)` meaning, so non-JS writers have it) and pass the header's checksum at
   lines 430 and 493. A record then verifies only under the header it was written with.
4. Update the golden layout assertion (`tests/pose-cache.test.ts:104`). Bumping
   `POSE_CACHE_CHUNK_REVISION` is optional while nothing is persisted.

Tests: the three repros above become refusals (R1 `chunk` "different cache", recovery 2 frames; R2
`data` checksum, recovery 3 frames; R3 recovery 2 frames). If the lead defers the remedy to B2, add
one test that pins R1 as a named known limit so the document and the behaviour cannot drift apart.

Not proposed: authentication, a manifest self-checksum, or a broader format change.

## Review questions

**1. Corruption, truncation, swaps.** Within one cache: no false success found. Header fields are
all compared with the manifest (every one of the 36 bytes is determined), truncation and single-byte
damage are exhaustively tested, duplicated or reordered chunks fail on index, reordered frames fail
on step order, a changed lifetime fails the dead-slot rule, zero-filled regions fail magic or CRC
(run). Across caches: R1–R3. Recovery misreport: F1 and R3 only. `complete: true` implies every
declared frame and byte verified; `cancelled`/`budget` are passed through; `problem` is null exactly
when complete.

**2. Caps before allocation.** No bypass found. Text length is checked before `JSON.parse`; frame,
chunk and body counts before any loop; chunk arithmetic stays far below 2⁵³; typed arrays are sized
by `min(declared, frames that fit in supplied bytes)`. Numeric edge values (1e308, 2⁵³, −0, 2³²,
non-integers, other spellings) are all refused with `PoseCacheError` (run). A 1 MiB oversized chunk
allocates for its declared frames only (run). Pooled Node `Buffer`s at non-zero offsets decode
correctly (run). Notes, none a defect:
- `maxManifestBytes` compares string length. Equal to bytes for any accepted manifest, because the
  canonical text is ASCII.
- `JSON.parse` working memory is a multiple of the text size; it is bounded by the text limit, not
  by the typed counts.
- Recovery can briefly hold about three copies of the recovered poses (walk buffer, trimmed copy,
  repack). Bounded by supplied bytes.

**3. Ownership.** The stated claims hold as inspected and spot-checked (run): encode reads the
caller's arrays without keeping or writing them and copies the body table and provenance; chunks
are separate zero-offset buffers; decode and recover return fresh arrays and body objects that
alias neither the chunks, each other nor a second call; provenance is a frozen null-prototype
record. Exception: F3. One comment is loose: `validatePoseCache` "allocates nothing proportional to
the data" (line 363) copies the body table.

**4. Sampling.** No bug found. Frame times return the stored frame exactly, time is clamped, output
stayed finite over a sweep, and a body is present between frames only if alive in both. Choices to
decide separately, not defects:
- Quaternion sign jumps at an interval's right end: just before the last frame the blend gives
  `(0, .7071, 0, .7071)`, at the frame the stored `(0, −.7071, 0, −.7071)` (run). Same rotation; a
  consumer that differences or re-blends sampled quaternions must compare as rotations.
- A body's last frame, and any one-frame lifetime, is visible only at that exact frame time
  (alive `0,1,0` at 0.49, 0.5, 0.51 s, run). Recovery clipping can create one-frame lifetimes. This
  is open decision 5 in `POSE_CACHE.md`.
- No step-gap cap (disclosed). The "exact cancellation" fallback at line 596 is unreachable for a
  validated cache, since the sign fix keeps the blend length above 0.7.

**5. Tests.** Missing counterexamples: F1 (no-live-body prefix), F3 (frozen constants), R1–R3 (no
test crosses two caches with an identical body table; the existing "another cache" cases change the
table or `dt`). Nothing else is requested before delivery of the bounded internal draft.

## Optional, not blocking

- `POSE_CACHE.md:7` names source `0b48ebf`; HEAD is its child `a133d85`. Update at delivery.
- Provenance (Git head, dirty flag) can change silently in a damaged manifest (disclosed). If
  remedy step 2 is taken, the same binding could later cover more of the manifest; a v1 question.
- Canonical-text strictness, several lifetime ranges, velocity and event tracks, and the missing
  manifest at crash time remain the lead's open decisions; no finding here depends on them.

## What was run

- Read: the three files in full, `examples/pose-track.ts` imports (none; the codec imports nothing
  and nothing but its test imports it; no `package.json` export or build entry), root `AGENTS.md`,
  shared `AGENTS.md` and `docs/team-and-model-routing.md`, roadmap section 2, AD-8 and B1.
- Two scratch scripts outside the repository (Node 25.2.1, `--experimental-transform-types`),
  importing `src/bake/pose-cache.ts` read-only; inputs a few KiB, largest 1 MiB. They produced every
  result marked "(run)". Two rows of the first run were harness errors (the helper re-sealed the
  edited value) and were re-run correctly; the corrected results are the ones reported.
- **Not run:** `tests/pose-cache.test.ts`, typecheck, the full suite, any GPU, browser or build
  step. The lead's baseline (25 codec tests, 59 combined, typecheck) is relied on, not repeated.
- No source, test, document, Git, Linear or Obsidian change other than this file. Solver and
  `src/lib` files under active edit were not opened or executed.


## Lead disposition after this review

The review above remains the original source-qualified finding record. The lead subsequently
fixed F1–F3 and R1–R3: null recovery when no body is present, frozen format/value constants,
qualified integrity wording, required caller cacheId and header-seeded frame CRC. Two new
regressions failed before the required fixes;43codec+unchanged legacy-track tests pass after
all changes, including mixed/torn/transplanted payload fixtures. This is lead verification of
the fixes, not a second independent review or v1/export acceptance.

A subsequent lead regression found an impossible total-byte budget could pass the in-memory
validator. Minimum encoded byte/chunk feasibility now rejects before pose scanning; existing
encoder error wording is preserved. Final codec+legacy-track gate:44passed, zero failed/skipped,
plus whole-project typecheck. No public export/writer/replay or v1 acceptance was added.
