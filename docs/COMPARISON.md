# three-avbd vs Rapier

An honest comparison, for choosing between them. Written 2026-11-02 against three-avbd `main`
plus the scene-validity labels of #60, and Rapier `@dimforge/rapier3d-compat` **0.21.0** (the
version the comparison harness pins; Rapier claims below are checked against that package's
type declarations unless marked otherwise). The detailed research log is
[RAPIER_COMPARISON.md](RAPIER_COMPARISON.md); this page is the summary.

Rules this page keeps: every number has a machine, date and source; anything not measured is
marked **(unverified)** or **(pending)**; no speedup ratio is quoted where either engine missed
the quality target.

## 1. What each engine is for

**Rapier** is a mature, general-purpose CPU physics engine (Rust compiled to WASM) with a broad
feature set, synchronous queries, sleeping and character/vehicle controllers: the default choice
for gameplay physics in a browser.

**three-avbd** steps rigid bodies entirely on the GPU (WebGPU) with Augmented Vertex Block
Descent and draws them straight from the solver's buffers: it is for scenes with tens or hundreds
of thousands of interacting bodies, destruction and breakable structures, where a CPU engine runs
out of frame budget.

## 2. Feature parity

`has` / `partial` / `missing`. Plan column: **0.4** ships now, **0.5** planned next, **later**,
**doc** (documented difference, no fix planned). Plans are intentions, not commitments.

### Bodies

| Capability | Rapier 0.21 | three-avbd | Plan |
|---|---|---|---|
| Dynamic / fixed bodies | has | has | 0.4 |
| Kinematic bodies | position- and velocity-based | partial: a fixed body's `moveTo` slides it to a target over the next steps, carrying what it touches; a fixed body given `set({ velocity })` keeps moving (conveyor, turntable; `src/lib/world.ts`, `Body.moveTo`) | 0.4; doc |
| Forces, impulses, torques | has | has (queued for the next step; persistent forces until `clearForces()`) | 0.4 |
| Mass / inertia override | has, incl. centre-of-mass offset | partial: `massProperties: { mass, moments }` (principal moments only; the body frame must be the principal frame) | 0.4 |
| Linear/angular damping | has | missing | STE-3328 |
| Per-body gravity scale | has | current candidate source: option/getter/setter, standard/SDF built-in integrator; bounded M4 Max checks | candidate0.4, STE-3328 partial |
| Axis locks | has | missing | later |
| Restitution | has, with combine rules | missing: contacts are inelastic | 0.5 if time |
| Friction | coefficient + combine rules | partial: coefficient, cone friction, combined by geometric mean (not configurable) | doc |
| Sleeping | has | **missing** (`world.capabilities.nativeSleeping` is `false`) | later |
| Enable / disable a body | has (`RigidBody.setEnabled`) | has: `body.setEnabled`, `body.reset`, same lifetime ID and slot ([BODY_LIFECYCLE.md](BODY_LIFECYCLE.md)) | 0.4 |
| Fixed-storage pools | no equivalent | has: `three-avbd/pool`, `storage: { growth: 'fixed' }`; acquire/release/step create no GPU buffers or pipelines (asserted in `tests-gpu/pool.gpu.test.ts`). No speedup over add/remove is claimed | 0.4 |
| Lifetime body IDs | handles | has: `body.id`, never reused; events and rays keep the handle they captured | 0.4 |

### Shapes

| Capability | Rapier 0.21 | three-avbd | Plan |
|---|---|---|---|
| Box, sphere | has | has | 0.4 |
| Convex hull | has | has, at most 32 vertices (`MAX_HULL_VERTICES`, `src/avbd3d/hull.ts`; larger point sets are reduced to 32). Native hull collision needs a ninth storage buffer per stage; otherwise hulls collide as their bounding box (warned once; `requireHulls: true` refuses instead) | 0.4 |
| Capsule | has | missing as a body (capsule only in CPU static queries) | 0.5 |
| Cylinder, cone, round shapes | has | missing: approximate with a hull | doc |
| Compound colliders | has | missing: one shape per body; weld bodies with fixed joints instead | later |
| Triangle mesh, heightfield | has | missing in the solver; `three-avbd/queries` has CPU rays, sphere/capsule overlaps and sweeps against static meshes, independent of the GPU world | later |
| Voxels | has (`ShapeType.Voxels`) | no collider; Voxel City uses one body per voxel | doc |
| Non-convex via SDF | no (trimesh or decomposition) | has, **experimental** (`three-avbd/sdf`, [SDF_WORLD.md](SDF_WORLD.md)) | 0.4 experimental |

### Joints

| Capability | Rapier 0.21 | three-avbd | Plan |
|---|---|---|---|
| Fixed, ball (spherical) | has | has | 0.4 |
| Spring | `JointData.spring(rest, stiffness, damping)` | partial: stiffness and rest length, no damping | 0.5 |
| Breakable joints | none built in (no threshold in the 0.21 declarations) | **has**: `breakForce`, `breakOnPull`, `onBreak`, all on the GPU | 0.4 |
| Plastic joints | none | **has**: `yieldForce` bends and keeps the bend, `breakBend` tears | 0.4 |
| Joint force readout | has | has: `world.readJoints()` → `joint.force` | 0.4 |
| Revolute, prismatic, rope, generic; motors and limits | has | missing (a hinge can be made from two ball joints, below) | 0.5: hinge; rest later |
| Multibody (reduced coordinates) | has | missing | never |

### Queries, events, integration

| Capability | Rapier 0.21 | three-avbd | Plan |
|---|---|---|---|
| Nearest raycast | has, synchronous | has: GPU, async, batched (`world.raycasts`, up to 65,535 rays a call); brute force rays × bodies; the answer arrives a frame or two later | 0.4 |
| All hits, shape casts, point/AABB queries vs bodies | has | missing against GPU bodies (CPU static meshes only) | 0.5 |
| CCD | has (`enableCcd`, soft CCD) | missing: discrete collision only. Use smaller steps (below) | doc |
| Sensors | has | missing (`reportContacts` still collides) | 0.5 |
| Contact begin/end events | has | partial: begin/end with point, normal and the begin step's impulse, filtered on the GPU and delivered at the next readback; bounded, with loss counters | 0.4 |
| Contact force events | has (threshold per collider) | missing | later |
| Collision filtering | collision groups, solver groups, hooks | partial: 32-bit group/mask | doc |
| Character, vehicle, PID controllers | has | missing | later (character); never (vehicle) |
| Snapshots (save/restore) | has (`takeSnapshot`) | missing | later |
| Debug render | has (`world.debugRender()`) | demo-only | 0.5 small helper |
| Rendering | copy poses from CPU into your meshes | **zero-copy**: `BodyMesh` draws from the solver's GPU buffer | 0.4 |
| Headless | WASM anywhere | WebGPU needed: Node with Dawn (`World.create({ device })`), workers | 0.4 |
| Runs without WebGPU | yes | **no**, and no CPU fallback | doc |

## 3. Performance

### Measured so far

All on one machine (Apple M4 Max). Rapier 0.21.0. Timings are **serialized**: each step (or batch
of 10) waits for completion, so they measure step latency, not pipelined GPU throughput or
rendered frame time.

**Main-era baseline**, 2026-11-01, Node + Dawn, 1/60 s, 4 iterations each, 60 lead + 120 measured
steps, batch 10, 3 repeats, Rapier sleeping and CCD off.
Source: [data/rapier-baseline-2026-11-01.json](data/rapier-baseline-2026-11-01.json).

| Scene (bodies) | Rapier ms/step, median (range) | three-avbd ms/step, median (range) | Quality target | Valid for quality claims? |
|---|---|---|---|---|
| rest-grid-1k (1,001) | **1.54** (1.49–1.56) | 1.68 (1.67–2.37) | Rapier met, AVBD missed (margin depth) | yes |
| pile-1k (1,001) | 2.95 (2.85–3.00) | **1.50** (1.49–1.67) | both missed | no: mid-collapse window |
| ring-9k (9,132) | 67.32 (61.37–98.77) | **2.12** (2.01–2.64) | both missed | not labelled; standing walls |

**Historical scale check** (three-avbd `b3675de`, 0.2.1, before the audit fixes; same machine,
Node + Dawn, 4 iterations each, 30 lead + 30 measured steps, **one repeat**): 110,442-body ring,
Rapier median 998.10 ms/step, three-avbd 9.41 ms/step. Source:
[RAPIER_COMPARISON.md, "Initial verification"](RAPIER_COMPARISON.md#initial-verification) (no
data file retained). A smoke check, not a protocol result.

**three-avbd alone**, 2026-09-24, M4 Max, Node + Dawn
([data/bench3d/m4-max.json](data/bench3d/m4-max.json)): 110k brick ring 9.27 ms/step (4
iterations), 100k box columns 2.95 ms, 32k settled pile 2.50 ms, 506k brick gables 25.1 ms (3
iterations). In Chrome on the same machine the README reports the ring at 10.4 ms.

**Rendered, with contact events** (2026-11-01, Chrome, `/compare-frame.html`, `sphere-pile-100`,
120 frames): three-avbd's frame work was 4.4–4.9 ms against Rapier's 1.2–1.4 ms, of which 3.7–4.1 ms
was three-avbd's event readback ([RAPIER_COMPARISON.md](RAPIER_COMPARISON.md#main-era-baseline-2026-11-01)).
The scene is now labelled invalid for quality, but the readback cost is a real cost.

**Settling batch on the valid scenes**, 2026-11-02, M4 Max, Node + Dawn, three-avbd at the #60
branch head `57c7c23` (the scene-validity PR, before its squash merge), Rapier 0.21.0. 1/60 s,
600 measured steps after a 120-step lead (hcp) or 600-step lead (piles), batch 10, **3 repeats**,
Rapier sleeping and CCD off, the same iteration count for both engines (Rapier: solver
iterations, 1 PGS iteration each). ms/step is the mean of the three
repeats' step-weighted means; depths are the worst over the measured window and were identical
across repeats. Contact target: floor and pair depth both ≤ 1 % of the smallest body dimension.
Sources: `docs/data/settling-gpu-2026-11-02-{hcp,piles}-{4,10}-{0.01,0.001}.json`, one file per
scene group, iteration count and AVBD margin ([data/](data/); trimmed from the raw harness output:
per-step quality traces and body lists removed, every summary field unchanged).

`sphere-pile-hcp-100` (100 close-packed 1 m spheres, a stable stack):

| Engine | Iterations | Margin | ms/step | Worst floor depth | Worst pair depth | Contact target |
|---|---|---|---|---|---|---|
| Rapier | 4 | — | **0.31** | 0.28 mm | 0.58 mm | met |
| three-avbd | 4 | 0.01 (default) | 1.35 | 13.1 mm | 11.2 mm | missed |
| three-avbd | 4 | 0.001 | 1.33 | 3.4 mm | 2.6 mm | met |
| Rapier | 10 | — | **0.62** | 0.27 mm | 0.72 mm | met |
| three-avbd | 10 | 0.01 (default) | 3.24 | 10.9 mm | 10.3 mm | missed |
| three-avbd | 10 | 0.001 | 3.23 | 1.5 mm | 1.8 mm | met |

Both engines hold this stack. With `contactMargin: 0.001` three-avbd meets the contact target with
no extra step time in these runs; at the 0.01 default it rests about a margin deep. At 100 bodies Rapier is
about 4–5× faster per step, with both meeting the target at margin 0.001.

`pile-1k-settled` and `pile-10k-settled` (boxes dropped from height with no initial overlap):

| Scene | Engine | Iterations | Margin | ms/step | Worst floor depth | Worst pair depth | Contact target |
|---|---|---|---|---|---|---|---|
| 1k | Rapier | 4 | — | 2.48 | 110 mm | 324 mm | missed |
| 1k | three-avbd | 4 | 0.01 | 1.44 | 222 mm | 456 mm | missed |
| 1k | three-avbd | 4 | 0.001 | 1.38 | 234 mm | 425 mm | missed |
| 10k | Rapier | 4 | — | 37.9 | 124 mm | 405 mm | missed |
| 10k | three-avbd | 4 | 0.01 | 1.71 | 354 mm | 732 mm | missed |
| 10k | three-avbd | 4 | 0.001 | 1.64 | 327 mm | 755 mm | missed |
| 1k | Rapier | 10 | — | 4.74 | 99 mm | 263 mm | missed |
| 1k | three-avbd | 10 | 0.01 | 3.19 | 190 mm | 482 mm | missed |
| 1k | three-avbd | 10 | 0.001 | 4.00 | 230 mm | 480 mm | missed |
| 10k | Rapier | 10 | — | 65.9 | 116 mm | 405 mm | missed |
| 10k | three-avbd | 10 | 0.01 | 3.40 | 345 mm | 653 mm | missed |
| 10k | three-avbd | 10 | 0.001 | 3.53 | 289 mm | 762 mm | missed |

**These pile scenes do not yet measure resting quality.** Neither engine meets the contact target
on either pile, at either iteration count: Rapier's worst pair depth is 263–405 mm too. The metric is
the worst depth over the whole window, so it is dominated by the drop's impacts and transient
interpenetration, not by how the pile rests. What the table does show: three-avbd's worst
transient depths are larger than Rapier's (1.3–1.9× in pair depth, 1.9–3.0× in floor depth), and
10 iterations instead of 4 change them by 15 % or less. Because both miss
the target, the step times above are **not** a quality-matched speed comparison, and no speedup
ratio is quoted for the piles. The final-window (resting) metric below separates how each engine
rests from the impacts.

At the end of that 1,200-step run three-avbd's 10k pile was still moving (fastest body 0.50–1.27 m/s at 4
iterations, 0.69–1.45 m/s at 10, depending on the margin), where Rapier's fastest body was below
0.001 m/s at 4 iterations and 0.13 m/s at 10. On the 1k pile both engines ended with every body
below 0.013 m/s ([same data](data/), `finalQuality.maxSpeed`).

**Final-window metric** (added after this batch). Every result now
also has a `finalWindow` record, computed over only the last N measured steps (default 60), next to
the unchanged worst-over-window fields:

- **Window**: the last `--final-window` measured steps (default 60, 1 s at 1/60 s; all measured
  steps if there are fewer). Lead-in steps are never included.
- **Floor / pair depth**: for each window step, the same worst floor penetration and worst
  body–body depth the existing metrics use; the report gives the max and the p95 over the window's
  steps (`maxFloorPenetration`, `p95FloorPenetration`, `maxContactDepth`, `p95ContactDepth`, plus
  the relative maxima). Pair fields are null if any window step was unmeasured.
- **Motion**: `maxSpeed` (fastest body's linear speed on any window step), `maxKineticEnergy`
  (largest total translational KE on any window step), `finalKineticEnergy`, and `restFraction`,
  the fraction of dynamic bodies with linear speed below 0.01 m/s (`REST_SPEED`) on the last step.
- **`contactTargetMet`**: the existing contact target (full floor coverage, floor and pair depth
  ≤ 1 % of the smallest body dimension) holds on **every** window step.
- **`settled`**: `contactTargetMet` and `maxSpeed` ≤ 0.05 m/s (`SETTLED_MAX_SPEED`); null when
  pair depth was unmeasured. Angular velocity is not part of either speed test.

Final-window batch (2026-11-02, M4 Max, Node + Dawn, Rapier 0.21.0, PR #65 at `e7d4ce5`):
2,400-step (40 s) lead, 600 measured steps, metrics over the last 60; one repeat, since quality
was repeat-identical in the earlier batch, so the step times are not headline numbers. Data:
[data/final-window-gpu-2026-11-02-*.json](data/) (per-step traces dropped); commands in
[RAPIER_COMPARISON.md](RAPIER_COMPARISON.md#final-window-resting-metric).

| Scene | Engine | Iterations | Margin | ms/step | Floor max | Pair max | Max speed | At rest (last step) | Contact target | Settled |
|---|---|---|---|---|---|---|---|---|---|---|
| 1k | Rapier | 4 | — | 2.72 | 3.0 mm | 12.2 mm | 0.000 m/s | 100 % | missed | no |
| 1k | three-avbd | 4 | 0.01 | 1.47 | 14.1 mm | 14.5 mm | 0.073 m/s | 99.5 % | missed | no |
| 1k | three-avbd | 4 | 0.001 | 1.45 | 5.4 mm | 5.6 mm | 0.004 m/s | 100 % | missed | no |
| 1k | Rapier | 10 | — | 5.17 | 2.2 mm | 12.7 mm | 0.000 m/s | 100 % | missed | no |
| 1k | three-avbd | 10 | 0.01 | 3.37 | 11.7 mm | 21.5 mm | 0.001 m/s | 100 % | missed | no |
| 1k | three-avbd | 10 | 0.001 | 3.22 | **3.0 mm** | **3.0 mm** | 0.001 m/s | 100 % | **met** | **yes** |
| 10k | Rapier | 4 | — | 36.0 | 8.1 mm | 39.5 mm | 0.000 m/s | 100 % | missed | no |
| 10k | three-avbd | 4 | 0.01 | 1.64 | 17.1 mm | 71.0 mm | 1.11 m/s | 99.4 % | missed | no |
| 10k | three-avbd | 4 | 0.001 | 1.63 | 27.8 mm | 32.7 mm | 2.39 m/s | 99.9 % | missed | no |
| 10k | Rapier | 10 | — | 62.6 | 8.9 mm | 31.2 mm | 0.003 m/s | 100 % | missed | no |
| 10k | three-avbd | 10 | 0.01 | 3.29 | 12.7 mm | 111.3 mm | 0.132 m/s | 100 % | missed | no |
| 10k | three-avbd | 10 | 0.001 | 3.25 | 3.7 mm | 98.3 mm | 1.38 m/s | 100 % | missed | no |

Floor and pair are the max over the 60 window steps; max speed is the fastest body on any window
step; at rest is the share of bodies below 0.01 m/s on the last step. The contact target is 1 % of
the smallest body dimension (5 mm for these 0.5–1.2 m boxes) on every window step, and settled is
that plus max speed ≤ 0.05 m/s.

- **1k: both engines are at rest after 40 s (every body below 0.01 m/s on the last step, but for
  0.5 % at 4 iterations and margin 0.01), and only three-avbd at 10 iterations with margin
  0.001 meets the contact target** (3.0 mm floor and pair), the one configuration of either engine
  that settles by this definition. Rapier rests with about 12 mm of body–body overlap at both
  iteration counts, so it misses the pair target. At 4 iterations and margin 0.001, three-avbd is
  close (5.6 mm, 0.004 m/s). At the 0.01 default it rests about a margin deep (12–22 mm).
- **10k: Rapier is fully at rest; three-avbd is not.** It has 99.4 % or more of its bodies at rest
  at every setting, but a few still move at 1.1–2.4 m/s (0.13 m/s at 10 iterations, margin 0.01),
  and at 10 iterations a few pairs stay 98–111 mm deep. Neither engine meets the contact target
  (Rapier's pairs are 31–40 mm deep). At margin 0.001 three-avbd's floor depth (3.7 mm at 10
  iterations) is under Rapier's (8.1–8.9 mm). Section 4 says what the outliers are.
- No 10k configuration meets the target, so the 10k step times (three-avbd 1.6–3.3 ms, Rapier
  36–63 ms) are still not a quality-matched comparison. At 1k only three-avbd meets it, so no ratio
  is quoted there either.

**Browser side by side** (2026-11-02, Chrome on the M4 Max, `/compare-side.html`,
`pile-1k-settled`, 4 iterations; one observation, not saved as data): at t = 10 s three-avbd's pile
was still moving (fastest body 1.7 m/s) while Rapier's was at rest. That is consistent with slower
settling in three-avbd (by 40 s the same pile is at rest, table above); it is a single visual
check, not a measurement protocol.

What this supports today: on the 1k resting grid Rapier is as fast or faster per step and meets
the contact target. On the 1k pile after 40 s, three-avbd at 10 iterations and margin 0.001 meets
it (3.22 ms/step, one repeat) and Rapier does not, at either iteration count. At ~9k and ~110k bodies three-avbd's step is far cheaper at 4 iterations, with
both engines outside the shared quality target. On a valid 100-sphere stack both meet the target
(three-avbd with margin 0.001) and Rapier is 4–5× faster. Where the crossover lies, and how it moves when
three-avbd runs enough iterations to meet the target, is **not measured yet**.

### Pending: full method

A quality-matched comparison is planned (release plan §3.3) and **has not run**:

- Scenes: `rest-grid-100/1k/10k`, `pile-1k-settled`, `pile-10k-settled`, `stack-50`, `chain-20`,
  `impact-100/1000`, `ring-9k`, `ring-110k`; boxes and spheres only (hulls as a labelled extra).
- Metrics: completed and batched ms/step (mean, median, p95), rendered frame time, readback and
  event cost separately, build time, floor/pair depth, final max speed and kinetic energy,
  retained GPU bytes (`world.storageInfo`).
- Fairness: same dt and seed, alternating order, ≥ 3 repeats, AC power, nothing else on the GPU;
  Rapier at its defaults with sleeping on **and** off; three-avbd both at the iteration count that
  meets the quality target and at 4; no ratio where either misses the target; M4 Max only, said so.

## 4. Quality

### Resting depth is the contact margin

A resting three-avbd contact sits about `contactMargin` deep, plus a solver residual. The GPU
margin became a parameter in #55 (default 0.01 m, the reference demo's `COLLISION_MARGIN`).

| Measurement (M4 Max) | margin 0.01 (default) | margin 0.001 | Rapier 0.21 | Source |
|---|---|---|---|---|
| 1 m box / 0.5 m sphere on a floor, 300 steps | 10.37 mm | 1.87 mm | — | [FINDINGS 2026-11-01](FINDINGS.md#2026-11-01--opt-in-contact-margin) |
| `rest-grid-1k`, floor / pair depth | 11.3 / 11.1 mm, target missed | 4.4 / 7.1 mm, target met | 0.8 / 5.2 mm, met | [baseline JSON](data/rapier-baseline-2026-11-01.json); [settling status](RAPIER_COMPARISON.md#the-earlier-evidence-re-read) |
| `sphere-pile-hcp-100`, 4 iterations, floor / pair depth | 13.1 / 11.2 mm, target missed | 3.4 / 2.6 mm, target met | 0.28 / 0.58 mm, met | [settling batch](data/) (section 3) |
| `pile-1k-settled` after 40 s, 10 iterations, final-window floor / pair depth | 11.7 / 21.5 mm, target missed | 3.0 / 3.0 mm, target met | 2.2 / 12.7 mm, missed | [final-window batch](data/) (section 3) |

The default stays 0.01 in 0.4.0; for scenes where resting depth matters, set
`contactMargin: 0.001` (section 7). A new default waits until tall walls and the small benchmark
tier are re-measured at 0.001 (**pending**). Evidence so far: before `startAtRest`, a 40-course wall fell at 6 s with or without
the margin ([FINDINGS 8m](FINDINGS.md#2026-09-24--stage-8m-tall-brick-walls-at-4-iterations-slow-bodies-start-at-rest)),
so the margin was not holding walls up; the current solver has not been re-measured.

### Settling: what H1 showed

The earlier "AVBD piles don't settle" finding was wrong as a general statement. It rested mostly
on invalid scenes (2026-11-02, CPU only; [settling status](RAPIER_COMPARISON.md#settling-status-2026-11-02),
[data/settling-h1-2026-11-02.json](data/settling-h1-2026-11-02.json)):

- **`sphere-pile-100` is an unstable equilibrium** (25 single-file columns of 4 spheres). Rapier
  only "settles" it because its solve is exactly symmetric: with 1 mm of jitter Rapier topples too
  (75 bodies fallen, peak 6.6–7.4 m/s). The CPU AVBD reference with real sphere contacts topples
  at steps 55–59 like the GPU did, so it is the scene and AVBD's Gauss–Seidel order, not the GPU
  port.
- **`pile-100/1k/10k` start overlapping** (119 pairs, worst 10.3 cm, in `pile-1k`) and the
  window ends mid-collapse: Rapier ended at 10.2 m/s, AVBD at 8.7 m/s. Neither had settled.
- **Valid replacements**: `sphere-pile-hcp-100` (framed close-packed stack; Rapier and the CPU AVBD
  reference both hold it), `pile-1k-settled` and `pile-10k-settled` (no initial overlap). All
  labels live in `SCENE_VALIDITY` in `src/comparison/scenes.ts`.
- **A real gap remains on `pile-1k-settled`** for the CPU reference (demo warm start, not the GPU
  solver's `startAtRest`): at step 1,200 it still has 115 bodies above 1 cm/s at 4 iterations and
  61 at 10, where Rapier has none.
- **GPU runs of the valid scenes** (section 3, 2026-11-02): the GPU solver holds
  `sphere-pile-hcp-100` and meets the contact target with margin 0.001. On the two piles the
  worst-over-window depths are dominated by the drop's impacts for both engines.
- **The GPU solver's piles settle, with exceptions at 10k** (final-window batch, section 3: 40 s
  lead, last 60 of 600 steps). At 1k, both engines are at rest, and at 10 iterations with
  margin 0.001 three-avbd settles with less overlap than Rapier (3.0 mm floor and pair against
  Rapier's 2.2 / 12.7 mm). At 10k, 99.4 % or more of the bodies are at rest, but a few keep moving
  (up to 1.1–2.4 m/s on some window step) and a few pairs stay deeply overlapped (33–71 mm at 4
  iterations, 98–111 mm at 10), where Rapier is fully at rest with 31–40 mm pairs. That 10k tail
  is the real remaining settling gap.
- **What the 10k outliers are** (10 iterations, margin 0.001; `--dump-movers` plus a solver
  contact probe, [details](RAPIER_COMPARISON.md#the-10k-outliers)):
  - The deep pairs are overlaps from the landing that the box-box contact manifold reports as
    resolved (about −1 mm, the margin, at every contact point, with the correct normal). The
    solver therefore never pushes them apart, and rerunning the narrowphase does not help.
  - The fast bodies are short bursts of local slipping inside the pile, one buried body and its
    neighbours, not bodies on edges, the surface or the pile's rim.
  - With `startAtRest` off, max speed fell from 1.38 to 0.075 m/s (one run). Proposed 0.5 fixes
    are in the linked section; neither is implemented.

### Tall stacks at low iteration counts

At 4 iterations, tall brick walls used to creep and buckle (a 40-course ring fell at 6 s; only 7 %
of contacts sticking, against all at 10 iterations). The GPU solver's `startAtRest` (on by default)
fixed the collapse: the 110k ring stands 40 s unhit with 5 cm drift, a 40-course ring 60 s with
3–4 cm. A 4-iteration wall is still weaker under impact: a smash of the 28k ring brings down
12.3–12.7k bricks at 4 iterations and about 5.1k at 10
([FINDINGS 8m](FINDINGS.md#2026-09-24--stage-8m-tall-brick-walls-at-4-iterations-slow-bodies-start-at-rest)).
`World` defaults to **10 iterations**; the benchmarks above use 4.

### No sleeping

Every enabled body is solved every step. A settled scene costs a full step, and a near-settled pile
keeps producing small motion and contact begin/end events (see the event readback cost above). All
comparisons so far ran Rapier with sleeping **off**; Rapier with sleeping on is **unmeasured**.

## 5. Determinism and latency

| | Rapier 0.21 | three-avbd |
|---|---|---|
| Same machine | deterministic (default packages; per the pinned package's README) | bit-identical on the same device when capacities are fixed up front and never grown: 600-step runs of a 4k box pile, 28k ring and 24k ragdolls compared bit for bit ([FINDINGS 8o](FINDINGS.md#2026-09-25--stage-8o-deterministic-gpu-steps-same-device)). Measured on the solver directly; through `World` this needs `storage: { growth: 'fixed' }`, since adaptive growth follows readback timing **(unverified through World)** |
| Across machines | `@dimforge/rapier3d-deterministic(-compat)`: cross-platform determinism, slower build | **not provided** (f32 on different GPUs and drivers) |
| Save / restore | `takeSnapshot` / `restoreSnapshot` | missing |
| When state is visible | synchronously after `world.step()` | on the GPU at once (rendering sees it); on the CPU after `await world.read()`, a frame or two later |
| Raycasts | synchronous | async, batched; a frame or two |
| Contact events | drained after each step | delivered with the next readback, in step order |
| Step submission | blocks the JS thread for the step | `world.update()` / `step()` queue GPU work and return |

In short: Rapier is the engine for gameplay that must decide on this frame's state, for lockstep
networking across machines and for save games. three-avbd's state lives on the GPU; game logic
works on observations one or two frames old.

## 6. When to choose which

**Choose three-avbd when**
- the scene has thousands to hundreds of thousands of interacting bodies: destruction, rubble,
  brick and voxel structures (Voxel City: 94,000 voxel bodies), piles, chain mail;
- you want structures that bend and break (breakable and plastic joints, on the GPU);
- you render with Three.js WebGPU and want instanced bodies drawn with no per-frame copy;
- you need non-convex dynamic bodies and can accept an experimental API (SDF);
- you control the target: WebGPU browsers (Chrome/Edge, Safari 26) or Node with Dawn.

**Choose Rapier when**
- the scene is small (hundreds to ~1k bodies), where it is as fast or faster and rests tighter;
- you need a character controller, vehicles, hinges, sliders, motors, sensors, CCD, capsules,
  triangle-mesh or heightfield levels;
- game logic needs synchronous queries and this frame's poses;
- most bodies are idle most of the time (sleeping);
- you need cross-machine determinism, snapshots or bouncy materials;
- you must run without WebGPU.

**Both** (unverified pattern): Rapier for the player, triggers and level queries; three-avbd for
the debris field drawn with `BodyMesh`. The two worlds do not interact unless your code copies
state between them, which costs a readback.

## 7. Shrinking the cons today

Every snippet below uses the current public API (typechecked against `src/lib` on 2026-11-02).

**Resting depth → smaller margin.** Rests about 1.9 mm deep instead of 10.4 mm (measured above);
tall-wall stability at 0.001 is not yet re-measured.

```ts
const world = await World.create({ renderer, maxBodies: 10_000 });
world.solver.params.contactMargin = 0.001; // default 0.01 m; validated at the next step
```

**Tall-stack creep → more iterations where it matters.** `World` already defaults to 10; drop to 4
only for paper-scale scenes that need the throughput.

```ts
const world = await World.create({ renderer, maxBodies: 120_000, iterations: 4 });
world.iterations = 10; // can change between steps
```

**No sleeping → freeze still bodies, disable unreachable ones, pool short-lived ones.** Freezing
with `setFixed(true)` keeps a body colliding and supporting what rests on it while it stops
moving; a hit wakes it. This stops settled-pile churn and its events; it is **not** shown to make
the step cheaper (fixed bodies still take part in collision detection), and a frozen body does not
fall if its support is removed until something touches it.

```ts
const still = new Map<Body, number>();
await world.read(debris);                      // poses and velocities of these bodies only
for (const b of debris) {
  if (!b.alive || b.fixed) continue;
  const n = Math.hypot(...b.velocity) < 0.02 ? (still.get(b) ?? 0) + 1 : 0;
  still.set(b, n);
  if (n >= 30) { b.setFixed(true); b.reportContacts = true; }
}
world.onContact(e => {
  if (e.type !== 'begin' || e.impulse < 1) return;
  for (const b of [e.a, e.b]) if (b?.fixed && still.has(b)) { b.setFixed(false); still.set(b, 0); }
});
// Out of play for good (fell off the map, far away): out of the solve, slot and ID kept
for (const b of debris) if (b.alive && b.position[1] < -50) b.setEnabled(false);
```

For bullets, shells and sparks, a pool in a fixed-storage World churns with no GPU allocation:

```ts
import { BodyPool } from 'three-avbd/pool';
const world = await World.create({ renderer, maxBodies: 1_025, storage: {
  growth: 'fixed', pairs: 8192, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } });
const created = await BodyPool.create(world, { capacity: 1_024,
  template: { kind: 'box', options: { size: [0.2, 0.2, 0.2], density: 500 } } });
if (!created.ok) throw new Error(created.reason);
const shot = created.pool.tryAcquire({ position: [0, 5, 0], rotation: [0, 0, 0, 1] });
if (shot.ok) setTimeout(() => created.pool.release(shot.body), 2000);
```

**No CCD → smaller steps, and sweep fast shots against static geometry on the CPU.** A body moving
`v·dt` per step tunnels through anything thinner; at 1/240 s a 40 m/s ball moves 17 cm a step
instead of 67 cm. Do not use `reuseManifolds` for fast projectiles.

```ts
const world = await World.create({ renderer, maxBodies: 10_000, dt: 1 / 240 });
world.maxSubsteps = 8;                         // 4 steps per 60 Hz frame, room to catch up
let previous = performance.now();
renderer.setAnimationLoop((now) => {
  world.update(Math.min((now - previous) / 1000, 0.1));
  previous = now;
});

import { StaticQueryScene, boxMesh } from 'three-avbd/queries';
const level = new StaticQueryScene();
level.addMesh({ ...boxMesh([0.02, 4, 4]), position: [5, 1, 0] });
const hit = level.sweepSphere({ center: [0, 1, 0], radius: 0.05, translation: [40 / 60, 0, 0] });
```

**Cylinders, cones, capsules → convex hulls.** At most 32 vertices; ask the renderer for the hull
limits, and `requireHulls: true` refuses a device that would fall back to boxes.

```ts
const renderer = new THREE.WebGPURenderer({ requiredLimits: await recommendedLimits() });
await renderer.init();
const world = await World.create({ renderer, maxBodies: 1_000, requireHulls: true });
const points: number[] = [];
for (let i = 0; i < 16; i++) {                 // two rings of 16 = the 32-vertex limit
  const a = (i / 16) * 2 * Math.PI, x = 0.5 * Math.cos(a), z = 0.5 * Math.sin(a);
  points.push(x, -0.5, z, x, 0.5, z);
}
const barrel = convexHull(points)!;            // one shape, shared by every barrel
world.addHull({ shape: barrel, position: [0, 1, 0] });
scene.add(new BodyMesh(world, { bodies: barrel, geometry: hullGeometry(barrel) }));
```

**Compound shapes → bodies welded with fixed joints.** Jointed bodies do not collide with each
other; the weld is unbreakable unless you give it a `breakForce` (which also makes it a
destructible prop).

```ts
const seat = world.addBox({ size: [1, 0.1, 1], position: [0, 1, 0] })!;
const back = world.addBox({ size: [1, 1, 0.1], position: [0, 1.55, -0.45] })!;
world.addJoint(seat, back, { anchorA: [0, 0.05, -0.45], anchorB: [0, -0.5, 0] });
```

**No hinge → two ball joints on the axis** (the gear demo's axles do this,
[SDF_GEARS.md](SDF_GEARS.md)). No limits or motor; drive it with `applyTorque`.

```ts
world.addJoint(frame, door, { type: 'ball', anchorA: [0.5, 1, 0], anchorB: [-0.5, 1, 0] });
world.addJoint(frame, door, { type: 'ball', anchorA: [0.5, -1, 0], anchorB: [-0.5, -1, 0] });
```

**Kinematic bodies → fixed bodies with `moveTo` or a velocity.**

```ts
const lift = world.addBox({ size: [3, 0.2, 3], position: [0, 0, 0], fixed: true })!;
lift.moveTo([0, 4, 0]);                        // slides there over the next update's steps
const belt = world.addBox({ size: [10, 0.2, 2], position: [0, 0, 5], fixed: true })!;
belt.set({ velocity: [1, 0, 0] });             // keeps moving: a conveyor
```

**Latency and event cost → read only what you need, batch rays, report contacts sparingly.**
A tracked read copies 160 bytes per body; every reporting body adds to the event readback.

```ts
world.track([player, ...nearby]);              // readbackEvery reads only these
world.readbackEvery = 1;
const hits = await world.raycasts([{ origin: [0, 1, 0], direction: [1, 0, 0] }, /* ... */]);
crate.reportContacts = true;                   // only the bodies that make sounds or take damage
```

**Sensors → test tracked positions on the CPU** (a trigger volume against `player.position` after
a tracked read), or `three-avbd/queries` overlaps against static meshes. Using a body with
`reportContacts` as a trigger still pushes things.

**Determinism on one machine → fixed storage.** `storage: { growth: 'fixed', ... }` (as in the
pool example) never grows buffers through readbacks, which is what broke repeatability in the
solver measurements; a [bounded public-World probe](WORLD_DETERMINISM.md) matched final body fields for17bodies/60steps in two pacing modes on M4 Max. Broader/hidden-state replay remains unverified.

**No real workaround yet:** restitution and damping (an impulse from last frame's
read velocity is a crude, stale damper), triangle-mesh levels in the solver, cross-machine
determinism, snapshots, character controllers, running without WebGPU.

## 8. Roadmap

Current native-support tracking is in [the staged roadmap](FEATURE_PARITY_ROADMAP.md); stage labels are not promised versions. Per-body gravity scale is implemented in current candidate source. Remaining proposals include damping, spring damping,
restitution, sensors, capsules, a hinge joint, queries against dynamic bodies, sphere contact
anchoring and the settling fixes the GPU runs point to, a quality-matched performance
table (section 3) and a small debug-lines helper. The live side-by-side page
(`/compare-side.html`) already ships in the repo. Later: sleeping, compound
colliders, triangle-mesh and heightfield collision, snapshots, a character controller. The
settling investigation and its hypotheses are tracked in
[RAPIER_COMPARISON.md](RAPIER_COMPARISON.md#settling-status-2026-11-02).
