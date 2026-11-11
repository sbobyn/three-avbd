# STE-3335: bounded failed world-anchor diagnosis

Research receipt, 2026-11-10 Vancouver / 2026-11-11 UTC. Temporary Codex worker,
gpt-6.1-sol High, explicitly authorized continuation after unavailable Claude access.
Local-only; persistent Three AVBD lead owns integration and acceptance.

## Source and authority

Physical checkout/Git root verified as assigned `t3-909a1b93-551f272b2303bba4`;
branch `feat/ste-3335-world-anchor-20261110`, HEAD
`2a176d6c3300841b94f1b8f3b9d8e70136860c9f`. Supplied base main `234bebe`.
Sole remote verified `git@github.com:sbobyn/three-avbd.git`; no network/Git writes.
Initial overlay: world.ts, index.ts, solver.ts, WORLD_ANCHORS_DESIGN.md modified;
world-anchors CPU/GPU fixtures untracked. This report and scratchpad are the only new writes.
Read local/canonical AGENTS, intake/routing, threejs-build, relevant PLAN/FINDINGS,
frozen design and failed checkpoint. No implementation or oracle edits.

**Both hardware gates remain failed.** Supplied raw `pendulum-first.json` and
`gpu-first.log` were read, never rewritten. Actual recorded device is Apple M4 Max,
Metal metal-3, Dawn 0.6.1, Node 25.2.1, default eight storage buffers;
fallback field unavailable/null, hardware identity accepted by parent.
No GPU/Dawn/browser/server/render/build/full-suite/install or benchmark run here.

## 1. Record, registration and topology

[solver.ts:1544](../../src/avbd3d/gpu/solver.ts#L1544) legacy
`appendJoint(-1,b,rA,rB,Infinity,0)` and new `appendWorldJoint` produce the same
fresh physical constraint: T_JOINT/-1/B, BIG linear stiffness, zero angular stiffness,
zero penalties/lambdas, identity rests, BIG fracture/yield/bend limits, B-size-squared arm.
Focused fake-device comparison **asserted all 160 bytes and full endpoint info arrays
identical**, separately for adaptive and fixed storage, slot 0/body count 1.
The control used fake-device metadata size [.1,1,.1]; it executes no physics.

The material differences are admission validation and released-slot allocation:
new route uses `appendConstraints` in both storage modes; legacy adaptive append grows
monotonically. Both register identical endpoint info and call `noCollide` (negative A
creates no exclusion). New World flush maps its handle to that route, then writes any
coalesced target: [world.ts:1951](../../src/lib/world.ts#L1951).
No new shader path, adjacency representation or hidden body is introduced.

Source topology: [layout.ts:354](../../src/avbd3d/gpu/layout.ts#L354) rejects negative
indices as dynamic and accepts negative A for active joints. Shared
[wgsl-topology.ts:68](../../src/avbd2d/gpu/wgsl-topology.ts#L68) counts/fills only dynamic
endpoints. Thus one active dynamic B gets one adjacency entry, no world entry;
[wgsl-solve.ts:464](../../src/avbd3d/gpu/wgsl-solve.ts#L464) dispatches the joint before
contact `pairBody` access. This is source reasoning, not a GPU adjacency readback.

A separate CPU diagnostic with a zero-size, zero-mass fixed A instead of null A gave
identical pendulum results. That extra body is **only a reference control**, never a
replacement for the frozen maxBodies=1 hardware gate. Nonzero fixed-A geometry changes
torqueArm, but that arm multiplies disabled angular rows for this ball joint.

## 2. Startup mechanism and reference reproduction

Unmodified reference `Solver` + `Rigid` + `Joint(null,B,...)`, dt 1/120, iterations 20,
alpha .99, betaLin 10000, gamma .999, mass 1, same geometry and zero velocities.
CPU oracle gravity is z-only, so apply the proper coordinate rotation
`(x,y,z) -> (x,-z,y)` to position, size, quaternion and local pivot; gravity becomes -z.
This preserves the physical problem; no alternate body definition in the actual gate.

| Step | CPU pivot error, mm | Recorded Metal error, mm |
|---:|---:|---:|
| 0 | 0 | 0.000008683 |
| 1 | 0.606683272 | 0.606672880 |
| 2 | 1.459008057 | 1.459003610 |
| 3 | 2.212332485 | 2.212341533 |
| 4 | 2.584152847 | 2.584175320 |

CPU max 0.0025841528474610086 m at step 4; RMS 0.0006078506343321073 m/1201 samples.
Metal max 0.00258417532032685 m at step 4; RMS 0.0006078189403228895 m/1201.
The step-4 error difference is 2.2473e-8 m. RMS is descriptive, never substitute acceptance.

Observed source mechanism, supported by wrapped-instance CPU iteration traces:
- Fresh penalties start at zero, then initialize to PENALTY_MIN=1, even for hard rows.
  “Hard” selects dual accumulation/stabilization, not infinite primal penalty.
  [forces.ts:186](../../src/avbd3d/ref/forces.ts#L186),
  [wgsl-solve.ts:235](../../src/avbd3d/gpu/wgsl-solve.ts#L235).
- Body translational inertial stiffness is mass/dt²=14400. Step 1 begins with almost
  free gravitational displacement: first primal residual 0.681186 mm, versus
  free fall 0.681250 mm. After 20 iterations it is still 0.606683 mm; penalties
  in transformed coordinates are [4.957374,1,131.650082]. BIG is the cap/stiffness,
  not the initial penalty. Contact massPenalty does not initialize joint rows.
- Step-start C0 is sampled **before body prediction**, then hard rows solve
  `C - alpha*C0`; dual adds `penalty*(C-alpha*C0)` and ramps penalty by
  `betaLin*abs(C-alpha*C0)`. This intentionally retains most existing error per step.
  [forces.ts:205–279](../../src/avbd3d/ref/forces.ts#L205),
  [wgsl-solve.ts:106](../../src/avbd3d/gpu/wgsl-solve.ts#L106),
  [wgsl-solve.ts:561](../../src/avbd3d/gpu/wgsl-solve.ts#L561).
- After step 4, raw C=[-1.417780,0,2.160497] mm; stabilized residual is only
  [-0.352478,0,0.246823] mm. Gravity, body prediction/velocity history and initially
  weak accumulated support add error while stabilization retains the preceding error.
  Lambda/penalties build over steps; this explains the startup peak in the reference.

Coordinate handling is consistent: world A is rA directly, B is pos+rotate(q,rB).
Both solvers initialize joint C0 before predicting bodies. GPU has additional startAtRest
and lifecycle cold branches; reference is f64, GPU f32/possibly fused arithmetic.
Their close early errors strongly support inherited solver behavior, **not proof of
bitwise GPU intermediate causality**. No GPU penalty/lambda/C0/adjacency samples were
available. No evidence here supports a new coordinate-frame or registration defect.

## 3. Retarget, reset, fixed state and force

[GPU fixture:59](../../tests-gpu/world-anchors.gpu.test.ts#L59) uses **density default 1**,
so its mass is .01 kg, unlike the 1 kg pendulum. Disabled steps retain target/capacity.
Reset clears body motion/history and forces; re-enable marks cold. Fixed step keeps
position [.2,-.5,0] despite target [.3,0,0]. Cold joint initializes penalties/lambda,
but enabled fixed B still participates in joint warm/dual updates; no dynamic primal
moves it. After that step cold clears. `setFixed(false)` zeroes velocities, without
resetting joint history. Retarget to [.25,0,0] changes only J_RA, leaving a 5 cm mismatch.

Sources: [world.ts:492](../../src/lib/world.ts#L492),
[world.ts:1386](../../src/lib/world.ts#L1386),
[world.ts:1692](../../src/lib/world.ts#L1692),
[body-reset.ts](../../src/avbd3d/gpu/body-reset.ts),
[solver.ts:1910](../../src/avbd3d/gpu/solver.ts#L1910).
Zero gravity makes adaptive gravitational prediction weight zero (no division-by-zero
propagation in either solver). It does not disable C0 stabilization or dual warm history.
`applyForce([1,0,0])` is a standing force for **all 240 steps**; clearForces occurs after
the final read, not after one step. World.push/Pusher apply Δv=F*dt/m before each solve.
Retarget neither clears nor consumes this force, consistent with the approved contract.

Bounded CPU controls, no defaults changed:
- Isolated zero-gravity 5 cm target jump, mass .01 kg, **no prior history or force**:
  residual after 240 steps **0.004481450684295611 m**.
- Idealized stabilized convergence `0.05 * .99^240` = **0.004481430935116232 m**.
  Thus even a nearly exact solve of the stabilized row does not imply 1 mm at step 240.
- CPU analogue of reset pose → fixed target .3 for one step → dynamic target .25
  plus 1 N each step: residual **0.00448142384762504 m**. Fixed step accumulated
  penalty [201,1,1], lambda [1.92,0,0]; it did not move the body.

These controls reproduce failure without a retarget write bug or force-history bug.
The analogue omits GPU lifecycle kernels and startAtRest; it is not hardware acceptance.
**Unknown:** actual second-gate numeric residual/pose/joint state, not logged in first run.
A near-4.48 mm hardware residual would support this mechanism; another residual needs
inspection. Failure aborts that test before its final remove/reuse assertions execute.

## 4. Decision and next bounded slice

No implementation-specific bug is proven; there is no justified corrective patch to hand
back. Changing only handle registration cannot fix an error reproduced by the oracle.
Keep the API candidate **local/unmerged**, STE-3335 partial, original failures intact.
A design review must explicitly choose whether to authorize an opt-in hard-anchor
initialization/stabilization policy while retaining oracle/default behavior, or defer
this API's acceptance. That policy is not designed or authorized by this diagnosis.
Do not lower 1 mm, increase iterations/substeps, discard startup samples, tune defaults,
relabel RMS as a pass, or assume cold-start/retarget history resets alone fix both gates.

Smallest next evidence slice for the parent hardware owner: log second-gate final
residual/pose and submitted step; if needed capture first four pendulum joint records
(C0, penalties, lambdas) and compare with these traces. A short legacy append control
can confirm hardware route equivalence without replacing the public one-body fixture.
No broad parameter sweep/new architecture is justified. Any approved correction must
then pass **both original unchanged hardware gates**, preserve ordinary joints/default
oracle behavior, ownership/capacity/retarget command semantics, finite records and counts.
Full repo gate remains outstanding; this report does not declare implementation done.

## Commands, limits and preservation

Ran CPU-only Node 25.2.1 scratch controls (each <1 second):
`node --experimental-transform-types --no-warnings scratchpad/ste-3335-diagnosis/records.ts`
and `node --experimental-transform-types --no-warnings scratchpad/ste-3335-diagnosis/cpu.ts`.
Records control initially hit a scratch-only Array-vs-TypedArray `.set` error; corrected
scratch metadata assignment and reran successfully. Both fixed/adaptive equality assertions
pass; reference simulations complete with the failing residuals above, not passing gates.
Scratch `cpu-output.json` holds full CPU trajectories; `cpu-summary.jsonl` includes traces.
No tests/fixtures regenerated; no full suite, typecheck or build was warranted/run here.
All five manifest SHA-256 values rechecked unchanged after work; branch/HEAD unchanged.
No PR/commit/push/merge/cleanup. Candidate/shared Git, live sessions, other worktrees,
recovery evidence, canonical installs and user-controlled releases remain untouched.
