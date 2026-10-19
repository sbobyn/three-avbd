# SDF paper reproduction status

The implementation targets Giles & Andrews, [Real-Time Collision Handling for Signed Distance Fields via Caching and Importance Sampling](https://savant117.github.io/sdf-dcd-demo/paper.pdf). This page separates method support from experiment reproduction. Nothing here is a claim that every paper figure or timing has been reproduced.

## Implemented and tested

- Algorithm 1, analytic/voxel fields, curvature seeds, caching and all three optimizers on CPU and GPU. Pinned upstream fixtures remain unchanged.
- Public baking, mass/inertia preparation, GPU spatial candidates, runtime field/body refresh, contact events and raycasts. Independent normals and identity-based warm starts remain intact.
- Explicit `epsilon: 0` selects the hardmax ablation. Equal field values use the midpoint subgradient; positive smoothing defaults are unchanged. `scaleCollisionParams()` preserves explicit zero.
- `warmStart: false` disables collision-sample reuse; cacheSize 4 plus randomSamples 1 still performs five fresh searches. It also prevents transport of previous SDF contact multipliers/penalties because those require a cached point identity. It does not disable AVBD globally; energy changes cannot be attributed solely to the collision search.

## Tables 3/4: box and gear ablations

Command: `nice -n 15 node --experimental-transform-types scripts/sdf-ablations.ts OUT.json 360`.

All 18 combinations completed sequentially with a 10 ms idle interval per frame and no GPU validation errors. These are the released scenes with GPU AVBD, not the paper CPU sequential-impulse solver. Queries and iterations are summed across substeps then divided by substeps; contacts/pairs are final-substep snapshots averaged across frames. No timing equivalence is claimed.

| Scene | Optimizer | Variant | Mean paired queries | Final energy (J) | Final sampled overlap (mm) |
|---|---|---|---:|---:|---:|
| Box | NM | default | 1377.8 | 6.02065e-06 | 0.000 |
| Box | NM | no-softmax | 2727.7 | 8.22908e-07 | 0.000 |
| Box | NM | no-cache | 4251.7 | 0.00258348 | 0.000 |
| Box | Ellipsoid | default | 905.9 | 1.77682e-08 | 0.000 |
| Box | Ellipsoid | no-softmax | 2111.7 | 2.05928e-08 | 0.000 |
| Box | Ellipsoid | no-cache | 3563.9 | 0.00392864 | 0.000 |
| Box | SGD | default | 895.4 | 1.58991e-06 | 0.000 |
| Box | SGD | no-softmax | 10311.7 | 2.09782e-07 | 0.000 |
| Box | SGD | no-cache | 997.3 | 0.0356603 | 0.323 |
| Gear | NM | default | 739.7 | 4.22937e-08 | 0.000 |
| Gear | NM | no-softmax | 1182.2 | 1.67408e-05 | 0.000 |
| Gear | NM | no-cache | 1198.0 | 0.00193445 | 0.000 |
| Gear | Ellipsoid | default | 797.3 | 0.000116144 | 0.000 |
| Gear | Ellipsoid | no-softmax | 1399.2 | 0.000185643 | 0.000 |
| Gear | Ellipsoid | no-cache | 1117.6 | 0.00226722 | 0.000 |
| Gear | SGD | default | 212.0 | 2.76382e-06 | 0.000 |
| Gear | SGD | no-softmax | 2258.1 | 2.15487e-06 | 0.000 |
| Gear | SGD | no-cache | 953.2 | 0.0913093 | 45.775 |

Smoothing removal increases paired-query cost for all six scene/optimizer combinations. Removing caching raises final residual energy in all six cases; the SGD/no-cache gear case reaches 45.8 mm sampled overlap and 0.091 J, qualitatively consistent with the paper’s FAIL entry. These are individual runs, not ensembles.

Exact paper counts are **not reproduced**: for example, the released upstream box capture itself finishes with 196 contacts, whereas Table 3 lists 116; our default NM box mean is 196. The released gear capture finishes with 47, versus Table 4’s 12; our default NM mean is 46.8. These source/trajectory differences must not be presented as exact numerical agreement. The raw report includes paper columns for direct comparison and retains the released SGD stop rule.

Data: [ablation record](measurements/sdf-ablations-2026-10-19.json).

## Figure 6: corrected 1,000-frame drop diagnostic

Commands: `scripts/sdf-fig6.ts OUT.json 100 1000 bunny 4:1` and the same command with `cow`, using Node's `--experimental-transform-types` flag. Runs were sequential with a 10 ms idle interval per frame.

Each configuration uses 100 shared random orientations, four cached plus one random sample, and the released parameters. Collision masks isolate the drops from each other. A 20 km-wide finite floor approximates the plane; edge or bottom escapes invalidate the comparison. All four corrected configurations completed with no escapes. Depth is the deepest source-mesh vertex below y = 0, not a dense-oracle simulation.

| Shape | Sampling | Mean depth over rollouts/frames (mm) | Peak depth (mm) |
|---|---|---:|---:|
| Bunny | Uniform | 0.402 | 78.213 |
| Bunny | Curvature | 0.387 | 64.365 |
| Cow | Uniform | 2.926 | 384.969 |
| Cow | Curvature | 3.104 | 334.693 |

Curvature sampling improves the bunny result and the cow peak, but worsens the cow mean. This does **not** establish a consistent curvature benefit or reproduce the complete Figure 6 study. The remaining transient depths are substantial and must not be described as penetration-free.

The earlier [finite-floor diagnostic](measurements/sdf-fig6-1000-4-1-2026-10-19.json) is retained only as an invalidated diagnostic: it allowed drop-drop contacts and had a 120 m-wide floor. A separate [isolated-drop diagnostic with escape records](measurements/sdf-fig6-finite-floor-diagnostic-2026-10-19.json) confirmed cows leaving that finite floor. The old extreme depth values cannot be treated as infinite-plane penetration measurements. The corrected records are [bunny](measurements/sdf-fig6-wide-bunny-2026-10-19.json) and [cow](measurements/sdf-fig6-wide-cow-2026-10-19.json).

### Larger contact-search budget

The same isolated-drop protocol at **16 cached + 4 random samples** measured zero source-vertex plane penetration for both bunny and cow, under both uniform and curvature sampling, across all 100 drops and 1,000 frames. All configurations had zero escapes. This is an observed result, not a universal nonpenetration guarantee. The solver rest-gap intrusion remained nonzero (about 1.1–1.3 mm mean), so zero plane penetration does not mean exact target separation.

[Raw 16+4 record](measurements/sdf-fig6-wide-16-4-2026-10-19.json). Command: `scripts/sdf-fig6.ts OUT.json 100 1000 bunny,cow 16:4`. Source: `d9e424d`, Three.js 0.186.1, M4 Max; sequential execution with 10 ms idle per frame. The earlier 4+1 records used Three.js 0.186.0. No timing comparison is claimed, and the exact paper-oracle reproduction remains outstanding.

At **8 cached + 1 random sample**, all configurations again had zero escapes, but residual transient penetration remained:

| Shape | Sampling | Mean depth (mm) | Peak depth (mm) |
|---|---|---:|---:|
| Bunny | Uniform | 0.022 | 5.910 |
| Bunny | Curvature | 0.022 | 5.910 |
| Cow | Uniform | 0.322 | 772.299 |
| Cow | Curvature | 0.201 | 133.516 |

[Raw 8+1 record](measurements/sdf-fig6-wide-8-1-2026-10-19.json), same source/environment and protocol as 16+4, with the final command argument changed to `8:1`. The 8+1 uniform-cow peak (772 mm) is worse than the earlier 4+1 result despite a lower mean, so improvement is not monotonic and these transient failures remain important. The 16+4 outcome shows a budget effect in this diagnostic, not a general guarantee; the completed sweep is reported below.

## Completed Figure 6 budget sweep and dense-plane analogue

All six cache/sample combinations, both sampling modes and both shapes are now measured with 100 orientations and 1,000 frames: **24 configurations**. The rerun 4+1 baseline uses the same Three.js 0.186.1 version as the other records. No configuration escaped the wide floor or overflowed its contact buffers. [Complete raw sweep](measurements/sdf-fig6-budget-sweep-2026-10-19.json).

Peak source-vertex penetration across all orientations and frames, in millimetres:

| Cache:random | Bunny uniform | Bunny curvature | Cow uniform | Cow curvature |
|---|---:|---:|---:|---:|
| 4:1 | 78.213 | 64.365 | 384.969 | 334.693 |
| 4:4 | 12.145 | 20.488 | 82.070 | 129.670 |
| 8:1 | 5.910 | 5.910 | 772.299 | 133.516 |
| 8:4 | 0.000 | 0.000 | 2.231 | 5.945 |
| 16:1 | 0.000 | 0.000 | 4.189 | 4.180 |
| 16:4 | 0.000 | 0.000 | 0.000 | 0.000 |

The high-budget configurations sharply reduce observed penetration, but results are not monotonic and curvature sampling does not consistently improve them. This reproduces the Figure 6 **parameter sweep protocol**, not the paper's numerical curves. It is not the separate Table 2 full-pile timing sweep.

The new diagnostic backend exhaustively evaluates **1,000 fixed, area-stratified mesh-surface points per body** against an analytic plane every substep. Every point inside the margin emits its own AVBD contact; persistent point-to-contact mappings transport warm starts. It uses the same initial orientations, mass/inertia, friction, gravity, substeps, iterations and depth probe as the optimizer runs. It does not use Algorithm 1, its seed selection, or supplemental mesh contacts. The generated point arrays and their hashes are recorded, together with SHA-256 hashes of the actual Float32 upload bytes (including vec4 padding).

| Dense reference | Mean depth (mm) | Peak depth (mm) | Peak total active contacts |
|---|---:|---:|---:|
| Bunny | 1.719 | 21.785 | 2539 |
| Cow | 4.546 | 32.812 | 2972 |

[Dense raw record](measurements/sdf-fig6-dense-plane-2026-10-19.json). Command: `scripts/sdf-fig6.ts OUT.json 100 1000 bunny,cow dense`. Runs are sequential with 10 ms idle per frame; no performance claim is made.

**Interpretation:** this is an independent dense plane-contact analogue, not the paper's exact oracle. The paper describes grid-sampled surface points, but its sample set and contact-reduction policy are unavailable. Our area-stratified points can miss extreme source vertices, and using all nearby samples as constraints changes contact multiplicity. Consequently the dense curve is not a guaranteed accuracy ceiling for the source-vertex metric, and trajectory differences cannot be attributed solely to search accuracy. Zero optimizer-run depth at 16+4 alongside nonzero dense depth is therefore not proof that the optimizer outperforms the paper oracle. See the separate Figure 7 analogue below; exact paper reproduction remains outstanding.

## Table 2: full-pile budget timing analogue

Command: `nice -n 15 node --experimental-transform-types scripts/sdf-table2.ts OUT.json 4314 360`.

All twelve budgets completed sequentially on the M4 Max: **4,314 dynamic bunnies plus one floor**, a reconstructed deterministic lattice, 360 frames, 120 warmup frames, 16 ms simulation frames, four substeps, and 20 AVBD iterations. NM uses tolerance 0.01 and at most 50 optimizer iterations. Every substep checked overflow; periodic full readbacks checked finite state. No overflow or non-finite state was observed. Each frame had 50 ms excluded idle time.

GPU timings below average 24 timestamped frames per budget and sum all four substeps. Collision includes preparation, spatial broadphase, search and contact export. Total sums per-substep elapsed timestamps spanning the collision/adjacency/coloring/solve phases, including inter-pass gaps. Wall time additionally includes dispatch and counter readbacks, timestamp waits on sampled frames, and synchronization. The raw JSON retains per-frame GPU timings, counters, and explicitly named **upperMedian** summaries; it does not retain individual wall samples. Runs are single observations, not confidence intervals.

| Cached + random | GPU collision (ms/frame) | GPU total (ms/frame) | Wall (ms/frame) | Paper t_coll (ms) |
|---|---:|---:|---:|---:|
| 4 + 1 | 20.28 | 28.09 | 41.20 | 1.8 |
| 4 + 2 | 29.32 | 45.50 | 60.31 | 2.4 |
| 4 + 4 | 42.89 | 63.11 | 80.68 | 4.2 |
| 6 + 1 | 36.03 | 50.80 | 77.37 | 2.7 |
| 6 + 2 | 35.01 | 44.35 | 58.83 | 3.0 |
| 6 + 4 | 45.07 | 55.24 | 67.54 | 4.4 |
| 8 + 1 | 41.58 | 51.21 | 63.49 | 3.9 |
| 8 + 2 | 48.79 | 61.61 | 76.73 | 4.2 |
| 8 + 4 | 59.43 | 74.14 | 88.35 | 5.0 |
| 16 + 1 | 104.58 | 119.92 | 134.91 | 7.7 |
| 16 + 2 | 110.61 | 123.71 | 143.18 | 8.1 |
| 16 + 4 | 130.61 | 145.56 | 159.10 | 8.9 |

These results are substantially slower than the listed paper timings. **No hardware or timing-region equivalence is claimed**, and the paper's exact pile poses are unavailable. This completes the full-size budget sweep for this implementation, not an exact numerical reproduction or a real-time performance claim. Production profiling/optimization remains warranted, especially at larger sample budgets.

Raw record: [full-pile timings](measurements/sdf-table2-full-2026-10-19.json).

### High-budget target: still unmet

A subsequent bounded search-optimization screen rejected ten prototypes. The restored-source 90-frame controls measured 108.82 ms with diagnostic pass splitting and 107.21 ms normally; these do not replace the 360-frame result below. No new runtime change was retained. The requested well-below-33 ms / ideally-below-16 ms collision target remains open; no target achievement or settling acceptance is claimed for the rejected variants. See the newest FINDINGS entry and `measurements/sdf-search-experiments-2026-10-19.json`. Native Metal tracing succeeded but did not collect useful compute shader samples/counters; configuring those is the next diagnostic checkpoint before another architectural change.

### Performance follow-up: history reads and transformed seeds

The retained optimization reads history members directly and caches transformed curvature seeds per body/substep. It preserves independent normals, point identities and warm starts. Optional cache allocation is capped at 128 MiB and device limits; unsupported/small cases retain direct sampling.

Normal, unsplit endpoint measurements (4,314 dynamic bunnies plus floor; 360 frames; four substeps; 50 ms idle/frame):

| Budget (cached + random) | Previous collision mean (ms) | Updated collision mean (ms) | Previous GPU total mean (ms) | Updated GPU total mean (ms) |
|---|---:|---:|---:|---:|
| 4 + 1 | 20.28 | 20.34 | 28.09 | 28.09 |
| 16 + 4 | 130.61 | 110.20 | 145.56 | 124.65 |

High-budget collision time decreased about 16%; low-budget time is effectively unchanged. These are single-run observations, not interleaved statistical trials. Intermediate budgets have not been remeasured. The performance gap remains open. Diagnostic split-pass profiling identifies narrowphase search as the dominant remaining cost; those timestamps include extra pass boundaries and must not be substituted for normal timings.

A separate 600-frame mesh-quality run matches every recorded physics field of the previous baseline exactly at all 20 samples, including energy and sampled penetration (maximum 2.749 mm). Sampling 300 nearby pairs does not establish a global penetration bound. A faster scalar-distance experiment was rejected after reaching 7.731 mm sampled penetration and 16.412 J final energy. The original distance objective is retained.

Records: `measurements/sdf-performance-endpoints-2026-10-19.json`, `sdf-performance-cache-settling-2026-10-19.json`, `sdf-dispatch-profile-2026-10-19.json`, and `sdf-performance-rejected-scalar-2026-10-19.json`. Reproduce normal endpoints with `scripts/sdf-table2.ts OUT 4314 360 4:1` and `16:4` sequentially; use `SDF_DISPATCH_PROFILE=1` only for diagnostic phase splitting. Run `SDF_FRAME_PAUSE_MS=100 node --experimental-transform-types scripts/sdf-scale.ts OUT 4314 600 64000` for the paced settling check.

## Figure 7: five-rollout dense-pile energy analogue

Command: `nice -n 15 node --experimental-transform-types scripts/sdf-fig7.ts OUT.json 500 5`.

Completed all **30 runs**, sequentially with 10 ms idle per frame: two released 27-mesh piles plus floor, three contact modes, five matched deterministic ±10 µm initial-position jitter seeds, and 500 frames per run. Released masses, principal inertias, friction, four substeps and 20 AVBD iterations are preserved. Uniform/curvature use the released 4+1 search budget. Energy is post-step translational plus rotational kinetic energy in the principal body frame. Every substep checks overflow and every frame checks finite state. No overflow, non-finite state, or below-ground body center occurred; the center check is **not a penetration bound**.

The independent dense backend tests 1,000 area-stratified, fixed body-local surface samples against every other body's SDF. Each active directed sample produces its own constraint, with independent normal and persistent identity/warm start. Both directions of dynamic pairs are tested. There is no optimizer or manifold reduction, so this deliberately changes contact multiplicity. It requires ten storage bindings and is a diagnostic backend, not a public portable collision path.

The table reports energy averaged over frames 401–500, then averaged over five rollouts; ranges show the five individual tail means.

| Scene | Mode | Mean tail energy (J) | Rollout range (J) |
|---|---|---:|---:|
| Chairs | uniform | 0.019345 | 0.0066971–0.0396314 |
| Chairs | curvature | 0.262713 | 0.000547303–0.895405 |
| Chairs | dense | 1.28031e-06 | 2.01546e-10–6.17444e-06 |
| Bunny Pile proxy | uniform | 0.180283 | 0.00888553–0.601629 |
| Bunny Pile proxy | curvature | 0.0322033 | 0.00259785–0.077708 |
| Bunny Pile proxy | dense | 1.9162e-06 | 9.43586e-08–4.6481e-06 |

The dense analogue settles much more tightly. Curvature improves the bunny average here but worsens the chair average, with substantial rollout variation. This does **not** reproduce the paper's consistent curvature-to-dense result. No solver thresholds or fixtures were changed to fit the curves.

**Exact Figure 7 remains unreproduced:** the released Bunny Pile is not the paper's Bunny Iron Maiden; its spiked-plate layout and motion are not provided by the pinned source. Also, the paper's 1,000-seed baseline is not equivalent to this fixed-surface, all-contact diagnostic. These results support a scoped comparison, not an exact dense-oracle or Figure 7 claim. Raw per-frame energies/contact counts, mean curves, jitter seeds, sample-upload hashes and source hashes are retained in [the measurement record](measurements/sdf-fig7-piles-2026-10-19.json).

## Other evidence and remaining gaps

- Table 1 bunny analogue: corrected 4,314-body/600-frame measurements in PR #37 check every substep. A 64k reservation avoids overflow in both measured configurations; default capacity drops contacts during startup. Sampled penetration is not a global bound.
- Table 5: all three optimizer sweeps exist. The opt-in gradient-only SGD stopping rule matches aggregate paper cost more closely; it is an inference about the paper/code discrepancy, not author confirmation.
- Figure 6: full six-budget sweep and an independently implemented 1000-point dense plane-contact analogue completed above. Exact paper oracle/sample-set equivalence and consistent curvature benefit remain unestablished.
- Figure 7: five-rollout released-pile dense-surface comparison completed above. Exact Iron Maiden layout and the 1,000-seed baseline remain unreproduced; consistent curvature benefit is not established.
- Table 2: the full-size timing analogue is measured above; exact paper layout, hardware and collision-region equivalence remain unavailable.
- Remaining Table 1 scenes (16k funnel, 8,819-body Colosseum, 583 cows), SAT/GJK/EPA/hierarchical baseline implementations, and matching paper CPU timings have not been reproduced. Published layouts and all baseline implementations are not present in the pinned released fixtures.
- Target M1/GTX 1080 measurements are excluded at Steven’s request. M4 Max observations are not predictions for those devices.

## Release claims

A release may describe an implementation of the released SDF collision method with documented AVBD and mesh-quality extensions. It must not claim complete reproduction of every paper experiment, paper-equivalent performance, guaranteed penetration-free contact, or that the benchmark default reservation is always sufficient. The existing small-cache curvature/penetration and late-settling limitations remain relevant.
