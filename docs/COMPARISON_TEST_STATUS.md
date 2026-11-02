# Comparison test program

> **Historical record.** Every number below was measured on `b3675de` (0.2.1), before #39, with
> an unmerged speculative-contact branch. None is a current result. This port did not bring over
> the `docs/data/*.json` reports these sections link, the `--avbd-margin` and `--speculative`
> options, or the solver's contact-margin and speculative sphere-box parameters (main has
> neither). Commands that use them do not run here. Current results need a new dated baseline
> from this branch.

Scope: local M4 Max, pinned Rapier WASM and three-avbd WebGPU. Measurements of
errors are distinct from execution status. A successful process or gate is not a
physical-quality pass. No publishing or commits are part of this work.

| Area | Reproducible coverage | Outstanding |
|---|---|---|
| Fast translation | Head-on mass ratios, shifted impacts, grazing, small/oblique GPU regressions | Wider angle/size/speed sweeps; finite numerical sweep resolution |
| Angular contact | `impact-rotate`, 1/60–1/960 timestep sweep; Rapier CCD explicitly requested | Both coarse configurations fail; AVBD angular CCD remains unimplemented |
| Settled scaling | `rest-grid-100`, `rest-grid-1k`, `rest-grid-10k`: independent 10-box columns | Interacting piles/rings must still meet a shared target; independent columns do not establish that |
| Tall/heavy loads | 50-box stack, 1,000× top load, 20-link chain, 1,000× end load; iteration sweep | Minimum-cost tuning for each engine, swinging chains and wider mass ratios |
| Analytic accuracy | Free fall, Coulomb sliding, isotropic principal-axis spin; two timesteps | General tumbling, non-isotropic angular momentum; free-fall precision diagnosis |
| Long duration | Two-minute resting-stack, heavy-chain and spin runs | Longer endurance, runtime adds/removals and repeated wake transitions |
| Multiple impacts | `impact-train`, five projectiles and a box pile | Count actual impacts; further geometries |
| Many spheres | 100-sphere pile, speculative mode on/off | Larger mixed-shape counts and broadphase profiling |
| Application cost | `compare-frame.html`: identical renderer, two alternating repeats, ray batches and optional pose readback | Larger scenes and more devices; event buffers are bounded and overflow fails |
| Memory | CLI reports process RSS high-water and final JS/external memory | Portable peak GPU memory; isolate engines/processes before attributing RSS |
| Other hardware | Same scripts/page are portable | M1 and older discrete GPU access unavailable in this session |

Run the serial local suite (does not run GPU jobs concurrently):

```sh
node --experimental-transform-types scripts/compare-suite.ts /path/to/results
```

The suite saves each full report, stdout/stderr and an incremental execution-status
file. It takes minutes. `strength-4` uses four iterations per engine;
`strength-16` increases AVBD to 16 and leaves Rapier at four, so it is a convergence
probe, not equal cost. Equal iteration counts themselves do not represent equal work.
All suite runs request Rapier CCD and disable sleeping. Resting targets cover ten
measured seconds after a two-second lead-in. Soak cases cover two minutes after lead-in.

Rendering uses a shared 160-byte body-buffer layout and the existing showcase
renderer at 960×540, pixel ratio 1, with 30 untimed warm-up frames. Rapier snapshots
are uploaded; AVBD supplies the same buffer directly. This is one concrete pipeline,
not an optimized-engine shootout. It reports work completion and display-frame
intervals separately. Query and pose-read timing may include waiting for preceding
GPU simulation; they are end-to-end costs, not isolated kernel times. Rendering
samples validate final state only; retain the separate per-step physics checks.

Energy and momentum changes are diagnostics. Gravity, fixed supports and friction
exchange momentum; impacts dissipate energy. Do not call those expected changes
conservation errors. Only isolated, force-free cases support that interpretation.
The analytic spin case has isotropic inertia and starts along a principal axis.

## Execution status

The first expanded local pass completed 156 physics runs across 21 reports; every
accepted run matched its validation replay. A runner argument-validation failure
was fixed and retried separately. Browser tests completed 16 rendered runs, including
raycasts, full pose readback and contact events. Results include physical failures
and timing outliers: see RAPIER_COMPARISON.md and docs/data/expanded-validation.json
and docs/data/rendered-validation.json.

Remaining engineering work is real: angular CCD, free-fall precision, long-term
spin damping, and sphere-pile stability. The independent-column result does not
resolve interacting pile/ring quality. Other-hardware access and portable peak GPU
memory measurements remain unavailable. These limitations were not converted into
passing tests or general speed claims.

Retry a named suite job without rerunning the entire matrix:

```sh
node --experimental-transform-types scripts/compare-suite.ts /path/to/retry angular-960
```
