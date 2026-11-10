# Qualification matrix — predeclared v0 protocol (STE-3354, roadmap S1 first slice)

Status 2026-11-10: **accepted by the accountable lead for bounded implementation**, before any new
trial. Fable source review used `4d2a0fd`; lead review used main `f9562db` (the intervening change
adds CPU `World.droppedTime`, outside these direct-solver rows). Nothing here has run. This is an
engineering protocol, not hardware evidence, Steven acceptance or S1 completion. Criteria change
only by a dated, reasoned amendment that keeps the old verdicts. The report schema remains draft.

Related: [FEATURE_PARITY_ROADMAP](FEATURE_PARITY_ROADMAP.md) §2 item 6, S1, S2, S3, G7;
[COMPARISON](COMPARISON.md) §3–4; [PAIRED_STUDIES](PAIRED_STUDIES.md);
[WORLD_DETERMINISM](WORLD_DETERMINISM.md).

## 1. Rules for every row

1. **Declared first.** Scene, config, capacities, criteria and thresholds are in this file before a
   run. Thresholds are existing source constants or explicit proposals below, never values chosen
   after seeing a new result. Frozen study verdicts (STE-3282 interlocking, SDF records) are not
   replaced or softened by this matrix.
2. **Three answers per criterion.** `pass` and `fail` need a measured value. `unknown` means the
   observer could not honestly decide (window too short, evaluator blind to the case, value not
   exposed). `unknown` is never a pass and never counted as one.
3. **Value states.** `measured`: read from the run, with unit and sample cadence. `notObservable`:
   this harness or API cannot see it (reason given; value `null`). `unknown`: observable in
   principle but not established by this run. `notRun`: declared but not executed.
4. **Failure policy.** Any of these fails the run and keeps the partial record: a non-finite body,
   quaternion norm off by more than 1e-4, counter `overflow` or `clashes` non-zero, an uncaptured
   GPU error, device loss, timeout, or a replay that does not reproduce the timed final snapshot.
   Capacity is never raised and no setting retuned to turn a failure into a pass.
5. **Quality before timing.** A row's timing may be reported only when every *required* criterion
   of that row is `pass`, and the matched workload is identified: same manifest hash, same
   geometry representation, the features actually in effect per engine (sleeping, CCD, margin,
   iterations, storage mode). Equal iteration counts do not mean equal quality or equal work.
   Failed and `unknown` trials stay in the raw record.
6. **Timers stay apart.** Rapier CPU physics; AVBD CPU encode/submit; AVBD queue-completion wait
   (a wait, not active GPU time); readback; render; dropped simulation time. An unavailable timer
   is `null` with a reason. No sum of compile + GPU + readback, no ratio, no winner.
7. **Hardware.** The actual adapter is assessed before any compute (`assessAdapter`); fallback,
   software and unidentified adapters are refused with no override. Every record carries adapter,
   Node/Dawn or browser version, settings, Git head and the unmasked `dirty` flag with change counts.
   A dirty or unknown-provenance run is recorded as such; it is never relabelled clean.
8. **Scope of a pass.** These are necessary engineering checks on sampled states. They are not a
   proof of global non-penetration, contact correctness or physical accuracy. Bounding-box overlap
   is only a candidate filter and is never reported as contact quality.

Not offered by any row: a synchronous current-world GPU query, a replay or checkpoint guarantee, or
cross-device equality. The in-run replay check is two runs in one process on one device.

## 2. Existing parts each row reuses

| Need | Existing symbol (file) |
|---|---|
| Authored scenes, validity labels, hash | `makeScene`, `CASES`, `SCENE_VALIDITY`, `sceneHash`, `jitterScene` (`src/comparison/scenes.ts`) |
| Run + per-step validation replay | `runOne`, `Options`, `DEFAULTS`, `Result`, `validateOptions` (`src/comparison/run.ts`); `runOne` takes an injectable `factory` |
| Engine adapters, fixed capacities | `createAdapter`, `Adapter`, `Settings` (`src/comparison/adapters.ts`): AVBD `GpuSolver3D`, `bodyCapacity n`, `contacts 32n`, `manifolds 8n`, `pairs 32n`, `colors 32`, `adapt:false` |
| Floor and validity metrics | `quality`, `passesFloorTarget`, `FLOOR_TARGET = 0.01`, `STATE_SIZE` (`src/comparison/quality.ts`) |
| Body-pair depth (independent evaluator) | `contactQuality`, `boxDepth`, `sphereBoxDepth` (`src/comparison/contact-quality.ts`) |
| Final-window rest metrics | `finalWindow`, `FINAL_WINDOW = 60`, `REST_SPEED = 0.01`, `SETTLED_MAX_SPEED = 0.05` (`src/comparison/final-window.ts`) |
| Joint and analytic errors | `physicalQuality` (`src/comparison/physical-quality.ts`) |
| Adapter gate, message hygiene, timing conventions | `assessAdapter`, `AdapterRecord`, `sanitizeMessage`, `TrialReport['timing']` shape (`src/comparison/interlocking-trial.ts`) |
| Source provenance | `gitProvenance`, `GitProvenance`, `GitChangeCounts` (`scripts/git-provenance.ts`) |
| CLI host pattern (refuse before GPU import, `wx` report, owned device teardown, exit codes) | `tools/world-determinism.ts`; pure core + fake-host tests: `tools/world-determinism-core.ts`, `tests/world-determinism.test.ts` |
| Public-`World` fixed-storage scene | `authoredScene`, `fixedStorageFor`, `worldSetupFor`, `PROBE_WORLD` (`tools/world-determinism-core.ts`) |
| Serial job runner | `scripts/compare-suite.ts` → `scripts/compare-rapier.ts` |
| Hardware GPU test harness | `gpuTest`, `skip` (`tests-gpu/device.ts`) |
| Feature-row donors | `tests-gpu/avbd3d-gpu.gpu.test.ts` (`GPU: stack and pyramid stand`, `GPU spheres rest, stack, and roll without slipping`, `GPU: spring equilibrium, joints hold, breakable fractures`, `GPU at scale: an 820-brick pyramid…`, `contactMargin: resting contacts sink about one margin deep…`); `tests-gpu/gravity-scale.gpu.test.ts`, `tests/gravity-scale.test.ts` |

Two entry levels exist. The comparison adapters drive `GpuSolver3D` directly (z-up reference
scenes) and do not exercise `World`, its storage plan, adaptation cadence, gravity scale or
dropped-time counter. `World`-level rows use the determinism-probe scene or the feature's GPU tests.

## 3. Required small core — harness v0 (three rows)

Shared declared config, all three rows. Units SI (m, kg, s), z-up, gravity −10 m/s² (the reference
`Solver` default carried in the manifest), friction combine √(μa·μb), restitution 0.

| Item | Value | Source |
|---|---|---|
| Entry | `runOne(engine, makeScene(name), 0, options, device, guard, factory)` | `run.ts` |
| dt / lead / steps / batch | 1/60 s / 0 / 120 / 10 | bound of this slice; scenes are valid as built |
| Final window | last 60 of the 120 steps | `FINAL_WINDOW` |
| Jitter, impact phase | 0, 0 | `DEFAULTS` |
| AVBD config A (shipped default) | 10 iterations, `contactMargin` 0.01 | `World` default iterations; `COMPARISON.md` §4 |
| AVBD config B (documented resting setting) | 10 iterations, `contactMargin` 0.001 | `COMPARISON.md` §4, §7 |
| AVBD capacities | fixed, from the adapter (table above); sleeping none, `adapt:false` | `adapters.ts` |
| Rapier (optional CPU reference, no GPU) | 0.21.0, 10 solver iterations, 1 PGS, sleeping off, CCD off | `adapters.ts`, `PAIRED_STUDIES.md` |
| Repeats | 1 per engine and config | quality observation, not a timing sample |
| Seed | none (`seed: null` in all three manifests) | `scenes.ts` |
| Shape representation | exact boxes and spheres in both engines; no hull, SDF or compound | `adapters.ts` |

A and B are separate verdicts. A `fail` under A is not replaced by a `pass` under B. Prior dated
evidence already suggests A may miss the 1 % depth target on 1 m bodies (resting depth ≈ margin:
10.37 mm single body, 11.3 mm on `rest-grid-1k` at 4 iterations, `COMPARISON.md` §4). That is
disclosed, not a reason to move the threshold.

| Row | Scene (authored in `scenes.ts`) | Bodies |
|---|---|---|
| **Q1** uniform rest | `rest-grid-100`: fixed 400×400×1 floor; 100 unit boxes, mass 1, μ 0.5, in ten independent 10-high columns 2 m apart | 101 (100 dynamic) |
| **Q2** sphere pile, mixed box/sphere contact | `sphere-pile-hcp-100`: fixed 200×200×1 floor; 100 spheres r 0.5, mass 1, μ 0.5, close-packed 8/7/6/5 layers; three fixed rotated wall boxes 1 mm outside the base | 104 (100 dynamic) |
| **Q3** jointed chain | `chain-20`: fixed 200×200×1 floor (μ 0); fixed 0.2 m anchor cube at z 50.1; 20 links 0.2×0.2×1, mass 1, μ 0; 20 spherical joints, jointed pairs do not collide | 22 (20 dynamic) |

Criteria. "Each step" means each of the 120 steps of the validation replay.

| ID | Criterion | Threshold | Source | Q1 | Q2 | Q3 |
|---|---|---|---|---|---|---|
| V1 | Finite state, quaternion norm | 0 non-finite bodies; norm within 1e-4, each step | `quality` | required | required | required |
| V2 | Capacity and colouring | `overflow` 0 and `clashes` 0, each step (AVBD) | `Adapter.inspect` | required | required | required |
| V3 | Timed final state equals replay final state | bitwise | `runOne` `replayMatches` | required | required | required |
| V4 | Manifest hash equals the declared scene's hash; body counts as in the table | exact | `sceneHash` | required | required | required |
| C1 | Floor coverage | 0 `outsideFloorBodies`, each step | `passesFloorTarget` | required | required | required |
| C2 | Floor depth ÷ smallest body dimension | ≤ 0.01, each step | `FLOOR_TARGET` | required | required | recorded |
| C3 | Body-pair depth ÷ smallest dimension of the pair | ≤ 0.01, each step | `FLOOR_TARGET` via `contactQuality` | required | required | **notObservable** |
| R1 | Final-window max linear speed | ≤ 0.05 m/s | `SETTLED_MAX_SPEED` | required | required | recorded |
| R2 | Fraction below 0.01 m/s on the last step | recorded, no threshold | `REST_SPEED` | recorded | recorded | recorded |
| R3 | Centre drift ÷ smallest dimension over ≥ 10 s | ≤ 0.01 | `runOne` `restingTargetMet` | **unknown** (2 s window) | not defined for this scene | not defined |
| J1 | Max joint anchor separation | ≤ 0.05 m, each step | **lead-adopted coarse regression guard**, extended from the existing 5-step adapter check in `tests-gpu/comparison.gpu.test.ts` | — | — | required |
| E1 | Energy, momentum change | recorded, no threshold | `physicalQuality`; `COMPARISON_TEST_STATUS.md` (diagnostics, not conservation errors) | recorded | recorded | recorded |

Notes on what the observers cannot decide:

- J1 keeps 0.05 m as a coarse continuity guard over the longer window. At 25% of a link's
  narrow dimension it is not a visible-quality or mature-constraint target. Report the raw error;
  stronger mechanism-quality criteria belong to G7/K1 before those features claim support.
- C3 on Q3 is `notObservable`: `contactQuality` does not know that jointed pairs ignore collision,
  so its depth between neighbouring links is not a contact result. The raw value is kept, unjudged.
- C2 and C3 measure overlap of the exact box/sphere shapes at the stored poses. They do not see
  the engines' own contact points, forces, friction state or anything between samples.
- R3 needs 600 measured steps. At 120 it stays `unknown`, so **no v0 row can unlock timing**.
- Q2's walls sit 1 mm from the spheres; depth against a wall is judged by C3 like any pair.
- Rapier with sleeping on, and AVBD below 10 iterations, are separate declared configs, not run in v0.

Sampling: the timed pass reads bodies twice (initial, final) and no counters. The replay pass is a
fresh solver that reads counters and all bodies after every step; that disturbance is deliberate
and none of its time is step cost. Readback wall time is recorded on its own.

What v0 answers: the three scenes run inside fixed capacity, stay finite, and their sampled
overlap, rest speed and joint error are on which side of declared limits over 2 s. These are
**short-window numerical and representation observations**. Still open before any speed claim on
these rows: the 10 s resting criterion (R3), longer settling, a matched Rapier configuration that
also passes, repeats with alternating order, and any `World`-level or rendered path.

## 4. Per-feature extensions (one row when the feature lands; not run by v0)

Each reuses its feature's own declared tests as the quality check and adds only the record format.

| Feature | Declared check today (source) | Matrix addition |
|---|---|---|
| Gravity scale (G1, delivered) | `tests-gpu/gravity-scale.gpu.test.ts`: proportional free fall, setter, fixed storage, SDF, pool, slot reuse | Row cites `measurements/gravity-scale-2026-11-10.json`; no new threshold |
| Same-device `World` repeat (F1) | `tools/world-determinism.ts`, 16 bodies, 60 steps, bitwise | Row cites `measurements/world-determinism-2026-11-10.json`; limits unchanged (final fields only, no hidden state) |
| Dropped-time reporting (G1, delivered in PR91) | `tests/world-timing.test.ts` and the packed-World accounting record | Available on `World`; direct-solver rows still report `null` because no frame clock or World is used |
| Damping, restitution, sleeping, CCD, joints v2, colliders, queries, events, bake | their tickets' acceptance tests | One small fixed scene each, thresholds in the ticket before the run |
| Stability (G7) | mass ratio (`stack-heavy`, `chain-heavy`), thin wall, step-size invariance | Thresholds by the lead in G7; existing scenes only |

## 5. Staged, larger and gated rows (declared, `notRun`)

One row per axis, varied one axis at a time from a passing smaller row. No Cartesian product.

| Axis | Row (existing scene unless marked) | Stage | Gate |
|---|---|---|---|
| Uniform 1k | `rest-grid-1k`, `pile-1k-settled` (lead 600, steps 600) | S2 | v0 pass; frozen protocol in `SCENE_VALIDITY` |
| Uniform 10k | `rest-grid-10k`, `pile-10k-settled` | S2 | 1k pass; known 10k settling tail (`COMPARISON.md` §4) stays a finding |
| Uniform 100k | `ring-110k` (standing wall, not a settled pile) | S2 | 10k pass; a declared stand/drift criterion, not yet written |
| Mixed shapes | boxes + spheres beyond Q2; hulls as a labelled extra | S2 | new authored scene needed (`[new]`) |
| Mixed sizes 1:2:8 | `[new]`; `MAX_LARGE = 64` limit from `src/avbd3d/gpu/radii.ts` | S5 | evidence-gated |
| Mass ratios | `stack-heavy`, `chain-heavy`, `impact-1/100/1000` | G7 | thresholds by the lead |
| Joints at scale | `chain-20` → showcase rope/bridge scenes | S2 | Q3 pass |
| Terrain | `[new]`; no heightfield collider exists today | collision stage | feature gate |
| SDF | existing SDF records and protocols under `docs/SDF_*.md` | separate | not gated by, and not gating, standard-backend rows; missing C4 original captures stay blocked (STE-3006) |
| Churn (pool of 1k in 100k) | `[new]` | S4 | evidence-gated |
| Query pressure | `Adapter.raycasts` batches | Q1/Q2 tickets | async batches only |
| Event pressure | `Adapter.watchContacts` / `readContactEvents`; capacity overflow fails | G3/G6 | — |
| Fixed versus adaptive storage | `fixedStorageFor` scene, `growth: 'fixed'` against default | S1 follow-up | adaptation landing step is timing-dependent (`WORLD_DETERMINISM.md`) |
| Rendered frame and dropped time | `compare-frame` page conventions | S2 | hardware browser, verified backend; no WebGL2 or software fallback |
| M1, GTX 1080 | the S2 table | S3 | **unmeasured**, access-gated (D4); never extrapolated from M4 Max |

The STE-3282 compound-geometry helpers (`proposedCompoundSandwich`, `proposedRingPairDepth`) stay
unwired and uncertified. No row depends on them.

## 6. Record shape (proposed `three-avbd.qualification-matrix/0`)

One JSON per invocation, new file only. Fields: `schema`, `status`
(`completed` | `failed` | `refused`), `proposal: true`, `benchmark: false`, `generatedAt`,
`source` (package, `gitProvenance` head/dirty/changes or `unknown` + reason, declared dependencies),
`environment` (runtime, OS, CPU, installed `webgpu`, `AdapterRecord`, required limits),
`rows[]`. Each row: `id`, `scene`, `hash`, `bodies`, `dynamicBodies`, `engine`, `config` (A/B, all
settings and capacities as resolved by the adapter), `run` (the unmodified `runOne` `Result`),
`criteria[]` (`id`, `required`, `state`, `value`, `unit`, `threshold`, `verdict`, `reason`),
`rowVerdict` (`fail` if any required criterion fails; else `unknown` if any required is unknown;
else `pass`), `timing`, `timingReportable` (always `false` in v0, with the reason), `limits`.

`timing` (raw intervals kept, nothing summed across kinds):

| Field | Meaning | When `null` |
|---|---|---|
| `setupMs` | adapter creation to first completion; includes pipeline creation, not separated | setup never completed; reason recorded |
| `rapierStepMs[]` | wall inside `step()`; Rapier completes physics there | AVBD |
| `avbdEncodeMs[]` | wall inside `step()`; encode and submit only | Rapier |
| `avbdQueueWaitMs[]` | wall inside `complete()` per batch; a wait, not GPU active time | Rapier |
| `readbackMs[]` | wall inside `snapshot()` | never |
| `countersReadMs[]` | wall inside `inspect()`, replay pass only; a GPU counters read for AVBD only | never |
| `gpuActiveMs` | not measured: no timestamp query in v0 | always |
| `renderMs` | not measured: headless, no renderer | always |
| `droppedSimulationTimeS` | not applicable: fixed-step loop without a frame clock; the adapter does not reach `World` | always |

Limits of this document: body counts and thresholds are read from source and must be re-derived
by the harness (V4). Quoted prior measurements qualify their own source revisions only. J1 is the
only v0 threshold without an existing constant behind a full window; the lead adopted it as a
coarse guard before trials. Legacy `runOne` combined batch means/quantiles remain nested raw
evidence only, never eligible timing comparisons in v0.

## 7. Implementation brief — S1 harness v0 (ready for a Sonnet worker)

**Goal.** A thin, opt-in Node tool that runs rows Q1–Q3 through the existing `runOne`, judges the
§3 criteria, and writes the §6 record. No new framework, no public API, no solver change.

**Read first.** This file; repo `AGENTS.md`; `src/comparison/run.ts`, `adapters.ts`, `quality.ts`,
`final-window.ts`, `physical-quality.ts`, `scenes.ts`; `tools/world-determinism.ts` and
`-core.ts`; `tests/world-determinism.test.ts`; `tests/comparison.test.ts` (fake `factory`).

**Owned new files only.**
- `tools/qualification-core.ts` — pure, device-free: frozen row and criteria tables (§3, values
  from the named constants, not retyped numbers where a constant exists); argument parsing and
  validation; `instrument(adapter, clock)` wrapping an `Adapter` to time `step`, `complete`,
  `snapshot`, `inspect` separately; `judgeRow(row, result)`; report builder; `refusedReport`.
- `tools/qualification.ts` — CLI host modelled on `tools/world-determinism.ts`.
- `tests/qualification.test.ts` — CPU tests with fakes.

**Do not edit** anything else: no change under `src/`, `scripts/`, `tests-gpu/`, existing tests,
docs, `package.json`, CI or thresholds. If a needed symbol is missing or unexported, stop and report.

**CLI.** `node --experimental-transform-types --no-warnings tools/qualification.ts
[--rows Q1,Q2,Q3] [--engines avbd|rapier|avbd,rapier (default avbd)] [--configs A,B (default A,B)]
[--json <new file>.json]`. No flag changes steps, dt, iterations, capacity or a threshold.
Hard bounds in code: at most 3 rows, 1,000 bodies, 120 steps, 1 repeat; timeout from `DEFAULTS`.
Exit codes as the determinism probe: 0 completed (verdicts are in the report, any mix), 1 execution
failure, 2 usage refusal before any GPU import, 3 GPU refusal or unavailable.

**Behaviour.**
- Options per run: `{ ...DEFAULTS, dt: 1/60, lead: 0, steps: 120, batchSize: 10, repeats: 1,
  avbdIterations: 10, rapierIterations: 10, rapierPgsIterations: 1, avbdMargin: 0.01 | 0.001 }`.
- Pass `runOne` a factory that wraps `createAdapter` with `instrument`; the first adapter of a run
  is the timed pass, the second the replay. Keep raw arrays; do not sum unlike timers.
- `--engines rapier` alone imports no GPU module. With AVBD: `assessAdapter` before
  `requestDevice`; refuse fallback, software and unidentified adapters, no override; device owned
  and destroyed by the tool; uncaptured errors and device loss fail the run through `guard`.
- Runs are serial. A row-local failure keeps the partial record and permits the next row. Device
  loss or a shared GPU error stops GPU execution; remaining selected rows are explicitly `notRun`,
  never attempted on a poisoned device. No successful report is published before owned-device
  drain/destruction finishes and late GPU/teardown errors are checked.
- Missing/non-finite aggregate metrics or incomplete sample coverage are unknown, never a
  numeric zero or a passing criterion. If `runOne` throws during cleanup, retain collected
  timings/observations with an explicit execution failure, not a fabricated completed `Result`.
- Verdicts follow §1–§3 exactly: `unknown` for R3 at this window, `notObservable` for C3 on Q3,
  `timingReportable: false` always. No ratio, ranking, FPS or winner field exists in the schema.
- Provenance through `gitProvenance`; `dirty` and change counts are copied, never altered. Reports
  contain no local path (`sanitizeMessage`) and are written with `wx`.

**CPU tests (fakes only, no device).**
1. Row table: names in `CASES`, `valid` in `SCENE_VALIDITY`; body, dynamic and joint counts from
   `makeScene` equal §3; within the hard bounds; thresholds identical to the exported constants.
2. Fake adapter through `runOne`: a clean run gives `pass` where decidable, R3 `unknown`, Q3 C3
   `notObservable`, Q1 row verdict `unknown`; nothing passes by omission.
3. Injected faults give `fail` or a failed run with the partial record kept: non-finite pose,
   non-unit quaternion, `inspect` throwing overflow, replay mismatch, depth, speed and joint error
   just over their limits; a value exactly at each limit passes.
4. `instrument` with a fake clock: per-kind counts; other-engine fields `null`; `gpuActiveMs`,
   `renderMs`, `droppedSimulationTimeS` `null` with reasons.
5. Refusals: bad arguments, more than 3 rows, existing `--json` target, software or fallback
   adapter record; argument refusals happen before any `webgpu` import.
6. Provenance: a dirty fake stays dirty; unknown provenance stays `null` + reason.

**Worker verification.** `pnpm typecheck` and the one new test file
(`node --experimental-transform-types --test tests/qualification.test.ts`). No GPU, Dawn, browser,
server, build, full suite, install or benchmark. Report failures with output.

**Lead acceptance on qualified hardware (later, not the worker).** J1 and configs A/B are accepted above before any trial. Run one serial invocation on the verified M4 Max adapter from a clean, identified
source: Q1–Q3, AVBD A and B (6 runs of 120 steps), optionally `--engines rapier` on the CPU. Keep
the raw report whatever the verdicts, and file a dated summary under `docs/measurements/`. A `fail`
becomes a finding or ticket, not a retune.

**Delivery and limits.** Mode set by the lead (default local-only until reviewed). No Linear or
publication. The result is a harness and short-window observations on one device: no timing claim
and no `World`-level, rendered, long-run, large-scale or target-hardware qualification.

## 8. Implementation notes — 2026-11-10, before hardware trials

The first runner implements the three new files named above. Rapier runs once per row with
config `R`, explicitly mapped to all selected A/B configurations; its inputs do not vary with
the AVBD margin. Rows skipped after device failure have `execution.status` and `rowVerdict`
`notRun`. Counters-read timings are available only for AVBD; Rapier's CPU inspection is not
labelled a GPU read. Reports retain raw legacy `runOne` data with explicit timing limits.
The draft schema remains `proposal: true` despite lead acceptance of the engineering protocol.

Twenty focused fake-CPU tests and typecheck pass. Lead review added regressions/fixes for
mutable nested protocol records and a timed-pass destroy failure not poisoning the session.
Both failed before the fixes. No solver/default/threshold changed. Actual hardware observations
will be a separately dated, source-qualified record; until then this is tooling, not evidence.

## 9. Bounded observations — 2026-11-10

[Source-qualified record](measurements/qualification-small-2026-11-10.json): clean commit
`80d355c54ce4e4264cc3e4bf2d87943a31bd044f`, predeclared protocol `6d1fb00`, Node25.2.1,
Dawn0.6.1, Rapier0.21.0. AVBD used Apple M4 Max / Metal3, nonfallback, no optional features,
requesting the adapter's reported limits (10 storage buffers). Rapier CPU runs preceded AVBD.
No renderer was created. One trial per scene/configuration; each includes its validation replay.

| Row | Rapier R | AVBD A (0.01 m margin) | AVBD B (0.001 m margin) |
|---|---|---|---|
| Q1 rest-grid-100 | unknown | unknown | unknown |
| Q2 sphere-pile-hcp-100 | pass | **fail C3** | pass |
| Q3 chain-20 | pass | pass | pass |

All nine runs completed; finite/rotation/replay criteria passed and AVBD's inspected overflow
and clash counts were zero throughout the replay. No GPU/cleanup error was reported. Q2 A's
maximum relative pair depth was0.0148603557, above the frozen0.01 target; this remains a finding,
not a reason to retune the run. B is a separate configuration, not a replacement pass. Q1 needs
a ten-second resting window and remains unknown. Chain passes only its coarse declared guard;
excluded jointed-pair contact quality is not judged. Raw reports/logs and their hashes are retained.

No timing comparison is eligible. These results do not qualify the public World API, large scenes,
target hardware, SDF, rendering, physical correctness, a release or Steven's acceptance. S1 and
G7 remain open for their larger, explicit acceptance. No new default is selected by this record.
