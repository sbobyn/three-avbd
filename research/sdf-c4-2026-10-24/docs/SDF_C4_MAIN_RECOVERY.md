<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status VERBATIM-FINAL. Rebuilt on 2026-10-31 from agent session transcripts (read 2026-10-25T17:07:19.908Z, last known write 2026-10-24T23:39:27.680Z). SHA-256 of the recovered body below this header: 5ed9193a8c0576fcf2378c779a2a5149a5aadf42d5ad9f29a6bc54cf653035a9. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006: recover the frozen baseline on merged main

Qualification #44 and the small-bunny performance fix #45 are merged. This diagnostic
checkpoint starts at `cd3ce901557aa9cf4f7ede489fac385971d383ea`. It does not change
production shaders, budgets, normals, point IDs or warm starts, and does not promote the
older experimental search/rejection code. The original research checkout is preserved.

## Recovered comparison

The schema-1 format, serial recorder/replay and format/ownership tests have been recovered
without the rejected candidate generators. Every run restores all input buffers, previous
contact/optimizer history, target bytes, seeds and RNG generation. Comparison checks every
live header and all 28 words of each live point; zero-dispatch runs compare the entire
unchanged target. Source changes require the exact captured shader SHA explicitly, and
both hashes remain in the report. This is permission to compare, never permission to accept
divergent output. Reader limits are 256 MiB per section and 768 MiB total before opening
binary files. Fixed-size reads reject files that grow; nonblocking opens reject FIFOs.

All nine preserved impact/dense-motion/late-state captures pass exact logical comparison
against current serial search: 128 bodies at 5 and 20 points, and 4,314 bodies at 20 points.
Each had one warmup and two measured restored dispatches, 200 ms idle between dispatches
and two seconds between processes. No browser simulation overlapped. This confirms the
old frozen data remains usable after merging current main; it is not a settling ensemble.

The large-scene search samples range from 24.25 to 44.96 ms **per isolated dispatch**.
Small samples also show substantial timing variation. These two-sample screens are not a
statistical performance comparison or a whole-frame/60 FPS claim. The prior dense-pile
performance gap remains. Raw reports and source/capture hashes are in
[the recovery record](measurements/sdf-c4-main-recovery-2026-10-24.json).

Schema 1 does not encode the new cooperative mesh-witness scratch/pass. The recorder
rejects that shader rather than mislabelling it as serial; use an explicit standalone
serial pass for small diagnostic fixtures. The 4,314-body transformed-seed production path
remains serial and is represented by these captures. Extending schema coverage must record
and time every new helper dispatch before it can compare a different production path.

## Rejection safety decision

A new CPU regression demonstrates why declared voxel bounds alone cannot authorize
conservative rejection for arbitrary public fields. Two rotated thin bounds have 0.3 units
of separating-axis clearance while their world AABBs overlap. Valid finite grids carrying
constant positive phi and equal gradients yield identical projected offsets and therefore
zero projected separation: the unchanged method emits active contacts. This intentionally
synthetic, inconsistent field is accepted by the public API; it is not a claim about the
released bunny geometry or a new regression in its physics.

Neither an arbitrary grid nor the presence of mesh vertices certifies that stored phi and
independently interpolated gradients represent projections onto that mesh. A field hash
whitelist is fixture provenance, not a generic proof. No blanket eligibility flag is added.

## Next acceptance checkpoint

1. Prototype a CPU interval certificate for **projected points**, not just geometry bounds.
   It must bound `p - phi * gradient / max(dot(gradient, gradient), 1e-8)` throughout the
   actual search region, including trilinear cells and outside-grid extension. Establish a
   separate sign bound for the both-inside branch and explicitly handle signed-separation
   mode. Uncertain/degenerate cases must use the original search.
2. Audit certificate eligibility/coverage against the nine frozen states and adversarial
   gradients, transforms, scales and margins before writing a GPU rejection fast path.
   Measure certificate construction/storage cost; reject this approach if useful coverage
   cannot be proved cheaply. Do not substitute empirical absence of contacts for proof.
3. If viable, define field/body refresh, slot recycling, growth and active-history veto,
   plus inactive history advection/ID retention. Skipping fresh search is an algorithmic
   change: require its own contact-recall and physical no-regression review.
4. Only then run three alternating paired trials with all helper costs. Require >=10%
   dense improvement and no >5% meaningful small-scene regression, then unchanged settling
   ensembles and unsplit full-frame p95. Intermediate <33 ms, ambition <16 ms remain unmet.

Prior failed compact/hot-state, deferred arithmetic, workgroup, seed-mask rank and split
search experiments must not be retried unchanged. The old basic seed mask showed only a
small diagnostic gain, insufficient to close the dense-pile gap. No optimization is enabled
by this recovery checkpoint.

## Reproduce

```sh
node --experimental-transform-types scripts/sdf-replay.ts CAPTURE_DIR OUT.json \
  --warmup 1 --samples 2 --pause-ms 200 --timeout-ms 90000 \
  --captured-shader EXACT_SHA256_FROM_MANIFEST
```

The output file must be new. Omitting `--captured-shader` requires the current shader hash
to match the manifest. Use one GPU executor. The CLI caps samples and has a watchdog;
CPU niceness is not a GPU utilization cap. After any timeout, confirm the process/device
has stopped before continuing. Full frozen binaries remain local, not in the repository.

## Verification

Final sequential `pnpm check` passes **191 CPU + 193 real-GPU tests**, zero failures/skips,
typecheck and both builds. Independent re-review is clean after fixing reader memory bounds,
empty-dispatch parity and nested-recorder ownership; a nonblocking-file-open edge was fixed
as well. The reviewer ran the 14 focused CPU tests and audited the nine recorded results;
GPU work was parent-owned. Production source is byte-identical to merged main. The recovery
work remains uncommitted on `codex/sdf-c4-replay-main`; no large-scene optimization is promoted.
