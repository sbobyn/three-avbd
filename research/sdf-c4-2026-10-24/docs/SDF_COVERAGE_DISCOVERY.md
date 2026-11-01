<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 4c2c9b6f746d51424368579fa3d93b7cc27d52da1ad869443ab7392c0f323c4f. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — coverage-first discovery redesign

Predeclared 2026-10-25, baseline main `cd3ce90`. CPU-only construction/audit first.
No production contact rejection, new backend or public API is enabled.

## Contract and architecture

Replace the failed finite-probe premise with an explicit spatial cover. For a voxel field's
**real-arithmetic trilinear scalar interpolant**, retain every cell with a nonpositive corner.
Trilinear weights are nonnegative and sum to one, so any point where phi <= 0 lies in a
retained cell. This covers interiors too: containment, disconnected components and cavities
must not depend on a surface vertex happening to fall inside another object. Require all
boundary vertices strictly positive; otherwise the exterior extension is not certified and
the field is unsupported. Gradients do not enter this scalar-solid cover.

Build a compressed binary hierarchy of these integer cell boxes. A node is discarded only
when its occupied-cell count is zero. Fully occupied rectangles may be leaves; otherwise
split an integer axis. Parent/child unions cover every original retained cell. Construction
snapshots the membership; mutable source grids cannot stale the cover. Prefix sums and node
storage have explicit allocation limits.

Query two transformed covers with a bounded dual-tree traversal. Enclose the inverse of the
actual real-valued `localPoint` affine map (including non-unit quaternion defects), using
outward binary64 interval arithmetic. Do not silently normalize quaternions or assume the
conjugate map is an exact inverse. Drop a node pair only if its enclosing world boxes are
farther apart than the requested world-space margin. Split one node into both children.
Keep intersecting leaf pairs and **all pending pairs at budget exhaustion** as a frontier.
An empty frontier establishes separation for this scalar-solid cover; a nonempty frontier
is work still requiring discovery. It does not establish contact at one sampled center.

This is an independent geometry/coverage oracle, **not a certificate for the current shader**.
The paper's `gradient * phi / |gradient|^2` projection can produce active contacts even
between separated scalar solids; independent stored gradients are legal public input.
Finite WGSL interpolation/transforms also have a different numerical contract. The old
projection counterexample remains a required test. A geometric clear result must never
be uploaded as a production skip mask. No claim of identical paper contact recall follows.

The next algorithmic boundary, if useful, is an explicitly opt-in covered-region discovery
path, with original active-contact/warm-start handling retained and fallback for unsupported
or unfinished regions. It needs a scalar-surface contact definition, a conservative GPU
arithmetic bound and contact reduction with stable identities before any live substitution.
The existing fixed-budget paper path remains the control. This audit does not authorize that
substitution or remove the unchanged settling/performance gates.

## Predeclared acceptance and measurement

1. CPU tests: exact occupied-cell inclusion, odd dimensions, thin/disconnected/cavity cases,
   containment, transformed/near-boundary cases, mutation isolation, malformed/budget inputs,
   and frontier coverage against exhaustive cell-pair enumeration on small fields.
2. All nine original frozen captures. A bounded first 1,024-slot screen uses 127 node visits;
   if promising, cover all slots in sequential <=60-second processes. Record original query
   work, tested voxel pairs, clear geometry pairs, unresolved frontier size, node/bounds work,
   fields unsupported, field bytes/build time, and **every disagreement with active projected
   output**, separated by active-history status. Do not use output contacts to choose work.
3. Geometry-usefulness screen: >=25% of dense original query work geometrically clear with
   <=64 MiB shared packed hierarchy storage. This is a headroom screen for a new discovery
   contract, not a timing gain or production acceptance. Disagreements forbid treating this
   as a transparent accelerator regardless of coverage. Budget exhaustion always retains work.
4. Only a reviewed GPU safety/contact contract and unchanged chair/bunny physical gates permit
   GPU experiments. Target remains practical 60 FPS; >10% measured dense improvement across
   three paired trials is only an intermediate gate, not fulfillment of that target.

Verification: low-priority sequential `pnpm check`; no simultaneous browser/GPU workload.
[WGSL arithmetic rules](https://www.w3.org/TR/2026/CRD-WGSL-20261021/#floating-point-accuracy)
remain a separate obligation from the binary64 geometry model below.

## Complete frozen-state screen

All nine captures and their complete pair-slot ranges were audited in 33 sequential CPU
processes, each capped at 8,192 slots / 60 seconds and nice 15. Sources and input sections
were hashed; inputs stayed unchanged. The final report contains all windows, capture
manifests, source hashes and per-capture unique-field storage accounting:
[measurement record](measurements/sdf-coverage-discovery-2026-10-25.json).

| Capture | Phase | Query-bearing pairs | Original queries on geometrically clear pairs |
|---|---|---:|---:|
| 128 bunnies, 4+1 | impact | 988 | 32.50% |
| 128 bunnies, 4+1 | dense motion | 961 | 19.23% |
| 128 bunnies, 4+1 | late state | 891 | 14.00% |
| 128 bunnies, 16+4 | impact | 998 | 47.02% |
| 128 bunnies, 16+4 | dense motion | 970 | 31.06% |
| 128 bunnies, 16+4 | late state | 917 | 24.71% |
| 4,314 bunnies, 16+4 | impact | 36,891 | 71.01% |
| 4,314 bunnies, 16+4 | dense motion | 41,144 | 63.20% |
| 4,314 bunnies, 16+4 | late state | 41,615 | 50.72% |

The denominator includes unsupported query-bearing pairs (including analytic ground), not
only successfully tested voxel pairs. Over 125,375 pair observations / 61,505,833 original
queries, there are **zero captured active projected-contact disagreements**, with or without
active history. Every clear pair in these captures also lacks matching active history.
These are snapshots of bunny scenes, not chair settling, a temporal ensemble, or a universal
absence proof. The synthetic independent-gradient regression still demonstrates a real
semantic disagreement between scalar-solid separation and legacy projected contact creation.

The shared bunny hierarchy has 25,421 nodes / **813,472 bytes (0.776 MiB)**, covering 210,696
of 934,920 cells. The peak additional typed-array construction storage is 5,718,328 bytes
(5.45 MiB); both figures exclude the original field/capture and JS overhead. Storage is
deduplicated by field header over each full capture, not by its largest window. All captures
pass the 64 MiB shared-storage screen. The full-pile dense usefulness screen passes 25%.

Work remains significant: dense motion visits 2,626,749 node pairs, evaluates 1,639,738 bounds,
and retains 99,720 unresolved regions, at most 60 for one pair. All 12,662 unfinished tested
pairs reach the 127-visit budget; their complete frontier is retained. Late state retains
144,873 regions across 17,674 budget-exhausted pairs, at most 63 per pair. These regions
cannot be collapsed to one center probe without losing the new coverage property.

**Decision:** accept this as the CPU coverage foundation for further discovery research.
Do not promote it to production rejection. The original query percentages describe potential
work to avoid under a new contact contract; they are not elapsed-time savings. No new GPU
kernel, frame-time gain, settling result, or 60 FPS qualification follows from this screen.
Even dense motion still retains pairs responsible for 36.80% of original queries, plus the
new traversal cost. Remaining-region search execution is part of the real-time problem.

## Next implementation checkpoints

1. **Covered-region contact oracle.** Define an opt-in scalar-surface witness/contact rule
   and run bounded refinement/search on the complete frontier. Include containment, thin
   opposing features, cavities, disconnected components and independent-gradient inputs.
   Budget exhaustion must return unresolved work explicitly and retain original search as
   fallback. Never treat one successful witness as coverage of all remaining regions.
2. **History/solver adapter.** Keep original active-contact refresh and warm-start records
   intact. Match pair identity, body/field generation and contact identity; preserve separate
   field normals, anchors and tangential impulse transport. Do not replace existing IDs with
   traversal order. Field/body changes invalidate the relevant coverage snapshot. Unsupported
   inputs and any unproven case retain the original path. A scalar-solid mode cannot be
   marketed as a bit-identical acceleration of arbitrary legacy projected-gradient fields.
3. **Numerically conservative GPU traversal.** Derive outward bounds for its exact finite
   f32 source operations and supported transform range, including subnormal/overflow handling.
   Invalid bounds, traversal/queue capacity and all ambiguous cases must retain work. Match
   CPU coverage on adversarial cases and all nine captures before measuring the bounded GPU
   kernel. The binary64 oracle alone is not that proof.
4. **Unchanged physical/performance qualification.** Seed-0 chair/bunny screens first; reject
   immediately on existing penetration/energy regression. Then all established matched
   ensembles and warm-start/contact-normal tests, followed by three paired dense timing trials.
   Require >10% measured dense improvement as an intermediate decision; practical 60 FPS
   still requires whole-frame/browser evidence, with <33 ms then <16 ms physics targets.
   No budget reduction, relaxed fixture, or hidden fallback cost is allowed to supply the gain.

Reproduction (from the repository root, with preserved capture parent supplied explicitly):

```sh
python3 scripts/sdf-coverage-screen.py CAPTURE_ROOT NEW_RAW_DIRECTORY NEW_REPORT_JSON
PATH="SEQUENTIAL_NODE_WRAPPER_DIRECTORY:$PATH" nice -n 15 pnpm check
```

The local sequential node wrapper adds `--test-concurrency=1` to test invocations. It does not
skip tests or modify their assertions. No commit, push, merge, public API or production
`src/` change belongs to this checkpoint.

Final verification: sequential low-priority `pnpm check` passes **267 CPU + 206 real-GPU
tests**, zero failures/skips, typecheck and both builds. Independent read-only code/evidence
review has no remaining actionable findings. Review fixes cover sparse runtime inputs,
unsupported-boundary labeling, exhaustive disagreement records, source dependency hashes,
and unique-field storage across all windows. These checks validate the research tooling and
unchanged production behavior; they do not qualify a new GPU discovery path. STE-3006 remains
In Progress and STE-3007 remains gated.
