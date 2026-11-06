# AVBD in TypeScript / Three.js / WebGPU — Implementation Plan

## Status

Current source map (2026-11-05): [architecture, data flow and repository boundaries](API.md#architecture-and-repository-map).
Older paths and checkpoints below are retained history. See that map's source qualification and [0.4 release notes](RELEASE_0.4.md)
before treating an earlier stage as current publication or acceptance status.

| Stage | State |
|---|---|
| 0 Scaffold | done 2026-09-23 |
| 1 2D CPU reference | done 2026-09-23: port matches upstream C++ (f64) to round-off on all 19 scenes; Eq 14 + VBD mode added as opt-in. |
| 2 GPU-shaped CPU solver | done 2026-09-23: SoA layout, grid broadphase, contact persistence, CSR, Jones-Plassmann colouring. Exact C++ parity in sequential mode; coloured f32 passes the behaviour suite. GPU defaults chosen (α 0.95). |
| 3 2D WebGPU, fixed topology | done 2026-09-23: WGSL kernels match the CPU to f32 round-off; zero-copy rendering from the solver's buffer; GPU drag; 100k bodies / 204k joints at 3.3 ms GPU per step (M4 Max). |
| 4 2D WebGPU with contacts | done 2026-09-23: whole step on the GPU (grid broadphase, narrowphase, hash persistence, adjacency, Jones-Plassmann colouring, indirect dispatch). Seeded single-step parity with the CPU (pairs, contacts, colours exact). Added `matchNearest` warm starts. |
| 5 2D scaling study | done 2026-09-24: per-phase GPU timing; adaptive colour cap, merged dual, locality-preserving colour buckets, register-resident rows; limits and growth fixes; iteration sweep; 250k boxes / 600k contacts at ~7 ms (4 it) on the M4 Max. `bench.html` for target hardware. **Go for 3D** (see below). |
| 6 3D CPU reference port | done 2026-09-24: `src/avbd3d/ref` is bit-identical to the upstream C++ (f64, no FMA) on all 14 scenes over 600 frames; behaviour tests; `index3d.html` viewer (orbit camera, shadows, drag, shoot; since folded into the 3D landing page, `index.html`, in 7a91f74). |
| 7 3D WebGPU | done 2026-09-24: `src/avbd3d/gpu`, whole step on the GPU (shares the 2D colouring/adjacency/args/scan kernels). Seeded single step matches the f64 reference to ≤ 3e-6; narrowphase matches on 300 random pairs; GPU behaviour suite passes; zero-copy rendering and a CPU/WebGPU switch in the viewer. 100k boxes at 22 ms (10 it, M4 Max). Awaiting check-in. |
| 8 3D scale + showcase | done 2026-09-24 (first pass): per-kernel profiling and fixes (AABB pair filter, 8-vertex clipper, lean dual write-back, large-body cap); iteration sweep; GPU-only spheres; Box2D-style face bias; showcase scenes after paper Figs 1/3, 7, 12, 13 plus piles to 250k; `pnpm bench3d:gpu`. Then contact-pair records and a leaner layout: 100k boxes at 2.9 ms (4 it) / 5.0 ms (10 it), 250k at 8.7 ms (4 it), M4 Max. Benchmark scenes after the paper's Figs 1, 3, 14 and `bench3d.html` for target hardware: 110k brick ring 11.8 ms (paper 9.8 on an RTX 4090), 506k brick walls 27.6 ms (paper 17.6). Then GPU memory sized from touching pairs (ring 608 -> 278 MB, 506k 1.85 -> 1.21 GB) and 1-8 primal lanes per colour: ring 10.4 ms, 506k 25.5 ms; fixed a colour-cap overflow that hid clashes and could collapse landing stacks. Awaiting check-in. |
| 9 npm library (v0.1) | published 2026-09-26 (`three-avbd@0.1.0`): `src/lib` (`World`, `Body`, `Joint`, `BodyMesh`; `three-avbd/advanced`) over the 3D GPU solver, y-up (the solver's gravity now pulls against an `up` parameter; reference scenes keep z). Runtime adds, removal with slot reuse, breakable joints with `onBreak`, async readback, zero-copy drawing. GPU tests on the public API; `examples/basic`; `pnpm build:lib` packs 139 kB, verified installed in a blank Vite project (TS 5.9 and 7). Design: `docs/API.md`. |
| 10 library 0.2 ("usable in a game") | published (built 2026-09-26): ball joints and springs (done); public hulls (done); impulses and forces (done); raycasts (done); contact events (done); kinematic bodies (done); collision groups (done); tracked readback (done). Also fixed the GPU tests' intermittent crash (FINDINGS 2026-09-26). |
| 11 library 0.3 (joints that bend) | published (built 2026-10-06): a rest rotation per joint (the angle lock holds `rotB = rotA·rest`), per-joint break thresholds in `appendJoints`, plastic joints (`yield`: the rest moves and the force is cut back, on the GPU) that break on how far they have bent (`breakBend`), what a joint carries readable (`Joint.force`, `Joint.bend`, `decodeJoint`), the Plastic Beam demo. The joint record is 40 floats: breaking in `three-avbd/advanced` (FINDINGS 2026-10-06). |

### SDF collision follow-on (2026-10-14)

- Phase 0: pinned headless oracle fixtures, seed sets and released-scene baselines captured.
- Phase 1: CPU fields/optimizer/manifold port and opt-in AVBD bridge implemented;
  101 CPU tests, typecheck and builds pass. GPU/full gate deferred at user request.
- CPU baking/public preparation API: mesh BVH + winding votes, bounded grids,
  async/worker cancellation, mass integration and area-weighted voxel/projected
  analytic curvature seeds. Seed-only API and explicit world-unit parameter scaling
  are implemented and covered by CPU tests.
  See `docs/SDF_BAKING.md`; unpublished, CPU-only. Four voxel assets match the
  pinned C++ seed fixtures. GPU World bindings remain deferred.
- CPU audit: direct baker comparison over 26,082 oracle nodes, cavity/disconnected
  mesh checks, 30-second mixed-size settling, public input validation and stale-doc
  cleanup complete. 121 CPU tests/typecheck/builds pass; GPU/full gate deferred.
- GPU narrowphase implementation draft: standalone atlas/pass/WGSL written;
  129 CPU tests/typecheck/builds pass after independent static review and fixes
  for float32 scale validation and failed-construction buffer cleanup.
  First small GPU validation passes: 73 selected GPU tests, including three SDF
  tests, after fixing reserved WGSL names. Five stress/showcase tests excluded
  to limit load. Production solver and public API unchanged. See `docs/SDF_GPU_DRAFT.md`.
- Bounded temporal GPU validation: five SDF tests pass, including 72 moving-body
  updates and 65-pair cache reorder across workgroups. Production integration must
  preserve independent SDF normals and separate pair cache from solver manifolds.
- Internal production bridge implemented: explicit candidates, GPU pose preparation,
  one manifold per SDF contact, identity-based basis-transported warm starts.
  79 bounded GPU tests, 129 CPU tests, typecheck/builds pass.
  See `docs/SDF_PRODUCTION_BRIDGE.md`; default collisions unchanged when detached.
- Bounded automatic candidates and World binding implemented: GPU SDF bounds,
  masks and shared joint exclusions; `World.enableSdfCollisions()` supports up to
  64 dense fixed slots. 83 bounded GPU tests and 129 CPU tests pass; nine targeted
  bridge/World checks pass after the final async-teardown guard (one additional
  regression). Typecheck/builds pass. See `docs/SDF_WORLD.md` for limitations.
- Pair contact-event aggregation and bounded SDF raycasts implemented: 130 CPU
  tests, 88 selected GPU tests, typecheck and both builds pass. Final eight World
  checks pass after backend-switch coverage; five heavy cases remain excluded.
  Query limits are documented in `docs/SDF_WORLD.md`.
- Event/query review fixes complete: pending ray input/body snapshots and
  scale-independent slab parallel checks. Independent re-review clean; 130 CPU
  and 90 bounded GPU tests, typecheck and both builds pass.
- Bounded non-convex/friction validation added: analytic/baked torus cavities,
  crossed-ring temporal contacts, World cavity/rim impacts and CPU/GPU Coulomb
  sliding/incline checks. 130 CPU and 95 selected GPU tests, typecheck and builds
  pass. Default contact-distribution regularization induces measured frictionless
  drag; defaults unchanged, tradeoff documented in FINDINGS and SDF_WORLD.
- Spatial broadphase implemented: GPU hashed grid, oversized list, compact candidates
  and exact pair-history lookup; explicit capacity/overflow, no 64-slot cap.
  Five bounded regressions cover coverage, sparse scaling, oversized bodies, overflow
  and warm-start churn. See SDF_WORLD for configuration and pathological cases.
- Runtime body/field refresh and automatic SDF candidate growth implemented.
  GPU history migration retains unchanged pairs and invalidates changed/reused slots.
  Updates rebuild the atlas; incremental voxel allocation remains open.
- Lifecycle review: fixed reuse of an unflushed body slot (replace its queued
  record rather than appending another GPU body). Independent static re-review
  found no remaining actionable issues; added query/failure-path regressions.
- Next major checkpoints, in order:
  1. Interactive browser SDF showcase implemented at `/sdf.html`: non-convex
     rings, warped boxes and a mesh-baked gear pile, with contact points/normals,
     SDF picking, joint dragging and spawning. Capped at 36 dynamic bodies;
     mass/inertia remain box proxies, not a paper reproduction.
  2. Released gear/box stacks and chair/bunny piles implemented at `/sdf-released.html`,
     with original fields, mass/full inertia, and six-second reference comparisons.
     Sticking-anchor consistency corrected; earlier mesh activation reduces motion
     and sampled impact penetration. Opt-in signed projection against static boxes
     corrects embedded surfaces reported as gaps; deeper relocated contacts can
     refresh obsolete sticking anchors while retaining warm forces. The chair settling regression
     stays unchanged. SDF adjacency now orders same-pair manifolds by persistent
     point ID; a two-run bunny test verifies same-device bitwise repeatability.
     Five-frame probes still find 8.1 mm chair / 6.8 mm bunny transient depth; see
     `SDF_RELEASED_COMPARISON.md`. Substep traces now isolate missing mesh
     extremity coverage (about 9 mm floor overlap); random support-seed trials
     regressed bunny settling and were removed. Next: deterministic support
     candidate retention implemented as an experimental GPU plane-support option.
     Isolated chair/bunny tests pass; full-pile overlap regresses, so it stays off
     in the demo. Next: mesh-to-mesh coverage/constraint diagnosis; anchor auditing
     ruled out stale sticking anchors in the measured embedded bunny case.
     This is not paper experiment parity.
  3. Reconstruct paper penetration/energy experiments and larger scenes; validate
     mixed-size scaling, memory use and target-device performance. Resolve measured
     regularization/friction tradeoffs. No published GPU timing claims yet.
  4. Package/document/review the release after these gates. Incremental voxel-atlas
     allocation and generation-aware contact events remain separate follow-ons.
  `docs/SDF_CPU_REFERENCE.md` records the collision scope and limitations.

### Stage 5 go/no-go for 3D: go
Everything around the per-body solve carries over unchanged in design: SoA layout, grid
broadphase (27 neighbour cells), hash persistence, CSR adjacency, Jones-Plassmann colouring,
colour buckets, indirect dispatch, per-phase profiling, seeded parity testing. What's new in
3D: quaternion poses, a 6×6 LDLᵀ per body (register pressure: keep the accumulator
unrolled), OBB SAT narrowphase with up to 8 contacts per pair (collision will weigh more,
since it's already 0.4–2 ms in 2D), and cone friction. Expect 2–3× the per-body cost of 2D.
Open risk: the target-hardware numbers (M1, GTX 1080) are still unmeasured.

Sources read: SIGGRAPH '25 paper (Giles, Diaz, Yuksel), `savant117/avbd-demo2d`
(~1.9k LOC C++), `savant117/avbd-demo3d` (~3.4k LOC C++), project page.

---

## 1. What the algorithm actually is (condensed)

Per time step (paper Alg. 1):

1. Collision detection → contact manifolds (persist λ, k, feature IDs for warm start).
2. Colour the body graph (bodies sharing a constraint get different colours).
3. `y = x + v·dt + g·dt²` (inertial target); `x` ← adaptive warm-start guess.
4. Warm start duals: `λ ← α·γ·λ`, `k ← clamp(γ·k, K_MIN, K_MAX)`, and `k ≤ k*` for soft forces.
5. For `n` iterations:
   - **Primal** (per colour, bodies in parallel): build per-body
     `H = M/dt² + Σ k·JᵀJ + diag‖G‖`, `f = M/dt²(x−y) + Σ J·clamp(k·C+λ, λmin, λmax)`,
     solve 3×3 (2D) / 6×6 (3D) SPD system via LDLᵀ, `x −= H⁻¹f`.
   - **Dual** (per constraint, in parallel): `λ ← clamp(k·C+λ, …)`; if inside bounds
     `k ← min(k + β|C|, k*, K_MAX)`; fracture check.
6. `v = (x − x₀)/dt` (BDF1).

Key ideas: augmented-Lagrangian hard constraints (k = ∞ ⇒ uses λ), stiffness ramping
for finite springs (Eq 16, no λ), diagonal-lumped geometric stiffness to keep H SPD
(Sec 3.5), α-regularised error correction (Eq 18), contacts as a Taylor expansion
around x₀ cached once per step (Sec 4) — so contact rows only need `dq` per iteration.

### Differences between the two reference demos (important for porting)

| | 2D demo | 3D demo |
|---|---|---|
| Force API | `computeConstraint` / `computeDerivatives`, generic rows (≤4) | `updatePrimal` / `updateDual` stamping into `lhsLin/lhsAng/lhsCross` |
| Error correction | **post-stabilisation** (α=1 iters + one α=0 iter) | Baumgarte α = 0.99 |
| Friction | box clamp per tangent row | **cone** (clamp ‖λ_tb‖ ≤ μλ_n) |
| β | single β = 1e5 | split β_lin = 1e4, β_ang = 100 |
| γ | 0.99 | 0.999 |
| Contacts/pair | ≤ 2 (box2d-lite clipping) | ≤ 8 (OBB SAT + clipping) |
| Up axis | +y | **+z** (kept; the viewer sets `camera.up`) |
| Angular joint C | angle diff × torqueArm | `2(qA·qB⁻¹).v` × torqueArm |
| Warm-start location | solver loop | inside each `Force::initialize()` |

Paper-only features not in either demo: stiffness rescaling for clamped forces (Eq 14),
static/dynamic μ switching, GPU coloring / LBVH / parallel everything.

---

## 2. Architecture decisions

- **Stack:** Vite + TypeScript, `three` `WebGPURenderer` (r17x+), `lil-gui` (since replaced by `src/ui/controls.ts`), Vitest for
  headless tests of the CPU solvers (as built: `node:test`, `pnpm test` for the CPU suites and
  `pnpm test:gpu` for the Dawn GPU suites).
- **Solver on GPU = raw WGSL compute on Three's `GPUDevice`** (`renderer.backend.device`).
  Raw WGSL rather than TSL because we need indirect dispatch, atomics, prefix scans,
  sort, and a readable 1:1 mapping to the C++. Rendering: Three `InstancedMesh` whose
  instance transforms live in a `StorageInstancedBufferAttribute`; each frame we
  `copyBufferToBuffer` the solver's pose buffer into it (cheap, decoupled, zero readback).
  *Decision point for you — see §5.*
- **Three solvers, same scenes/UI:** `CpuRef` (faithful port, the oracle) →
  `CpuSoA` (GPU-shaped CPU: typed arrays, colouring, CSR, identical buffer layouts) →
  `Gpu`. Swappable at runtime so every GPU stage is validated against CPU.
- **No float atomics needed.** Primal is a gather per body over its CSR adjacency;
  dual writes only the constraint's own state. Integer atomics only for counts/scans.
- **Constraint storage:** "row-generic" records like the 2D demo (J, H-diag, C, fmin,
  fmax, k*, k, λ, fracture) so joints/springs/contacts/motors share one kernel path with
  a small `switch(type)` for C/J evaluation. Contacts precompute J and C₀ at step start.
- **Metrics built in from day 1:** max/avg constraint error, kinetic+potential energy,
  stack drift, per-pass GPU timestamp queries. These are the "is it right?" gauges.

---

## 3. Stages & check-in demos

### Stage 0 — Scaffold (small)
Vite/TS/three WebGPU app, ortho 2D view + perspective 3D view, GUI, stats, WebGPU
feature detection (timestamp-query, subgroups), Vitest harness (as built: `node:test`).
**Check-in:** empty app renders; `npm test` green.

### Stage 1 — 2D CPU reference port (the oracle)
Faithful TS port of avbd-demo2d: `Rigid`, `Force`, `Joint`, `Spring`, `Motor`,
`IgnoreCollision`, `Manifold` + box2d-lite clipping, solver w/ post-stab toggle, all
**19 scenes** (Pyramid, Cards, Rope, Heavy/Hanging Rope, Spring Ratio, Stack Ratio, Rod,
Soft Body, Joint Grid, Net, Motor, Fracture, frictions…), mouse-drag joint, param GUI
(dt, iterations, α, β, γ, post-stab), contact debug draw.
Extras for paper fidelity: "VBD mode" toggle (β=0, no λ — reproduces the paper's
failure cases), stiffness rescaling (Eq 14), static/dynamic μ switching.
Tests: stack stays standing 10 s, rope length error < ε, friction slide distances,
spring-ratio sag, determinism.
**Check-in demo:** side by side with the official 2D web demo — every scene behaves the
same; VBD-vs-AVBD toggle on Spring Ratio / Heavy Rope shows the paper's Fig 2/4/7 effect.

### Stage 2 — 2D "GPU-shaped" CPU solver (de-risk)
Rewrite as SoA typed arrays with the exact GPU buffer layouts: body arrays, constraint
rows, per-body CSR adjacency rebuilt per step, greedy graph colouring, per-colour
Jacobi-within-colour with double-buffered positions, contact persistence via sorted
pair keys + feature IDs, uniform-grid broadphase (large statics handled separately).
Separates *algorithm/order changes* from *GPU bugs*.
**Check-in demo:** runtime toggle CpuRef ↔ CpuSoA on every scene; metric plots overlay;
first scaling numbers on CPU (e.g. how big a pyramid at 60 fps).

### Stage 3 — 2D WebGPU, fixed topology (joints/springs only)
Kernels: warm-start bodies, warm-start constraints, per-colour primal (3×3 LDLᵀ),
dual, velocity. Colouring still CPU (topology static). Render straight from GPU buffers.
Debug mode: 1-step GPU vs CpuSoA readback diff.
**Check-in demo:** Rope, Rod, Joint Grid, Soft Body, Spring Ratio, Fracture on GPU;
then a 100k+ body joint lattice to see raw solver throughput.

### Stage 4 — 2D WebGPU with contacts (full pipeline on GPU)
GPU broadphase (cell keys → radix/counting sort → pair emit), box–box narrowphase
(≤2 contacts), manifold persistence (sort by pair key, binary-search last frame's list,
match feature IDs, keep λ/k/stick), per-body CSR (count → scan → scatter), parallel
greedy colouring (a few Jacobi-style rounds, leftover conflicts fall back to Jacobi via
double buffer — as the paper does), colour-sort bodies, **indirect dispatch** per colour.
No CPU sync in the frame loop.
**Check-in demo:** Pyramid, Stack, Stack Ratio, Cards, frictions, Net all on GPU matching
CPU; drag works (GPU-side drag joint).

### Stage 5 — 2D scaling study
Benchmark scenes: giant pyramid, box rain into a container, "wrecking ball into a pile"
(2D Fig 1), huge joint lattice. Timestamp every pass; sweep N × iterations (1/2/4/8).
Optimise the top offenders (likely broadphase sort, CSR/colour rebuild, dispatch count =
iterations × colours): subgroup scans, fused kernels, fewer colours, workgroup-local
colour loops, randomised colour order option.
**Check-in:** scaling chart (bodies vs ms per pass), stability at 1–4 iterations, and a
go/no-go on the 3D design. Target to beat: ≥100k boxes real-time on your Mac; paper
reference is 110k 3D boxes @ 4 iters = 3.5 ms solve on a 4090.

### Stage 6 — 3D CPU reference port
Port avbd-demo3d: quaternion math (Eq 20/21 ⊕/⊖), 6×6 split LDLᵀ, `updatePrimal/
updateDual` stamping, ball-socket geometric stiffness, OBB SAT + clipping (≤8 contacts),
cone friction, split β, spheres (paper's smash balls). z-up → y-up remap. 14 scenes
(incl. Bridge, Breakable) + OrbitControls + ray-pick drag.
**Check-in demo:** side by side with the official 3D web demo.
*As built:* kept z-up (the viewer sets `camera.up`) so solver state stays comparable with
the oracle. Spheres moved to Stage 7/8: the upstream demo has no sphere shapes, so there is
no oracle for them.

### Stage 7 — 3D WebGPU
Reuse Stage 4 pipeline (broadphase/persistence/CSR/colouring/indirect dispatch are
dimension-agnostic by design); swap in 6-DOF body kernel, 3D narrowphase (box–box,
sphere–box, sphere–sphere), quaternion integration. Validate against 3D CpuRef.
**Check-in demo:** 3D Pyramid, Stack, Rope, Bridge, Breakable on GPU matching CPU.
*As built:* no 3D SoA CPU solver. Instead the GPU can take fixed colours, one per body in
the reference's newest-first order, which reproduces the reference's Gauss-Seidel sweep, so
a seeded GPU step is compared with the f64 reference directly. Box-box only (spheres: Stage 8).

### Stage 8 — 3D scale + showcase
Paper-figure recreations: block pile smashed by sphere (Fig 1/3), breakable brick wall
(Fig 13), chain mail + heavy ball (Fig 12), 50-link pendulum w/ 50 000:1 mass ratio
(Fig 7). Instanced rendering with shadows. Benchmarks vs paper Table 1.
**Check-in:** benchmark report + showcase scenes.
*As built:* spheres are a GPU-only extension (the reference has none). The chain mail is a
net of plate links joined by ball joints rather than interlocked rings. Target-hardware (M1,
GTX 1080) numbers are still deferred.

### Stretch
3-DOF particle/cloth vertices mixed with rigid bodies (Fig 5/14 flag & cloth), LBVH
broadphase for mixed sizes, VBD/XPBD comparison modes, recording/replay.

---

## 4. Risks & how we handle them

- **f32 precision** with k up to 1e9–1e10 next to M/dt² in LDLᵀ: the C++ is f32 too, so
  it's workable; keep K_MAX tunable and test Stack Ratio / Cards (most sensitive).
- **GPU non-determinism** (atomic ordering in colouring/pair lists) ⇒ trajectories will
  diverge from CPU over time. Validate with single-step diffs on identical inputs + metric
  envelopes, not frame-by-frame trajectories.
- **Colour count** drives dispatch count (iters × colours). Box piles should colour in
  ~6–12; if higher, cap colours and let conflicts go Jacobi.
- **Warm-start persistence on GPU** is the fiddliest part (Stage 4) — Stage 2 builds and
  proves the exact scheme on CPU first.
- **Large static ground** breaks uniform grids → statics in a separate list tested
  against every dynamic body's cell range (or clipped into cells).
- **Post-stab vs α:** support both; default to whichever the reference demo for that
  dimension uses.

## 5. Decisions (settled 2026-09-23)

1. **Raw WGSL** compute on Three's `GPUDevice`; Three only renders.
2. Repo: `~/dev3/three-avbd`.
3. **Performance target: as high as possible on slightly older hardware** — Apple M1
   (8-core GPU, unified memory, ~68 GB/s), GTX 1080 / 1080 Ti laptops (Pascal). Consequences:
   - No hard dependency on optional WebGPU features. `subgroups` and `timestamp-query` are
     used when present, with a plain workgroup-memory fallback for every scan/reduction.
   - Workgroup size 64 by default (good on both Apple SIMD-32 and NVIDIA warp-32);
     tunable per kernel.
   - Memory bandwidth is the budget: compact SoA layouts, `vec4<f32>` packing (no
     `mat3x3` padding waste), f32 everywhere, contact data cached once per step.
   - Minimise dispatch count (iterations × colours dominates on M1's driver overhead):
     indirect dispatch, fused kernels, colour count kept low.
   - Never stall on readback in the frame loop; HUD stats read back async, a frame late.
