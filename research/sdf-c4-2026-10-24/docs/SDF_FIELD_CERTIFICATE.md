<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status VERBATIM-FINAL. Rebuilt on 2026-10-31 from agent session transcripts (read 2026-10-25T00:11:46.350Z, last known write 2026-10-24T23:59:42Z). SHA-256 of the recovered body below this header: d76fede57019883c34630bd77138a9807aa38ad68b54cab997f5b9367ad97c8d. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — field certificate feasibility

## Decision

**Reject this whole-domain interval prototype for GPU promotion.** It identifies too little
work to justify its hierarchy and per-pair checks. No production solver, contact search,
quality budget, normals, feature IDs or warm-start data changed. The <33 ms intermediate
and practical 60 FPS goals for the full pile remain unmet.

The CPU experiment bounds the actual stored phi and gradient values, rather than trusting
mesh bounds or an asset hash. It is a feasibility screen, **not a portable floating-point
certificate**: error padding, interpolation endpoint rounding and optimizer-domain drift
are not proven against all permitted WGSL evaluation behavior. Positive results are called
*candidates*. They must never authorize production rejection. We stopped at this feasibility
stage because its coverage already fails the usefulness screen; no GPU fast path was built.

## What was measured

Starting from merged main `cd3ce901557aa9cf4f7ede489fac385971d383ea`, audit all nine preserved
frozen serial captures through the validated replay reader. This examines the actual prepared
body transforms, atlas, domain, prior history, output contacts and recorded query counters.
The six 128-body mesh-quality states use signed separation, so this prototype deliberately
keeps their original searches (zero candidates). Mesh-witness extensions are also unsupported.

The 4,314-body reference states use unsigned separation. Check all pairs with recorded query
work; conservatively veto matching active history even when warm-starting is disabled. Static
analytic ground pairs fall back because the prototype implements voxel fields only.

| Phase | Query-bearing pairs | Tested voxel pairs | Candidates, 31 nodes | Candidate query work, 31 nodes | Candidates, 127 nodes | Candidate query work, 127 nodes |
|---|---:|---:|---:|---:|---:|---:|
| Impact | 36,891 | 35,073 | 1 | 0.00131% | 4 | 0.00603% |
| Dense motion | 41,144 | 36,961 | 5 | 0.00676% | 18 | 0.02427% |
| Late state | 41,615 | 35,784 | 2 | 0.00236% | 8 | 0.00983% |

Every candidate has zero active contacts in the corresponding captured output. That is an
empirical contradiction check, not proof of no missed contacts over arbitrary points or
future trajectories. Work percentages use the original query counts, not elapsed GPU time.
Do not interpret them as a measured speedup or a formal GPU speedup bound.

The immutable min/max hierarchy for the one shared bunny field uses **35,381,792 bytes
(33.74 MiB)** beyond the existing atlas. Building it takes 55–74 ms in these CPU trials.
Full audits take 2.57–2.60 seconds at 31 nodes and 11.19–11.97 seconds at 127 nodes. At the
larger budget each phase inspects about 130–139 million hierarchy entries. These are offline
JavaScript CPU measurements on M4 Max, not estimates of GPU or per-frame performance.
Processes ran sequentially at low priority; each was capped externally at 60 seconds.

[Raw measurements, capture hashes and source provenance](measurements/sdf-field-certificate-2026-10-24.json).
No binaries or machine-specific paths are stored in the report.

## Bound and safeguards

1. Snapshot min/max phi and each independent gradient component in a voxel hierarchy.
2. Transform a world-domain interval into each body's local coordinates; bound trilinear
   samples, outside-grid extension, world gradients and phi scaling.
3. Bound the shader offset `gradient * phi / max(dot(gradient, gradient), 1e-8)` for each body.
   The common position cancels when subtracting offsets. At least one phi lower bound must
   be positive before the unsigned gap branch can certify a model candidate; both-inside
   falls back. Signed mode and supplemental mesh contacts always fall back.
4. Only accept a model candidate if every subdivision has projected-gap lower bound above
   the contact margin. Otherwise subdivide the longest axis within the 31/127-node cap.
   Unresolved, invalid and numerical-range cases keep original search.
5. Matching active history is an unconditional veto; stale pair identities do not veto a
   different pair. Audit reads are immutable. There is no cache write, ID allocation,
   normal reuse, mask upload or runtime hook.

Axis-aligned interval dependencies and independent gradient ranges expand strongly under
rotation and over many trilinear cells. Near-zero gradient bounds widen the projection
ratio further. Raising the node budget fourfold barely improves useful coverage. This
is evidence against this tested representation/budget, not against every possible field
certificate or against the SDF method itself.

## Next justified checkpoint

Do not port this hierarchy to WGSL or retry the earlier unsafe geometry-only rejection.
A different certificate representation would need a separate CPU screen: precompute tight
**per-cell projected-image/error bounds** with position/gradient correlation retained, then
ask whether they permit a cheap reusable field-level bound. Include negative-phi support,
outside-grid behavior, degenerate gradients and transforms in that proposal. Arbitrary public
fields must be allowed to fail eligibility; an empirical asset whitelist is insufficient.
That is a research hypothesis, not an accepted optimization or promised speedup.

Before committing another implementation, predeclare a useful coverage/cost threshold and
compare it with the remaining objective/search execution redesign. Any promoted rejection
still needs a floating-point safety argument, explicit inactive-history/ID lifecycle policy,
field refresh/recycling/growth behavior and unchanged contact-recall/settling acceptance.
Only a candidate passing that screen merits three alternating bounded GPU trials including
all helper passes and memory costs, followed by full-frame timing. The existing >=10% dense
improvement and no >5% meaningful small-workload regression requirements remain unchanged.

## Reproduce

```sh
nice -n 15 node --experimental-transform-types scripts/sdf-field-certificate-audit.ts \
  CAPTURE_DIR NEW_OUTPUT.json 31 100000
```

Arguments are capture, new output file, maximum subdivision nodes (1–127) and maximum tested
voxel pairs (1–100,000). Use 127 for the larger screen. The CLI never imports or opens a GPU
backend. Run captures sequentially; use an external 60-second timeout for bounded studies.
The report explicitly marks `modelOnly: true` and `productionEnabled: false`.

## Verification

Ten focused CPU tests cover positive projected separation, equal/zero gradients, both-inside,
transformed/scaled fields, outside-grid and cell-edge samples, the rotated geometric-bound
counterexample, active-history veto with warm-starting disabled, stale identity handling,
input immutability and contradiction detection. Sampled containment is regression coverage,
not a floating-point proof. Full sequential `pnpm check` passes **201 CPU + 193 real-GPU
tests**, zero failures/skips, typecheck and site/library builds. Demo simulations were paused;
GPU tests used one worker. No candidate GPU benchmark or changed-trajectory ensemble was
run because there is no production candidate.

Independent review found one provenance issue: hashes had been recorded after a small audit
guard change. All 12 CPU audits were repeated on the final source, with hashes checked before
and after the batch. All work, candidate, subdivision and range-read counts reproduced
exactly; the report now contains those final-source measurements. Independent GPT-6 Sol
re-review verified all 12 raw outputs and five source hashes with no remaining actionable
findings. The branch has no PR, so no review was posted. This work remains local/uncommitted.
