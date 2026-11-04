<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: fcabb1b2ed26625f8729eb7db38d4ccb1f182e9aca4bc17145215808daf240ff. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006/3007: real-time execution policy checkpoints

Approved 2026-10-25. Baseline main `cd3ce90`; prior research remains intact.
The fixed-budget production path is the control. These experiments may change search
trajectories; they are not exact-layout optimizations or a reproduction of paper GPU timing.
No default/API change, commit, merge or release follows from a timing screen alone.

## Checkpoints and acceptance fixed before measurements

1. **Cached-candidate refresh.** An offline shader variant refreshes eligible cached
   candidates at their advected locations instead of re-running their optimizer. Fresh
   candidates retain the original every-substep discovery policy, sample budget, RNG and
   ordered repulsion, including the original full-cache convex-pair skip; full optimization
   occurs every fourth substep. Only NM is eligible.
   Unknown, mixed-sign, degenerate-gradient, warped-field and changed activation cases
   fall back. Motion and projected-anchor drift must be at most `min(tolerance/4,margin/8)`;
   normals must remain within cosine .995 and separation change within the same distance.
   Pair identity/history checks and the existing supplementary support paths remain.
   These local guards are a heuristic, NOT a no-missed-contact proof: a different minimum
   could emerge elsewhere even when a cached point remains valid. This is an opt-in
   experimental algorithm until physical qualification passes.
2. **Field-contract acceleration.** Evaluate conservative bounds only for supported field
   representations with an explicit defensible contract. Arbitrary public fields retain
   full search. Do not revive the rejected zero-coverage natural-range certificate or
   substitute source-mesh bounds for represented-field/projection bounds.
3. **Adaptive discovery.** Only after a useful refresh result, test a separately declared
   discovery schedule with forced discovery for new/invalidated pairs. Keep the fixed
   16+4/every-substep control. Never relabel changed budgets/cadence as identical work.
4. **Remaining execution.** Optimize the measured residual cost; include all classification,
   refresh and dispatch costs, memory, numerical differences and small-scene effects.
5. **Physical/browser qualification.** Full gate, matched settling, impacts, lifecycle,
   independent normals, warm starts and sustained browser criteria remain required.

For checkpoint 1: compile/fallback/history tests precede small released chair/bunny runs.
Use the existing 360-frame/11-seed protocol and existing physical limits for promotion;
no new failing seed, increased >=5mm probe count or median peak penetration is accepted.
Check each baseline-passing seed still passes; aggregate failure counts alone are insufficient.
Retain the known baseline bunny seed-3 energy failure. Early failing cases reject the
candidate before large ensembles. No fixture or tolerance changes.

Performance screens use one GPU process at a time, low CPU priority, watchdogs and idle
gaps. Three alternating paired trials, >=10% dense collision median gain, no >5% meaningful
small-scene regression, and whole-frame gains are required to promote. Brief screens are
feasibility only. Report physics separately from rendered FPS; substeps/solver iterations,
assets, mass/inertia, seeds and quality profile must match within every comparison.
Intermediate full-pile target remains <33ms; <16ms physics is the ambition, and the existing
practical-browser gate is <=6ms physics / <=14ms total GPU envelope at full simulation speed.

Verification: focused CPU/GPU tests, `pnpm typecheck`, then sequential `pnpm check` using
the existing single-worker wrapper. GPU execution is parent-owned; reviews are CPU-only.

## Progress

- Plan recorded before candidate runs. Checkpoints 1–5 pending.
- Broad cached refresh rejected at the first seed-0 physical screen: chairs reduce total
  queries 23,610,333 -> 19,975,872 (15.4%) but peak penetration rises 2.97 -> 10.57mm
  and >=5mm probes 0 -> 5. Bunny queries reduce 59,060,234 -> 53,017,984 (10.2%),
  with no >=5mm probes in that seed; it does not override the chair rejection.
  These are work reductions, not timing gains. Raw filenames `sdf-temporal-*-360.json`.
- Next isolated variant, specified before runs: allow refresh only when **every** prior
  candidate of a pair is inactive, including supplementary candidates; require the old
  separation of every previous point to exceed margin + 4*tolerance. Previously active
  pairs retain all optimizations. A pair newly becoming active can have refreshed earlier
  cached candidates; fresh search and per-point activation checks do not prove full recall.
  This addresses the active-support change while targeting the measured inactive-pair
  work. It remains a heuristic with the same quality gate and full-search fallback;
  arbitrary inactive points are not a separation certificate. No production enablement.
- Inactive-pair refresh also fails the first physical/performance screen: seed-0 chair
  peak 2.97 -> 6.68mm, >=5mm probes 0 -> 2. Dense 16+4, 4,314-body, 60-frame screen
  collision means 109.35 -> 104.71ms (4.2% gain), total physics 116.20 -> 110.54ms.
  Four timed frames per run are insufficient for promotion; no further ensemble is
  justified by these results. Checkpoint 1 has no accepted candidate; adaptive discovery
  remains gated on that prerequisite. Production stays unchanged.
- Next checkpoint-2 representation screen, declared before execution: store voxel words
  in an immutable `rgba32uint` 3D texture and use integer `textureLoad`, retaining the
  original eight-corner sum, exterior extension, gradients, optimizer/RNG and budgets.
  This is an exact-load storage experiment, not a separation certificate. Unsupported
  dimensions/allocation limits and analytic fields keep the existing buffer evaluator.
  Test exact live-result parity first on tiny cases, then nine original frozen states;
  stop on any mismatch. If parity passes, require the existing three paired dense trials
  and >=10% gain before live integration. Include texture allocation/reset/setup evidence;
  no filtered/half-precision values or changes to public fields. Per-field shader branches
  are immutable for each offline capture; runtime refresh integration remains unimplemented.
- The per-field branchful texture view fails tiny exact-output parity: contact normal.x
  differs by one float32 bit (`0xae31e44e` -> `0xae31e44f`). Rejected before timing.
  A second variant preserves the entire original linear atlas in an integer texture and
  uses only integer quotient/remainder address mapping, with no field-selection branch.
  It passes the same tiny exact-output test across NM/ellipsoid/SGD and direct/transformed
  seeds. This variant is **all-or-reject** at device dimensions / 64 MiB texture budget;
  it is not the per-field fallback design above. No runtime enablement. Nine frozen-state
  exact parity and the unchanged performance gate still apply. Schema-1 serial replay
  excludes the cooperative mesh-support dispatch; a passing replay cannot qualify that
  path for live integration.
- Linear texture storage also fails the first original 128-body/5-point impact capture:
  pair 177, point 4, normal.x `0x3ef7db97` -> `0x3ef7db96` (one ULP). Reject before
  performance measurements. No evidence here proves a physical regression from that one
  bit, or identifies a compiler cause; it fails the predeclared exact-layout contract.
  Neither texture variant changes production. Remaining eight states and timing trials
  were deliberately not run after the first real-state mismatch.

## Current checkpoint status

| Checkpoint | Evidence / status |
| --- | --- |
| 1. Cached refresh | Two cache-only candidates and a combined refresh/probe policy rejected. No qualified speedup. |
| 2. Field contract/storage | Arbitrary-field rejection remains uncertified. Two exact-texture variants fail end-to-end parity; no promotion. |
| 3. Adaptive discovery | Combined refresh/probe feasibility screen rejected on chair settling. No accepted prerequisite or production integration. |
| 4. Remaining execution | No accepted preceding candidate to profile/integrate; baseline unchanged. |
| 5. Qualification | Regression gate only. No candidate settling ensemble or sustained browser acceptance. |

The experiments above are feasibility decisions, not completion of the five-checkpoint
performance objective. Retain the existing small-demo release and fixed-budget reference.
Do not loosen exact-layout tests or physical limits to promote the rejected variants.
The next design needs either a certificate that covers meaningful inactive-pair work,
or a distinct, explicitly specified algorithmic policy that passes the existing physical
criteria. Repeating scalar/layout changes without a demonstrated mechanism is insufficient.

Results and provenance: [measurement record](measurements/sdf-realtime-policy-2026-10-25.json).
Integer `textureLoad` follows the [WGSL texture-load contract](https://www.w3.org/TR/WGSL/#textureload);
that contract alone does not guarantee whole-shader float32 bit parity after recompilation.

Verification of the research tooling and unchanged production baseline: low-priority
sequential `pnpm check` passes typecheck, 253 CPU tests, 202 real-GPU tests and both builds,
with zero failures/skips. Independent read-only code/evidence review found no blocking
issues; the record includes available texture failure trace provenance and explicitly
notes unavailable source-at-failure manifests. No PR exists and no review was posted.
No commit, push, merge or release was performed.
