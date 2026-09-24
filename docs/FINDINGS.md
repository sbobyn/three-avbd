# Findings

Measured results that drive design decisions. Newest first. Each entry says how it was measured.

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
