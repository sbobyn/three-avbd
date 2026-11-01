<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-WINDOW-VERIFIED. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: a86650dba3e4a4a2bb94843ebe705bee65d5a36f313630516fd541d2f8078825. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — retained-region contact proposals

Predeclared 2026-10-25, baseline `cd3ce90`. This CPU prototype consumes the complete
[coverage frontier](SDF_COVERAGE_DISCOVERY.md). It does not replace production discovery.

Latest checkpoint: [native-compatible hints and bounded solver integration](#native-compatible-hints-and-bounded-solver-integration).
The original scalar-root contract below remains unchanged. The experimental solver path
uses separately typed hints, not the scalar candidates as if they were native contacts.

## Contract

- Snapshot voxel values and construct a bounded spatial index of sign-changing lattice
  edges. Trilinear interpolation restricted to an edge is linear; its zero crossing is a
  useful surface witness. This does not imply that edge witnesses span every possible
  contact (face intersections, interior tangencies and containment still require care).
- Query those witnesses in both directions within retained regions, with explicit traversal,
  probe, candidate and surface-refinement budgets. Refine the opposing anchor using the
  scalar interpolant's analytic derivative, then verify opposite signs using outward binary64
  interpolation bounds at the ends of a short segment. Both anchors must have an enclosure
  within 1e-5 world units of a surface root (source edges also use outward root intervals).
  A small scalar residual alone is not a geometric error bound. Failed,
  degenerate or ambiguous projections produce no contact proposal and retain unresolved work.
- Keep stored field normals separate from the scalar derivative used for refinement.
  Degenerate or inconsistent normals remain unsupported. Each proposal has its own normal,
  both surface anchors and a canonical source-edge key; never use a shared pair normal or
  traversal/rank as the contact identity. This is a changed scalar-surface contact rule,
  not the legacy projected-gradient gap. No bit-identical legacy claim.
- **Every original retained region remains unresolved**, even if it produced a witness or
  all its indexed edges were visited. Candidate generation cannot certify absence elsewhere.
  Unsupported fields, queue/budget limits and the legacy semantic gap require original search.
- History handling is a pure proposal: match explicit pair/body/field generations, immutable
  field snapshots, canonical feature, anchor proximity and normal continuity. Return original
  ID/opaque solver warm state only for a valid match. Unmatched history is returned for the
  existing detector to refresh, never silently deleted. Changed scope invalidates old history;
  it must never transfer impulses between bodies/field revisions. Solver transport of impulses,
  sticking-anchor rules and active-contact refresh remain owned by the existing bridge.
  History must be created through `snapshotRegionHistory`: copied/frozen scope and candidate
  metadata prevent in-place caller updates from changing the previous frame's identity.
  All three normals must remain continuous; the opaque solver warm-state object is not copied.

## Gates and bounded evidence

1. CPU geometry cases: intersecting/separated/touching solids, near-margin witnesses,
   disconnected components, cavities, containment, transforms, ambiguous/zero normals,
   source mutation and invalid/budget input. Verify all emitted anchors against both fields,
   independent normals and that no success drops unresolved regions.
2. CPU identity/history cases: candidate reordering, movement, normal discontinuity,
   generation/body/field changes, capacity exhaustion and stale IDs. No input mutation and
   no automatic force/manifold replacement; unmatched state requires legacy refresh.
3. Frozen-state feasibility: first 32 retained voxel pairs found within the first 1,024
   query-bearing slots of each original capture; selection uses geometry only, not output
   contacts. Use 127 coverage visits, 512 feature-BVH visits, 128 surface probes, 32 candidates,
   12 projection iterations and 8,192 region-index tests, using each capture's margin. Sequential nice15 processes,
   60-second timeout each. Record every
   selected slot, proposal count, original active count, work and unresolved count. Do not infer
   contact recall, whole-pile runtime savings, GPU performance or settling from this sample.
4. Full low-priority sequential `pnpm check`, independent review. Before live substitution:
   reviewed contact/finite-f32 contract, full active-history adapter, unchanged seed-0 chair/bunny
   screens then ensembles and paired timings. Practical 60 FPS remains unqualified.

No source/default/API change, commit, push or merge is authorized by this checkpoint.

Initial CPU geometry tests caught budget starvation from repeated feature-tree queries per
region, then from linear region filtering. The revised design walks each source feature tree
once and indexes paired source/target region bounds. Construction nodes/comparisons, bound
transforms and query work are counted separately. These witness filters are heuristic; the
original conservative frontier is always retained. All ten geometry/history tests pass with
the same contact assertions and budgets. No capture measurements preceded this correction.

Independent review found a large-cell counterexample where the first scalar-residual rule
accepted coincident anchors about 500 world units from the opposing surface. The revised
sign bracket/world-error gate rejects that false contact and has regression coverage for
large cells and rescaled scalar values. This proves proximity to a root, not that the root
is nearest or belongs to the physically appropriate contact branch. Live settling remains
a required later gate.

The first nine-capture sample produced zero proposals. Breadth-first traversal can spend its
entire node budget expanding prefixes of a large edge tree; some visited leaves were outside
the opposing grid. Preserve this failed sample unchanged. Before repeating the same sample
and budgets, switch to a best-first heap ranked by an opposing-field sample at each node's
center (clamped to its grid plus exterior distance). This is only a witness scheduling
heuristic, never a conservative exclusion. Count priority field reads and heap comparisons;
keep original frontier retention and all existing geometry/history assertions. Add a 65³
synthetic surface test with only 64 node visits to cover the scale-related starvation case.

## Bounded frozen-state result

All nine sequential CPU samples completed within their 60-second limits. Same 32 selected
pairs per capture and budgets as the failed breadth-first sample; no active-output selection.

| Bodies / budget | State | Proposals | Pairs with proposals | Legacy active pairs | Legacy active pairs with no proposal |
|---|---|---:|---:|---:|---:|
| 128 / p5 | impact | 42 | 3 | 7 | 4 |
| 128 / p5 | dense motion | 198 | 9 | 10 | 1 |
| 128 / p5 | late state | 299 | 11 | 12 | 1 |
| 128 / p20 | impact | 44 | 4 | 6 | 2 |
| 128 / p20 | dense motion | 85 | 4 | 5 | 1 |
| 128 / p20 | late state | 332 | 12 | 12 | 0 |
| 4,314 / p20 | impact | 25 | 3 | 3 | 0 |
| 4,314 / p20 | dense motion | 5 | 1 | 3 | 2 |
| 4,314 / p20 | late state | 1 | 1 | 3 | 2 |

The revised traversal produces 1,031 proposals across 48/288 selected pairs, compared with
zero before. All 2,433 original retained regions remain unresolved. No selected field was
unsupported. The missing 13 legacy-active pairs all reach the 128-probe limit; their recorded
rejections include outside-grid witnesses, inconsistent normals, outside-contact anchors and
unresolved projection. These are unresolved observations, not proven geometric misses: the
old projected-gradient rule and new scalar-surface rule differ. There is no contact-recall,
manifold-quality or settling-equivalence claim.

Work across these samples: 14,816 feature visits, 268,869 region tests, 32,296 probes,
19,750 priority samples, 94,337 heap comparisons and 244,288 interval endpoint evaluations.
The CPU proof-oriented generator takes 1,064 ms total across 288 pairs, excluding repeated
field building and selection. This is not a GPU timing or a runtime saving. The index has
33,724 edges for the shared bunny field; JS object/storage overhead is not a measured heap
budget. The retained coverage and unchanged legacy search still own correctness.

[Initial failed screen](measurements/sdf-region-contacts-2026-10-25.json),
[directed screen with every selected row, candidate, rejection count and source hash](measurements/sdf-region-contacts-directed-2026-10-25.json).
The directed screen was repeated after a reporting-only correction clarifying that
unsupported pairs are counted, not listed per slot; proposal counts were identical.

## Next gates before any production substitution

1. Diagnose the 13 unmatched observations using actual scalar geometry and contact-support
   regions. Add deterministic adversarial cases for thin contacts, multiple nearby branches,
   local normal disagreement and limited-budget region scheduling. Do not simply raise the
   budget or relax anchor/normal gates to make these captures pass.
2. Establish spatially distributed contact selection and a stable feature-to-manifold adapter.
   Refresh the entire existing active history; preserve independent normals and transport
   warm impulses through the existing bridge. Root proximity does not prove useful manifold
   coverage, and a canonical lattice edge is not a complete contact-patch identity.
3. Only then implement bounded GPU queues and a reviewed finite-f32 version of the contact
   contract. Prove explicit fallback/overflow behavior, run unchanged chair/bunny seed-0
   settling screens then ensembles, and measure paired GPU timings and browser frame cadence.

This checkpoint implements a CPU candidate generator and immutable identity planning. It
does not complete STE-3006, qualify STE-3007 or demonstrate practical 60 FPS.

## Verification

Final `pnpm check`, nice15 with test concurrency one: **283 CPU + 206 real-GPU tests**, zero
failures/skips, typecheck and both builds pass. This includes the unchanged released chair
settling and bunny transient-penetration tests; the new prototype is not used by those tests.
No new GPU benchmark or simultaneous GPU workload was launched. `src/` is byte-identical
to baseline `cd3ce90`; no public API/default, commit, push or merge changed.

Independent read-only review resolved the scale error, incomplete independent-normal
validation, mutable history aliases and scope-key enumeration. Final code/evidence review
has no remaining actionable findings. It reconciled source hashes, all selected pairs,
budgets, numerical proposal bounds and reporting limitations. There is no open PR for this
working-tree checkpoint, so the review was not posted externally.

## Follow-up: unmatched-pair diagnosis and scheduling

Before changes, inspect the 13 unmatched pairs on CPU. Recorded legacy contact positions are
diagnostic evidence only, never seeds or selection inputs for the new generator. A bounded
edge scan of the first four impact pairs finds nearby witnesses with consistent scalar/stored
normals, while 83–99% of their source edges lie outside the opposing grid. The existing
projection cannot start outside that grid. Reject wholly out-of-grid feature nodes before
spending witness probes by transforming their bounds to the target's local frame. This is
still a heuristic witness filter; the original retained frontier is never discharged.

Keep all existing budgets, anchor/normal gates and frozen pair selection unchanged. Record
additional bound transforms, test a narrow contact region and compare the same nine captures.
Any remaining discrepancies require diagnosis rather than relaxed thresholds. Production
integration and new-path settling remain gated on distributed contact coverage/history.

The grid-feasibility screen reduces unmatched legacy-active pairs from 13 to 11, with all
budgets unchanged. A fine-grid synthetic case exposed an overly wide acceptance bracket for
the existing residual test; tighten its cell-relative width from cell/1024 to cell*1e-6,
retaining the 1e-5 world bound and all existing assertions. Preserve this intermediate screen.

Next scheduling change: queue individual edge witnesses alongside feature nodes, instead of
spending 16 probes in leaf storage order. Rank exact edge positions using the opposing scalar
sample; defer invalid source normals/out-of-grid starts without deleting them. Count these
additional priority reads separately (at most 16 per visited leaf), along with heap operations.
The probe/node/candidate limits, independent normals, identity keys and full retained frontier
stay unchanged. This trades cheap scheduling samples for fewer expensive surface projections;
measure both costs rather than calling it a speedup in advance.

The individual-witness screen produces 1,221 proposals in 51 pairs, leaving 10 of 61
legacy-active pairs without proposals. CPU generation rises from 1,277 ms (grid filter)
to 1,618 ms. Preserve both reports: this is a coverage gain with additional cost.

Before the next screen, allow up to three alternating source/target projections for an
outside witness whose anchor distance exceeds the margin. All projections share the same
12-Newton-step probe budget. Accept refinement only when distance decreases, both new
anchors have outward sign/root bounds, stored/analytic normals remain consistent, normals
remain continuous with the seed and source movement stays within a local cell-diagonal
trust radius. Keep the original edge key; proximity/normal history checks still apply.
Containment witnesses do not take this refinement path. This is a local proposal heuristic,
not a nearest-point or complete contact-patch proof.

Use a scalar residual hint only to schedule costly interval endpoint proofs near a root;
the hint cannot accept one. Record projections, iterations and refinement attempts as well
as all earlier work. Alternate traversal between each feature tree's two spatial halves;
this prevents one dense component from monopolizing the existing candidate cap in the
disconnected regression, but does not guarantee distributed manifold coverage in general.
The original offset-sphere refinement fixture produced no accepted refined proposals;
a closed sloped-wedge fixture now exercises an edge outside the margin moving to an
in-face witness within it. No contact threshold/assertion was relaxed. All 19 focused
geometry/history/audit tests pass. Repeat the same nine captures, selection and budgets.

## Follow-up result: bounded patch refinement

All nine sequential nice15 CPU samples completed within the same 60-second per-process
limit. Selected slots match the original directed screen exactly; budgets and contact
margins are unchanged. Source hashes match before/after the screen.

| Bodies / budget | State | Proposals | Pairs with proposals | Legacy active pairs without proposal |
|---|---|---:|---:|---:|
| 128 / p5 | impact | 99 | 5 | 2 |
| 128 / p5 | dense motion | 256 | 9 | 1 |
| 128 / p5 | late state | 315 | 12 | 0 |
| 128 / p20 | impact | 40 | 5 | 1 |
| 128 / p20 | dense motion | 95 | 4 | 1 |
| 128 / p20 | late state | 384 | 12 | 0 |
| 4,314 / p20 | impact | 64 | 3 | 0 |
| 4,314 / p20 | dense motion | 13 | 2 | 1 |
| 4,314 / p20 | late state | 2 | 2 | 1 |

Total: **1,268 proposals in 54/288 selected pairs**, including 40 refined proposals. Of 61
legacy-active pairs, **7 still lack proposals**, down from 13 in the directed screen. All
2,433 original regions remain unresolved. No previously proposal-bearing pair loses all
its proposals. This is pair-level feasibility under different contact semantics, not
contact recall or manifold/settling equivalence.

Work versus the original directed screen: interval endpoint evaluations fall from 244,288
to 21,042; field samples rise from 198,986 to 376,431, and Newton steps rise from 109,542 to
202,698. The revised traversal uses 21,011 feature visits, 221,657 region tests, 21,263
probes and 472,026 heap comparisons. All rows respect the shared 12-step/probe budget,
at most seven projection calls and three refinement attempts per probe. The additional
target-grid transforms and individual edge-priority reads are included in the full report.
All proposal IDs are unique within their pair; both anchors pass the 1e-5 world root bound
(largest recorded bound 2.78e-8). Refined source anchors have independent sign brackets.

CPU generation totals **877 ms**, versus 1,064 ms in the original directed screen and
1,618 ms in the intermediate individual-edge screen. These are single-run feasibility
timings over the selected sample, not a paired benchmark, GPU speedup or frame-time result.
No new GPU search implementation or live-history adapter is included.

The seven remaining observations are p5 impact slots 53/56, p5 dense slot 60, p20 impact
slot 40, p20 dense slot 67, 4,314 dense slot 321 and 4,314 late slot 147. All reach the
128-probe cap; rejected roots, normals or over-margin distances remain explicit failures.
Only the first four original impact observations and two original dense observations
have detailed geometric diagnostics so far. Do not treat the other observations as
diagnosed, or relax the margin to remove them. Next: diagnose these retained contact
regions, establish distributed manifold/history integration, then finite-f32/GPU and
unchanged settling/timing qualification. STE-3006 remains in progress; STE-3007 is gated.

Preserved intermediate evidence:
[grid filter](measurements/sdf-region-contacts-grid-2026-10-25.json),
[individual edge priority](measurements/sdf-region-contacts-witness-2026-10-25.json),
[refinement and full work accounting](measurements/sdf-region-contacts-refined-2026-10-25.json).

Independent read-only review of the refinement, fair queues, proof metadata, identity
validation and source-consistent evidence found no actionable issues. Coverage gaps remain:
no complete surface-patch coverage proof, no live warm-start/settling equivalence, and no
production speed claim. These are required gates before substituting the existing detector.

Follow-up full gate: nice15, one test process at a time, `pnpm check` passes **286 CPU +
206 real-GPU tests**, zero failures/skips, typecheck and both builds. Existing chair settling,
bunny penetration and contact-order tests pass on the unchanged production path. The build
retains its existing large-chunk advisory; no limits or tests were weakened. `src/` remains
byte-identical to `cd3ce90`. No commit, push or merge.

## Seven-pair diagnosis and full-history follow-up

Predeclare the next root-projection screen with unchanged selection, margins and budgets.
Diagnostics now cover all seven original remaining pairs. Some accepted scalar roots are
over the distance margin; others disagree with stored normals (including nearly opposite
normals at short-distance roots). Scalar samples below the margin do not certify root
distance. Keep these failures explicit. Test a safeguarded projection: once Newton crosses
a sign change, keep subsequent iterates on that segment with a secant fallback. The
existing outward sign/world-error proof still decides root acceptance. Diagnostics using
legacy contact positions are never used to seed or select generated proposals.

The safeguarded-segment screen leaves all seven unmatched pairs unchanged and removes
only 22 of 202,698 Newton steps. Reject the extra state/branching and restore the previous
projector. Next test: surface-tangent steps of half/quarter/eighth of the existing local
trust radius before projecting onto the source surface, sharing the same iteration budget.
Keep decreasing-distance, normal-continuity and root-proof gates. This addresses slow
alternating projections near parallel surfaces; it is not a larger probe budget.

The tangent-step screen also leaves all seven pairs unmatched; restore the prior refinement.
An exhaustive CPU nearest-edge diagnostic finds in-margin, normal-consistent edge pairs
for p5 dense slot 60 and 4,314 dense slot 321. The other five have no such edge pair in
that diagnostic; this does not prove absence of in-face contacts. Next bounded candidate:
reserve 16 of 128 probes for nearest indexed target roots if the first 112 probes found
no proposal. The target traversal shares the existing 512 feature-node cap. Count target
bounds/edge priorities and transforms explicitly. Keep root proofs, normal gates and
the original unresolved frontier. No budget or margin increases.

Nearest-target traversal and joint-tree traversal do not recover additional pairs at the
unchanged 512-node limit; neither is retained. A center-only node priority misses narrow
patches inside a node. Sampling a second point toward the opposing surface, together with
a 16-probe reserve for indexed local zero edges, recovers p5 dense slot 60 and 4,314 dense
slot 321. This priority is heuristic and never discharges coverage. Five pairs remain.

Predeclare the next screen: allow those indexed neighboring roots to seed paired tangent
refinement within one cell-diagonal of each original root. Accept only decreasing distance,
independently bracketed roots, continuous valid stored normals, and the unchanged final
margin. Share the same 128 probes, 512 node visits and 12 Newton steps per probe. This tests
in-face contacts, not an increased contact margin. All nine original samples remain included.

The paired-patch screen recovers p5 impact slot 53, leaving four original unmatched pairs.
A diagnostic descent from the nearest consistent zero edges also finds a potential in-margin
patch for p20 dense slot 67. Predeclare a final unchanged-budget screen: tangent displacements
proportional to the separation vector (capped at half a cell diagonal), evaluated simultaneously
on the two surfaces, with three decreasing step sizes. This avoids fixed-length overshoot.
Keep all prior acceptance and root-bracket checks; diagnostics do not seed the measured run.

The scaled-tangent trial recovers no additional pair; restore the measured fixed trust steps.
The reserved neighborhood currently spends its probes in lattice-corner order. Predeclare a
bounded scheduling correction: collect the same 3x3x3 start nodes, count every lookup/sample,
reject inconsistent edge normals, and rank remaining edges by actual endpoint distance before
spending the reserved root probes. All node visits still share the 512 cap; add sort comparison
counters. Candidate acceptance and the original frontier remain unchanged.

## Final search / native-history checkpoint — 2026-10-25

Final-source screen: [all nine capture samples](measurements/sdf-region-contacts-history-2026-10-25.json).
The preceding `ranked-patch` report is intermediate evidence, before lookup accounting and
focused regressions. The final screen hashes the frozen current implementation and tests.
Selection, all margins, 128 probes, 512 feature visits, 8,192 region tests and shared 12
Newton steps/probe are unchanged. All 288 pair slots/keys match the preceding refined screen.

| Measure | Previous refined | Final |
|---|---:|---:|
| Proposals | 1,268 | 1,476 |
| Pairs with proposals | 54 | 58 |
| Legacy-active pairs with no proposal | 7 | 3 |
| Original unresolved regions | 2,433 | 2,433 |
| Probes | 21,263 | 18,889 |
| Newton steps | 202,698 | 175,133 |
| Field samples | 376,431 | 447,072 |
| Feature/node visits | 21,011 | 66,256 |
| Single-run CPU generation total | 877 ms | 998 ms |

Recovered p5 impact slot 53, p5 dense slot 60, p20 dense slot 67 and 4,314 dense slot 321.
No previously proposal-bearing pair loses all proposals. The new lookup index adds one
JavaScript Map entry per zero edge (33,724 for the shared bunny field); this overhead is not
included in the typed-array byte totals. Neighborhood lookup work is 110,625 reads, 20,257
found edges, 1,598 neighborhood-sort comparisons and 42,876 seed-sort comparisons. There are
more field reads/node visits and a slower CPU total despite fewer Newton iterations. These
single-run proof-oriented CPU numbers are not paired timings, a GPU speedup or FPS results.

**Three pairs remain unmatched:** p5 impact slot 56, p20 impact slot 40, and 4,314 late slot
147. [Reproducible seven-pair gap diagnostics](measurements/sdf-region-gap-diagnostics-2026-10-25.json)
retain the nearest normal-consistent zero-edge pairs and a separately bounded local descent.
For these three the best diagnostic distances are approximately 41.94, 40.48 and 20.22 mm,
against 40, 40 and 20 mm margins. The corresponding legacy projected gaps include 38.65,
39.42 and 18.98 mm. This is evidence of a contact-definition/coverage issue, **not a proof
that closer in-face roots do not exist**. Do not increase margins, accept inconsistent normals,
or turn these diagnostic points into benchmark seeds. All coverage still uses original search.

Diagnostic reproduction (from repo root; capture root supplied by the caller):

```sh
python3 scripts/sdf-region-gap-screen.py \
  docs/measurements/sdf-region-contacts-refined-2026-10-25.json \
  "$SDF_CAPTURE_ROOT" "$SDF_GAP_RAW_DIR" "$SDF_GAP_REPORT"
```

### Complete native record handoff, with an exact epoch contract

`scripts/sdf-region-history.ts` now snapshots and remaps every native 28-word Point record,
including inactive optimizer history, independent normals, IDs, anchors and the solved-export
slot. Pair order changes do not reorder force ownership. Every old point is explicitly
retained, made inactive, retired by the original detector, or invalidated. CPU stride growth
repacking preserves all points; insufficient capacity throws before dispatch. This does not
change the native detector's cache-size policy: it may retire old points, which are reported.
The production GPU history transfer still requires matching point capacity; live capacity
migration is **not** implemented by this offline repacker.

Review found that export indices alone are unsafe after another solver step or buffer growth.
Snapshots now bind them to the solver object, actual contact-buffer object, allocation generation
and step. Any mismatch severs the prior links. The callback must synchronously check the actual
`context.previousContacts` epoch immediately before encoding, and return the actual current
export buffer at the next step. This is a **trusted adapter contract**: the generic transaction
cannot prove that a caller supplied the actual buffer or invoked the check before dispatch.
The tested adapter owns this check. A production adapter must own it too; checking only at
CPU preparation is insufficient. Failed transactions never publish a new snapshot; this does
not roll back any GPU work a callback already submitted.

The new bounded real-GPU test runs the unchanged native detector and exporter for four bodies,
two pairs and three frames. It checks pair reordering, independent normals, all three warm-force
components transported into the new basis, penalty decay, and cold invalidation after two
ping-pong swaps (same buffer object, wrong step). Six CPU history tests cover inactive records,
retirement, scope/epoch invalidation, aliasing, malformed records and capacity handling. Two
focused region regressions exercise local tangent reseeding under eight probes and canonical
edge lookup/mutation isolation. Existing production sticking/settling tests remain unchanged.

**Scope:** full native history handoff is exercised, but region proposals are not inserted into
the production manifold or solver. `legacySearchRequired: true`, `productionEnabled: false`.
This is neither new-path settling qualification nor a production performance improvement.

Final full gate: sequential nice15 `pnpm check`, **294 CPU + 207 real-GPU tests**, zero failures
or skips, typecheck and both builds pass. The existing bundle-size advisory remains. Production
chair/bunny settling and penetration regressions pass; these exercise the original detector.
Source/evidence review found no remaining code blocker in this offline scope. `src/` is unchanged
from `cd3ce90`. No commit, push or merge. [Validation evidence](measurements/sdf-region-history-validation-2026-10-25.json).

Next gate: resolve the three remaining surface/legacy mismatches without losing contact coverage,
then integrate distributed region proposals with complete active/inactive identity refresh and
native export in a dedicated opt-in backend. Only after unchanged chair/bunny screens and ensembles
pass should finite-f32 GPU traversal and paired end-to-end timing be considered for promotion.
STE-3006 remains In Progress and STE-3007 remains gated. Practical 60 FPS is still unproven.

## Native-compatible hint integration protocol

The remaining three scalar-root gaps cannot be labelled resolved by loosening the zero-root
contract. Predeclare a separate experiment: three deterministic quarter/mid/three-quarter
points between each visited source zero edge and its stored-gradient target projection.
These geometry-only hints never read captured contacts, never discharge coverage and retain
separate types/identity from proof-carrying scalar candidates. Native stored-gradient evaluation
at the current poses decides activity. CPU checks are diagnostic; actual WGSL is authoritative.

The initial integration keeps the original detector, full active/inactive history and exporter
unchanged. Optional contacts use independent result/history storage and identities, current-pose
re-evaluation, reserved solver capacity and an ordered export after native contacts. First policy:
only rescue pairs with zero native active contacts, avoiding duplicate patch constraints. Decline
unsupported/inconsistent metadata, overflow and invalid epochs. Require meaningful insertion and
warm-start tests plus unchanged physical acceptance before any runtime promotion. This first
integration adds work; it is not the performance optimization or a 60 FPS claim.

## Native-compatible hints and bounded solver integration

The three remaining **generator-to-legacy observations** now have geometry-derived hints
that evaluate active under the exact native WGSL contact expression. These were already
active pairs in the native capture, not missing physical contacts in the existing solver.
Their scalar-root proof gaps remain open. No margin or root tolerance was relaxed.

| Capture / pair slot | Bounded hints | Native-active hints | Best native gap | Margin |
|---|---:|---:|---:|---:|
| 128-body p5 impact / 56 | 336 | 67 | 37.944 mm | 40 mm |
| 128-body p20 impact / 40 | 243 | 4 | 39.609 mm | 40 mm |
| 4,314-body p20 late-state / 147 | 336 | 8 | 18.995 mm | 20 mm |

The same nine-capture / 288-selected-pair sample is retained, including zero-output rows.
The scalar generator covers 58/61 legacy-active pairs; native hints alone cover 60/61;
their union covers 61/61. Native hints alone still miss p20 dense-motion slot 67, which the
scalar generator covers. This is observed pair-level feasibility under two contact contracts,
not complete manifold recall, absence certification or dense-pile quality qualification.
All 2,433 retained regions remain unresolved and require the complete original search.

`sdf-region-native-audit.ts` uses original geometry, selected frontier and unchanged probe
caps to create at most three hints per visited edge, at most 384 per pair. Captured outputs
are comparison-only; they never seed proposals. All inputs retain provenance. Each hint
stores both local coordinates; the GPU reconstructs its current world position and evaluates
the native stored-gradient expression, including its independent normal and projection
anchors. Research source extraction has checked unique boundaries and fails if they change;
the production narrowphase shader itself is unchanged. GPU batches run one capture at a time.
Final evidence: [native hints](measurements/sdf-region-native-integrated-2026-10-25.json).
The earlier `sdf-region-native-hints` report is the preliminary source revision, retained as such.

### Solver path and history contract

`scripts/sdf-region-solver.ts` implements a **research-only, explicit-pair backend** using the
real `GpuSolver3D`. The production bridge gains an internal after-export callback and a
readback accessor; without that callback its native search/export behavior is unchanged.
No public `World` setting or demo automatically enables this experiment.

1. Run the entire native detector and exporter first, preserving all active/inactive records,
   optimizer payload, IDs, normals, RNG and solved-export links.
2. Evaluate uploaded geometry hints and retained sidecar seeds at current GPU poses. Each
   point keeps its own normal. A normal discontinuity or excessive anchor drift invalidates
   its force link. Fields and body slots are fixed for the backend; replacement requires a
   new backend and recycled body identities require new pair keys.
3. **Missing-pair policy:** export at most four sidecar contacts only when the native pair has
   zero active contacts. This intentionally does not insert additional constraints on the
   three already-native-active pairs above. It avoids changing their physical behavior or
   double-constraining a patch; it is not a replacement for native discovery.
4. Sidecar IDs occupy `[0x50000000, 0x60000000)`, disjoint from native optimizer IDs, current
   mesh support IDs, rolling and sticking bits. IDs follow canonical hint features, not rank
   or array index. Pair reorders remap complete previous sidecar records. Active identities
   are retained first, with distributed fresh points and remaining inactive history within
   four slots. Optional retirements are counted; native history is never truncated.
5. Independent sidecar buffers carry IDs and solved-slot pointers. Valid force reuse requires
   matching pair identity, the actual previous solved buffer, and consecutive **GPU solver
   step** numbers. Two ping-pong swaps cannot defeat the step check. Warm-start disablement
   is honored. Native takeover clears sidecar export links, so later resumption cannot read
   an unrelated native force. Basis transport, sticking anchors and penalty decay use the
   original exporter expression. Supplemental export does not increment the pair counter twice.
6. `setProposals` refreshes discovery input; previously discovered sidecar contacts continue
   to refresh even when absent from that input. `clearProposals` explicitly clears uploads and
   retires history. Buffer replacement, invalid epochs and explicit invalidation cold-start.
   An after-export exception poisons the bridge: recreate it instead of retrying with
   partially advanced/unsubmitted native history.

Limits: 32 explicit pairs, 384 hints/pair, four retained optional points/pair, 4,096 feature
IDs/pair. Uploads validate atomically. Reserve `pairs × (nativePoints + 4)` contact/manifold
capacity before stepping, then export optional records only after native records. Own GPU
storage is `62,848 × pairCapacity + 96` bytes (1.918 MiB at 32 pairs), excluding the native
bridge and any solver capacity growth. Unsupported analytic/mixed-field pairs stay entirely
on native search. There is no automatic discovery refresh, spatial broadphase integration,
field replacement/capacity growth, combined contact-event API or live browser qualification
for this wrapper. CPU region generation still requires caller-supplied poses outside stepping.

### Physical and lifecycle evidence

Four bounded real-GPU tests exercise:

- Exact complete native-record comparison and solved forces with/without the supplement,
  including an inactive-history frame; native point data are not rewritten.
- Eight real exported contacts over two voxel pairs, distinct normals and IDs, transported
  warm forces/penalties after a small GPU pose rotation and pair/hint reorder; invalid epochs,
  warm-start disablement, native takeover, explicit retirement, invalid uploads and no overflow.
- A two-body voxel box/floor case where native search remains installed but native sample
  budgets are explicitly zero **for the isolation test only**, forcing real support from
  region contacts. Compare against an independently run full native control, sequentially.
- Fail-stop after a deliberately thrown after-export callback, before unsubmitted history
  can be reused.

The initial 180-step support check failed the 1 mm settling-window drift limit (3.81 mm).
Using the existing released-scene six-second / 360-step settling window, without changing
the physical thresholds, both paths pass:

| Metric after 360 steps | Region support | Full native control |
|---|---:|---:|
| Body center height | 0.326572 m | 0.328878 m |
| Residual linear speed | 0.000624 m/s | 0.000688 m/s |
| Final-window height range | 0.000624 m | 0.000684 m |

The 2.306 mm final-height difference is within the pre-test 5 mm comparison envelope.
This is one small support case, not matched chair/bunny ensembles for the new algorithm.
The existing full-gate chair/bunny tests still exercise native discovery, with the optional
backend disabled. They establish no regression in default behavior, not new-path pile quality.

Final full gate: nice15 sequential `pnpm check`, **295 CPU + 211 real-GPU tests**, zero
failures/skips, typecheck and both builds pass. Four integration tests and the existing
chair/bunny regressions pass. The final-source nine-capture audit again produces the table
above: 46,635 hints, 1,038 ms single-run CPU generation over the 288-pair sample, with every
source hash unchanged across that audit. This CPU cost is not a frame-time measurement.
[Validation hashes, limits and physical metrics](measurements/sdf-region-solver-validation-2026-10-25.json).
Independent read-only review fixed fail-stop and explicit retirement semantics; current code
has no remaining actionable finding in this limited scope. Work is uncommitted; no push/merge.

### Remaining promotion gates

Native-compatible hint feasibility and bounded solver insertion are implemented. No search
work is removed and no practical-60-FPS improvement is claimed. Next: reliable distributed
contact/manifold coverage and discovery refresh, then conservative finite-f32 GPU traversal
with bounded queues, changed-path chair/bunny screens and ensembles, and paired end-to-end
timing including every helper, CPU generation, upload and memory cost. A replacement must
also address the scalar/native semantic boundary and the one native-hint-only sample miss.
Until these gates pass, original search remains mandatory, STE-3006 stays In Progress and
STE-3007 remains gated. No merge.

### GPU witness traversal qualification protocol (2026-10-25)

Pre-measurement protocol: pack the immutable surface-edge hierarchy once per shared field.
Split each source into four disjoint spatial subtrees. Eight independent GPU jobs per voxel
pair each visit at most128 queue entries, project at most16 edge witnesses, and emit48 hints.
A512-field-sample cap includes ranking and projections. A64-entry queue
reports dropped entries and unvisited frontier explicitly. Ranking samples and f32 transforms
are heuristics only: they NEVER establish separation, erase unresolved regions or skip native
search. This is witness discovery, not a GPU implementation of the CPU certified solid cover.
Geometry-derived IDs encode source side, canonical lattice edge and quarter-point index.
The existing native-expression evaluator, independent normals and guarded history remain.

Qualification uses the complete released27-dynamic-body chair and bunny piles, original fields,
full mass/inertia and four substeps, matched explicit378 pairs and reserved capacity in both
arms. No sample budget or margin changes. Seed0 paired screen first, then seeds1/2 if it passes;
all runs are sequential with10ms idle between frames. Every fifth frame measures vertex depth.
Required absolute limits: chair peak40mm/final5mm/energy0.01J; bunny30mm/10mm/0.01J. Comparison
limits: peak/final depth no more than1mm above matched native, energy no more than
max(1mJ,1.05×native). A screen that adds no contacts cannot qualify the changed path. Eleven-seed
ensembles remain a later gate; a failed screen blocks promotion, without weakening limits.
Separate40-frame throughput sample (10warmup+30measured) follows each360-frame physical run:
four real substeps plus CPU encoding and GPU drain, no diagnostic readbacks inside each timed
frame,10ms idle outside timing. This excludes rendering, is measured in a settled state, and
cannot be called browser FPS or practical60FPS. No native work is removed, so it measures
supplement overhead rather than an optimization. Full required gate remains sequential pnpm check.

### GPU implementation and measured outcome

The opt-in research `RegionProposalBridge` now accepts `{gpuDiscovery:true}` with at most512
explicit pairs (uploaded-hint mode remains32). Geometry is shared per field and snapshotted
synchronously with the native atlas before shader compilation awaits. The GPU uses current
native-prepared poses, including field rotation/scale/COM, to traverse eight disjoint source
patch jobs, create canonical hints, evaluate native contact expressions and update sidecar
history each substep. There is no per-step CPU geometry generation or proposal upload.

Preparation has explicit CPU limits: four unique field attempts,64MiB aggregate source-grid
bytes,32MiB per source grid and32MiB packed hierarchy. Failed preparation still consumes its
attempt/work budget; it cannot cause unlimited retries. Unsupported fields get NIL roots and
reported reasons; both directions of an affected pair use native search alone. Packing failures
roll back partial appended data. Device storage limits are checked. Queue entries that will be
dropped do not incur ranking reads. Remaining/dropped work is reported, never certified absent.
A near-surface proposal requires an in-grid start with target phi×scale≤margin; this is an
optional-constraint eligibility heuristic, not a safe native rejection test. Native-active pairs
skip optional discovery, since selection would suppress its contacts anyway.

The initial screen exposed a chair regression: peak0.639→7.512mm, final0→3.352mm. Its
settled physics-frame sample was11.779→18.882ms. The final nearby-surface/suppression candidate
reduces the changed-path chair peak to3.612mm and the measured frame sample to14.492ms.
These separate runs are diagnostic observations, not a statistically controlled speedup claim.
The initial report is retained as rejected evidence. Final matched inputs use identical source
hashes, geometry hashes, native settings, explicit candidate order and reserved capacity.

| Full released pile, seed0 | Native | GPU supplement | Decision |
|---|---:|---:|---|
| Chair sampled peak depth | 0.639mm | 3.612mm | Fails ≤native+1mm |
| Chair final depth | 0mm | 0mm | Pass |
| Chair final energy | 0.255mJ | 1.374mJ | Fails ≤max(1mJ,1.05×native) |
| Bunny sampled peak depth | 4.633mm | 0mm | Pass |
| Bunny final depth | 0mm | 0mm | Pass |
| Bunny final energy | 0.220mJ | 0.195mJ | Pass |
| Chair settled physics-frame median / p95 | 11.081 / 11.409ms | 14.492 / 16.127ms | Added cost, not optimization |
| Bunny settled physics-frame median / p95 | 12.066 / 12.570ms | 14.207 / 14.620ms | Added cost, not optimization |

Both paths pass the existing absolute depth/energy limits, but the chair fails the stricter
predeclared matched gate. No criteria were relaxed. Chair has105 optional contact observations
across53 substeps (44 cached observations); bunny62 across32 substeps (24 cached). Actual
optional constraints were solved; this is not merely an unchanged-native regression test.
Both scenes use27 dynamic bodies plus floor and378 explicit pairs, four substeps per frame.
Each run measures360 physics frames, followed by the separate bounded40-frame throughput
sample. Timing includes CPU encoding and GPU drain, excludes rendering, and samples settled
states. It is NOT browser FPS, a dense-pile speedup or a practical60FPS qualification.
Chair extra GPU memory is24,314,640B, of which558,000B is hierarchy/roots/counters; the large
remaining evaluated-point pool is still a redesign target. Bridge-only preparation is recorded
separately; common World setup and capacity reservation are not included in that field.

The unchanged frozen nine-capture/288-pair audit finds6306 hints and active proposals for58/61
native-active pairs. It misses p5 late38, p20 impact40 and p20 dense67. For this audit only,
native records are zeroed to measure **unmasked proposal feasibility**; captured expected
contacts are used only to score the output, never as hints. This differs from live solving,
which suppresses discovery on native-active pairs. Selection manifests/slots were checked
against the previous report. These observations do not establish exhaustive coverage or
certified separation. Full native search remains mandatory.

Independent read-only review fixed aggregate preparation limits/fallback, source-generation
snapshot consistency, ranking caps, stale diagnostic slots and measurement naming. Two new
GPU tests exercise current-pose refresh, native-record parity, fallback, geometry mutation
while compilation is pending, distinct normals, solved warm forces, reorder and retirement.
One CPU test verifies complete disjoint packing and immutable copies. Full gate result is
recorded in the validation artifact after completion.

**Not promoted:** further seeds are deferred because the first matched chair screen failed.
Next: diagnose changed contact timing/native takeover on the chair trajectories, improve
coverage of the three remaining witness misses, then repeat these unchanged gates before
11-seed ensembles. Performance work must cut native search safely, and reduce the large
point pool/helper cost, rather than add unrestricted work beside it. No public option is
turned on, no merge, STE-3006 remains In Progress and STE-3007 remains gated.

Evidence: [initial screen](measurements/sdf-gpu-discovery-initial-2026-10-25.json),
[final matched piles](measurements/sdf-gpu-discovery-piles-2026-10-25.json),
[unmasked replay feasibility](measurements/sdf-gpu-discovery-recall-2026-10-25.json).

Final validation: **296 CPU +213 real-GPU tests**, zero failures/skips, typecheck/site/library
builds pass under nice15 sequential `pnpm check`; native chair/bunny settling remains green.
[Gate digest, exact code/test hashes and promotion blockers](measurements/sdf-gpu-discovery-validation-2026-10-25.json).
No commits, pushes or merges. Independent code and measurement review found no remaining
material issue in this experimental scope; the failed chair qualification remains explicit.
