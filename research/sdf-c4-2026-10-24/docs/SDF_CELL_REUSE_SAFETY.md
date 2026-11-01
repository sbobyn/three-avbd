<!-- RECOVERED TEXT, NOT ORIGINAL COMMIT. Status VERBATIM-FINAL. Rebuilt on 2026-10-31 from agent session transcripts (read 2026-10-25T00:52:42.545Z, last known write 2026-10-25T00:52:26.519Z). SHA-256 of the recovered body below this header: 0fda920ebd2d2fdd84d6a4d1a2cbaf71b169c60b45d0e779322a07cc5d2e1580. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory. -->

# STE-3006 — exact hierarchy reuse and numerical-safety checkpoint

CPU-only research on the per-cell model. Production search, budgets, normals, contact IDs
and warm starts are unchanged. No candidate GPU kernel is implemented. The original
real-arithmetic model has concrete float32 counterexamples and must not reject production
pairs. This checkpoint separates exact reuse of that model from establishing shader safety.

## Exact reuse

A bounded FIFO memo stores the union of a queried hierarchy range. Its key is the hierarchy
level and six integer block endpoints. The field is immutable; the key contains no pose or
contact history. Every pair clears the cache, including when its two bodies share a field.
Returned intervals are copied so a caller cannot corrupt cached results. Capacity is explicit
(0–64 entries); the measured candidate uses 16 per field.

On a miss, optional dyadic tiling covers **exactly** the originally selected coarse cells
with existing larger hierarchy nodes. It does not widen the range or alter subdivision.
Odd final nodes are clipped to their actual extents. A two-word visited mask suffices because
the original query has at most 64 coarse cells. No additional shared field hierarchy is built.
The greedy cover avoids descending from the root for every query, which was slower in a pilot.

Unit tests compare returned ranges and pair decisions with flat, uncached evaluation, including
odd sizes, multiple levels, exterior regions, eviction, shared fields and caller mutation.
The frozen-state audit compares each ordered slot-decision digest plus all eligibility,
subdivision and original-work totals, not only total candidate counts. Signed-mode small
captures continue to fail open. Hashes attest to the exact measured sources.

### Accounting and bounded protocol

`requestedReads` is the number of original flat hierarchy entries the unchanged queries
would read. `rangeReads` counts actual model hierarchy entries loaded after reuse. Neither
is DRAM traffic. `tileVisits` counts candidate-cell visits and attempted lifts, not every
mask-marking or arithmetic operation, and is not an instruction count. Cache lookups,
allocation and traversal have real costs even when reads fall.

`cacheLogicalBytesPerField` estimates a hypothetical compact record with 14 f32 values and
seven u32 key words: 1,344 bytes at 16 entries (twice that for two distinct fields in a pair).
It is **not** measured JavaScript heap or an implemented GPU layout. CPU entries hold at least
14 binary64 payload values (1,792 bytes for 16 entries), plus unmeasured array/string/Map
metadata. The field hierarchy itself remains 59,959,984 bytes; no claim is made that this
counter measures total process memory or future per-invocation GPU storage.

All nine frozen states run sequentially at reduced CPU priority. Each process covers at most
16,384 pair slots, has a 60-second timeout and builds its own immutable field hierarchy.
Controls and candidates use identical slot windows; large reference states use 127 nodes/pair,
small signed-mode states use 31. Report build-excluded audit CPU time separately from repeated builds.
Timing is diagnostic, not a GPU speedup prediction. Production performance acceptance is still
>=10% measured dense improvement with preserved correctness/settling and <=5% small regression.

```sh
nice -n 15 node --experimental-transform-types scripts/sdf-cell-projection-audit.ts \
  CAPTURE_DIR NEW_OUTPUT.json 127 100000 body 16 tiled 0 16384
```

Use `0 flat` for the matched control. Repeat nonoverlapping windows through the capture's
`pairCount`; outputs use exclusive creation. The CLI retains the legacy real-valued domain
for this cost-only ablation. It does not silently turn the model into a numerical certificate.

### Matched results

All 21 matched slot windows (42 bounded processes) have identical ordered pair-decision
hashes and logical search totals. Every final source hash matches the pre-run hash. The
three large states also reproduce the preceding checkpoint's aggregate decisions and
requested reads. There are zero captured active-contact contradictions; the known synthetic
float32 counterexamples below still disqualify safety. All six small states fail open.

| Reference state | Flat entries | Reused/tiled entries | Read reduction | Candidate query coverage | Flat / candidate build-excluded audit CPU seconds |
|---|---:|---:|---:|---:|---:|
| Impact | 299,315,550 | 230,984,774 | 22.83% | 18.86% | 44.79 / 60.88 |
| Dense motion | 313,509,253 | 238,749,154 | 23.85% | 14.45% | 48.70 / 65.80 |
| Late state | 309,973,414 | 236,654,690 | 23.65% | 8.40% | 48.25 / 65.91 |

Largest individual process: 30.07 seconds. Build-excluded audit totals sum the disjoint windows
and exclude each hierarchy rebuild but include slot iteration, hashing and bookkeeping; paired order was control then candidate, one trial per
window. These are diagnostic CPU measurements, not statistically qualified GPU timings.
The candidate increases CPU audit cost by **35–37%**, despite fewer reads. It also performs
518–536 million counted tiling visits/lift attempts per large state. The dense candidate
still loads about 81 hierarchy entries per original query it could avoid.

**Decision: do not port this cache/tiling traversal to production.** Exact reuse is possible,
but this implementation does not establish a net performance benefit. Keep it as an offline
ablation. Any successor must reduce total traversal/arithmetic as well as field reads and
establish numerical safety before GPU testing. No practical-60-FPS claim follows from this.

[Raw paired measurements and provenance](measurements/sdf-cell-cache-2026-10-24.json).
Earlier pilots tested 0/16/64 memo entries and a root-recursive cover on 1,024 eligible dense
pairs. A 16-entry memo alone saved 9.55% of reads; 64 saved 11.22% at four times the compact
record storage. The root-recursive cover saved the same reads as the retained greedy cover
but visited 30.22 million nodes versus 12.10 million counted greedy visits/lifts. Those pilot
figures are scoped to the prefix and are not full-state performance claims.

## Numerical safety: concrete blockers and established building blocks

Three CPU regressions demonstrate why sampled contact agreement is insufficient:

1. A plane with phi=x and g=(1,0,0) has exact projected x=0. An explicit f32 evaluation of
   the shader's eight weighted additions instead yields projected x=2^-23, outside the
   old approximately +/-1.2e-11 cell enclosure. Padding only the stored final box cannot
   account for arithmetic cancellation inside interpolation and projection.
2. Two equal plane fields at origin x=100, with one body translated by f32(2e-6), are
   classified separated by the real model at margin f32(1e-6). At p.x=f32(100.3), the shader
   subtraction loses the smaller translation. Both local samples and offsets are identical,
   producing zero unsigned separation. A generic geometry/transform assumption is unsafe.
3. With body lower bound 1 and margin f32(1e-7), shader-rounded `lo-margin/2` is below the
   CPU double domain. A certificate over that narrower CPU box misses legal shader points.

`scripts/sdf-f32-enclosure.ts` adds offline exact-rational primitives. Every finite f32 is
an integer multiple of 2^-149. BigInt arithmetic computes exact add/subtract/multiply/divide
endpoints; a monotone search for adjacent f32 values brackets them without losing tiny terms
in binary64. The interval includes input/output flush-to-zero. Division uses a worst-case
ULP across the entire quotient interval, avoiding error-envelope discontinuities at powers
of two. Unsupported denominator ranges or possible overflow return unknown (`null`).

`f32SearchDomain` uses these operations to enclose the shader's AABB/margin domain, rejecting
unsupported subnormal min/max cases. This establishes a reusable **domain-construction
building block**, not closure of an optimizer's returned point. It is not connected to the
cost-only audit or runtime. Tests cover directed rounding hidden by binary64, subnormals,
power-of-two quotient boundaries, overflow, undefined divisors and the reported regressions.

The module also establishes a **conditional real-map perturbation bound**. Let
`h(g)=g/max(|g|^2,E)`, `E=f32(1e-8)`, with proven errors `|delta phi|<=ePhi`,
`|delta g|<=eG`, original `|g|>=gMin` and `|phi|<=phiMax`. Set
`r=max(0,gMin-eG)`. Along the perturbation segment the Jacobian norm is bounded by
`L=1/max(E,r^2)`: below the floor it is `I/E`; above it is a scaled reflection with
norm `1/|g|^2`. The map is continuous at the floor. Its magnitude is at most `1/r`
when `r>sqrt(E)`, and otherwise at most `1/sqrt(E)` (bounded by 16384 in the helper).
Thus the offset error is at most `ePhi*maxMagnitude + phiMax*L*eG`.

`projectionPerturbationBound` evaluates an upper enclosure using the exact primitives,
including zero gradients and segments crossing the denominator floor. Independent review
checked the derivation; regression tests cover those branches. This preserves the useful
correlation of the real projected-image model once valid input error bounds exist, rather
than immediately discarding it for independent phi/gradient intervals. **The input errors
must still be derived for the shader, and its final offset arithmetic must be added.**
The theorem does not by itself establish those missing facts.
It also assumes the same `E=f32(1e-8)` in both maps. The earlier real model uses the
binary64 literal `1e-8`; regenerate its bounds with the materialized shader constant or
include that constant difference before applying the perturbation theorem to that model.

The normative basis is [WGSL floating-point accuracy and reassociation](https://www.w3.org/TR/2026/CRD-WGSL-20261021/#floating-point-accuracy):
add/subtract/multiply permit directed rounding, division has a 2.5-ULP allowance in its
specified divisor range, subnormals may flush, and expression reassociation is permitted.
The helper covers individual operations; composing them in one source order does not prove
all legal shader evaluation orders. No shader-wide proof is claimed.

Construction and query numerical-range failures now fail open in the offline audit rather
than aborting an otherwise valid finite-field capture. Invalid inputs and unrelated programming
errors still surface. Unsupported field headers are remembered to avoid rebuilding the same
unrepresentable hierarchy for every body.

## Required before GPU promotion

- Enclose local-coordinate rounding, cell selection and t outside nominal [0,1] at rounded
  grid ends; include all possible interpolation stencils.
- Derive a correlated projected-image error enclosure for the full allowed expression,
  including outside normalization, zero-gradient fallback and denominator-floor branches.
- Include quaternion/local/world rounding, sign selection and separation length/comparison.
  Exact per-operation tests and f32 execution samples alone do not discharge reassociation.
- Prove the returned optimizer point stays in the certified rounded domain, or enlarge it
  safely. Real convexity of simplex contraction/shrink does not establish float32 closure.
- Preserve inactive identity/RNG/history semantics and runtime refresh/recycling/growth;
  retain active-history vetoes. Then require independently reviewed contact/settling acceptance.

The next useful safety step is the correlated interpolation/projection error enclosure,
using the exact primitives and counterexamples as checks. Do not compensate with an arbitrary
larger epsilon or an asset whitelist. Until the entire chain is covered, keep GPU rejection off.

## Verification

The full `pnpm check` gate passed: 226 CPU tests and 193 GPU tests, with zero failures
and zero skips, plus typechecking, the site build and the library build. Tests ran
sequentially at low process priority with demo simulations paused; no experimental
certificate GPU kernel was run. The site build retains its existing large-chunk advisory.
Independent review checked the arithmetic, exact range reuse and paired measurement data;
reported findings were fixed. No commit, push or merge is part of this checkpoint.
