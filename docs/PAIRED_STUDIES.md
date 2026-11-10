# Rapier-first paired studies — STE-3282

Steven's direction, 2026-11-08: build each selected demo in Rapier first, then three-avbd.
Use the result to discover strengths, extra application work and adoption/correctness/performance
weaknesses. No preset winner. Related release/adoption work remains in STE-3003; this study is
[STE-3282](https://linear.app/sbobyn/issue/STE-3282), existing M9 release umbrella.

## First study: interlocking sculpture

Run the repository's normal `pnpm dev`, then `/examples/interlocking-rapier.html`.
Rapier0.21.0, Three0.187.0; existing dependencies, hardware WebGPU rendering required.
The scene starts paused. Two already-linked, orthogonal rings hang from a fixed peg;
Play, push the lower ring, orbit, reset, and vary16/32/64convex pieces per ring.
Reset reconstructs only this owned physics world, retaining the camera and selected detail.
It is not possible to pass closed solid rings through each other without an intersection;
the authored linked starting arrangement is intentional, not a linking trick.

The model uses genuine convex-sector compound colliders that preserve the opening, not a
single hull that fills it. Visible meshes remain the same96segment tori at every collider detail.
The tube cross-section approximation uses8sample points; this is disclosed rather than called
exact geometry. Mass and analytic torus principal inertia are specified independently of
collider count; zero-density colliders prevent duplicate mass. Default timestep1/120s,
10Rapier solver iterations, gravity−9.81m/s², friction0.5, restitution0, sleeping/CCDoff.
Rendered geometry has smooth node materials; no graphics/performance result is implied.

Shared authored inputs: `src/comparison/interlocking-scene.ts`. Rapier-specific setup/compound
creation/lifecycle: `src/comparison/interlocking-rapier.ts`. Three.js controls/rendering/report
export: `examples/interlocking-view.ts` (shared between both pages). This separation exposes
engine-specific construction in the two model files rather than counting common UI as physics glue.
The AVBD counterpart is `src/comparison/interlocking-avbd.ts`, using the public World/SDF APIs.
Only the selected engine runs; open Rapier first, then `/examples/interlocking-avbd.html`.

Observation JSON includes exact build/dirty provenance, authored inputs, settings, poses,
steps/push count, dropped simulation time, device/browser/viewport and limitations. It is not a
benchmark or editable-project save. Reset returns to authored initial state; it does not restore
an exported observation. Hidden tabs pause; the loop bounds catch-up to4steps/frame and reports
dropped time. Renderer, controls/listeners, materials/geometry, Rapier world and the owned device
have explicit teardown. No user data, unrelated scene or shared session is reset/disposed.
The page checks the actual initialized Three backend and refuses a WebGL2 fallback rather than
misattributing it to the probed WebGPU adapter. A physics-step/read failure pauses and leaves Reset
available; a renderer failure releases owned resources and asks for an explicit reload. Initial
startup failure also releases resources. A cached Rapier WASM initialization rejection requires
reload; reset retries cannot repair it. Real device-loss/bfcache recovery remains unqualified.

## Evaluate before porting

1. Does contact alone support the linked rings on the peg? No ring-to-ring joints or scripted poses.
2. Can the user clearly see the openings and push/reset without hidden setup?
3. Does changing collider detail alter contacts or visible motion? Preserve awkward/failing cases.
4. Does reinitialization preserve chosen inputs/camera and release old resources?
5. Record actual confusion, documentation/API lookup and extra glue while implementing/reviewing.
   Agent elapsed effort is not a measured human onboarding time.

Device-free CPU tests cover openings at all3detail settings, mass invariance, supported hanging
before a push, finite bounded240step trajectory, reset reconstruction and idempotent world disposal.
They do not certify browser rendering, leak-free repeated browser mounting, arbitrary forces,
long-duration topological preservation or physical correctness. No GPU benchmark was run.

## Matched AVBD counterpart and comparison

The implemented AVBD counterpart reuses authored inputs, visible geometry, actions, initial camera,
render resolution policy and task through public World/SDF entry points. It uses exact analytic torus
fields rotated into the visible/principal body frame, 500 curvature-seed candidates (85 generated
seeds in the current scene), and the same analytic mass/inertia. The peg uses an analytic cylinder;
the floor gets the automatic box field. Reset disposes/recreates this World because body reset with
SDF enabled is unsupported. Setup phases and default collision settings are exported. Memory is
not measured. AVBD native sleeping/CCD are unavailable and restitution is not modelled. Default
SDF alpha 0.01 can introduce drag; do not treat visible damping differences as a solver win.
Both pages currently render ordinary meshes synchronized from poses; AVBD requires async GPU
readback and serializes frame work. This does not exercise its GPU-resident BodyMesh advantage.
No renderer, World or device belongs to an existing user session.

Use true SDFs and matching mass/inertia; log baking/setup memory/time. A smooth SDF and a convex compound are
not identical approximations: expose geometric error and representation budget rather than
pretending piece count equals voxel resolution. Do not count precomputation as free.

Run separate views:
- **Feature/DX:** best supported implementation of the intended behavior in each engine. Record
  missing native features, extra glue, docs/type/dependency friction and lifecycle responsibilities.
  Count engine-specific code separately from common scene/render/UI/test/generated code; LOC is
  a supporting observation, not a quality score. Record actual time/help only when observed.
- **Controlled physics:** identical body mass/inertia, starting poses, timestep, interactions and
  physical intent. Disclose solver settings; equal iteration numbers do not imply equal work or accuracy.
  Controlled sleeping/CCD settings are distinct from a best-supported product configuration.
- **Performance:** only after both meet predeclared behavior/quality criteria. Pin commit/patch,
  package/device/browser/resolution/DPR, seed/input sequence and settings. Separate setup/bake,
  solver CPU encode/step and completed GPU work, CPU pose transfer, queries/events and rendering.
  Alternate serialized runs, warmup/repeats, preserve raw intervals and simulation/wall speed.
  The existing compare-frame/side/physics harnesses provide reusable evidence conventions; a live
  side-by-side view itself is not a benchmark. Don't sum unlike overlapping timers into false totals.

Physical acceptance must include finite state, absence of capacity overflow, no geometry escape,
contact/penetration tolerance and supported hanging/rest behavior—not FPS alone. Define the
geometric tolerance and observation window from both approximations before measurements; numbers
are pending rather than invented here. Never report speed ratios for cases that miss acceptance.

### Quality contract (pose observables, declared before runtime trials)

`src/comparison/interlocking-quality.ts` is device-free and engine-neutral. Input: one simultaneous
`[upper, lower]` pose snapshot in the shape both models already return, plus the representation
(`analytic-sdf` or `rapier-compound` 16/32/64). Pose-only: no velocity, energy, force or contact
data is read or inferred. Criteria (`INTERLOCKING_QUALITY_CRITERIA`) were fixed from the authored
geometry before any trial: penetration limit 0.1·r = 0.016 m, quaternion norm tolerance 1e-4
(as `contact-quality.ts`), the existing endpoint guards upper y > 2.5 and lower y > 1, and a
384×96 ring-surface grid. Do not change them after observing either engine.

- **Fields:** exact analytic torus in the ring body frame (axis z), checked against AVBD's
  axis-y field through `FIELD_Y_TO_BODY_Z`; exact cylinder peg with the shared x-quarter-turn
  peg rotation; floor as its top plane with an exact torus support formula.
- **Pair depth** (ring/ring, ring/peg) samples one ring surface against the other field. Fields
  are 1-Lipschitz, so the true minimum lies within the grid covering radius (≈0.0101 m) of the
  sampled minimum. `separated` and `penetrating` concern the analytic surface only; `within-limit` bounds the deepest
  surface point, not a minimum translation distance; contact inside the bands is `unknown`.
- **Representation band:** the compound is compared with the analytic torus (sector 0 hull vs
  analytic surface, sampled and derived). Measured band 0.0173/0.0135/0.0125 m for 16/32/64 pieces;
  the 8-sample tube cross-section (≈0.0122 m) dominates, so more sectors do not remove it. Every
  compound interval estimate is widened by this band (twice for ring/ring). This is not a proven
  conservative whole-hull bound: `boundCertified:false`, all compound pair/floor/thread verdicts
  remain `unknown` (apart from gross floor escape/off-floor guards). No definite actual-compound
  separation or penetration is inferred. It is representation error, not
  exact SDF error, and evaluates the analytic proxy rather than Rapier's own contact geometry.
- **Topology:** exact plane-crossing linking of the two core circles plus a sampled lower bound
  on core distance. `analyticCoreLinkResolved` means only that the analytic centre-circle link is definite and the
  core-distance lower bound is positive. It does NOT certify solid/compound-body topology. A
  definite link change between observations is a violation; equal links at sparse snapshots do
  not prove no transient pass-through. Peg threading is axis-segment-through-opening per pose.
- **Floor:** exact support height; `off-floor`, `escaped-below`, and `unknown` for edge overhang.
- **Verdicts:** each criterion is `violation`, `no-violation-observed` or `unknown`; invalid
  (non-finite, non-unit, miscounted) poses make every other criterion `unknown`. Qualification
  stays `gated`: these are necessary checks. Height, threading, linking and floor clearance never
  certify contact support, global non-penetration or physical correctness, and bounding-box overlap
  is never a contact result. `summarizeTrial` treats hanging-only guards as observations after a push.

Next: a bounded trial collects both engines' poses through the same input sequence and reports
these observations raw, including `unknown`, before any performance comparison.

### Bounded trial runner (diagnostic, not a benchmark)

`src/comparison/interlocking-trial.ts` (engine/clock/observer-injectable, device-free core) and
`scripts/interlocking-trial.ts` (CLI). One engine per invocation, the same authored inputs: 240 steps
(default; hard maximum 720, minimum 121 so the push happens), pose snapshots at steps
0/60/120/180/240 (final step added when `--steps` is not a multiple of 60), and the impulse applied
after the step-120 snapshot and before step 121. The observer (`observeInterlocking`,
`evaluateHanging`, `summarizeTrial`) runs at snapshots only, never per step or frame. Inputs are
validated before any engine, WASM or device is acquired; the runner owns the fresh model it
acquires and attempts disposal in `finally` after a step, push, GPU-wait, read, observer, summary or
dispose failure (a failed run still emits a report with partial snapshots). A throwing custom clock
can reject the runner, but cannot bypass acquired-model cleanup; unavailable disposal timing is
`null`, never a fabricated zero.

```
node --experimental-transform-types --no-warnings scripts/interlocking-trial.ts --engine rapier --pieces 32 --steps 240 --json rapier-trial.json
node --experimental-transform-types --no-warnings scripts/interlocking-trial.ts --engine avbd --steps 240 --json avbd-trial.json
```

Without `--json` the report goes to stdout. `--json` refuses an existing file. Exit codes: 0
completed, 1 trial failed (report emitted), 2 usage/input refusal, 3 GPU refusal/unavailable.
Rapier needs no GPU. AVBD runs headless through the installed Node Dawn binding, owns the device in
the script (the model destroys only its World), and inspects the actual adapter before any
workload: fallback, software (SwiftShader/llvmpipe/softpipe class) and unidentified adapters are
refused with no override flag, and the adapter metadata is preserved in the report. A binding that
does not report `isFallbackAdapter` is recorded as `null`, accepted only when the hardware identity
is known and not software-like.

**Report** (`three-avbd/interlocking-trial/v1`, JSON): package version and Git head/dirty
provenance (`git-provenance.ts`), authored inputs/mass/criteria, engine settings and version,
representation (analytic SDF, or Rapier compound pieces with `boundCertified:false`), per-snapshot
step/phase/poses/observation/verdict, hanging and after-push summaries, step count, errors with
phase and completed-step count, adapter, limits and cleanup status. Observation keys follow the quality
contract unchanged: `analyticCoreLinkResolved` (centre circles only), `boundsCertified`, unknown
compound geometry, qualification always `gated`. There is no save/restore of simulation state and
no speed ratio, winner, FPS or physical-quality claim.

**Source provenance** (`git-provenance.ts`, also in the browser build and `compare:rapier` head/dirty):
`head` and `dirty` keep their meaning: the checkout's own Git top level must be the project root
(an archive unpacked inside another repository reports `unknown`, not that repository's head), and
unknown provenance is `null`, never clean. For a Git checkout, `changes` adds integer counts from
Git's NUL-separated status — `entries` (`dirty` is exactly `entries > 0`), `tracked`, `untracked`,
`staged`, `unstaged`, `renamed` (one entry per rename pair) and `conflicted` — so tracked
modifications can be told from untracked additions. No path, filename or content is recorded.
Ignored files are not listed by Git's default status and are not counted; an untracked directory is
one entry. Unavailable Git gives a fixed `reason` (`git not found`, `not a Git checkout`,
`not the root of a Git checkout`, `git metadata unreadable`, `git status output too large`), never
Git's raw message. The counts say *what kind* of change makes a build dirty, not *why*: they cannot
identify which files a hosting platform added, and they do not make a dirty build pristine.
`compare:rapier` forwards the same count object as `gitChanges` (null for unavailable metadata).

**Timing** keeps different things apart and never sums them: setup (`acquire()` wall, with the
engine-reported setup phases included in it); CPU step (time inside `step()`: Rapier completes
physics, AVBD only encodes/submits); GPU queue-completion *wait* wall at snapshots (AVBD only;
`null`, not zero, for Rapier; not active GPU time); pose readback wall (AVBD async GPU readback,
Rapier synchronous); observer CPU; whole-trial wall (includes all of those and loop overhead,
excludes dispose); dispose. Raw per-step intervals are kept. A not-run or unavailable timer is
`null`. Rendering is `measured:false`/`null`: no renderer and no GPU-resident `BodyMesh`
comparison. These are single-run wall readings, not warmed, repeated or alternated measurements.

**Native-collider contact observations** (2026-11-10, STE-3282, additive `nativeContacts` per
snapshot; [`interlocking-native-contacts.ts`](../src/comparison/interlocking-native-contacts.ts)).
The analytic evaluator cannot certify Rapier convex compounds, so at the same snapshots only (never
per step) the Rapier adapter queries its actual attached colliders with the installed public
`Collider.contactCollider(other, prediction = 0)` at their current stored poses (not the cached
narrowphase manifolds). Pairs: ring-ring (pieces² sector pairs) and each ring vs peg and floor
(pieces each); same-body and fixed-fixed (peg-floor) pairs are excluded and recorded as such.
Each pair's enumeration is refused (`error`, zero queries for that pair) unless its rings have
the authored 16/32/64 colliders and its peg/floor one; other valid pairs remain observable.
A snapshot runs at most 64² + 4·64 queries. Each pair records
coverage (`expectedQueries`/`queries`), `returnedContacts`, `penetratingContacts` (signed distance
< 0), the minimum finite returned signed distance (`null` without a finite result) and deepest
observed penetration (`null` without a negative result), and `result`: `contact-returned`,
`no-returned-contact` or `unknown`. Rapier may return a
contact with a tiny positive distance at prediction 0; it is recorded, not reclassified. A
non-finite distance makes the pair `invalid`, a throwing query `error` (partial counts kept,
result `unknown`); a failing hook leaves the analytic trial outcome and cleanup unchanged. The
query neither steps nor mutates the world (tested: identical poses, mass and 60-step trajectory).
Its wall time is `timing.nativeContacts`, separate from observer, readback and CPU step.

Limits: per-component diagnostic of actual pairs, not a global compound minimum translation
distance, physical-correctness proof or continuous no-pass-through check; `no-returned-contact` is
never a pass; criteria, verdicts, summaries and `qualification: 'gated'` are unchanged. AVBD has no
native-collider equivalent for its analytic fields: its snapshots record `available: false` with that
reason, and no missing value is compared with Rapier.

## Fix-and-retest loop

Keep raw observations with engine/source/settings and distinguish application mistake, docs/API
friction, missing feature, correctness bug and performance issue. Small known-cause fixes get
focused regression/consumer verification; rerun both on the same case after a material fix and
preserve original baselines. Larger solver/API changes remain explicit proposals with acceptance
and dependencies. Don't tune only AVBD until it wins, weaken a quality threshold or use the
Rapier implementation's accidental mistakes as a selling point. Existing Rapier0.21 soft-body
plasticity/tearing also rules out a blanket “Rapier cannot bend or break” claim.

Next sequence: Rapier interlocking review → matched AVBD implementation → paired evidence →
prioritized fixes/showcase claims. Then consider bend/hold/snap, gear workshop and kinetic/art
studies through the same process; no second large demo is a prerequisite to learning from this one.
Source PR delivery does not authorize a new production deploy or package publication.

## First hands-on task (20–25 minutes)

From your own source checkout, follow the README prerequisites/install and `pnpm dev`;
open `/examples/interlocking-rapier.html`, then `/examples/interlocking-avbd.html`.
Do not run simultaneous views for a timing comparison. If port 5317 is occupied, choose your own
free port explicitly: `pnpm exec vite --host 127.0.0.1 --port 5318 --strictPort`.

1. **5 minutes — contact geometry:** orbit the paused Rapier rings; identify the open holes,
   peg and pre-linked initial arrangement. Play, pause and push. No joint or scripted support.
2. **5 minutes — representation:** reset and try 16/32/64 convex pieces. Visible mesh and mass
   stay fixed. Describe motion/contact differences rather than assuming more pieces wins.
3. **5–8 minutes — AVBD counterpart:** repeat the same actions. Its torus is one analytic field
   per ring, not a compound; note apparent drag, support, jitter and any escape/intersection.
   A fixed 1/120 s is the physics step, not a request to render 120 FPS; at most 4 steps/frame
   drops excess debt and records it. Equal 10 iterations are not equal work or equal quality.
4. **5 minutes — developer experience:** inspect both model files, then reset and save an
   observation JSON. Saving pauses playback. Reset retains camera/detail but restores authored
   inputs; disposal frees this model, and does not destroy the caller-owned device. Report API/
   docs friction and any failure with the exact observation/source/settings. Do not change your
   existing consumer project just for this task.

This task reviews geometry/contact workflow, not a competition score. Next qualification must
predeclare penetration/topology tolerances, record capacity/overflow and longer supported behavior,
then measure serialized matched workloads. Background preview throttling, dropped simulation time
and readback/render cost must remain visible; no FPS ratio is inferred from a review session.
