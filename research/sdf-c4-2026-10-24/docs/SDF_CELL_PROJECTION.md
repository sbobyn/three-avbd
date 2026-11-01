<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 034a0679244f75f623dc9cd0254299284a4d5d4647b0635a48f4945f2f35ec69. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — per-cell projected-image feasibility

Follow-on: [exact reuse and numerical safety](SDF_CELL_REUSE_SAFETY.md) preserves this
historical screen and adds concrete float32 counterexamples. Its CPU-only cache/tiling
changes must not be confused with a safe shader certificate. Hashes below identify this
earlier measured revision, not subsequent source edits.

This checkpoint is an **offline CPU real-arithmetic model**, not a portable WGSL certificate.
No production search mask, contact update, normal, feature ID, quality budget or warm-start
state is changed. A candidate never authorizes rejection in the running solver.

## Predeclared screen

Before the full audit: seek at least 10% of dense-state original query work, zero captured
active-contact contradictions and less than 64 MiB of additional shared field storage.
Run all nine frozen captures; test 31 and 127 subdivision nodes for the three large reference
states. GPU implementation requires a separate floating-point safety argument and evidence
that the certificate's runtime cost leaves useful headroom. Coverage alone is not a speedup.
The existing >=10% measured GPU gain and unchanged settling/history requirements still apply.

## Construction

In each trilinear cell, bound the image of
`P(x) = x - phi(x) g(x) / max(dot(g(x), g(x)), 1e-8)`.
Phi and the stored gradient are independent channels; no signed-distance or unit-gradient
property is assumed. Eight corner extrema bound each channel; four parallel edge differences
bound each partial derivative. Evaluate a center enclosure and bound the Jacobian over the
cell, then intersect its mean-value enclosure with the natural interval enclosure.

For a denominator above the floor, the Jacobian is
`I - (g grad(phi)^T + phi Dg)/N + phi g grad(N)^T/N^2`, where
`grad(N) = 2 Dg^T g`. Below the floor, N is constant. If its range crosses the floor, retain
the natural enclosure instead. The known `N^2 >= 1e-16` lower bound prevents arithmetic
padding from turning the squared denominator negative. Plane fixtures verify cancellation:
when phi=x and g=(1,0,0), projected x is tightly bounded around zero instead of spanning a cell.

Store phi ranges, projected-image bounds and gradient ranges per cell, with outward float32
storage padding, then aggregate a spatial hierarchy. Each range query uses at most 64
hierarchy entries; coarse blocks may include additional cells, which widens the answer.
Bodies share the field hierarchy. Construction snapshots input data and never mutates it.
The 64-entry bound is per interior/clamped region, not per whole query: splitting at grid
faces can produce up to 27 regions.

An interior-only version identified no eligible large-pile pairs: every search domain extended
outside at least one grid. The retained model splits local boxes at grid faces and encloses
all interior/exterior regions. Outside it follows the shader's distance extension and normalized
`g + outside/distance` direction, including the zero-vector fallback. When a region touches
`distance=0`, union in the unnormalized-gradient projection branch too. No region is silently
clamped out of consideration.

World bounds include position, uniform scale and COM. Conjugate quaternion rotation is the
transpose, which is not exactly the inverse for non-unit quaternions. Bound both the resulting
position defect and gradient-denominator change using matrix orthogonality defects; reject
transforms outside the supported defect envelope. Sampled tests include slightly non-unit
quaternions rather than silently normalizing captured state.

The optional body-axis test evaluates support intervals on each body's three axes using
the original local projected-image box. This retains orientation lost when converting both
images to world AABBs. The existing transform-error allowance is projected onto each axis;
axes need not be unit length. These six scalar tests require no additional field reads,
although they add arithmetic and can change the subsequent subdivision traversal.

## Pair and safety policy

Use the captured search domain and subdivide its longest axis. At least one field must have
a strictly positive lower bound before the unsigned projected-gap branch can be used;
both-inside, signed separation and supplemental mesh contacts fail open. Matching active
history vetoes rejection even if warm starts are disabled; stale identities do not refer to
a new pair. Invalid, unresolved and unsupported cases keep search. Captured output contacts
are used only to detect contradictions, never to choose candidates.

The double-arithmetic padding, interpolation/endpoint rounding, normalization and optimizer
domain drift are not a formal GPU error bound. Real-arithmetic and sampled tests cannot
prove no missed GPU contacts. Runtime refresh, slot recycling, growth and inactive history/ID
retention are not implemented because this is an immutable snapshot study. Any promotion
requires those contracts and independent review before GPU experiments.

## Reproduce

```sh
nice -n 15 node --experimental-transform-types scripts/sdf-cell-projection-audit.ts \
  CAPTURE_DIR NEW_OUTPUT.json 31 100000 body
```

Use 127 for the larger node budget; use `world` instead of `body` for world-axis-only bounds.
Captures must validate through the existing reader;
outputs are exclusive new files. Run one CPU audit at a time with an external 60-second
process timeout. No GPU backend is imported. Actual measured source hashes are checked
before and after the batch; captures retain their own shader and buffer hashes.

## Measured screen and decision

Each variant ran all nine frozen states sequentially, plus the three large states at the
127-node budget. All six 128-body mesh-quality states fail open because they use signed
separation. Their zero coverage is intentional, not a result for the current cooperative
mesh-witness production path. The table below is the 4,314-body reference-profile capture.
Percentages weight candidate pairs by their **original recorded search queries**; they are
not percentages of GPU time saved.

| State | Nodes/pair cap | World-axis query coverage | With body axes | Body-axis candidates | Body-axis hierarchy entries read |
|---|---:|---:|---:|---:|---:|
| Impact | 31 | 3.17% | 9.44% | 4,437 | 109,913,940 |
| Impact | 127 | 9.03% | 18.86% | 8,455 | 299,315,550 |
| Dense motion | 31 | 2.95% | 7.29% | 3,737 | 118,111,472 |
| Dense motion | 127 | 7.54% | 14.45% | 7,126 | 313,509,253 |
| Late state | 31 | 1.77% | 4.25% | 2,251 | 120,469,090 |
| Late state | 127 | 4.44% | 8.40% | 4,325 | 309,973,414 |

There are zero captured active-contact contradictions in both variants. Matching active
history vetoes 1,189 / 4,145 / 5,654 pairs in impact / dense / late states respectively.
The shared hierarchy occupies **59,959,984 bytes (57.18 MiB)** for 934,920 cells;
913,354 cells use the centered bound. This is additional storage beyond the existing atlas.
Construction takes about 2.35–2.42 CPU seconds in these runs. The full body-axis audits take
14.78–15.71 seconds at 31 nodes and 43.44–46.67 seconds at 127 nodes, including construction.
These are low-priority offline JavaScript timings on this machine, not GPU predictions.

**The 127-node body-axis model passes the predeclared coverage/storage screen. It does not
pass a GPU-promotion or performance screen.** At dense motion it identifies 2,939,186 of
20,334,211 original queries, but reads 313,509,253 hierarchy entries: about 107 entries per
candidate query avoided. Each entry contains 14 floats. Cache reuse and instruction costs
are unmeasured, so these counts establish neither DRAM traffic nor runtime benefit. The
31-node variant is cheaper but misses the 10% dense coverage threshold. Do not port this
traversal directly to the production GPU path on coverage alone.

Next checkpoint: reduce or amortize hierarchy-query work (for example, reuse clamped-region
ranges across subdivisions or traverse paired field blocks), then repeat these same frozen
screens with explicit cost accounting. Separately derive a portable float32 enclosure for
field interpolation, outside normalization, pose transforms and the actual optimizer domain.
Only a candidate with both a safety argument and plausible net cost should advance to bounded
GPU A/B tests, exact contact/history checks and matched settling. Practical 60 FPS remains open.

Raw evidence: [world-axis batch](measurements/sdf-cell-projection-2026-10-24.json) and
[body-axis batch](measurements/sdf-cell-oriented-2026-10-24.json). Each file records the actual
source hashes checked before/after its own run and original capture provenance. The world-axis
batch predates the optional support-axis implementation; its historical source hashes are
retained rather than relabeled as the final source. Independent review checked that the final
world-axis decision path is unchanged.

## Verification

The 12 focused CPU tests pass, covering nonlinear cells, denominator-floor branches,
outside faces/edges/corners, transform defects, axis support, history vetoes, stale identity,
input immutability and audit accounting. Independent code review found no actionable issues;
its additional sampled world/support enclosures had no observed violations. Sampling is not
a portable arithmetic proof. Final `pnpm check` passes: **213 CPU + 193 real-GPU tests**,
zero failures/skips, typecheck and both builds. GPU test files ran sequentially at reduced
process priority with demo simulations paused; no candidate GPU kernel or timing experiment
ran. The existing Vite chunk-size advisory remains. Production `src/` is byte-identical to
base `cd3ce90`; no changed-trajectory settling ensemble is warranted for this offline model.
Independent final data/document review verified every table value, pair-reason accounting,
capture provenance and all five final source hashes. Work remains local and uncommitted.
