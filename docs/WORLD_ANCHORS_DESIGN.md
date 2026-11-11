# K0 first slice: public world-point ball joint

Design proposal, 2026-11-10; implementation/integration approval belongs to the persistent lead.
Source: `234bebe57ecfeb989aee6fd433fc74a7f4d8edda` (`origin/main` at intake),
branch `plan/ste-3335-world-anchor-20261110`; clean before this new document.
Existing issue: **STE-3335**, design-only In Progress per the supplied lead brief.
This is one partial K0 contract, not completion of that issue or programme STE-3326.
No source, tracker, Git delivery, hardware or executable checks are authorized here.

## Decision and boundary

Recommend **`World.addWorldJoint(body, options): WorldJoint`**, a named, ball-only route.
Require an explicit world point and accept an explicit local body point, defaulting to zero.
Expose **`WorldJoint.setWorldAnchor(point): void`** for retargeting through the existing solver write.
Do not add `addJoint(body, null, ...)` in this slice: ordinary `Joint.a/b` remain non-null `Body`.
Do not add a dummy fixed body, hidden body ID, pool lease, or `maxBodies` reservation.
No solver math, shader, record stride, bind group, or advanced `JointSpec` semantics change.
World-fixed rotation, plasticity, fracture and world springs are deferred, explicitly refused options.
This narrower first contract satisfies the original world-pendulum goal without bundling spring damping.
The lead must approve the named method and the ball-only subset before implementation.

The supplied status is reused, not re-audited: G1 complete; G3 native sensors PR #98 merged
at this source after 109 CPU/105 actual M4 Max GPU checks plus type/build/packed-consumer work.
Those counts are supplied evidence, not runs performed by this author. G2 restitution failed
its original height gates and stays unsupported/In Progress; it is not a dependency of K0.
STE-3330 Done describes bounded native functionality, not release, physics/performance or human acceptance.

## Source observations (relative links inspected at the pinned source)

- [World and handles](../src/lib/world.ts): `World.addJoint`, `addSpring`, `Joint`, `checkPair`,
  `checkJointRoom`, `removeBody`, `removeJoint`, `flush`, `beginRead`, `readJoints`, `destroy`.
  Ordinary joint options use local `anchorA/B`; `rest: 'current'` samples CPU-known rotations.
  Springs infer default length from those CPU-known poses; neither is a suitable implicit world anchor.
- `Joint.a/b` are public `Body`; `suspended` dereferences both. `flush` maps both `.index` values;
  body removal scans both fields. Private queues/sets, break listeners and readback decoding use `Joint`.
  A nullable overload alone would leave these consumers invalid and force a public return-type migration.
- [Solver](../src/avbd3d/gpu/solver.ts): `JointSpec` / `appendJoints` validate both indices >= 0
  before taking slots; torque-arm construction dereferences both bodies. Keep these checks unchanged.
  `writeJoint` already maps reference `bodyA === null` to `a = -1`; B must be a real body.
  `appendJoint(-1, b, rA, rB, stiffnessLin, stiffnessAng)` already constructs that representation.
- `appendJoint` uses `checkEndpoints` and reusable `appendConstraints` only in fixed storage;
  its adaptive path increases `jointCount` even after release. Do not adopt that churn behavior.
  `appendConstraints` reuses released slots, grows adaptive storage and preflights fixed capacity.
  `freshJoint` initializes finite BIG thresholds and identity rests; use it, not GPU Infinity.
- `noCollide` returns early for negative A: a world point creates no ignored body pair.
  `releaseJoints` clears records, marks T_NONE, releases exclusions and returns slots to the free list.
  `setWorldAnchor` currently writes three floats at J_RA, with no ownership/type/slot validation.
- [Reference Joint](../src/avbd3d/ref/forces.ts): `Joint(null, bodyB, ...)` uses world `rA`,
  body-local `rB`, zero A size for torque arm, identity world rotation, and optional angular stiffness.
  This establishes the representation; reference support alone does not certify the public lifecycle.
- [GPU drag](../src/avbd3d/gpu/sim.ts): `startDrag` uses world-A/body-B with finite linear stiffness
  and angular zero; `moveDrag` calls `setWorldAnchor`; `endDrag` disables rather than releases.
  Reuse anchor writing, not soft drag stiffness or its slot ownership policy.
- [Solve WGSL](../src/avbd3d/gpu/wgsl-solve.ts): `anchorA`/`rotA` handle negative A;
  warm start and dual check enabled A only when nonnegative, always check B.
  `PairBody`/`pairBody` belong to contact evaluation; do not feed -1 to unsigned `pairBody`.
  T_JOINT follows `addJoint` before the contact pair path; T_SPRING dereferences both bodies.
- [Layout/topology](../src/avbd3d/gpu/layout.ts): JOINT_FLOATS = 40, `jointActive` permits negative A,
  requires enabled B, and `dynamicBody` rejects negative indices. No new topology representation needed.
- [BodyMesh](../src/lib/mesh.ts) consumes body slots/buffer and `Body` identity, not joint endpoints.
  It must see exactly the same body/instance counts; a world anchor is not renderable body storage.
- [Capabilities](../src/lib/capabilities.ts): lifecycle/pooling/sensors are standard-backend scoped;
  body aux support is independent. SDF already has joints, but that is not a lifecycle promise.
  [API](API.md), [plan](PLAN.md), [findings](FINDINGS.md), [package scripts](../package.json)
  qualify current interfaces, historical evidence, and the unchanged required `pnpm check` gate.

## Proposed public surface and endpoint semantics

```ts
interface WorldJointOptions {
  anchorWorld: Vec3;       // required world-space metres; copied, no pose inference
  anchorBody?: Vec3;       // body-local metres; default [0, 0, 0]; copied
}
// World.addWorldJoint(body: Body, options: WorldJointOptions): WorldJoint
// WorldJoint: readonly world: World; readonly body: Body; readonly type: 'ball';
// getters anchorWorld: Vec3; anchorBody: Vec3; holding: boolean; suspended: boolean;
// setWorldAnchor(point: Vec3): void; remove(): void;
```

`WorldJoint` is a separate exported handle, not a `Joint` subtype or a `Joint` return.
No public `a/b`, `rest`, `restRotation`, `force`, `bend`, `broken` or break callback contract is added.
`body` always denotes internal B; the world is internal A. The public call's first argument
therefore maps to **B**, not A. There is no reordered quaternion/rest interpretation to hide.
The anchor getters return copies of requested command state, never claimed GPU observations.
`holding` means registered and not removed and world live; `suspended` means holding and body disabled.
The first slice is nonbreaking: world handles never enter `onBreak`, preserving its `(Joint) => void` type.
Ordinary `Joint` creation/getters/break state and existing listener signatures remain unchanged.

Anchors coincide when `pB + rotate(qB, anchorBody) == anchorWorld`. Caller supplies both frames;
no implicit inverse transform, cached body position, GPU readback, or GPU-to-CPU synchronization.
An off-centre body-local anchor permits a pendulum; attaching the centre alone does not test swinging.
Hard linear rows use BIG, angular stiffness is exactly zero: orientation remains free.
Unknown options must be rejected on this new narrow route (including `type`, `rest`, `anchorA/B`,
`yieldForce`, `breakForce`, `breakOnPull`, `breakBend`, `stiffness`, `damping`); do not silently ignore them.
In particular a requested fixed world frame must fail, not produce a freely rotating ball joint.

For clarity about deferred semantics: existing fixed joints default to equal rotations; ordinary
`rest` holds `rotB = rotA * rest`; `current` uses last readback/explicit assignments, potentially stale.
The internal world frame has identity rotation, so a future fixed world joint would hold `qB = rest`,
not the inverse body orientation. A future `current` would need an explicit freshness contract.
This slice accepts neither fixed nor `current`, avoiding any default stale CPU pose capture.

## Commands, validation and ownership

Validate live World, actual same-owner live Body, supported backend, options and exact three-number
finite-f32 anchors before any mutation, slot reservation, counter change or GPU write; copy inputs.
NaN, Infinity, malformed lengths, f32 overflow, foreign/removed bodies and unsupported options throw.
Use the existing identity owner check; do not treat matching numeric indices as matching bodies.
A failed request leaves pending queues, free slots, ignored pairs, body IDs and pool reservations unchanged.
Capacity counts ordinary joints, springs, queued/placed world handles together; fixed exhaustion throws
`StorageCapacityError('joints', ...)` at the public call. Adaptive allocation failure follows existing
solver-failure cleanup, not a promise to recover from arbitrary device allocation failure.

Maintain a separate pending world-handle queue and placed set; count both in `checkJointRoom`.
After body/full/lifecycle flush and ordinary joint placement, append world constraints through one
new **internal** solver route `appendWorldJoint(b, anchorWorld, anchorBody): number`.
Validate B and copied finite anchors first; use `appendConstraints(1, fill)` with `freshJoint`,
BIG linear / zero angular stiffness, zero warm state, existing B-only torque arm, T_JOINT/-1/B.
Do not widen `JointSpec`, relax `appendJoints`, change ordinary `appendJoint`, or refactor all constructors.
This additive internal method is visible on the advanced solver class: lead reviews its declaration;
no advanced record ABI change is proposed. Return a blocker if existing helpers cannot preserve this boundary.

Retarget is copied and coalesced by handle; pending handles carry the latest point into construction.
Placed handles queue one `setWorldAnchor(slot, point)` at the next command flush, after construction.
A flush means existing `step`, `read`, or explicit `flushCommands`; `update(0)` alone need not flush.
Creation/retarget/read/flush alone advances no clock; only positive-dt steps solve the constraint.
Retarget changes J_RA only: no rest/warm-state reset, body velocity rewrite, impulse, force clearing,
or synthetic anchor velocity. Teleporting a target can inject energy; this is not spring damping.
An already-submitted step/read is not changed by a later command. A later read sees the new target
command but does not imply the body has solved it. No automatic readback on add/retarget.

`remove` cancels pending creation/retarget or releases the placed slot exactly once; repeat is a no-op.
Retarget after removal, body removal or World destruction throws before any queue/write.
Remove a holding handle after World destruction throws (matching ordinary Joint resource discipline).
On body removal or pool despawn/release, remove all its world handles by **Body identity** first;
remove-body scans must include the new sets, including handles that have never been flushed.
Retarget/remove commands belong to handles, not persistent slot IDs; reusing a slot cannot revive them.
Destroy clears pending commands/sets without post-destroy queue writes; held getters become false.
No breakability/force watch is introduced, no new automatic joint read, no hidden counters or body slot.

## Runtime coverage and explicit refusals

Standard built-in shaders: accept dynamic or fixed, enabled or disabled bodies, including pool leases.
A fixed body remains prescribed: the joint does not move it to the anchor; a fixed misalignment is not
promised to resolve. Making it dynamic resumes the existing constraint. Explicit body pose/reset writes
retain the anchor and may initially violate it; reset/re-enable use existing cold-start behavior.
Disable retains joint capacity and target; enabled B resumes participation on subsequent steps.
Forces/impulses retain existing enabled/body ownership rules; anchor retarget neither consumes nor
re-times them. A sensor remains subject to joints/gravity; its collision response exclusion is unchanged.

First public route refuses SDF preparing/on and custom shaders/collision backends before mutation.
Do not describe ordinary SDF joints as unsupported; this is a conservative scope for the **new route**.
Block public SDF enabling while any pending/placed world handle is holding, before backend preparation.
Remove all such handles first; no silent conversion or destruction. Advanced direct backend replacement
is outside the public route's guarantee; document that escape hatch rather than claiming full enforcement.
No new capability flag is required: method documentation states standard-only, and runtime validates it.
At eight versus nine storage buffers, keep existing shape/collision fallback truth: world joints add
no bindings, no shape support and no mandatory optional WebGPU feature. Do not infer GPU acceptance
from a negotiated limit alone; parent probes and validates the actual built-in configuration.

## Predeclared acceptance (parent hardware owner)

One dynamic box, no other bodies/ground/contacts: `maxBodies: 1`, size [0.1, 1, 0.1] m,
mass 1 kg via density 100 kg/m³; local pivot [0, 0.5, 0], world pivot [0, 0, 0].
Start rotated 20 degrees about +z and place centre at `-rotate(q, localPivot)` so initial error is zero;
velocities zero, gravity [0, -9.81, 0], body gravityScale 1, body damping zero, sensor false.
Use dt = 1/120 s, 20 iterations, remaining default solver parameters, 1200 steps (10 seconds).
After each step, await `world.read([body])`, require returned `step` equals that submitted boundary;
no intervening step, reset or pose write. Compute Euclidean error from the returned GPU pose:
`|position + rotate(rotation, anchorBody) - anchorWorld|`. All samples including initial must be finite;
**maximum <= 0.001 m** over the whole window. Record maximum, RMS, sample/step and actual device.
Also require orientation change > 0.01 rad from the initial pose, unchanged live/body/instance counts,
and no second body allocation.
No CPU cache, reference pose or initial anchor coincidence alone may stand in for this measurement.
Read/flush without stepping (including `update(0)`) is a separate command test; dt=0 is invalid under
`checkDt`, not an invented zero-dt solve. Never relax 1 mm or tune after looking without lead review.

Parent first probes actual hardware adapter/backend (M4 Max/Metal, not fallback/software); if absent,
report unrun/blocked. No new M1/GTX performance claim. Bounded additional hardware cases cover retarget
at a known step boundary, disable/enable, reset and a queued force with retarget: assert clock/order,
finite state and convergence to the requested anchor, not unchanged trajectories or analytic damping.
The 5% analytic damped-oscillator envelope belongs to later spring damping and remains outstanding.

## One ready implementation brief — partial STE-3335

- **Outcome/owner:** persistent lead approves this subset; one local-only worker implements it.
  No child delegation. Estimated 90–120 minutes implementation/focused checks, excluding parent GPU,
  packing, review and delivery; stop with concrete findings if shared lifecycle work expands the slice.
- **Instructions:** project `AGENTS.md`; canonical `agent-config/AGENTS.md`, automatic-work-intake,
  routing and threejs-build skill read for this design. Worker reloads `agent-config/AGENTS.md` and the supplied resolved paths,
  exact branch/HEAD/status and brief; no assumptions about inherited context or source checkout.
- **Candidate:** base above, only this design untracked after authoring. Lead supplies an approved
  implementation checkout/branch, not this design worker's default cwd. No new checkout here.
- **Worker write ownership:** `src/lib/world.ts`, `src/lib/index.ts`, `src/avbd3d/gpu/solver.ts`,
  new `tests/world-anchors.test.ts` only. Add narrow handle/queues/capacity/removal/backend guard,
  additive exports/options and internal append route. No shader/reference/layout/mesh/dependency edits.
- **Focused device-free checks:** recording fake-device tests patterned on `tests/world-sensors.test.ts`;
  verify -1/B record, copied anchors, queued/coalesced writes, validation atomicity, shared capacity,
  adaptive/fixed slot reuse, pending cancellation, disable/reset/fixed/sensor behavior and pool lease
  despawn/reuse; stale handle cannot write a new occupant. Test destroy and backend refusals.
  Run `node --experimental-transform-types --test tests/world-anchors.test.ts tests/joints.test.ts`
  and `pnpm typecheck`; report commands/output. Fake commands prove ownership/order, not physics.
- **Parent ownership:** API map/migration notes/types review, GPU fixtures/actual-hardware runs,
  package build/packed consumer, Git/PR/merge/Linear. Keep `Joint` endpoint/read/listener types intact;
  packed example creates, retargets/removes WorldJoint and uses ordinary Joint.a as Body unchanged.
- **Regression selection:** ordinary two-body fixed/ball/rest/current/plastic/break and onBreak,
  body identity/slot reuse/pools and sensor collision exclusions; advanced negative JointSpec rejection
  and custom backend behavior unchanged. Select existing focused cases in `tests/joints.test.ts`,
  `tests-gpu/lib.gpu.test.ts`, `lib-lifecycle.gpu.test.ts`, `world-sensors.gpu.test.ts` as applicable.
  Reuse unchanged A1/G1/G3 kernel evidence; do not commission a full suite for each feature assertion.
- **Integration gate:** source/diff review plus focused checks, parent hardware protocol above,
  types/packed consumer and relevant API diagram update. Repo `pnpm check` remains required before
  declaring an implemented change done; only the lead can reconcile it with bounded-run policy.
  No GPU skip is a pass; no fixture regeneration, ignored failures or test weakening.
- **Return/escalation:** exact base/head/dirty files, commands, results/skips, unsupported scope and
  evidence to the existing lead. ABI/kernel changes, nullable existing returns, unexpected lifecycle
  coupling or failure of the original 1 mm gate return for approval, not an improvised workaround.

This author performed only local source/link inspection and document scope review; no tests,
typecheck, build, GPU/Dawn/browser/server/benchmark or network inspection was run. All supplied
canonical 8ef/original e355 pins, live ports 5317/5318, shared Git, checkpoint 5/stash 3,
nested dirty/ignored/unpushed recovery and
Video/Otter/provisional ship-demo holds remain untouched. Publication, npm, installations,
`~/releases`, release qualification and human acceptance are separate decisions.


## Lead acceptance of the first implementation — 2026-11-11T02:17:55.889761+00:00

Original design SHA-256 `bb5a56ff27ff1aa20680370c90f439cde9653640b325dd0d9f82d3d7599990c6`. Lead inspected current handle/flush/removal/capacity
and solver append/allocator paths. The named `addWorldJoint` and separate nonbreaking
`WorldJoint` ball handle are accepted for the bounded first slice. Preserve ordinary
`Joint.a/b`, listener/read types, advanced `JointSpec` validation and the adaptive
legacy `appendJoint` behavior; use a new validated internal route through reusable
`appendConstraints`. This is public API approval within the existing implementation
authority, not runtime/1mm acceptance. K0 stays partial until spring damping is done.

Implementation clarifications:
- World-point rows are T_JOINT, A=-1/B=body slot, BIG hard linear/zero angular,
  fresh finite state and the existing B-only torque arm. No shader/layout/ref change.
- Getter anchor copies are authored commands, not GPU observations. Retargets copy
  and coalesce per handle, including before first flush; they must never land on a
  reused slot after removal. Reject every unsupported option, never silently fixed→ball.
- `holding` becomes false after body removal or World destruction; `suspended` means
  still registered but the Body is disabled. A live handle's remove checks World
  liveness as ordinary Joint does; repeated removal remains a no-op. Internal owner
  teardown/pool cleanup after loss/destroy must mark/cancel handles without post-destroy
  GPU writes or invoking a public operation that throws midway through owned cleanup.
- Public add and live retarget refuse SDF preparing/on or custom backend/shader state
  before mutation. Public enableSdfCollisions refuses while any world joint is pending
  or placed, including disabled bodies. The advanced direct backend escape remains
  unqualified; retarget must recheck current support, not assume the creation backend.
  Do not introduce a backend transaction redesign for this first slice.
- Share fixed capacity across ordinary joints, springs and pending/placed world joints;
  preflight before queuing. Auto-remove on Body identity/pool despawn, cancel retargets,
  release once. Adaptive and fixed churn must reuse a released slot. World handles
  never join ordinary break/read listener sets or allocate a Body ID/slot.

The original 1mm/1200-step pendulum protocol above is frozen unchanged before code.
Parent owns actual-device fixture, source/API/guide/migration, packed consumer and
normal ticket delivery. Worker owns only world.ts, index.ts, solver.ts and new CPU
world-anchors tests; focused existing joints/ownership checks and typecheck only.
No new solver architecture, spring damping, nullable existing Joint endpoints or
new capability flag. A source conflict/ABI or failed hardware gate returns as a
precise blocker; no lowered tolerance or silent workaround.

## 2026-11-11 UTC — first implementation checkpoint (not accepted)

Local implementation atop protocol commit `2a176d6` passed 68 focused CPU ownership/lifecycle
tests and typecheck. Lead review added a finite-f32 torque-arm admission check; its regression
failed before the fix and passes after. No shader/layout change was made.

The first dedicated M4 Max/Metal Dawn run (default eight storage buffers) **failed** the frozen
1 mm protocol: maximum pivot error **0.00258417532032685 m**, step 4; RMS
0.0006078189403228895 m over 1201 GPU-stamped samples. Orientation change was
0.6793507682672636 rad. The separate 240-step retarget convergence check also failed.
Two GPU tests failed, none skipped. These are failed acceptance results, not a performance test.
Raw samples, logs, pre-run fixture hash and exact dirty-source hashes are preserved in the
lead's private recovery evidence. Thresholds/settings remain unchanged.

STE-3335 remains In Progress: world-point API is a local candidate pending diagnosis, hardware
acceptance, API/consumer documentation, packed consumer and normal delivery. Spring damping
is still outstanding. Main `234bebe` and existing review sessions remain unchanged.

### Diagnosis follow-through (2026-11-11 UTC)

[Bounded source/CPU diagnosis](audits/world-anchors-diagnosis-20261110.md) reproduced
the startup peak with the unmodified reference (2.584153 mm vs Metal 2.584175 mm)
and byte-compared new/legacy world-point records. No candidate-specific defect was
proven. Parent observation-only hardware follow-up measured 4.481133 mm at step244
after240 retarget steps, still failing the unchanged1mm gate and supporting the
existing alpha=.99 stabilization-decay explanation. No default/threshold change.
The API remains local/unmerged pending an explicit reviewed opt-in policy proposal;
no production solver change or general physical guarantee follows from this diagnosis.

### Lead protocol amendment — explicit opt-in arm, 2026-11-11 UTC

The [policy proposal](WORLD_ANCHOR_POLICY.md) is accepted for local implementation
as immutable per-handle `policy: 'inertial-hard'`, with legacy as the no-option default.
An explicitly named opt-in arm will use that option with the same one-body pendulum
and retarget fixtures, full startup samples, dt, 20 iterations, steps and 1 mm limits.
This **amends the invocation**, not the criteria. Original no-option failures remain
failures and their exact fixtures/raw evidence are preserved. Ordinary joints, oracle
and default exported solve shader retain existing behavior. New info.w policy metadata
requires explicit version/migration documentation. No delivery or hardware pass yet.

### Opt-in implementation acceptance — 2026-11-11 UTC

The explicitly amended inertial-hard arm passed both unchanged physical criteria on
M4 Max/Metal, Dawn0.6.1, default8 storage: 1201sample/1200step pendulum maximum
2.982381033391471e-8m; retarget residual3.045992600472497e-8m after240steps.
These are numerical residuals from GPU poses, not physical-accuracy or energy bounds.
The original legacy failures are retained above and remain failed.

123focusedCPU tests,3newGPU tests (including default-legacy equality and mixed
sensor/ordinary fixed/adaptive slot reuse) and53existing public-wrapper GPU regressions
passed with zero failures/skips. Typecheck,site/library builds, five packed imports,
strict types, packed default8-device lifecycle/ordinary endpoint compatibility and
building the documented fresh-project pendulum alteration passed with local peers.
No fresh registry install/browser/render/large-scene/target-device/energy qualification.
Nov10's single483CPU/267GPU integration gate is reused for unchanged source; it was
not rerun per feature. Exact dirty source hashes and local0.4.0 artifact are in the
[dated record](measurements/world-anchors-2026-11-11.json). Spring damping remains open.
