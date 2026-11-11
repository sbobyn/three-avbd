# G3 sensors: bounded design and first proof

2026-11-10 · [STE-3330](https://linear.app/sbobyn/issue/STE-3330), under STE-3326.
Source baseline: `3aee4bab68d3fce8c5ec66393bcdcd3e7f0cdfdf`, clean at dispatch,
branch `plan/ste-3330-sensors-20261110`. Codex/Sol design worker; persistent lead owns decisions.
**Design only; no implementation, tests, physics, GPU, browser or delivery performed.**
[E] means observed source; [P] proposed contract; [U] requires proof/lead decision.
Links below are repository-relative; symbols qualify evidence more durably than line numbers.

## 1. Decision and boundary

[P] Prefer existing standard detection → preparation → existing solve/watch phases.
First useful mechanic: a fixed box trigger and a freely translating dynamic sphere.
Keep Body40float, filter8B, joint40float and the default eight-storage-buffer device path.
No CPU readback drives physics, new solver architecture, G2 dependency or restitution method.

[U] There is no demonstrated **semantically ABI-neutral** route ready for public implementation.
A candidate preparation pass can use private aux.w and a standard contact-key marker;
the latter is an explicit advanced contact-format semantic extension, not a spare-flag assumption.
Lead decision D1 must precede code: approve a bounded internal proof of that extension,
or choose an explicitly versioned alternative. This document accepts neither ABI change nor feature.
The one ready brief in §10 is that proof, with the public capability still false.

[E] [roadmap](FEATURE_PARITY_ROADMAP.md) G3 depends on F2 and asks for static sensor/spheres
first, moving fixed sensors, no response and observable overflow. F2 resolved to private16B aux;
[BODY_AUX_DESIGN §§11–13](BODY_AUX_DESIGN.md#11-lead-review-and-first-slice-resolutions--2026-11-10)
records the built-in integrate variant, preserved exported solve source and G1 checks.
G1 is implemented here. G2 research is outside this design; no failed restitution method is reused.

## 2. Actual detection, response and reporting

[E] [wgsl-collision.ts](../src/avbd3d/gpu/wgsl-collision.ts), `testPair`, rejects disabled
partners, fixed-fixed pairs, mutual group/mask failures and `ignored(a,b)` joint exclusions.
Pair endpoints are ordered by GPU slot (`a > b`), not lifetime ID or sensor role.
All32 group/mask bits participate. Sensors must preserve both mask tests and joint exclusions.
[E] `sphereBox` tests actual sphere/OBB intersection (inclusive tangency), including a sphere
centre inside the box; inside chooses the nearest face, with deterministic axis/sign ties.
`narrowphase` stores count, anchors, B→A normal, geometric-mean friction and generation step.
Contact margin enters c0 after detection; it does not expand this sphere/box hit predicate.

[E] Detection precedes integration in [solver.ts](../src/avbd3d/gpu/solver.ts), `step`.
`warmStartBodies` then predicts poses; the event watcher runs after the completed solver step.
Thus membership describes the detecting poses, while begin-point reconstruction uses final poses.
This is existing discrete reporting, not synchronous GPU callbacks or CCD.

[E] `hashInsert`, `reuseContacts`, `copyContacts` and `narrowphase` carry warm history.
`copyContacts` scales lambda, clamps/reramps penalty and preserves sticking keys/anchors.
`reuseManifolds` copies previous membership without testing separation or current filters.
`params.reuseContacts` defaults true; World can request manifold reuse within substeps.
A sensor cannot rely on stale membership for meaningful enter/exit timing.

[E] [wgsl-solve.ts](../src/avbd3d/gpu/wgsl-solve.ts), `evalContact`, uses
`F = pen*C + lam`; `accumulate` adds force **and stiffness/geometric terms**.
`dualManifold` updates lambda, ramps normal/tangent penalties and changes STICK_BIT.
Zeroing only lambda, friction, or one phase cannot establish no response.

[E] [contacts.ts](../src/lib/contacts.ts), `ContactWatch.touching`, requires count>0,
a reporting endpoint and nonzero lifetime IDs. It does **not** require positive force.
It inserts lifetime-ID pairs, emits begin on new membership, averages A-local anchors
transformed by current A pose, and reports `abs(sum(lam.x))*dt` as impulse.
`ended` compares sets and emits zero point/normal/impulse. No new event kind is necessary.
[E] [world.ts](../src/lib/world.ts), `step`, `read` path, resolves identity
snapshots and captures listeners/events before invoking callbacks; destroyed reads reject.
[identity.ts](../src/lib/identity.ts), `orderedEvents`, supplies ends-before-begins within a step.
[API contact contract](API.md#contact-events-02) retains eight retired generations/slot,
dropped-event accounting, async delivery, set replacement loss and GPU-dependent within-kind order.

## 3. Proposed public contract, after proof and lead review

[P] `BodyOptions.sensor?: boolean = false`; `body.sensor` readonly getter;
`body.setSensor(boolean)` method. Strict boolean validation before metadata, IDs, slots,
queues or GPU writes; unsupported configurations throw before mutation. Repeated value is no-op.
Getter reports authored CPU configuration immediately; effect begins at next submitted step.
`flushCommands` may upload configuration, but flush/read alone never invents membership events.
Removed-handle setter follows gravityScale/damping: validated own metadata only, no former-slot write.
World destroyed/device-error checks remain first, as in the neighboring setters.

[P] Keep `reportContacts` explicit, default false and independent of `sensor`.
A sensor suppresses physical contact response even when neither endpoint is watched.
A reporting nonsensor partner can request events; a listener alone does not turn reporting on.
This preserves helper allocation/readback policy and avoids automatic watching as a hidden cost.
Begin/end remain `onContact` events with existing step/ID/order/loss rules.
Sensor impulse is exactly zero, meaning **no collision-response impulse applied by this pair**;
it is not estimated impact speed, overlap depth, available impulse or a force-threshold event.
Point/normal keep existing A/B conventions; they are geometric witnesses, not a volume centroid
or reliable depenetration instruction. End carries zero vectors. No sensor-first endpoint reorder.

[P] A first public slice must declare a narrow support field, e.g.
`staticBoxSphereSensors: boolean`, while broad `sensors` remains false until its broader scope
is defined and qualified. Current `sensors: false` literal in
[capabilities.ts](../src/lib/capabilities.ts) must not be flipped to imply all shapes/backends.
This additional spelling and the eventual meaning of broad `sensors` are lead decision D2.
Proof adds no public field/API. Partial public exposure is gated on atomic scope validation:
fixed box sensors and dynamic nonsensor spheres only among potentially interacting pairs.
Refuse unsupported partners on both add and setSensor, before allocation/mutation; conservative
world-wide shape refusal is acceptable if documented, rather than guessing from current overlap.
Group changes must not silently activate an unsupported pairing. No response fallback is allowed.

[P] First stationary slice refuses sensor `moveTo`, nonzero prescribed fixed velocities and
fixed→dynamic conversion; ordinary supported pose assignment/reset remains discrete teleport.
Moving-fixed support is a separate acceptance stage (§8), including both moveTo and velocity drive.
Dynamic bodies becoming sensors, sphere/hull sensor shapes, box/hull dynamic partners, SDF and
custom shaders/backends are refused initially, including backend installation with live sensors.
Ordinary sensor:false bodies retain current behavior. Pools validate the copied template before
reserving anything; first slice may accept only the fixed box template under the same world policy.

## 4. Binding and ownership budget

[E] Counts below are explicit layout storage entries; U=uniform, R=storage read,
W=storage read/write. They are not a claim every entry point reads every declared binding.
Source: `createLayouts`/`createPipelines`/`rebuildBindings` in solver.ts and WGSL declarations.

| Layout / entry points | Binding ownership (group0 unless noted) | Storage ceiling |
|---|---|---|
| broad: beginFrame/gridCount/gridScatter/findPairs/findFixedLarge | 0 params U;1 bodies R;2 grid W;3 pairs W;4 counters W;5 statics R;6 joints R;7 filters R | 7 |
| refs: updateRefs | 0 params U;1 bodies W;2 refs W | 2 |
| contacts: hashInsert/narrowphase/reuseManifolds | 0 params U;1 bodies R;2 pairs R;3 contacts W;4 previous contacts R;5 manifolds W;6 previous manifolds R;7 hash W;8 counters W;optional9 hulls R | 8 / 9 hulls |
| topology: degree/fill/sort/colour entries | 0 params U;1 bodies R;2 joints R;3 info R;4 manifolds R;5 counters W;6 adjacency W;7 colours W;8 contactPoints R | 8 |
| integrate: built-in warmStartBodies | 0 params U;1 bodies W;9 aux R;group1 pass U | 2 |
| solve: warmStartJoints/primal/primalSparse/dual/updateVelocities | 0 params U;1 bodies W;2 joints W;3 info R;4 contacts W;5 adjacency R;6 colours R;7 counters R;8 manifolds R;group1 pass U | 8 |
| args: argsPrev/argsPairs/argsContacts/argsColors | 0 params U;1 counters R;2 colours R;3 indirect args W | 3 |
| watcher: touching/ended | 0 bodies R;1 manifolds R;2 contacts R;3 counters R;4 watch R;5 sets W;6 events W;7 params U | 7 |
| proposed prepareSensors | 0 params U;1 bodies R;2 aux R;3 manifolds R;4 counters R;5 contacts W | 5 |

[E] Feature-critical entry-point storage use (transitive reads/writes, distinct buffers):
`hashInsert` bodies/previousManifolds/hash/counters=4; `narrowphase` all8 contact entries
(or9 hulls); `reuseManifolds` bodies/previousContacts/contacts/manifolds/previousManifolds/
counters=6. `warmStartJoints` bodies/joints/info=3; `warmStartBodies` bodies/aux=2;
`primal` and `primalSparse` full solve8; `dual` bodies/joints/info/contacts/manifolds/counters=6;
`updateVelocities` bodies=1. Watcher touching=7; ended sets/events=2.
The full explicit layouts above still bound the resource budget; a smaller entry-point read set
is not permission to append aux to the already-full solve layout.

[P] Preparation reads count/endpoints from each bounded manifold, reads authored sensor flags
from aux, and rewrites only its contact records. Dispatch after collision and before adjacency;
reuse existing argsContacts count/indirect record after checking its unit is manifolds.
No new per-step buffer, bind group or allocation; create/prewarm both parity groups at setup,
rebuild only with adaptive contact storage, keep exact fixed capacities, destroy with solver.
Proof must test allocation-failure cleanup and no destruction of borrowed device/body resources.
Aux capacity is already16N bytes. Using w for a numeric0/1 sensor flag changes private aux ABI
from reserved-zero to defined metadata: version it deliberately and preserve x/y/z on every write.
`setBodyAux` currently has partial-scale and whole-record paths; the latter writes reserved0.
Add a separate validated sensor writer or extend all whole-record writers to retain the flag.
No stealing group bits, physical float lanes, counter words, or generation timestamp bits.

## 5. Narrow route comparison and explicit ABI gate

| Route | Benefit | Gate / reason not an accepted implementation |
|---|---|---|
| Widen filter vec2u to vec4u (F2 original) | Broadphase/query/backend readers already have filters; all mask bits retained | Changes advanced `filterStorage` stride, host packing, ray/SDF readers and budgets; solve still lacks binding room; narrowphase becomes9/10 if added directly |
| Reuse body initialPos.w bit8 | Detection and solve already read bodies | LifecycleABI1 only accepts0..7; raw cache tests and flag clearing break it; requires full semantic migration, not one constant |
| New aux binding in solve/contacts | Direct readable ownership | Solve becomes9, contacts9/10; violates required8/9 path |
| Separate preparation + explicit standard contact-key flag | Five-buffer phase; solve keeps8; watcher reuses manifolds | Advanced contact-key semantic extension D1; history and all solve readers need private variants; SDF cannot inherit this bit |
| Separate overlap outputs/watch pipeline | Can avoid changing solver contact keys | Needs distinct bounded geometry/output/event plumbing and validation; not a proven smaller additive route; defer rather than invent a new solver architecture |

[P] Candidate marker `STANDARD_SENSOR_BIT = 0x04000000` (bit26) in Contact.key.
[E] layout.ts documents standard feature bits0..25, STICK31; sphere feature is3<<24.
SDF uses bits0..28, rolling29 and vertex30: bit26 is **not free for SDF**.
[U] Lead must approve standard-only feature/flag partition and advanced decoder/migration policy,
including raw readContactList consumers; retaining record sizes alone is insufficient compatibility.
[E] `solver.readContactList` currently strips only STICK_BIT/SDF_ROLLING_BIT from `feature`;
the proposed bit would leak into that public decoded feature unless explicitly masked for standard
records. Add that decoder change to D1 and the proof's solver.ts ownership; test the unchanged
sphere feature alongside raw flagged contacts. Never strip bit26 from SDF features.
Do not put marker constants into exported PRELUDE_3D or change exported solveWGSL as a shortcut.
[P] Use explicit template parameters for private built-in solve/contact variants, as G1 does.
Exported source baseline SHA from dispatch is
`f2228d885f039af67798bd759ce25dbfa927d290c9d8d149ae3419cda2ff5df3`;
not recomputed/executed here. Preserve it and default generated sources by fixture in implementation.
Custom contacts/solve overrides refuse sensors; do not infer support by parsing source comments.

[P] In private solve, skip sensor manifolds in `accumulate` before PairBody/eval/Hessian work;
skip `dualManifold` before force, penalty or sticking updates. Read the first-point marker only
after count>0 and capacity checks; preparation marks all points consistently and clears the marker
for nonsensor records. Cover primalSparse via its shared
accumulate path. Preparation zeroes lam AND pen, removes STICK_BIT, sets marker on every point.
No joint force suppression: sensor only means collision nonresponse, not joint disconnection.
Keep count>0 and anchors/normal intact for watcher. Adjacency/colour edges may remain initially;
they consume capacity/cost despite zero response. No performance or bitwise scene equivalence claim.

[P] Private contact variant masks the marker from previous feature matching; no flag is allowed
to turn sphere feature recognition into another shape. Preparation must run every detecting step,
even with zero iterations and no reporting. If sensors remain active, disable contact/manifold
reuse internally for the entire world (both ordinary and substep paths), explicitly documented.
This is an opt-in execution-policy change, not a change to sensor:false default scheduling.
Toggles invalidate `manifoldsValid` and mark the body DIRTY while preserving DISABLED/COLD.
Turning sensors off must force fresh history; merely clearing the flag leaves old zero/stick data.

## 6. Full feature-relevant lifecycle flag audit

[E] `layout.ts`: `lifecycleBits` accepts0..7, `bodyEnabled` masks2, `bodyCold` masks4.
Readers extend beyond collision/solve: shared topology accessors, `lib/push.ts` and
`lib/raycast.ts` embed the same lifecycle helpers (ray uses raw vec4 production Body records).
`wgsl-collision.hashInsert` uses raw `initialPos.w != 0.0`, not a DIRTY-only test.
[E] Writers: solver `pack` sets1; `writeBodies` clears flags or resets lifecycle;
`patchBody` writes DIRTY|CPU lifecycle; `setLifecycle` accepts only DISABLED/COLD and writes
DIRTY|bits; `warmStartBodies` resets enabled bodies' w to0 after collision.
`BodyReset` preserves w while synchronizing starting pose. World `uploadStatics` parks vacant/
removed/reserved slots, zeroes filters/watch IDs and submits lifecycle flags.
[U] Adding bit8 would require changing every listed reader/writer, exported prelude semantics,
CPU lifecycle mirror/validation, parking and custom compatibility. Reject that route for this proof.
The proposed aux/contact route leaves these semantics unchanged, using existing dirty writes only.

## 7. Ownership, invalidation and event transitions

| Operation [P unless marked E] | Configuration/history owner | Membership/event rule |
|---|---|---|
| Create ordinary/queued sensor | World owns boolean; upload complete aux before step | New ID, clean flag/history; no event before step |
| setSensor while touching | Validate full support first; dirty current body; invalidate reuse | Same ID/membership: no synthetic end/begin; next new begin impulse reflects current mode |
| true→false→true between steps | Last explicit assignment wins; history stays cold | No intermediate CPU events |
| pose set / reset | Existing command ordering; reset keeps sensor | Same-ID overlap retained; geometric exit ends on detecting step |
| disable / re-enable | Preserve sensor and aux; existing lifecycle bits | Disabled step ends; later enabled overlap begins; between-step toggle retains membership |
| remove / slot reuse | Clear aux flag, filters, watch; new life gets explicit default/template | Old end then new begin at same step, using lifetime IDs |
| pool reserve/acquire/release | Copied template owns flag; vacant flags0; fresh ID per lease | No leakage to replacement; old events resolve retired identity |
| fixed→dynamic / shape/backend change | First slice refuses unsupported transition atomically | No partially changed mass, sensor or backend state |
| groups change | Full32 bits; force fresh detection/history | Excluded pair ends next step; restored overlap begins |
| remove/disable during pending read | Existing snapshot and retired identity rules | Never retarget event to replacement; loss counted |
| destroy/device loss | Solver owns helper resources; World guards late completion | Pending destroy read rejects; no new event reliability promise |

[E] Disable/reset semantics are in [BODY_LIFECYCLE](BODY_LIFECYCLE.md); reset does not synthesize
same-ID pair transitions. Existing watch unsubscription/resizing behavior is preserved, not redesigned.
[P] Contact-set/event and upstream pair/contact/manifold overflows remain observable through
existing counters (`readCounters`, World dropped/set-overflow counters); no lossless guarantee.
Fixed plans never resize; adaptive watch replacement keeps existing documented empty-set restart.
No additional per-pair capacity is hidden from [storage-budget.ts](../src/lib/storage-budget.ts).

## 8. Staged support truth

[P] Proof: internal standard fixed-box/sphere only, public sensors:false everywhere.
Then narrow public stationary slice only after §3 validation/lifecycle and consumer gates.
Moving fixed stage must test a translating/rotating prescribed box crossing a stationary dynamic
sphere without imparting velocity; allow moveTo and fixed velocity only after their tests pass.
Contacts use detecting poses, so entry is quantized to steps and teleports can miss the volume.
Dynamic sensor stage must preserve gravity/damping/forces/inertia while suppressing contact
response on BOTH endpoints. It needs sensor-sensor tests and joint semantics, not fixed-mass tricks.
Other standard pairs/hulls require feature-key audit, 9-buffer hull test and geometric envelopes;
box-fallback hull collisions cannot silently count as exact sensor hull coverage.
SDF needs separate point-ID/bridge/history/lifecycle design; current SDF bit26 is occupied.
Custom backends/shaders require explicit opt-in contract/version; remain unsupported by default.
C2 can later move metadata to per-collider ownership; this body-only proposal makes no compound claim.

## 9. Frozen proposed acceptance, before any run

[P] Analytic fixture: y-up, gravity0, damping0, identity rotations, dt=1/64s, 128 steps,
fixed box centred0 size[1,4,4], sphere radius1/8, density1, start[-2,0,0], velocity[2,0,0],
angular velocity0. Sensor created first (slot0/ID1), sphere second(slot1/ID2).
Detecting x=-2+(s-1)/32: begin at step45 (x=-0.625), end at step86 (x=0.65625).
Exactly [('begin',45,2,1),('end',86,2,1)]; no intervening stay or extra transition.
Tangency included by sphereBox; binary fractions avoid decimal boundary ambiguity.
Begin normal[-1,0,0], impulse0; reconstructed A/sphere point x=-0.46875, y=z=0,
allow1e-6m on point and1e-6/component on normal; end vectors/impulse exactly0.
Swapped creation order reverses endpoints/normal; ID/slot fixture assertions remain explicit.

[P] Matched control keeps geometry/slots but excludes pair by masks and has sensor:false.
Every sampled position/velocity component difference <=max(1e-6,abs(control)*1e-4),
finite throughout; sphere momentum m*v and trajectory must also match analytic free flight at
same bound. Angular speed stays <=1e-6rad/s. These are proposed sensor tolerances, not results:
1e-4 relative mirrors undamped control in `tests-gpu/damping.gpu.test.ts`; absolute1e-6 follows
`gravity-scale.gpu.test.ts`. Existing baseline envelopes/fixtures remain frozen.
Also inspect sensor contacts after solve: lam=pen=0, STICK clear at each overlap; counts remain1.
Run no-report variant for nonresponse, and partner-only reporting variant for event opt-in.

[P] Separate authored cases: moving gate (later gate), mask bit31, disabled step/end/re-enable,
reset retained overlap, removal/replacement end-before-begin, toggle with previously force-bearing
contact, pool release/reacquire/newID, no unsupported add/set/backend partial mutation.
Force tiny event capacity across multiple steps; assert exact dropped count; fill pair/contact/
manifold and watch limits in bounded fixtures and observe corresponding overflow without false pass.
CPU fake fixtures cover layout/strides, atomic validation, upload ordering, aux reset/ownership,
parity prewarm/cleanup, no-per-step GPU allocations and capability refusal. Fakes prove no physics.

## 10. ONE ready first implementation brief: internal nonresponse proof

Owner: existing persistent lead. Dependency F2/G1 source above; G2 is not a dependency.
Execution gate: lead records D1 contact-key semantic decision before code; D2 before public exposure.
If D1 is declined, stop and return that gate; do not silently substitute body flags/filter widening.
Owned candidate files: `src/avbd3d/gpu/{solver,wgsl-solve,wgsl-collision}.ts`, new
`src/avbd3d/gpu/sensor-preparation.ts`, new `tests/sensor-preparation.test.ts`, new
`tests-gpu/sensors.gpu.test.ts`; parent owns `docs/API.md` map/semantic note and this design update.
Do not edit ref solvers, fixtures, exported PRELUDE or public World/pool/capabilities in this proof.
Implement private aux.w writer(default0, boolean validation/all slots checked before any write),
private marker variants and five-buffer preparation, explicit full detection while active,
with history invalidation on mode changes. Keep existing exported solve hash and custom path.
Use internal solver bodies plus ContactWatch with explicit IDs for §9 fixture; public API remains absent.
Focused CPU command proposed: `node --experimental-transform-types --test tests/sensor-preparation.test.ts`.
Parent hardware command proposed: `node --experimental-transform-types --test tests-gpu/sensors.gpu.test.ts`.
Both unrun here. Parent verifies actual nonfallback adapter first; compile/dispatch on negotiated8,
then9/hull compatibility; retain raw failures. Recheck affected lifecycle/pool/default/custom/G1
GPU regressions and frozen CPU layout/storage/command fixtures; never regenerate oracle fixtures.
Parent reviews diff and actual traces, then required `pnpm check` before declaring implementation done.
Public slice requires separate owned World/validation/pool/capability tests, API-map/guide/release
migration, plain Three.js consumer/packed import and actual hardware acceptance; proof alone closes none.
Extra adjacency/colour/event cost is unmeasured; no performance claim or other-device extrapolation.
Delivery here is LOCAL-ONLY one document, no commit/PR/merge/issue writes. Parent alone handles
STE-3330/STE-3326 state, API/consumer decisions and authorized ticket-linked Git delivery/cleanup.


## 11. Lead decisions: opt-in internal proof only — 2026-11-11T00:52:32.223359+00:00

Reviewed baseline `3aee4bab68d3fce8c5ec66393bcdcd3e7f0cdfdf`. The original worker
document SHA-256 was `a42d09696080a01fddf6d8b9a027ea5dd66f196d5b8ad59318f100c21ec2465a`. Source review confirmed
that `accumulate` contributes stiffness as well as force, `dualManifold` can ramp
penalties from zero, ContactWatch accepts zero-lambda manifolds, and standard
feature matching currently strips only STICK. A preparation-only zero is insufficient.

**D1 accepted for an explicitly opted-in internal proof, not a new standard ABI.**
Use `GpuSolverOptions.sensorProof?: boolean` (default false, marked internal and
experimental), plus an internal `setSensorFlags(indices, booleans)` proof hook.
The proof defines numeric aux.w=0/1 and standard contact bit26 only for that mode.
Keep exported PRELUDE/solve/contact sources, default built-in generated source and
all record strides unchanged. Keep public World/pool/capabilities untouched and
`sensors: false`. The advanced class may expose these internal spellings in emitted
types; document that they are not a supported sensor API or a compatibility promise.
This is not approval to reinterpret records produced by a normal/custom/SDF solver.

Proof construction must explicitly request `hulls: false`, reject custom shaders,
and reject every non-null collision backend before mutation/preparation. No SDF
bit26 stripping, no hull feature assumption, no silent backend fallback. Refuse
flag writes unless proof mode is enabled; validate the complete boolean/index batch
before CPU/GPU writes. A true flag is initially accepted only on an existing fixed
box slot. Other shape, moving/dynamic sensor and lifecycle support remains unqualified.
There is no public promise that arbitrary advanced raw-buffer mutation is safe.

Use private template-generated solve and contact variants selected only in proof
mode; do not patch WGSL with regex or share mutable pipeline dictionaries. The
private solve skips marked contacts before PairBody/Hessian construction and before
dual work; preparation preserves geometry/counts while clearing lambda, penalty and
stick. The private contact variant masks the marker for feature matching. The read
decoder masks it only for standard proof-mode records; ordinary/SDF decoding is
unchanged. Retain raw marker inspection in hardware fixtures.

For this proof **disable both contact and manifold reuse for its entire lifetime**,
even after flags turn off. Do not mutate the caller's params object to achieve it;
encode effective flags locally. This deliberate experimental policy makes toggled
off history fresh and avoids stale membership. Changed flags also invalidate cached
manifolds and set existing DIRTY while preserving DISABLED/COLD. Default mode retains
its exact existing encode schedule and default shader text. No speed claim follows.

Create/prewarm the five-storage-buffer preparation pipeline and parity groups only
for proof mode. Reuse IA_CONTACTS (manifold workgroup count); bound manifold/contact
reads before marker inspection. On resize rebuild parity groups through the existing
owned path; fixed stepping must allocate no buffers/groups/pipelines. Preserve x/y/z
on flag writes and w on all aux whole-record writes. No new buffer or budget item.
Use a deliberately named proof metadata version in the private module rather than
changing published/body/filter/lifecycle ABI constants for default users.

**D2 deferred:** no narrow public capability spelling, Body.sensor option, setter,
pool or World behavior is accepted yet. Internal proof does not complete STE-3330.
After proof, separately decide coherent public support rather than advertise broad
sensors on one tested pair. Full public lifecycle/atomic refusal/consumer gates in
§§3,7–9 remain. Do not ask Steven a routine implementation question for D1.

Verification contract: new recording-fake CPU fixtures plus focused existing
gravity-scale/damping/lifecycle/storage/source-compatibility checks and typecheck.
Write the frozen §9 actual-hardware tests but do not run GPU/Dawn/browser in the
worker. Parent owns qualified 8-buffer hardware proof, unchanged default/custom/G1
regressions, API-map/migration note and delivery. Reuse today's already-run full
gate; do not repeat an app-wide suite. Keep every raw failed run and threshold.
No source/runtime acceptance is recorded by these decisions alone.
