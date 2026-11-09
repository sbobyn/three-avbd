# Maturity audit — round 2 (2026-11-09)

Second and final requested audit round for the Three AVBD lead: a recheck of the merged gallery/UI
fixes, then the library judged as an adopted API, as a large-scale web solver, and for realtime and
baked workflows, with a source-backed comparison against Rapier and the engine/DCC stacks.
Read-only. Nothing here is implemented, approved, release acceptance or publication approval.

| | |
|---|---|
| Source | branch `feat/ste-3003-maturity-20261109`, HEAD = `origin/main` `4e594e5d746af8f0defb40c2ba44edc17f711611` (PR 79 merge) |
| Overlay | clean before and after; the only write is this file (untracked, local-only) |
| When | 2026-11-09 |
| Package | `three-avbd` 0.4.0 source candidate, unpublished (npm latest 0.3.0 per the lead); tested Three 0.187.0, Rapier 0.21.0 installed |
| Auditor | one review worker; no delegation, implementation, Git, Linear, server or browser action |

**Next action for the lead:** run Slice 1 (M-01, M-02, M-03): three small, code-proven robustness
defects in `src/lib/world.ts`, each with a focused regression, none changing a documented contract
beyond "invalid input now throws". Slices 2 and 3 do not overlap it.

## What was and was not checked

- **Read:** project `AGENTS.md`, `docs/audits/*` (round 1 and lanes A–C), `GALLERY_DESIGN.md`,
  `RELEASE_0.4.md`, `API.md` (data flow, World, settings), `USER_GUIDE.md` and `SETUP.md` (consumer
  sections), `package.json`, `tsconfig.lib.json`, all of `src/lib/world.ts`, `push.ts`, `mesh.ts`,
  `raycast.ts`, `body-commands.ts`, `lifecycle.ts`, `identity.ts`, `capabilities.ts`, `storage.ts`,
  the entry files, `src/avbd3d/gpu/solver.ts` (parameters, `step`, `adapt`, readbacks, storage growth,
  broadphase statics), `radii.ts`, the example startup/loops, `tests-gpu/device.ts`,
  `tools/determinism.ts`, `scripts/interlocking-trial.ts` (head), and Three 0.187.0's
  `Renderer.setAnimationLoop`, `WebGPUBackend` adapter request and `Clock`.
- **Run:** one `node -e` arithmetic check for M-03. No test suite, typecheck, build, benchmark,
  GPU work, browser tab, server or install.
- **Browser:** not used. Every UI recheck below is against merged source; runtime statements are the
  lead's earlier evidence (Apple M4 Max, Metal 3, fallback false) and are labelled as such.
  Pixel appearance, touch, screen reader, no-WebGPU browsers, device loss, M1/GTX 1080 and
  performance remain unobserved.
- **Not read:** `FINDINGS.md` as a whole, the WGSL kernels, the SDF bridge internals, the 2D
  solver, `contacts.ts`, `pool.ts` beyond its header, `storage-budget.ts`. Findings about those
  areas are limited to what the files above prove.
- **Web:** primary vendor pages fetched on 2026-11-09; each matrix row says what was actually read.

## Verdict

**As a demo and research surface it is coherent and honest. As a general physics library it is a
strong, narrow engine: very good at many similar rigid bodies drawn straight from the GPU, and
missing most of the vocabulary a Rapier, Unity or Unreal user reaches for first.**

Strengths, from source:
- The whole step is GPU-resident: one command encoder, indirect dispatch sized on the GPU, no
  per-step readback (`solver.ts:1842-1985`). Storage adapts from a counter read every 10 steps.
- Drawing needs no copy (`BodyMesh` reads the solver buffer, `mesh.ts`).
- The command layer is careful: masked writes, lifetime IDs, stamped reads, destroy and device-loss
  handling, fixed storage and pools (`world.ts`, `identity.ts`).
- Breakable and plastic joints run on the GPU, which Rapier's documented joints do not offer.
- Limits are written down (`RELEASE_0.4.md` capability table and known limitations).

Limits that decide adoption:
- **Everything observable is asynchronous.** Poses, contacts, joint state and rays arrive a frame
  or more later. Gameplay code written against Rapier's synchronous queries does not port.
- **Small vocabulary.** Box, sphere, convex hull (32 vertices), experimental SDF. Fixed and ball
  joints and springs. No hinge, slider, limits or motors; no capsule, compound, static mesh or
  heightfield in the solver; no sleeping, CCD, restitution, damping, sensors or character
  controller (all already listed as unavailable in `RELEASE_0.4.md`).
- **No baked workflow exists yet.** There is no pose cache, no world serialization and no verified
  replay. The observation JSON is a record, not a cache.
- **Input validation is uneven** (M-02, M-03) and one user-callback path can kill a World (M-01).

**Best next demo or workflow:** a headless **pose-capture and playback** example (Slice 3): step a
World in Node + Dawn with fixed steps, read poses every frame, write a small pose track, and play it
back in a plain Three.js `InstancedMesh` with no physics. It uses only the public API, shows the
realtime-to-baked path a DCC user expects, measures the real readback cost, and tells us which
library changes baking actually needs before any format or API is designed.

## 1. Round-1 recheck (G-01 to G-25)

Checked against merged source at `4e594e5`. "Runtime" is the lead's earlier hardware evidence, not
mine. "Needs check" names the smallest observation still missing; none blocks Slice 1–3.

| ID | State | Merged source evidence | Runtime evidence / check still needed |
|---|---|---|---|
| G-01 | Fixed | `examples/basic.html` has title card, status, gallery and source links; `examples/startup.ts` + `try/catch` in the four examples; `tests/example-startup.test.ts` | No-WebGPU message never observed in a browser. See M-05, M-06 for what the fix left |
| G-02 | Fixed | Both interlocking pages link the GitHub `PAIRED_STUDIES.md`; no `../docs/` href remains in any HTML | None needed |
| G-03 | Fixed | `backendParams3D` at `app3d/main.ts:113,189,194,405`; 2D row "Solver · resets settings" (`app2d/main.ts:217`); `solverUnavailable` | Lead observed 17 iterations / −4 gravity survive GPU→CPU→GPU. Disabled CPU option on a GPU-only scene not observed |
| G-04 | Fixed in source | `#notice` and `#no-webgpu` in `index.html:112,133`, `2d.html:45,63` | Needs a browser without WebGPU, desktop and 390 px |
| G-05 | Fixed | Toggle with `pressed`, Step dock button, "· paused" (`app3d/main.ts:387-388,740`; `app2d/main.ts:206-207,459`) | Lead observed Step 0→1 while paused |
| G-06 | Fixed | Every Vite entry has one "Demo gallery" link (counted across all 20 HTML files) | None needed |
| G-07 | Fixed | Limits lines and reworded copy in `catalog.ts`; gear page "Drive speed" | None needed |
| G-08 | Partial | Catalog chips of 9k+ open `&paused=1` and are marked heavy (`catalog.ts:88-91`) | Paused still builds the scene. Page-side guard remains a proposal; see also M-07 |
| G-09 | Fixed in source | `FramingPolicy` (`sdf-released/framing.ts`, `main.ts:124`) | Orbit, then Reset, on a real scene not observed |
| G-10 | Fixed in source | 2D "Reset the camera" → `fitCamera()` (`app2d/main.ts:209`) | Pan, then reset, not fully observed |
| G-11 | Fixed in source | `color-scheme: dark` and shared control rules (`compare.css`, example CSS) | Pixel review unavailable |
| G-12 | Partial by design | `tokens.css`, one title pattern on all 20 pages, brand mark | Full SDF re-skin and viewer dark mode stay **proposals** |
| G-13 | Fixed in source | 12 px floor in the SDF style sheets | Pixel review unavailable |
| G-14 | Fixed | One `CANNONBALL` range (`scene-extras.ts`) | None needed |
| G-15 | Fixed | "Reset solver settings" in both viewers | None needed |
| G-16 | Fixed | Labels, `aria-expanded`, `aria-current`, focus return (`controls.ts`, `viewer-ui.ts`) | Lead observed Escape and focus restore. No real screen reader |
| G-17 | Fixed | `shortcut()` ignores Cmd/Ctrl/Alt (`viewer-ui.ts:35-36`), unit-tested | None needed |
| G-18 | Fixed (concrete parts) | Sticky search row only; docs links absolute | Group-name alignment stays taste |
| G-19 | Fixed | `comparison/labels.ts` + `tests/comparison-labels.test.ts` | None needed |
| G-20 | Fixed | `#progress` line, text instead of the disabled select | Lead observed step, queued push and reset on AVBD |
| G-21, G-22 | Fixed | Titles, sentence-case status | None needed |
| G-23 | Proposal | Native `confirm()` unchanged (`device-budget.ts:126-137`) | Works; in-page version stays a proposal |
| G-24 | Hypothesis, gated | Capture-phase `pointerdown` unchanged (`sdf-showcase/main.ts:149`) | Needs a real touch device before any change |
| G-25 | Fixed | Headless output regions | None needed |

**The new `await renderer.setAnimationLoop(...)`** is correct for the tested Three: in 0.187.0 it is
`async` and awaits `init()` (`Renderer.js:2387-2396`), so an init failure lands in the example's
`catch`. Three 0.186 (inside the declared peer range) was not checked; awaiting a non-promise is
harmless. What it does not cover is failure after startup (M-06).

No round-1 finding regressed. One new inconsistency came out of the recheck (M-07).

## 2. New findings

Severity is for a consumer of the package or a public visitor. Each has a disposition:
**implementable**, **evidence-gated**, **proposal** (larger, tracked), or **already satisfied**.

### Confirmed defects (code-proven trigger)

**M-01 · Medium · implementable · Slice 1 — A throwing listener can permanently fail the World**
- Where: `src/lib/world.ts:1447-1451` (automatic readback stores any rejection in `gpuError`),
  `:1804` (`onBreak` listeners) and `:1817` (`onContact` listeners), both called unguarded inside
  the read.
- Trigger: `world.readbackEvery = 30` and any `onBreak`/`onContact` listener that throws once (a
  null handle, a UI update on a removed element). The read rejects, the rejection becomes
  `world.error`, and every later `update`, `step`, `read` and `BodyMesh` render throws the
  listener's own error. The API documents `error` as device loss or a GPU read failure.
- Also: the rest of that batch's events are lost and `retiredBodies.drain` is skipped. With an
  explicit `await world.read()` the caller sees the rejection but the batch is still lost.
- Fix: call each listener in `try/catch`, finish the batch and the bookkeeping, then surface the
  first listener error: reject the explicit `read()` with it, and `console.error` it for automatic
  readbacks without touching `gpuError`.
- Accept: a GPU test where a contact listener throws once under `readbackEvery = 1`: `world.error`
  stays null, later events arrive, the second listener still gets the first event.
- Confidence: high (source). Not reproduced on a device.

**M-02 · Medium · implementable · Slice 1 — Body creation accepts values that `set` and pools reject**
- Where: `src/lib/world.ts:983-1007` (`add`) copies `position`, `rotation`, `velocity`,
  `angularVelocity` unchecked and never checks `size`, `radius`, `density` or `friction`; the
  `Rigid` constructor and `GpuSolver3D.pack` do not either. `Body.set` validates the same fields
  (`body-commands.ts:6-22`), pool templates validate shape and material (`pool.ts`), and
  `massProperties` is validated (`world.ts:315-318`).
- Trigger: `world.addBox({ size: [1, 1, 1], position: [0, NaN, 0] })`, `addSphere({ radius: 0 })`,
  `addBox({ size: [1, 1] })` (a JS caller) or `density: -1`. Non-finite values reach the body
  buffer, against the repo rule that GPU buffers hold finite floats; a zero-volume dynamic body
  silently becomes mass 0.
- Fix: in `add`, run the initial state through `copyBodyPatch`, and check size/radius positive and
  f32-finite, density finite and ≥ 0, friction finite and ≥ 0, masks 32-bit, reusing the pool's
  checks. Also reject `addJoint(a, a)` (`checkPair` allows it; effect on the solver not traced).
- Compatibility: inputs that were silently accepted now throw. One line in the 0.4 migration notes.
- Accept: a CPU test of the shared validators plus one GPU test that each bad input throws before
  any slot or ID is taken (`bodyStats` unchanged).
- Confidence: high for the missing checks; the downstream damage of NaN was not run.

**M-03 · Medium-low · implementable · Slice 1 — One bad `update()` argument stops time for good; `dt` and `iterations` are unchecked**
- Where: `src/lib/world.ts:1385-1400`, setters at `:806-817`, `World.create` at `:707`.
- Trigger: `world.update(undefined)` or `update(NaN)` (a first-frame delta in plain JS):
  `Math.max(0, NaN)` is NaN, `owed` stays NaN, and every later call runs zero steps with no error
  (checked: `NaN >= 1/60` is false, `Math.min(NaN, dt)` is NaN). `world.dt = 0` makes each update
  run `maxSubsteps` zero-length steps; only `contactMargin` is validated at step time
  (`solver.ts:1691`).
- Fix: treat a non-finite `seconds` as an error (or 0, with a one-time warning); validate `dt`
  (finite, > 0), `iterations` (integer ≥ 1), `maxSubsteps` (integer ≥ 1) and gravity (finite) in
  the setters and in `World.create`.
- Accept: CPU-testable if the accumulator is a small pure function (as `runFixedSteps` already is
  for the interlocking page); otherwise one GPU test.
- Confidence: high.

**M-05 · Low · implementable · Slice 2 — The featured "copy this" example uses a deprecated Three API**
- Where: `examples/basic.ts:71` (`new THREE.Clock()`); Three 0.187.0 warns on construction
  (`three/src/core/Clock.js:61`, deprecated since r183). The `USER_GUIDE.md` sketch assumes a
  `clock` too.
- Fix: use the `performance.now()` delta already in `examples/fresh-project/main.js:36-39`, or
  `THREE.Timer`. Update the guide's sketch to match.
- Accept: no deprecation warning on load; `tests/example-startup.test.ts` still passes.

**M-07 · Low · implementable · Slice 2 — "Heavy" means two different sizes**
- Where: the gallery marks and pauses cases of 9k bodies and up (`catalog.ts:88-91`); the
  side-by-side page marks "(heavy)" only above 20,000 (`comparison/side.ts:65`). `pile-10k` is
  heavy on the gallery and unmarked in the page's own menu, where it also loads unpaused.
- Fix: the page uses the gallery's rule. The gallery files must stay free of outside imports
  (`tests/gallery.test.ts:132-133`), so keep `isHeavyCase` in `catalog.ts`, add the same predicate
  to `comparison/labels.ts` for `side.ts`, and let a test hold the two equal, as
  `comparison-labels.test.ts` already does for labels. Pausing on menu selection is the G-08 page
  guard and stays a proposal.
- Accept: a test that, over all 27 cases, the catalog's heavy set equals the page's.

### Risks and gaps (not proven failures)

**M-04 · Low · risk · implementable (additive) · Slice 1 — `recommendedLimits()` may read a different adapter than the renderer uses**
- Where: `world.ts:594-599` calls `requestAdapter()` with no options; Three's backend passes the
  renderer's `powerPreference` (`WebGPUBackend.js:215-221`).
- Trigger (not reproduced): a two-GPU machine and a renderer created with `powerPreference`. Limits
  taken from one adapter and required on the other can make device creation fail.
- Fix: accept optional `GPURequestAdapterOptions` and pass them through. Additive; say in the docs
  to pass the same `powerPreference` to both.

**M-06 · Low · implementable · Slice 2 — Examples show startup failures but not later ones**
- Where: the frame callbacks in `examples/basic.ts:72`, `sdf-hollow.ts:71`, `sdf-gear.ts:98`,
  `sdf-from-mesh.ts:95` are unguarded; `sdf-hollow.ts:75` has `void world.read(...).then(...)`
  with no `catch`. After device loss `world.update` throws every frame while the status still
  reads "Running", and the loop is not stopped on failure. The viewers and the interlocking page
  handle this (`interlocking-view.ts:160-168`).
- Fix: a small `startup.frame(fn)` wrapper in `examples/startup.ts` that stops the loop and writes
  the error to the status line once; add the missing `catch`. Keep `basic.ts` short.
- Accept: a fixture like the existing startup tests: a callback that throws once leaves the status
  with the message and the loop stopped.

**M-08 · Medium · risk · evidence-gated — A World cannot be run reproducibly, even with fixed storage**
- Where: `world.ts:1422-1446` reads counters every 10 steps and applies them when the read lands;
  `GpuSolver3D.adapt` runs `adaptColors` (colour cap, Jones–Plassmann rounds) before its
  fixed-storage early return (`solver.ts:2073-2077`). The landing step varies run to run.
- Why it matters: replay, baking a shot twice and regression fixtures all need the same input to
  give the same output on one device. `RELEASE_0.4.md` already states same-device determinism
  through `World` is unverified; this is the likely cause, by source reasoning only.
- Gate: a `tools/determinism.ts`-style probe through the public `World` (fixed storage, no reads),
  twice, comparing body buffers. Owner: lead, on qualified hardware.
- If it diverges: the fix is a public switch (apply adaptation at fixed step boundaries, or not at
  all), which is an interface change → proposal P-3, not a routine fix.

**M-09 · Low · doc · implementable · Slice 2 — Query and force semantics that surprise ported code**
- `raycasts` tests every ray against every body slot, twice, and creates five buffers and a bind
  group per call (`raycast.ts:187-221`): cost grows as rays × `bodyCount`, with no broadphase.
  Say so beside the 65,535-ray limit.
- `applyForce(force, point)` keeps the *world* point fixed while the body moves, and repeated calls
  add up until `clearForces` (`push.ts`, `world.ts:442-445`). Unity users expect per-step forces;
  a body-attached thruster needs a readback. One sentence each in `API.md`.
- `update()` drops time past `maxSubsteps` silently and exposes no dropped-time counter; the
  interlocking page had to count it itself (`runFixedSteps`). Document; a counter is additive (P-1).

**M-10 · Low · evidence-gated — Host work that scales with body count on topology change**
- `BodyMesh.refresh` filters all bodies and re-uploads the whole ID attribute whenever
  `world.version` changes (`mesh.ts:156-175`), and pools bump the version on every acquire and
  release. `uploadStatics` re-derives the grid classes over all bodies when any radius or
  fixed/dynamic class changes (`solver.ts:1165-1196`).
- A code pattern, not a measured failure. Gate: a churn measurement (pool of 1k inside 100k bodies)
  before any change. No action now.

**M-11 · Low · evidence-gated — Whole-world readback allocates and copies three times**
- `solver.read` creates a staging buffer per call, slices it, and `readBodies` copies again into
  the snapshot (`solver.ts:2129-2141`, `world.ts:1855-1862`): 160 bytes a body, about 16 MB at
  100k bodies per read. Fine for occasional reads; it is the whole cost of per-frame pose capture.
- Gate: Slice 3 measures it. A reused staging buffer is an internal change; a compact pose
  (28 bytes) gather pass is proposal P-2.

### Already satisfied (no action)

- Destroy, device loss, read-in-flight and renderer-storage ownership paths are handled and tested
  (`world.ts:730-735,1902-1915`, `lib-lifecycle`, `world-contracts` GPU tests).
- Slot reuse, lifetime IDs and stale-handle checks (`identity.ts`, `world-observations` tests).
- The package's five entries, `sideEffects: false`, declarations and the fresh-consumer procedure
  (`SETUP.md`) are in place; publication is separately gated.
- Basic reference vs GPU vs package differences are stated (2D is a reference port outside the
  package; CPU reference is boxes only; `USER_GUIDE.md`, gallery Limits lines).

## 3. The "fast, large-scale web solver" claim

What the implementation is, separated by layer:

| Layer | Implemented | Limit to state with any claim |
|---|---|---|
| AVBD paper (SIGGRAPH 2025, Giles, Diaz, Yuksel) | Rigid bodies, contacts with friction, fixed/ball joints, springs, fracture; plus this port's plastic joints | The paper's cloth and soft bodies are not simulated; "cloth" and "Soft Body" scenes are rigid plates and boxes on joints |
| Convex primitive path | Hash-grid broadphase, box/sphere/hull narrowphase, 8-point manifolds, GPU graph colouring, coloured primal + dual iterations (`solver.ts:1842-1985`) | Cell size follows the median radius; up to 64 bodies above 2× median are tested against everything (`radii.ts`). Wide size ranges are outside the measured envelope. Hulls need 9 storage buffers per stage and ≤ 32 vertices |
| Capacity | Contacts, pairs, manifolds grow at 80 % full to 2× demand from a 10-step counter read (`solver.ts:2073-2088`); colours capped at 64 | Growth lags by design: a sudden pile can overflow between reads, and overflow drops records. Fixed storage never grows |
| Stability aids added by this port | `startAtRest`, `massPenalty`, `matchNearest`, `faceBias`, contact reuse, `contactMargin` | Each changes results versus the reference; default margin rests about 1 cm deep |
| SDF path (Pacific Graphics 2026 method) | Analytic and baked voxel fields, spatial candidates, GPU narrowphase, events, rays | Experimental; adaptive storage only; no activation/reset/pool. Chair, bunny, full-pile and C4 gaps stand as recorded; the C4 transcripts remain not evidence |
| Host cost | No per-step readback; colours × iterations dispatches a step | Counter read every 10 steps; M-10, M-11 on churn and capture |

What can be said today, with its qualifiers: the dated measurements in `COMPARISON.md` (for example
the 110k brick ring at 9.27 ms a step, 4 iterations, M4 Max, headless Dawn) are throughput on one
device for near-uniform boxes. They do not show settling quality at that scale (the 10k pile keeps
outliers, no sleeping), mixed sizes, hull-heavy scenes, the M1/GTX 1080 target, or anything about
being faster than another solver beyond the specific serialized cases recorded there.

**Draft qualification plan (declare before running; not executed):**
1. Scenes, fixed in advance: settled pile 1k/10k, ring 9k/110k, a mixed-size pile (radius ratio
   1:2:8, three equal thirds), a hull pile (32-vertex rocks), a jointed structure under impact,
   and a churn case (pool of 1k in 100k). Same scene builders as `compare-suite`.
2. Settings, fixed: `dt` 1/60, iterations 4 and 10, margin 0.01 and 0.001, adaptive and fixed storage.
3. Quality first, thresholds written before the run: max penetration, bodies at rest at t = 10 s
   and 40 s, energy drift on a standing structure, overflow counters at zero, joint error.
4. Performance only for runs that pass quality: median and p95 step time, counter-read latency,
   memory from `storageInfo`; adapter, driver, browser/Dawn version and commit in every record.
5. Devices: M4 Max (have), M1 and GTX 1080 (required for the stated target; currently missing).
6. Same-device replay (M-08) as a separate pass/fail line.
Owner: lead; reuses STE-3282 trial reporting. No winner or ratio is derived from failed-quality runs.

## 4. Realtime and baked workflows

| Need | Status | Where / what is missing |
|---|---|---|
| Fixed step, bounded catch-up | Native | `World.update`, `maxSubsteps` (`world.ts:1385`) |
| Dropped-time reporting | Glue | Not exposed; the interlocking page counts it itself |
| Render interpolation between steps | Absent | Drawing reads the latest GPU state; no blend factor exposed |
| Continuous forces, impulses, kinematic targets | Native | `applyForce`/`applyImpulse`/`moveTo`; world-point semantics (M-09) |
| Managed substeps | Native | `step({ reuseManifolds })` |
| Headless stepping | Native + glue | `World.create({ device })`; the consumer supplies Dawn (`webgpu` is a devDependency, not shipped) |
| Pose capture | Glue | `await world.read()` per frame; 160 B a body; no compact pose stream (M-11) |
| Contact / fracture event track | Native, lossy | Bounded, counted loss; documented as not supporting replay |
| Deterministic replay | Unknown | M-08; cross-device is declared unavailable |
| Reset to initial state | Glue | Recreate the World from your own scene definition; `body.reset` is per body, standard backend only |
| Serialize / restore solver state | Absent | No snapshot of bodies + joints + warm-start history; Rapier documents `takeSnapshot` |
| Seeded inputs | Glue | The library has no RNG; examples use `Math.random()` |
| Asset mass / inertia / units | Native + glue | SI units; `massProperties`, `principalInertia`, SDF `finalizeSdf`; no scene importer |
| Cache for DCC interop (Alembic, USD, VDB, point cache) | Absent | The observation JSON is a record with stated limits, not an editable world or a cinematic cache |
| Bake UI (frame range, bake, scrub) | Absent | An application concern |

A serialization format, an offline baking pipeline or an interchange exporter is a larger tracked
proposal (P-2). The smallest slice the goal justifies is Slice 3: an example that proves the path
with today's API and measures it.

## 5. Industry comparison

Like is compared with like: three-avbd and Rapier are libraries; Unreal, Unity, Blender, Houdini
and Maya are authoring stacks that wrap one or more solvers. No speed ranking is implied, and
nothing here says three-avbd can or should match an application's feature set.

### Library layer: three-avbd 0.4.0 candidate vs Rapier JS 0.21

Rapier column: the JavaScript 0.21 user guide pages, read 2026-11-09
([rigid bodies](https://rapier.rs/docs/user_guides/javascript/rigid_bodies),
[colliders](https://rapier.rs/docs/user_guides/javascript/colliders),
[joints](https://rapier.rs/docs/user_guides/javascript/joints),
[scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries),
[serialization](https://rapier.rs/docs/user_guides/javascript/serialization),
[determinism](https://rapier.rs/docs/user_guides/javascript/determinism)).

| Capability | three-avbd | Rapier JS 0.21 (documented) |
|---|---|---|
| Where it runs | WebGPU compute; no CPU fallback | WASM on the CPU |
| Body types | Dynamic, fixed, fixed-with-target (`moveTo`) | Dynamic, fixed, kinematic position- and velocity-based |
| Shapes | Box, sphere, convex hull ≤ 32 vertices; experimental SDF (analytic, baked voxel) | Ball, cuboid, capsule, cylinder, cone, convex hull/mesh, triangle mesh, heightfield, round variants; compound mentioned |
| Joints | Fixed, ball, spring; **breakable and plastic on the GPU** | Fixed, spherical, revolute, prismatic, generic; motors on spherical/revolute/prismatic; limits documented for prismatic |
| Forces and impulses | Persistent forces, one-step impulses; world-point | Persistent forces "cleared manually", impulses; damping, gravity scale, axis locking, dominance |
| Material | Friction per body; no restitution or combine rules | Friction and restitution with combine rules |
| CCD | Absent (smaller `dt`) | CCD against fixed colliders, optional per body, soft CCD |
| Sleeping | Absent | Automatic |
| Sensors | Absent | Sensor colliders |
| Filtering | 32 groups + mask | Collision groups and solver groups; contact hooks |
| Events | Begin/end with point, normal, impulse; async, bounded | Collision events, opt-in per collider |
| Ray queries | GPU, async, brute force over bodies | Ray, with filters; examples are synchronous calls |
| Shape cast / overlap / point | CPU, static triangle meshes only (`three-avbd/queries`) | Shape cast, point projection, intersection tests against the world |
| Character / vehicle | Absent | Character controller referenced |
| Snapshot | Absent | `takeSnapshot` / `restoreSnapshot` |
| Determinism | Cross-device not promised; same-device via World unverified (M-08) | "fully cross-platform deterministic" for the JS build, same version and inputs |
| Rendering | Zero-copy instanced drawing from the solver buffer | Application copies transforms |
| Scale evidence | Dated M4 Max measurements, quality-qualified per case (`COMPARISON.md`) | Not assessed here |

### Application layer (what a baked or authored workflow looks like there)

| Stack (version read) | Rigid solver layer | Other solvers in the same stack | Caching / baking | Read status |
|---|---|---|---|---|
| Unreal Engine 5.9 | Chaos: rigid bodies, constraints, destruction with Geometry Collections, Physics Fields | Chaos Cloth (incl. ML cloth), Flesh, hair, fluid, vehicles, ragdoll, networked physics | A "Cache System" under Destruction records per-frame transforms and events for replay | [Physics overview](https://dev.epicgames.com/documentation/en-us/unreal-engine/physics-in-unreal-engine) read; the Chaos Destruction sub-pages returned no article body, so clustering, damage thresholds and the Cache Manager are **not read back** |
| Unity 6.6 (6000.6), built-in | "integration of the Nvidia PhysX engine in object-oriented 3D projects" | Separate 2D engine; data-oriented integrations listed on another page | Not on the page read | [Physics section](https://docs.unity.com/en-us/engine/current/manual/physics-section) read; the integrations page 404'd |
| Unity Physics 1.3.15 (DOTS) | "a deterministic rigid body dynamics system and spatial query system" | — | Not on the page read | [Package index](https://docs.unity3d.com/Packages/com.unity.physics@1.3/manual/index.html) read. **Havok Physics for Unity not read back** |
| Blender 5.2 LTS | Rigid Body World: speed, substeps per frame, solver iterations, split impulse; constraints Fixed, Point, Hinge, Slider, Piston, Generic, Generic Spring, Motor | Cloth, soft body, fluid are separate simulations ("Unlike the other simulations in Blender… works closer with the animation system") | Cache panel: start/end frame, Bake ("Calculates the simulation and protects the cache"), Bake All Dynamics | [Rigid Body World](https://docs.blender.org/manual/en/latest/physics/rigid_body/world.html), [introduction](https://docs.blender.org/manual/en/latest/physics/rigid_body/introduction.html) read. The pages read do not name Bullet |
| Houdini 22.0 | Bullet RBD: box/sphere/composite and convex shapes, concave "not fully supported"; substeps, constraint iterations, sleeping; RBD Bullet Solver SOP with constraint, proxy, collision and guide inputs, emission | Vellum: "extended Position Based Dynamics" for cloth, hair, soft bodies, balloons, grains, fluids. FEM not read | Simulation cache memory limit and checkpoints on the SOP; disk cache nodes not read | [Bullet Solver DOP](https://www.sidefx.com/docs/houdini/nodes/dop/bulletrbdsolver.html), [RBD Bullet Solver SOP](https://www.sidefx.com/docs/houdini/nodes/sop/rbdbulletsolver.html), [Vellum](https://www.sidefx.com/docs/houdini/vellum/overview.html) read |
| Maya (help 2018–2025) | Bullet plug-in: active, kinematic, passive bodies, rigid sets, constraints; rigid bodies on the CPU | Bullet soft bodies (OpenCL for cloth-type); Nucleus/nCloth **not read back** | "Export selection to Alembic" for Bullet objects | Search-result summaries of `help.autodesk.com` pages only; the direct page fetch 404'd. Treat as weaker than the rows above |

What this means for direction, without implying parity:
- Every stack separates **authoring** (constraints between pieces, fields, guides, emission) from
  **solving** and from **caching**. three-avbd has the solver and a zero-copy realtime view; it has
  no cache and no authoring layer, and the nearest-term value is a cache-shaped output (Slice 3).
- The rigid constraint vocabulary every stack shares is hinge, slider, generic 6-DOF, motor and
  limits. three-avbd's fixed/ball/spring set is the clearest library-level gap (P-1).
- Breakable and plastic joints solved on the GPU are a real point of difference next to Rapier's
  documented joints; Unreal's destruction stack covers that ground at application level.
- Soft bodies and cloth are separate solvers everywhere (Chaos Cloth/Flesh, Vellum, Blender cloth,
  Bullet soft bodies). VBD (SIGGRAPH 2024) is the elastic-body method; this repository implements
  rigid AVBD only and should keep saying so.

## 6. Second implementation batch (three non-overlapping slices)

Not started. Model fit is a suggestion; the lead assigns.

| Slice | Fit | Findings | Files it may touch | Must not touch | Checks |
|---|---|---|---|---|---|
| **1 — World input and listener robustness** | Opus 5.5 Medium | M-01, M-02, M-03, M-04 | `src/lib/world.ts`, `src/lib/body-commands.ts` (shared validators), new `tests/world-validation.test.ts`, one new or extended `tests-gpu/world-contracts.gpu.test.ts` case per finding, `docs/API.md` and `docs/RELEASE_0.4.md` (migration lines) | `src/avbd3d/**`, `src/lib/pool.ts` behaviour, examples, site | typecheck; the new CPU tests; `world-contracts`, `world-observations`, `lib`, `lib-lifecycle`, `body-commands`, `pool` GPU tests on a verified hardware adapter; `build:lib` |
| **2 — Example and page consistency** | Sonnet 5.5 High | M-05, M-06, M-07, M-09 (doc lines) | `examples/startup.ts`, `examples/{basic,sdf-gear,sdf-hollow,sdf-from-mesh}.ts`, `tests/example-startup.test.ts`, `src/comparison/{labels.ts,side.ts}` (the gallery catalog is not edited), `tests/comparison-labels.test.ts`, `docs/USER_GUIDE.md` (sketch), `docs/API.md` (query/force sentences, a different section from Slice 1) | `src/lib/**`, solver, viewers | typecheck; `example-startup`, `comparison-labels`, `gallery` tests; site build; one small paused browser look at `basic.html` for the console warning |
| **3 — Headless pose capture and playback example** | Sonnet 5.5 High | Q4 preparation; measures M-11 | new `examples/pose-capture.ts` (Node + Dawn, public API only, refuses fallback adapters as the trial script does), new `examples/pose-playback.{html,ts}` (plain `InstancedMesh`, no World), one catalog entry and thumbnail, `tests/gallery.test.ts` registration, a short section in `docs/USER_GUIDE.md` after Slice 2 lands | `src/lib/**` (if it needs a library change, stop and report), no new package, dependency or exported format | typecheck; gallery tests; one bounded run (≤ 300 steps, ≤ 1k bodies) on verified hardware recording bytes and ms per captured frame |

Interfaces and seams:
- Slice 1 changes no signature except `recommendedLimits(options?)` (additive). New throws are
  listed in the migration notes.
- Slices 1 and 2 both touch `docs/API.md`, in different sections; land Slice 1 first or have one
  worker apply both doc edits.
- Slice 3's track is an **example-local, provisional schema** (`schema`, `dt`, body list with id,
  shape and size, then position + quaternion per body per frame). It is labelled as not a library
  format and not a restorable world. It depends on nothing in Slices 1–2.

## 7. Larger proposals and evidence gates (not routine fixes)

| ID | Proposal | Why not now | Gate / owner |
|---|---|---|---|
| P-1 | Joint vocabulary: hinge with axis, slider, limits, motors, a world-anchored joint (the solver already has world anchors, `setWorldAnchor`, unexposed by `World`); per-body damping, restitution, gravity scale; a dropped-time counter | Public interface and solver math; 0.5 scope | Design note under STE-3003; a paired study per joint type under STE-3282 |
| P-2 | Baked workflow: compact GPU pose gather, a documented pose-cache format, optional USD/Alembic export in a separate tool | New format and possibly a new entry point | After Slice 3's measurements; Steven decides the target DCC |
| P-3 | Reproducible World mode (adaptation at fixed boundaries or off) | Interface change; depends on M-08's result | M-08 replay probe on qualified hardware |
| P-4 | Sleeping / islands | Known limitation; solver architecture | Existing settling evidence in `COMPARISON.md`; no new ticket |
| P-5 | G-08 page-side heavy guard, G-23 in-page confirm, G-12 SDF re-skin and viewer dark mode | Unchanged from round 1 | STE-3288 follow-ups |
| E-1 | G-24 touch orbit | Needs a touch device | Lead / Steven |
| E-2 | Scale qualification (section 3 plan), incl. M1 and GTX 1080 | Hardware not available | STE-3006 / STE-3007 lineage; lead |
| E-3 | M-10 churn cost, M-11 capture cost | Patterns, not failures | Slice 3 and the plan above |

## 8. Status by track

- **UI readiness:** round-1 fixes are in merged source with focused fixtures; remaining items are
  three small consistency fixes (M-05 to M-07) and the unchanged proposals and gates. Pixel, touch,
  screen-reader and no-WebGPU acceptance are still open.
- **Library adoption:** usable for its stated niche. Slice 1 closes the code-proven robustness
  defects. The vocabulary gap (P-1) and async-only observation are the real adoption limits.
- **Cleanup:** none required by this audit. No file, branch, checkpoint or stash was touched.
- **Research qualification:** unchanged. SDF gaps and the C4 evidence status stand; the section 3
  plan is a draft, not a result.
- **Release:** 0.4.0 remains an unpublished candidate. Slice 1 adds migration lines. Nothing here
  is npm or publication approval, and the merge of PR 79 implies none.
- **Human acceptance:** none claimed. Steven has not reviewed this report or the round-1 result.

## Non-goals

No new framework, dependency, package, CI rule or interchange format. No solver rewrite. No
resurrected PR 36 or reconstructed C4 baseline. No "faster than" claim by inference. No feature
parity with any application stack.


## Lead integration — 2026-11-09 (M-01 to M-03)

Opus implementation and lead review address M-01/M-02/M-03 in the pending source patch over
`4e594e5`. Pure `world-validation.ts` checks creation/timing inputs before mutation; initial
poses reuse `copyBodyPatch`. Readback outcomes distinguish completed GPU reads with callback
errors from rejected GPU reads, so all subscribed listeners receive the batch and automatic
callback errors do not poison `world.error`. Explicit reads reject with the original listener
error after bookkeeping. The public signatures remain except the compatible `maxSubsteps`
accessor; invalid input rejection and callback dispatch are documented in the migration notes.

Two audit assumptions were corrected using existing regressions:
- Zero iterations is already used by the library's tests: retain nonnegative safe integers,
  rather than imposing positive-only iterations. Zero integrates without constraint solving.
- World masks accept signed JavaScript bitwise results (`~2`, `1 << 31`) as well as unsigned
  32-bit values. The initial unsigned-only validator failed the existing collision-group test
  and was corrected; pool-template validation is unchanged.

The old joint-safety regression now asserts creation-time NaN rejection, then separately injects
an invalid CPU observation to retain the defensive `rest: 'current'` check. It restores the
pose before GPU submission. No invalid fixture is made physically acceptable.

Lead hardware preflight: Apple M4 Max / Metal 3 / `apple-m4-max`, macOS 26.6.2, fallback false.
Focused CPU checks pass 22/22; typecheck, library build and site build pass. The affected GPU
regression files cover World contracts/observations, library/lifecycle, body commands and pools
plus seven new validation/listener cases. Exact run outcomes and delivery SHA are in the lead
receipt; the initial two integration failures are retained there, not erased. No broad benchmark
or full-suite replay, fresh npm publication, human acceptance, target-device or pixel-level
acceptance is implied. M-04 and M-08/M-10/M-11 remain proposals/evidence gates; the later
example slice and provisional baking workflow have not been delivered by this patch.


### Lead integration — example/runtime slice (2026-11-09)

M-05/M-06/M-07 and missing M-09 guidance are implemented in the pending example patch over
main `a36358d`. Sonnet supplied the bounded example/labels/docs changes; lead review added
six regressions that reproduced queued resize calls into disposed renderers and successful
readbacks overwriting the original stopped-state error. Both are fixed; resize listeners and
owned orbit controls are released, and late readback UI updates are ignored after stopping.

Final focused example/startup, comparison-label, gallery, comparison-side and fresh-project
checks pass 89/89, with typecheck and site build passing. Unchanged World behavior reuses
the preceding 77 hardware GPU tests; no new full suite or broad benchmark was run.

Actual browser probe before the scene: ANGLE Apple M4 Max Metal, WebGPU apple/metal-3,
fallback false. The new QA tab's basic example had 165 live bodies and reached step 543;
its actual World device reported apple/metal-3, fallback false, and its canvas used WebGPU.
Destroying only this newly created QA World produced one error, a persistent alert beginning
`Stopped: World destroyed: update after destroy()`, no canvas and no later stepping; resize
after stop left it stopped. This is an isolated application-failure observation, not device-loss
or performance acceptance. Source/fake checks show no deprecated Clock construction; startup
console output was not captured, so no blanket no-warning claim is made. The paused
`rest-grid-100` comparison showed 100 dynamic/101 total bodies at step 0, two WebGPU canvases
and `10k (heavy)` in the size menu; no heavy case was loaded. Own QA tab was closed.

The API already documented brute-force ray cost, so that text was retained. New force/drop-time
notes describe actual current behavior, not new features. The remaining Clock sketch in
COMPARISON was aligned by the lead. Pixel appearance, real device loss, touch, replay, baked
workflow and target-device performance remain separate gates/proposals.
