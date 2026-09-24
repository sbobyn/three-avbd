# Findings

Measured results that drive design decisions. Newest first. Each entry says how it was measured.

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
