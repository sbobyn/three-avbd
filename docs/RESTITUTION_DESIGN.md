# Restitution: method note (G2, STE-3329)

Status: **CPU experiment contract reviewed by the lead, 2026-11-10**, against `origin/main`
`0f77819`. Recovered from the failed Fable task; original draft preserved privately. Steven
explicitly authorized continuing with Codex. Nothing in this note has yet been run:
no test, typecheck, build, GPU or browser. Every behavioural statement is either source reading,
algebra under stated assumptions, or marked **unmeasured**. The numeric gates below are accepted for this bounded CPU experiment before any run. This
is not acceptance of the GPU method, an advanced semantic change or a restitution API.

Parent: STE-3326. Roadmap entry: [G2](FEATURE_PARITY_ROADMAP.md). Storage background:
[BODY_AUX_DESIGN](BODY_AUX_DESIGN.md) §§2, 7, 11–13.

## 1. Result in short

- **Candidate method: an approach-gated restitution target on the existing normal row.** In the step where
  a contact's incoming normal approach speed exceeds a threshold, the row's step-start term is
  lowered so the row asks for a relative normal displacement of at least `e·|v_n⁻|·dt`. No
  velocity pass, no new solver stage, no change to the primal, the dual or `solveWGSL`.
- **The method is not yet proven in this solver.** The algebra holds only if the normal row
  converges within the step. How much of the impact impulse a fresh contact delivers in the
  configured iterations is unmeasured, and rebound speed is sensitive to it (§3.4).
- **First slice: an isolated, opt-in 2D CPU experiment** that reuses `src/avbd2d/ref` read-only
  through subclassing. No edit to the reference, its defaults, the oracle fixtures or any GPU file.
- **GPU route, staged after the experiment:** a small pass that sees the aux record and rewrites
  `Contact.c0x`. It needs no new storage buffer and no stride change, and leaves exported
  `solveWGSL` byte-identical. It does change what `c0x` means during an impact step, which is a
  lead decision (§9, L1), not accepted here.
- **Rebound height remains a measured acceptance question.** The draft's discretisation
  expression (§3.5) is an unverified model; it does not waive the original 5% height gate.
- **Q2 config A already fails C3.** G2 may not claim the 100-sphere depth target at baseline (§8).

## 2. Current source facts the method depends on

| Fact | Source |
|---|---|
| Normal points from B to A; `A > B` in a manifold | `Manifold`, `src/avbd3d/gpu/layout.ts:239-242`; 2D `collide.ts:34` |
| Normal row: `C = c0x·(1−α) + n·ΔxA − n·ΔxB + (rA×n)·ΔθA − (rB×n)·ΔθB`, displacements since `x⁻` | `evalContact`, `wgsl-solve.ts:211-220`; 2D `Manifold.computeConstraint` |
| `c0x = n·d + contactMargin` at step-start poses, so `C ≥ 0` allows overlap up to the margin | `wgsl-collision.ts:747`; 2D `manifold.ts` (`C0`) |
| Force is push-only: `F.x = min(pen·C + λ, 0)`; friction bound is `|F.x|·μ` | `wgsl-solve.ts:221-228` |
| `c0x` is rewritten every step on every path: narrowphase, `reuseContacts`, `reuseManifolds`, SDF export | `copyContacts` `wgsl-collision.ts:718-755`; `wgsl-sdf-bridge.ts:99` |
| All iterations of a step use one `α` (3D GPU); 3D defaults inherit `α = 0.99`, no post-stabilisation | `solver.ts:1839-1867`, `gpuParams3D` `solver.ts:213-221`, `avbd3d/ref/solver.ts:50` |
| `bodies[i].vel` / `angVel` hold the step-start velocity for the whole solve; damping has already been applied and stored | `warmStartBodies` `wgsl-solve.ts:293-335`, `DAMPING_WGSL` `:14-20`, `updateVelocities` `:666-678` |
| Velocity is BDF1: `(pos − initialPos)/dt`; `vel.w` keeps the previous up-velocity for the adaptive warm start | `updateVelocities`; `wgsl-solve.ts:313-320` |
| A fixed body with velocity is kinematic and its displacement enters the row through `dLin`/`dAng` | `wgsl-solve.ts:329-334`, `pairBody` `:177-180` |
| Warm start: `λ ·= α·γ`, `pen ·= γ`, floored by `contactPenaltyMin` (`m/dt²` with `massPenalty`, default on) | `wgsl-collision.ts:691-696, 749-752` |
| `Contact` (16 words) and `Manifold` (8 words) have no spare field; every body `w` is taken | `layout.ts:239-257`; BODY_AUX_DESIGN §2.3 |
| `bodyAux.w` is reserved, written 0, with no reader | `layout.ts:33-46`; BODY_AUX_DESIGN §13 |
| `c0x` readers in `src/`: `evalContact` only. `ContactWatch` declares the field and reads `lam.x` | `wgsl-solve.ts:218`; `src/lib/contacts.ts:19, 106` |
| 2D reference: boxes only; default post-stabilisation (`α = 1` in the main iterations, one extra `α = 0` iteration after velocities are taken) | `avbd2d/ref/solver.ts` `step` |
| 2D broadphase skips a pair that already has a force between its bodies | `solver.ts` `step` → `Rigid.constrainedTo`, `body.ts:52` |

The 3D CPU reference has no spheres (`avbd3d/ref/collide.ts` is box SAT). A sphere rebound can
only be measured on the GPU solver.

## 3. Method

### 3.1 Definition

For each contact point, at step start:

```
v_n⁻ = d(C_normal)/dt at step-start velocities
     = n·(vA + ωA×rA) − n·(vB + ωB×rB)          (negative: approaching)
b    = e_pair · (−v_n⁻) · dt      if −v_n⁻ > v_th and e_pair > 0
     = 0                          otherwise
row  : C' = n·Δ_rel + min((1−α)·c0, −b)          when b > 0
       C' = C  (unchanged arithmetic)             when b = 0
```

`n·Δ_rel` is the existing displacement part of the row. The `min` is a **max form**: the row asks
for the larger of the existing stabilisation displacement `(1−α)·|c0|` and the restitution
displacement `b`, never their sum. A sum would add `(1−α)·|c0|/dt` to the rebound speed, up to
`(1−α)·|v|`, which is an energy source.

Defining `v_n⁻` as the time derivative of the row itself (same Jacobian) removes any sign or
lever-arm ambiguity: it needs no assumption about world up, and it includes angular velocity and
a kinematic partner's velocity exactly as the row does.

### 3.2 What the algebra proves

Assumption **(conv)**: the row is active and satisfied as an equality at the end of the last
iteration.

1. Under (conv), the *linearized row* velocity equals
   `max(-(1−α)·c0/dt, e·|v_n⁻|)`. Replacing the first term with an absolute value additionally
   assumes `c0 ≤ 0`. This is not an exact finite-rotation contact-point velocity theorem.
2. When a converged rebound separates, the next approach gate is inactive. Without convergence,
   a pair can still be approaching above the threshold on later steps and fire again. Thus the
   method is approach-gated, not a proven one-shot impact latch. Record per-step firing and
   repeated activation; a resting or repeated-kick failure is retained, not dismissed.
3. Multiple contact rows ask for compatible relative motion only under additional geometry and
   convergence assumptions. This avoids directly summing independent impulses, but does not
   prove absence of multi-contact energy gain or spin artifacts.
4. The existing normal Jacobians/system carry effective mass and inertia. Coupled dynamic and
   kinematic responses still need experiment evidence.
5. Resting contacts are unchanged only while all their approach speeds remain below the gate.
   This is measured in A6 rather than assumed.

### 3.3 Interactions, by reading

| Topic | Behaviour under the method | Status |
|---|---|---|
| Friction | Tangent rows and `c0y/c0z` untouched. The cone bound grows with the impact normal force in that step | Direction plausible; magnitude of spin transfer unmeasured |
| Stick anchors, `STICK_BIT`, sphere lever arms at `initialRot` | Untouched | By reading |
| Damping | `v_n⁻` uses the damped step-start velocity, the same one the inertial target uses | Consistent by construction |
| Gravity and forces | The step's gravity enters the inertial target only; the hard row overrides it | Covered by §3.5 algebra |
| Adaptive warm start | After a bounce `(v_up − vel.w)` opposes gravity, weight clamps to 0 for one step | By reading `:317-318` |
| `FLAG_START_AT_REST` (`REST_SPEED` 0.1 m/s) | No interplay if `v_th ≥ 0.1` | By reading |
| Fixed and kinematic partners | Relative velocity includes the kinematic velocity; rebound is relative to the mover | Algebra; unmeasured |
| Jointed pairs | Jointed and no-collide pairs produce no contact, so no restitution. Joint limits are out of scope | By reading |
| Manifold reuse across substeps | `c0x` is recomputed per substep, the gate is re-evaluated per substep | By reading `copyContacts` |
| Penalty ramp | `pen.x += β·|C|` sees the larger `C` in the impact step and decays at `γ` per step afterwards | Effect on later resting quality unmeasured |
| Momentum | No better or worse than the existing block iteration | Unmeasured |

### 3.4 The real uncertainty

If the solver delivers a fraction `η` of the impulse the row needs, the rebound speed is
`v⁺ = ((1+e)·η − 1)·|v⁻|`. At `e = 0.9`, `η = 0.95` gives `0.805·|v⁻|`, about 80 % of the
expected height. An inelastic contact hides the same shortfall as a little residual penetration.
`η` depends on iterations, the fresh-contact penalty (`PENALTY_MIN` in the 2D reference,
`m/dt²` with `massPenalty` on the GPU), `β`, colouring order and f32. **None of this is
measured.** That is why the first slice is an experiment and not a GPU implementation.

### 3.5 Draft height model (unverified; not an acceptance exemption)

Flat, non-rotating body, single impact, (conv) holds, free flight is the solver's own
`v ← v + g·dt; x ← x + v·dt`. Let `h` be the drop height and `d ∈ [0, |v|·dt)` the overlap at the
start of the contact step, both measured to the margin surface, and `v` the speed at that step
start. Let `s = 1` if the step restores the overlap without changing velocity (2D
post-stabilisation), else `s = 0`. The original draft proposes the following approximation; discrete apex sampling, finite
constraint convergence and finite rotation have not been bounded here:

```
H = e²·h + d·(e² − 1 + s) + e·|v|·dt·(1 − e)/2
```

| Case (`g` = 10 m/s²) | `e²h` | Worst `H − e²h`, `s = 0` | Worst, `s = 1` |
|---|---|---|---|
| e 0.9, h 1 m, dt 1/60 | 0.81 | −1.3 % … +0.4 % | up to +7.9 % |
| e 0.5, h 1 m, dt 1/60 | 0.25 | −18.6 % … +3.7 % | up to +11 % |
| e 0.5, h 1 m, dt 1/240 | 0.25 | −4.7 % … +0.9 % | up to +2.8 % |
| e 0.5, h 4 m, dt 1/240 | 1.00 | −2.8 % … +0.5 % | up to +1.4 % |

`d` depends on the contact step. The expression and numeric ranges above are retained as
an unverified hypothesis, not a proof of a universal 60 Hz limitation or a reason to weaken G2.
The experiment must report actual first apex, measured incoming/outgoing velocity and the
residual against this expression separately. The original 5% height criterion stays in force;
a failed method/configuration is not promoted to GPU implementation.

## 4. Methods compared against the current source

| | A. Velocity pass after `updateVelocities` | B. Bias computed inside `evalContact` | C. Pre-solve target pass rewriting `c0x` (**candidate**) | D. Pack `e` into `geo.w` with friction |
|---|---|---|---|---|
| Reaches `e` | Own layout can bind aux | **Blocked**: `solve` layout is full at 8; aux would be a 9th storage buffer for `primal`/`dual` | Own layout binds aux | No new binding |
| Solver change | A second coloured sweep writing bodies from pairs: a new solver stage | Two more body loads per pair in the primal hot loop (`wgsl-solve.ts:184-186` records a 60 % slowdown from extra live rows) | None in `solveWGSL` | Friction read changes in every consumer |
| Multi-point manifolds | Impulses add unless solved jointly | Constraint | Constraint | n/a |
| Needs pre-step velocity after it is overwritten | Yes, no field to keep it | No | No | n/a |
| Exported `solveWGSL` | Unchanged | Changed, or another built-in variant | **Unchanged** | Changed |
| Verdict | Rejected: architecture | Rejected: binding blocker | Carried forward, conditional on §7 | Rejected: precision hack, silent ABI change |

## 5. GPU storage and bindings for the candidate (later phase; not part of the first brief)

Per-entry-point storage use, derived from `createLayouts` and the solve-phase encode
(`solver.ts:2044-2073`):

| Entry point | Layout | Storage today | With G2 |
|---|---|---|---|
| `warmStartBodies` | `integrate` (bodies, aux) | 2 | 2, unchanged |
| `warmStartJoints`, `primal`, `primalSparse`, `dual`, `updateVelocities` | `solve` | 8 | 8, unchanged |
| `hashInsert`, `narrowphase`, `reuseManifolds` | `contacts` | 8 or 9 | unchanged |
| topology and colouring kernels | `topo` | 8 | unchanged |
| **new** `applyRestitution` | **new** `restitution` | — | **5**: bodies R, manifolds R, contacts RW, counters R, bodyAux R |

- Uniforms for the new pass: the existing `Params` (dt, α, joint count, capacities) plus one new
  16-byte uniform `{ threshold: f32, combine: u32, pad, pad }`. Uniforms do not count toward
  `maxStorageBuffersPerShaderStage`. `Params.pad0/pad1` are **not** renamed: `Params` is part of
  `PRELUDE_3D`, which is inside exported `solveWGSL`, and its SHA-256
  (`f2228d88…f5df3`) must not move.
- Per-body value: `bodyAux.w`, default 0. `BODY_AUX_DEFAULT` stays `[1, 0, 0, 0]`; stride 16 B,
  buffer size and the storage budget are unchanged. The internal `BODY_AUX_ABI_VERSION` would go
  to 2. This uses the last aux lane; BODY_AUX_DESIGN §7 already routes sensor and CCD flag bits to
  the filter record.
- Write: `c0x' = min(c0x, −b/(1−α))` for contacts with `b > 0`. `evalContact` multiplies by
  `(1−α)`, which reproduces the max form of §3.1 with no shader change. Requires `α < 1`; a
  non-zero restitution with `α ≥ 1` must be refused before any upload.
- Placement: after `warmStartBodies`, before the first `primal`, dispatched indirectly like
  `dual` (`IA_CONSTRAINTS`, index minus `jointCount`). Lever arms from `initialRot`. Two bind
  groups by contact-buffer parity, rebuilt wherever `G.contacts[cur]` is.
- **Zero default:** the pass is encoded only while at least one live slot has `e > 0` (a CPU
  count). With all zeros the command stream, every buffer and every result are the current ones;
  existing envelopes, command traces and the 8-buffer packed consumer need no change.
- No per-step readback, no per-step allocation, no new storage buffer.
- Custom solve override: aux writes are already refused (`setBodyAux`, `solver.ts:1730-1731`), so
  restitution is refused and its capability is false. A custom *contacts* module with the
  built-in solve fills the same records; behaviour there is unknown, capability false at first.
- **ABI note (L1):** strides, offsets and exported shader text are unchanged, but an external
  reader of the contact buffer would see `c0x` lowered during an impact step, and a custom solve
  module cannot receive restitution. This is a semantic change to a documented field.

SDF: exported SDF contacts land in the same records before the solve, so the pass would apply in
principle. `SDF_ROLLING_BIT`, the anchor conventions of `exportContacts` and the support-contact
record (`wgsl-sdf-bridge.ts:158`) have not been checked against §3.1. Stage: standard backend
first; SDF capability stays false until its own gate passes.

## 6. API and ownership (proposal for the API phase)

| Item | Proposal |
|---|---|
| Per body | `restitution?: number` on body options, getter and setter on the handle, as `gravityScale`. Dimensionless, finite as f32, `0 ≤ e ≤ 1`; anything else throws before mutation. Default 0 |
| Combine | One world-level rule, `restitutionCombine: 'average' \| 'min' \| 'multiply' \| 'max'`, default `'average'` (L3). Per-collider rules wait for C2 |
| Threshold | World-level `restitutionThreshold` in m/s, default 1.0 *proposal* (L4), must be ≥ `REST_SPEED` |
| Shapes | Whatever the standard narrowphase produces: boxes, spheres, hulls. No shape-specific term |
| Capability | `world.capabilities.restitution`: true only for built-in solve + standard collisions with `α < 1`; false for custom solve, custom contacts and, at first, SDF |
| Pools, reset, disable, removal, slot reuse | Follow the G1 contract in [API.md](API.md#per-body-velocity-damping): template value on acquire, value kept across reset and disable, removed handle updates metadata only, a reused slot gets its new body's full record |
| Failure | Validation before mutation; unsupported backend throws at the setter, defaults keep working |

Out of scope: restitution on joints or limits, per-collider materials, velocity-dependent `e`.

## 7. Predeclared experiment and acceptance (2D CPU, before any run)

Parameter sets, 10 iterations each: **P-ref** `defaultParams()`; **P-par** `parallelParams()`;
**P-3d** `{ postStabilize: false, alpha: 0.99 }` (the 3D GPU's stabilisation). Variant **V0**: the
reference's fresh-contact penalty. Variant **V1**: impact rows start at
`min(dynamic masses)/dt²`, mirroring `contactPenaltyMin`. `g = −10`. `v_th = 1.0 m/s` *proposal*.

| Fixture | Scene |
|---|---|
| F1 drop | 1×1 box, density 1, μ 0.5, released at rest, gap `h` above a fixed 100×1 ground; `e ∈ {0, 0.5, 0.9}`; `(h, dt) ∈ {(1, 1/60), (1, 1/240), (4, 1/240)}` |
| F2 rest | The F1 box starting in contact, `e = 0.9` on both, 600 steps |
| F3 stack | The reference `stack` scene, every body `e = 0.9`, 600 steps |
| F4 coupled | (a) two equal boxes, μ 0, one at 4 m/s into the other at rest on the ground, `e ∈ {0.5, 0.9}`; (b) F1 box dropped onto a resting box |
| F5 oblique | F1 box rotated 30°, `e = 0.9` |

| ID | Criterion | Threshold | Gate |
|---|---|---|---|
| A0 | Zero mode: all `e = 0`, experiment step vs plain `Solver.step()` on F1, F3 | poses and velocities **exactly equal**, every step | required |
| A1 | `e = 0` compatibility/no added bounce | apex no higher than the matched zero-mode control plus 1e-12 m; report the baseline apex separately (not perfect physical zero-bounce proof) | required |
| A2 | Impact ratio `ρ = v_n⁺/|v_n⁻|` at the first impact, F1, `e ∈ {0.5, 0.9}`, every `(h, dt)` and parameter set | `|ρ − e| ≤ 0.02` and `ρ ≤ e + 0.005` *proposal* | required for the set carried to the GPU (P-3d) |
| A3 | First apex against the unverified §3.5 expression | record actual H, H_pred and residual | diagnostic only; not eligibility evidence |
| A3r | Original roadmap criterion `|H − e²h| ≤ 0.05·e²h` | all declared positive-e drop cases, no exemption from §3.5 | required, P-3d |
| A4 | No energy gain | `ρ ≤ e + 0.005`; five successive apexes strictly decreasing; no apex above `h` | required |
| A5 | `dt` robustness | A2 holds at both 1/60 and 1/240 | required |
| A6 | Quiet rest, F2 and F3 | trajectory **exactly equal** to the `e = 0` run for all 600 steps (the gate never fires); report the largest resting approach speed against `v_th` | required |
| A7 | Coupled, F4a | relative normal speed after = `e`× before within 0.03; horizontal momentum change ≤ 0.1 % *proposal* | required |
| A8 | F4b, F5 | report rebound and total energy; total energy after ≤ before | report; energy bound required |

Rules: thresholds are fixed before the run. A failure is recorded with its number and returned to
the lead; no threshold, fixture, iteration count or default is changed to turn it into a pass.
V1 passing where V0 fails is a finding about penalty start, not a pass for V0. A 2D CPU result
in f64 with sequential ordering does not qualify the f32 coloured GPU solver.

## 8. Qualification baseline (Q1–Q3)

- Recorded state ([QUALIFICATION_MATRIX](QUALIFICATION_MATRIX.md)): Q1 all `unknown`; Q2 config A
  **fails C3** (0.0148603557 > 0.01), config B (margin 0.001) passes; Q3 passes. Q2 A stays open
  under STE-3334.
- G2 therefore does not assert "the 100-sphere depth target is still met" at the default margin.
- **Zero-mode compatibility** (all `e = 0`): no pass is encoded, so A stays the failed control and
  B stays passing, by construction. To be confirmed on hardware in the GPU phase, not re-tuned.
- **Strengthened acceptance for the GPU phase:** with a non-zero `e` on the Q2 bodies, config B
  must still pass C3 and the other decidable criteria; config A is run as the failed control and
  its C3 value is reported beside the recorded one. Neither result changes a default.
- No gate on M1/GTX 1080, no timing, benchmark-winner or physical-accuracy claim follows.

## 9. Decisions for the lead

| ID | Decision | Recommendation |
|---|---|---|
| L1 | Accept that an impact step lowers `c0x` in the contact buffer (advanced semantic, no stride change) | Accept if §7 passes; alternative B is blocked by the binding table |
| L2 | Use `bodyAux.w` for restitution | Accept; flags go to the filter record per BODY_AUX_DESIGN §7 |
| L3 | Default combine rule | `'average'`; pairs in tests always set both bodies |
| L4 | `v_th` default 1.0 m/s and whether it is public | Accept for the experiment; decide exposure in the API phase from A6's measured headroom |
| L5 | CPU gates | Lead accepts A0/A1/A2/A3r/A4–A8 before runs; A3 is diagnostic only; no original height-goal waiver |

L1 remains unaccepted until the method has evidence and a concrete compatibility review.
This CPU experiment changes no public or advanced contract and does not reword G2's original
height target. API/default decisions remain proposals for the later GPU/API phase.

## 10. Implementation brief: 2D CPU method experiment (one slice)

**Model/effort:** Opus, medium. **Tracker:** STE-3329 (non-closing reference). **Delivery:** as
the lead assigns; default a topic branch from current `origin/main`, PR, no merge without the
lead's review of the measured table.

**Goal.** Measure §7 on the 2D CPU reference with the method of §3.1, without editing the
reference.

**Owned files (new only).**

- `src/avbd2d/experiments/restitution.ts`
- `tests/restitution-experiment.test.ts`
- `docs/RESTITUTION_DESIGN.md`: append one dated "Experiment results" section (measured table,
  command, commit). No other edit to this note.

**Not to be touched.** `src/avbd2d/ref/**`, `tests/fixtures/**`, `tools/cpp-oracle/**`,
`src/avbd2d/{soa,gpu}/**`, `src/avbd3d/**`, `src/lib/**`, `docs/API.md` (no public interface
changes), package exports, defaults, CI.

**Interfaces.**

```ts
export type RestitutionCombine = 'average' | 'min' | 'multiply' | 'max';
export function combineRestitution(a: number, b: number, rule: RestitutionCombine): number;
export interface RestitutionOptions {
  restitution: (body: Rigid) => number;   // 0..1, validated; no field added to Rigid
  combine: RestitutionCombine;
  threshold: number;                      // m/s
  impactPenaltyFloor?: boolean;           // variant V1
}
export class RestitutionManifold extends Manifold { /* bias per contact */ }
/** Creates RestitutionManifolds for uncovered pairs, then calls solver.step(). */
export function stepWithRestitution(solver: Solver, options: RestitutionOptions): { fired: number; maxApproach: number };
```

**Mechanism (all through public members of the reference).**

1. Before `solver.step()`, repeat the reference broadphase loop in the same order (`i` from last
   to 0, `j` from `i−1` to 0, same bounding-circle test, skip `constrainedTo`) and construct a
   `RestitutionManifold` for each hit. The reference's own broadphase then skips those pairs,
   and its existing `initialize() === false` path drops them. Force order is the reference's, so
   A0 can be exact.
2. `initialize()`: call `super.initialize()`; if it returns true, for each contact compute
   `v_n⁻ = JAn·vA + JBn·vB` from the bodies' current (step-start) velocities and store
   `bias = e·(−v_n⁻)·dt` when `e > 0` and `−v_n⁻ > threshold`, else 0. For V1, apply the impact penalty floor on the first `computeConstraint` call after the
   reference's warm-start decay, once per biased row per step: at least
   `min(positive dynamic masses)/dt²`, capped at `PENALTY_MAX`. No floor for unbiased rows.
   This avoids claiming a pre-decay floor is identical to the GPU's post-decay floor.
3. `computeConstraint(alpha)`: call `super.computeConstraint(alpha)`; for contacts with
   `bias > 0`, add `Math.min(0, −bias − (1 − alpha)·C0[0])` to the normal row. Contacts with
   `bias === 0` must execute no extra arithmetic.

**Tests (CPU, `node:test`).** One test per §7 row A0–A8 over the stated fixtures, parameter sets
and variants, with thresholds as written constants taken from §7; plus `combineRestitution`
unit cases and option validation (NaN, negative, > 1 rejected). Each measuring test also logs its
measured value for the results table. No assertion is derived from an observed value.

**Checks to run.** `pnpm typecheck`;
`node --experimental-transform-types --test tests/restitution-experiment.test.ts tests/avbd2d-ref.test.ts tests/avbd2d-behavior.test.ts`
(the last two prove the oracle is untouched); `git diff --stat origin/main` shows only the owned
files. No GPU, browser or benchmark run; **no parent hardware gate for this slice**.

**If a required criterion fails.** Stop, keep the failing assertion, record the measured value in
the results section and report to the lead. Do not loosen, skip, retune or switch variant to pass.

**Report back.** Branch, commit, checks run with output, the A0–A8 table per parameter set and
variant, the measured `η`-equivalent (`ρ`) and resting headroom, and any deviation from this brief.

## 11. Later phases (only after the lead accepts the experiment)

1. **GPU method slice** (§5): `wgsl-restitution.ts`, layout, pass, `setBodyAux` lane `w`, internal
   only. Parent hardware gates on the actual M4 Max/Metal non-fallback device: sphere drop
   `e ∈ {0, 0.5, 0.9}` against §7 A2–A5 restated for spheres, zero-mode command-trace and
   envelope identity, default 8-buffer device, fixed storage, pool/reset, Q2 A/B per §8.
2. **Public API and capability** (§6), with `docs/API.md` updated in the same change.
3. **SDF stage**, with its own contact-convention check and gate.

Open after all three: kinematic-mover rebound, oblique spin transfer, chain propagation through
stacks, and any behaviour on target hardware remain unmeasured until a scene asks for them.


## 12. Lead implementation boundary — Codex continuation

The first implementation is an experiment only, with immutable predeclared gates and bounded
fixtures. Separate harness correctness tests from method eligibility: a report may correctly
record a failed method. Keep failing measurements/raw cases; do not disguise a failed eligibility
check as a pass by changing the gate. No production shader or library changes follow until
reviewed evidence supports them.

Preflight all options and body coefficients before mutating an owned Solver. Existing ordinary
manifolds from prior plain stepping must be explicitly refused or deliberately handled, not
silently left without restitution. Coefficients are read once per body per step; no callback
re-evaluation inside solver iterations. Gate diagnostics count biased contact rows/step and
record the approach speed before and after; they are not proof of collision correctness.

The unchanged reference/defaults/fixtures remain read-only. Lead owns final documentation,
result acceptance and ticket/PR integration. A first falsifying case can stop further expansion
while the bounded report preserves completed and not-run cases.


## 13. CPU experiment results — 2026-11-10

[Source-qualified summary](measurements/restitution-cpu-2026-11-10.json), clean base `0f77819`,
contract committed as `ab0a438` before trials, then a recorded/hash-qualified new-file overlay.
Codex inherited Sol6.1 High implemented the experiment; the accountable lead reviewed it.
The original failed-provider draft and worker raw report remain preserved separately.

The experiment is in `src/avbd2d/experiments/restitution.ts`; the bounded report command is:

```sh
node --experimental-transform-types --no-warnings tools/restitution-experiment.ts --json
```

It emits JSON to stdout: 54 fixed drops and 12 rest/stack cases, no graphics or GPU. Harness
correctness tests are distinct from method eligibility; successful JSON generation does not
mean restitution is supported. No production solver, reference/default/oracle/fixture, library
export, rendering or dependency changed.

| Parameter set | Variant | A2 passes (of 6) | Original A3r height passes (of 6) |
|---|---|---:|---:|
| P-ref | V0 | 2 | 2 |
| P-ref | V1 | 6 | 6 |
| P-par | V0 | 2 | 1 |
| P-par | V1 | 6 | 5 |
| P-3d | V0 | 2 | 1 |
| P-3d | V1 | 6 | 5 |

**Neither P-3d variant is eligible for GPU promotion.** In the first falsifying case,
h=1 m, dt=1/60 s, e=0.5, both contact rows entered at -4.5 m/s. V0 returned about 2.25 m/s
(ratio 0.4999999914) but its sampled margin-referenced apex was 0.2327425619 m against the 0.25 m
target (-6.903%). V1 also met the impact ratio but reached 0.2277632468 m (-8.895%). The original
5% goal remains unchanged. A velocity-ratio pass does not substitute for a height pass.

All 18 zero-coefficient drops and 12 rest/stack zero controls exactly matched the plain Solver.
All 6 initially touching single-box rest cases matched the zero control with no firing;
P-3d's largest approach speed was 0.006171953 m/s. The six frozen Stack A6 cases failed at step 28,
but source inspection shows that fixture starts with 1 m gaps. The failed criterion is retained;
it cannot establish a quiet-stack defect. A corrected future resting-stack fixture would be
a new prospective protocol, not a replacement for this result.

A1 stays unknown: no contact-free zero-control apex was observed. A4's signed response ceiling,
absolute normal-speed proxy and first-apex limit are separate observations, not total mechanical
energy proof. Five-apex, coupled and oblique qualification remain notRun. Convergence is unknown;
fixed-J row residuals are recorded without inventing a tolerance after the run.

Final focused harness tests 14/14 and typecheck pass. Lead review tightened finite/missing-apex
classification, froze exported workload records and used Object.is for exact zero controls.
A new missing-apex regression failed before that fix; original worker report/hash is retained.
No full-suite, GPU, browser, build, performance or physical-certification claim follows.

**Next boundary:** investigate height loss and contact-memory/position handling in CPU before
selecting another method. Do not expose restitution, change the production contact buffer or
weaken the gate based on this experiment. The five-apex and initially settled-stack controls
also remain unfinished acceptance work under G2.


## 14. Follow-up diagnostic contract — before trace, 2026-11-10

Only the known P-3d first failure is traced: h=1 m, dt=1/60 s, e=0.5, variants V0/V1, 45 steps,
unchanged threshold/iterations and method. Read body pose/velocity and contact-row outputs after
each step. From the actual first-impact endpoint, advance a separate arithmetic-only free-flight
counterfactual (`v += g*dt; y += v*dt`) without feeding it into the Solver. Also record each step's
actual vertical velocity minus the prior actual velocity plus gravity. These are diagnostics,
not new acceptance gates, corrections or an energy proof. Preserve the frozen results above.
No production, reference, fixture or GPU change is authorized by this trace.


### Fixed trace observations

The final report was regenerated from the final source and remained byte-identical to the
pre-trace report. The 45-step traces use the same failing inputs. At step 29, after the impact,
actual vertical velocity exceeds a pure-gravity continuation by 0.0462478 m/s (V0) and
0.0232667 m/s (V1). Both current restitution biases and both final normal lambdas are zero.
These observations expose additional post-impact response but do not identify its precise
iteration/cache cause. A future source-level experiment must separate intermediate constraint
updates from final output; the trace is not a contact-impulse or energy measurement. It changes
neither method eligibility nor production behavior.


## 15. Prospective CPU attribution controls — before trials

The next slice tests two independent hypotheses on the same known failure, without changing
any previous eligibility gate or physics default. Both P-3d V0/V1 cases remain h1m,dt1/60,e0.5,
45steps. At most eight arms: each variant with baseline, impact-lambda release, existing
`stiffnessRescale` opt-in, and both controls. This is an attribution experiment, not a new
restitution implementation or a parameter search.

- **Impact-lambda release control:** after contact initialization/feature matching, clear only
  normal lambda inherited from a feature biased on the preceding step when that same feature
  now has positive separating normal velocity. Keep penalties/tangent lambda/contact geometry.
  Never clear an ordinary resting contact's lambda. Default off; coefficient-zero runs never
  acquire impact history. Record old lambda/release counts. This cannot repair a height failure
  by assertion; it tests whether that memory explains the next-step response.
- **Existing Hessian-rescaling control:** use the reference's existing `stiffnessRescale:true`
  on the owned Solver. It changes the clamped-force Hessian path, so its zero-coefficient control
  must be a matched plain Solver with that same option. Do not call it unchanged default mode.
  No reference implementation/default/fixture edit is permitted.
- **Fixed observations:** first-impact rows/rho and endpoint, step29 departure from free gravity,
  the subsequent body trajectory and apex within the45step trace, row bias/final lambda and
  option provenance. A release-only control must leave the first28body states exactly unchanged.
  Existing normal impulse/height goals remain reported; no new GPU-eligibility shortcut.
- **Diagnostic hypothesis screen:** a proposed elimination of the step29 free-gravity residual
  needs magnitude at most1e-10m/s in this f64 fixture. Retain nonzero/failing/unknown results;
  no retuning after observations. This is not a physical accuracy tolerance or energy proof.

The method remains CPU research. Whole-contract default report and default traces must remain
byte-identical to the delivered baseline. All original raw/failed records remain preserved.
Only the existing experimental module, report host and focused tests may change in the worker;
lead owns result acceptance/docs/Git/Linear. Coupled/oblique/GPU/public API stay gated.


## 16. Attribution-control observations — local Nov10 / UTC Nov11

[Source-qualified summary](measurements/restitution-memory-controls-2026-11-10.json), protocol
committed as `719b8ba` before trials. Only the experimental module/report/tests changed.
Command:

```sh
node --experimental-transform-types --no-warnings tools/restitution-experiment.ts --trace-memory-control
```

The release-only hypothesis fails: clearing both inherited normal lambdas changes neither
step29 residual nor apex in this fixture. V0 retains 0.0462477635 m/s; V1 retains 0.0232667481 m/s.
The reference's existing `stiffnessRescale` opt-in, alone or with release, reduces the residual
to about 4.44e-16 m/s in both variants. This is a controlled observation, not full iteration-level
causality, an energy proof or evidence that a GPU solver should enable the option.

**All eight arms still fail the original height gate.** With rescaling the sampled apex is
about 0.2227222 m, still below the 0.25 m target. Removing this residual is not sufficient to
qualify the restitution method. No production change follows from the control.

Release-only first 28 positions/velocities exactly match baseline. All zero-coefficient controls
match a plain Solver with the same rescale setting; opt-in rescaling is not relabelled default
behavior. Default 54-drop/12-rest JSON and default traces remain byte-identical to delivered
baseline evidence. The worker reports 18 focused harness tests and typecheck passing; lead
review reproduced the raw report from current source and verified those baseline identities.
No new GPU, browser, build, full-suite or performance check was warranted.

Original failed arms, unknowns and applicability limits remain. G2 stays In Progress. A further
method proposal must address finite-step contact/position handling before native restitution,
while retaining the original target and separate energy/coupled/quiet-stack acceptance.
