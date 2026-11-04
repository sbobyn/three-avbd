<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: f0127bb30f16aae9c73943f0588e8d290718bc9f96362416a490be30ab4a2635. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — rounded separation and returned-domain screen

This checkpoint connects a conditional CPU field enclosure to the actual offset/separation
arithmetic and the optimizer's returned-point domain. It does **not** complete a portable
proof for the production shader. No production source, normal, contact ID, warm start or
search setting changes. GPU rejection remains disabled.

## Contract and what is now connected

The numerical pass has two explicit modes. `portable` never certifies a pair because the
whole-shader evaluation contract is still unproved. `source-assume-zero` is a diagnostic
contract: finite intermediate evaluation of the stated source graphs, the previously
specified weighted interpolation family, and exact `length(vec3f(0)) == 0` for interior
voxel sampling. These assumptions must not be mistaken for adapter capability checks or
inferred from successful samples. A finite bound is conditional, not authorization to skip
production work.

The new chain is:

1. Enclose the rounded AABB/margin intersection using the existing exact-rational f32
   primitives. Use captured f32 parameters rather than JavaScript configuration doubles.
2. Enlarge that box to enclose **every returned optimizer point**, independently of objective
   decisions, cached seeds, random seeds, sorting and early exits under the finite contract.
3. Apply rounded translation, quaternion rotation, scaling and COM addition. Do not assume
   unit quaternions. Query every possible rounded interior stencil using raw-vertex ranges.
4. Bound materialized phi and world gradient, then `gradient * (phi / max(dot(g,g), f32(1e-8)))`
   separately for each body, including denominator-floor, division and multiplication error.
5. Prove that at least one phi is strictly positive throughout the subdomain. Only then is
   the unsigned separation branch known. Signed-separation and mesh-contact modes fail open.
6. Subtract the **rounded offsets**, enclose the dot and inherited square root, and compare
   the resulting lower bound to the captured f32 margin. Active uses strict `< margin`, so
   a lower bound `>= margin` suffices. Do not substitute a real squared-margin test.

The two projected world points are not computed separately: the production shader computes
`offsetA-offsetB`. Introducing rounded `p-offset` expressions would introduce a different
cancellation pattern and would not prove the actual expression.

The range bounds lose position/field correlation. This is a deliberately simpler numerical
alternative to the previous Jacobian/projected-image hierarchy, whose heuristic double
padding still cannot authorize GPU rejection. Its results must be evaluated on their own;
no earlier real-model rejection is accepted without the new check.

## Optimizer-domain reasoning

`sourceOptimizerDomain` covers three paths:

- **Projected gradient descent:** initial and subsequent points are clamped. With ordinary
  search endpoints and the finite-evaluation contract, stored best points stay in the box.
- **Ellipsoid:** best starts clamped, but the violation comparisons can accept an outside
  point when the small positive difference flushes to zero. Independent review caught this
  exception. Input flushing and output flushing each hide less than `2^-126`; expand each
  endpoint outward by `2 * 2^-126`. The regression admits `x=-2^-149` with lower bound zero.
- **Simplex:** initial, reflected and expanded points are clamped; contraction and shrink
  are not. For each iteration, enclose `(x0+x1+x2)/3` with outward sums/division. The real
  contraction/shrink result lies in the convex hull of its operands. Add the existing
  conservative polynomial rounding/FTZ bound for `c + .5*(v-c)` (absolute term sum at most
  twice the largest operand magnitude), then union with unchanged/clamped points. Induction
  through the iteration budget encloses all possible returned vertices. No objective or
  convergence branch is assumed. Overflow, unsupported bounds and excessive budgets return
  unknown rather than restoring the original box.

The simplex bound uses the **source arithmetic graph**, not unrestricted algebraic rewrites.
The ellipsoid proof concerns the returned best point; it does not certify arbitrary
intermediate ellipsoid states or prove every objective/normal computation remains finite.

## Raw-range hierarchy and positive square root

`SourceFieldRanges` copies finite f32 vertex extrema into a min/max pyramid. Parents only
union child ranges, with no floating-point projected-image construction. Rounded local/grid
coordinates select all possible stencils and vertices. A query coarsens until it reads at
most sixteen existing nodes; odd-size edge nodes retain their exact extents. The hierarchy
has its own 64 MiB aggregate source-pyramid data cap; capture bytes, the legacy pyramid,
query temporaries and JavaScript overhead are additional.

For supported interior stencils, exact trilinear weights are nonnegative and sum to one.
Each exact output lies between the stored vertex extrema. Add the previously derived
weighted-term rounding allowance, then apply the rounded world transform. The integral
base and coordinate subtraction satisfy exact subtraction inside a unit cell (Sterbenz,
or base zero); unsupported negative coordinate bounds or terminal extrapolation return
unknown. Clamp/exterior normalization is **not** silently approximated as interior. Large
query boxes and coarse nodes may destroy useful separation even though they remain
conservative under the chosen contract.

`f32Sqrt` avoids using host `Math.sqrt` as its proof. For positive normal inputs, binary
search compares `y*y*x` with 1 using exact BigInt integers to bracket `1/sqrt(x)`. Widen by
the two-ULP inverse-square-root allowance (including a power-of-two boundary), then enclose
`1 / inverseSqrt` using the existing division rule. This covers the inherited contract and
more accurate results. Zero, subnormal input, overflow or unsupported division returns
unknown. Dot sums cover all addition orders; squares retain the repeated-component
correlation. The unresolved zero-input case is not waived by this new helper.

The normative reference is the [WGSL floating-point accuracy and reassociation rules](https://www.w3.org/TR/2026/CRD-WGSL-20261021/#floating-point-accuracy).
These allow expression transformations beyond the source graphs evaluated here. The
remaining compiler-wide obligation cannot be removed by passing tests on one GPU.

## Coverage protocol

The existing sixteen-entry real-model pass is only a work prefilter. Its decisions, reads,
node totals and work counts are checked against the preceding frozen screen. Numerical
reasons and hashes describe **only those model candidates**, not every query pair. A
prefilter can lose candidates; it cannot by itself authorize any new rejection.

For each candidate, construct the rounded returned domain and run the conditional numerical
checker with at most 31 subdivision nodes and sixteen hierarchy entries per field query.
A pair is retained only if every covered subdomain certifies. Any unresolved leaf retains
the pair. Matching active history remains an unconditional veto before either pass.
Captured active-contact contradictions are recorded separately for the model and numerical
pass; zero contradictions is a regression screen, not a proof.

Run all nine preserved captures sequentially, at reduced priority, with at most 8,192 slots
and a 60-second timeout per process. Source hashes are recorded before and after, and capture
manifests accompany raw results. One pass per window; CPU time includes accounting, hashing
and both field builds. The old and new pyramids coexist only in this offline comparison, so
the two pyramid byte counts are reported separately; their sum is simultaneous hierarchy
storage, excluding capture bytes, query temporaries and JavaScript overhead. No GPU timings or FPS
claims follow.

```sh
python3 scripts/sdf-separation-screen.py CAPTURE_ROOT NEW_RAW_DIR NEW_REPORT.json
```

### Measured result: do not promote this design

All 33 subprocesses completed (largest: 47.19 seconds). Source hashes were unchanged before
and after. Aggregated legacy model work, reads, nodes and decisions-by-count match the
previous sixteen-entry screen. Slot windows differ, so this is a totals comparison rather
than an ordered-digest comparison across windows. The six signed-mode small captures retain
all work without building either hierarchy.

| Large state | Model candidates | Model query coverage | Conditional candidates / coverage | Numerical-pass CPU seconds |
|---|---:|---:|---:|---:|
| Impact | 6,442 | 14.12% | 0 / 0% | 123.82 |
| Dense motion | 5,576 | 11.20% | 0 / 0% | 107.45 |
| Late state | 3,408 | 6.57% | 0 / 0% | 66.22 |

The numerical-pass seconds include returned-domain construction, hierarchy building and
accounting, and exclude the preceding legacy model work. They are offline CPU costs, not
GPU timings. All 15,426 candidate return domains expanded. The first unresolved leaf of
every candidate had an unsupported field enclosure (`unresolved-field`); this category
includes exterior/clamp, rounded boundary and numerical-range exclusions. It does not
identify one unique failure cause and does not prove a contact exists.

The conditional pass does not bypass unresolved assumptions: a portable certificate remains
disabled independently of these measurements. Zero captured active-contact contradictions
is expected when no pair is rejected and provides no evidence of useful rejection coverage.
This result is not a measurement of padding the previous correlated hierarchy: it tests the
simpler natural-range replacement and the wider optimizer domain together.

Each populated shard uses 35,381,792 bytes of source-pyramid data plus 59,959,984 bytes for
the legacy model, 95,341,776 bytes combined (about 90.93 MiB), excluding other audit memory.
Only 1,133 / 842 / 832 numerical hierarchy entries were read across impact/dense/late:
early field exclusions dominate; this is not evidence of an efficient successful query.

[Full source hashes, manifests and per-window reports](measurements/sdf-source-separation-2026-10-24.json).

A further bounded pilot used 127 numerical nodes on the first 1,024 dense-state slots.
None of its 294 model candidates survived: 293 reached a non-splittable f32 subdomain and
one exhausted the field-enclosure budget. It completed in 15.11 seconds, including the
model pass/builds. Increasing subdivision alone did not rescue this sample; this is not a
full 127-node matrix. [Pilot evidence](measurements/sdf-source-separation-pilot-2026-10-24.json).

The cheaper natural-range design fails the existing >=10% dense coverage acceptance gate.
Do not port it to GPU or claim the old 11.20% model coverage as numerically certified.
The source-family projection/separation and returned-domain pieces are now connected and
regression-tested, but the intended portable, useful correlated certificate is **not complete**.

## Verification

The final `pnpm check` exited successfully: 242 CPU tests and 193 real-adapter GPU tests,
zero failures/skips, typecheck, site build and library build. Tests ran at low priority with
one test file at a time after all CPU coverage processes completed. The three SDF browser
demos were confirmed paused. No experimental certificate GPU code was run. Vite retains
its existing large-chunk advisory.

Independent review found and verified the ellipsoid guard fix, then checked the final code,
proof scope, data totals, source hashes, capture provenance and pilot. Two memory-accounting
wording corrections were applied; no actionable finding remains. `git diff --check` passes
and production `src/` is identical to HEAD. No commit, push or merge.

## Remaining decision gates

Portable safety remains incomplete: compiler-wide evaluation/finiteness, exact zero length,
exterior normalization and rounded terminal-cell behavior must be covered or explicitly
excluded by a defensible production contract. This checkpoint has not established a safe
padded version of the previous correlated projected-image hierarchy.

If the conditional numerical screen cannot retain useful work coverage, do not implement
this natural-range query on the GPU. First demonstrate useful coverage with a correlated
bound over rounded stencils, exterior regions and the full returned domain. If that cannot
be achieved within the storage/query budget, prefer optimizing existing search execution
without rejecting contacts. The practical 60 FPS objective remains open.
