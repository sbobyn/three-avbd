# STE-3335: opt-in world-anchor policy proposal

Original design, 2026-11-10 Vancouver; approval/implementation follow-through is recorded below.
Both original legacy GPU gates remain failed. The separately named opt-in arm subsequently
passed bounded hardware checks; see [source-qualified evidence](measurements/world-anchors-2026-11-11.json).
Persistent Three AVBD lead owns integration. Temporary worker; no delegation, source edits or Git delivery.
Requested at dispatch: Codex gpt-6.1-sol, reasoningEffort high, after unavailable Claude; bounded design, local-only.
Worker reports that model/effort; host executedModel is unavailable/null, so requested settings are not host execution proof. Cost/usage unavailable. No claim of a Claude execution or model comparison.

## Snapshot and evidence

Physical pwd and Git root verified as `<managed review checkout>`.
Branch `feat/ste-3335-world-anchor-20261110`, HEAD `2a176d6c3300841b94f1b8f3b9d8e70136860c9f`;
local `origin/main` expected `234bebe57ecfeb989aee6fd433fc74a7f4d8edda`; sole fetch/push remote
`git@github.com:sbobyn/three-avbd.git`. No fetch, network, refs/index/commit changes.
Intake overlay: modified world.ts, index.ts, solver.ts and WORLD_ANCHORS_DESIGN.md;
untracked CPU/GPU world-anchor tests, diagnosis and scratchpad. All retained unchanged.
Instructions read: local AGENTS.md; canonical agent-config/AGENTS.md, docs/automatic-work-intake.md,
docs/team-and-model-routing.md; threejs-build/SKILL.md; relevant PLAN/FINDINGS/API sections.
This explicit note-only scope overrides normal implementation/API-map/full-check requirements here.

Candidate SHA-256 (relative paths, not just committed HEAD):
- `src/lib/world.ts`: `fdc1a0c3dafffc2a0fac24d6065f48175b55c22e282b3fd3d3f324e952a21a67`
- `src/lib/index.ts`: `8f7ab2d761f5266db8a85e05a8103965b9b0fd872ed557d267eecb5e94a705ba`
- `src/avbd3d/gpu/solver.ts`: `33d5ab14a5be036bac1bc9f381c32a57ab8dbcfb95a4d6b46ec919d43fe2bba5`
- `tests/world-anchors.test.ts`: `addd0780dba64f99988e60dc3fba6e343cedd52d4248b64917091bdc71f13ad1`
- `tests-gpu/world-anchors.gpu.test.ts`: `0097bebc201a6c98c60cefb3860e4c19518e5f108cfe8f2c0bb7266f8a5533e6`
The last hash includes the parent's retarget logging; do not compare against the old five-hash manifest.
Full pre-work source/docs/test/diagnosis-scratch hashes: `scratchpad/ste-3335-policy/before.json`.

Sources: [frozen protocol](WORLD_ANCHORS_DESIGN.md), [diagnosis](audits/world-anchors-diagnosis-20261110.md),
[reference initialization/primal/dual](../src/avbd3d/ref/forces.ts#L186),
[GPU warm start](../src/avbd3d/gpu/wgsl-solve.ts#L235),
[GPU row stabilization](../src/avbd3d/gpu/wgsl-solve.ts#L106),
[solve order](../src/avbd3d/gpu/solver.ts#L2190), [API map](API.md#architecture-and-repository-map).
Parent private evidence remains at `.git/feature-parity-plan-20261110/world-anchors/` in its canonical checkout:
pendulum-first.json/gpu-first.log, retarget-diagnostic.json/.log, parent-candidate-manifest.json,
diagnosis-manifest.json. Supplied evidence is accepted, not rewritten or rerun here.
M4 Max/Metal/Dawn 0.6.1/eight-buffer pendulum maximum 0.00258417532032685 m at step 4;
second gate residual 0.004481133371235788 m at step 244. Diagnosis predates that second logged number.
Removal/reuse hardware assertions after its convergence assertion were not reached.

## Recommendation and contract decision

Recommend a **per-handle explicit `policy?: 'legacy' | 'inertial-hard'`** on WorldJointOptions,
default `'legacy'`. Immutable after creation; unknown values throw atomically. No arbitrary numeric knobs.
This adds a public option to the local/unmerged candidate, whose option validator currently rejects it.
It also revises that candidate's claim of “no solver math or metadata change”; approval must name this.
The opted-in policy solves current linear anchor error every step, with a mass/timestep penalty floor;
it keeps angular freedom, existing iteration count, forces, velocity reconstruction and ordinary warm multipliers.
It is neither an exact rigid kinematic attachment nor a universal one-millimetre promise.

Concrete alternatives:
1. Seed penalties alone: fixes startup in the CPU control, provably leaves retained retarget error. Reject as incomplete.
2. Explicit inertial-hard: addresses both mechanisms, isolates compatibility; recommend bounded implementation for lead review.
3. Default inertial-hard on the new route: existing no-option fixtures could exercise it, but silently changes the reviewed
   candidate semantics for every new world joint. Requires explicit direction approval; not this recommendation.
Cold history reset alone still samples nonzero C0 and starts penalties at 1; it is not an alternative solution.

**Acceptance gate:** the two frozen tests currently call addWorldJoint without a policy. With recommendation 2 they
must continue failing as written. Preserve them and their raw failures. No honest design can both retain that default
and make those exact invocations exercise the opt-in. Before production implementation, the lead must explicitly
resolve whether an opt-in invocation amendment is acceptable (same physical fixtures, all samples, assertions,
1 mm limits, dt, iterations and default eight-buffer device), or obtain approval for alternative 3, or defer delivery.
Do not describe the amendment as an unchanged invocation, or weaken/skip the original tests to get green CI.
This is a direction/acceptance choice, not a routine worker tuning choice; Steven's supplied direction has not resolved it.

## Why this policy, mathematically

For a nearly solved stabilized hard row, C(next) ≈ alpha*C(start). For a 0.05 m jump and 240 steps,
0.05*.99^240 = 0.004481430935116232 m. Even an exact primal solve fails 1 mm.
The ideal bound would need alpha <= (.001/.05)^(1/240) = 0.9838320318344105, before load/roundoff error.
Choosing that boundary has no error budget and fits a single deadline. Instead declare **zero retained C0**
for opted-in dynamic ball rows: target the actual current constraint, not a fraction of yesterday's error.
Zero C0 at every positive-step preparation makes existing primal AND dual formulas use C, regardless of pc.alpha.
Global alpha still controls ordinary constraints and lambda warm decay; do not change it or angular/contact rows.

Let r=R*anchorBody, J=[I,-[r]x], D=diag(m I3,Iworld), and h=dt.
The anchor mobility W=J D^-1 Jᵀ=(1/m)I3-[r]x Iworld^-1 [r]x is positive definite for m>0, SPD inertia.
Effective inertial anchor stiffness is Hc=W^-1/h² (N/m). Rotational mobility depends on the anchor lever and
principal moments; W >= (1/m)I implies Hc <= (m/h²)I in the PSD order, including r=0.
Use the conservative isotropic floor **kappa=max(PENALTY_MIN,m/h²)**, not an arbitrary fit multiplier.
For the isolated linearized augmented solve, each residual mode contracts by Hc/(Hc+kappa I) <= 1/2
per primal/dual cycle with frozen geometry. This is local reasoning, not a nonlinear/contact convergence theorem.
Twenty iterations provide margin without changing the frozen 20. Penalty units are N/m; lambda units N;
rotational inertia is kg m². Existing body-size torqueArm is for angular rows, not this linear floor.
For the 1 kg fixture kappa=14400 N/m; the second fixture is .01 kg, giving 144 N/m, not 14400.
Fresh penalty 1 versus inertial 14400 explains weak early support; BIG caps hardness, it is not initialization.

Preparation follows ordinary warmStartJoints: preserve its cold lambda clearing and alpha*gamma warm decay,
then zero C0Lin.xyz and floor penLin.xyz after decay/cold initialization, every enabled dynamic opted-in step.
Retain beta ramp and PENALTY_MAX=1e10; do not reset lambda on every retarget or step.
A retarget still writes only copied/coalesced J_RA at flush; the new stabilization semantics take effect only
on the next positive-dt solve. No pose/velocity projection, synthetic anchor velocity or implicit readback.

## Minimal GPU route and explicit ABI consequence

Prefer one private preparation module `src/avbd3d/gpu/wgsl-world-anchor-policy.ts`, **not a solveWGSL variant**.
After warmStartJoints and before warmStartBodies, dispatch it only when policy handles exist.
Read params/bodies/info, write joints: same group-0 bindings 0/1/2/3 and existing solve layout/group;
no new buffer, uniform, storage binding, stride, body, adjacency, shader feature or solve architecture.
Existing solve layout has eight storage bindings; this entry uses three of those storage resources.
Extra cost: one pipeline/module plus up to one O(jointCount) preparation dispatch per step, small record reads/writes;
CPU validation/bookkeeping also added. Neither cost nor target hardware performance measured here.

Mark opted-in rows by **info[slot].w = 1**, only for T_JOINT/-1/B with hard linear/zero angular stiffness.
Zero remains legacy. This IS a metadata ABI extension: jointInfo() currently documents fourth word as zero
[solver.ts:2318](../src/avbd3d/gpu/solver.ts#L2318). Version/document it internally and in parent API maps;
do not claim all metadata stays identical for opted-in rows. Keep JOINT_FLOATS=40/160 bytes, info stride=16 bytes.
All legacy constructors/writeJoint/appendConstraints continue writing zero; only the new route opts in after validation.
Release clears marker; allocation growth copies it with existing info; no world policy may survive slot reuse.
No bits are stolen from torqueArm, spring rest, C0 padding or public material fields.

Default exported solveWGSL, built-in body-aux/native-sensor math, CPU oracle and fixtures stay byte-for-byte unchanged.
The extra module changes only opted-in joint state before their existing math. Native sensor activation swaps primal/
dual pipelines, so it cannot remove this independent preparation. Audit destroy/growth/bind-group reconstruction.
Advanced old readers still stride correctly, but a reader requiring info.w==0 needs the explicit extension notice.
Custom solve/contact modules, sensorProof and SDF refuse the new policy before mutation; no promise they apply it.
Retain public route's backend guards and block switching backend with holding handles. Direct advanced replacement
remains outside the guarantee. If metadata compatibility or ordering cannot be maintained, stop rather than widen scope.

## Bounds and lifecycle

All admissions/retargets must preserve existing identity, copied-anchor, capacity and finite-f32 torque-arm checks.
Additionally validate the opted-in active m/h² is finite and <= PENALTY_MAX before submission; refuse rather than
silently cap away the derived floor. Revalidate after dt/mass changes; validation must precede queue/capacity mutation.
Fixed m=0 bypasses preparation: prescribed pose stays prescribed, no division by zero; dynamic resumption recomputes floor.
Require positive finite dynamic mass and SPD principal inertia representable in f32, including finite reciprocals.
No gravity-based denominator: zero gravity and gravityScale=0 work identically. Zero iterations means no correction
promise; dt=0 stays invalid. Flush/read/update(0) changes no body pose or clock and performs no policy solve.
Disable skips preparation/participation and retains target/marker; enable/reset use existing cold behavior then floor.
Fixed warm history remains ordinary; returning dynamic uses current-error rows without a promised transient energy bound.
Sensors still receive joints/gravity/standing forces, while collision nonresponse stays unchanged.
Remove/body removal/pool release/destroy cancel by handle identity; policy follows a life, never a recycled numeric slot.

Finite inputs alone do not guarantee finite arithmetic. Check floor and lever-arm products in f64 before f32 packing;
reject overflow/underflow in required intermediates, including kappa*|r|², inertia/h² and squared force/penalty norms.
Huge anchors can lose 1 mm in f32 subtraction long before overflow; a coordinate ULP >= 1 mm is already outside
this accuracy envelope. Do not clamp/rescale anchors or promise huge-coordinate support; refuse such policy inputs.
These necessary admission checks are not a proof for unbounded velocities, force, pose writes or conflicting joints.
A complete runtime numerical-domain guarantee is not supported by this evidence; stop on nonfinite hardware state.
Retarget/teleport and abrupt current-error correction can inject energy. No passivity, physical correctness,
determinism, arbitrary-force accuracy, large-scale stability or performance claim. Spring damping stays separate K0 scope.

## Two scratch controls and next implementation slice

Command: `node --experimental-transform-types --no-warnings scratchpad/ste-3335-policy/controls.ts`
(exit 0, shell wall time 0.10 s, not a benchmark); output `scratchpad/ste-3335-policy/results.jsonl`.
Unchanged reference imports; wrapped Joint.initialize instance only; proper (x,y,z)->(x,-z,y) rotation as diagnosis.
Exactly two predetermined policies, each pendulum 1200 steps, isolated retarget 240, fixed/standing-force analogue 240.
No tuning/sweep: floor from m/h²; second control additionally zeros C0 every dynamic step.
Floor-only: pendulum max 7.353829387e-10 m, retarget final .0044814309351 m,
force analogue .0044814309268 m. Floor+zero-C0: pendulum max 6.083688313e-10 m,
retarget final 0 m, force analogue 1.624353417e-16 m; all sampled state finite.
The analogue omits GPU lifecycle/cold/startAtRest/f32 kernels; these numbers support design only, never hardware acceptance.

One ready **local-only** slice after lead reviews the contract and resolves the acceptance decision:
- Owner: one implementation worker, no delegation; exact checkout/head/overlay above, refreshed by lead.
  Scope: world.ts/index.ts option/handle, solver.ts preparation ownership, new private WGSL module,
  layout.ts metadata constant/comment, focused world-anchor CPU tests. Parent owns API docs and GPU fixtures/delivery.
- Device-free checks: existing focused world-anchor/joint tests plus typecheck; test options/default byte invariance,
  rejection atomicity, formula/finite bounds, command order, cold/reset/retarget/fixed/disable/sensor behavior,
  adaptive/fixed growth and release, pool reuse/stale handles, custom/SDF refusals, teardown and eight-buffer layout.
  CPU fakes prove dispatch/records, not convergence. Keep scratch controls/reference sources unchanged.
- Parent hardware: retain both original failed/raw protocols; run the explicitly approved invocation with unchanged
  two physical gates, thresholds, full startup samples, steps, read stamps and default-eight M4/Metal qualification.
  Reach final removal/reuse assertions; check default ordinary joints/legacy bytes and finite records alongside opt-in.
  Verify mixed ordinary+policy joints and sensor pipeline activation retain behavior; packed consumer checks new
  option/export plus ordinary Joint.a/b typing and advanced jointInfo stride/marker. Required pnpm check remains
  a later integration gate, not run or passed by this design worker.
- Stop if either gate fails, finite/domain validation is unresolved, ABI retention needs another binding/stride,
  ordinary/default source behavior changes, or custom/SDF support/solver redesign is needed. Return evidence;
  no threshold/default/iteration/substep tuning, no oracle/fixture regeneration, no unreported pose projection.

No GPU/Dawn/browser/server/render/full suite/typecheck/build/install/network/benchmark executed here.
Final SHA-256 comparison: all 582 pre-existing source/docs/test/diagnosis-scratch files unchanged;
see `scratchpad/ste-3335-policy/preservation.json`. Branch/HEAD and local origin/main verified unchanged.
No PR/commit/push/merge/cleanup; existing lead and all supplied preservation holds remain in place.

## Lead decision — opt-in arm, 2026-11-11 UTC

Accepted for bounded **local implementation**, not public delivery or physical acceptance:
`policy: 'inertial-hard'`, immutable per world-point handle; omitted/`'legacy'` retains
existing behavior. No ordinary joint/default/oracle or exported solve shader change.
The new marker in info.w must be explicitly versioned/documented; no stride change.

Acceptance amendment is explicit: a **separate opt-in invocation** will exercise the
new policy against the same physical fixtures, full startup samples, dt/iterations/steps,
default-eight hardware and 1 mm limits. This does not turn either original no-option
invocation into a pass. Original frozen and observation-only fixtures, raw samples and
failed logs remain preserved privately; legacy results remain failed quality observations.
No success claim or PR merge until the opt-in arm, compatibility/lifecycle checks and
packed consumer pass. Parent must describe this invocation amendment in delivery docs.
An unresolved numerical-domain or metadata compatibility risk stops implementation.
