# Findings

Measured results that drive design decisions. Newest first. Each entry says how it was measured.

## 2026-10-18 — Paper-scale pile: 4314-bunny exploratory measurements (capacity validation pending)

**Review correction (2026-10-19):** the historical measurements below are not sufficient to
establish zero dropped substeps: the old harness read overflow only after the final substep.
Its recorded frame times exclude the explicit counter readback, despite the original label.
Mesh penetration scanned the first 300 qualifying directed pairs, biased toward early body IDs;
the reported depths are observations of that subset, not bounds on the entire pile. These raw
records are retained unchanged for provenance. Harness version 2 checks every substep, times
those readbacks, and reservoir-samples nearby pairs across all bodies in both directions.
Version 2 results must be measured before making corrected capacity or pile-wide quality claims.

Paper Table 1 times a 4314-body Bunnies scene, but the layout is not published.
`scripts/sdf-scale.ts` builds an analogue:
- the released voxel bunny and the released ground;
- a 33×33 lattice, 4 layers high, spaced 1.2 m, with random orientations;
- mesh-quality settings, the World spatial broadphase, and 600 frames (10 s).

One run per configuration on the dev machine (M4 Max). Frame times are wall clock, including
submission but excluding the explicit per-frame counter readback. **They are not target-hardware numbers and not the
paper's t_coll.**

- **Capacity:**
  - World's default reservation is 8 candidate pairs per body (34,520). It overflowed on frames
    1–2, because the lattice packs more AABB neighbours than that, so those pairs were dropped for
    those steps. Auto-grow then doubled capacity to 69,040, with no further overflow observed in the final-substep samples.
  - Reserving 64,000 pairs up front (`maxPairs`) recorded zero overflow in final-substep samples; earlier substeps were not checked.
  - The settled pile uses about 44.5k candidate pairs and 41–43k contacts.
  - Recommendation for large scenes: reserve `maxPairs` rather than rely on growth.
- **Cost:** median 46 ms per frame (p95 51 ms, max 74–86 ms), with 4 substeps and 20 AVBD
  iterations. That is 2.8× the 16.7 ms frame budget at 60 Hz on this machine. It is not comparable
  with the paper's 1.8 ms t_coll on an RTX 4090, which times collision only.
- **Stability and penetration** (64k reserved; ground penetration is exact over all vertices;
  mesh-mesh penetration is sampled over 300 nearby pairs every 60 frames):

  | frames 300–600 | `main` 33d34f6 | with the witness rule (PR #36) |
  |---|---|---|
  | kinetic energy | 2.33–12.8 J, spike at frame 360 | 0.67–2.21 J |
  | biased-subset mesh penetration (not pile-wide bounds) | up to 12.8 mm (frame 480) | ≤ 3.7 mm in that subset |
  | ground penetration | 0 | 0 |

  Without the rule, the pile does not settle within 10 s. With it, about 1 J remains. That is
  about 0.3 mJ per body, comparable to the small pile's 0.01 J / 27-body limit. This is one run each
  and is indicative, not an ensemble.

Measurements: `measurements/sdf-scale-bunnies-{default,reserved,witness}-2026-10-18.json`.

## 2026-10-18 — Paper Table 5 SGD row matches SGD without its ‖Δx‖ < τ stop (opt-in added)

The entry below found that the released SGD costs about 0.48× Nelder–Mead per pair, against the
paper's 3.40×. To find which change matches the paper, the pinned upstream oracle was built in
scratch with a runtime switch over four `gradientDescent` variants
(`measurements/sdf-sgd-variants-2026-10-18.patch`). Each variant ran all ten Table 5
configurations for 360 frames, with released parameters and optimizer 2. Variant 0's output is
byte-identical to the unpatched SGD run.

| Variant | SGD / NM per pair (mean) | iterations per step | contacts | per-config corr. with paper |
|---|---|---|---|---|
| 0 released (decaying step and noise; stop on ‖g‖ < τ or ‖Δx‖ < τ) | 0.48 | 1088 | 40.0 | −0.28 |
| 1 fixed step and noise | 2.15 | 4632 | 42.2 | −0.16 |
| 2 fixed step, decaying noise | 1.15 | 2682 | 40.3 | −0.36 |
| 3 released without the ‖Δx‖ < τ stop | **3.48** | **7086** | 38.3 | 0.70 |
| paper | 3.40 | 7708 | 46.3 | |

- **Variant 3 matches the paper's row in aggregate and in pattern (r = 0.70):**
  - The mean ratio and the iteration count are close.
  - The per-configuration pattern matches, including Undistorted as the highest (4.83 vs 4.94).
  - The largest miss is DISPLACE 0.20 (2.23 vs 3.43).
- **The fixed step does not explain it.** The paper's prose attributes SGD's behaviour to a fixed
  step size (Sec. 4), yet variant 1 neither reaches the paper's cost nor follows its pattern.
- **Why released SGD stops early.** A counting build, Undistorted, 360 frames:
  - 60% of calls stop on ‖Δx‖ < τ because the projection onto V pinned the iterate at the box
    face;
  - 30% stop on a small unclamped step;
  - 11% stop on ‖g‖ < τ;
  - none hit the limit;
  - the result is about 3 iterations per call.

  Without the Δx stop, 64% of calls run to the 50-iteration limit and the rest stop on the
  gradient, about 36 iterations per call.
- **Conclusion:** this is an inference, not a confirmation from the authors. The paper's SGD
  numbers are consistent with an SGD that terminates only on the gradient norm or the iteration
  limit. The released code also applies the paper's stated ‖x(k+1) − x(k)‖ < τ test (Sec. 3.3),
  which mostly fires as a stall against V's boundary. Contacts remain lower than the paper's
  (38–42 against 46) in every variant, which is the same trajectory gap seen for Nelder–Mead.
- **Opt-in on our side:** `sgdGradientStopOnly` (default false) drops the Δx stop on the CPU and
  GPU. The default keeps the released behaviour and the oracle fixtures.
  - A CPU test checks the opt-in on the 16 oracle cases. With the same stream it replays the
    released iterates, then stops only on the gradient or the limit.
  - A GPU test runs an overlapping box pair over eight pair keys. On every key the opt-in never
    stops sooner than released, and it extends the released stop on at least one key.
- **GPU Table 5 SGD rows with the opt-in** (`scripts/sdf-table5.ts out 360 2 gradient-stop`, 360
  frames, released parameters):

  | | SGD / NM per pair (mean) | iterations per step | contacts | per-config corr. with paper |
  |---|---|---|---|---|
  | GPU, opt-in | 3.50 | 6674 | 46.7 | 0.73 |
  | upstream variant 3 | 3.48 | 7086 | 38.3 | 0.70 |
  | paper | 3.40 | 7708 | 46.3 | |

  - The GPU and upstream variant 3 correlate at 0.81 per configuration.
  - The largest misses against the paper are TWIST 0.50 (3.73 vs 2.73) and Undistorted (5.42 vs
    4.94).
  - Iterations per step run about 13% low. This follows from pair counts, which depend on the
    trajectory (see the Nelder–Mead Table 5 entry).
  - With this opt-in, the production GPU path matches all three Table 5 optimizer rows in
    aggregate, and the SGD row also in pattern (r = 0.73). This is not a per-configuration match:
    single configurations are off by up to 1.0 (TWIST 0.50), and t_coll is not measured.

Measurements: `measurements/sdf-sgd-variants-2026-10-18.json`, with per-configuration rows, the paper
values and the stop-reason counts.
GPU opt-in rows: `measurements/sdf-table5-sgd-gradient-stop-2026-10-18.json`.

## 2026-10-18 — GPU Ellipsoid and SGD; Table 5 rows match upstream, paper SGD row does not

The GPU narrowphase now runs all three optimizers (`optimizer` 0/1/2). This supersedes the "GPU
remains Nelder–Mead only" notes in the two entries below.
- **Ellipsoid (1):** a WGSL port of the CPU reference. Each point record grows from 20 to 28 words,
  to store its symmetric ellipsoid for the 0.75/0.25 warm start. A GPU test checks the position
  (within τ) and the iteration count (within 2) against the verified CPU reference. A second test
  re-optimizes a cached point from its stored ellipsoid and compares the position, the iterations
  and the new ellipsoid against the CPU blend plus `ellipsoidMethod`. Removing the blend, or
  corrupting the unpacking of the stored ellipsoid, makes that test fail.
- **SGD (2):** noise comes from the GPU per-pair stream, so it matches upstream statistically, not
  bitwise. Tested for descent and for repeatability.
- **Params block:** 64 → 80 bytes (`optimizer`, `stepSize`). `stepSize` is validated and uploaded
  only for SGD; other optimizers pack 0.
- **Cost for every optimizer:** the 8 ellipsoid words are always present, including for the
  Nelder–Mead default. That adds 40% per point record, so 108 → 148 words per pair result at the
  default 5 points (592 bytes), with the same growth in history copies. The automatic pair
  ceiling that `sdfBroadphaseOptions` derives from the storage-binding limit falls by about 27%. At
  20 points, the private per-invocation result grows from about 1.6 KB to about 2.3 KB. We accepted
  this for one layout across optimizers. It has not been measured on the M1 / GTX 1080 target. If it
  costs there, the ellipsoid words can move to a separate buffer bound only for optimizer 1.

`scripts/sdf-table5.ts` now takes an optimizer list. It ran 360 frames for each of the ten Table 5
configurations with released parameters, swapping only the optimizer. For an upstream comparison,
the pinned oracle was built in scratch with one extra line that sets `solver.params.optimizer`
from `$OPT` after the scene is built. That line is not committed, so the driver hash is unchanged.
That build's Nelder–Mead runs reproduce all ten committed upstream captures exactly (iterations
and pairs).

The cost measure is iterations per pair, divided by the same source's Nelder–Mead iterations per
pair. Pair counts depend on the trajectory (see the Table 5 entry below), so the ratio isolates
optimizer cost. Means over the ten configurations:

| | GPU (ours) | upstream C++ | paper |
|---|---|---|---|
| Ellipsoid / NM | 2.35 | 2.35 | 2.22 |
| SGD / NM | 0.49 | 0.48 | 3.40 |

- **Ellipsoid:** reproduced. Per configuration, the GPU and upstream agree within ~16% (for
  example BEND 0.95 at 158 vs 156 iterations per pair). Both are close to the paper.
- **SGD:** the GPU matches upstream on every configuration, within 0.10 of the ratio. Upstream's
  released `gradientDescent` stops after about 15–40 iterations per pair (88 on TWIST 5.00). The
  paper reports about 3.4× Nelder–Mead, close to the 50-iteration limit on every point. So the
  paper's SGD row is not reproduced by the released code itself. The likely cause is a different
  step size or stopping rule in the paper's runs. That was not investigated further, and released
  parameters were not changed.
- **Queries:** the paper lists queries equal to iterations for Ellipsoid and SGD. Upstream (and
  this pass) also counts one final query per point, and Ellipsoid feasibility cuts outside V need
  no query. So queries are not directly comparable.
- **Not covered:** contacts per call vary with the trajectory; SGD paths depend on the random
  stream; t_coll is not measured.

Measurements: `measurements/sdf-table5-optimizers-2026-10-18.json`, with GPU, upstream and paper
rows and the ratios.

## 2026-10-18 — Ellipsoid and gradient-descent optimizers ported to the CPU reference

The audit found only Nelder–Mead ported, while the paper compares three optimizers (Tables 1, 3–5).
The CPU reference now implements all three, ported line for line from `optimize.cpp` and
`collide.cpp` with float32 emulation:
- the analytic objective gradient: the softmax blend of the field gradients, minus repulsion;
- the deep-cut ellipsoid method [LM24], with upstream's initial ellipsoid and 0.75/0.25 warm start;
- stochastic projected gradient descent [RM51], with decaying step and noise from the manifold's
  shared stream.

SGD also keeps its samples under the convex skip, as upstream does.

Upstream ground truth comes from new driver commands, run through the existing harness on a clean
pinned checkout:
- `optimizers.json`: 16 cases. Each records the objective and gradient at the seed, an ellipsoid
  run, a warm-started ellipsoid run, and an SGD run.
- `manifolds-optimizers.json`: 4-step warm ellipsoid and SGD boxes, and ellipsoid-on-torus and
  SGD-on-bend seed cases.

`verify` first confirmed every existing fixture reproduces exactly. After generation, only the
manifest changed (driver hash plus the new entries); all other fixtures were byte-identical.
On macOS the harness needs `SDKROOT=$(xcrun --show-sdk-path)`.

The port matches on the first run:
- iteration and query counts are exact;
- positions are within τ and final ellipsoids within 1e-4;
- manifold points, ranks, flags, stats and RNG consumption are exact across chained warm steps.

The GPU narrowphase remains Nelder–Mead only, so the Ellipsoid and SGD rows of Tables 1, 3–5
are still not reproduced on the production path.


## 2026-10-18 — Paper Fig. 6: cache size dominates penetration; curvature gain not reproduced

`scripts/sdf-fig6.ts` drops the released bunny (scale 1) and cow (scale 1.3) onto the ground plane
from 100 deterministic random orientations (uniform on SO(3), identical across configurations).
Each starts with its lowest vertex 0.25 m up. Runs use 500 frames with 4 substeps and 20 iterations
on the production GPU path, with the released (paper-default) parameters.

The sweep covers n_cache ∈ {4, 8, 16} × n_sto ∈ {1, 4} × uniform/curvature sampling, using
`maxPointsPerPair` = max(5, n_cache + n_sto). All 100 rollouts of a configuration share one World,
spaced so only body–ground pairs exist.

Two metrics are recorded per frame and rollout:
- **Penetration:** the lowest source-mesh vertex below the plane, which is exact for a plane.
- **Intrusion:** depth below the solver's 1 cm rest gap, which separates configurations even when no
  geometry overlaps.

Tables report the mean over frames of the per-frame mean across rollouts, and the peak over frames
of the per-frame maximum across rollouts. All values are in mm.

| Shape | Sampling | n_cache | n_sto | Mean penetration | Peak penetration | Mean intrusion | Peak intrusion |
|---|---|---|---|---|---|---|---|
| bunny | uniform | 4 | 1 | 0.511 | 78.2 | 2.63 | 88.2 |
| bunny | uniform | 4 | 4 | 0.005 | 5.9 | 1.25 | 15.9 |
| bunny | uniform | 8 | 1 | 0.003 | 3.0 | 1.08 | 13.0 |
| bunny | uniform | 8 | 4 | 0.000 | 0.0 | 1.02 | 3.8 |
| bunny | uniform | 16 | 1 | 0.000 | 0.0 | 1.03 | 6.7 |
| bunny | uniform | 16 | 4 | 0.000 | 0.0 | 1.10 | 3.1 |
| bunny | curvature | 4 | 1 | 0.477 | 64.4 | 2.52 | 74.4 |
| bunny | curvature | 4 | 4 | 0.017 | 5.9 | 1.32 | 15.9 |
| bunny | curvature | 8 | 1 | 0.003 | 3.0 | 1.09 | 13.0 |
| bunny | curvature | 8 | 4 | 0.000 | 0.0 | 1.03 | 3.8 |
| bunny | curvature | 16 | 1 | 0.000 | 0.0 | 1.03 | 6.7 |
| bunny | curvature | 16 | 4 | 0.000 | 0.0 | 1.10 | 3.2 |
| cow | uniform | 4 | 1 | 3.810 | 300.0 | 7.59 | 310.0 |
| cow | uniform | 4 | 4 | 0.234 | 82.1 | 2.65 | 92.1 |
| cow | uniform | 8 | 1 | 0.170 | 69.5 | 1.78 | 79.5 |
| cow | uniform | 8 | 4 | 0.000 | 2.2 | 1.00 | 12.2 |
| cow | uniform | 16 | 1 | 0.001 | 4.2 | 1.06 | 14.2 |
| cow | uniform | 16 | 4 | 0.000 | 0.0 | 0.96 | 10.0 |
| cow | curvature | 4 | 1 | 3.684 | 334.7 | 7.94 | 344.7 |
| cow | curvature | 4 | 4 | 0.586 | 101.1 | 3.03 | 111.1 |
| cow | curvature | 8 | 1 | 0.134 | 35.3 | 1.62 | 45.3 |
| cow | curvature | 8 | 4 | 0.001 | 5.9 | 1.03 | 15.9 |
| cow | curvature | 16 | 1 | 0.001 | 4.2 | 1.09 | 14.2 |
| cow | curvature | 16 | 4 | 0.000 | 0.0 | 0.97 | 10.0 |

- **Reproduced: cache size dominates.** Going from n_cache 4 → 8 → 16 cuts mean penetration by
  roughly 100× and then 100× again. Bunny goes 0.51 → 0.003 → 0 mm; cow goes 3.8 → 0.17 → 0.001 mm.
  Four stochastic samples help most at small caches. This matches the paper's statement that
  "sample caching exerts the most profound impact".
- **Not reproduced: curvature sampling.** Curvature-aware sampling is only marginally better at
  n_cache 4 / n_sto 1 (bunny 0.48 vs 0.51 mm, cow 3.68 vs 3.81 mm). It is *worse* for the cow at
  n_cache 4 / n_sto 4 (0.59 vs 0.23 mm). The paper reports it "significantly suppresses
  interpenetration".
- **The release default is the weak case.** n_cache 4 / n_sto 1, the released default, lets a cow
  sink up to 300 mm in the worst rollout. These runs use the released parameters without our
  mesh-quality corrections, as the paper's experiment does.
- **Not reproduced: the oracle and the paper's exact setup.** The paper's 1000-point brute-force
  oracle simulation is a different collision method and is not reproduced. The paper's drop height,
  frame count and averaging (mean vs max over rollouts) are unstated; both aggregates are stored.

Measurements: `measurements/sdf-fig6-2026-10-18.json`, which holds per-frame curves for every run.

## 2026-10-18 — Paper Table 5 (Nelder–Mead rows): counts reproduced per pair

`scripts/sdf-table5.ts` runs the operator-distorted Falling Boxes scenes on the GPU with the
released parameters, which are the paper's defaults. It covers the undistorted baseline and
Bend, Displace and Twist at the paper's three strengths each, using the oracle's `--warp-k`
captures (`loadReleasedScene(id, read, k)`). For each it reports contacts, Nelder–Mead
iterations and SDF queries per collision call. Each frame's sums are divided by its 4
substeps, then averaged over 360 frames. Upstream's per-call numbers come from its captures
the same way. The paper's numbers are from Table 5, p. 10. Collision time is not measured.

| Config | Ours (GPU): contacts / iterations / queries | Upstream capture | Paper (NM) | Iterations per pair, ours / upstream |
|---|---|---|---|---|
| Undistorted | 48.0 / 834 / 1965 | 39.8 / 701 / 1650 | 45.7 / 1066 / 2302 | 35.4 / 37.6 |
| Bend 0.15 | 55.7 / 2076 / 4375 | 44.4 / 2281 / 4897 | 46.0 / 2389 / 5010 | 61.7 / 55.4 |
| Bend 0.55 | 51.9 / 2288 / 4967 | 40.3 / 2399 / 5117 | 39.8 / 2346 / 4896 | 54.0 / 58.1 |
| Bend 0.95 | 63.5 / 2950 / 6278 | 50.2 / 3073 / 6491 | 36.4 / 2842 / 5870 | 60.7 / 61.4 |
| Displace 0.05 | 58.8 / 1693 / 3675 | 38.9 / 1225 / 2714 | 42.0 / 1707 / 3600 | 53.5 / 48.4 |
| Displace 0.10 | 49.3 / 1492 / 3222 | 40.4 / 1429 / 3078 | 36.1 / 1861 / 3939 | 54.6 / 53.4 |
| Displace 0.20 | 36.1 / 1392 / 2939 | 41.8 / 2566 / 5386 | 36.1 / 2330 / 4982 | 61.6 / 63.7 |
| Twist 0.50 | 57.1 / 2081 / 4544 | 50.4 / 2536 / 5416 | 45.8 / 3161 / 6561 | 51.4 / 57.0 |
| Twist 2.50 | 52.8 / 2610 / 5518 | 40.0 / 2751 / 5811 | 42.1 / 3354 / 7081 | 66.0 / 66.0 |
| Twist 5.00 | 43.6 / 2399 / 5022 | 36.5 / 2663 / 5583 | 43.5 / 2743 / 5871 | 74.7 / 72.2 |

- **Per pair:** our Nelder–Mead cost matches upstream's within about 12% in every configuration.
- **Totals:** both implementations land within roughly ±40% of the paper. The ordering matches:
  distortion costs 1.7–3.5× the undistorted baseline here, against the paper's 1.6–3.1×, and
  queries run about 2.1× iterations in all three.
- **Displace 0.20 outlier (−40%):** this is pair count. Our planks spend fewer frames in contact
  (22.6 against 40.3 pairs), a trajectory difference from AVBD versus sequential impulses.
- **Contacts:** 36–64 per call, against the paper's 36–46. This matches our generally higher
  contact counts.
- **Upstream undistorted (701 against the paper's 1066):** the released code's convex skip,
  which the paper does not describe, likely explains this.
- **Run:** a single deterministic rollout, repeated bit-identically.
- **Not reproduced:** the Ellipsoid and SGD rows (only Nelder–Mead was ported at the time; see the
  GPU Ellipsoid and SGD entry above) and t_coll.

Measurements: `measurements/sdf-table5-2026-10-18.json`.

## 2026-10-18 — Audit against the paper and upstream sdf-dcd-demo

Superseded in part by the entries above: the Ellipsoid and SGD optimizers, the Table 5 sweep and
the Fig. 6 limits listed here as missing were added later the same day.

A read-only audit compared the CPU port, the GPU path and the docs with Giles & Andrews
(CGF 45(7) 2026) and the pinned upstream 1dcdf1e7.

**Faithful on the default path:**
- Algorithm 1: caching, Eq. 6 advection, top-up, convex skip, curvature reservoir sampling,
  deduplication, ranking, Eq. 5 normals and separation, and the gap outside both bodies.
- Eqs. 2–3 and the defaults (ε 0.1, α 0.01, τ 0.01, 50 iterations, margin 0.02, allowed
  penetration 0.01).
- Nelder–Mead, every analytic field and warp, voxel sampling and its outside-grid extension.
- Curvature seeds and mass integration. All 11 analytic seed sets match the captures to ≈1e-7.
- Documented GPU difference: the per-pair 32-bit random stream.

**Where upstream itself departs from the paper (inherited):**
- Activity is decided by `separation < margin`, not φA<0 and φB<0 (paper p5).
- The solver uses separation (φA+φB, or the Newton gap), not the paper's depth d.
- Not in the paper: the convex-pair sample skip, replacement-threshold rank hysteresis, the
  cached-point simplex cap, the coherent-normal rule, and the search box grown by margin/2.
- Displace treats k as amplitude with a fixed frequency of 7; the paper writes k as frequency.
- Collision runs on every substep, 4× per frame.

**Our deviations from upstream:**
- The AVBD contact skin. Now documented in SDF_PRODUCTION_BRIDGE.md.
- Rolling handling covers the whole pair.
- Warm-start forces are rotated as a whole vector.
- Velocities come from AVBD position differences.
- Pair orientation is reversed (a > b), which changes tie-breaks only.
- The CPU adapter does not apply SDF mass, full inertia or scale.
- Bake defaults differ. Now documented in SDF_BAKING.md.
- Ellipsoid and SGD optimizers are missing; only Nelder–Mead exists.

**Fixed here:**
- SDF point ids could equal `SPHERE_FEATURE` (0x03000000), making `evalContact` treat the contact
  as a built-in sphere. New ids now skip it; a GPU test seeds the counter just below it.
- Stale docs: the body layout and anchor frame (SDF_GPU_DRAFT.md), the rolling-pair wording and
  skin semantics (SDF_PRODUCTION_BRIDGE.md), and the key-bit comment in `layout.ts`.

**Open:**
- No quantitative paper experiment is reproduced: Tables 1–5 and Figs. 6–7. Table 5's k-sweep
  captures exist but are unused.
- The GPU limits (cache ≤4, total ≤5, ε>0) block the Table 2 and Fig. 6 sweeps on the GPU.
- WGSL `sin`/`cos` outside [-π,π] in Displace and the spiky wheel is a CPU/GPU parity risk.



## 2026-10-18 — All eleven released SDF scenes reproduced; rolling contacts and non-convex quality

`sdf-released.html` and `sdf-released-compare.ts` now load every sdf-dcd-demo scene. New: Falling
Boxes, Bend, Twist, Displace, Spiky Wheel, Cows on Spikes and Primitives. They use the captured
analytic specs, COM, mass and full inertia. Upstream finalizes every library shape except `Ground`,
the only static box, so the static spike plate now gets curvature seeds. Non-box analytic shapes get
render and probe surfaces from a marching-tetrahedra mesher: 72 cells for spikes and warps, 48 for
smooth primitives. Its grid is offset by a fraction of a cell so axis-aligned faces never sit on grid
planes, and zero-area slivers are dropped. A test covers all ten non-box analytic kinds: vertices
within a cell of the field, ≥99% of surface area facing outward. Scene load (Node, nice 15) takes
22 ms for Box Stack, about 0.4 s for Spiky Wheel and Cows on Spikes, and 0.55 s for Primitives
(1.37 s before the lower resolution for smooth primitives).

The first all-scene run exposed three GPU problems.
- **Rolling anchors.** The bridge kept sticking anchors except on analytic spheres. A rolling
  Primitives cylinder kept four sticking contacts and sank 123 mm. A Spiky Wheel capsule sank 130 mm.
  Anchors are now refreshed for analytic kinds 1–5 (sphere, capsule, cylinder, cone, torus).
- **Rolling linearization.** Even with fresh anchors, an isolated cylinder rolling at 1 m/s sank
  from 300 to 238 mm in 4 s while speeding up (ω -3.3 → -4.65 rad/s). The built-in solver documents
  the same effect for its spheres: lever arms rotated with a rolling body add a false separation.
  These SDF contacts now carry `SDF_ROLLING_BIT` (0x20000000), and `evalContact` evaluates them at the
  step-start rotation, like `SPHERE_FEATURE`. Ordinary SDF IDs now wrap below that bit, and readback
  reports it as `rolling`, not as part of `feature`. The cylinder now rides at 0.319 m and slows to
  ω -1.2 rad/s, a sphere similarly. That slow-down is rolling resistance the release does not have.
- **Non-convex quality.** Mesh quality was gated on voxel meshes. In non-convex analytic scenes a
  spike tip 127 mm inside the floor read +2.3 mm through the unsigned mixed-sign gap. Mesh quality now
  applies to every scene with a non-convex body. Vertex contacts still need voxel triangles.

New GPU tests: a rolling analytic cylinder must keep its axis within 5 mm of its radius above the
floor (it failed at 238 mm before the linearization change). A cylinder standing on its cap must hold
on a 10° incline with friction 0.6. It drifts under 1 cm, so the refresh does not remove static
friction there.

The reference probes only every 30 frames, so penetration is compared on that grid. Upstream's
randomly oriented spawns overlap during frames 1–29, unmeasured by the reference. **Probe
vertices differ:** ours are the render surfaces above, the reference uses upstream shape meshes.
These are comparable lower bounds, not identical measurements. Final kinetic energies are at
6 s, when several scenes are still moving.

| Scene | Peak / final mm (GPU) | Peak / final mm (reference) | Final KE GPU J | Final KE reference J |
|---|---|---|---|---|
| Box Stack | 0 / 0 | 0 / 0 | 6.0e-6 | 2.0e-7 |
| Gear Stack | 0 / 0 | 0 / 0 | 3.6e-7 | 6.6e-8 |
| Falling Boxes (convex, release parameters) | 28.1 / 1.0 | 16.8 / 0 | 1.2e-3 | 6.9e-10 |
| Bend | 21.1 / 0 | 18.1 / 0 | 5.8e-4 | 2.1e-6 |
| Twist | 31.2 / 0 | 18.3 / 0 | 2.3e-4 | 4.3e-11 |
| Displace | 26.2 / 0 | 42.3 / 0 | 4.2e-4 | 1.3e-14 |
| Pile of Chairs | 3.0 / 0 | 9.1 / 0 | 4.6e-5 | 5.3e-19 |
| Spiky Wheel | 0 / 0 | 0 / 0 | 0.044 | 0.65 |
| Cows on Spikes | 95.0 / 36.0 | 121.9 / 121.2 | 0.023 | 8.3e-5 |
| Bunny Pile | 1.7 / 0 | 0 / 0 | 6.6e-4 | 0.014 |
| Primitives | 7.4 / 0 | 0 / 0 | 0.42 | 0.65 |

Before these fixes, the same comparison read Spiky Wheel 119 / 97.5 mm, Primitives 155 / 21.6 mm,
and Displace 70.4 / 17.7 mm at 0.51 J.
- **Scenes the reference settles:** at 6 s ours keep far more residual energy (1e-6 to 1e-3 J
  against 1e-19 to 1e-6 J), and Cows on Spikes (0.023 J) is still moving.
- **Rolling scenes:** they lose energy faster than the reference (Spiky Wheel 0.044 against 0.65 J).
- **Contact counts:** about 1.2–2.3× the reference's.
- **Cows on Spikes:** deep in both runs, by design of the scene.

This is outcome agreement with the released CPU sequential-impulse demo, not trajectory parity, and
not the paper's GPU experiments. In comparison runs during this change (raw logs not committed), scenes
without analytic kinds 1–5 kept bit-identical trajectories. Measurements:
`measurements/sdf-released-all-2026-10-18.json`.

## 2026-10-18 — SDF interlocks: two rules tried, neither accepted

Full `pnpm check` on `main` 686d4e3 (sequential, nice 15, nothing excluded): typecheck,
142 CPU and 156 GPU tests including the five heavy workloads, and both builds pass.

Bunny seed 3's remaining failure (0.058 J) is an interlock. Pair 22/5 point 179 is inside
both meshes (phiA ≈ -2 mm, phiB ≈ -9 mm) but their outward gradients are aligned
(∇A·∇B > 0). It pushes A down at -8 to -12 mm while B's vertices sit 0.3–1 mm inside A's
underside, so the vertex witness is right and point 179 is wrong. With aligned gradients,
phiA+phiB along either gradient gives no direction that resolves the overlap.

- **Aligned both-inside points are not contacts** (moving pairs, `signedSeparation`): this fixes
  the bunnies (failures 1 → 0, probes ≥5 mm 14 → 1, max peak 15.4 → 6.9 mm) but chair seed 3 now
  fails at 0.0377 J. Trace: chair 25's floor point 719 sits 5 mm above the box face.
  It takes the both-positive branch, whose unsigned gap normal points *down* because the chair
  surface below it faces up and lies about 1 mm under the box face. It pushes at 257 N against
  neighbour 270 (+y, 233 N) and pumps the chair upward. Rejected under the decision rule.
- **Also applying static-box signed projection to every sign:** both fixtures settle, but the
  ensemble has 3 failures per scene and chair probes ≥5 mm rise 37 → 188. Rejected.

The shader is unchanged from `main`. Both mechanisms are opposing contacts within a single
pair (mesh-mesh or mesh-floor). The next attempt should resolve such a conflict per pair: detect
opposed active normals and keep the one consistent with the exact vertex witness or box face.
Single-sample rules so far only move the heavy-tail failure to another seed.
Measurements: `measurements/sdf-interlock-2026-10-18.json`.

The opt-in is renamed `meshPlaneContacts` → `meshVertexContacts` (unreleased API, no alias), since it
now covers mesh-mesh pairs. Earlier entries and measurement files keep the name they were recorded with.

## 2026-10-17 — Mesh-to-mesh vertex witnesses; mesh vertex contacts enabled for mesh piles

**Fixture (chairs, jitter=1, supports on).** `sdf-pair-trace.ts` on the failing pair 10/20
showed one active optimizer point at +9.9 mm (the rest gap, so apparently satisfied) while one vertex
of each chair sat 5–6 mm inside the other. Fresh samples near the overlap did not survive.
Cause: the oracle's epsilon = 0.1 makes the smooth max approximately (phiA+phiB)/2 + 0.158 at
these feature sizes, which is nearly flat along a line through both surfaces. A point 30 mm inside A and
20 mm outside B scores like a real overlap, so the search has no pull toward penetration.
Chair meshes have 164 unique vertices (24 hull) and bunnies 502 (108). At the failure, one
of the two overlapping vertices was a hull vertex and the other was not.

**Change (GPU, opt-in `meshPlaneContacts`).** The atlas now packs every unique source vertex
(stable order; the hull is a subset, so plane extrema are unchanged). For two dynamic
meshes the narrowphase scans each body's vertices inside the pair volume against the other
field, skipping |grad|² < 0.25. If the deepest vertex is below min(margin, ½ tolerance) it
adds one supplemental contact in the fifth slot: separation = the field value, normal = that
field's unit gradient, anchors = the vertex and its projection. The first four optimizer contacts
are unchanged. IDs are `0x40000000 | side<<27 | vertex`, cached by identity like plane supports.
Fixture: peak 12.5 mm → 0.42 mm, final 6.1 mm → 0.

**Ensemble (seeds 0–10, five-frame probes, versus the guarded default).**
- Chairs: failures 0 → 0, probes ≥5 mm 98 → 37 (supports better on 10/11 seeds), max peak 26.5 → 15.9 mm.
- Bunnies: failures 3 → 1, probes ≥5 mm 264 → 14 (11/11 seeds), median peak 22.4 → 0.8 mm, max
  final 8.5 → 1.1 mm. The one failure is bunny seed 3 ending at 0.058 J (no overlap). Its trace shows
  optimizer point 179 deepening from -8.7 to -17.9 mm with a normal opposite to the vertex witness
  (about 1000 N each, an interlock), driving body 5 upward over 25 frames.
- A filter that skipped a witness opposing a deeper kept contact fixed that bunny case (0 failures)
  but produced chair seed 5: final 11.1 mm and 0.136 J. It was added after the fact and **rejected**;
  depth ordering does not identify which opposing contact is correct.
This meets the decision rule fixed in advance (no added failures, better medians and counts),
so `releasedSettings` mesh-quality now enables `meshPlaneContacts` for the mesh scenes (gears, chairs,
bunnies). Canonical runs: chairs 2.97 / 0 mm / 4.6e-5 J, bunnies 1.75 / 0 mm / 6.6e-4 J, gears 0 / 0.
Reference/library defaults are unchanged.

**Cost.** Mean narrowphase field queries per frame: chairs 36.4k → 63.1k (+73%), bunnies
59.0k → 161.1k (2.7×). GPU time was not measured; no M1/GTX 1080 claim.

Browser playback (`sdf-released.html`, mesh quality, no headless GPU work running): chairs and
bunnies replay all 360 frames and auto-pause. Final energies are 4.59e-5 J and 6.62e-4 J,
matching the headless canonical runs. Final sampled surface depth is 0 and contact depth is 0 for both.
The pane was hidden, so playback ran at about 1 frame/s; this is not a performance measurement.
The only console errors were 0×0 render-target errors from the initial hidden-viewport load.

After merging `main` (#14–#25 solver/broadphase work; manifold reuse is skipped while an SDF
backend owns contacts), the 11-seed chair and bunny runs are bit-identical to the pre-merge runs
(22/22), and the bounded gate passes (141 CPU and 148 GPU tests, both builds).

Review follow-ups (PR #26): SDF worlds now adapt the colour cap, Jones-Plassmann rounds and the tail
hint on every periodic readback, including with `autoGrow:false` and after an SDF error. Previously
only pair capacity was adapted, so a dense SDF pile could keep a frozen cap. Mesh vertex contacts
refuse fields above 4096 unique vertices, the per-pair serial scan budget. Detaching a backend
invalidates built-in manifold reuse. The 11-seed chair and bunny runs are bit-identical before and
after these changes (22/22). GPU time on the M1/GTX 1080 targets is still unmeasured.

Still open: opposing-normal interlocks (bunny seed 3); `meshPlaneContacts` now also covers
mesh-mesh pairs, so its name is inaccurate. Measurements: `measurements/sdf-mesh-witness-ensemble-2026-10-17.json`.

## 2026-10-17 — Degenerate-gradient projection launches bodies; floor supports still not enabled

**Launch bug (default path).** A 10-seed ensemble run of the handed-off code with floor
supports had one bunny run end at 2.78 J. A bounded trace showed the cause: at frame
264/substep 1, bunny 3 rests on the floor and is launched at 10.55 m/s by one
ordinary floor contact (id 1035). Its narrowphase separation was **-4.58 m**, with a material anchor
4.9 m away. The static-box signed projection uses `phi·grad/|grad|²`, which is
unbounded where a voxel gradient nearly vanishes. That projection is in the default
mesh-quality profile (`signedSeparation`). Floor supports only changed the
trajectory that reached it.

Retained fix (GPU `wgsl-sdf.ts` and CPU `manifold.ts`, identical rule): when the
moving body's gradient has `|grad|² < 0.25` (a true SDF has |grad| ≈ 1), the projection
falls back to the bounded `phiA+phiB`. New CPU and GPU tests use a constant-phi voxel
field with a 0.02 gradient on a floor box. Both report -0.249 m without the guard and
stay within the real 35 mm overlap with it.

**Guard alone (default, seeds 1–10, ±10 µm initial jitter, five-frame probes).**
Bunny test-limit failures dropped from 4 to 3, worst final overlap from 25.7 to 8.5 mm, and worst
energy from 0.122 to 0.0077 J. Chairs had identical peaks and zero failures, though two seeds
now end at 1.1 and 4.2 mm (limit 5). Canonical runs (seed 0): chairs 8.10 / 0 mm / 0.0011 J;
bunnies 20.0 / 8.4 mm / 0.0014 J.

**Floor supports with the guard (seeds 0–10, paired by seed).** Decision rule, fixed
before the run: enable only if failures do not increase in either scene and median
peak and the count of probes ≥5 mm are no worse.
- Bunnies: probes ≥5 mm went from 264 to 57 (supports better on 11/11 seeds), median peak from
  22.4 to 7.8 mm, finals >0.5 mm from 6 to 3, and failures stayed at 3 (the same seeds, with identical
  early peaks of 30–34 mm in both configurations).
- Chairs: probes ≥5 mm went from 98 to 82 (5 better, 2 worse), max peak from 26.5 to 13.5 mm, but failures
  went from 0 to **1**: seed 1 ends with 6.1 mm of chair-to-chair overlap.
Supports are **not enabled**. Every remaining >5 mm event with supports is mesh-to-mesh,
so floor coverage is largely solved and the blocker is mesh-mesh contact (both-inside
crossing features, slow alpha = 0.99 recovery). Measurements:
`measurements/sdf-supports-ensemble-2026-10-17.json`.

The shared bunny failures (seeds 2/4/5, 30–34 mm peaks) show the current GPU test limits
pass on the canonical trajectory but not robustly across 10 µm perturbations.

## 2026-10-17 — Single pile trajectories cannot decide SDF contact changes

**Baseline drift.** The current working tree no longer reproduces
`sdf-stable-order-2026-10-14.json`. Two fresh canonical runs are bit-identical to each
other but differ from the record from bunny frame 16 / chair frame 77. Five-frame
probes: chairs peak 8.10 mm / final 0 / 1.95e-5 J; bunnies **27.36 mm / 8.26 mm**
(bunny 27 on the floor) / 4.46e-4 J. This is inside the GPU test envelope (30/10 mm),
so the later plane-support/refresh edits changed default trajectories without failing
a test. The exact responsible edit was not isolated.

**Embedded bunny pair (mesh-plane run, 22/5).** New `scripts/sdf-pair-trace.ts`
shows the pair at positive separation until frame 340. The overlap then appears within
about 10 frames, which rules out slow accumulation. Mixed-sign samples report unsigned `length(gap)`:
at frame 347, point 1626 is 19.7 mm inside A and 11.4 mm outside B with facing
gradients, which is about 8 mm of overlap reported as +8.9 mm. Cached point 1447 at
12.3 mm inside A reports +17.4 mm and releases. Separately, a chair 8/17 trace shows
a both-inside point (phiA, phiB about -12/-14 mm, near-orthogonal gradients, likely crossing
legs) staying near -25 mm for 10 frames. Its normal swings frame to frame, and AVBD's
alpha = 0.99 only removes 1% of existing violation per substep.

**Ensemble.** `sdf-released-compare.ts` now accepts `mesh-plane` and `jitter=N`
(deterministic ±10 µm initial offsets). Three seeds per configuration
(`measurements/sdf-ensemble-2026-10-17.json`) show that outcomes are dominated by
trajectory sensitivity. On the unchanged code, bunny peaks range 20.1–34.4 mm, and one seed ends
at 0.12 J, above the 0.01 J test limit. The canonical GPU test passes on one trajectory, not
robustly. Floor supports were not worse across seeds: bunny peaks
2.7/34.4/0 mm versus 25.8/34.4/20.1 mm without supports. The earlier single-run rejection
is therefore not conclusive either way.

A facing mixed-sign sign correction (negate when `dot(na,nb)>0` and
`dot(offsetA-offsetB,na)<0`) was not an improvement. One bunny seed reached
**10.45 J** and was rejected. A first attempt had the inequality inverted; its numbers
were discarded. That experiment was reverted (the later degenerate-gradient guard is a
separate, retained change; see the entry above).

Next: decide contact changes on seed ensembles (more than three seeds) with mesh-to-mesh
and floor counts separated. Investigate both-inside crossing features and the slow
alpha recovery of deep detected contacts. Make GPU regression tests robust to
trajectory sensitivity rather than relying on one canonical path.

## 2026-10-14 — Deterministic floor supports work in isolation, not yet accepted for piles

Implemented the opt-in GPU `meshPlaneContacts` extension. CPU QuickHull retains
actual mesh vertices sufficient for arbitrary plane extrema; the GPU scans them
in a deterministic order. Only a fully covering static box top face qualifies.
At most one extra extremity contact replaces the fifth candidate when the surface
is within half a collision tolerance of the face. The first four ranked search
contacts remain unchanged. Stable vertex feature IDs occupy a reserved range;
ordinary sampling IDs and the sticking bit remain distinct. The supplemental
contact has its own normal and warms by identity, not rank. Edge/side/underside
cases retain general SDF search. The CPU reference explicitly rejects this GPU-only
option rather than silently ignoring it.

Default World snapshots and GPU atlases do not retain/build support data. Opt-in
snapshots copy the source triangles for safe rebuilds; source curvature seeds and
voxel grids are unchanged. The option must be requested at standalone pass creation
as well as dispatch, or at World SDF enable time. No demo quality profile enables it.

Two isolated tilted meshes, 240 frames each with per-frame surface probes, have
zero sampled peak/final overlap and final energy 3.35e-9 J (chair), 2.11e-6 J
(bunny). Stable IDs/cache retention, default-off behavior, disabling cached support,
box-edge fallback and immutable snapshots have targeted coverage. These are not
substep-wide or volume-wide guarantees of no intersection.

Full six-second piles still regress: replacing all floor contacts yielded 12.90 mm
chair / 52.31 mm bunny peak depth (both final zero). The retained supplemental
variant yielded 13.46/0 mm chair peak/final and 15.89/15.89 mm bunny peak/final.
An intersection-only trigger left 9.11 mm final chair overlap. None is enabled in
the demo. Existing chair settling and bunny repeatability policies are preserved.

A tighter sticking-anchor refresh threshold did not resolve the embedded bunny.
The new bounded `scripts/sdf-contact-audit.ts` shows its deep contact was already
non-sticking: detected -21.106 mm, projected anchor gap -21.521 mm, no anchor
relocation. Therefore that threshold experiment was reverted. This remaining
mesh-to-mesh case needs coverage/constraint diagnosis, not another blind refresh
threshold change. Measurements: `measurements/sdf-plane-supports-2026-10-14.json`.

Verification: typecheck, 139 CPU tests, 126 sequential GPU tests, Vite build
and library build passed; one additional production warm-force regression passed
afterward (127 GPU tests total), with a fresh typecheck. Five heavy GPU workloads
were excluded; this is the bounded gate, not unrestricted `pnpm check`. Default
chair settling and independent-run bunny repeatability pass. No browser playback
was run concurrently. The existing Vite chunk-size warning remains.

## 2026-10-14 — Substep traces isolate missing mesh extremity coverage

Added `scripts/sdf-impact-trace.ts`: a single target body/floor pair, at most
30 frames of substep detail after a bounded warm-up (maximum 360 frames). It
records actual mesh minimum height, curvature-seed minimum height, velocity,
contact normals, forces, retained anchor gaps and detected separation. It does
not change solver settings. Evidence: `measurements/sdf-impact-trace-2026-10-14.json`.

Chair body 6 reaches -9.081 mm at frame 94/substep 1 while its lowest curvature
seed is +21.285 mm. Bunny body 10 reaches -8.926 mm at frame 214/substep 2;
its floor contacts still report positive separation. These substep minima are
larger than the previous five-frame whole-scene samples. This identifies a
contact-coverage problem; more solver iterations alone cannot constrain an
unrepresented extremity.

Rejected trials: selecting uncovered curvature supports, sharper objective,
bypassing optimization for a support seed, adding actual mesh supports to all
pairs, and adding them only against static boxes. The last active trial improved
chair peak/final depth to 7.305/0.721 mm and final energy to 0.00001921 J, but
bunny peak rose to 22.379 mm and final energy to 0.280877 J. All experimental
physics changes were removed. Existing independent normals, warm starts and
stable ordering are preserved. An initial static-only run was a no-op because
runtime snapshots omit surface triangles; the reported active trial explicitly
preserved them. No snapshot/API expansion is retained.

Next: a deterministic support-contact candidate/retention policy that preserves
spatial coverage, assessed first on a single tilted chair/bunny and then both
piles. Do not expand random seed pools or raise sampling budgets blindly.
Transient penetration remains unresolved. One diagnostic Dawn process exited
natively; retaining its wrapper objects through asynchronous readbacks allowed
the repeat to finish. This was not a shader validation error.

Verification after removing the experiments: typecheck, 138 CPU tests, 123 GPU
tests, Vite build and library build passed sequentially at low CPU priority.
The five heavy GPU workloads were excluded to honor the bounded-work constraint;
this was not the unrestricted `pnpm check`. Chair settling and two-run bunny
repeatability passed. No new browser replay was needed for the retained diagnostics;
the production physics settings are unchanged. Vite retains its chunk-size warning.

## 2026-10-14 — Stable SDF adjacency resolves observed settling variation

3D topology assumed one manifold per pair and returned zero for every secondary
sort key. SDF's multiple independent manifolds per pair therefore tied; atomic
allocation order leaked into floating-point accumulation. Topology now sorts by
the first contact's persistent feature ID with STICK_BIT removed, after the other
body ID. Adds one read-only binding (eight total storage buffers, baseline limit),
not additional contacts or solver iterations. Standard one-manifold pairs retain
their ordering. Independent normals and warm starts are unchanged.

Two independent 180-frame bunny runs match full physical state bit-for-bit on the
same GPU. Six-second headless comparisons with 30- and 5-frame probe intervals
have identical final results despite different readback/probe timing. Two browser
replays match each other's displayed metrics and the headless report: bunny final
energy 0.0021 J, 189 contacts, 111 pairs and zero final sampled surface depth.
The viewer now probes final surface depth separately from detector contact depth.
This is evidence on this device, not cross-device/compiler determinism.

Five-frame probes measure chair peak/final depth 8.10/1.12 mm and final energy
0.0002561 J; bunny 6.78/0 mm and 0.0021134 J. Thirty-frame sampling missed those
peaks (3.46/0 mm). Transient intersections remain; do not claim collision-free
motion. Chair settling bounds remain unchanged. Raw measurements and reproduction
command: SDF_RELEASED_COMPARISON, sdf-stable-order-2026-10-14.json.

Verification: bounded sequential nice-15 gate passed typecheck, 138 CPU tests,
123 GPU tests (including unchanged chair settling and new bitwise replay), Vite
and library builds. Five heavy GPU workloads remain excluded, so this is not
unrestricted `pnpm check`. Browser and headless simulations did not overlap.
Existing chunk-size warning remains. No target-hardware performance or zero-
contention claim. Nothing committed or pushed.

## 2026-10-14 — Signed static projection and deeper-contact anchor refresh

Worst-vertex witnesses exposed embedded bunny surfaces reported as positive gaps.
Opt-in `signedSeparation` now projects mixed inside/outside samples against the
static analytic box normal. A separate opt-in `refreshDeeperContacts` releases
sticking anchors only when relocation exceeds three optimizer tolerances and the
new separation is deeper by more than one tolerance. CPU/GPU bridges preserve
point identity, independent normals, transported warm force and penalties.
Released mesh quality enables both; library/reference defaults are unchanged.

The accepted six-second comparison measured chair peak/final sampled penetration
14.11/0 mm and energy 0.00005674 J; bunny 17.58/0 mm and 0.0001905 J. This is not
zero-overlap proof: probes run every 30 frames, and transient penetration remains.
Static projection alone failed the wider gate (chair final 5.13 mm, bunny 12.77 mm).
Broad/opposed moving-surface sign variants increased residual motion and were
rejected. No regression limit was weakened. See SDF_RELEASED_COMPARISON and the
raw `sdf-anchor-refresh-2026-10-14.json` trace, including its configuration note.

Final bounded gate: typecheck, 138 CPU tests, 122 selected GPU tests, Vite and
library builds passed. Includes the unchanged chair regression, new bunny envelope,
CPU/GPU mixed-sign tests, and stale-anchor refresh with normal warm-force retention.
Five heavy GPU workloads remain excluded, so this is not unrestricted `pnpm check`.
All GPU diagnostics were sequential, at most 360 frames per pile with queue
readbacks/yields; CPU processes ran at nice 15. No zero-contention or target-device
performance claim. Existing build chunk-size warning remains. No commits/pushes.
Browser bunny playback completed six seconds and auto-paused: contact depth 0,
energy 0.0102 J. This exceeds the headless regression's 0.01 J energy envelope and
shows remaining run/backend variation; the viewer does not perform vertex probes.
Do not claim universally settled or intersection-free piles.

## 2026-10-14 — Sticking-anchor normal error and earlier mesh contacts

Fixed a constraint mismatch in GPU and opt-in CPU SDF bridges: retained sticking
anchors now supply the normal error as well as the friction lever arms. Previously
the normal depth came from a different, relocated optimizer point. A regression
perturbs the retained normal anchor and checks the actual exported GPU normal row.
Independent normals, contact identity and transported warm forces are preserved.

The released viewer's mesh-quality profile activates contacts at 4 cm, with the
same resting gap as the original 2 cm activation. Five candidates/four substeps
remain; no damping, sleeping or larger buffers. A released-settings mode retains
captured parameters. Library defaults remain unchanged.

Full four-scene six-second measurements: chair energy 0.03349 → 0.000470 J,
final sampled penetration 3.27 mm → 0, sampled peak 54.98 → 33.29 mm. Bunny energy
0.01413 → 0.000249 J and peak 43.79 → 22.02 mm, but final sampled overlap increased
from 0 to 10.44 mm. Box/gear stacks settle without sampled penetration. This is not
a complete penetration fix. Exploratory higher-budget/search/correction variants
were rejected; only consistent-anchor evaluation and earlier activation remain.
See `SDF_RELEASED_COMPARISON.md` and its raw measurement links.

Verification: bounded sequential nice-15 gate passed typecheck, 137 CPU tests,
118 selected GPU tests, Vite build and library build. A final sixth bridge test
for earlier activation passed in a focused six-test rerun (119 distinct selected
GPU tests total). The new six-second chair regression checks final energy below
0.01 J, final sampled penetration below 5 mm and sampled peak below 40 mm; the
old measured run exceeded the energy and peak bounds. Five heavy GPU workloads
remain excluded. Existing chunk-size build warning remains. No target-device
throughput or zero-contention claim; measurements drained the queue between
substeps. Browser chair playback completed all six seconds, auto-paused, and both
profile switches worked. Final browser energy was 0.0015 J, illustrating run-to-run
variation; no independent vertex probe is run in the viewer. No commits or publication.

## 2026-10-14 — Released SDF scenes and principal inertia

Added `/sdf-released.html`: original box/gear stacks and chair/bunny piles,
resolution-100 grids, exact captured mass/full inertia and reference metrics.
Principal-frame field rotation preserves off-diagonal inertia without rebaking;
contact anchors and warm starts remain in the production body's principal frame.
The six-second sequential comparison found settled boxes/gears, chair residual
energy 0.03349 J and 3.27 mm final sampled penetration, and bunny final energy
0.014130 J versus reference 0.014126 J. Transient penetration remains a gap;
see [the detailed comparison](SDF_RELEASED_COMPARISON.md) and raw traces there.

Verification: typecheck, 136 CPU tests and 116 of 117 selected GPU tests passed
initially. The failure was an obsolete test-only WGSL Body stride; updated it to
match the extended production layout and all five tests in that file passed.
Added a sixth released-scene CPU test for HTTP-decoded gzip/checksum rejection;
all six passed (137 CPU tests total across the suite and focused follow-up).
Production and library builds pass; existing chunk-size warning remains.
Five heavy GPU workloads were excluded; this is not unrestricted `pnpm check`.
GPU tests and comparisons ran sequentially, nice 15 with drained queues. No claim
of zero contention or target-device throughput. Browser verified box rendering,
all voxel loads, gear/chair/bunny playback, live metrics, pause and reset. Browser
validation caught transparent HTTP gzip decoding; loader handles both paths and
retains decompressed content hash checks. Nothing committed or published.

## 2026-10-14 — Bounded interactive SDF showcase

Added `/sdf.html` with 12-body ring, twisted-box and baked-gear presets, mixed
spawning up to 36 bodies, SDF raycast picking, kinematic-handle ball-joint dragging,
orbit/zoom, pause/reset and optional sampled contact points/normals. The gear is a
procedural watertight triangle mesh baked at resolution 32; its hole remains empty.
Warp geometry inverts the analytic field mapping, including its handedness change.
BodyMesh renders directly from GPU poses; contacts/readback are optional and
throttled. Debug snapshots hold stepping while readbacks complete.

The page caps display at 30 Hz, pixel ratio at 1.5, and catch-up at two physics
steps per frame. Hidden tabs stop stepping; paused static views stop rendering.
Candidate capacity covers every pair within the fixed 38-slot allocation (floor,
drag handle and 36 dynamic bodies). This is not a stress benchmark or paper
reproduction: mass/inertia are deliberately approximate box proxies.

Verification: all three presets rendered in the browser without reported errors;
checked mixed spawning, ring dragging/release, and contacts toggled while paused.
CPU regression checks analytic render-surface alignment, outward triangle winding
and the baked through-hole. A five/six-body GPU check covers settling, contacts,
spawning, joint dragging and removal. The bounded sequential nice-15 gate passed
131 CPU and 112 selected GPU tests, typecheck and both builds. Five heavy GPU
workloads remain excluded; existing Vite chunk-size warning remains. Final
paused-render/toggle changes were browser-checked and typecheck/build rerun.
No target-device performance claim, commit or push.

## 2026-10-14 — SDF lifecycle review: pending slot reuse

Found and fixed a P2 bug in World.add: adding, removing and replacing a body
before the pending append queue was flushed queued the same slot twice. A bounded
GPU regression reproduced three solver bodies where two were expected. Replacing
the pending record at its slot offset preserves append order and GPU body IDs.
The regression also verifies contact generation and the replacement raycast handle.

Three additional regressions verify submitted ray results across field refresh and
destruction, rejection of growth beyond device limits without losing the installed
backend, and temporary-buffer cleanup/retry after an injected host allocation
exception. This is not a real GPU out-of-memory or device-loss test.
Independent read-only static re-review found no remaining actionable issues.

Verification: typecheck, 130 CPU tests, 111 selected GPU tests on local Dawn,
Vite build, library build and git diff --check passed. Commands ran sequentially
at nice 15. This was the bounded gate, not unrestricted pnpm check: five heavy GPU
workloads remain excluded. The existing Vite chunk-size warning remains. No
target-device benchmark or claim of GPU isolation; no commit or push performed.

## 2026-10-14 — SDF runtime refresh and capacity growth

World can now stage additions/removals, including sparse or recycled slots, then
commit them with awaited updateSdfCollisions. Stepping/raycasting rejects while
dirty or preparing; omitted live fields retain their snapshots, explicit field
bindings replace them. CPU field snapshots prevent caller mutations from leaking
into later atlas rebuilds. Failed updates retain the previous backend, while
already staged topology edits remain dirty until repaired or SDF is disabled.
Updates rebuild the atlas/bridge; this is not an incremental voxel allocator.

A GPU history-transfer pass preserves only pairs whose two Body handles and
bindings are unchanged. Changed fields and same-step recycled slots invalidate
history. Surviving records retain independent normals, point IDs, anchors and
indices into the solved production contact buffers. Growth copies both production
contact parities when those buffers also need enlargement.

The existing ten-step World counter check now grows SDF capacity after overflow,
unless autoGrow is false. adaptSdfCollisions explicitly awaits a check/growth;
sdfCollisionCapacity and sdfCollisionError expose status. Stale async callbacks
check backend identity, dirty/preparing state and destruction before acting.
Only counters are read back, never poses or contacts. Overflowing frames remain
incomplete; no rewind/replay is attempted. Device-limit failures reject explicitly
or populate the automatic error status; they do not silently claim recovery.

Seven bounded lifecycle regressions cover:
- Manual and periodic growth, opt-out, and preserved warm forces.
- 65 overlapping bodies / 2080 pairs forcing production contact reallocation.
  Deep overlap changes normals, so this test verifies the full transported
  world-space force rather than incorrectly assuming a fixed normal component.
- Append/default capacity sizing, sparse removal, all slots removed, and reuse.
- Same-step remove/reuse and overlapping field replacement clear stale forces.
- Submitted field snapshots and omitted-binding immutability.
- Invalid updates preserve the old backend; stale adaptation and teardown are safe.

Verification: 130 CPU tests and 107 selected GPU tests passed on local Dawn,
plus typecheck, Vite and library builds. Existing Vite chunk-size warning remains.
A final targeted lifecycle rerun covers the capacity-sizing refinement.
Runs were sequential at nice 15; five heavy GPU cases remain deferred. No browser
visual or target-device benchmark. CPU priority does not guarantee GPU isolation.

Limits: World maxBodies remains fixed; atlas rebuilds should be batched.
Contact events retain the standard slot-pair identity semantics, so same-step
remove/reuse can appear continuous even though force history is invalidated.
Incremental voxel allocation, generation-aware events, broader scene/hardware
validation and the regularization/friction tradeoff remain follow-on work.

## 2026-10-14 — GPU spatial SDF broadphase

Replaced the automatic 64-body quadratic candidate list with a hashed centre-cell
grid and separate oversized-body list. GPU passes clear/build the grid, index
previous exact body-pair identities, and emit compact candidates with previous-slot
references. No per-step CPU pose or pair readback. Independent normal export and
force-basis transport are unchanged. Fixed fields/body slots remain a limitation.

The third World setup argument accepts cellSize/maxPairs. Defaults use the median
scaled field bounding diagonal and up to eight candidates per body, bounded by
possible pairs/device limits. Pair overflow sets counter bit 1 and counts omitted
candidates; these frames are incomplete. Re-enable with more capacity. World
automatic buffer adaptation is suspended in SDF mode because it cannot resize
SDF history buffers. Dense/oversized populations can still require quadratic work.

Five new bounded GPU regressions passed:
- 96 rotated/scaled fields (including oversized fields larger than proxy geometry):
  exact candidate-set agreement with CPU transformed-AABB brute force, no duplicates.
- 256 sparse bodies: 128 accepted pairs, 2048 candidate capacity, candidate tests
  below one tenth of all pairs. This is coverage/work-count evidence, not timing.
- 67 oversized bodies: all 66 dynamic/static pairs found; no old 64-body truncation.
- Four overlapping bodies: capacity one reports overflow and all six attempted
  pairs; recreating at capacity six restores complete coverage.
- Pair disappearance/re-entry retains surviving warm forces by exact body identity,
  while re-entering pairs have zero stale force.

Final verification: 130 CPU tests passed; 100 selected GPU tests passed on local
Dawn, with zero skips in the selected suite. Typecheck, Vite and library builds
passed; existing Vite chunk-size warning remains. The initial GPU gate caught a
WGSL hash-expression parenthesis error; corrected and reran the selected GPU suite
and builds successfully. Runs were sequential at nice 15. Five stress/showcase
cases remain excluded; no target-device benchmark or browser visual test performed.
CPU priority is lowered, but GPU scheduling/contention is not guaranteed.

Next: runtime field/body allocation, automatic SDF capacity growth, broader
mixed-size scene validation and target-device measurements.

## 2026-10-14 — Bounded non-convex collision and friction validation

Added five regressions in `tests-gpu/sdf-nonconvex.gpu.test.ts`, using two or three
bodies per scene and sequential CPU/GPU execution:

- Analytic and baked (24-cell resolution) tori: empty cavity, clearance, inner wall,
  outer wall, separation and re-entry. Active contacts, minimizer locations and
  separation agree with the CPU manifold using the GPU pair RNG policy. Normals
  point into the cavity at the inner wall and outward at the outer wall.
- Two crossed moving tori over 16 updates: multiple active contact regions,
  CPU/GPU location/deepest-separation envelopes, cached points and distinct normals.
  Non-smooth medial-axis normals are not claimed to agree bit-for-bit.
- World free fall through analytic/baked holes, with a separate positive rim
  impact. False contacts/events inside the cavity are rejected.
- Three-second flat sliding and 15-degree incline scenes compare CPU/GPU height,
  travel and speed. Every sampled GPU contact must be finite, compressive and
  inside its Coulomb cone. Sticking must engage after frictional stopping.

The initial flat frictionless speed-conservation check exposed a reference-method
bias: default collision `alpha=0.01` distributes contact samples using a repulsion
term, tilting curved-surface contact normals and introducing drag even at mu=0.
At defaults, final CPU/GPU speeds from 1 m/s were 0.8873/0.9531 m/s after 3 s.
Tightening tolerance alone did not remove it (0.9122/0.9021 m/s). Disabling collision
repulsion with `alpha:0`, `tolerance:0.001`, `maxIterations:100` produced
0.99993/0.99986 m/s and 2.99991/2.99961 m travel. This is collision alpha, not the
AVBD solver stabilization alpha. Defaults and pinned reference behavior remain
unchanged; no general claim of frictionless energy conservation at defaults.

The flat Coulomb-isolation regression explicitly uses those accuracy parameters,
retaining the physical speed-conservation assertions and checking stopping distance
against v²/(2 mu g). At mu=0.8, CPU/GPU stop after 0.05463/0.05492 m. Incline tests
retain default collision parameters: zero-friction travel is 11.4463/11.4263 m;
mu=0.8 drift is 0.000976/0.000612 m after 3 s. These are matched-proxy-mass small
scenes, not a target-device benchmark, exact trajectory parity, or a broad guarantee
for arbitrary meshes/interpenetration. The regularization tradeoff remains open.

Verification: 130 CPU tests, 95 selected GPU tests, typecheck and both builds pass;
zero skips within the selected suite. The five new GPU regressions take about 2 s
locally. The gate ran sequentially at nice 15; five stress/showcase tests remain
excluded, and the existing Vite chunk-size warning remains. No production-code
change, browser visual run, target-device benchmark, commit or publication.

## 2026-10-14 — SDF event/raycast review fixes

Reviewed the uncommitted SDF event/query changes against base 9b9c27b6 with an
independent read-only reviewer. Final re-review found zero actionable issues.
No event aggregation changes were needed; independent solver normals and warm
starts remain untouched.

Fixed pending-ray result reconstruction: the returned batch and hit points now
use the uploaded float32 ray snapshot rather than caller-owned arrays after
readback. World also captures Body handles at submission, so disabling SDF and
removing/reusing a slot cannot attach an old hit to the replacement body.

Replaced the field-space slab parallel epsilon with an exact-zero check. Scaling
a sphere by 1e13 made a head-on local direction smaller than 1e-12 and previously
produced a false miss. Regression coverage includes that case, a shallow ray
entering a long box, and a genuinely parallel miss. Both new regressions failed
before their fixes and pass afterward.

Verification: 37 targeted GPU tests, then the bounded gate's 130 CPU tests and
90 GPU tests, typecheck and both builds pass; no selected tests skipped. All runs
were sequential at nice 15. Five heavy stress/showcase tests remain deferred, so
this is not the unrestricted pnpm check. The existing Vite chunk-size warning
remains. Browser/target-device performance and extreme-float accuracy were not
validated. The documented bounded sphere-tracing nonconvergence limit remains.
No open PR exists for this branch, so no review was posted; nothing committed.

## 2026-10-14 — SDF pair events and surface raycasts

Added a reporting-only GPU aggregation pass: one synthetic manifold/contact per
physical pair, averaging solved local anchors and summing absolute normal forces.
The force-weighted representative normal does not replace any solver normal.
Independent contacts, their penalties and identity-based warm starts stay intact.
Existing ContactWatch handles begin/end transitions without duplicate point events.

World raycasts now query the packed SDF atlas with current GPU poses. They share
the standard nearest-hit reduction and masks/ignore semantics. Field-space bounds
clipping keeps samples inside the domain used for conservative warp slope bounds;
voxel slope bounds come from phi edge differences, including the outside-grid
extension. Tracing is limited to 512 samples per body/ray and 256 rays per call.
Non-convergence is a miss; this is approximate field picking, not exact triangle
intersection. See SDF_WORLD.md for tolerances and grazing-ray limitations.

Validation: typecheck, 130 CPU tests, 88 selected GPU tests and both builds pass.
The final eight World SDF tests also pass after expanded backend-switch coverage.
Existing standard World raycasts/events and bridge normal/warm-start regressions
pass. Five stress/showcase cases were excluded, so the unrestricted gate remains
deferred. Vite retains its existing chunk-size warning. No browser visual check.

All test jobs ran sequentially with nice 15. The full selected GPU suite took
57 seconds. System-wide GPU utilization sampled 94% during that run and 63% after
completion; swap remained zero. These snapshots cannot isolate this task's GPU
cost or prove no interference. CPU priority does not throttle GPU work. No stress
benchmark or target-device performance claim was made.

## 2026-10-14 — Bounded automatic candidates and World SDF API

Added createAutomatic for at most 64 fixed slots. It enumerates potential pairs
once on CPU, then filters SDF world AABBs, static/static pairs, reciprocal collision
masks and live joint exclusions on GPU. The exclusion helper is shared verbatim
with the standard broadphase. This is a bounded quadratic scan, not spatial-grid
scaling. Solver capacity is reserved for five contacts/manifolds per potential pair.
Filtered pairs overwrite their sampling history with empty results; accepted-pair
counters do not count rejected slots. Explicit candidates now use the same filter.

World.enableSdfCollisions accepts field bindings for existing bodies, defaults
unassigned boxes/spheres to analytic fields and installs the automatic bridge.
Disable restores standard collisions. Fields/mass/render-frame responsibilities
and supported operations are documented in SDF_WORLD.md. Adds/removes fail before
handle mutation while enabled or preparing; contact reporting is rejected pending
per-pair event aggregation. Raycasts retain original shapes. The API is unpublished.

Four World tests cover masks, stale force invalidation, moving out/in, joint release
and GPU-disabled joints, voxel settling, setup failures/cancellation, and 64-body
capacity/65-body rejection. The stale-cache test uses definite penetrating contacts:
a single-candidate configuration at shallow overlap did not discover an active
contact on one sampled step, so candidate count alone cannot assert active contact.
A final audit added a destroyed-owner guard before binding production buffers after
async shader compilation, with a direct teardown-during-compilation regression.

The bounded suite passes 129 CPU tests (23.85 s) and 83 GPU tests (44.91 s).
After the final teardown guard, all nine bridge/World tests pass (1.12 s), including
one new test; typecheck and both builds pass again. The only build warning is the
existing Vite chunk-size warning. Five heavy GPU tests remain excluded, so the
unrestricted pnpm check was not run. All checks were sequential at niceness 15,
with limited build workers; no benchmarks. System GPU snapshots were 58% before
and 63% after the broad run, zero swap at the initial check. No claim of zero
contention or performance on other hardware. Uncommitted/unpublished.

## 2026-10-14 — Internal production SDF collision bridge

Added an opt-in collision backend hook to GpuSolver3D and an explicit-pair SDF
bridge. GPU preparation reads production body poses, velocities and static flags,
then evaluates SDF contacts and exports one production manifold per active point.
The existing adjacency/colouring/primal/dual pipeline consumes those records. The
standard broadphase/narrowphase remains the default and resumes after detaching.

Warm starts use ordered pair identity and persistent SDF point ID, not rank or
atomic allocation order. Each SDF result records its exported production contact
slot. Previous solved forces rotate through world space into the new point basis;
penalties decay/clamp with the production mass-floor option. Sticking anchors are
retained for nonspheres. The first settling test exposed spherical anchor pinning;
refreshing spherical anchors (as the standard backend does) fixed the falling case.
The first penalty assertion also needed to isolate decay from the enabled mass floor;
reorder expectations explicitly include the changing contact-basis projection.

Four new small GPU tests cover differing normals, normal/tangent force transport,
penalty retention, pair reorder/key reset, empty candidates, sticking anchors,
mutable parameter validation, detach/fallback, and a falling sphere supported for
120 production steps. All 79 selected GPU tests pass (57.77 s), plus 129 CPU tests
(23.40 s), typecheck and both builds. Existing Vite chunk warning remains.
Commands ran sequentially at niceness 15; the five previously excluded scale and
showcase tests remain excluded, so this is not an unrestricted pnpm check. No
benchmarks. System-wide snapshots were 64% GPU before the broader checks, 71%
during, with zero swap; these do not prove zero contention with other work.

Current limits are explicit: all candidates/exclusions are caller-owned, body/field
slot assignments are fixed, capacity reserves five contacts/manifolds per pair,
and public World bindings/automatic candidate generation remain pending. No
per-frame pose/contact readback. Eight storage bindings, no optional GPU features.
See SDF_PRODUCTION_BRIDGE.md. Uncommitted and unpublished.

## 2026-10-14 — Small temporal and multi-workgroup SDF tests

Added two GPU regressions without changing production code. The temporal test
compares 72 pair updates against CPU across sphere/voxel, either body static or
both moving, rotation, COM offset, scale, separation/re-entry and warm-start reset.
It verifies cached IDs and reconstructs projected anchors. A separate 65-pair
case checks the default candidate path, curvature seeds, cache slot reversal,
rank order, duplicate rejection, finite unit normals and static-static suppression.

All five SDF GPU tests pass on Dawn (441 ms complete targeted run). Typecheck,
129 CPU tests and both builds pass; existing Vite size warning remains. Commands
were sequential at niceness 15; no stress tests or benchmarks. The broader GPU
regressions were not repeated because production code was unchanged. Unrestricted
`pnpm check` remains excluded under the bounded-load constraint. No new utilization
sample was taken; the short runtime is not proof of zero contention.

The production manifold's shared normal cannot directly represent these independent
SDF contact normals. The next bridge must address pair-cache identity separately
from solver manifold records and read production body poses on GPU. See
`SDF_GPU_DRAFT.md`. Changes remain uncommitted and unpublished.

## 2026-10-14 — First bounded GPU validation

Small real-Dawn SDF tests exposed reserved WGSL names `meta` and `active`;
renamed them `flags` and `activeCount`, preserving the ABI. All three SDF tests
pass: transformed analytic/voxel fields, contact/cache remapping and stale keys,
and optimizer positions against CPU with the same per-pair random policy.

The sequential GPU regression run passed 73 tests in 53.37 s, zero failures.
Five tests were excluded via `--test-skip-pattern` (not changed): the 2D 100k-body
scale case, 3D 820-brick scale case, showcase scenes, painting and tower repeats.
Node omits filtered tests from its count; zero reported skips does not mean the
unrestricted suite ran. No benchmarks. All 129 CPU tests, typecheck, Vite and
library builds pass afterward; existing chunk-size warning remains. Full
`pnpm check` was not run because it includes the deliberately excluded workloads.

Commands used niceness 15 and test concurrency one, with build worker limits.
System GPU snapshots were 53% before, 62% and 88% during, 69% after. Initial CPU
idle was 68.96%, swap zero. These snapshots cannot attribute utilization or prove
no slowdown of other work; niceness does not cap GPU priority. Production AVBD
integration, broader temporal parity and target-device performance remain pending.
Nothing committed or published.

## 2026-10-14 — GPU narrowphase static review and CPU regressions

Independent review found two P2 issues: mutable scales could pass JS validation
but become zero in float32, and failed pass construction leaked acquired buffers.
Upload validation now checks the float32 scale; construction cleans up acquired
buffers on failure. Two CPU tests cover scale underflow/overflow and nine injected
construction failures (six allocations, upload, two bind groups). Independent
re-review found no additional actionable regression by static inspection.

129 CPU tests pass; typecheck, Vite build and library build pass. The existing
Vite chunk-size warning remains. Commands ran sequentially at verified niceness 15,
with test concurrency one and build worker limits. CPU tests took 23.67 s and
304 MiB max child RSS; typecheck peaked at 582.1 MiB. No actual GPU device,
shader compilation or GPU tests were invoked. Full `pnpm check` remains deferred
because it includes GPU tests. These results do not establish runtime GPU parity
or zero contention with another task. Changes remain uncommitted/unpublished.

## 2026-10-14 — GPU SDF narrowphase draft; execution intentionally deferred

Wrote an internal standalone pass (`sdf-layout.ts`, `sdf-pass.ts`,
`wgsl-sdf-fields.ts`, `wgsl-sdf.ts`) without changing production GPU solver shape
encoding or contact behavior. CPU packers describe a float32 atlas, body COM/scale
transforms, explicit pairs/cache remapping, bounded parameters and contact output.
The WGSL draft covers all analytic CPU shape kinds and voxel interpolation,
Nelder–Mead, four cached/one fresh candidates, curvature sampling, cache advection,
deduplication, ranking, normals, projected anchors and pair-scoped persistent IDs.
Per-pair/step hashed RNG deliberately differs from the CPU global PCG stream.

The host pass uses a caller-supplied device, five storage bindings, explicit
submission/readback/destruction and double-buffered caches. It is not connected to
AVBD constraints or public World/BodyMesh and is not exported by the package.
`tests-gpu/sdf.gpu.test.ts` contains field, cache and CPU-optimizer parity tests,
including replay of the GPU seed policy, but none were executed. No actual GPU
device or shader compiler was invoked. WGSL validity, numeric GPU correctness,
performance and production integration remain unverified. See `SDF_GPU_DRAFT.md`.

127 CPU tests pass, including six new ABI/host-limit/decoder tests and a plain JS
mock of buffer swapping and disposal. Typecheck (including GPU test source), Vite
build and library build pass. Shader strings are not validated by these commands;
the Vite chunk-size warning remains. All local validation ran at niceness 15 with
serialized CPU tests and limited build parallelism. The CPU suite took 24.36 s,
max child RSS 302.3 MiB; typecheck peaked at 579.6 MiB. At 16:15:00 PDT a spot-check
showed 53.81% CPU idle, zero swap and 74% GPU utilization system-wide. No claim of
zero effect on concurrent work. Full gate/GPU tests remain deferred by request.

## 2026-10-14 — Direct baker comparison and CPU robustness audit

Added independent resolution-16 C++ grids and direct TS bake comparisons for
bunny, gear, cow and chair: 26,082 nodes total, maximum measured distance error
1.41e-6 normalized units, no sign mismatches outside the surface tolerance. The
gear has 157 gradient differences above 0.01 due to nonunique nearest surfaces;
the test independently projects both directions onto source triangles with Three's
closest-point routine. It checks validity rather than forcing a BVH tie winner.
Original high-resolution grids and finalized seed goldens remain unchanged.

Nested cavity, disconnected solids and non-manifold duplicate-face checks pass.
Three separated box bodies of side lengths 0.25/1/2 settle on a shared ground for
30 simulated seconds with finite poses/velocities, bounded force count and cleanup.
This is mixed-size ground-contact coverage, not arbitrary mixed-size stack proof.
Public field/body validation now rejects invalid dimensions and float32
underflow/overflow/nonfinite grids. Worker callback failures also propagate when
the thrown value is undefined, with cancellation and subsequent reuse tested.
Updated stale CPU API/unit-scaling documentation.

121 serialized CPU tests, typecheck, both builds, independent coarse-grid
regeneration verification, built-package smoke and diff whitespace check pass.
Vite retains its chunk-size warning. GPU tests/full gate remain explicitly deferred;
no GPU or browser context was created. CPU checks ran sequentially at verified
niceness 15, one test process and limited build parallelism. CPU suite took 25.91 s
with 281.3 MiB max child RSS; typecheck peaked at 581.3 MiB. A 15:57:20 PDT snapshot
showed 27.19% CPU idle, zero swap and 75% GPU utilization system-wide. These are
headroom observations, not proof of zero interference with another task.

## 2026-10-14 — Voxel seed parity and CPU unit scaling

Voxel finalization now samples retained normalized triangle surfaces by area,
using the upstream PCG sequence and float32 cumulative/barycentric operations.
Source triangle/corner order is retained before distance-query canonicalization
and BVH sorting. Worker results transfer this surface alongside the grid. The
separate `curvatureSeeds` API returns seeds without mass integration or mutation;
`scaleCollisionParams` explicitly scales length parameters and length-squared
epsilon while leaving alpha/counts unchanged. Default collision behavior stays
unchanged. GPU World integration and GPU tests are still deferred.

All four voxel assets (bunny, gear, cow, chair) match existing C++ seed counts,
ordered coordinates, COM, volume and inertia within 2e-6 relative/absolute hybrid
tolerance. Original seed/grid goldens were not changed. A separate pinned C++
exporter provides normalized surface inputs with provenance and raw-byte hashes;
independent regeneration/verification passed. This is seed-stage parity with
oracle grids, not a claim of bit-identical TS mesh baking.

114 serialized CPU tests pass, including worker mesh/seed preservation, seed-only
purity/cancellation, weighted sampling, and 1/8× / 8× seed/contact/objective scaling.
Typecheck, Vite and library builds, built public-API smoke, and diff whitespace
check pass. Vite retains the existing chunk-size warning. Full `pnpm check` was
not run because it would invoke GPU tests.

All validation used verified niceness 15, sequential commands, test concurrency
one and limited Vite parallelism. Oracle verification: 3.42 s / 132 MiB max child
RSS; CPU tests: 24.88 s / 280.4 MiB; typecheck peak: 576.7 MiB. A 15:48:46 PDT
spot-check showed 49.69% CPU idle, 5.7 GiB unused physical memory, and zero swap
usage/ins/outs. No GPU work or other-task changes; these observations cannot prove
zero slowdown to concurrent work. Changes remain uncommitted/unpublished.

## 2026-10-14 — CPU SDF baking and public preparation subpath

Added the unpublished `three-avbd/sdf` entry point: local-space mesh baking with
BVH distance queries, three-axis winding votes, topology diagnostics, allocation
limits, synchronous/cooperative async APIs and a caller-owned worker helper.
Inputs are copied before worker transfer. Unit-density mass/COM/full inertia and
projected curvature seeds are available separately. No GPU World binding or
package version change. See `SDF_BAKING.md` for units, limitations and examples.

107 serialized CPU tests pass, including six new baking/API tests. Every sampled
node of a translated cube matches the analytic box distance; a torus retains its
hole, and reversing its winding produces the same grid after canonical triangle
ordering. Real Node worker transfer, abort and reuse pass. Analytic box/torus
mass, inertia and ordered seeds match unchanged C++ fixtures. Mesh baking is not
claimed bit-identical to the upstream baker, and voxel seeds currently use
projection rather than the upstream area-weighted mesh candidates.

Typecheck, Vite and library builds pass, as do a built-package import/bake smoke
check and compilation of the documented installer against WebWorker types.
Vite retains its existing >500 kB chunk warning. No browser or GPU context was
created; GPU tests and full `pnpm check` remain explicitly deferred.

Validation ran sequentially under a verified niceness-15 parent; CPU tests used
one test process at a time, and Vite parallelism was limited. CPU suite: 22.70 s,
290.4 MiB maximum child RSS; typecheck: 575.2 MiB; Vite: 236.6 MiB; library build:
365.7 MiB. At 15:40:53 PDT, an aggregate spot-check showed 58.69% CPU idle and
zero swap usage/ins/outs. This suggests available CPU headroom, not a measured
zero-impact guarantee for the other task. No other task or checkout was changed.

## 2026-10-14 — SDF CPU reference (phase 1), opt-in AVBD bridge

Added float32 SDF fields, warped fields, voxel interpolation, PCG, objective,
Nelder–Mead and cached manifolds under `src/avbd3d/ref/sdf/`. All 4,200 field samples,
16 optimizer fixtures and 21 contact updates pass their explicit numeric envelopes;
contact counts/flags/order, optimizer counters and final RNG states match. Voxel
inputs are exported independently from the pinned C++ source; no phase-0 golden
was changed to fit the port.

An opt-in collision hook connects the fields to the existing CPU AVBD reference,
using independent contact bases and cache identities. The default box oracle
remains unchanged; existing reference regressions pass. Box stacks, a torus,
voxel gears and a bunny settle; a sphere passes through the torus hole. Mass and
diagonal inertia remain caller-owned, and mesh baking/curvature generation are
not part of this change. No public API, npm version or GPU implementation changed.

Typecheck, 101 serialized CPU tests and both builds passed. Independent voxel-grid
verification passed. All validation used verified niceness 15. GPU tests/full
`pnpm check` are still deferred by Steven, not passed. See `SDF_CPU_REFERENCE.md`
for reproduction, tolerances, limitations and resource observations.

## 2026-10-14 — SDF phase-0 coverage completed; GPU validation deferred

Extended the pinned, unmodified C++ oracle with 21 replayable manifold updates,
24 finalized curvature-seed sets, and 20 six-second scene traces (all 11 released
scenes plus nine Table 5 warp-strength variants). PCG draws are recovered from
before/after state without changing the RNG. A headless SDL adapter handles only
asset lookup and throws on missing assets; no graphics library or GPU is used.

Independent rebuild/verification reproduced all 71 JSON fixtures exactly on Apple
Clang 17. Typecheck, 89 serialized CPU tests, Vite build and library build passed.
The full `pnpm check` was intentionally **not run**: Steven requested that GPU tests
be deferred to avoid competing with another task. The Vite chunk-size warning
remains. No runtime engine code or public API changed.

At frame 360, released Box Stack: 196 contacts / 5,577 paired queries per frame;
Gear Stack: 47 / 3,128. Contacts refer to the last substep; query/iteration totals
sum four substeps. These do not match the paper table counts, and are not claimed
as paper-scene reproduction or GPU performance. Energy/penetration traces and
independent mesh-vertex penetration probes are reference baselines; the probes
are sampled lower bounds, not exact intersection depth. See the oracle README.

Shared-machine measurements: 19 one-second CPU samples over 15:06–15:12 PDT showed
49.66–77.67% idle (median 62.31%), with zero swap-in/out counters. Verified oracle
reproduction took 23.47 seconds, max child RSS 143.1 MiB; serialized CPU tests took
21.28 seconds, max child RSS 290.5 MiB. Typecheck peaked at 574.3 MiB. These are local
resource observations, not target-hardware benchmarks. Initial `nice` requests
were rejected by the sandbox; final verification/tests/builds ran with niceness
15 confirmed outside the sandbox. No saturation or swapping was observed, but
other-task latency was not measured, so zero slowdown cannot be established.

## 2026-10-12 — SDF oracle foundation (phase 0, levels 1–2)

Added `tools/cpp-oracle-sdf/`: a headless driver linking unmodified sdf-dcd-demo
at `1dcdf1e7fa07d16fda15826ad8c2e6697075a76e`. It captures 24 SDF fields (including
four resolution-100 voxel assets and Table 5 warp strengths), 175 points each,
and 16 domain-clamped Nelder–Mead cases. Source/asset/compiler/driver provenance
is recorded; explicit generation is separate from non-overwriting verification.
Apple Clang 17, f32, no FMA contraction or fast math: separate builds reproduced
all JSON exactly. Query counts are objective evaluations, not individual SDF calls.

This is fixture infrastructure only, not an SDF port or a benchmark reproduction.
Manifold/cache/random-draw fixtures, curvature seeds and scene metrics remain.
See `tools/cpp-oracle-sdf/README.md` for the inputs, commands and limits.

## 2026-10-12 — Raw readback integration for #16

three-destruction assembles counters from its own batched GPU readback. Without forwarding
`tailBodies`, `adapt()` deliberately keeps the conservative scheduling hint. Export
`C_TAIL_BODIES` from the advanced entry so raw-buffer consumers can forward the optional
counter without hardcoding an offset. Older consumers remain valid; omitting it affects
performance only. The full gate passes: 81 CPU, 88 GPU (zero skips), typecheck and both
builds. Downstream activation and play-session measurements are recorded in three-destruction.

## 2026-10-12 — Combined solver integration (#14/#16/#17/#15)

All required gate components pass together: typecheck, 81 CPU tests, 88 Dawn GPU tests
(zero skips), Vite and library builds. `reuseManifolds` remains false by default; the
consumer's existing `solver.step()` calls detect every substep. Against pre-optimization
main 9b9c27b, all six complete body-state buffers are bit-identical at 60 and 180 steps,
both with ordinary settings and `--color-stress` (iteration/alpha/cap changes). The harness
retains the 1,000-body dense-tail case, the jointed sparse-label hub and mixed-size scene.

Combining dynamic-only probes and grid levels required a fine-fixed/coarse-dynamic auxiliary
query; the explicit ownership-matrix test covers both index orders and excludes duplicates.
The previous individual performance figures are historical; downstream combined benchmarks
are recorded separately in three-destruction's docs/perf.md.

## 2026-10-12 — #15: opt-in contact-manifold reuse between explicit substeps (STE-2538)

`step({ reuseManifolds: true })` retains the previous contact set, recomputes its
separation from current poses, and applies the existing warm-start decay. It skips the
broadphase/hash/narrowphase, while adjacency, coloring and solving still run each substep.
The first call, body/filter/constraint writes, capacity changes and queued World kinematic
moves force detection. Custom contact shaders without the entry point fall back to detection.
Default `step()` and `update()` keep their prior behavior. Detect at the start of every frame;
this is not CCD and is unsuitable for fast impacts or rapidly changing contact normals.
Broadphase diagnostics explicitly refer to the last detecting step during reuse.

Validation: typecheck, 81 CPU tests, 82 Dawn GPU tests (zero skips), Vite and library builds
pass. Seven new GPU cases cover refreshed separation, first-call fallback, invalidation,
empty sets, a supported stack, retained pair diagnostics, queued kinematics and rotating hull
friction (some cases cover more than one behavior). A no-reuse comparison against main
9b9c27b has bit-identical complete body buffers at both 60 and 180 steps in all four scenes.

Measured on M4 Max under shared load (uptime load 12.31/10.49/10.58, GPU utilization sampled
at 47%). Three sequential, back-to-back baseline/candidate comparisons, dt=1/120, candidate
reusing every second substep. Each run warms up 60 steps, times 120 steps, and profiles nine
fresh/reused pairs (median pair-average GPU timings). Command:
`node --experimental-transform-types scripts/compare3d-gpu.ts <baseline> --reuse`.
Omit `--reuse` to require exact default-path body-state equivalence.

| Scene | Wall ms/step old → reuse | GPU collision ms old → reuse | GPU total ms old → reuse |
|---|---:|---:|---:|
| 10,000 fixed + 512 movers | 1.002 → 1.023 | 0.131 → 0.066 | 0.590 → 0.524 |
| 125-body pile | 0.979 → 0.988 | 0.164 → 0.098 | 0.721 → 0.623 |
| 32-joint hub | 1.011 → 0.975 | 0.066 → 0.066 | 0.623 → 0.623 |
| Mixed-size fixed grid + 512 movers | 2.419 → 1.482 | 1.901 → 0.983 | 2.490 → 1.475 |

Opt-in maximum position differences at 60 / 180 steps: fixed-heavy <1e-9 m; pile
0.013918 / 0.004175 m; hub 0 / 0.074111 m; mixed-size <1e-9 m. The hub's later impact
shows why early equivalence is insufficient and why this option remains off by default.
All sampled positions remain finite and no capacity overflow occurs. Collision savings are
clear in the expensive mixed-size case; smaller cases have mixed wall results, so no general
FPS improvement is claimed. Timestamp quantization and shared load limit small timings.
No older-device or three-destruction play-session validation yet. The measurements above preceded integration with #16/#17; they must not be added
together as an estimated combined speedup.

## 2026-10-06 — Joints that hold a turn and bend for good: a rest rotation, yield, a bend limit, per-joint thresholds

Why: three-destruction (`three-destruction/avbd`) builds falling building sections and hinges on
the GPU joints, and 0.2.2 made it work around three things. `appendJoints` took one break
threshold per call (so it grouped joints by force and made one upload each). The angle lock
forced the two bodies' rotations equal, so a hull's principal frame, up to 45° from its
neighbour's, was twisted into line: it held each link with three ball joints instead of one fixed
joint. And a joint always sprang back to its rest pose (hinges faked a bent rest by removing and
re-adding a spring from readbacks).

What (`GpuSolver3D.appendJoints`, `World.addJoint`, the reference `Joint`; layout in `layout.ts`):
- A joint's own `fracture` and `linear` over the call's.
- A rest rotation per joint (`rest`, `J_REST`): the angle lock holds rotB = rotA·rest, with the
  error 2·vec((rotA·rest)·rotB⁻¹) times the torque arm, taken in the hemisphere with w >= 0 (q and
  −q are one rotation). The identity, the default, is the demo's joint.
- Yield (`yield`, `J_YIELD`, in the spare w of C0's angular vec4), on a rigid angle lock only: in
  the dual update a force asked of it past `yield` but not past `fracture` moves its rest to
  `rotA⁻¹·rotB`, zeroes the step's reference error C0 and cuts |λ_ang| back to `yield`; the
  penalty is not ramped while it gives (the force is at its bound, as a clamped one's).
- A bend limit (`breakBend`, `J_BREAK_BEND`, in the spare w of B's anchor), on a plastic joint:
  when it gives and has then bent past the limit, the turn from the rest it started with
  (`J_REST_START`) to the one it holds, it breaks, as by fracture. Tested in the dual update
  (`dualJoint`, `Joint.updateDual`) in each iteration that the joint yields in. See below for why
  fracture alone cannot do it.
- The joint record is 40 floats (`JOINT_FLOATS`, 32 before): the rest, the rest it started with,
  and the yield and bend-limit words in spare w's. Breaking for raw readers through
  `three-avbd/advanced`. The warm start and the dual store back only the fields they change.
- Skipped: linear (positional) plasticity. The linear rows stay hard, and break on `linear`.

### The default twists, the rest holds (GPU, Dawn on the M4 Max)
Two unit boxes in free fall, spinning, B turned 30° about a skew axis from A, joined at a shared
face, the angle between them after 10, 30 and 60 steps:

| | 10 | 30 | 60 |
|---|---|---|---|
| default (identity rest), A turned or not | 27.07° | 22.07° | 16.28° |
| `rest = rotA⁻¹·rotB`, either sign of B's quaternion | 30.00° | 30.00° | 30.00° |

The default's numbers are three-destruction's (27°, 22°, 16°) to the digit. For bodies whose
quaternions share a hemisphere and that are turned less than 180° apart, which is all that was
measured, the identity rest changes nothing: the CPU reference with it set to the identity is
bit-identical on Breakable, and the oracle fixtures and the seeded parity tests are unchanged.
Outside those cases it is a fix, not a no-op. The demo's lock, qsub(rotA, rotB), takes the long
way round when the two quaternions have opposite signs or the bodies are turned apart by more than
180° (rotA·rotB⁻¹ has w < 0), and its error then pushes the bodies apart: a latent error that
the short way round, taken for every joint, removes. The GPU's lock takes it for default joints
too; the reference's no-rest branch was left as the demo's, so the two disagreed there. Both do
now (`Joint.evaluateAng`).
- Measured on the reference as it was (two unit boxes in free fall, 30° apart, spinning, no rest,
  B's quaternion negated): the angle between them came out right (29.7°, 29.4°, 29.1° after 1, 2,
  3 steps) but each body tumbled at up to 92 rad/s in the first step (2.5 rad/s with B's sign
  positive), and a seeded single step differed from the GPU's by 1.77 in a pose component. Now
  the negated pair is the positive one's
  exactly (B's quaternion the negation of it: no difference at all over 40 steps), and B turned
  200° from A is B turned −160° to 1.6e-12 (`tests/joints.test.ts`; the seeded step in
  `tests-gpu/avbd3d-gpu.gpu.test.ts`).
- With a rest, B's quaternion of opposite sign and no short way round drift to 29.5°, 29.6°,
  29.7°: the error then points the long way, and the lock pushes the bodies off the turn it holds.

### What a plastic hinge does: it carries `yield`, and swings a load as a hinge
CPU reference (f64), a cantilever of four 1 m links with a weight on the end, 10 iterations,
dt 1/60, the weld at the wall yielding at |λ_ang| = 60 (torque arm 7.38, so 443 N·m). A rigid-
plastic hinge swings a load W until W g L sin φ = M φ (L = 4.3 m out, M = torqueArm × yield);
the simulated furthest swing against that:

| yield | weight | load / hinge moment | simulated | ideal |
|---|---|---|---|---|
| 60 | 12 kg | 1.17 | 64.3° | 54.1° |
| 60 | 15 kg | 1.46 | 89.6° | 82.8° |
| 60 | 20 kg | 1.94 | 111.0° | 106.6° |
| 100 | 20 kg | 1.17 | 64.4° | 54.1° |
| 100 | 30 kg | 1.75 | 103.3° | 98.9° |
| 30 | 6 kg | 1.17 | 65.9° | 54.1° |

The swing overshoots the ideal by 4–12° (the beam's own mass and the solver's damping), so the
hinge does carry about `yield`: `tests/joints.test.ts` holds it to 12°. |λ_ang| never passes
`yield` (60.0 over a 600-step run). On the GPU the same beam turns 11.9°, 43.0°, 80.0°, 106.0° at
0.5, 1, 1.5 and 2 s against the CPU's 11.9°, 43.0°, 80.2°, 106.7°, and settles at 108.8° (CPU
109.9°); a seeded single step of a joint asked for a lot at once matches the reference to 9e-8
(yield, fracture, the rest it moves; `tests-gpu/avbd3d-gpu.gpu.test.ts`).

### Fracture above a yield: what the dual sees
The dual tests fracture on the force asked, |k·C* + λ|, before the cut-back; but a hinge that
gives is cut back to `yield` every iteration, so it sees little more than yield plus one
iteration's slip. Same beam, yield 60, the largest force seen over a run against the static
demand of the load (W g L / torque arm):

| weight | 2 kg | 5 | 10 | 15 | 20 | 30 | 40 | 60 |
|---|---|---|---|---|---|---|---|---|
| static demand | 12 | 29 | 58 | 87 | 117 | 175 | 233 | 350 |
| seen by the dual | 30 | 61 | 63 | 69 | 74 | 79 | 81 | 86 |

So an angular fracture just above the yield tears only what arrives all at once, and a heavy
static load makes the hinge swing rather than tear. (A joint set up so, a finite `breakForce`
above its `yieldForce` and neither `breakOnPull` nor `breakBend`, warns once.) Two ways make a
load break a plastic joint. Its bend (`breakBend`, next section) is for a hinge that a load keeps
bending. Its pull (`linear`: |λ_lin| is the weight it carries, in newtons, and stays hard) is
for a joint that carries a weight: the Plastic Beam's wall weld (bends at 700 N·m, tears at
400 N) pulled up to 139 N under 8 kg (bent, held), 255 N under 14 kg (a folded beam, held) and
~550 N under 25 kg (CPU: torn at 20 kg and up, not at 14). With `linear` the one threshold is in
newtons for the pull and applies to the angular force at the same number.

A load put on all at once overshoots to about twice its static demand before the solver settles:
5 kg asking 29 reached 61 and gave 1.7° with a yield of 60; 2 kg stayed at 30 and held.

### A bend limit: a sustained overload tears a plastic joint
The limit is on the net bend, the angle between the rest the joint holds and the one it started
with (so it is what `Joint.bend` says, and a hinge bent one way and back is as far from where it
started as it ends up). Tested only when the joint yields, as that is the only time the rest
moves. The start rest has to be in the record (a quaternion needs four words, and only three
were spare), hence the second growth of `JOINT_FLOATS`. An accumulated angle, the path length of
the rest's turns, would fit in a spare word and need no start rest, but it measures something
else: a hinge swung back and forth would count both ways, and it would no longer be the number
`Joint.bend` and the HUD report.

The cantilever of four links with a weight on the end, the weld at the wall yielding at 60 and
tearing at 120 (never reached: the dual sees 60), breakBend 0.6 rad (34.38°), 10 iterations,
dt 1/60. One scene, run on the reference (f64) and on the GPU built from it. Without the limit
every load holds, however far it swings; with it:

| weight | 4 kg | 6 | 8 | 10 | 12 | 15 | 20 |
|---|---|---|---|---|---|---|---|
| bend with no limit, held: CPU | 0.85° | 2.95° | 8.39° | 33.19° | 64.26° | 89.56° | 110.03° |
| the same, GPU | 0.85° | 2.92° | 8.30° | 32.83° | 63.47° | 88.40° | 108.87° |
| with the limit, CPU | holds | holds | holds | holds | step 70, 34.41° | step 59, 34.51° | step 53, 34.45° |
| with the limit, GPU | holds | holds | holds | holds | step 71, 34.66° | step 59, 34.50° | step 53, 34.45° |

A load that bends it less than the limit leaves it holding (10 kg, at 33.2°, 1.2° short); one that
bends it further breaks it within the turn of an iteration of the limit (0.03° to 0.28° over),
and the heavier the sooner (53, 59, 70 steps). The GPU breaks in the reference's step or one
later, with the bend within 0.25°. A seeded single step of a joint within its limit, past it
(it breaks in an early iteration, at 3.12° of bend) and one that began with a rest of 25° (it has
bent 3.29° from it, not 25°) matches the reference on whether it breaks, and on the bend to
7e-8 and the poses to 2e-7 (`tests-gpu/avbd3d-gpu.gpu.test.ts`).

### Why C0 moves with the rest (and the penalty does not ramp)
The step's reference error C0 (Eq. 18) is computed once, at the start of the step. A joint that
gives in a step it began with a large error, the rest moved but C0 kept, had the stale C0 pull
the new rest's error back: two bodies 20° off their rest, a yield of 0.05, no gravity, ran away,
B at 28°, 36°, 60°, 99° after 1, 2, 5, 10 steps and 139° after 120. With C0 zeroed the offset
becomes the bend (B at 19.9°, 19.9°, 19.6°, 19.6°; a rigid joint instead corrects it slowly,
19.8° to 6.0° over 120 steps). In steady flow C0 is already ~0 (the rest sits where the bodies
ended the last step), so this only matters at the first yield, but there it is the difference
between a joint and a runaway.

Ramping the penalty while a row gives (β|C| an iteration) made the 20 kg beam swing 116° against
111° (ideal 107°) with an angular penalty of 1265 against 301 after 400 steps (30 kg: 138° against
131°, 1992 against 394): a hinge that stiffens as it flows. A row at its bound isn't ramped, as
the paper's clamped forces aren't.

### The Plastic Beam demo
A cantilever of eight links, every weld plastic past 700 N·m, the wall's weld tearing at 400 N of
pull. 2 kg: 0.3° of bend, holds. 8 kg: 21° at the wall and about 43° at the tip (GPU, 6 s; CPU
21°); cut the weight loose at run time and the bend stays (`Sim3D.cut`). 25 kg: the wall's weld
tears at about 1.2 s and the beam falls. From 10 kg up the beam folds along its length instead.

### Cost: within the noise
The joint record was 144 bytes (36 floats) where it was 128 on main, and the angle lock
multiplies the rest in; the bend limit made it 160 bytes (40 floats). The first measurement is
against main (a copy of its tree on the same Dawn device, M4 Max, the two run alternately). The
machine's own spread dwarfs any difference: on battery the same code varied 14 to 22 ms a step
on the lattice below, and charging at 8% it still spread 6.6 to 11.6 ms on the Jointed drop.
Fastest and median wall ms per step:
- `pnpm bench3d:gpu`, "Jointed drop 34k (71k joints)", 10 runs each: main 6.64 / 9.47, here
  6.82 / 8.91 (the GPU phases' fastest: 6.03 and 6.09). Chain mail 1.6k, 4 runs each: 1.14 / 1.21
  and 1.15 / 1.24. Jointed drop 6k: 3.17 / 3.42 and 3.16 / 3.49.
- A 24,000-body lattice of 71,500 joints, 10 iterations, 8 runs each, fastest: ball joints 4.89
  on main and 5.03 here; rigid joints (the angle lock live) 7.09 and 7.36.
- Main with only the 144-byte record (6 runs of the Jointed drop) tied with both, at 6.57.

So no cost shows beyond a few percent, under that spread. The warm start and the dual store
back 6 and 4 of the record's 9 vec4 (10 now) where they stored all 8. Re-run on a quiet machine
before quoting a number.

The second growth, 144 to 160 bytes and the bend test in the dual, against the tree before it
(the same device, alternated, then again with the order reversed; the machine was busy, load
average about 16, which is the spread):
- "Jointed drop 34k (71k joints)", 18 runs each, wall ms per step, fastest / median: 6.55 / 7.60
  before, 6.72 / 7.42 after (GPU phases: 6.03 / 6.58 and 6.16 / 6.46).
- Jointed drop 6k, 22 runs each: 3.50 / 3.83 before, 3.62 / 4.03 after (GPU phases 2.69 / 3.21
  and 2.82 / 3.04). Chain mail 1.6k, 6 runs each: 1.30 / 1.50 and 1.34 / 1.58.

The sign of the difference changes with the statistic, and each tree's own spread (3.5 to 4.9
ms on the 6k) is larger than it: no cost shows, and none is claimed. A joint that does not
yield never enters the bend test; what it pays for is the larger record.

## 2026-09-27 — Bodies lost to NaN at high mass ratios: negative pivots in the f32 primal solve

three-destruction's urban demo lost bodies when fragments of a few grams were crushed under
floor slabs of about 30 t. A lost body then spread NaN to the whole scene: comparisons with NaN
pass every broadphase test.

**Cause.** `finishBody` solves each body's 6x6 Newton system with an unpivoted LDLᵀ in f32. A
sliver resting on an edge under the slab has contact rows near PENALTY_MAX (1e10). Rotation
about that edge is held only by its inertia term, I/h² ≈ 1e-3, about 12 orders of magnitude
below the rows around it. In f32 that pivot cancels to noise.

**Measured on the CPU** (the shader's elimination order, `Math.fround`, 0.6 g sliver, two edge
contacts, h = 1/120):

| contact stiffness k | exact last pivot | f32 last pivot |
|---|---|---|
| 1e8 | 4.6 | 4.6 |
| 1e9 | 4.6 | 2.6 |
| 1e10 | 4.6 | −18 |

A negative pivot turns that direction's Newton step into ascent. The body spins up over the
iterations to Inf, then NaN.

**Fix.** Each pivot is floored at `PIVOT_FLOOR` (1e-5) times its diagonal: `D = max(D, A_kk · 1e-5)`.
This stiffens only a direction that ill-conditioned (130 instead of 4.6 in the example), and the
parity tests are unchanged. `tests-gpu/pivot.gpu.test.ts` seeds that sliver from the reference
with every contact at PENALTY_MAX, spinning at 3 rad/s about the edge. Without the floor it is
NaN within 20 steps; with it, it stays finite and in place.

**In the urban demo** (three-destruction at ef3edfd, mass floor off, `pnpm stress`):
- without the floor, 3 of 9 runs lost bodies, 1,042 to 1,382 each;
- with it, 0 of 8 runs lost any.

## 2026-09-26 — The GPU tests' intermittent crash: a timing read destroyed mid-map

The GPU suite used to die about one run in four (`pnpm test:gpu`: the process exits with no error,
the file reported only as `'test failed'`), always at the same point in `avbd3d-gpu.gpu.test.ts`:
as the friction test's solver was destroyed and the spring test began. It crashed as often before
the 0.1 library work as after (3/15 vs 4/15 runs, the same file), and in one process
(`--test-isolation=none`) as in its own, so it wasn't the runner.

Cause: a step timed with timestamp queries (GpuSim3D profiles one step in 30) maps its timing
read buffer asynchronously, and `destroy()` destroyed that buffer and the query set while the map
was pending. The browser rejects the map; Dawn under Node crashed. Measured on the spring, joint
and friction tests: 10/10 runs crashed with timestamp queries, 0/10 without them.

Fix (both solvers): `destroy()` leaves a timing read that is still mapping alone, and the read
destroys the timing buffers when it settles. After it: 0/10 on those tests, and the whole GPU
suite passed 6/6 runs.

## 2026-09-25 — Convex hull shapes (GPU-only)

Why: three-destruction (sbobyn/three-destruction, `three-destruction/avbd`) runs Voronoi fracture
pieces on this solver. As fitted boxes they were 2–4× their own volume: pieces rested on corners
with gaps or sank into the ground, a break's pieces were born overlapping (the solver pushed them
apart at ~0.5 m/s, with contact forces of 7–157 kN between 0.1 kg pieces), and non-convex
originals collided as one box.

What: `SHAPE_HULL` bodies (`hull(solver, convexHull(points), …)`, `src/avbd3d/shapes.ts`). The CPU
builds the hull (incremental, coplanar triangles merged into polygon faces so a flat side is one
face), the edges with their two faces, and the mass properties; vertices go into the principal
frame (the solver keeps three principal moments). The GPU narrowphase (`gpu/wgsl-hull.ts`) handles
any pair with a hull on a side: SAT over both shapes' face normals by support points, then only
the edge pairs whose Gauss-map arcs cross (Gregorius, GDC 2013), so an edge pair costs a few dot
products; face contacts clip the incident face by the reference face's side planes and keep at
most 8 points (the deepest, then the farthest from those kept); edge contacts take the edges'
closest points; a sphere meets the hull's closest surface point. Box-box and sphere pairs keep
their paths.

Binding limit: the contacts module then binds nine storage buffers, over WebGPU's default of
eight per stage. Hulls are on where the device was created with
`maxStorageBuffersPerShaderStage >= 9` (Apple and desktop GPUs report 10–31+; app3d and the GPU
tests request the adapter's limit, the bench pages don't); otherwise a hull collides as its bounding box
(`GpuSolverOptions.hulls`, test). The hull narrowphase compiles when the first hull is added.

Measured (M4 Max, Dawn): hull GPU tests (8 in the first PR, 9 since): a box-shaped hull rests within 2 mm of the same box; a
tipped tetrahedron lands on a face and stays (lowest vertex within 3 cm of the ground, i.e. the
collision margin); a sphere rests on a hull slab; a pile of 24 random 14-point hulls settles
(none below −3 cm, fastest < 5 cm/s after 8 s) with hulls resting on hulls; the box fallback.
`pnpm check`: 58 CPU and 34 GPU tests pass (the GPU tests now run with hulls on); 35 GPU tests with the growth test below.

Review follow-ups: hulls are capped at 32 vertices (the builders keep the most spread-out ones), so
faces, edges and contact points fit the 8-bit feature keys and a pair's cost is bounded; the hull
buffer holds u32 words (floats bitcast: small integers stored as f32 would be subnormals, which an
implementation may flush); an explicit `hulls: true` still respects the device limit; a test grows,
frees and reuses the hull buffer. Cost, 80 random hulls falling in a heap, collision phase per step:
~0.9 ms at 14 vertices each, ~2.2 ms at 25 (boxes: 0.07 ms for 40). The edge query is 70-75% of it
(0.5 ms without); caching each pair's last separating axis (Gregorius) would be the next step. Box scenes are
unchanged: Brick ring 110k, three alternating runs each, wall 11.9 / 12.7 / 10.1 ms (main) vs
10.9 / 11.4 / 9.3 ms (branch), collision 2.7–3.7 ms on both (the machine was noisy).

## 2026-09-25 — Stage 8o: deterministic GPU steps (same device)

Measured with `tools/determinism.ts`: build a scene twice, step both, and compare the body
buffers bit for bit every 20 steps.

| scene | before | after |
|---|---|---|
| Box Pile (4k), 600 steps | differ by step 30; at step 70, 73% of bodies, up to 22 cm | identical |
| Brick Ring (28k), 600 steps | not measured | identical |
| Ragdolls on Cloth (24k), 600 steps | not measured | identical |

Two sources. First, each body's constraint list was filled with atomics, in a different
order every run. The primal solve sums its constraints in list order, so the rounding
differed, and a chaotic pile amplifies that. A `sortAdjacency` pass (shared 2D/3D topology)
now puts each list in a fixed order: joints by id, then contacts by the other body and a
secondary key. It costs about 1% (110k ring, raw solver: 15.6 vs 15.5 ms per step).

Second, capacity overflow. With the sort but the default capacities, the pile still split at
step 80, exactly when manifold storage overflowed: which records an overflow drops depends on
thread timing. The solver's new `capacity` option sizes contact storage and colours up front.
A deterministic run uses it and never calls `adapt`, whose growth follows readbacks that land
on different steps each run.

A control run with the roomy capacities but no sort split by step 40, so both fixes are
needed. The Jones-Plassmann colouring was already deterministic: it runs Jacobi rounds with
hashed priorities. The 2D solver has the sort but no `capacity` option yet, and hasn't been
measured.

## 2026-09-24 — Stage 8n: heavy bodies sank through the floor; contacts start at m/dt²

The viewer's cannonball panel goes up to 10 t. From 500 kg up, a ball dropped at 45 m/s on
the floor went straight through the 1 m ground slab (GPU, default parameters):

| ball (r 0.7 m) | lowest centre, demo penalty | with `massPenalty` |
|---|---|---|
| 43 kg | 0.72 m | 0.77 m |
| 500 kg | −17 m (still falling) | 0.77 m |
| 10 t | −59 m (still falling) | 0.77 m |

A new contact starts at PENALTY_MIN = 1 and ramps by β|C| (1e4 × |C|) an iteration, while a
body's own term in the primal Hessian is m/dt² (3.6e7 for 10 t). The contact can't push back
until many steps later, and once the centre passes the slab's mid-plane the normal flips.

`massPenalty` (GPU only, on by default; FLAG_MASS_PENALTY) starts a contact's normal penalty
at no less than the lighter dynamic body's m/dt². That removes about half the error per
iteration from the first one, whatever the mass. For unit boxes and bricks this is ~10³,
below where their penalties settle, and friction rows keep the demo's ramp.

- The GPU tests pass with it on: stack, pyramid, and Coulomb friction.
- The parity test turns it off, as it does the other GPU-only rules. The CPU reference stays
  a faithful port and doesn't have it.
- Brick Walls (27k): 1.1–1.3 ms/step with it on, 1.2–1.4 off.

The ~0.45 m dip at 0.77 for every mass is separate. A 45 m/s body travels 0.75 m in a step
before any contact exists (there are no speculative contacts), and α = 0.99 keeps most of
that penetration, so the ball climbs back out over a few seconds.

## 2026-09-24 — Stage 8m: tall brick walls at 4 iterations; slow bodies start at rest

Follow-up to 8l's creeping walls. Headless probes: walls built into a reference `Solver` and
run on it or on `GpuSolver3D`, adapting every 30 steps; a brick counts as fallen once it has
moved > 0.5 m sideways or turned > 0.15 rad, and a wall "falls" when more than 1% have.

### It is AVBD at 4 iterations, not the GPU port
- A 40-course ring one brick deep at radius 5 (1,200 bricks): the CPU reference falls at
  11 s, the GPU at ~18 s. A 40-course straight wall 8 bricks long falls at 4-6 s on both.
- One 40-course ring at radius 40 (9,840 bricks; the 110k ring's rings are 2 cm apart, so its
  inner ring is this wall) fails on the GPU like the 110k ring, at 6 s, in under 1 s of wall
  time per 20 s simulated. It was the test bed for everything below.
- The mode is buckling, not sliding: the lower wall tilts in, the upper wall out (top course
  4 mrad at 3 s, 40 mrad at 5 s). At 4 iterations only 7% of contacts are sticking and 10%
  carry no normal force (median 0.4 N); at 10 iterations all stick and the load is even
  (median 3.9 N). Penalties are not the difference: median normal penalty 1.7e3 at 4
  iterations, 1.15e3 at 10.

### The 1 cm per course is the collision margin
The demo's normal row is n·(xA − xB) + `COLLISION_MARGIN` (1 cm, in the reference and on the
GPU), so a resting contact sits 1 cm deep. The 40-course ring's top course at 3 s is 33 cm
down with the margin and 8-9 cm down with 1 mm or none; with stiff normals (below) it is
exactly 40 × 1 cm. It has nothing to do with the collapse: with no margin the wall still
falls at 6 s. Also tried on the radius-40 ring, fall time against 6 s:
- alpha 0.9 / 0.95 / 0.999: 8 / 12 / 5 s. gamma 0.99 / 0.9999: 7 / 6 s. betaAng 1e4: 6 s.
- betaLin 1e3 / 1e5: 6 / 6 s; 1e6 stands, but blows bricks out of the wall at ~4 s.
- λ warm start without alpha (λ·γ): 5 s; λ·0.95: 9 s. STICK_THRESH ×10 or ×100: 6 s.
- Colouring order: the reference's sequential Gauss-Seidel (newest first, so the top course
  first) does worse than the GPU's colours, not better.
- A floor on the normal penalty: 3e4 and 1e5 stand 40 s, 1e4 falls at 7 s, 3e5 and more blow
  the wall apart in the first second. Too narrow a window to use.
- Bricks built pre-sunk by the margin: still 6 s. A 3 s settle at 40 iterations, then 4:
  25 s. Neither is a fix.

### The cause: the adaptive warm start
Each step's iterations start from x- + v·dt + w·g·dt², where w is the downward part of last
step's acceleration over g (VBD's adaptive initialisation, as in the demo). Four iterations
don't correct that guess in a resting stack. The unconverged part of the old velocity carries
over to the new one, and w turns jitter into a push down into the supports. The wall swells
(its top 5-7 cm above where it started by 4-5 s), then buckles. Radius-40 ring, 4 iterations:

| First guess | 40-course ring (9.8k) | 110k ring |
|---|---|---|
| demo: x- + v·dt + w·g·dt² | falls at 6 s | falls at 7 s |
| w = 1 | falls at 4 s | — |
| w = 0 | stands 40 s, drift 0.23 m | falls at 14 s |
| x- (no extrapolation) | stands 40 s, drift 2 cm | stands 40 s, drift 6 cm |

The CPU reference agrees (a patched copy, the 1,200-brick ring): w = 0 falls at 12 s (from
11), starting from x- at 27 s. Starting every body from x- damps real motion, though: in the
GPU tests a sliding box went 2.26 m where Coulomb says 3.16, and the 50000:1 pendulum's joints
stretched 0.29 (limit 0.15).

### Fix: slow bodies start at rest (GPU `startAtRest`, on by default)
A body whose fastest point is slower than 0.1 m/s (|v| + |ω|·r, `REST_SPEED`; g·dt is
0.17 m/s) starts its iterations from x-; faster bodies keep the demo's guess, so sliding,
swinging and flying bodies are untouched and every GPU test passes. A cutoff of 0.01 or 0.03 m/s
falls at 6 s; 0.1 and 0.3 stand 60 s. The reference is unchanged; the parity tests turn the
option off. The viewer has a toggle for it, and the 28k ring is back at the paper's 4 iterations.
At 4 iterations with the fix:
- 110k ring unhit: stands 40 s (drift 5 cm). 28k ring unhit: stands 60 s (fell at 18 s).
- 40-course ring at radius 40: stands 60 s (drift 3-4 cm), and 40 s at 3 iterations; at
  radius 5, 40 s. The 40-course straight wall stands 30 s (fell at 6 s); only the top
  course's end brick, which overhangs by half its length, drops, as it does at 10 iterations.
- 28k ring smashed: 12.3-12.7k of the 28k bricks down by 5 s (12.2-13.1k without the fix).
  Bricks that fall between 10 s and 40 s now come from the ball's exit breach, where
  without the fix they came from all round the ring. The 4-iteration wall is still weaker
  under impact: at 10 iterations the same smash brings down ~5.1k bricks, with or without the
  fix, and nothing moves after 10 s.

Timing: an interleaved A/B of two solvers (fix on / off) put every small scene within ±3%,
but it ran on battery (the 110k ring at 17-23 ms against 9.3 ms on AC), so its numbers are
not recorded here, and `docs/data/bench3d/m4-max.json` still holds the 8l run. Re-run on AC.

## 2026-09-24 — Stage 8l: the ring and gable smashes launched as in the paper's video

Checked against frames of the project page's teaser video: in Fig. 1 the sphere rolls in from
*outside*, hits the stepped face, crosses the arena and breaks out through the far wall (the
near half collapses in a broad V), and it is ~0.8 of the wall's height across; ours started
inside, 0.4 of the height, and only holed the wall. In Fig. 3 the spheres roll on through the
whole field; ours (density 10) stalled in the rubble they pushed, lodged in walls by ~7 s.
Now `brickRing`'s sphere is `courses / 5` in radius (8 m at 110k), rolling in at 30 m/s from
2 m outside; `brickGables`' spheres have density 50 and a 12 m run-up at 30 m/s; both start
on the ground rolling (spin matched to speed). Viewer cameras moved to the paper's framings.

Re-measured on the M4 Max (whole suite, on AC; unchanged scenes within 5% of before):

| Scene | Before | Now | Paper, RTX 4090 |
|---|---|---|---|
| Brick ring 110k, 4 it | 8.67 ms | **9.27 ms** (0.95×) | 9.8 ms |
| Brick gables 506k, 3 it | 24.6 ms | **25.1 ms** (1.43×) | 17.6 ms |

The M1 Pro report predates this and needs a re-run.

### Tall brick walls creep and fall at low iteration counts (fixed in 8m)
Unhit, with the sphere parked away (headless, bricks moved > 0.5 m or turned > 0.15 rad):
- 110k ring (40 courses): stands 5 s at 4 iterations, most of the upper wall down by 15 s;
  6 iterations last ~10 s, 8 ~15 s; 10 still standing at 20 s.
- A 40-course ring at radius 40 fails like the 110k one; 20 courses at radius 80 stand 40 s
  at 6 iterations, so it is the wall's height, not f32 precision at 80 m from the origin.
- Contact reuse on or off makes no difference.
- 28k ring (20 courses): stands ~15 s at 4 iterations, 40 s+ at 6.
- The top course sits 0.2 m (20 courses) to 0.4 m (40 courses) below its start at every
  iteration count: about 1 cm of steady penetration per course.
The benchmark window ends ~3 s in, before any of this. Cause and fix: Stage 8m.

## 2026-09-24 — Stage 8k: carrying pairs of still bodies in the broadphase (tried, reverted)

The paper rebuilds its LBVH and runs the narrowphase on every pair every step; skipping the
search for still bodies would go beyond it, and collision is 38% of a step on the M1 Pro.
Built: updateRefs lists the bodies that left their reference pose this step (or whose joint
broke); only they walk the grid, emitting pairs with still bodies and, from the higher index,
with moving ones; pairs of two still bodies are copied from last step's list (pairs made
ping-pong); still small bodies test moving large ones in a separate pass. Every pair test is
padded by twice each body's reuse drift (2 mm + 2 mrad x radius) and the cells grow to match,
so still bodies cannot creep into contact unseen. Verified: the exact broadphase test with the
pads, and a test that the list stays complete and duplicate-free through a wall smash (it
failed when carrying was disabled on purpose). A first version of that test compared the list
with the poses after the step and flagged pairs the ball had only just reached; the list is
built from the poses the step starts from.

It did not pay:
- At the 2 mm tolerance 30-70% of bricks count as moving at any moment (stacks creep at 3-4
  iterations; the wall smash is 4% still while settling, 99% before impact, 36% during it).
- Skipping in place was slower: still bodies share thread groups with moving ones and wait for
  them, each moving body now searches its whole neighbourhood rather than half, and the pads
  add 3-14% pairs (ring 224k -> 256k).
- Compacting the movers first fixed the divergence but added dispatches and atomics. On AC,
  interleaved against the previous commit: box columns (99.7% still) -4.3%, ring 110k -1.7%,
  wall smash 0%, settled pile +1.9%, gables 506k +5.5%, jointed drop 34k +5.7%, gables 6.7k
  +9.1%, ring 9k +11.7%, chain mail +14.7% (the machine was still recovering its clocks:
  absolute times ran about twice the usual).
Kept as git stash "Attempt: carry pairs of still bodies...". The larger win for scenes at rest
would be sleeping (bodies at rest skip the solve too), with a looser tolerance than contact
reuse's.

## 2026-09-24 — Stage 8j: the 2D solver on an M1 Pro: GPU trig precision

First run on other hardware (MacBook Pro M1 Pro, 16-core GPU, same macOS build as the M4 Max):
3D all green; two 2D GPU/CPU checks failed, deterministically. A seeded single step of
Dynamic Friction missed by 1.15e-4 (M4 Max: 3.8e-6), and Spring Ratio drifted 0.090 m from
the CPU in 60 steps (M4 Max: 1.6e-4, steady, not growing; the two primal modes agree bit for
bit). Division emulated as a reciprocal shifted by up to 4 ulp changed nothing. The 2D
solver turns every angle into cos/sin with the WGSL built-ins, which the spec only bounds to
2^-11 absolute; rounding them to 2^-13 on the M4 reproduced it (Spring Ratio 0.23 m, Dynamic
Friction 3e-5; at 2^-11: 1.2 m and 4.9e-4). The 3D solver uses quaternions and no trig.

Fix: cosSin in the 2D prelude, Cody-Waite reduction by pi/2 and the Cephes single-precision
polynomials. Written as plain subtractions, fast math folded the three-part pi/2 back into
one rounded constant and the error grew with the angle (2.8e-6 at 100 rad); with fma it is
8.8e-8 over ±100 rad, better than the M4's built-ins (1.3e-7). A GPU test checks it against
Math.cos/sin. Box Rain's seeded step then gained a contact on one pair at frame 120: that
pair's own f64 count flips when a coordinate moves by 2e-6 m (one f32 ulp at x = -18), so
the built-in trig had only happened to land on the CPU's side. The seeded test now compares
contact counts per pair (stricter than the total) and exempts only pairs whose f64 count
flips under f32 round-off of their inputs, and their bodies' poses.

## 2026-09-24 — Stage 8i: the solve at 506k is near the M4 Max's bandwidth

In-step per-dispatch timestamps (5 untimed steps between timed ones keep the clocks up; the
sum matched the bench's solve phase): gables 506k, 3 iterations, 14.7 ms = dual 4.85 (33%),
the two biggest colours (173k, 164k bodies) 5.2 (35%), the rest of the colours 4.0, warm start
and velocities 0.6. Ring 110k: dual 28%, biggest two colours 39%.
The dual pass streams ~700 MB an iteration (pairs, both bodies, 4.45M 64-byte points read, the
changed fields written) in 1.6 ms: ~440 GB/s against the M4 Max's 546 GB/s. The RTX 4090 has
~1 TB/s; our solve is 1.43x the paper's at 506k (14.8 vs 10.3 ms) on about half the bandwidth.

Tried: running each pair's dual in primal, by the body that closes the pair (the later colour:
both poses are final then and nothing reads the pair again that iteration, so the maths is the
same; the seeded parity test passed). Interleaved against the previous commit: gables -1.9%,
ring 110k -2.9%, columns -4.5%, chain mail -8.4%, but jointed drop 34k +7.3%, settled pile
+3.5%. The points are not in cache any more by then, and the dual work lengthens each colour's
dependent-load chain. Reverted.

## 2026-09-24 — Stage 8h: collision — separated pairs, and a reuse idea that did not pay

### Where collision time goes (per-dispatch timestamps inside real steps)
The narrowphase and findPairs are nearly all of it (ring 110k: 2.4 and 1.4 of 4.0 ms; gables
506k: 5.3 and 2.2 of 8.4 ms, isolated passes at low clocks). Counting the narrowphase's paths:
| scene | reused | tested, touching | tested, apart |
|---|---|---|---|
| Brick ring 110k | 11% | 17% | 72% |
| Brick gables 506k | 43% | 55% | 3% |
| Jointed drop 34k | 0% | 44% | 56% |
| Settled pile 32k | 5% | 47% | 48% |
| Box columns 100k | 97% | 3% | 0% |
Rings of bricks overlap in world AABBs far more than they touch.

### Face axes in the broadphase (kept)
testPair now also rejects a pair when a face axis of either box separates them by more than
1 mm (the narrowphase would reject it on that axis anyway; spheres use their radius), and
findPairs loads the probing body's position, radius, axes and AABB once per thread instead of
per candidate. The GPU broadphase test's CPU oracle applies the same rule. Against the
previous commit (interleaved, AC): ring 110k -14.7%, ring 9k -9.7%, jointed drop 6k -5.1% /
34k -3.6%, box columns -3.2%, wall smash -2.6%, settled pile -2.0%, chain mail +0.9%, gables
506k -0.4%. The jointed drop and pile keep their apart pairs (separated along edge axes or
turned), and the gables have almost none.

### Reuse by the pair's relative offset (tried, reverted)
Reuse fails mostly because bodies creep: unhit walls at 3-4 iterations drift past the 2 mm /
2 mrad per-body tolerance (gables reuse 33% at step 30, 75% at 600). An upper bound (tolerance
effectively infinite) made the 506k gables 13.5% faster. Checking translation per pair
instead (the offset between the centres against its value at generation, 16 more bytes per
manifold; turning still per body, since the normal is stored in world space) raised reuse a
lot (gables 67% at step 30, 92% at 600; ring 78% at step 90), but steps got only 2% faster on
the gables and ±2% elsewhere, at 60 steps in and at 300: the reuse path (hash lookup, copying
every point) costs much of what the narrowphase did. Not worth the memory; reverted.

## 2026-09-24 — Stage 8g: primal lanes per colour; colour-cap overflow was hiding clashes

### Where the solve time went (110k brick ring, per-kernel timestamps)
The primal reached only ~70-130 GB/s, so it is latency-bound, not bandwidth-bound: each
contact is a chain of dependent loads (adjacency, pair, both bodies, point). Colours have a
long tail (40k, 39k, 21k, 8k, 1.4k, 554, 213, 76, 19, 1 bodies) and a colour's time is its
slowest body's chain: the tail colours took about a third of the primal. The colour cap also
sat at 26 for 11 colours used (started from the degree over all broadphase pairs, and the
bench lead-in is too short for three shrink votes).

### One primal kernel, 1/2/4/8 lanes per body chosen per colour on the GPU
`primal` (replacing `primal` and `primalWide`) splits each body's adjacency over
lanesFor(colour size) threads and sums the partial systems in workgroup memory; the args
kernel sizes each colour's dispatch the same way (a `colorThreads` hook in makeArgsWGSL).
Rule `primalLanes` = [never 1, 2 from 32k bodies, 4 from 4k, else 8]. Sweep (interleaved in
one process; the machine was loaded or on battery, so ratios only), against one lane:
wall smash -53%, chain mail -15%, jointed drop 34k -35%, settled pile 32k -19%, ring 110k
-14%, gables 506k -15%, box columns 100k +4% (4 contacts per box: one lane is enough there;
colour size cannot tell it from the ring). Against the previous commit (which already used
two lanes for small scenes), interleaved on battery: wall smash -28.5%, jointed drop 6k
-24.1%, ring 9k -27.9%, settled pile 32k -3.5%. On AC, machine quiet, interleaved against the
previous commit: ring 110k 11.83 -> 10.33 ms (-12.7%), jointed drop 34k 7.82 -> 6.53 ms
(-16.5%), gables 506k 27.29 -> 25.88 ms (-5.2%), box columns 100k 2.88 -> 3.12 ms (+8.2%: two
lanes on 4-contact boxes cost ~3% against one, and three spare colours add 8 empty dispatches
to a 3 ms step; letting colours above 8-24k bodies take one lane won 0-3% on the columns but
lost 2-6% on the ring and gables, so the rule stays).

| scene (bench3d, AC) | ours now | paper, RTX 4090 |
|---|---|---|
| Brick ring 110k, 4 it | **10.4 ms** (solve 5.6, collision 4.3) | 9.8 ms (3.5, 6.3) |
| Jointed drop 34k + 71k joints, 10 it | **6.4 ms** | 16 ms incl. cloth |
| Brick gables 506k, 3 it | **25.5 ms** (solve 14.2, collision 8.5) | 17.6 ms (10.3, 7.2) |

### Colour-cap overflow: a pre-existing bug found while testing this
The GPU "stack and pyramid" test sat on its limit (top brick 7.55-7.57 vs >= 7.55) and one
change or another tipped it. Tracing found the demo pyramid (bricks start apart and land)
collapsing in 13 of 40 runs on the previous commit: the colour cap started at 2, landing
needed 5, and a body with no colour left below the cap was committed to the last colour
alongside a neighbour, uncounted (clashes 0), so those bricks ran Jacobi-style until a
readback grew the cap and pushed into each other for good (top at 7.16, then collapse).
Fixes: the shared colouring keeps such a body pending in the last colour, so it is counted
as a clash and the host grows the cap at the next readback; the 3D cap keeps 3 spare colours
(grows when fewer than 2 remain, shrinks to used + 3), starts at >= 8, and starts from the
degree over touching pairs (the colouring's graph) rather than all broadphase pairs. With a
start cap of 12 the old code collapsed 0 of 40 times; the new code 0 of 40.
Tests: the pyramid height is now checked against the CPU reference's settled height (7.523,
bit-identical to upstream: the reference itself ends 0.23 m below resting exactly, outside
the old absolute 0.2 m bound), and a new check forces a cap of 2 and expects clashes to be
reported (the previous commit reported 0).

## 2026-09-24 — Stage 8f: GPU memory, sized from touching pairs

Manifold storage used to share the broadphase pair capacity (2x the estimated pairs, most of
which never touch) and contact storage was 4x the pairs; both are double-buffered, and growth
doubled capacity at 60% full. Now (`solver.ts`, `estimatePairs`):
- The CPU estimate also runs the narrowphase's separating-axis test (15 axes, 1 mm tolerance;
  sphere tests for spheres) on each candidate pair, counting the pairs that touch.
- Manifolds get 1.6x the touching pairs (floor: one per body), with the hash table and the
  adjacency sized from them rather than from the pairs; contacts get 8 per touching pair (the
  clipper's maximum; floor four per body). The 8-byte pair list stays at 2x pairs.
- Growth at 80% full, to twice the demand (the counters include what did not fit).

Peak GPU buffer bytes (M4 Max via Dawn, bench lead-in plus 180 steps):

| scene | before | after |
|---|---|---|
| Brick ring 110k | 608 MB | 278 MB |
| Brick gables 506k | 1,847 MB | 1,214 MB |
| Box columns 100k | 229 MB | 138 MB |
| Falling pile 32k | 139 MB (adapt every 10) | 79 MB |
| Jointed drop 34k | 102 MB | 96 MB |

Overflow (counters read and `adapt` called every 10 steps as the viewer does, or every 30 as
the benchmark does, 240 steps): none in any bench scene either way, except the falling 32k pile
at every 30, which overflowed once at step 120 as before (contacts before, manifolds now);
growing to 1.6x demand instead of 2x overflowed there a second time, so growth doubles.
Speed unchanged (interleaved A/B: ring 110k -2.7%, falling pile -1.6%, wall smash +2.2%).
What is left is mostly contact storage (64-byte records, double-buffered: 220 MB of the ring's
278 MB). Brick-on-brick pairs average 4.4-5.6 points against the 8 reserved.

## 2026-09-24 — Stage 8e: benchmark scenes after the paper's, and bench3d.html

### What the paper's large scenes are
Rendered from the paper's figures: Fig. 1 (110,000 blocks, 4 iterations) is a ring wall of bricks
in running bond, stepped outside and sheer inside, smashed from inside by one sphere. Fig. 3
(510,000 blocks; Table 1 says 3 iterations, the caption 4) is a field of triangular brick walls
one brick thick, ploughed by two spheres. Fig. 14 is 35,000 rigid bodies with 72,000 joints
falling onto a 10k-vertex cloth. The earlier comparison (Stage 8d) used settled random piles,
which have fewer contacts and no motion.

New scenes (`bench-scenes.ts`), all standing exactly from frame 0 so no settling is needed:
- `brickRing`: 110,332 bricks [1, 0.5, 0.5], 40 courses, rows 10 deep at the base stepping in
  every 4 courses, 160 m across; a 4 m sphere at 25 m/s from inside. Rings are 2 cm apart:
  straight bricks' corners reach past the ring radius, and touching rings pushed each other
  apart (a 9k ring slumped 0.46 m unhit; gapped, every brick stays within 2 cm).
- `brickGables`: 16 × 68 triangular walls of 465 bricks (505,920), two 4.3 m spheres.
- `jointedDrop` (stand-in for Fig. 14, no cloth): 600 plates of 5 × 5 × 2 ball-jointed cubes
  falling in layers onto a border-pinned chain-mail net; 34,097 bodies, 71,064 joints.

A first attempt, stepped pyramids of unit cubes, was wrong twice over: 69 courses slump at 4
iterations (0.7 m spread in 1.5 s unhit), and face-to-face cubes make ~23 contacts per body,
twice the bricks' ~11, so the 110k mound took 32 ms a step.

### Against the paper, on its own scene shapes (M4 Max via Dawn, on AC, machine otherwise quiet)
Timed over ~110 steps right after a 60-step lead-in, while the spheres are still breaking walls.

| scene | ours: wall per step (GPU solve, collision) | paper, RTX 4090 | GPU buffers |
|---|---|---|---|
| Brick ring 110k, 4 it (Fig. 1) | **11.8 ms** (7.1, 4.3) | 9.8 ms (3.5, 6.3) | 608 MB |
| Brick gables 506k, 3 it (Fig. 3) | **27.6 ms** (16.1, 9.0) | 17.6 ms (10.3, 7.2) | 1.85 GB |
| Jointed drop 34k + 71k joints, 10 it (Fig. 14 stand-in) | **8.0 ms** (6.1, 1.0) | 16 ms incl. a 10k-vertex cloth | 102 MB |

So on its own scenes we are 1.2x (110k) and 1.6x (510k) behind a GPU with ~2x the memory
bandwidth; the gap is in the solve, while our collision is faster at 110k and 25% slower at
510k. Our contact reuse helps here as it would not for the paper (most walls are untouched).
Timing noise: another process's test run on the same machine made the same suite read 18.8 /
17.5 / 29.9 ms; the numbers above are from a quiet rerun that matched an earlier quiet run.

### GPU memory is the next constraint for 8 GB machines
Peak buffer bytes per body: ~5.5 KB for brick scenes. Contact and manifold storage are sized
from the CPU pair estimate (contacts 4x pairs, manifolds 2x pairs) and double-buffered: the 9k
ring holds 282k contact slots for 95k contacts and 141k manifold slots for 18k manifolds. The
510k field needs 1.85 GB, which should fit an 8 GB M1 or GTX 1080 but leaves little room
(1.21 GB after Stage 8f).

### bench3d.html
Runs the suite (`src/avbd3d/bench-cases.ts`, shared with `pnpm bench3d:gpu`) in the browser:
tiers small (≤ 9k bodies), paper scale (110k ring, 34k jointed), 510k, settled. It reports wall
and per-phase GPU times, GPU buffer MB and the paper's times, uses a fresh device per case
(an out-of-memory case cannot take the rest down), and copies JSON with the adapter, limits
and user agent. In a hidden browser tab timings are unusable (the 34k jointed drop read 13-75 ms
across runs in a hidden pane, 8 ms headless, ~7 ms in the visible viewer); the page says so.

## 2026-09-24 — Stage 8d: small scenes, rendering, and what was not worth it

### Small scenes are latency-bound, not dispatch-bound
- Tried first: all iterations in a single 256-thread workgroup (storage barriers instead of
  dispatch boundaries). 2.5-3x *slower* (wall smash 6.4 → 16.9 ms at 10 it): one GPU core
  cannot hide the latency, and each colour step waits for its slowest body. Not kept.
- What bounds a small colour is each body's serial chain of dependent loads (a wall brick
  has ~24 contact points). `primalWide` splits a body's joints and pairs across two threads
  and sums the partial 6x6 systems through workgroup memory (two threads is what fits: 64
  bodies × 176 B partials in the 16 KB guaranteed; more lanes would need a second dispatch
  dimension). Interleaved A/B, 4 / 10 iterations:

| scene | 1 thread per body | 2 threads | |
|---|---|---|---|
| wall smash 2k | 4.64 / 7.35 ms | 1.81 / 4.71 ms | 61% / 36% faster |
| breakable wall | 1.35 / 2.56 ms | 0.97 / 1.76 ms | 28% / 31% |
| chain mail | 1.14 / 1.31 ms | 0.89 / 1.04 ms | 22% / 21% |
| 32k pile | 3.16 / 5.42 ms | 2.70 / 4.39 ms | 14% / 19% |
| 110k pile | 8.50 / 12.99 ms | 8.12 / 13.47 ms | ±4% |
| 100k columns | 3.35 / 5.06 ms | 3.48 / 5.35 ms | 4-6% slower |

  Chosen automatically below 8192 bodies per colour.

### Rendering
With the GPU unthrottled the viewer holds 120 fps with shadows on the 32k pile and on 100k
box columns (physics at 60 Hz, 5.4 ms per step at 10 iterations); the 37 fps seen earlier was
the throttled state. Added a View → Shadows toggle (`?shadows=0`) for older GPUs and cut the
sphere mesh from 1,280 to 320 triangles.

### Host-side costs that bit
- The CPU pair estimator (buffer sizing) sized its grid from the 99th-percentile radius, so a
  random pile's largest 1% were tested against every body, with an array lookup inside: scene
  construction was quadratic (32k bodies 3.6 s, 110k 65 s, 512k never finished). It now uses
  the GPU's large-body rule (2x median, at most 64) and a set: 110k loads in ~1 s.
- The colour cap started at 12 and only shrinks after readbacks, so a 3-colour stack paid 12
  colour dispatches per iteration until then (and the tests, which step in tight loops, paid
  it throughout). It now starts at the estimated max contact/joint degree + 2.
- Through Node's Dawn binding each WebGPU call costs ~15-20 µs, so tiny scenes cost ~1.5 ms of
  host time per step in the tests (0.07 ms in the browser). Test cost scales with steps, not
  bodies; the suites were trimmed accordingly (below).

### Test suite cost (`pnpm check`)
Trimmed from ~70 s to ~28 s of test time (CPU 31 → 8 s, GPU 39 → 20 s) without dropping a
check: golden trajectories now sampled to frame 180 (bit-exact divergence shows within a few
dozen frames of contact; every scene is in contact by 120), "stays finite" sweeps run 40
frames, the 2D seeded GPU test seeds at 60 and 120 (not 300), GPU stand checks run 300 frames
with a collapse-sized speed bound (the exact rest state is checked on the CPU reference), the
spring mean is taken over six whole periods from the start. The CPU pyramid test was dropped:
the reference is bit-exact with upstream, and the GPU suite checks the pyramid stands.

### Against the paper (Table 1, Figs 1 and 3; RTX 4090) — superseded by Stage 8e
| scene | paper (RTX 4090) | ours (M4 Max, WebGPU) |
|---|---|---|
| 110k-block pile, 4 it | 9.8 ms (3.5 solve + 6.3 collision) | **8.2 ms** (~4.4 solve, ~3.3 collision, ~0.5 colouring/adjacency) |
| 510k-block pile, 3-4 it | 17.6 ms (10.3 solve + 7.2 collision) | **51 ms** at 512k (~26 solve, ~21 collision, ~4 colouring/adjacency) |
| 35k bodies + 72k joints, 10 it | 16 ms incl. collision | not built (chain mail: 1.6k links + 3.1k joints, 1.0 ms at 10 it) |

Ours: settled random piles of randomly sized and turned boxes (`paper.ts`-style: boxPile, 600
settling steps, robust wall time); phase split from isolated timestamped steps. Theirs: piles
being smashed by spheres (contacts churn, so our contact reuse would help less). The RTX 4090
has ~2x the M4 Max's memory bandwidth (1 TB/s vs 546 GB/s), a 72 MB L2 and several times the
FP32 throughput. At 110k our working set (~55 MB of bodies and contacts) largely fits the M4
Max's caches and the whole step beats the paper's; at 512k (~250 MB) it does not, and 4.6x the
bodies costs 6.2x the time. Collision at that scale (21 ms vs 7.2) is the clearest gap.

### Half-precision contact anchors: not done
Probe: padding the 64-byte contact record by 16 bytes cost 4.8% (4 it) and 8.2% (10 it) on the
110k pile, so shaving 12 bytes with f16 anchors would save at most ~4-6%. For that it would
round anchors to ~0.5 mm (inside stacks), and the parity tests would have to loosen their
anchor tolerance. Not worth it.

## 2026-09-24 — Stage 8c: contact reuse and spatial order

Measured with interleaved A/B runs in one process (see Stage 8b).

### Reusing contact points of still pairs (`reuseContacts`, on by default)
A small kernel keeps a reference pose per body; a body that moves more than 2 mm or turns
more than 2 mrad from it takes a new reference and records the step. A pair whose points were
computed no earlier than both bodies' last move keeps them (anchors, warm-start data) and
skips SAT and clipping; C0 is still recomputed from the current poses, so the constraint
error stays exact and only the anchor locations can be up to the tolerance stale. Parity
tests turn it off.
- Reuse rate: box columns 96% of pairs by step 120, 100% after; a 32k random pile 22% at step
  240, 76% at 360, 94% at 600.
- Gain: 6-12% at 4 iterations, 3-6% at 10 (A/B of two solvers on the same scene). Smaller than
  the narrowphase's share suggested: SAT was cheaper than the broadphase grid, the pair hash
  and copying the records, which reuse still does.

### Spatial (Morton) body order (`spatialSort`, on by default)
Bodies are stored in Z-curve order of their starting positions, so the bodies a contact
touches sit near each other in memory. Measured on a settled pile rebuilt three ways:
scrambled 2.94 ms, builder order 2.83 ms, Morton 2.52 ms (4 it, 32k); 7.84 / 7.75 / 6.79 ms
at 108k. Scrambling costs little because builder order is already poor; sorting is what
pays, so a one-off sort at construction captures it and a runtime re-sort (remapping every
index while running) was not worth building. `GpuSolver3D.gpuIndex(i)` maps reference
indices; the app only ever uses GPU indices.

### Combined, against the previous commit (interleaved, after 600 settling steps)
| scene | 4 it | 10 it |
|---|---|---|
| 32k random pile | 3.31 → 2.89 ms (13%) | 5.30 → 4.92 ms (7%) |
| 100k box columns | 2.89 → 2.84 ms (2%) | 4.73 → 4.64 ms (2%) |
| 250k box columns | 10.65 → 10.38 ms (2%) | 14.66 → 14.84 ms (-1%, noise) |
| wall smash 2k | 3.07 → 2.28 ms (26%) | 8.15 → 6.98 ms (14%) |
The random pile is now ahead of the version before contact pairs too (3.15 → 2.89 ms at 4 it).

## 2026-09-24 — Stage 8b: 3D GPU memory layout (contact pairs)

Decisions below come from interleaved A/B runs of the committed solver against the working
tree in one process (same device, same clock state), since isolated runs on this machine
swing by 2-5x with power and heat.

### Contact pairs (manifolds) instead of independent contact points
A pair record (32 B: bodies, first point, point count, normal, friction) plus 64-byte points
(was 96 B each: bodies and normal moved to the pair, the stick flag into bit 31 of the
feature key). The adjacency, colouring, hash table and dual iterate pairs; the primal loads
the partner body and basis once per pair. Warm starts find last step's pair with one hash
lookup and match features among its ≤ 8 points (nearest-anchor fallback in the same scan).
Body records were reordered so everything a contact reads (pose, rotation, step-start pose
and rotation) is the first 64 bytes.

| scene (interleaved A/B) | committed | pairs | |
|---|---|---|---|
| 100k box columns, 4 it | 4.20 ms | 2.88 ms | 31% faster |
| 100k box columns, 10 it | 7.34 ms | 4.93 ms | 33% faster |
| 32k random pile, 4 it | 3.15 ms | 3.23 ms | 3% slower |
| 32k random pile, 10 it | 4.95 ms | 5.42 ms | 10% slower |

The split follows points per pair: columns have 4, the random pile 1.9 (53% of its pairs
have a single point), so grouping saves little there and the extra indirection costs a
little. Stacks, walls and towers look like the columns.

What mattered on the way:
- **Capacity.** The first version shrank the initial pair buffers (8 → 2 per body). A fresh
  brick wall has ~12.5k pairs on frame 1; pairs overflowed and were dropped for two steps,
  the bricks sank into each other, and the wall stayed in a contact-heavy state (28k instead
  of 11k contacts, slower thereafter). Now the host counts the scene's starting pairs on a
  CPU grid (the GPU's sphere + AABB rules), allocates from that with floors of 4 pairs and
  4 points per body, and grows at 60% full (was 80%): a falling pile doubles its pair count
  between readbacks.
- **Registers, not bytes, in the pile's primal.** Keeping both bodies' full state, the basis
  and six stored Jacobian rows live across the pair loop made the pile's primal 60% slower
  (0.27 → 0.43 ms per iteration). Carrying only rotation and displacements per body (0.34)
  and returning lever arms instead of Jacobian matrices (0.32; each body rebuilds its three
  rows with the same operations, so rounding is unchanged) recovered most of it. Flattening
  the pair/point loops (against SIMD divergence) changed nothing measurable; kept for the
  simpler control flow.
- Body warm start and velocity update now load and store fields instead of whole 160-byte
  records; the colour cap keeps one spare colour (was two) after quiet readbacks, and
  Jones-Plassmann rounds adapt (4, doubled on any clash). Rounds turned out cheap: 16 → 2
  saved only ~3% because the colouring carries over between steps; the ~1 ms colouring in
  isolated-pass profiles was a clock artefact.

### Benchmark (M4 Max via Dawn, charging, nothing else on the GPU, `pnpm bench3d:gpu`)
| scene | bodies | contacts | 4 it ms/step | 10 it ms/step |
|---|---|---|---|---|
| columns 32x32x10 | 10k | 41k | 0.59 | 0.94 |
| columns 50x50x20 | 50k | 200k | 1.45 | 2.30 |
| columns 100x100x10 | 100k | 400k | **2.94** | 4.97 |
| columns 100x100x25 | 250k | 1.0M | 8.66 | 15.5 |
| random pile 40x40x20 | 32k | 150k | 3.27 | 5.29 |
| chain mail | 1.6k | — | 0.74 | 1.19 |
| wall smash (after impact) | 2k | 11-22k | 2.67 | 7.11 |

Whole steps (collision, colouring, solve). The paper reports 3.5 ms of solve for 110k boxes at
4 iterations on an RTX 4090. Small scenes are dispatch-bound: the wall smash's 12 colours ×
iterations dominate its time.

## 2026-09-24 — Stage 8: 3D scale and showcase (first pass)

### Measurement caveat
Absolute timings from late in this session are not trustworthy: the laptop ran its battery
down to 11% under sustained GPU load (drawing from battery while on AC), and an unchanged
kernel (warmStartBodies) then ran 5x slower than in the morning. Numbers below marked *full
power* come from earlier runs; the final `pnpm bench3d:gpu` table must be rerun on a charged
machine with no other GPU work (an open viewer tab alone added 30-100%). Also: my first
reading of "multi-second shader compiles" was the same contention; measured alone, the
largest pipeline (narrowphase) compiles in ~0.5 s cold and a 32k scene loads in ~0.3 s.

### Where the time went, and what helped (100k box columns, 400k contacts, full power)
Per-kernel timestamps on a settled scene (isolated kernels read high, ratios are what count):
narrowphase 1.9 ms, primal 0.59 (all colours), dual 0.26, findPairs 0.52 per step/iteration.
- **AABB pair filter.** Bounding spheres of neighbouring boxes overlap far more often than
  the boxes: 388k pairs for 100k touching pairs. A conservative world-AABB test after the
  sphere test cut that to 100k; step 11.4 → 9.8 ms (10 it), 50k boxes 5.2 → 3.4 ms.
- **Dual writes back only lambda, penalty and stick** (not the 96-byte record): solve
  5.96 → 5.64 ms.
- **8-vertex ping-pong clipping** instead of copying a 16-vertex array per clip plane (a
  quad clipped by four planes has at most 8 vertices; order and so feature keys unchanged):
  narrowphase 1.18 → 0.79 ms.
- Not kept: rewriting the contact rows through the relative contact displacement (fewer
  cross products) did not change the solve time (bandwidth-bound) and moved f32 rounding
  enough to push one lambda just past the parity test's bound, so it was reverted rather than
  loosening the test. Unrolling the contact-row loops: identical time in an interleaved A/B
  (11.19 vs 11.20 ms); kept for readability.
- Large-body classification: a showcase ball (3x the median brick radius) stayed "small" at
  the 2D factor of 4 and set 4 m grid cells; factor 2, capped at the 64 largest bodies, took
  the 2k-body wall smash from ~8 to ~4-6 ms.
- Best full-power figures, 100k boxes: **~6 ms at 4 iterations, 8.4-11 ms at 10** (robust
  interleaved timing gave 11.2 ms at 10). The solve is bandwidth-bound (~250 GB/s moved per
  the byte count); the next real gain needs smaller records (per-manifold normal/basis,
  f16 anchors) rather than arithmetic.

### Iterations (GPU, 600 frames)
| iterations | Stack (10) | Pyramid (16 rows) | 20-high columns | Soft Body |
|---|---|---|---|---|
| 2 | collapsed (top 8.9) | sagging, KE 0.1 | stands, KE 20 | collapsed |
| 4 | stands, KE 4e-7 | stands, KE 1e-2 | stands, KE 3e-4 | stands |
| 10 | stands, KE 9e-7 | stands, KE 7e-6 | stands, KE 5e-5 | stands |
4 iterations (the paper's benchmark setting) holds stacks and piles; 10 settles fully.

### Narrowphase: Box2D-style face bias (GPU option, on by default)
The demo picks an edge axis when `0.95·edgeSep > faceSep + 0.01`. With penetration the
separations are negative, so scaling the *edge* value favours the edge: equal separations at
-0.7 choose it, leaving a single contact and a box stuck 0.7 deep (the Stage 7 Breakable
state). `faceBias` scales the face value instead (`edgeSep > 0.95·faceSep + 0.01`), as Box2D
does. With it, GPU Breakable settles (KE 1e-7, like the CPU run); without, KE stays ~5e-2.
The parity tests turn it off to compare against the faithful reference.

### Spheres (GPU-only extension)
A sphere is a reference `Rigid` (cubic bounds, solid-sphere mass and inertia) marked in
`shapes.ts`; the shape code rides in `angVel.w`. Sphere-sphere and sphere-box give one
contact. Two failures found and fixed on the way:
- Static friction keeps a contact's old body-local anchors. For a rolling sphere the contact
  point moves over both surfaces, so pinned anchors rotated away: it sank through the ground.
  Sphere contacts always take fresh points (still warm-starting force and penalty).
- The reference builds contact Jacobians at the *current* rotation while expanding C about
  the step start. A sphere rolling 0.1 rad per step then sees a false separation in its
  normal row every step; it sank and gained energy. Sphere contacts use the step-start
  rotation (the Taylor point). Box contacts keep the reference's form.
Result: a sphere launched sliding at 3 m/s rolls at 2.14 m/s (theory 5/7·v = 2.143) within
0.2 s with no slip, then loses ~1% of its speed per second to numerical rolling resistance.

### Showcase scenes (GPU-only, `bench-scenes.ts`)
- Wall Smash (paper Fig. 1/3): 2,000 bricks in running bond, a 2 m ball at 30 m/s punches
  through (10-12 colours).
- Breakable Wall (Fig. 13): bricks welded by hard joints that fracture above 50 (holds under
  its own weight at every strength tried, 50-400); the ball breaks dozens of joints (75 of
  1,150 at strength 100).
- Chain Mail (Fig. 12): 40x40 plate links on ball joints, hung by the corners, catches a ball
  ~16,000x a link's mass; joint stretch ≤ 0.1 at 10 iterations (0.2 at 10 it with a
  5x heavier ball, 0.11 at 20 it).
- Heavy Pendulum (Fig. 7): 50 links and a 50,000:1 end mass swing coherently, joint error
  ≤ 0.1.
- Box piles to 250k and a 32k random pile (settles, 8-9 colours, no clashes).

## 2026-09-24 — Stage 7: 3D WebGPU solver (src/avbd3d/gpu)

The whole 3D step runs on the GPU with the 2D pipeline's structure. Adjacency, Jones-Plassmann
colouring, indirect arguments and the prefix scan are shared (the topology and args WGSL are
now generated from either dimension's prelude); broadphase (3D hashed grid, 27 cells),
narrowphase (OBB SAT + clipping, up to 8 contacts per pair) and the solve (6x6 LDLᵀ per body,
rows folded in as outer products) are new. Records: body 160 B, joint 128 B, contact 96 B.

### Verification: seeded single step against the f64 reference
There is no 3D SoA CPU solver. Instead `GpuSolver3D.fixedColors` can give every dynamic body
its own colour in the reference's newest-first order, which makes the colour sweep the
reference's Gauss-Seidel sweep. `seedFrom(ref)` copies the reference state mid-run (bodies,
joints with penalties and lambdas, contacts as warm-start source), both take one step:
- 10 scenes (≤ 64 dynamic bodies) at frames 60, 120, 300: every reference contact between
  movable bodies is found at the same body-local points (1e-4), lambdas agree to 1e-3
  relative, and poses agree to **≤ 2.7e-6** (f32 against f64), first try.
- Exception, understood: a box lying flat on another has two SAT face axes with *equal*
  separation. f64 and f32 break that tie differently, so the same contact points get other
  feature keys, strict key matching loses the warm start, and that step differs (4.4e-4,
  Dynamic Friction frames 60/120). The GPU runs with `matchNearest` (as in 2D), which recovers
  those warm starts; it is off in the parity test because nearest matching also warm-starts
  contacts the reference legitimately starts fresh (seen: 8.4e-4 at Dynamic Friction frame 1).
- Narrowphase alone: 300 randomly posed overlapping box pairs (219 edge, 80 face manifolds,
  530 contacts): same count, points (1e-3) and feature keys as `ref/collide.ts`.
- Broadphase: 3000 random boxes incl. oversized ones and an IgnoreCollision pair: exactly the
  brute-force bounding-sphere pairs.

### Behaviour on the GPU's own colouring (tests-gpu/avbd3d-gpu.gpu.test.ts)
The reference's calibrations hold: the stack rests at the same heights, the pyramid stands
(3-7 colours, no clashes), Coulomb stopping distances within 15%, ramp boxes hold or slide on
the same side of tan 30°, spring mean 9.2, rope/bridge joint error < 0.02-0.03, Breakable
fractures, drag and shot boxes work. Over 600 frames the stable scenes agree with the CPU run
(Stack to 1 mm); chaotic ones (rope swing, soft-body tumble, bridge) diverge as expected.

### Two things that looked like GPU bugs and were not
- Breakable on the GPU ended with the top box 0.7 inside the one below, jittering
  (KE ~5e-2 for good). Handing the GPU's state to the CPU reference reproduces it exactly.
  Cause, in the upstream narrowphase: an edge axis wins when `0.95·edgeSep > faceSep + 0.01`,
  which for deep penetration (-0.7) favours an edge over an equally good face axis, leaving a
  single contact point; with α = 0.99 only 1% of the penetration is removed per step. The
  GPU run just took a different (chaotic) path into that state. A candidate fix for Stage 8,
  GPU side only (the reference stays faithful).
- Dragging a mid-stack box with an instant 9 m pointer jump launches the boxes above it
  (KE ~3000). The CPU reference does the same: it is the demo's 5000 N/m drag spring.
- Also: a 40-row brick pyramid (820 bricks) collapses on both CPU and GPU at 10 iterations
  (rows start 0.35 apart and drop); the 16-row demo pyramid stands on both.

### First scaling numbers (settled box columns, 10 iterations, M4 Max via Dawn)
| boxes | contacts | ms / step |
|---|---|---|
| 1k | 4k | 2.5 |
| 10k | 41k | 3.8 |
| 50k | 200k | 10.1 |
| 100k | 400k | 22.3 |
| 250k | 1.0M | 51.7 |

About 1.5x the 2D cost per contact at equal iterations. Nothing is tuned yet (Stage 8): the
contact kernel recomputes the basis and reloads both bodies per row, records are wide, and
the colour cap/iteration trade-offs from 2D have not been re-measured in 3D.

## 2026-09-24 — Stage 6: 3D CPU reference (src/avbd3d/ref)

### The TS port reproduces the upstream C++ bit for bit
`tools/cpp-oracle/oracle3d.cpp` runs the unmodified avbd-demo3d solver headless; `build.sh`
also compiles it with `float` rewritten to `double` and `-ffp-contract=off` (clang fuses
`a*b + c` into FMAs by default, which JavaScript cannot do). Against that build the port is
**exactly equal** (max pose difference 0, force counts equal) on all 14 scenes at frames 1,
10, 60, 300 and 600 (`tests/fixtures/oracle3d`, `gen3d.sh`). This needed every expression
kept in the C++ evaluation order, including full 3x3 products with their structural zeros.
The test allows 1e-9 only as headroom for a libm difference in Static Friction's `sin`/`cos`.

### Calibrated behaviour of the reference (tests/avbd3d-ref.test.ts)
- Resting contacts sink one collision margin (0.01) each: a 10-box stack's top rests at 9.894.
  The stack bounces on landing and is quasi-static (speed ~2e-4) only after ~800 frames.
- Dynamic friction: stopping distances within 10% of Coulomb v²/(2μg), μ = √(μa μb).
- Static friction on the 30° ramp: boxes with μ > tan 30° stop (the μ = 0.59 box slides
  ~3 m down the ramp first, then holds; creep < 0.005 over 2 s); μ < tan 30° slide to the ground.
- Spring (k 100, mass 8) oscillates undamped about 9.19 (static equilibrium 9.2).
- Hard joint error after 10 s: rope 0.009, heavy rope (5 m end box) 0.016, bridge 0.014.
- Breakable: 2 of 10 joints fracture within the first second, then the rest hold.

### CPU cost
Pyramid (137 boxes, ~1.1k contacts, 10 iterations): 13 ms per step as first written, 10 ms
after unrolling the 3x3 products and removing per-contact allocations (Node, M4 Max). Enough
for the 14 demo scenes in real time; scale is the GPU's job (Stage 7).

## 2026-09-24 — Stage 5: 2D scaling study

All numbers from the M4 Max (40-core GPU) through headless Dawn, unless noted. Short GPU
timings on this machine swing ±20–50% with clock changes, so comparisons use
`src/avbd2d/gpu/timing.ts`: warm-up, many drained batches, variants interleaved over rounds,
best median per variant. Per-phase GPU timestamps of isolated steps are noisier than wall
time (the GPU drops its clocks between them), so wall time is the primary metric.

### Where the time goes
Per-phase timestamps (collision, adjacency, colouring, solve). At 10 iterations the solve is
55–85% of the step. At 4 iterations, collision (0.4–2 ms) and colouring (0.5–2 ms) become a
third to a half. Adjacency is always ≤ 0.4 ms.

### Dispatch count is the first-order cost below ~100k bodies
Every primal pass up to the colour cap is encoded (the count lives on the GPU). An empty one
costs ~12 µs here: the 16k lattice at cap 32 vs 6 was 6.7 vs 3.5 ms. Changes:
- colour cap = colours in use + 2, grown at once on clashes, shrunk after 3 quiet readbacks
  (lattice −21%, piles −3…−16%);
- one dual pass over joints and contacts per iteration instead of two.

### Memory order inside a colour matters
Bodies bucketed by atomic scatter (random order) against one thread per body in index order
(skipping other colours): index order was 4–21% faster despite launching every body for
every colour. Buckets now come from a stable counting sort: a per-workgroup colour histogram,
a prefix scan over (colour, workgroup), in-chunk ranks from shared memory. That closed most
of the gap. The index-scan variant is sometimes still faster on this 40-core GPU, where idle
threads are nearly free; `primalMode` switches between them, and the browser benchmark runs
both so the target hardware can decide.

### Register-resident rows
Constraint rows used to come back as a struct of `array<vec3f, 3>` indexed dynamically,
which is spilled on Metal. Unrolled `addRow` calls into a register accumulator: 20k pyramid
6.3 → 5.8 ms (10 it), 3.1 → 2.7 ms (4 it). Seeded parity with the CPU unchanged.

### Not worth it (measured)
- Splitting the step into one pass per phase: no measurable cost, so profiling does it.
- Fewer Jones-Plassmann rounds: 16 → 4 saves only 0.2–0.4 ms, and 4 rounds let 3 clashes
  through in box rain. Kept at 16.

### Robustness fixes
- Growing contact storage now copies both contact buffers and keeps the counters, so warm
  starts survive. Before, a growth reset the counters, and one readback saw "0 colours".
- Capacities are clamped to `maxStorageBufferBindingSize`. Past the 128 MB default, a
  250k-body pile's contact storage made the bind groups invalid, and the step silently did
  nothing. Devices now request the adapter's larger limits (app, benchmark, tests).

### Iterations: cost and quality (GPU, `pnpm sweep2d`)
Cost is ~3 ms of fixed per-step work plus ~0.3–0.4 ms per iteration at 20–90k bodies.

| iterations | pyramid 20 | stack 20 | slope creep 20 s | rope joint err | pyramid 100 (drop) |
|---|---|---|---|---|---|
| 1 | collapses | falls | slides off | 0.29 | — |
| 2 | 5.9 / 8.0 | drifts 0.5 | 7 mm | 0.087 | collapses |
| 3 | 7.2 | stands | 2.7 mm | 0.037 | collapses |
| 4 | 7.7 | stands | 4.0 mm | 0.023 | collapses |
| 10 | 7.98 | stands | 1.9 mm | 0.011 | 148 of 5050 boxes off their row |

A 100-row brick pyramid is the hard case, and it's the method, not the GPU. The demo's
sequential reference loses 2756 boxes at 10 iterations. In coloured order, a pyramid spawned
resting holds at 4 iterations (36 displaced), 3 partly collapses, and surviving the drop
needs ~10. Sequential top-down order holds the drop at 4 (19 displaced): colours move load
down about one row per colour pass. Alternating colour order each iteration was worse
(explosive at 10). Heaps and rain piles (the paper's regime) are fine at 3–4 iterations.
Iterations stay a per-scene choice; defaults remain 10.

### Scaling (box rain, 100 rows, width varied; settled piles; `pnpm scaling2d`)

| bodies | contacts | 4 it wall ms | 10 it wall ms |
|---|---|---|---|
| 10k | ~23k | 2.2 | 2.4 |
| 25k | ~60k | 2.8 | 4.6 |
| 50k | ~115k | 4.4 | 6.7 |
| 90k | ~205k | 5.0 | 10.1 |
| 160k | ~370k | 6.9 | 10.0 |
| 250k | ~580k | ~6.5–8 | 15.1 |

Raw data: `docs/data/scaling2d-apple-metal-3.json`. On this machine, 250k boxes with ~600k
contacts fit 60 fps at 4 iterations. For the target hardware, `bench.html` runs the suite
in a browser and copies the results out; no M1 or GTX 1080 measurement has been made yet.

## 2026-09-23 — Stage 4: the whole 2D step on the GPU

Broadphase, narrowphase, contact persistence, adjacency, colouring and solve all run on the
GPU. Indirect dispatch sizes each kernel from counts the GPU produced, and nothing is read
back while stepping. Measured on the M4 Max (see the Stage 3 caveat about target hardware).

### Verification: seeded single-step parity
Diffing long GPU and CPU runs can't separate bugs from f32 chaos, so the GPU is seeded with
the CPU solver's full state mid-simulation (bodies, joints, contacts with their warm-start
data, colouring). Then both step once. Across 10 scenes × frames 60/120/300 × demo and
parallel parameters:
- the pair set is identical (exact string-set equality);
- colours are identical body for body; clashes 0, overflow 0;
- contact counts are identical, and poses agree to ≤ 1e-4 (Cards ≤ 1e-3: 2 mm, 0.8 g
  bodies), except in scenes built from exactly-touching boxes (Net, Wrecking Ball). There a
  zero-gap contact's `sep > 0` test flips between f32 and f64 (C0 = the 5e-4 margin exactly).

### Bugs this caught
- **Broadphase classification on the boundary.** The CPU classified bodies as "large" from
  the stored radius; the GPU recomputed it in f32. The box whose radius *was* the threshold
  counted as large on the GPU and small on the CPU, so it was in neither the grid nor the
  large list and lost all its pairs (Box Rain, 4 load-bearing contacts, 1.4 cm error in
  one step). Fix: threshold midway between the largest small radius and the smallest large
  one, and a cell-size margin.
- **Feature-ID flicker toppled stacks on the GPU only.** Atomic adjacency order leaves
  ~1e-9 rad of rotation where the CPU's arithmetic cancels exactly. A vertex lying exactly
  on a side plane then gets clipped, which renames the contact's feature, so it loses its
  warm start (penalty 1 instead of ~19,000) while its twin keeps it. The box gets a
  1.4e-3 rad kick in one step, and the 20-box stack walked over within 2 s. The coloured
  CPU solver survives 1e-3 rad of initial noise, so this was GPU-specific amplification, not
  ill-conditioning. Fix: `matchNearest`. When the exact (pair, feature) key misses, inherit
  from the pair's previous contact nearest in A-local anchor position (≤ 5% of the smaller
  box). It's on in `parallelParams()`, identical on CPU SoA and GPU, and off in the
  reference (oracle parity kept). The GPU stack now tracks the CPU to 1e-4 after 10 s.
- WGSL-level: a weak compare-exchange can fail spuriously (retry the same slot, or lookups
  stop early); a buffer must not be both indirect source and writable binding in one
  dispatch (separate args buffer and module); ≤ 8 storage buffers per pipeline (split
  modules).

### Scaling, full pipeline (headless Dawn, `pnpm bench2d:gpu`, 10 iterations)

| scene | bodies | contacts | colours | wall ms/step |
|---|---|---|---|---|
| pyramid 100 | 5k | 16k | 6 | 3.4 |
| pyramid 200 | 20k | 43k | 12 | 6.4 |
| wrecking ball 400×100 | 40k | 57k | 8 | 7.1 |
| box rain 300×300 | 90k | 121k | 7 | 7.9 |
| joint lattice 320² | 102k | 0 (204k joints) | 5 | 10.1 |
| joint lattice 512² | 262k | 0 (523k joints) | 5 | 20.8 |

Per body that's ~0.09 µs per step against the CPU solver's ~8 µs, about 90×. In a 60 fps
budget, ~90k boxes with contacts fit on this machine, against ~2k on the CPU. Joint lattices got slower than
Stage 3 (6.2 → 10.1 ms at 100k) because they now pay for the per-step broadphase (200k
no-collide binary searches) and 16 colouring rounds. Chrome timings taken while the preview
pane was hidden were unreliable: 49 ms wall for the 20k pyramid, against 6.4 ms headless.
Timestamp GPU time and wall time also disagree for single cold steps. Stage 5 needs
per-phase timestamps and measurements in a visible browser tab.

## 2026-09-23 — Stage 3: WebGPU solver, fixed topology (src/avbd2d/gpu)

Measured on an **Apple M4 Max (40-core GPU, 546 GB/s)**. That is far above the target
hardware: an M1 has 8 GPU cores and 68 GB/s. The kernels are memory-bound gathers, so expect
roughly 5–8× these times on an M1. That's an estimate, not a measurement; the in-app HUD
reports timestamp-query GPU time, so the target machines can measure it directly.

### The WGSL port matches the CPU solver to f32 round-off
Headless Dawn (`pnpm test:gpu`), the 8 joint-only demo scenes, GPU against the coloured f32
CPU solver built from the same scene and colouring:

| | step 1 | step 60 | step 300 |
|---|---|---|---|
| worst scene | 2e-6 | 1.6e-4 | 1e-3 (Rope: 0.2) |

Rope is a free-swinging 20-link chain, effectively a chaotic multi-pendulum, so f32 GPU
arithmetic against the CPU's f64 arithmetic drifts apart there. Every other scene stays
≤ 1e-3 after 5 s. The GPU also passes the behaviour checks (hanging-rope joint error, rod sag,
motor speed) and the drag round trip. Appending a constraint leaves every existing GPU
record bit-identical.

### No infinities on the GPU
WGSL implementations may assume finite floats (Metal compiles with fast math), so ±∞ in
stiffness, force bounds and fracture thresholds is uploaded as ±3e38, and "hard" means
stiffness ≥ 1e30. The parity results above were obtained with this encoding.

### Scaling (hard-jointed lattices, 10 iterations, α 0.95, 5 colours, 0 clashes)

| lattice | bodies | joints | Dawn wall ms/step | Chrome timestamp GPU ms/step |
|---|---|---|---|---|
| 64² | 4k | 8k | 0.66 | |
| 128² | 16k | 33k | 0.85 | |
| 256² | 65k | 131k | 3.4 | |
| 320² | 102k | 204k | 6.2 (Chrome wall 5.3) | 3.3 |
| 512² | 262k | 523k | 14.2 | |

Per body that's ~85× the CPU solver (the CPU does 4k at 21 ms). Colouring + upload of the
100k lattice takes ~70 ms once. The gap between wall and GPU time (5.3 vs 3.3 ms at 100k) is
submission overhead: ~55 dispatches per step plus per-step uniform writes. That's a Stage 5
target.

### Large lattices show the paper's stated limit
Max joint error on the 320² lattice reaches ~0.2 by 2 s (4k lattice: 5e-3), because a
320-wide sheet pinned at two corners needs force to travel hundreds of links, and
information crosses one link per colour sweep. The paper's Discussion names this
limitation. It's a property of the method, not the port.

## 2026-09-23 — Stage 2: GPU-shaped CPU solver (src/avbd2d/soa)

### The GPU data layout reproduces the C++ exactly
In `order: 'sequential'` + f64 mode, the SoA solver matches the upstream C++ to ≤ 4e-10 after
600 frames on all 19 scenes. That covers the grid broadphase, per-point contact records,
persistence by sorted (pair key, feature), CSR adjacency and joint compaction.
`tests/avbd2d-soa.test.ts` enforces it. The broadphase also matches brute force on random
clouds that include oversized bodies.

### Colouring: index priorities don't converge; hashed Jones-Plassmann does
Speculative greedy colouring (every clashing body recolours at once, lower index wins) left
11 clashes on a 19-link rope after 8 rounds. Neighbours keep picking the same colour, so one
body settles per round. Incremental Jones-Plassmann with hashed priorities converges in
≤ 12 rounds on every scene, with 0 clashes: a 5000-link chain takes ≤ 20 rounds and 3 colours.
An unchanged graph takes 0 rounds. Scenes need 3–8 colours.

### Jacobi fallback for clashing colours is not safe for hard joints
With 587 leftover clashes, Joint Grid exploded (positions ~1e6), because neighbours solved
Jacobi-style overshoot on hard joints. The paper says clashes only degrade to Jacobi; for
hard constraints they must be driven to ~0. The colouring round budget is sized for that.

### Coloured order converges more slowly on stacks; the card house is order-sensitive
- Static Friction, 10 iterations: coloured order lets one plank slip 3–5 cm once (at 18–28 s),
  in both f32 and f64. At 20 iterations, or with α = 0.95 (below), it holds. Shuffling colour
  order each iteration makes it worse (slip at 5 s).
- Cards: the house stands in the demo's newest-first order, falls in oldest-first with
  α = 0.95, and stands in only 2–4 of 5 shuffled orders. The coloured orders behave the same.
  This is a marginal scene, not a colouring bug; it is excluded from the coloured pass/fail
  suite.
- f32 storage changes nothing measurable: in sequential order, f32 and f64 track each other.

### GPU default parameters: α = 0.95, no post-stabilization
Coloured f32 backend, mean/worst joint error over frames 60–600, and slope creep:

| | Hanging Rope | Heavy Rope | Joint Grid | slope creep 30 s |
|---|---|---|---|---|
| post-stab (demo) | 2.1e-2 / 3.9e-2 | 7.5e-2 / 1.2e-1 | 1.1e-2 / 1.8e-2 | 33 mm |
| α = 0.95 | 5.9e-3 / 2.2e-2 | 1.9e-2 / 4.2e-2 | 5.7e-3 / 6.7e-3 | 2.1 mm |
| α = 0.99 | 6.4e-2 / 2.9e-1 | 8.1e-2 / 3.0e-1 | 1.5e-2 / 1.7e-2 | 22 mm |

α = 0.95 also brings Stack Ratio closer to rest height (47.42 against 47.5; post-stab gives
47.23). It saves one primal pass per step. The parallel solvers therefore use
`parallelParams()`: β = 1e5, γ = 0.99, α = 0.95. The reference keeps the demo defaults for
oracle parity.

### CPU scaling baseline (M-series, Node, coloured f32, 10 iterations, `pnpm bench2d`)

| scene | bodies | contacts | colours | ms/step | broad | narrow | adj+colour | primal | dual |
|---|---|---|---|---|---|---|---|---|---|
| Box Rain 40x25 | 1003 | 2235 | 6 | 5.9 | 0.46 | 0.54 | 0.12 | 3.3 | 1.4 |
| Pyramid 50 | 1276 | 4727 | 7 | 11.1 | 0.58 | 0.84 | 0.20 | 6.6 | 2.9 |
| Joint Lattice 64² | 4096 | 0 | 5 | 21.4 | 1.15 | 0.15 | 0.40 | 14.3 | 5.4 |
| Wrecking Ball 100x40 | 4002 | 15165 | 8 | 41.1 | 1.97 | 2.92 | 0.69 | 24.8 | 10.6 |
| Pyramid 100 | 5051 | 19606 | 7 | 45.2 | 2.47 | 3.20 | 0.76 | 27.2 | 11.5 |

That's ~6–9 µs per body per step; the CPU's real-time ceiling is ~1.5–2k boxes. Primal + dual
is 85% of the time, collision detection ~12%, adjacency + colouring < 2%. The GPU's job is
the solve; the pipeline around it is cheap.

## 2026-09-23 — Stage 1: 2D CPU reference

### The TS port matches the upstream C++ to round-off
`tools/cpp-oracle` compiles the unmodified avbd-demo2d solver headless. Compiled as written
(f32), it agrees with the f64 TS port to 1e-7…1e-4 over 300 frames. Scenes with exactly
touching boxes (Net, Stack Ratio) differ in contact count from frame 2, because zero-gap
contacts flip on f32 rounding. Compiled in f64 (a textual `float`→`double` copy), it matches
the port to ≤ 5e-10 after 600 frames on all 19 scenes, with identical force counts every
frame. `tests/avbd2d-ref.test.ts` enforces this against `tests/fixtures/oracle2d`.

Consequence for the GPU (f32): expect contact-set flicker at zero-gap configurations. Validate
the GPU against metric envelopes and single-step diffs, not long trajectories.

### Sliding friction is under-applied by the demo; Eq. 14 fixes it but hurts stacking
Dynamic Friction scene, 10 iterations, 10 s. Coulomb predicts d = v²/(2μg).

| slide distance at combined μ = | 1.58 | 1.22 | 1.00 | 0.71 | 0.50 |
|---|---|---|---|---|---|
| Coulomb | 3.16 | 4.08 | 5.00 | 7.07 | 10.0 |
| demo (penalty Hessian) | 6.28 | 7.96 | 9.73 | 13.98 | 18.77 |
| stiffness rescale (Eq 14) | 3.08 | 4.00 | 4.92 | 6.99 | 9.92 |

The demo builds the
friction Hessian from the unclamped penalty, so a sliding contact's step is too small.
Eq. 14 rescaling gets within 3% of Coulomb, but makes the card house unstable: it explodes
with full Eq. 14, and collapses when only friction rows, only normal rows, or a stiffness
floor are rescaled. The paper uses rescaling only in its friction test. Decision: opt-in
(`stiffnessRescale`), off by default.

### β = 10 (paper Table 2) is wrong for these units; α-regularization beats post-stab
Mean / max hard-joint error over frames 60–600:

| config | Hanging Rope 5 it | Heavy Rope 5 it | Hanging Rope 20 it | Heavy Rope 20 it |
|---|---|---|---|---|
| demo: post-stab, β 1e5, γ .99 | 3.8e-2 / 7.8e-2 | 1.2e-1 / 2.0e-1 | 1.4e-2 / 3.2e-2 | 4.9e-2 / 6.9e-2 |
| paper: α .95, β 10, γ .99 | 1.7 / 3.0 | 3.8 / 7.0 | 0.43 / 0.75 | 0.94 / 1.9 |
| α .95, β 1e5, γ .99 | 1.1e-2 / 4.8e-2 | 3.7e-2 / 7.0e-2 | 3.3e-3 / 2.5e-2 | 9.9e-3 / 2.5e-2 |
| plain VBD, k = 1e6 | 1.2e-2 / 2.5e-2 | 1.6e-2 / 4.2e-2 | 1.5e-3 / 2.9e-3 | 1.2e-2 / 3.5e-2 |

β has units (the demo comment warns about this). With β = 1e5, Baumgarte-style α = 0.95
gives about 3× lower joint error than the demo's post-stabilization. Plain VBD with a stiff
k = 1e6 is competitive on these rope scenes, because they don't really test stiffness ratios.
Revisit the GPU default (post-stab vs α) with these metrics in Stage 2.

### Other calibrated behaviour of the reference
- Static Friction: boxes slide 3–6 cm while landing on the 30° slope, then creep < 1 mm per 25 s.
- Rod (20-link cantilever, all rows hard): the tip sags ~0.10 by 5 s and recovers slowly
  (0.068 at 30 s). Information propagation along the chain is limited by iterations.
- Stack Ratio (1024:1 mass on top): the bottom box sits ~0.05 into the ground and recovers
  ~3 mm/s. This is the C++ behaviour too.
- CPU cost (M-series, Node): Pyramid (211 bodies) 2.7 ms/step, Joint Grid (625) 7.3 ms/step;
  the O(n²) broadphase dominates the grid scene.

## Two-level broadphase grid (#17, 2026-10-12)

When held slabs enlarge the existing grid, moving-body radii now select an additional fine
level. Similarly sized fixed pieces share that level; coarse pieces retain the existing
cell size. Both levels share the hash table and scan buffers, with level-salted hashes and
explicit level/cell checks. Within a level, dynamic/dynamic pairs belong to the higher index
and dynamic/fixed pairs to the dynamic body. Cross-level pairs belong to the finer body;
fine fixed bodies use the auxiliary pass when coarse movers exist. Each scan needs only 27 cells.
The original large-body list remains for extreme sizes. With no useful size separation,
the grid stays at one level. Radius or dynamic/fixed changes refresh the classification.

Validation: all gate components passed: 81 CPU tests, 76 Dawn GPU tests, no skips,
typecheck and Vite/library builds. GPU files ran sequentially. The new brute-force pair test
covers fine/coarse/large bodies, both index orders, duplicate exclusion, sleeping, waking
and resizing. Independent review caught an initial fixture that never activated the fine
level; the corrected fixture explicitly asserts each stage's grid configuration.
Three comparison runs against main 9b9c27b produced identical complete body-state buffers
after 60 steps in all four scenes, with no overflow.

M4 Max, shared load (6.94, GPU utilization 49% at the start of the final comparison batch).
Medians of three runs, each with 120 steps and nine timestamp samples:

| Scene | Wall ms/step old -> new | GPU collision ms old -> new | GPU total ms old -> new |
| --- | ---: | ---: | ---: |
| 10k fixed + 512 moving, similar sizes | 1.142 -> 1.453 | 0.131 -> 0.197 | 0.590 -> 0.590 |
| 125-body pile | 1.442 -> 1.356 | 0.131 -> 0.131 | 0.786 -> 0.786 |
| 32-joint hub | 1.404 -> 1.239 | 0.066 -> 0.066 | 0.655 -> 0.655 |
| 160 held slabs + 4k small fixed pieces + 512 moving pieces | 2.865 -> 1.144 | 2.163 -> 0.197 | 2.687 -> 0.721 |

The targeted mixed-size case improves substantially. Other wall-time results are mixed
under load; the similar-size case is slower in wall time and differs by one timestamp tick
in collision, with unchanged GPU total. No universal speedup or older-hardware claim.
The comparison script is reproducible with a baseline checkout path; the original CPU
capacity estimate stays conservative and unchanged. No npm version/publication change.

## Bounded color-tail dispatches (#16, 2026-10-12)

For small active sets, colors 16 and above now run in one workgroup, sequentially by color
and in chunks within each color. Storage barriers preserve Gauss-Seidel color order; no
Jacobi update or color relabeling is introduced. The host omits the individual tail
commands: at cap 64, 14 iterations, primal dispatch calls fall from 896 to 238. Pass
constants are shared across iterations and uploaded only when alpha changes or the buffer
grows (232,960 bytes per step previously, versus 16,640 once at cap 64).

The first prototype left empty indirect commands in place; independent review correctly
identified that this left the main overhead. The next prototype exposed a dense-tail
regression (1,000 bodies serialized: GPU solve 2.818 -> 9.961 ms). The final policy fuses
at most 128 active bodies, or at most 1,024 active bodies with a recent tail count <=128.
Fixed-color validation uses the exact CPU count. Other scenes use the count supplied to
`adapt`, conservatively starting on the parallel path. A stale hint can temporarily cost
performance, but the fused kernel always processes all current colors and chunks. Large
active sets and dense tails retain parallel dispatches; custom solve shaders also retain
the original path. `fuseSparseColors = false` disables fusion for comparison.

The existing cap already shrinks after three quiet readbacks; regression coverage verifies
64 -> 4 and regrowth on clashes. This does not solve pathological graph-coloring clashes
or guarantee a minimum palette. Default coloring and color order are unchanged.

Validation: 81 CPU tests and the full 77-test GPU gate passed, plus the subsequently added
stale-hint test (78 distinct GPU tests, zero skips), typecheck, Vite build and library build.
New coverage compares complete states for fusion, multi-chunk tails, >1,024-body fallback,
alpha/iteration changes, and an underestimated hint with dynamic coloring. Three baseline
comparisons against main 9b9c27b produced zero differing body-state values after 60 steps
in all five scenes, including alpha/iteration/cap changes.

`node --experimental-transform-types scripts/compare3d-gpu.ts <baseline-checkout>` runs
sequentially on one Dawn device. These are deliberately cap-64 stress measurements, not
normal adaptive-demo FPS claims. 120-step wall time and nine GPU samples per scene,
medians across three runs; M4 Max with shared GPU load (load 6.94, GPU utilization 49%):

| Scene | Wall ms/step old -> new | GPU solve ms old -> new |
| --- | ---: | ---: |
| 10k fixed + 512 moving | 10.085 -> 2.928 | 2.753 -> 0.852 |
| 125-body pile | 9.616 -> 2.757 | 2.621 -> 0.918 |
| 32-joint hub | 9.956 -> 3.137 | 3.277 -> 0.918 |
| Hub with sparse high color labels | 9.840 -> 2.788 | 4.850 -> 2.032 |
| 1k bodies in one high-label bucket (parallel fallback) | 9.845 -> 10.568 | 3.736 -> 3.408 |

The dense fallback wall-time result is mixed with GPU time under load; no gain is claimed
for it. GPU timestamps are quantized (~0.0655 ms). The real destruction session and older
hardware still need measurements before extrapolating these targeted gains.

## Fixed-body broadphase probes (#14, 2026-10-12)

Fixed invocations in the primary probe pass return before loading their shape or scanning
grid neighbors. Combined with #17, the auxiliary pass scans coarse neighbors for fine fixed
bodies only when coarse movers exist. A dynamic
small body owns its pairs with fixed small bodies regardless of index; the large-body path owns
fixed-large pairs, and a separate pass handles small fixed versus large dynamic bodies when needed.
The saved WIP's compacted probe list was removed: it added atomics, a buffer region and an argument
dispatch without a demonstrated benefit in these tests. There is no new public option or buffer layout.
three-destruction implements sleep by rewriting a body as fixed with zero solver mass, restoring it
on wake; this change covers that representation, not a new native sleeping API.

Validation: all gate components passed (81 CPU tests, 76 Dawn GPU tests, zero skips; typecheck,
Vite build and library build). GPU files ran sequentially with `--test-concurrency=1`; Node rejects
that flag in NODE_OPTIONS, so the gate's components were invoked explicitly. The new regression
covers all small/large and fixed/dynamic pair combinations, both index orders, and sleep/wake rewrites.

`node --experimental-transform-types scripts/compare3d-gpu.ts <baseline-checkout>` compares each
scene sequentially against main 9b9c27b on the same device. Three runs produced identical full
body-state buffers after 60 steps, with no overflow, for 10,000 fixed pieces plus 512 dynamic pieces,
a 125-body pile, and a 32-joint hub. Median timings (M4 Max, Dawn, other GPU work active; initial
load 12.92, GPU utilization 59%):

| Scene | Wall ms/step baseline → candidate | GPU collision ms baseline → candidate | GPU total ms baseline → candidate |
| --- | ---: | ---: | ---: |
| Fixed-heavy | 0.989 → 0.949 | 0.131 → 0.131 | 0.590 → 0.590 |
| Pile | 0.917 → 0.912 | 0.131 → 0.131 | 0.655 → 0.655 |
| Joint hub | 0.941 → 0.916 | 0.066 → 0.066 | 0.590 → 0.590 |

GPU timestamps are quantized at about 0.0655 ms here. The small wall-time changes under shared
load are not evidence of a robust FPS gain; representative hull-heavy and target-device measurements
remain necessary. This establishes pair coverage and state equivalence for the measured scenes,
not universal cross-device bitwise determinism. No version bump or publication was performed.

Combined #14/#16/#17 integration: all gate components passed (81 CPU, 81 GPU, zero skips),
with an explicit fine/coarse fixed/dynamic ownership regression. Six cap-stress comparison
scenes against pre-optimization main retain bit-identical complete body states at 60 steps.

### STE-2538 combined replay follow-up

Sparse color fusion is now opt-in (`fuseSparseColors = true`). The destruction
play-session matched the baseline through 815 frames but diverged at frame 816
with fusion enabled, with zero reported coloring clashes; disabling fusion
restored the first 900 frames. The focused synthetic tests did not expose this
real contact/joint transition. Earlier fusion timings describe the experimental
path, not a replay-safe default. The exact fused-entry-point difference remains
unresolved; keep the original per-color dispatch path for deterministic replay. (Superseded in
part by "STE-2538 fused tail" below: the divergence is confined to steps that count a colouring
clash, and the zero clashes were a sampling gap.)

### STE-2538 fused tail: the frame-816 cause (2026-10-17)

What is established: the divergence is confined to steps whose colouring clashes. With a proper
colouring the fused tail and the per-colour dispatches are bit-identical; gating fusion off on
clash steps alone restores the play session (below). When bodies of one colour share a constraint
(the Jones-Plassmann rounds or the cap ran out: such bodies stay pending and are counted as
clashes, and those with no colour go to the last colour, a tail colour once the cap passes 16;
read from `wgsl-topology.ts`, not tested here, since both files below colour through
`fixedColors`), the colour's own dispatch runs its 8-body workgroups concurrently, while
`primalSparse` runs the same chunks one after another in one workgroup. The exact order the
per-colour path then follows is not pinned down: it is neither chunk-sequential nor Jacobi (the
deferred-writes variant below gives a third result), and it is scheduling-dependent.

- `tests-gpu/sparse-colors-contacts.gpu.test.ts`: fused equals per-colour bit for bit with
  contacts in the tail (one body a colour, and one colour over five chunks), and in a control
  below the tail.
- `tests-gpu/sparse-colors-clash.diag.ts` (a diagnostic, not a test): equal for a proper tail
  colouring over several chunks and for a clash inside one chunk; different from the first step
  for 40 jointed bodies sharing one tail colour, in each of four runs. With all 40 sharing a
  colour, two per-colour solvers on the same scene also differed from step 2 in one of four runs:
  a clash across workgroups is scheduling-dependent in the default path too. (M4 Max, Dawn;
  console output not saved.)
- The play session (three-destruction, a local pack with fusion on): deferring a colour's writes
  until all its chunks have read still stops at frame 816, with a different hash; falling back
  to the per-colour dispatches on any step that counts a clash (`argsColors`:
  `counters[C_CLASHES] == 0`) reproduces all 2,940 baseline hashes, in one replay
  (three-destruction `docs/perf.md`, sbobyn/three-destruction#88).
- The earlier "zero clashes": `beginFrame` clears `C_CLASHES` every step, and the destruction
  engine copies the counters once a readback, so a clash in any other step is never seen.
- That fallback kept every per-colour dispatch encoded (zero-sized in the tail when fused). For
  colours this small, a zero-sized indirect dispatch cost about as much as a real one: 400
  bodies, 64 colours (about 1-20 bodies each, a proper fixed colouring, so the fallback never
  fired), 10 iterations, wall time a step from submit to done, per-colour 6.5-6.7 ms, fused
  2.9 ms, fused with the fallback 6.7-7.0 ms (M4 Max, Dawn, a shared machine, load not
  recorded; medians of 7 trials, two runs each). It was not kept.

Fusion stays off by default. The per-colour path is the replay reference only while no clash
spans workgroups. In the play session, three recordings with fusion off agree on all 2,940
hashes (the baseline, its repeat, and the merged main on published 0.3.0), but that is not
guaranteed. An exact
fused path needs the clashing colour dispatched on its own without encoding the rest of the tail,
or clashes given one defined order in both paths (which changes the default path's results on
clash steps and makes them deterministic).
