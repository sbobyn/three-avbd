# Rapier feature parity and comparison plan

> **Historical record.** Every number below was measured on `b3675de` (0.2.1), before #39, with
> an unmerged speculative-contact branch. None is a current result. This port did not bring over
> the `docs/data/*.json` reports these sections link, the `--speculative` option or the
> speculative sphere-box parameter, so commands that use `--speculative` do not run here.
> (`--avbd-margin` now sets the GPU `contactMargin` added in #55.) Current results need a new
> dated baseline from this branch. For which scenes can back a quality claim, see
> [Settling status](#settling-status-2026-11-02).

## Main-era baseline (2026-11-01)

The first current result, measured at `8064026`: main `0e11c7f` (after the audit fixes, #47) plus
the port, clean tree. Machine: M4 Max, Node and Dawn. Rapier 0.21.0. Settings: 1/60 s, 4 iterations
each, 60 lead steps, 120 measured steps, batch size 10, 3 repeats, Rapier sleeping and CCD off.

```bash
pnpm compare:rapier rest-grid-1k,pile-1k,ring-9k --repeats 3 --machine "M4 Max" --json report.json
```

| Scene (bodies) | Engine | Mean ms/step, median (range) | Worst floor penetration (m) | Pair penetration (m) | Contact target |
|---|---|---|---|---|---|
| rest-grid-1k (1,001) | Rapier | 1.54 (1.49–1.56) | 0.0008 | 0.0052 | met |
| rest-grid-1k (1,001) | AVBD | 1.68 (1.67–2.37) | 0.0113 | 0.0111 | missed |
| pile-1k (1,001) | Rapier | 2.95 (2.85–3.00) | 0.1136 | 0.2053 | missed |
| pile-1k (1,001) | AVBD | 1.50 (1.49–1.67) | 0.1801 | 0.3234 | missed |
| ring-9k (9,132) | Rapier | 67.32 (61.37–98.77) | 0.4285 | 1.2825 | missed |
| ring-9k (9,132) | AVBD | 2.12 (2.01–2.64) | 0.4280 | 0.9614 | missed |

No scene met the shared quality target for both engines, so none of these timings is a matched speed
comparison. AVBD's resting overlap (about 0.011 m) is its fixed contact margin (`COLLISION_MARGIN = 0.01`),
which main does not expose as an option. Rapier's ring-9k timings varied widely between repeats. Every validation replay
matched its timed run. An earlier run on `cd3ce90` (before the audit fixes) gave identical penetration
figures and timings within 4–9% for both engines, which is within run-to-run noise on this machine. The trimmed report is [data/rapier-baseline-2026-11-01.json](data/rapier-baseline-2026-11-01.json)
(scene manifests reduced to hashes, per-step samples dropped; the full report's sha256 is recorded in it).

Browser check (2026-11-01, Chrome on the same machine, `/compare-frame.html`, `sphere-pile-100`,
120 frames, contact events on): both engines ran twice with no errors and the spheres draw as
spheres. After the 30 warm-up frames Rapier reported no contact events (260 during warm-up, then
the pile settled). AVBD reported 174 more (475 during warm-up), identical in both repeats, so its
sphere contacts keep beginning and ending on a pile that should be at rest. That is a
contact-quality finding, not a harness fault. With events on, AVBD's frame work was 4.4–4.9 ms
against Rapier's 1.2–1.4 ms, most of it the event readback (3.7–4.1 ms).

Current harness: schema 5, with independent box/sphere penetration checks, initial-overlap reporting, joint-anchor errors and analytic motion diagnostics. The sections below retain the progression of experiments and their limitations.

Research snapshot: 2026-09-29. three-avbd baseline: `b3675de`, package version `0.2.1`.

## Settling status (2026-11-02)

Which resting and pile scenes can back a quality claim, and why the earlier "piles do not
settle" finding is mostly about the scenes. Everything in this subsection ran on the CPU (the
reference solver in Node, Rapier as WASM); no GPU device was opened. The GPU runs of the corrected
scenes came later the same day: the settling batch in [COMPARISON.md](COMPARISON.md) section 3,
and the [final-window batch](#final-window-resting-metric) below, which shows the GPU solver's
1k pile settling. Per-step traces:
[data/settling-h1-2026-11-02.json](data/settling-h1-2026-11-02.json).

### The earlier evidence, re-read

From the 2026-11-02 margin runs (AVBD GPU at margins 0.01 and 0.001, 60 lead + 120 steps) and the
main-era baseline above:

- **`sphere-pile-100` is not a pile.** It is 25 single-file columns of 4 spheres (r = 0.5 on a
  1 m grid, z = 1–4), an unstable equilibrium with no initial overlap. AVBD's per-step max speed
  sat at about 0.02 m/s for about 60 steps, then grew exponentially from 0.03 to 1 m/s over about
  60 steps (e-fold about 0.3 s; an inverted pendulum of L = 0.5 m has √(L/g) ≈ 0.22 s), then rose
  by exactly g·dt = 0.167 m/s per step (free fall) and bounced at about 6 m/s: the columns
  toppled. Rapier reported 0.000 m/s because its symmetric solve never perturbs the equilibrium.
- **`pile-1k` starts interpenetrating and is measured mid-collapse.** It begins with 119
  overlapping pairs (worst 10.3 cm) and drops from up to 16 m; at the end of the 180 steps Rapier
  was at 10.2 m/s / 1,163 J and AVBD at 8.7 m/s / 989 J. Neither had settled.
- **`rest-grid-1k` does settle in AVBD** (0.008 m/s). Its 11 mm depth is the 1 cm margin; at
  `--avbd-margin 0.001` it met the contact target (4.4 mm floor, 7.1 mm pair).
- The browser observation above (AVBD contact events keep starting and ending on
  `sphere-pile-100` after warm-up) fits the same toppling after about 1 s.

### H1(a): the CPU reference solver on `sphere-pile-100`

The CPU reference (`src/avbd3d/ref`, unchanged) collides every body as a box, so it sees the
spheres as 1 m cubes (`src/avbd3d/shapes.ts`). It was run two ways: as is (a box-column control),
and with the reference's opt-in CPU SDF contacts (`SdfCollisionAdapter`, analytic sphere and box
fields), which keep the same AVBD solver but collide real spheres. 600 steps at 1/60 s:

| Solver (CPU) | Iterations | First step > 0.1 / > 1 m/s | Peak max speed | Top layer z, start → end | Bodies fallen > 0.25 m | Toppled |
|---|---|---|---|---|---|---|
| Reference, box contacts (spheres as cubes) | 4 | 1 / never | 0.65 m/s (step 4) | 4.00 → 3.91–3.96 | 0 | no |
| Reference, box contacts (spheres as cubes) | 10 | 1 / never | 0.33 m/s (step 2) | 4.00 → 3.93–3.96 | 0 | no |
| Reference + CPU SDF sphere contacts | 4 | 1 / 55 | 6.28 m/s (step 143) | 4.00 → 0.13–0.89 | 94 | **yes** |
| Reference + CPU SDF sphere contacts | 10 | 1 / 59 | 5.72 m/s (step 101) | 4.00 → 0.67–1.01 | 80 | **yes** |

With sphere contacts the CPU reference topples at both iteration counts, starting at the same
time as the GPU solver did (step 55–59), with growth of about e per 0.28 s (0.13 → 0.41 m/s
between steps 20 and 40 at 4 iterations). The cause is the scene and the AVBD algorithm's
asymmetric (Gauss–Seidel) solve, not the GPU port. The box-contact control does not topple
because cube columns are stable. Caveat: after the collapse the CPU SDF backend lets rolling
spheres sink into the 200 m floor (the lowest centre is at z = 0.42, under the floor top at 0.5,
by step 240, with speeds held near 5 m/s);
that is a limit of that research backend on this floor, it starts only after the columns have
fallen and does not affect the onset.

```bash
T="node --experimental-transform-types --no-warnings scripts/settling-trace.ts"
$T sphere-pile-100 --engine ref --iterations 4      # also --iterations 10
$T sphere-pile-100 --engine ref-sdf --iterations 4  # also --iterations 10
```

### H1(b): Rapier with 1 mm of jitter

The same scene in Rapier 0.21.0 (CPU, WASM), with and without a seeded horizontal jitter of up
to 1 mm per sphere per axis (`--jitter 0.001`, seed 1; initial worst pair overlap 1.9 mm):

| Rapier | Iterations | First step > 0.1 / > 1 m/s | Peak max speed | Top layer z, start → end | Bodies fallen | Toppled |
|---|---|---|---|---|---|---|
| no jitter | 4 | never / never | 0.05 m/s | 4.00 → 4.00 | 0 | no |
| no jitter | 10 | never / never | 0.01 m/s | 4.00 → 4.00 | 0 | no |
| 1 mm jitter | 4 | 104 / 145 | 7.35 m/s (step 256) | 4.00 → 1.00 | 75 | **yes** |
| 1 mm jitter | 10 | 104 / 145 | 6.59 m/s (step 254) | 4.00 → 1.00–1.63 | 75 | **yes** |

Rapier topples too once the symmetry is broken, so its "settled" `sphere-pile-100` is an
artefact of exact symmetry, not a resting-quality result. During the collapse Rapier (CCD off)
reached 0.081 m floor and 0.048 m pair penetration at 4 iterations. The harness CLI gives the
same trace (it now opens no GPU device when only Rapier runs):

```bash
$T sphere-pile-100 --engine rapier --iterations 4 --jitter 0.001   # also 10, and without --jitter
$T sphere-pile-hcp-100 --engine rapier --iterations 4 --jitter 0.001   # also ref-sdf; 4 and 10
$T pile-1k-settled --engine rapier --iterations 4 --steps 1200        # also ref, pile-10k-settled; 4 and 10
pnpm compare:rapier sphere-pile-100 --engines rapier --rapier-iterations 4 --jitter 0.001 --lead 0 --steps 600 --repeats 1 --json rapier-jitter.json
```

### Scene labels

`SCENE_VALIDITY` in `src/comparison/scenes.ts` records these labels, and the CLI copies them into
each report manifest. `tests/comparison.test.ts` checks that every scene marked valid starts
with no overlapping pair and nothing in the floor.

| Scene | Label | Use for resting/quality claims |
|---|---|---|
| `rest-stack`, `rest-grid-100/1k/10k` | valid (independent box columns, built touching) | yes, as resting columns; they do not test interacting piles |
| `sphere-pile-100` | **unstable equilibrium** (single-file sphere columns) | no; kept for continuity with earlier reports |
| `pile-100`, `pile-1k`, `pile-10k` | **mid-collapse window** (start overlapping; the default 60 + 120 steps end while bodies still fall) | no; timing at a dynamic moment only |
| `sphere-pile-hcp-100` (new) | valid | yes |
| `pile-1k-settled` (new) | valid with `--lead 600 --steps 600` | yes |
| `pile-10k-settled` (new) | valid with `--lead 600 --steps 600` | yes |

- **`sphere-pile-hcp-100`**: 100 spheres in four close-packed triangular layers of side 8, 7, 6
  and 5 (36 + 28 + 21 + 15), each upper sphere in a pocket of three (ABC stacking), inside three
  fixed walls 1 mm outside the base, like a cannonball stack's frame. CPU checks, 600 steps:
  Rapier at 4 and 10 iterations, with and without 1 mm jitter, peaks at 0.04–0.06 m/s in the
  first steps, then ≤ 0.0001 m/s, top layer unmoved (3.449 → 3.447–3.448). The reference with
  SDF sphere contacts also holds (peak 0.46 / 0.19 m/s at steps 2–3 while its 2 cm SDF margin
  pushes the layers apart, final 0.002–0.003 m/s, nothing fallen).
- **`pile-1k-settled`, `pile-10k-settled`**: the same random boxes as `pile-1k`/`pile-10k`
  (seed 12345) at 2.1 m spacing instead of 1.6 m, which clears the largest box's diagonal
  (2 × 1.04 m), so nothing overlaps at the start. The top layer starts at 20.9 m (1k) and 33.5 m
  (10k). Rapier (CPU, 1,200 steps) is below 0.05 m/s from step 462–485 (1k) and 537 (10k, 4
  iterations); in steps 601–1,200 its max speed stays ≤ 0.005 m/s, except 10k at 10 iterations,
  which has isolated events in that window up to 0.09 m/s (steps 601–633, 734–752 and 813–822)
  and a late one from about step 1,140 that reaches 0.25 m/s.
- **AVBD on `pile-1k-settled`, CPU reference (box contacts are exact here)**: it does *not*
  settle within 1,200 steps at 4 or 10 iterations. In steps 601–1,200 the max speed stays between
  0.07 and 3.8 m/s. The motion is a slowly decaying tail of bodies, not one stray body:

  | Reference | Step | Median speed | Bodies > 1 cm/s | Bodies > 5 cm/s | Translational KE |
  |---|---|---|---|---|---|
  | 4 iterations | 600 | 4.1 mm/s | 276 | 49 | 1.75 J |
  | 4 iterations | 1,200 | 2.3 mm/s | 115 | 17 | 0.099 J |
  | 10 iterations | 600 | 1.2 mm/s | 89 | 16 | 0.27 J |
  | 10 iterations | 1,200 | 0.6 mm/s | 61 | 14 | 0.038 J |

  Rapier at both iteration counts had no body above 1 cm/s at steps 600 and 1,200 (KE ≤ 3 × 10⁻⁷ J).
  The reference uses the demo's adaptive warm start, not the GPU solver's `startAtRest`, so this
  says nothing about the GPU solver yet. It does make the scene a real test of H3 and H5 (iteration
  count, rest threshold), which the GPU runs below will start to answer.

```bash
for it in 4 10; do for m in 0.01 0.001; do
  pnpm compare:rapier sphere-pile-hcp-100 --avbd-iterations $it --rapier-iterations $it --avbd-margin $m --lead 120 --steps 600 --repeats 3 --machine "M4 Max" --json hcp-$it-$m.json
  pnpm compare:rapier pile-1k-settled,pile-10k-settled --avbd-iterations $it --rapier-iterations $it --avbd-margin $m --lead 600 --steps 600 --repeats 3 --machine "M4 Max" --json piles-$it-$m.json
done; done
```

These have since run (COMPARISON.md section 3); no resting-quality claim should rest on
`sphere-pile-100` or the unsettled `pile-*` scenes.

### Final-window (resting) metric

The GPU settling batch (2026-11-02; [COMPARISON.md](COMPARISON.md) section 3) found that neither
engine meets the contact target on `pile-1k-settled` or `pile-10k-settled`, Rapier included (worst
pair depth 26–40 cm). Those numbers are the worst over the whole measured window, so the drop's
impacts and transient interpenetration dominate them. Each result therefore also carries a
`finalWindow` record (`src/comparison/final-window.ts`), next to the unchanged worst-over-window
fields (`worstQuality`, `maxContactDepth`, `contactTargetMet`, `measuredContactTargetMet`, …):

- **Window**: the last `--final-window` measured steps (default 60, 1 s at 1/60 s; all measured
  steps if there are fewer). Lead-in steps are never included.
- **Floor / pair depth**: for each window step, the same worst floor penetration and worst
  body–body depth the existing metrics use; the report gives the max and the p95 over the window's
  steps (`maxFloorPenetration`, `p95FloorPenetration`, `maxContactDepth`, `p95ContactDepth`, plus
  the relative maxima). Pair fields are null if any window step was unmeasured.
- **Motion**: `maxSpeed` (fastest body's linear speed on any window step), `maxKineticEnergy`
  (largest total translational KE on any window step), `finalKineticEnergy`, and `restFraction`,
  the fraction of dynamic bodies with linear speed below 0.01 m/s (`REST_SPEED`) on the last step.
- **`contactTargetMet`**: the existing contact target (full floor coverage, floor and pair depth
  ≤ 1 % of the smallest body dimension) holds on **every** window step.
- **`settled`**: `contactTargetMet` and `maxSpeed` ≤ 0.05 m/s (`SETTLED_MAX_SPEED`); null when
  pair depth was unmeasured. Angular velocity is not part of either speed test.

The CLI summary line prints the same fields (`--final-window N` changes the window), and
`/compare-side.html` shows each engine's live at-rest fraction (the page has no per-step history,
so it does not compute `settled`). `tests/comparison-final-window.test.ts` checks, on synthetic
traces, that impacts before the window leave every final-window metric unchanged, that one impact
step inside it is caught, that a single-step spike moves the max but not the p95, and that a
resting trace is reported settled.

**GPU results** (2026-11-02, M4 Max, Node + Dawn, Rapier 0.21.0, PR #65 at `e7d4ce5`, run with the
commands below). The lead is 2,400 steps (40 s): Rapier's piles settle by about step 540
on the CPU, but the AVBD reference was still moving at step 1,200 and the GPU 10k pile was still
moving at the end of a 1,200-step run, so the window is 40–50 s. Quality is identical across
repeats, so the batch ran one repeat; its timings are not headline numbers. Data:
`docs/data/final-window-gpu-2026-11-02-{rapier-4,rapier-10,avbd-4-0.01,avbd-4-0.001,avbd-10-0.01,avbd-10-0.001}.json`
(trimmed like the settling batch: body lists and per-step traces removed, the raw file's sha256
recorded in each).

| Scene | Engine | Iter | Margin | ms/step | Floor max | Pair max | Max speed | At rest | Target | Settled |
|---|---|---|---|---|---|---|---|---|---|---|
| pile-1k-settled | Rapier | 4 | — | 2.72 | 3.0 mm | 12.2 mm | 0.000 | 100% | no | no |
| pile-1k-settled | AVBD | 4 | 0.01 | 1.47 | 14.1 mm | 14.5 mm | 0.073 | 99.5% | no | no |
| pile-1k-settled | AVBD | 4 | 0.001 | 1.45 | 5.4 mm | 5.6 mm | 0.004 | 100% | no | no |
| pile-1k-settled | Rapier | 10 | — | 5.17 | 2.2 mm | 12.7 mm | 0.000 | 100% | no | no |
| pile-1k-settled | AVBD | 10 | 0.01 | 3.37 | 11.7 mm | 21.5 mm | 0.001 | 100% | no | no |
| pile-1k-settled | AVBD | 10 | 0.001 | 3.22 | 3.0 mm | 3.0 mm | 0.001 | 100% | **yes** | **yes** |
| pile-10k-settled | Rapier | 4 | — | 35.98 | 8.1 mm | 39.5 mm | 0.000 | 100% | no | no |
| pile-10k-settled | AVBD | 4 | 0.01 | 1.64 | 17.1 mm | 71.0 mm | 1.109 | 99.4% | no | no |
| pile-10k-settled | AVBD | 4 | 0.001 | 1.63 | 27.8 mm | 32.7 mm | 2.389 | 99.9% | no | no |
| pile-10k-settled | Rapier | 10 | — | 62.62 | 8.9 mm | 31.2 mm | 0.003 | 100% | no | no |
| pile-10k-settled | AVBD | 10 | 0.01 | 3.29 | 12.7 mm | 111.3 mm | 0.132 | 100% | no | no |
| pile-10k-settled | AVBD | 10 | 0.001 | 3.25 | 3.7 mm | 98.3 mm | 1.377 | 100%* | no | no |

Max speed in m/s, the fastest body on any of the 60 window steps; at rest is the fraction below
0.01 m/s on the last step; target is the contact target on every window step; settled adds max
speed ≤ 0.05 m/s. \* Rounds to 100 %; the fast bodies had slowed by the last step (KE 1.0 × 10⁻⁴ J).

- **1k:** after 40 s both engines are at rest. AVBD at 10 iterations with margin 0.001 is the only
  configuration of either engine that meets the contact target: 3.0 mm floor and pair depth.
  Rapier rests with about 12 mm of body–body overlap, which misses the 5 mm pair target. AVBD at 4
  iterations with 0.001 is close (5.6 mm, 0.004 m/s).
- **10k:** Rapier is fully at rest (pair overlap 31–40 mm, target missed). AVBD has 99.4 % or more
  of its bodies at rest, but a few move fast on some window step (1.1–2.4 m/s; 0.13 m/s at 10
  iterations with 0.01), and at 10 iterations the deepest pair is 98–111 mm: a small number of
  moving or stuck bodies, not a pile-wide failure. What they are: [10k outliers](#the-10k-outliers).
- **Speed (same runs, one repeat):** AVBD 1.45–3.4 ms/step at both scales; Rapier 2.7–5.2 ms (1k)
  and 36–63 ms (10k). No configuration meets the target at 10k, so no ratio is quoted there.
- So "AVBD piles don't settle" is wrong as a general statement. At 1k, AVBD (10 iterations, margin
  0.001) settles with less overlap than Rapier; at 10k a few bodies keep moving and some pairs stay
  deeply overlapped.

Run serially, nothing else on the GPU:

```bash
for it in 4 10; do
  pnpm compare:rapier pile-1k-settled,pile-10k-settled --engines rapier --rapier-iterations $it \
    --lead 2400 --steps 600 --final-window 60 --repeats 1 --timeout-ms 3600000 \
    --machine "M4 Max" --json final-window-rapier-$it.json
  for m in 0.01 0.001; do
    pnpm compare:rapier pile-1k-settled,pile-10k-settled --engines avbd --avbd-iterations $it --avbd-margin $m \
      --lead 2400 --steps 600 --final-window 60 --repeats 1 --timeout-ms 3600000 \
      --machine "M4 Max" --json final-window-avbd-$it-$m.json
  done
done
```

### The 10k outliers

Diagnosis **pending** (a per-body dump of the final window, `--dump-movers`).

## Decision

Build toward practical 3D game-physics coverage while measuring the common feature set now. The first deliverable is a reproducible browser comparison, not a claim of total parity. Keep AVBD's GPU-resident simulation and rendering useful as features grow.

There are three separate questions: which features exist, how much time and memory they cost, and what physical error they produce. A stable simulation may still be inaccurate or overly damped. Neither AVBD's algorithm nor a large scene proves this implementation outperforms Rapier.

The roadmap below proposes work. An initial comparison harness now implements the subset described next; it adds no physics features. It covers the public 3D library. Existing 2D reference/demo functionality is not counted as a shipped 3D API feature.

## Initial harness

`pnpm compare:rapier` runs the default 100- and 1,000-box piles in Node with Dawn and pinned
`@dimforge/rapier3d-compat@0.21.0`. `pnpm dev` then `/compare.html` runs the same adapters in the browser.

```sh
pnpm compare:rapier pile-100,pile-1k --steps 120 --lead 60 --repeats 3 --json report.json --machine "my machine"
pnpm compare:rapier ring-9k --steps 60 --repeats 2 --json ring.json
```

Available cases: `pile-100`, `pile-1k`, `pile-10k`, `ring-9k`, `ring-110k`. Counts in the report
include the floor and any projectile. Options include `--avbd-iterations`, `--rapier-iterations`,
`--sleep` (Rapier only), and `--timeout-ms`. Timeouts are cooperative between steps, not a hard
interruption of a blocked WASM call. A missing GPU or failed case produces a nonzero CLI exit.

The harness recreates initial conditions for each repeat, warms disposable worlds, alternates
engine order, matches mass/inertia and effective friction, and checks AVBD overflow/clashes every
step. Capacity is fixed and recorded; overflowing runs fail instead of silently dropping contacts.
JSON contains the complete scene manifest, its deterministic identity, raw timing samples, settings,
environment and initial/final physical diagnostics. Diagnostic reads are outside the step timer.

**Current timing is serialized step-to-completion wall latency.** Every GPU step waits on the queue.
This deliberately measures synchronization latency and cannot establish sustained GPU throughput.
It is also not full-frame timing. Reports contain no speedup ratio. Four iterations in each engine
are not equivalent work, and quality is not matched. Floor penetration only measures the bottom
extent against the horizontal ground plane; it is not body-body penetration or an overall accuracy
metric. Diagnostics are endpoint samples, not guarantees about every intermediate pose.

Still pending from phase 0: SIMD variant, pipelined timing with separately replayed per-step
diagnostics, body-body penetration and joint/analytic quality tests, quality-target tuning,
rendered frame timing, query/readback workloads, memory accounting, and target-hardware runs.
The common case builders use boxes and spheres; hull/joint comparison cases remain planned.

### Initial verification

The first implementation passed `pnpm check`: 63 CPU tests, 54 real-device GPU tests,
typecheck, app build and library build. Browser smoke testing completed the 100-box case in
both engines. CLI JSON export was verified; the in-app browser download automation timed out,
so browser file-download completion is not verified.

Node/Dawn runs on M4 Max completed the 1,000-box pile and 9,132-body ring, with 60 lead-in
steps, 60 measured steps and two alternating-order repeats. At four engine-specific iterations:

| Case | Rapier median latency across repeats | AVBD median latency across repeats | Rapier final max floor penetration | AVBD final max floor penetration |
|---|---|---|---|---|
| 1,001-body pile | 2.44–2.75 ms | 2.25–2.31 ms | 0.0467 m | 0.1012 m |
| 9,132-body ring | 60.73–62.22 ms | 3.09–3.18 ms | 0.0411 m | 0.1842 m |

A separate bounded scale check completed the 110,442-body ring (110,440 bricks, floor and sphere)
in both engines: 30 lead-in and 30 measured steps, one repeat, Rapier first, four engine-specific
iterations. Rapier median/p95 was 998.10/1008.43 ms; AVBD median/p95 was 9.41/11.96 ms.
Final maximum floor penetration was 0.1194 m and 0.3158 m respectively. This shorter window and
single repeat are a scale smoke check, not a replacement for the full protocol or matched quality.

These are exploratory serialized-latency observations, with different physical errors, not
quality-matched performance claims. The next comparison work should tune against declared
quality thresholds and add pipelined timing before public benchmark conclusions.

## Baselines and evidence

Rapier's current JavaScript guide identifies itself as 0.21. Its online API documentation is a moving target. Before implementation, pin the exact published npm version and package variant, inspect its TypeScript declarations, and smoke-test every feature used by the harness. Do not assume online documentation proves availability in an older installed release. Compare the browser/WASM distribution first; native Rust or threaded variants belong in separately labelled experiments.

Local evidence: [public exports](../src/lib/index.ts), [World and body API](../src/lib/world.ts), [GPU raycasts](../src/lib/raycast.ts), [contact events](../src/lib/contacts.ts), [advanced exports](../src/lib/advanced.ts), [GPU solver](../src/avbd3d/gpu/solver.ts), [hull implementation](../src/avbd3d/hull.ts), [existing benchmark cases](../src/avbd3d/bench-cases.ts), [public API tests](../tests-gpu/lib.gpu.test.ts), [hull tests](../tests-gpu/hulls.gpu.test.ts), and [measured findings](FINDINGS.md).

In the tables, **present** means found in the implementation, not freshly runtime-verified. **Partial** identifies a narrower feature or different contract. **Missing** means no equivalent public 3D API was found. These are implementation findings, not benchmark outcomes.

## Feature matrix

### Bodies and materials

Rapier evidence: [RigidBodyDesc](https://rapier.rs/javascript3d/classes/RigidBodyDesc.html), [ColliderDesc](https://rapier.rs/javascript3d/classes/ColliderDesc.html), and [collider guide](https://rapier.rs/docs/user_guides/javascript/colliders/).

| Feature | Rapier documented support | three-avbd 0.2.1 | Work needed |
|---|---|---|---|
| Dynamic and fixed bodies | Present | Present | Compare lifecycle and contacts |
| Kinematic motion | Position- and velocity-based bodies | Partial: fixed-body `moveTo`, prescribed surface velocities | Specify movement, teleport, velocity, and contact semantics |
| Forces, torques, impulses | Present | Present, queued for a step | Verify timing and units in adapters |
| Mass and inertia | Automatic and explicit properties | Partial: shape/density-derived mass properties | Public center-of-mass and inertia overrides |
| Axis locks | Translation and rotation controls | Missing | Constrained degrees of freedom in primal solve |
| Damping and gravity scale | Per-body controls | Missing from public API | Explicit controls with timestep tests |
| Sleeping and waking | Present | Missing automatic sleep/wake API | Island-aware sleeping; `startAtRest` is a warm-start heuristic, not sleeping |
| Restitution | Coefficient and combine rules | Missing configurable bounce | Restitution model with energy and impact tests |
| Friction | Coefficient and combine rules | Partial: friction coefficient and cone solve | Material-combination contract and measured sliding behavior |
| Collision filtering | Collision and solver groups, hooks | Partial: 32-bit membership/masks | Separate detection/response filtering; GPU-friendly rules |
| Sensors | Non-response colliders | Missing | Overlap detection/events without contact forces |
| Runtime changes | Body/collider lifecycle APIs | Present for body adds/removal, state, fixed state and groups | Broader collider editing; stale-handle and queued-write contracts |
| Dominance and per-body solver budgets | Present | Missing | Defer until a concrete consumer needs them |

### Shapes and geometry

Rapier evidence: [collider constructors](https://rapier.rs/javascript3d/classes/ColliderDesc.html). three-avbd evidence: `World.addBox/addSphere/addHull`, hull builder, and GPU narrowphase.

| Shape or capability | Rapier documented support | three-avbd 0.2.1 | Work needed |
|---|---|---|---|
| Boxes and spheres | Present | Present | Immediate comparison cases |
| Convex hulls | Present | Partial: builder caps hulls at 32 vertices; hull collision needs sufficient storage bindings | Publish limits; capability reporting; compare identical cooked geometry |
| Capsules | Present | Missing | High-priority analytic shape for character queries |
| Cylinders, cones, rounded shapes | Present | Missing dedicated primitives | Hull approximation must be labelled; dedicated support later |
| Multiple colliders and compounds | Present | Missing: public body owns one shape | Collider identities, local transforms, aggregate inertia and compound broadphase |
| Triangle meshes and heightfields | Present | Missing | Static-world acceleration and robust edge contacts |
| Segments, triangles, polylines | Present | Missing dedicated public shapes | Lower priority than static terrain |
| Convex decomposition | Present | Missing | Asset cooking after compound support |
| Voxel collider | Listed in current API | Missing equivalent collider; voxel demo uses bodies | Verify pinned package; defer specialized collider |

On insufficient device limits, hull contacts can fall back to bounding boxes. A hull benchmark must confirm the actual hull path and fail or mark unsupported if unavailable; never silently compare hulls with boxes.

### Joints, queries and game integration

Rapier evidence: [JointData](https://rapier.rs/javascript3d/classes/JointData.html), [joint motors and limits](https://rapier.rs/javascript3d/classes/UnitImpulseJoint.html), [scene queries](https://rapier.rs/docs/user_guides/javascript/scene_queries/), [controllers](https://rapier.rs/docs/user_guides/javascript/character_controller/), [World API](https://rapier.rs/javascript3d/classes/World.html), and [serialization](https://rapier.rs/docs/user_guides/javascript/serialization/).

| Feature | Rapier documented support | three-avbd 0.2.1 | Work needed |
|---|---|---|---|
| Fixed and ball/spherical joints | Present | Present, different parameterization | Match anchors and rest orientations |
| Springs | Stiffness and damping | Partial: stiffness/rest length, no public damping option | Damped springs and parameter conversion |
| Hinge, slider, rope, generic joints | Present | Missing public 3D equivalents | Explicit constraint families and limits |
| Motors and joint limits | Present on applicable joints | Missing public 3D equivalents | Position/velocity targets, force limits, compliance |
| Reduced-coordinate articulations | Multibody joint API | Missing | Separate research scope, not ordinary joint parity |
| Breakable joints | Equivalent built-in threshold contract not established in this audit | Present: break threshold, optional pull break, readback event | Treat as three-avbd feature; compare only with explicitly specified Rapier wrapper |
| Closest ray hit | Present | Present: async single/batched GPU queries | Measure latency; current work scales with rays × bodies |
| All ray hits and richer query filters | Present | Partial: nearest hit, masks, at most 16 ignored bodies per call | Result buffers and richer filtering |
| Shape casts, overlap, point and AABB queries | Present | Missing public equivalents | Shared query geometry and spatial acceleration |
| Continuous collision detection | Present; see [CCD guide](https://rapier.rs/docs/user_guides/javascript/rigid_body_ccd/) | Full CCD missing; opt-in sphere-box speculative contacts implemented | Swept/rotational coverage and broader shape support remain |
| Collision events | Collision/force event facilities | Partial: begin/end plus begin impulse, delivered on readback | Sensors, sustained force reporting, overflow and delivery contracts |
| Character controller | Move-and-slide, slopes, steps, ground handling | Missing | Requires capsules/sweeps, static geometry, explicit latency design |
| Vehicle and PID controllers | Present | Missing | Later consumers of queries/forces/motors |
| Save/restore world | Snapshot API | Missing | Versioned snapshot including solver state and handles |
| Debug visualization | Debug-render API | Demo visualization; no equivalent public debug API | Contacts, bounds, joints and failure counters |
| CPU gameplay access | CPU-side API | Async pose/event readback; retained values can be stale | Document freshness, batching, ownership and removal behavior |
| GPU rendering | Renderer integration required | Direct solver-buffer rendering via BodyMesh | Preserve this advantage and measure full-frame cost |
| Soft bodies | Listed in current World API; verify published-version scope | Jointed rigid plates in cloth-like demos, not general soft bodies | Explicitly deferred; do not claim cloth/soft-body parity |

Determinism also needs a qualified comparison. three-avbd findings demonstrate same-device repeatability with fixed adequate capacities and deterministic adjacency ordering; adaptive growth and overflow complicate that guarantee. Do not infer cross-device or cross-engine identical trajectories. Audit the pinned Rapier build's determinism contract separately before making networking claims.

## Proposed implementation sequence

Each phase ends with a usable example, documented limits, and physical-behavior tests. Estimates are relative scope, not delivery commitments. Preserve CPU oracle defaults; add behavior in the public/GPU paths or behind opt-ins. New optional GPU features need fallbacks.

| Phase | Deliverable and dependencies | Acceptance checkpoint | Scope |
|---|---|---|---|
| 0 — Baseline | Version-pinned adapters, scene format, capability checks and first comparison report | Reproduce results from one command/page; publish failures and raw settings alongside timings | Medium |
| 1 — Core contracts | Explicit capabilities; state/event freshness; restitution, damping, material rules, sensors; audit handles and overflow | Drop/bounce, slide, trigger and lifecycle suites; GPU errors and dropped events surfaced | Medium–large |
| 2 — Geometry and queries | Design body/collider separation before compounds; add capsules, query acceleration, overlaps and translational shape casts; static meshes/heightfields | Query results checked against small brute-force fixtures; compound inertia tests; no cracks/snags on terrain seams | Large |
| 3 — Fast motion and FPS slice | Reuse phase 2 sweeps for limited CCD; character movement on static world, steps/slopes/platforms; define dynamic pushing | Speed/thickness tunneling matrix; controller course; report input-to-result latency at scale | Large |
| 4 — Mechanisms | Damped springs, hinge/slider/rope constraints, limits, motors; per-axis body locks | Door, suspension and motor examples; bounded anchor/limit error and motor work | Large; can proceed independently after phase 1 |
| 5 — Scale and reliability | Island sleeping/wake propagation, sustained contact events, diagnostics, snapshots | Settled pile saves work; impacts wake connected bodies; removal/platform motion wake correctly; restart reproducibility | Large; benchmark throughout |
| Later | More shape families, vehicle/PID helpers, specialized collision hooks, articulations, soft bodies | Scope individually after consumer demand and evidence | Separate projects |

Phase 2 is the main architecture decision: compounds and terrain affect body-to-collider mapping, broadphase, feature IDs, event identity, and raycasts. Design it once rather than adding isolated shape flags that later need replacement. Keep the simple one-shape API as a convenience.

For phase 3, prototype GPU controller scheduling before promising FPS suitability. Iterative move-and-slide with repeated CPU↔GPU waits could erase the benefit. Evaluate a GPU-resident controller versus an explicitly limited CPU collision proxy for static geometry; any proxy must expose freshness and dynamic-body interaction limits. Limited translational CCD is not full rotational/general CCD.

The first useful target is large environmental physics with reliable queries and events. A second target is an FPS interaction slice. Full Rapier parity, API compatibility, and synchronous CPU semantics are not interchangeable goals.

Existing related work: [STE-2290](https://linear.app/sbobyn/issue/STE-2290) is the 2D pivot-floor investigation (reproduce first; its ticket requests isolated work); [STE-2266](https://linear.app/sbobyn/issue/STE-2266) concerns advanced exports for the destruction consumer. This plan does not change those tickets or authorize implementation in sibling repositories.

## Comparison suite

### Scenarios

Use a neutral seeded scene description with explicit units, poses, velocities, mass/inertia, shape geometry, material rules and joint frames. Adapt existing benchmark builders into this format instead of maintaining two hand-authored copies. Export actual body counts: the current builder produced 110,440 bricks plus the floor and sphere (110,442 bodies), despite an older source comment saying 110,332 bricks.

| Scenario | Proposed sweep | What it establishes |
|---|---|---|
| Sparse falling bodies | 100, 1k, 10k, 50k, 110k | Integration/broadphase baseline with little contact work |
| Dense box piles | Same sweep where memory permits | Sustained contacts, settling, penetration and throughput |
| Brick-ring smash | Existing 9k and 110k variants | Real showcase load, with pre-impact, impact and settling windows |
| Resting world plus disturbance | Settled pile, then controlled impact | Sleeping advantage, wake latency, realistic active fraction |
| Fixed/ball-jointed assemblies | 100, 1k, 10k joints; selected larger existing cases | Constraint propagation, joint error and cost |
| Hull debris | 100, 1k, 10k; identical hulls under current cap | Narrowphase shape cost and contact quality |
| Gameplay access | 1, 32, 1k rays; 0, 32, 1k, all bodies read per frame | Query latency, transfer costs and frame budget |
| Body churn | Controlled add/remove/impulse batches during motion | CPU staging, allocation, slot reuse and frame spikes |
| Small FPS-style environment | Box/hull approximation initially, 100–1k moving props | Current usable overlap; no claim of controller or mesh parity |

The 506k scene is an optional capacity experiment after the harness works. Scale limits must not delay publishing smaller common cases. Record active bodies and each engine's contact statistics, but do not equate contact-point counts: manifold construction and constraint representations differ.

### Physical quality

Proposed quality targets below must be frozen before comparison runs. Normalize lengths by a declared characteristic body size L. Adjust a threshold only for a documented physical reason, then rerun both engines.

| Test | Measurements | Initial acceptance target |
|---|---|---|
| Free fall | Position/velocity error against analytic motion at 1 s; convergence with timestep | Report error curves; avoid a solver-specific threshold |
| Resting stack | Geometric penetration, drift over last 10 s, residual kinetic energy | Maximum penetration ≤ 1% L; drift ≤ 1% L; no lost bodies |
| Horizontal friction slide | Stopping distance vs v²/(2μg), with matched effective μ | ≤ 5% error in simple isolated test |
| Joint chain/cantilever | RMS/max anchor error, sag, oscillation decay | Maximum anchor error ≤ 1% link length; report sag separately |
| Heavy-on-light stack/chain | Ratios 1, 100, 1k, 10k, 50k; penetration/error, NaNs and ejections | Same stack/joint bounds; zero non-finite states |
| Undamped spring | Period vs 2π√(m/k), amplitude decay and energy drift | Period error ≤ 5%; report numerical damping independently |
| Momentum sanity | Isolated frictionless interactions, no external forces | Report normalized momentum error; distinguish physical dissipation from drift |
| Fast projectile/thin obstacle | Speed and thickness sweep; missed impacts | Zero misses for declared supported CCD scope; current lack recorded |
| Bounce, after restitution exists | Rebound height and inferred restitution | Error ≤ 5% at chosen nonzero target; no unexplained energy gain |

Use analytic solutions where available. For complex scenes, publish behavior metrics and a timestep/iteration convergence study; neither Rapier nor the AVBD reference is universal physical ground truth. The CPU reference proves port fidelity, not superiority. A finite-state check alone is not a physical-accuracy test.

Avoid comparing internal constraint forces without establishing equivalent units and sampling windows. For penetration, use a shared geometric evaluator on readback snapshots in separate quality runs; account explicitly for contact margins and hull geometry. Do not time diagnostic readbacks as pure solver work.

### Fair settings

1. Start at the same outer timestep (1/60 s), with follow-up 1/120 s studies. Log internal substeps, solver iterations, stabilization, CCD, friction rules and all non-default parameters. Equal iteration counts do not mean equal work or quality.
2. Publish three views: default-user experience; minimum time meeting the frozen quality targets; quality achieved within 4, 8 and 16.7 ms physics budgets. Include all tuning candidates and failures, not only the winning configuration.
3. For matched overlap, use zero restitution and matched effective friction, mass, inertia, geometry and initial state. Exclude unavailable features from that comparison rather than substituting hidden approximations.
4. Run both an all-awake controlled workload and an ordinary sleeping-enabled workload where supported. Never disable Rapier sleeping in a settled-scene headline without labelling it.
5. Distinguish collision-only scenes, queries, and full game workloads. CCD-enabled Rapier versus discrete three-avbd is a capability comparison, not equal-work timing.
6. Pin the standard and SIMD Rapier WASM variants if available; report each, with the best applicable supported browser variant prominently. Native/multithreaded runs use separate tables.

### Timing and execution

- Record machine, CPU/GPU, RAM, OS, browser, power mode, adapter limits/features, engine versions/SHAs, package variants, settings, seed and scene hash. Start with M4 Max, then actually measure M1/M1 Pro and an available GTX 1080-class system; never extrapolate their results.
- Warm up WASM/JIT and shader pipelines in a separate world. Recreate the timed scene with the same seed, simulate a fixed lead-in, and measure fixed simulated-time windows. Keep the browser tab foreground and engines running one at a time; alternate run order.
- Start with five repeats per configuration and at least 600 measured steps where feasible. Report median and p95/p99 step/frame times plus between-run variation. Store raw samples. Slow cases get explicit shorter windows/timeouts, not silently fewer simulated seconds.
- For three-avbd, distinguish CPU encoding/submission time, GPU timestamp duration, and completed-step wall time. A queue submission is not completed simulation. Use bounded batches and `queue.onSubmittedWorkDone()` at measurement boundaries; separately measure serialized request-to-completion latency. Do not compare GPU timestamps alone with Rapier's entire CPU frame.
- If GPU timestamps are unavailable, mark them unavailable and retain completed wall timing. For the browser headline, measure sustained frame time including equivalent rendering and required gameplay synchronization.
- Provide a physics-only table and a Three.js rendered table with the same visible geometry, camera, materials, shadows, resolution and pixel ratio. For Rapier, use an efficient instanced upload path, avoiding unnecessary per-object allocations. Include that upload cost; include three-avbd submission and any requested readbacks too.
- Keep setup, asset cooking, shader compilation, memory growth and first-frame latency in separate columns. Report JS/WASM memory and known GPU buffer allocation estimates separately; do not claim portable whole-process peak GPU memory measurements.
- Use a proposed five-minute wall cap per case and capacity checks before allocation. Report timeout, OOM, device loss, unavailable feature, overflow, or quality failure distinctly. A timeout supplies no exact speedup multiplier.

### Results contract

Save machine-readable scene/settings manifests and raw timing/quality records alongside the human table. Each record needs engine/version, scene hash, seed, run, hardware, outer timestep, substeps, iterations, active fraction, sleep/CCD state, completion status, timing mode, sample count, quality metrics, allocation estimates and failure reason.

| Scene / bodies | Quality target met? | Rapier completed ms/step | three-avbd completed ms/step | Full-frame p95 | Quality error | Memory estimate | Ratio |
|---|---|---|---|---|---|---|---|
| Not measured | — | — | — | — | — | — | — |

Compute a speed ratio only when both completed the same workload and met the same declared quality target. Otherwise show failure/timeout or a quality-performance curve. Report simulation throughput per simulated second when timestep/substeps differ. Keep stability, physical accuracy, speed and scale claims separate.

## First implementation batch

1. Pin Rapier npm artifacts and verify its capabilities; add a neutral scene schema and two adapters.
2. Reuse box-pile and brick-ring inputs. Run 100/1k/10k boxes and 9k ring first; check masses, effective friction and initial contacts before scaling.
3. Add independent stack/joint quality measurements, completion-aware timings and JSON export.
4. Run 110k ring and all-awake versus settled/woken piles; record failures without extrapolation.
5. Add same-renderer frame measurements and query/readback workloads. Publish a feature table and reproducibility instructions alongside results.

Expected future locations: shared comparison scenes/adapters under `src/`, a browser comparison page, an optional headless runner under `scripts/`, regression tests, and raw reports under `docs/data/`. Choose exact filenames when implementation starts; do not replace the existing benchmark suite.

For implementation changes, run `pnpm check` (typecheck, CPU tests, Dawn GPU tests, app build, library build), then exercise the real browser comparison. GPU tests skipped for lack of an adapter are not passes. Preserve oracle fixtures and report gate/runtime results separately. Implementation status and measured limitations are recorded below.

## Harness status (2026-10-01)

The browser entry is `/compare.html`; the headless runner is `pnpm compare:rapier`.
Rapier is pinned to `@dimforge/rapier3d-compat@0.21.0`. Both adapters consume identical
serialized box/sphere manifests with matching masses, inertia and effective friction.

Schema 2 measures completed batches (default 10 steps), with a step-weighted mean.
Its p95/p99 are quantiles of **batch-average** step time, not individual frame latency.
Use `--batch-size 1` for serialized completion latency. Lead-in and measured batches
never overlap. Setup and rendering are excluded.

A separate fresh-world replay inspects counters and finite state after every step,
including lead-in, and records floor penetration, normalized depth, the worst body,
box/sphere depths, energy and coverage. Its final snapshot must exactly match the timed
run; mismatches invalidate the result. This conservative reproducibility requirement may
reject nondeterministic backends. Replay time is outside timing samples but inside the case
timeout. Independent rotated-vertex tests validate the floor calculation; edge/off-floor
bodies are reported as lost coverage.

The frozen floor-only target is a maximum depth of 1% of each body's smallest full
dimension (sphere diameter), at every replay step, with valid rotations, finite states
and full floor coverage. This is deliberately narrower than physical accuracy; the
table's proposed resting-stack criterion also needs settled-window drift and body-body
penetration. A floor-only pass does not establish general quality parity.

Examples:

```sh
pnpm compare:rapier pile-100,pile-1k --batch-size 10 --lead 30 --steps 60 --repeats 2 --json report.json
pnpm compare:rapier pile-100 --engines avbd --avbd-iterations 8 --json avbd.json
pnpm compare:rapier pile-100 --dt 0.004166666666666667 --lead 120 --steps 240 --repeats 1 --json timestep.json
```

Iteration counts remain engine-specific. CLI also accepts `--rapier-iterations`,
`--rapier-pgs-iterations`, `--timeout-ms`, `--machine`, and `--sleep`.
When timestep changes, compare time per simulated second over the same simulated duration.

### Tuning observations

On M4 Max, Node + Dawn, all-awake, at 1/60 s, the 101-body pile's four-iteration
worst floor penetration across 90 steps was 0.05391 m for Rapier and 0.08689 m for AVBD.
Final-only values were 0.00180 m and 0.02237 m: endpoints substantially understate impact
penetration. Two fresh runs per engine reproduced the same quality metrics.

The 8/16/32-iteration sweep (one repeat, 30 lead-in + 60 measured steps) did not meet the
1% target on either the 101- or 1,001-body pile. Increasing iterations did not monotonically
improve peak penetration. At 1/240 s with 8 iterations and the same 1.5 simulated seconds,
the 101-body peak relative depths fell to 1.89% (Rapier) and 3.74% (AVBD), still failing.
These are exploratory convergence observations, not quality-matched speed results.

Next: separate settled contact quality from impact behavior; add body-body penetration,
analytic motion/friction tests, and timestep convergence before selecting a matched-quality
configuration. Then run longer repeats and equivalent browser rendering/gameplay workloads.
Do not publish the preliminary throughput ratio as an overall engine-speed claim.

### Repeated large-scene throughput

M4 Max, Node + Dawn, four iterations per engine, 1/60 s, sleeping disabled,
batch size 10, 30 lead-in + 30 measured steps, two repeats in alternating order.
Each replay checked all 60 steps and matched the timed final snapshot exactly.

| Bodies | Rapier mean ms/step (repeat range) | AVBD mean ms/step (repeat range) | Rapier peak floor depth | AVBD peak floor depth | 1% floor target |
|---|---:|---:|---:|---:|---|
| 9,132 | 72.032–72.335 | 2.293–2.514 | 0.32507 m | 0.35874 m | Both fail |
| 110,442 | 1088.985–1104.227 | 10.199–10.779 | 0.56061 m | 0.47390 m | Both fail |

The worst penetrations were boxes, not the large sphere. Quality values repeated
exactly across fresh runs. These short runs have only three timed batches each;
they are exploratory throughput evidence, not robust tail-latency estimates or
a quality-matched speedup claim. Rapier demonstrably simulated the 110k case, but
well below real-time at these settings. No rendered frame-rate conclusion follows.

Raw artifacts from this session: `comparison-batched-rings.json` and
`comparison-quality-tuning.json` (kept outside the repository due to full manifests).

Verification for this iteration: `pnpm check` passed (66 CPU tests, 55 GPU tests
on a real adapter, zero skips, typecheck and both builds). Browser smoke completed
both engines with the new controls/results table. CLI JSON export was verified.
The in-app browser's download-event wait timed out, so browser file export remains
unverified. Vite retains the large comparison-chunk warning from bundled Rapier WASM.

## Isolated contact diagnosis and matching (2026-10-01)

Schema 3 adds `drop-box` (one unit box released with its center at z=3 m) and
`rest-stack` (ten touching unit boxes). An independent 15-axis OBB SAT evaluator
measures minimum separating translation for box pairs, excluding the ground.
It handles containment and rotated boxes without using either engine's contacts.
It is an O(n²) diagnostic limited to all-box scenes with at most 256 bodies;
unsupported scenes report unmeasured, never a contact-target pass.

The all-step contact target requires floor and pair penetration ≤1% of the smaller
body's smallest dimension. The resting target additionally requires center drift
≤1% from the lead-in endpoint throughout at least ten measured seconds. This target
is reported only for the resting-stack case. Rotational drift and general physical
accuracy remain outside this target. Contact energy/speed remain diagnostics.

### Cause and configuration

AVBD's contact constraint adds a 0.01 m margin, permitting approximately that much
normal overlap. The original unit-box 1% target coincides with that allowance.
Reducing timestep or increasing iterations cannot remove the allowance itself.

GPU `contactMargin` is now configurable; its default remains 0.01 m and the CPU
reference is unchanged. The comparison CLI exposes `--avbd-margin` and records
the value. Tests below opt into 0.001 m, retaining the original quality threshold.
This does not imply Rapier and AVBD use identical contact stabilization schemes.

At 1/60 s with four iterations, the default-margin AVBD stack exceeded the contact
bound. Eight iterations and then 1/120 s at four iterations also failed. With the
0.001 m margin, both engines passed the resting target in two fresh runs:

| Ten-box stack, 1/60 s | Rapier, 4 iterations | AVBD, 4 iterations, 0.001 m margin |
|---|---:|---:|
| Worst floor depth across all 720 steps | 0.00080 m | 0.00356 m |
| Worst box-pair depth across all steps | 0.00520 m | 0.00285 m |
| Maximum center drift over measured 10 s | 0.00606 m | 0.00205 m |
| Mean completed ms/step, two-run range | 0.0299–0.0301 | 1.857–2.726 |
| Resting target | Pass | Pass |

These timings cover 120 lead-in and 600 measured steps, batch size 10, all awake.
The variance warrants more timing repeats before publishing a performance claim.

Impact is separate: at 1/60 s both engines failed the drop's 1% penetration target.
At 1/480 s, AVBD still failed even with the smaller margin (0.01166 m peak).
At 1/960 s, both passed over the same two-second impact window, twice:

| Single-box drop, 1/960 s, 1,920 steps | Rapier | AVBD, 0.001 m margin |
|---|---:|---:|
| Peak floor penetration | 0.00008 m | 0.00193 m |
| Mean completed ms/step | 0.00990–0.01104 | 1.740–1.793 |
| Milliseconds per simulated second | 9.50–10.60 | 1670–1721 |
| Contact target | Pass | Pass |

Rapier already passed at 1/480 s; 1/960 s is a shared passing configuration, **not**
the minimum-cost setting for either engine. Do not compare its per-step cost against
a 1/60 s case without accounting for the 16× step count. These tiny cases show
diagnostic correctness and narrow quality matching, not large-scene scalability.

All candidates, including failures, are summarized in
[data/contact-comparison.json](data/contact-comparison.json). Full per-step raw
reports remain in this session's artifacts. Every completed run matched its validation
replay exactly.

Reproduction:

```sh
pnpm compare:rapier drop-box,rest-stack --avbd-margin 0.001 --lead 120 --steps 600 --repeats 2 --json contact-margin.json
pnpm compare:rapier drop-box --avbd-margin 0.001 --dt 0.0010416666666666667 --lead 0 --steps 1920 --repeats 2 --json contact-impact-960.json
```

Next: extend the geometry evaluator to mixed shapes and a scalable candidate-pair
search, then quality-match the larger piles/rings. Add analytic free-fall/friction
and rotational-drift checks before broader accuracy claims.

Verification: final `pnpm check` passed (68 CPU tests, 56 GPU tests, zero skips,
typecheck and both builds). A real browser run with 120 lead-in steps, 600 measured
steps and 0.001 m AVBD margin reproduced both resting-target passes. With only 60
lead-in steps Rapier's drift criterion failed, demonstrating that settling time is
part of the test contract. The page now exposes lead-in and timestep controls.
CLI JSON export is verified; browser file download remains unverified.

## Mixed-shape and larger-scene diagnostics (schema 4)

The independent evaluator now supports box/box SAT, sphere/sphere distance, and
sphere/box closest-point distance, including containment. A sweep-and-prune search
sorts world-space AABBs on their widest overall axis, rejects separated intervals,
then evaluates exact candidate pairs. The ground remains a separate floor metric.
There is no 256-body cutoff and no silent pair truncation. Dense candidate sets can
still be quadratic; diagnostics remain outside timed batches and within the case
timeout. Invalid snapshots yield no contact-target pass.

Analytic tests cover sphere containment and rotated boxes; a seeded 300-body mixed
scene compares swept results against exhaustive pairs. Reports retain candidate
counts, worst pairs, per-step penetration and (for new runs) initial overlap.

The 9,132-body ring starts with zero pair penetration. Its projectile is an 8 m
diameter sphere moving at 30 m/s. With four iterations, AVBD margin 0.001 m,
1/60 s, 30 lead-in + 30 measured steps and two repeats, the worst pair penetration
was 1.21740 m for Rapier and 0.99767 m for AVBD, both at step 12 and involving the
sphere and a brick. Floor-only diagnostics missed this failure. The contact target
fails for both, with pair depths normalized by the smaller brick dimension (0.5 m).

Mean completed batch step times were 69.026–75.091 ms (Rapier) and 1.872–2.624 ms
(AVBD). These remain unmatched-quality throughput observations, not a speedup claim.
The short timing window contains only three batches per run. Both validation replays
matched exactly, with identical peak quality metrics across repeats.

At 1/240 s over the same one simulated second (120 lead-in + 120 measured steps),
two repeats per engine again completed and matched their validation replays:

| 9k ring, timestep | Rapier peak pair depth | AVBD peak pair depth | Rapier peak floor depth | AVBD peak floor depth |
|---|---:|---:|---:|---:|
| 1/60 s | 1.21740 m | 0.99767 m | 0.32507 m | 0.34901 m |
| 1/240 s | 0.57958 m | 0.62029 m | 0.44750 m | 0.17187 m |

Both engines fail the unchanged 1% contact target at both timesteps. Peak pairs
involve the projectile in all runs; smaller timesteps improve that metric but do
not monotonically improve every metric. This is a nonlinear impact scene, not a
resting accuracy test. No relative physical-accuracy ranking follows from one metric.

The refined run's mean times were 66.453–67.674 ms/step for Rapier and
1.773–1.986 ms/step for AVBD; multiply by 240 for milliseconds per simulated second.
All quality peaks reproduced across repeats. These are still short exploratory
windows, and neither configuration qualifies for a quality-matched speedup table.
Reports: [contact-ring-comparison.json](data/contact-ring-comparison.json);
full raw artifacts: `contact-ring9k.json` and `contact-ring9k-refined.json`.

Next diagnostic: an isolated moving-sphere/brick impact with a mass-ratio and timestep
sweep, then reintroduce neighboring bricks and floor contact. Establish why the
projectile overlap remains large before scaling this quality comparison to 110k.
The new evaluator has been exercised on 9,132 bodies; 110k diagnostic cost remains
unmeasured.

Schema 4 verification: `pnpm check` passed (70 CPU tests, 56 GPU tests, zero skips,
typecheck and both builds). The real 9k CLI workflow and JSON export were exercised
at both timesteps. Browser execution was not repeated for this iteration; browser
file download remains unverified.

## Isolated sphere/brick impact diagnosis

Added `impact-1`, `impact-100`, and `impact-1000`. These use the ring's 4 m-radius
sphere at 30 m/s and a 1 × 0.5 × 0.5 m brick, centered at z=10 m, without gravity,
friction or ground contact. Only the projectile/brick mass ratio changes; geometry
and speed stay fixed. The initial surface gap is 1.75 m, so unimpeded first contact
occurs at 1.75/30 seconds. Each run covers 0.25 simulated seconds, no lead-in,
four solver iterations, AVBD margin 0.001 m, and two fresh repeats.

The `--impact-phase` option adds `30 × dt × phase` metres to the initial gap.
It delays collision by that fraction of a timestep, rather than changing velocities.
The shifted manifest and hash are recorded. This is an initial-condition sensitivity
test: the shift in metres differs with timestep. Phase must be in [0,1).

### Timestep alignment matters

At 1/60 s the unshifted collision falls halfway between steps and both engines show
approximately 0.25 m peak overlap. At 1/240 and 1/960 s the unshifted contact lands
on a timestep boundary, so that single initial condition is unusually favorable.
A half-step shift exposes much larger penetration in several cases.

| Equal-mass impact | Rapier peak depth, phase 0 / 0.5 | AVBD peak depth, phase 0 / 0.5 |
|---|---:|---:|
| 1/60 s | 0.25000 / 0.00647 m | 0.25375 / 0.00624 m |
| 1/240 s | 0.00615 / 0.06673 m | 0.00377 / 0.06567 m |
| 1/960 s | 0.00392 / 0.00000 m | 0.00099 / 0.01646 m |

The common 1% target here is 0.005 m (the brick's smallest dimension is 0.5 m).
At 1/960 s, all three mass ratios pass for both engines in the unshifted case;
in the shifted case Rapier passes all three, while AVBD fails all three
(0.01646–0.01744 m). These observations are not a comprehensive CCD comparison,
and no claim is made that all Rapier collision settings are equivalent to AVBD's.

Increasing projectile mass from 1× to 1,000× does not reproduce the ring's
approximately metre-scale penetration in this isolated test. That suggests the
multi-body impact contributes to the larger ring errors, but does not yet identify
its cause. Only two contact alignments were sampled; passing them is not a
phase-independent accuracy guarantee.

### Finite-iteration error is a separate issue

Endpoint snapshots are retained for impact cases. With zero external forces,
total linear momentum should be conserved even when restitution is zero. The
report computes `norm(Pfinal - Pinitial) / norm(Pinitial)` from shared masses and
snapshot velocities. Energy loss alone would not establish a momentum error.

For the half-step-shifted, equal-mass 1/960 s case:

| AVBD iterations | Relative momentum error | Peak penetration |
|---|---:|---:|
| 4 | 4.6967% | 0.016459 m |
| 16 | 0.001532% | 0.015625 m |
| 64 | 0.000769% | 0.015625 m |

The 16-iteration result supports incomplete solver convergence as a contributor
to the momentum error; it does not prove the absence of other errors. Rapier's
momentum error in this sweep remained at float-rounding scale. At large mass ratios,
normalizing by total momentum can conceal errors in the lighter body's velocity;
the endpoint velocities are retained and should be inspected too.

The residual AVBD overlap is half of `30/960` metres. Its peak is at step 57,
the first sampled state after analytic contact at step 56.5. The GPU pipeline
generates contacts before the position-solving phase. Together, this supports a
discrete contact-detection timing limitation that more iterations alone cannot
remove. This is separate from the momentum convergence result.

All 76 runs completed and reproduced their validation replays. Full settings,
endpoints and derived diagnostics are retained in
[data/impact-comparison.json](data/impact-comparison.json). Timing windows are short
and these runs are diagnostic experiments, not a published speed comparison.

Reproduction (repeat with phase 0 and 0.5, and dt/steps pairs 1/60 + 15,
1/240 + 60, and 1/960 + 240):

```sh
pnpm compare:rapier impact-1,impact-100,impact-1000 --impact-phase 0.5 --avbd-margin 0.001 --dt 0.0010416666666666667 --lead 0 --steps 240 --repeats 2 --json impact-phase-960.json
pnpm compare:rapier impact-1 --engines avbd --avbd-iterations 16 --impact-phase 0.5 --avbd-margin 0.001 --dt 0.0010416666666666667 --lead 0 --steps 240 --repeats 2 --json impact-iterations-16.json
```

Next implementation priority: motion-aware contact generation (speculative or swept
contacts/CCD), with these phase-shifted impacts as regressions. Keep the CPU oracle
unchanged and gate new behavior behind an opt-in setting. Add a momentum-quality
criterion and iteration presets before returning to claims of large-scene quality parity.

Impact-sweep verification: `pnpm check` passed (72 CPU tests, 56 GPU tests, zero
skips, typecheck and both builds). All 76 CLI runs completed, exported JSON and
matched their validation replays. Browser execution was not repeated in this
iteration; browser file download remains unverified. Solver behavior was not
changed by this diagnostic batch.

## Opt-in speculative sphere-box contacts

The GPU solver now exposes `params.speculativeSphereBox` (default false).
The comparison CLI uses `--speculative`, and the browser has an experimental
checkbox. The CPU reference remains unchanged.

For a sphere and an ordinary box, a conservative motion-expanded candidate test
includes pairs whose current closest-point gap is closing within the next step.
The narrowphase creates a speculative constraint at the current closest points.
Relative linear velocity and relative gravity displacement determine the closing
distance; the positive normal gap remains available travel rather than being
scaled down by penetration stabilization.

A dedicated sphere-to-all-boxes scan avoids missing fast small spheres outside
the original neighboring grid cells. It respects collision masks and ignored pairs,
and emits predictive pairs separately to prevent duplicate constraints. Its cost
is O(number of spheres × number of bodies), so this first version is intended for
a few projectiles, not sphere-heavy scenes. Existing pair/contact capacity errors
remain failures rather than silently truncated passing results.

This is **not full CCD**: it uses current normals and does not sweep angular motion,
hulls, sphere-sphere pairs or arbitrary curved trajectories. Conservative planes
can obstruct grazing paths that would miss a corner. These are scope limitations
to investigate before treating the feature as a general gameplay replacement.

The default solve and speculative solve use separate compiled primal/dual variants.
This preserves default-mode arithmetic; adding runtime speculative arithmetic to
the shared solve had caused the existing irregular-hull regression to fail.
The original test was retained, and separating variants restored its pass.
Mode changes invalidate manifold history. Custom solve shaders cannot enable
this built-in feature; attempting it reports an error.

Regression coverage includes phase-shifted overlap, fast small spheres crossing
a thin static box, full allowed travel before impact (preventing premature braking),
receding and tangential motion, collision masks, and unchanged default hull behavior.

Recommended diagnostic configuration remains 16 iterations and a 0.001 m margin:

```sh
pnpm compare:rapier impact-1,impact-100,impact-1000 --engines avbd --speculative --avbd-iterations 16 --impact-phase 0.5 --avbd-margin 0.001 --dt 0.0010416666666666667 --lead 0 --steps 240 --repeats 2 --json speculative-impact-final.json
```

A smaller penetration bound alone does not establish physical accuracy or momentum
conservation. Use the saved endpoint states and prior momentum checks alongside it.
Next: measure the 9k ring with this mode, add grazing/rotating-target cases, and
replace the all-box scan before testing workloads with many spheres.


Final shader-variant results: two runs each at mass ratios 1:1, 100:1 and 1,000:1,
1/960 s, half-step-shifted contact, 16 AVBD iterations and 0.001 m margin all
passed the contact target. Peak pair penetration was 0.0010002–0.0010003 m.
For equal masses this replaces the discrete 16-iteration result of 0.015625 m.
Relative momentum errors ranged from 0.000205% to 0.002295%; no general accuracy
claim is inferred. All six final runs reproduced their validation replays.

The final browser workflow also completed the equal-mass unshifted impact at
1/60 s: AVBD peak pair depth was 0.00101 m with the opt-in mode, 16 iterations and
0.001 m margin. The comparison's Rapier run used four iterations and its recorded
defaults; this is not a tuned CCD comparison. Timing samples were short and variable,
so this batch establishes the contact behavior, not a performance result.

Final report: [speculative-impact-comparison.json](data/speculative-impact-comparison.json).
The earlier `speculative-impact.json` artifact predates the positive-gap correction
and is superseded. Verification: final `pnpm check` passed (72 CPU tests, 59 GPU
tests, zero skips, typecheck and both builds), plus the browser workflow. The
default-mode hull regression was fixed without changing its assertion. Browser file
download remains unverified.

## Speculative contact limits: ring, grazing and angular motion

Matched AVBD controls on M4 Max: 16 iterations, 0.001 m margin, 1/60 s,
30 lead + 30 measured ring steps, two repeats per mode. Both modes reproduced
validation replays exactly and both failed the quality targets.

| 9k ring mode | Mean ms/step, two runs | Peak pair overlap | Peak floor overlap |
|---|---:|---:|---:|
| Discrete | 15.581 / 16.361 | 0.93201 m | 0.78423 m |
| Speculative sphere/box | 38.674 / 30.675 | 0.70473 m | 0.55136 m |

The mode reduces these peak overlaps but does not solve the ring's quality problem.
These short, sequential batches establish a measured cost increase here, not a
portable performance ratio. No new Rapier result or quality-matched speedup is claimed.

Two new manifests isolate limitations with one 1/60 s step (zero lead, two repeats,
same AVBD settings). Endpoint states are essential: overlap alone misses false contacts.

- `impact-graze`: radius 0.2 m sphere travels from (0.71, -2, 10) at
  (0, 240, 0) past a static unit box. The whole path clears by 0.01 m. Discrete
  motion reaches the expected (0.71, 2, 10). Speculative motion ends near
  (1.07683, -0.62018, 10), with velocity (22.00955, 82.78890, 0): substantial
  false braking and deflection. Its penetration target passes, but its free-motion
  diagnostic **fails**. A tangent plane at the starting closest point obstructs a
  trajectory that misses the actual rounded box.
- `impact-rotate`: a 4 × 0.2 × 0.2 m dynamic blade rotates toward a stationary
  radius 0.2 m sphere at (1, 1, 10). Initial linear velocities and gravity are zero.
  Both modes miss the approaching angular contact and end with 0.30 m overlap.
  The current predictor has no angular sweep.

All 12 runs completed and matched their validation replay exactly. One-step timing
includes too much startup noise to compare performance. Portable results, settings,
manifests and grazing endpoint diagnostics are in
[speculative-edge-comparison.json](data/speculative-edge-comparison.json).

Reproduce each command with and without `--speculative`:

```sh
pnpm compare:rapier ring-9k --engines avbd --speculative --avbd-iterations 16 --avbd-margin 0.001 --lead 30 --steps 30 --repeats 2 --json ring.json
pnpm compare:rapier impact-graze,impact-rotate --engines avbd --speculative --avbd-iterations 16 --avbd-margin 0.001 --lead 0 --steps 1 --repeats 2 --json edges.json
```

Next: replace the closest-point plane heuristic with a swept sphere/box intersection
for translation, and add angular motion bounds/contact detection. Require both
penetration and no-contact trajectory checks before promoting this mode. Then
profile candidate generation and repeat the matched ring measurement. Keep this
mode opt-in; the isolated head-on successes do not imply general CCD coverage.

Verification after adding these diagnostic scenes: `pnpm check` passed with
73 CPU tests and 59 GPU tests, zero failures/skips, typecheck and both builds.
This gate validates existing behavior and the independent diagnostic geometry;
it does not make the recorded grazing/angular failures pass. No solver arithmetic
was changed in this follow-up.

## Expanded validation program (2026-10-01)

The current test inventory and remaining limits are tracked in
[COMPARISON_TEST_STATUS.md](COMPARISON_TEST_STATUS.md). `scripts/compare-suite.ts`
runs serial jobs and writes full reports and execution logs. Schema 5 adds joint
manifests and independent physical diagnostics. Rapier CCD is now explicitly
configurable with `--ccd` and a browser checkbox; previous reports retain their
original settings.

The opt-in sphere/box predictor now checks the translated sphere segment against
the rounded box: bounded convex-distance minimization rejects misses, followed by
bisection for the first crossing and its normal. This fixes the recorded 1 cm-clear
side pass. It is a finite-precision translational sweep, not full angular CCD.
Default solver settings remain unchanged. Tests retain the head-on, thin-box,
receding and masking checks and add grazing, oblique and small-projectile cases.

### First larger shared-quality pass: independent resting columns

Four iterations per engine, AVBD margin 0.001 m, Rapier CCD requested, no sleeping,
1/60 s, 120 lead-in + 600 measured steps, two alternating repeats. Each scene is
separate ten-box columns, not a connected pile. Both engines passed the full-run
1% penetration target and ten-second resting drift target in every run below.

| Dynamic boxes | Rapier mean ms/step | AVBD mean ms/step |
|---|---:|---:|
| 100 | 0.159–0.169 | 1.655–1.978 |
| 1,000 | 1.460–1.464 | 1.535–2.608 |
| 10,000 | 17.451–17.962 | 1.601–1.728 |

This is evidence of roughly 10× lower simulation cost for AVBD at the declared
narrow quality target in the 10k all-awake case. It does not prove full physical
accuracy, interacting-pile equivalence, or a general engine speedup. A sleeping
Rapier control is a separate workload and must be reported alongside it.

### Analytic motion exposes implementation errors

Over two seconds, starting at z=100 m, free-fall position error at 1/60 s was
0.04170 m for Rapier and 0.16174 m for AVBD. At 1/240 s it was 0.01051 m and
0.25696 m respectively. AVBD's position error did not converge under refinement;
position/velocity reconstruction at f32 precision is a hypothesis to investigate,
not an established diagnosis. The finite-state/contact target alone passes these
free-flight cases and must not be mistaken for an analytic accuracy pass.

For a unit box sliding at 5 m/s with effective friction 0.5 and gravity 10 m/s²,
the analytic stop distance is 2.5 m. Maximum trajectory errors over two seconds:
Rapier 0.01061 m / 0.00260 m at 1/60 / 1/240 s; AVBD 0.04208 m / 0.01093 m.
For principal-axis spinning of an isotropic cube at 2 rad/s, maximum orientation
errors were 0.000076 / 0.000399 rad for Rapier and 0.03283 / 0.00863 rad for AVBD.
These values measure this implementation and configuration, not a theorem about
either solver family.

The subsequent precision diagnosis reproduces both z=100 AVBD endpoints exactly
with a small `Math.fround` recurrence (`scripts/diagnose-free-fall.ts`): predict
`z = f32(f32(z + f32(v*dt)) + f32(g*f32(dt*dt)))`, then reconstruct
`v = f32(f32(z - previousZ)/dt)`. It gives z=79.8382568359375 at 60 Hz and
z=79.7430419921875 at 240 Hz, exactly the measured GPU values. This localizes the
unconstrained free-fall error to the f32 prediction/position-difference recurrence;
it is not a contact-solver failure. The same model predicts smaller errors near
the origin, but that offset variant has not yet been GPU-tested. No solver fix for
this precision issue is claimed.

### Controls and long-duration results

The expanded local matrix completed **156 runs in 21 reports**, each with an exact
validation replay. One angular job initially failed to launch because the suite's
option-override code matched the numeric value `16`; flag-only overrides fixed it,
and the job was rerun through that driver. The original launch log is retained.
Execution success does not mean every physical criterion passed.

With Rapier sleeping enabled, the 10k-column case still passed contact and resting
targets, ended with zero active bodies, and took **1.171–3.584 ms/step**. That overlaps
the earlier AVBD 1.601–1.728 ms range and removes a clear throughput winner across
these short runs. Keep this control alongside the all-awake result, not in a footnote
when making a gameplay recommendation. Longer timing repeats are needed to explain
the sleeping run's variance.

Heavy-chain peak anchor errors over ten seconds (20 links, 1,000× end mass):

| Engine / iterations | Peak joint error | Approx. mean ms/step, first repeat |
|---|---:|---:|
| Rapier / 4 | 0.69721 m | 0.032 |
| AVBD / 4 | 0.11984 m | 1.612 |
| Rapier / 16 | 0.04359 m | 0.203 |
| AVBD / 16 | 0.02856 m | 6.459 |
| Rapier / 64 | 0.00272 m | 0.515 |

Thus AVBD's lower error at the same iteration count is not a cost-matched win:
tuned Rapier was both cheaper and more accurate in this small joint test. In the
heavy-stack test AVBD retained lower overlap, but neither engine met the unchanged
contact criterion; more Rapier iterations did not monotonically improve that case.

Over two measured minutes (plus two-second lead-in), both resting-stack configurations
passed. In the force-free spin case, AVBD lost **67.0%** of total kinetic energy and
Rapier gained **0.65%**. AVBD's maximum orientation error reached approximately π
(the orientation-distance metric wraps at π). The result demonstrates substantial
numerical damping, not physically accurate long-term spinning. No new integration
behavior has been enabled to hide it.

The initially passing two-second sphere pile did not remain an AVBD pass over ten
seconds: peak pair overlap reached 0.09366 m in discrete mode and 0.06524 m with
speculative sphere/box contacts. Rapier stayed at 0.00169 m and passed. The speculative
mode does not sweep sphere/sphere contacts. The five-projectile train also failed the
contact target in both engines (0.17585 m Rapier, 0.21782 m AVBD peak pair overlap).
This scene sends multiple projectiles; it does not yet count distinct impact events.

Angular target sweep over the same 1/60 simulated second:

| Timestep | Rapier peak overlap (CCD requested) | AVBD peak overlap (speculative) |
|---|---:|---:|
| 1/60 s | 0.29645 m | 0.30000 m |
| 1/240 s | 0.08610 m | 0.06615 m |
| 1/960 s | 0.00289 m | 0.06721 m |

All fail the 0.002 m pair threshold set by the blade's thickness. Increasing Rapier's
CCD substep budget to eight at 1/60 s did not change that coarse result. AVBD still
needs angular contact handling; the translational grazing fix does not address it.

At 1/60 s the new AVBD translation sweep passed head-on impacts at 1:1, 100:1 and
1,000:1 ratios for both sampled contact phases (~0.00100–0.00102 m). Rapier with CCD
requested still failed this penetration criterion (~0.25 m / 0.00647 m by phase).
That is a penetration result for these settings, not an overall accuracy win:
AVBD's equal-mass relative momentum error reached 0.315%, while Rapier remained
at rounding scale. Broader speed/angle/shape coverage is still needed.

Compact results, raw timing samples, settings, environment and scene hashes:
[expanded-validation.json](data/expanded-validation.json). Full scene manifests and
per-step samples are retained in this session's raw artifacts. CLI process memory
is recorded separately from physical quality; RSS includes the harness and runtime
and is not a portable peak-GPU-memory comparison.

### Rendered application workflow

`/compare-frame.html` exercises the existing Three.js GPU-buffer renderer at
960×540 and pixel ratio 1. Both engines use identical geometry/materials/camera and
four solver iterations; AVBD uses a 0.001 m margin. Rapier uploads poses into the
same 160-byte/body layout. Sleeping is disabled. Each configuration runs two
alternating repeats with 30 warm-up and 120 measured frames. These are completed
work times, not reciprocals of display FPS, and this is not a separately optimized
Rapier renderer.

| Rendered workload | Rapier mean work ms/frame | AVBD mean work ms/frame |
|---|---:|---:|
| 1,000 resting boxes | 3.733–3.864 | 4.347–4.484 |
| 10,000 resting boxes | 25.222–25.574 | 6.039–6.572 |
| Falling 1k pile + 100 rays + full pose reads + contact events, repeat batch | 4.707–5.100 | 6.391–6.711 |

Resting scenes ended within the contact bound, but frame runs have endpoint checks,
not the physics harness's complete replay. Both falling-pile endpoints failed the
contact bound (Rapier pair depth 0.06063 m; AVBD 0.11084 m), so those costs do not
establish matched-quality gameplay performance. Event counts were respectively
6,594 and 9,561 per measured run, with nonzero warm-up events; differing trajectories
and event semantics mean equal event counts are not required.

The first gameplay batch was highly noisy: Rapier 6.153–22.262 ms and AVBD
11.543–95.512 ms, including an AVBD p95 completed-work time of 528.9 ms. It is retained
alongside the repeat, not silently discarded. Pose-read/query/event times include
waiting for preceding GPU work; they cannot be interpreted as isolated kernel costs.

Browser testing exposed a second-run renderer initialization stall. Reusing the
renderer, explicitly releasing each run's body buffer, a fresh browser tab, and
bounded initialization/animation-frame waits allowed repeated workflows to complete.
The original browser-tool extraction was truncated at 200,000 characters; it is
retained as `.truncated.txt`, not valid raw JSON. Complete compact reports were
subsequently extracted from the visible report field. Browser download completion
remains unverified; this does not affect those saved measurements.

All 16 accepted rendered runs had finite final states and valid rotations. Results
and raw frame timing arrays, including the noisy batch:
[rendered-validation.json](data/rendered-validation.json).

Isolated-process 1k runs observed high-water RSS of about 411 MiB (Rapier) and
318 MiB (AVBD), including Node, Dawn, initialization and validation. Final JS heap
usage was about 35 MiB and 52 MiB respectively. These are process observations,
not total engine memory or portable peak GPU allocations; no memory-efficiency
winner is established.

Final verification after renderer lifecycle fixes: `pnpm check` passed with
**74 CPU tests and 62 real-device GPU tests**, zero skips/failures, typecheck and
both builds. The existing large-bundle warning remains. `git diff --check` passed.
No commits or publishing were performed. M1/older-discrete-GPU testing remains pending
because those devices were not available in this session.
