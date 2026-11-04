# Audit remediation, 2026-10-31 (three-avbd)

Base: `cd3ce901557aa9cf4f7ede489fac385971d383ea` (main, #45). Scope: the three-avbd findings of
the 2026-10-31 audit (A1–A6, AS, AC-1..3, AH-1..3, comparison harness). The audit's findings
were static hypotheses. Each one below was traced in the code before anything changed.

**Current disposition index:** [AUDIT_DISPOSITION.md](AUDIT_DISPOSITION.md).
The final historical audit gate below records 187 CPU and 200 Dawn GPU passes after
review corrections. Earlier partial runs remain chronology, not the final status.
Current-candidate checks must be rerun; these historical results do not qualify
later commands, observations, queries or capabilities. No browser qualification
is implied. The per-finding reasoning and recovery limitations below are retained.

## Dispositions

| ID | Finding | Traced? | Disposition | Change |
|---|---|---|---|---|
| A1 | STE-3006 (SDF C4) evidence lost with `/private/tmp` worktrees | Yes, by a separate recovery task (private scratch, not in the repo) | DOC / user decision | None in code. Status below |
| A2 | A reused joint slot kept its old pair's no-collide entry | Confirmed: `appendConstraints` removed the slot from `releasedSlots` before `uploadStatics` filtered by it, and `IGNORE_PAIRS_WGSL` checks the slot's *live* joint, so the old pair stayed apart while the new joint held. A joint added and released before an upload also left its entry | FIX | `src/avbd3d/gpu/no-collide.ts` (pure table), `GpuSolver3D` uses it |
| A3 | Contact pair-set overflow (`table[1]`) ignored | Confirmed: `ContactWatch.read` returned `full`, `World.read` used only `dropped`. A full set then misses pairs, which re-emit begin/end every step | FIX | Counter, bounded resize, docs |
| A4 | Speculative sphere/box flag (dirty checkout, 0.2.1-era) | Assessed by the recovery task | EXT / INV | None. Status below |
| A5 | `read(bodies)` while a read is in flight could resolve without reading them | Confirmed: `read` returned the read in flight whatever it held | FIX | Coverage check, chained read |
| A6 | No destroyed guards; async destroy races | Confirmed: `destroy()` only set a flag; a read in flight could call `releaseJoints` on destroyed buffers after its await | FIX | Guards, settle-on-destroy, idempotent destroy |
| AS | Stale docs | Confirmed | DOC | AGENTS sentinel path, PLAN test harness and `index3d.html`, API heading |
| AC-1 | `sdf*WGSL` constants built at import | Confirmed defined, not re-exported from any package entry | INV (measured) | None |
| AC-2 | Repeated quaternion helpers | Confirmed, different types and signatures | DOC (no change) | None |
| AC-3 | SDF bridge creates bind groups every step | Confirmed in `SdfCollisionBridge` (filter, export, events) **and** `SdfSpatialBroadphase.encode` | FIX | `src/avbd3d/gpu/bind-group-cache.ts` |
| AH-1 | Rewritten slot inherits the old occupant's manifold | Reproduced on real Dawn: old box anchors at -0.5 instead of -1 | FIX | Invalidate previous contact history on rewritten slots |
| AH-2 | `sortAdjacency` insertion sort is quadratic | Per-body, bound derived below | DOC, needs measurement | None |
| AH-3 | Speculative mode's extra body loads | Dirty checkout only | Folded into A4 | None |
| Harness | Comparison harness git `define` and sphere drawing | Exists only in the preserved dirty checkout (not on main) | EXT | Patches kept outside the repo. Status below |

### A2: joint slot reuse and the no-collide list

`NoCollideTable` holds the sorted `(hi, lo, slot)` list, entries waiting for upload, and slots
released since the last upload. Fixes:

- `release(slots)` also drops waiting entries for those slots. A joint placed and released
  before an upload no longer leaves its entry.
- Reusing a slot no longer cancels its release. At upload, every entry for a released slot goes,
  and only entries added after the slot's last release stay.

Covered paths: `World` joint removal, springs (same `appendConstraints` path), broken joints
released at a readback, and slots placed, released and reused again before a step (a `read` or
`raycasts` flushes the joint queue without a step). The same table serves
`three-avbd/advanced` users calling `releaseJoints` / `appendJoints` directly.

CPU tests: `tests/no-collide.test.ts`. GPU tests (executed; see verification status above):
`tests-gpu/world-contracts.gpu.test.ts`, the four "A2" cases, which count broadphase pairs.

### A3: contact set overflow

- `World.contactSetOverflows` (new getter) counts readbacks that found a set had overflowed since
  the previous readback. Events in that window are documented as unreliable.
- After an overflow the world resizes the sets before the next step. The new size is
  `min(solver.manifoldCapacity, device limit)`. That many pairs is enough, because the pass
  reads at most `manifoldCapacity` pair records a step. The device limit is the largest set
  table that fits `min(maxStorageBufferBindingSize, maxBufferSize)`
  (`ContactWatch.maxPairs`). Growth is bounded: once the size reaches that bound, further
  overflows are still counted, but no more resizes happen.
- History: the new sets start empty, so this is **not lossless**. Pairs already touching begin
  again, and a pair that stops at the resize step reports no end. This is documented in
  `docs/API.md` and on the getter.
- Buffer safety: the resize happens only when no read is in flight. The replaced watch is kept
  until a read has delivered its unread events (before the new watch's), then destroyed. At most
  two watches exist at a time. `World.destroy` frees both. Readbacks use their own staging buffers,
  so no mapped buffer is destroyed.

GPU test (executed; see verification status above): "a contact set overflow is counted, the set grows, and events then
go quiet". It uses 100 reporting boxes against `maxContactPairs: 1` (64 slots).

### A5: reads in flight

`read(bodies)` while a read is in flight returns that read only if it holds every requested
living body, as written by then (`body.written <= writes at issue`). A full `read()` is covered
only by a full read in flight with no writes since. Any other request waits for the read in
flight, settled or failed, and then reads itself. So when the returned promise resolves, the
requested bodies have been read. `read([])` still returns the read in flight, as before.
`readJoints` keeps its wait-then-read loop.

GPU tests (executed; see verification status above): a subset read during another subset read, a full read during a
subset read, and a body written after the read in flight began.

### A6: lifecycle

- After `destroy()`, these throw `World destroyed: …`: `step`, `update`, adding bodies, `Body.remove`
  (through `assertMutableTopology`), `addJoint`, `addSpring`, and `Joint.remove` (checked before
  the handle changes state). `read`, `readJoints`, `raycast` and `raycasts` reject with the same
  message.
- A read in flight at `destroy()` checks the flag after its await. It rejects and applies nothing:
  no joint release, no events, no snapshot write. The automatic `readbackEvery` read ignores
  only that destroy rejection. Any other rejection stays unhandled, as before.
- `destroy()` is idempotent.
- Retained handle setters (`Body.set`, `applyImpulse`, …) throw before mutating CPU state.
  New raycasts reject after destruction; queries submitted beforehand retain their snapshot
  and may complete, as the existing SDF lifecycle contract requires.

GPU tests (executed; see verification status above): use after destroy (retained handles included), and reads in
flight at destroy. The `gpuTest` wrapper fails on any uncaptured GPU error, such as a write to
a destroyed buffer.

### AC-3: SDF bind groups

`BindGroupCache` keeps groups keyed by owner (pipeline or layout) and exact buffer identities,
with a bounded LRU of 8. The bridge's filter, export, event and prepare groups and the spatial
broadphase group now come from it. The narrowphase output and the solver's contact buffers
ping-pong, so a single-entry cache would miss every step. A replaced buffer (field refresh,
capacity growth, statics regrowth) is a new object, so it misses and gets a new group. Caches
are cleared on `destroy`, and a grown bridge starts its own cache.

CPU test: `tests/bind-group-cache.test.ts`. GPU tests (executed; see verification status above): two cases in
`tests-gpu/step-allocations.gpu.test.ts` that count `createBindGroup` over steps after warm-up
(automatic candidates with a reporting body; explicit candidates with `contactEventStorage`).
Each expects zero. Note that `ContactWatch` keeps a single-entry group cache. With the solver's
own ping-ponged contact storage (no SDF), it still makes a group each step. That was outside
this finding and was left unchanged.

### AH-1: rewritten slots and contact history

The real-Dawn reproducer failed: a 1 m box replaced by a 2 m box at the same pose kept
bottom anchors at -0.5 instead of -1. Clearing the reference pose alone also failed: static
friction warm starts restored the old anchors even after narrowphase regenerated contacts.

Packing a body now sets `initialPos.w` to 1. It was never read before (each step copied
friction into it from `pos.w`); it is now a one-step marker. Custom `shaders.solve` modules
must be derived from the current `solveWGSL`, as `GpuSolver3D` already requires, or the marker
is never cleared and every pair loses its contact history. `hashInsert` omits old
manifolds touching a rewritten slot, invalidating both contact reuse and friction history.
`warmStartBodies` clears the marker after collision, preserving all xyz pose semantics.
`rewriteFixed` uses the same packed template. Unchanged bodies retain their history.
`seedFrom` preserves its explicitly imported matching history. The first full gate caught
that exception; the existing seeded CPU-reference parity test now passes alongside all
rewritten-body cases. No record size or exported offset changed; advanced consumers writing raw body records
must respect the documented marker. The CPU reference/oracle is unchanged.

Three real-Dawn regressions pass: replacing a dynamic box with reuse on and off, and
rewriting a fixed floor at the same pose. Full gate results are recorded above when complete.

### AH-2: `sortAdjacency`

Each thread sorts one dynamic body's list with insertion sort, at O(d²) comparisons. Each
comparison calls `adjKey`, which reads the constraint's endpoints. The degree `d` is the
active joints on the body plus the touching **pairs** (one manifold per pair, `topoCount` =
manifolds), not contact points. Fixed bodies have no list. Nothing in the WGSL bounds `d` beyond
`bodyCount − 1 + joints`. A dynamic slab under N small bodies has `d ≈ N`, with about N²/2
comparisons on one thread. The shader's comment assumes "a few dozen constraints at most",
which holds for piles of similar-sized bodies but is not enforced. No change was made. Justifying a
change needs a GPU timestamp of the `sortAdjacency` phase on a scene with one dynamic plate
carrying N = 64…4096 boxes, measured on the target hardware (M1, GTX 1080), with an acceptance
threshold set before measuring.

### AC-1 and AC-2

AC-1: building each SDF shader source takes 0.1–0.3 µs per call (838–24,810 characters).
Measured in Node 25.2.1 on the dev machine (M4 Max) with a throwaway script outside the repo,
calling `sdf{History,Broadphase,Export,Events,Narrowphase}Source()` 200× each. Import-time
construction is negligible, so the exported constants stay as they are (no public removals).

AC-2: the `rotate`/`multiply` helpers in `src/lib/world.ts`, `src/avbd3d/gpu/sim.ts`,
`src/lib/mesh.ts` (a TSL node function) and `src/avbd3d/ref/math.ts` (out-parameter, f64)
differ in types and contracts. Merging them would change precision or call shape for no
measured gain. Left as they are.

### AS: docs

- `AGENTS.md`: the BIG/HARD sentinels are in `src/avbd2d/gpu/layout.ts`. There is no `shaders.ts`.
- `docs/PLAN.md`: the test harness is `node:test` (`pnpm test`, `pnpm test:gpu`), and
  `index3d.html` was folded into `index.html` (7a91f74).
- `docs/API.md`: "Decisions to make now" is now "Decisions made (historical)". The version text
  (0.4.0 in `package.json`, 0.3.x on npm) is a pending release, not a bug, and is left alone.

### A1: STE-3006 C4 evidence (status recorded, no regeneration)

A separate, read-only recovery task searched for the Oct 24–25 work. Summary:

- Git cannot restore it. Nothing from the lost worktree was staged, stashed or committed, and
  the newest object in the shared store is `cd3ce90` itself.
- No file copies survive anywhere this account can read. Trash and Time Machine were not
  readable or not configured, which needs a user decision or Full Disk Access.
- Agent transcripts gave back report and tooling **text**: 3 documents verbatim (including
  `SDF_C4_MAIN_RECOVERY.md` and `SDF_FIELD_CERTIFICATE.md`), 21 files rebuilt and fully
  confirmed against verbatim reads, 1 window-verified, and the rest partial, diverged (withheld)
  or not recovered.
- **No measured data survives.** None of the `docs/measurements/sdf-*-2026-10-2{4,5}.json`
  files, capture roots or gate logs were recovered. Numbers quoted in recovered text are report
  text, not measurements.

Recommendation: treat STE-3006's C4 checkpoints as reported, not reproducible. Do not import the
recovered text into main as evidence. If it is kept, put it on a dedicated research branch with
a recovery-status header on every file. Any regeneration is a new, dated GPU task on current
main, run under Steven's approval and never labelled as the Oct 24–25 results. Keep agent
worktrees out of `/private/tmp` and commit evidence to a pushed branch at each checkpoint. The
recovery manifest and per-file hashes stay in private scratch.

### A4, AH-3 and the comparison harness (status recorded, no physics change)

The recovery task assessed the preserved, uncommitted comparison work (0.2.1 era, `b3675de`):

- The opt-in `speculativeSphereBox` flag routes every sphere/box pair through a per-sphere scan of
  all bodies (O(spheres × bodies)). It skips `faceSeparated` for motion pairs, and it drops alpha
  stabilization on the normal row whenever `c0x > 0`, which includes resting contacts inside the
  margin. It is not CCD (no angular sweep).
- **Port hazard on main:** main's dynamic-only probe rule and `findFixedLarge` mean a naive port
  would silently drop static-sphere / dynamic-box pairs. The ownership rule must be redesigned.
  Main's substep manifold reuse also needs explicit handling.
- The rest-instability hypothesis is **unverified**. The recorded sphere-pile instability occurs
  with the flag **off** as well, dominated by sphere/sphere contacts, so it does not implicate the
  flag.
- With the flag off, `speculativePair()` loads both shape words before testing the flag, for
  every broadphase candidate. A no-default-cost regression is required before any port.
- All recorded comparison numbers predate #39 (deterministic colour-chunk order) and the
  broadphase changes. They must be rebaselined on main before any comparison claim.

Harness defects. Both apply to the preserved comparison tree, **not to main**: main has no
comparison harness, no git `define` in `vite.config.ts`, and no `src/comparison/`.

1. Git provenance in source archives: `vite build` fails in a copy without `.git`. A prepared
   patch adds a provenance helper that records `{source:'unknown', head:null, dirty:null,
   reason}` instead. It was checked on CPU in a scratch copy.
2. Spheres drawn as boxes on the frame page: the renderer picks meshes through the `setBodies`
   callback, **not** the shape word. Writing `angVel.w` would not have fixed it. A prepared patch
   returns `Shape.Sphere` for sphere bodies from that callback. It is typecheck-only, and no
   recorded result is affected (the page's cases contain no spheres).

The patches are kept in private scratch with pre-image hashes and are not transplanted into
main. Next steps (Steven's decisions): (1) snapshot the preserved work to a private branch in a
separate worktree; (2) port only the harness to current main, with both fixes applied by hand,
and rebaseline; (3) only then consider porting `contactMargin` and the flag behind a
redesigned ownership rule, with the required regressions (no default cost, sphere rest with the
flag toggled, mid-run toggle, ownership, capacity). Angular CCD, free-fall precision, spin
damping and sphere-pile stability stay listed as open gaps.

## Compatibility (public and `three-avbd/advanced`)

- No public export was removed or renamed. Added: the `World.contactSetOverflows` getter, and
  `World.assertLive` (marked `@internal`, needed by the handles). New internal modules:
  `no-collide.ts` and `bind-group-cache.ts` (not exported from any entry). `ContactWatch` gains
  `pairs` and `static maxPairs`, but it is not a package export.
- Behaviour changes users can observe:
  1. `releaseJoints` + `appendJoints`/`appendSprings` in one frame no longer keep the old pair
     from colliding. This is a bug fix and changes trajectories in that case only.
  2. `read(bodies)` during a read in flight may now issue a second readback.
  3. Use after `destroy()` throws or rejects instead of erroring at the WebGPU level or silently
     doing nothing.
  4. Overflowing contact sets now grow once to the solver's pair capacity, which uses more GPU
     memory.
- Default physics parameters, oracle code (`src/avbd2d/ref`, `src/avbd3d/ref`) and fixtures are
  unchanged. Contact normals are unchanged. Rewritten bodies now discard the previous occupant's history;
  unchanged bodies and explicit reference seeding retain theirs.
- three-destruction pins three-avbd 0.3.0, and its peer range `>=0.3.0 <0.4.0` excludes this
  0.4.0 tree. Its normal gate therefore does **not** exercise these changes. Before any
  version or peer-range bump, separate packed-consumer evidence is needed: `pnpm build:lib`,
  `pnpm pack`, installed into a three-destruction checkout locally, with its typecheck and GPU
  suite run serially. No release, version or peer-range change was made or is authorized here.

## Initial implementation commands (CPU only)

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Installed. Lockfile unchanged |
| `pnpm typecheck` | Pass (covers `src`, `tests`, `tests-gpu`, `scripts`, `examples`) |
| `pnpm test` | 187 tests, 187 pass, 0 fail (includes the new `no-collide` and `bind-group-cache` suites) |
| `pnpm build:lib` | Pass (`tsc -p tsconfig.lib.json`; output in the ignored `build/`, includes the new modules and `contactSetOverflows`) |
| AC-1 timing script (outside the repo) | Figures above |

Before running, `tests/*.test.ts` was checked for Dawn imports. None import `webgpu` or
`tests-gpu/device.ts`. The two that mention GPUs use fake devices.

## Coordinator validation

All GPU processes were serial (`--test-concurrency=1`), using an external Node launcher for
`pnpm check`; package scripts and test thresholds were unchanged.

- The AH-1 reproducer first failed with old bottom anchors (-0.5 instead of -1). Resetting
  reference poses alone still failed because static friction restored old anchors.
- The history-invalidation fix initially also discarded deliberately seeded reference history.
  The first full gate was stopped after detecting that regression. `seedFrom` now explicitly
  retains its imported matching history, and the unchanged reference-parity tests pass.
- The second full gate: 187/187 CPU, 199/200 GPU, no skips. Sole failure was the added
  post-readback raycast guard; already-submitted queries must finish with captured identity.
  Subsequent gate build phases did not run because of that failure.
- After removing that guard: `node --experimental-transform-types --test-concurrency=1 --test
  tests-gpu/sdf-lifecycle.gpu.test.ts tests-gpu/world-contracts.gpu.test.ts` passed 25/25,
  zero skips, about 5.4 seconds. This includes the previously failing test.
- Final `pnpm typecheck && pnpm build && pnpm build:lib`: pass. Vite reports its existing
  large-chunk warning; no ceiling was changed.
- `git diff --check`: pass. No commit, staging, push, release or dependency change.

The World-contract suite now has 12 cases (three for AH-1). Both new SDF bind-group allocation
cases passed in the full run, asserting no bind groups are created after warm-up.

Fresh full gate after the review fixes, every step serial, scripts unchanged:
`pnpm typecheck`, `pnpm test` (187/187), `node --experimental-transform-types --test
--test-concurrency=1 tests-gpu/*.gpu.test.ts` (200/200, 0 skipped, about 354 s), `pnpm build`,
`pnpm build:lib`: all pass. This is the content of `pnpm check`, with the GPU files run by one
runner instead of the script's default concurrency.

Remaining: separate packed
three-destruction compatibility evidence before changing its supported AVBD version. The
normal destruction dependency remains 0.3.0 and does not exercise these sibling fixes.

## Packed-consumer check against three-destruction (2026-11-01)

A fresh clone of sbobyn/three-destruction at `de719ef` (main), outside every existing checkout.
Nothing there was committed or pushed. This tree was packed with `pnpm pack` (0.4.0, tarball
sha256 `d95134709b5646433fd4b940ca05dcce0ab059eb7545129d556e8823203c5de1`). GPU work was
serialized with `vitest run --no-file-parallelism`, and nothing else ran on the GPU at the time.

| Step | three-avbd 0.3.0 (lockfile, baseline) | three-avbd 0.4.0 (packed, via a scratch-only `pnpm.overrides`) |
|---|---|---|
| `pnpm typecheck` | Pass | Pass |
| `vitest run --no-file-parallelism` | 113 files pass, 1 skipped; 1180 tests pass, 7 skipped | 113 files pass, 1 skipped; 1181 tests pass, 6 skipped. All 13 `tests/avbd-*` GPU files ran and passed |
| `pnpm build && pnpm test:package` | not run | Pass. The packed consumer links the 0.4.0 install and imports the `avbd` entry |

The skipped tests on 0.4.0 are statics/cost measurements and structure-load cases, not GPU
tests. The baseline run was not verbose, so the one test that changed from skipped to passed is
not identified. The override only bypasses the peer range: three-destruction still declares
`three-avbd >=0.3.0 <0.4.0` and pins 0.3.0, and none of that was changed. This is compatibility
evidence for a later bump, not the bump itself. Not checked: the demo in a browser.

## Step 4 status (approved; prepared, nothing committed)

- C4 research text: 25 confirmed files (3 verbatim, 21 fully verified, 1 window-verified) were
  staged outside the repo under `research/sdf-c4-2026-10-24/`. Each has a recovery-status header,
  and an index README lists hashes and the 16 excluded partial or unverified files. It is kept
  out of `src/`, `tests/` and `tests-gpu/` so no gate picks it up. Next: create a research branch
  from main and commit it once commits are approved.
- Comparison harness: a written port plan (what ports, what doesn't, and the steps). Porting needs
  `@dimforge/rapier3d-compat` as a devDependency, a **lockfile change**, which needs explicit
  approval. The speculative-flag solver diff is excluded until the harness has a new baseline on main.
- C4 measurement regeneration and the speculative-flag redesign: not started; separate GPU tasks.
