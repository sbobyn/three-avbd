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


## 12. Bounded proof result — 2026-11-10 local / 2026-11-11 UTC

Protocol `6bf85224` preceded code. [Exact source hashes and check scope](measurements/sensors-proof-2026-11-10.json)
identify the dirty overlay used for qualification; its later delivery does not make that
run clean. The Codex worker delivered six owned source/test files, 50 focused CPU
checks and typecheck, without GPU execution. Lead review added one meaningful regression
and current dynamic-mode validation: a fixed-to-dynamic patched slot must not reuse its
construction-time eligibility. It failed before the fix; the final focused CPU batch
passes51/51. Broader raw advanced edits and public lifecycle remain unqualified.

On actual Apple M4 Max / Metal3, the dedicated proof device negotiated the default
eight storage buffers. The binding did not report `isFallbackAdapter`; the known
Apple hardware identity passed `assessAdapter`, rather than being called a measured
false fallback flag. Five128-step flight variants passed the frozen §9 predicates:
sensor/partner/no reporting, swapped creation and zero iterations. Normal creation
emitted begin45/end86, zero impulse, expected point/normal and no extra transition.
Every sampled pose/velocity/momentum matched both free flight and the masked control
at the declared tolerance; raw overlap lambda/penalty stayed zero with STICK clear.
Toggle from a force-bearing contact, disable/re-enable and mask bit31 cases passed.
One custom-control fixture initially failed by calling the deliberately unsupported
aux setter; the corrected test asserts that refusal. No shader/physics threshold was
changed to resolve it. Failed logs and initial files are retained privately.

Final selected hardware integration passes114/114, no failures/skips: the proof plus
G1/default/custom/lifecycle/commands/observations/pool/SDF/comparison regressions.
All test processes assess hardware first; no renderer/browser or large scene runs.
Typecheck, library/site builds and a packed five-entry strict-types/import check
pass (existing site chunk-size warning retained). Packaging reused local compatible
peers; no install/download/registry publication or user copy was touched. The same-day
full gate is not repeated under Steven's daily limit; affected-area evidence above
is distinct from a release gate or comprehensive final-source qualification.

D1's **internal** nonresponse proof is accepted for this exact stationary fixture.
STE-3330 remains In Progress. D2/public API, complete atomic lifecycle/shape validation,
moveTo/velocity-driven fixed sensors, dynamic/sensor-sensor shapes, hull/SDF/custom
support, overflow and fresh installed consumer gates remain open. No new gallery or
production sensor feature is advertised; no physical/performance/release/human
acceptance follows. Default exported shader strings/record strides remain unchanged.

## 13. D2 recommendation: coherent native-standard sensors — 2026-11-11 UTC

[P] This follow-up supersedes the *recommended future API* in §§3,8, not their dated evidence or
§11's proof authorization. Baseline `19290ae8636aa2d50394a76ec3444073b6a2692d`; source inspection
only. PR96 merged the bounded proof (§12); it did not qualify public sensors. D2 recommendation:
`BodyOptions.sensor?: boolean` default false, readonly `Body.sensor`, `Body.setSensor(on: boolean)`.
Validate strict booleans (including explicit null/undefined setter arguments) before any mutation;
repeat assignments are no-ops. Keep `reportContacts` independently explicit/default false.
No `staticBoxSphereSensors` field, new event type, automatic listener, watch, readback or World opt-in.
Getter reports authored state immediately; physics changes on the next submitted detecting step.
Sensor means this pair contributes no collision force **or stiffness to either endpoint**; geometry,
count and witnesses remain. Existing forces/impulses, gravityScale, damping, inertia, joints and springs
continue normally. Fixed/kinematic means existing `fixed` plus prescribed motion, not a new body type.

[P] Support target: standard built-in box/sphere pairs, native hull-box/hull-sphere/hull-hull pairs
on a device negotiated for native hulls; fixed, moving-fixed and dynamic sensors, sensor-sensor.
Keep `testPair`'s fixed-fixed and connected-joint exclusions: two fixed/kinematic sensors do not
report each other. No CCD or swept overlap; discrete detection precedes integration. Events retain
slot-ordered A/B conventions, detecting-step membership/final-pose witnesses and exactly zero sensor
collision impulse (§3), existing async/loss behavior and ends-before-begins per step.

[P] Change `WorldCapabilities.sensors` from literal false to boolean **only with accepted support**:
true means built-in standard native primitive sensors are available, not every shape or backend.
Hull sensor pairing additionally requires `hullCollisions === 'native'` and accepted native-hull
sensor tests. SDF/custom return false; snapshots remain immutable/re-read after backend changes.
Box-fallback hulls are never advertised as exact sensor geometry. Refuse worlds mixing authored
sensors and fallback hull bodies/templates conservatively, regardless of masks/overlap, in both
admission directions. Preserve fallback behavior for sensor-free worlds. No source-comment safety
inference or silently treating SDF point-ID bit26 as a sensor. Capsules/compounds stay unsupported.
Stages below keep public sensors false until the advertised matrix is accepted, not one tested pair.

## 14. Activation and ABI: select lazy, per-solver native variants

[E] [solver.ts](../src/avbd3d/gpu/solver.ts) currently selects `sensorProof` in `createPipelines`,
allocates `sensorFlags` only then, and uses it in `step`, `encodeParams`, `setBodyAux`,
`readContactList`, `rebuildBindings`, `assertBackendSwitchAllowed`. `setSensorFlags` requires an
existing stationary fixed box; `sensorProofEligible` is packed at construction. `patchBody` updates
current `dynamic`, but raw velocity/shape edits have no complete eligibility mirror. This hook is
not a public runtime-add shortcut. `acquireHull` separately switches `contactShaders` to
`contactsHullWGSL` on first hull: public activation must update that future selection too.

[P] Introduce internal idempotent `ensureNativeSensors()` and distinct activated state; do not
broaden `sensorProof`'s accepted meaning. Before first true body/template assignment, preflight
support/storage/ID admission, then build only affected contact/solve variants and preparation layout,
pipeline and both parity groups into temporary **instance-owned** objects. Commit the complete bundle
and CPU flag array only after synchronous setup succeeds; invalidate manifolds. Do not rerun all
`createPipelines`, mutate a global dictionary, replace buffers or recreate the integrate group.
Reuse the compatible built-in `warmStartBodies`/joint/velocity entries where unchanged; replace
`hashInsert`/`narrowphase`/history entry selection and `primal`/`primalSparse`/`dual` as needed.
No source rewriting: extend existing template parameters for private native sensor variants.
Choose hull/nonhull contact source from actual `hullShaders` state, and retain a sensor-aware hull
factory for later `acquireHull`. A failed construction leaves authored metadata/IDs/slots unchanged;
late WebGPU validation/device errors invalidate the owning World through its existing error path,
not an invented synchronous validation guarantee. No further compile on ordinary steps/toggles.

[P] Compared routes: always-on variants add setup/source changes even to sensor-free Worlds;
World `{sensors:true}` makes runtime setSensor unexpectedly fail and burdens every consumer/pool
with advance planning. Neither is necessary: lazy setup fits synchronous add/set and existing lazy
hull compilation. First sensor can incur synchronous setup; no cache, startup or pipeline speed
claim. A sensor pool prewarms at create, so acquire/release retain their no-compilation promise.
Untouched solvers retain exact exported/default generated text and dispatch/setup sequence; no
sensor pipelines/groups/flag array until activation. After activation retain native variants and
force BOTH contact and manifold reuse off for remaining native lifetime, even after last sensor
turns off; document this execution-policy cost. Preparation runs every native step, including zero
iterations/no reporting, after collision before topology using `IA_CONTACTS`, as in the proof.
Backend phases never run preparation or reinterpret their keys; returning to native detects fresh.

[P] Body40float/filter8B/joint40float and lifecycleABI1 (DIRTY/DISABLED/COLD only) remain unchanged;
all32 group/mask bits remain available, including31. Aux16B w is numeric0/1, xyz retain G1 semantics.
Promoting bit26 from private proof to **declared standard built-in contact metadata** is a real
semantic ABI decision for advanced raw consumers: publish its version/feature mask, qualified to
native standard records; `readContactList` strips it only there. Exported legacy WGSL/default
strings stay unchanged. Custom overrides (even one override or byte-identical supplied text) refuse
sensors, rather than claim compatibility from source text; sensor:false/custom behavior is retained.
Arbitrary raw advanced buffer mutation remains outside the public World contract; supported advanced
write/rewrite/patch helpers must reject unsupported shape modes before mutation and maintain current
shape/mass metadata. Never reuse `sensorProofEligible` for public eligibility. No filter migration.

[E/P] [wgsl-hull.ts](../src/avbd3d/gpu/wgsl-hull.ts) `hullFaceContact`/`hullEdgeContact` key
expressions use AXIS_FACE_A/B/EDGE (0/1/2) <<24 plus face/edge indices clamped255 in lower lanes;
standard sphere uses3<<24. Thus those inspected producers do not occupy bit26. This is feasibility,
not hull sensor proof: add private `makeContactsTemplate(true,true)` selection; check every hull
producer, copying/matching and marker stripping with executable fixtures, then actual hull contacts.
No blanket comment proves it. Preserve explicit contacts8/9(native hull), solve8, preparation5
storage layouts; never add aux to solve/contact layouts. Existing contact growth rebuilds sensor
parity groups; fixed stepping adds no allocation. Destroy only owned helpers, never borrowed device.

## 15. Ownership, command order and atomic refusal

[P] World owns authored booleans and queued intent; solver owns CPU slot flags/aux and activated
resources. Extend `reauxes`/`flush` rather than a separate sensor command architecture. Full records
append/rewrite first, then resets/patches/lifecycle, then aux xyz and sensor flags before `slide`,
`push`, collision and solve. Upload true flags on newly added slots **before their first physics**.
Activation happens before accepting a true intent, not deferred until a partially mutating flush.
Validate the complete `setSensorFlags` batch (including duplicates with last assignment winning)
before writes, then dirty changed slots preserving DISABLED/COLD and invalidate `manifoldsValid`.
Use current supported shape metadata, not original fixedness or velocities. Standard target supports
both masses and prescribed velocities; raw sail/unsupported shapes must be refused on add/rewrite
or activation scan, regardless of group masks. No overlap-dependent admission or dynamic-mode hack.

[P] Live `setSensor` asserts World liveness, strict boolean/support first, then own metadata and
`reaux`. Removed handle: validate boolean and update only its own metadata, never activate resources,
queue a flag, block a backend or write its former slot. Disabled live bodies retain/block on true.
Repeated true/false toggles between steps use last assignment; true→false may retain lazy resources
but creates no CPU events. Toggle while touching keeps pair membership/ID; dirty both transition
histories so false cannot revive old lambda/stick state. `flushCommands`/`read` upload commands but
create no detection/events; reads may deliver already-submitted events. Reset keeps sensor, scale,
damping, filters and reporting; `BodyState` cannot change sensor. Disable preserves flag, excludes
collision; a disabled detecting step ends overlap, re-enable can begin. Between-step toggles alone
do not promise an end/begin. `setFixed` preserves sensor and existing velocity-zeroing semantics;
`set`, `moveTo`, fixed velocity/angularVelocity drive remain supported, with detection-step timing.

[P] `occupy`, `removeBody`, `vacantRigid`, `stage`, `rewrites` and `appends` must restore the current
occupant's complete metadata: park/free/reserved-vacant aux.w=0, new ordinary life defaults false,
new pool lease uses copied template. Preserve w on ALL xyz aux writes, including contiguous runs,
scale-only calls and reset/full-body restore; do not copy an old slot's flag into a replacement.
Pool `checkOptions` copies/strictly validates sensor; extend `Reservation` with template intent.
`BodyPool.create` validates/activates before `reserveBodies`/hull pin/slot mutation, prewarms once;
`acquireReserved` rechecks backend/support before allocating ID/popping vacancy. Lease toggles do
not change template. Release clears parked flag; next lease has new `Body.id`. True templates block
backend changes even with no leases; disposed templates and removed handles do not. Capacity/ID
refusal must leave flags, free lists and ID allocator untouched; unsupported support throws first.

[P] Keep `BodyIds`, `RetiredBodies.snapshot` and `orderedEvents` unchanged: pending reads resolve
captured lifetime IDs, never current slot occupant or current sensor value. Removal/reuse generates
old end then new begin on a detecting step; bounded eight-retired-generations and dropped-event
accounting persist. Group changes preserve both 32-bit tests, dirty history and end/begin next step;
no synthetic mode event. Watch/set/contact/pair/manifold overflow remains bounded and observable,
not lossless. No extra contact watch or scheduled read when sensor:true alone; existing World's
adaptation/automatic-read policies remain independently configured.

[P] Centralize a pure sensor/backend preflight plus solver pending-intent callback (parallel to
`lifecyclePending`, assigned by World). Guard `assertBackendSwitchAllowed` and direct advanced
`setCollisionBackend` BEFORE backend.prepare/old.destroy/clear/assign: refuse nonnull backend with
any live authored sensor (including disabled/unflushed adds), pending sensor changes/removal cleanup,
nonzero uploaded flags or active true pool template. Require a normal native flush to settle false/
removal intent; do not flush implicitly to pass a backend check. No guard based only on GPU flags.
After all intent/flags clear, adaptive solver may switch; fixed World's existing refusal remains.

[P] `enableSdfCollisions` must call that check before setting `sdfState='preparing'`, flush/import/
bridge allocation. During preparing, refuse true sensor admission/toggles/template creation before
metadata mutation; recheck before bridge installation. `installSdfCollisions` retains previous
backend/bindings/state on refusal, destroys only the newly made bridge, restores on/off in finally.
A direct advanced install during SDF preparation must be refused by the shared pending guard too.
Use an owner-scoped installation permit for the current SDF transaction at final commit, checking
all sensor predicates again; a blanket preparing refusal must not deadlock SDF's own installation.
Never install a backend that cannot interpret flags then roll CPU metadata forward to match it.
No SDF sensor extension is included. Existing SDF failures may have unrelated flush effects; this
contract requires sensor incompatibility rejection *before* those effects, not universal rollback.

## 16. Acceptance stages and ONE ready implementation brief

[P] A — activation/metadata foundation (next brief below), no public API/capability yet. CPU recording
fakes prove no untouched default/custom source/setup/dispatch change, per-instance isolation, lazy
idempotence/failure ownership, full-batch refusal, current shape/mass writes, aux retention/clearing,
8/9 layouts, late hull factory selection, pending/direct backend guards and fixed-storage allocation
rules. These are encoding assertions, never motion proof. Existing proof remains bounded evidence.
B — coupled public World/Body/pool contract + box-box/box-sphere/sphere-sphere across fixed/moving/
dynamic roles and sensor-sensor, complete §15 CPU admission/lifecycle fixtures. C — native hull-box,
hull-sphere and hull-hull, including sensor on either side, plus fallback refusal in both admission
directions; native hull key/decoder fixtures. Keep public capability false/unreleased until B/C's
applicable matrix passes; eight-buffer devices expose only boxes/spheres and refuse hull mixing.

[P] Freeze exact candidate/protocol and reuse existing fixture tolerances before later hardware:
untouched default/custom/G1 motion; each B/C target geometry with swap order, zero iterations and
no reporting; zero lambda/penalty/STICK + matched free flight on both endpoints; dynamic gravity/
linear-angular damping/force and impulse controls; joints/springs still acting and pair exclusions;
moving fixed translation AND rotation via moveTo and velocity drive with detection-step events.
Include toggle force-bearing→sensor→solid, disable/reset/removal/reuse with pending reads/IDs/end
order, pool template/lease/reset churn, bit31 filters, tiny exact pair/contact/manifold/watch/event
capacities with overflow counters and atomic admission refusal. Dedicated8-storage primitive and
negotiated9-storage native-hull devices, qualified actual hardware first. No invented relaxed numeric
tolerance, CCD, physical/performance winner, broad benchmark or target-device extrapolation.

[P] **Ready brief A — reusable native activation and atomic slot metadata, local-only.** Existing
STE-3330 under InProgress STE-3326; persistent lead owns acceptance. Codex/Sol High, no children;
base19290ae on the supplied task checkout, preserve all existing holds. Own only
`src/avbd3d/gpu/{solver.ts,sensor-preparation.ts,wgsl-collision.ts,wgsl-solve.ts}` and
`tests/sensor-preparation.test.ts`; do not add Body API/World wiring or flip capability. Implement
`ensureNativeSensors()`, native flag writer/current-shape guards, separate proof restriction, marker
metadata declaration and nullable pending-intent guard hook (§§14–15), private hull variant/factory,
all supported helper rewrite/patch/reset flag semantics. Retain old proof tests. This replaces the
construction-only bottleneck with the actual runtime-add mechanism B will consume, not another
geometry prototype. Bound to one cohesive source/CPU slice (roughly1–2 implementation days,
estimate not commitment); return if raw helper shape ownership or atomic setup cannot fit it.
Checks when authorized: focused `node --experimental-transform-types --test
 tests/sensor-preparation.test.ts tests/gravity-scale.test.ts tests/damping.test.ts
 tests/lifecycle.test.ts tests/capabilities.test.ts`, then `pnpm typecheck`; no worker GPU/build/full
suite. Parent owns World callback wiring/B/C, docs/API map and advanced migration declaration,
consumer/packed strict-types checks, actual-device protocol and repository `pnpm check` gate or
explicit existing-evidence reconciliation before completion, Linear, integration and Git receipt.
Return diff/source/checks/limits only, no commit/push/merge. Lead gates: ratify D2 and public native
bit26 semantic ABI; refuse fallback/SDF/custom as above; accept staged hardware/consumer evidence
before advertising support. G2 remains separate/ineligible, F2/G1 accepted; no routine user question.


## 17. Lead ratification and bounded A1 scope — 2026-11-11T01:20:16.247103+00:00

D2's public direction is accepted: body boolean option/getter/setter, independent
reporting, no special-case capability and no World-level opt-in. This is approval
of the target contract, not implementation or hardware acceptance. Public capability
remains false until the coupled advertised standard-shape/lifecycle matrix passes.
Standard bit26 semantics are ratified **only for explicitly activated native sensor
records**; legacy exported/default shader sources and SDF key meanings stay intact.
The native metadata version/feature-mask declaration will accompany public exposure;
A1 keeps constants/internal hooks out of package export barrels. No default ABI rewrite.

The broad brief A above is too large for one bounded worker. Execute **A1: lazy
activation plus atomic native slot flags**, then parent reviews before World wiring:

- `ensureNativeSensors()` is an internal, idempotent synchronous setup boundary for
  built-in standard solvers. Build changed pipelines/layout/parity groups into local
  objects before committing instance state; no buffer replacement, default pipeline
  rebuild or integrate-group recreation. Preserve ordinary/proof modes. Private
  nonhull and hull contact variants must remain selectable when the first hull arrives.
- A separate internal `setNativeSensorFlags` validates the whole copied boolean/index
  batch before activation or writes; true requires supported current native shapes,
  not initial mass/stationarity. No-op false writes on untouched solvers do not activate.
  All-false activated solvers retain their resources/execution policy. No public API.
- Track current standard shape kind (box/sphere/native hull vs unsupported sail or
  hull fallback). Activation scans existing slots; append/full replacement rejects
  incompatible shapes before pinning/writing/count changes. Native flags permit
  both masses and prescribed motion. Existing proof still restricts stationary boxes.
- Masked patch/mass/velocity edits preserve native flags and actual shape metadata.
  Full replacement helpers (`rewriteBodies`, `rewriteFixed`, `seedFrom`) explicitly
  clear native flags for the replaced slots; appended slots start false. This is the
  advanced full-replacement contract. Future World reset/lease flush must restore
  authored flags after rewrites and before physics; it must not infer identity from
  a raw slot. Proof's prior semantics remain separate. Preserve aux.xyz on sensor
  writes and aux.w on every gravity/damping whole-record write.
- **Temporary A1 restriction:** once native activation succeeds, refuse every non-null
  collision backend, even after flags clear, as the existing proof does. This prevents
  private solve variants from interpreting SDF bit26. Do not pretend that suppressing
  preparation alone protects SDF: private primal/dual guards would still misread it.
  The recommended backend switching after all intent clears in §§14–15 remains a
  coupled-stage gate until solver pipeline selection and owner-scoped SDF transaction
  are implemented together. Do not add an unwired pending-callback protocol in A1.

A1 owns only solver/preparation/private collision+solve generators and the existing
CPU sensor-preparation test file. No World/pool/capability/export or GPU test changes.
Focused CPU tests/typecheck only; preserve old proof/source hashes. Parent owns actual
hardware checks, source/API map/migration and normal ticket delivery. Full GPU/World
lifecycle/geometry/overflow acceptance is still open. Aim90–120min bounded, not the
prior1–2day all-A estimate; if a material ownership conflict cannot fit, return exact
partial evidence rather than guess or expand. The next task must implement code, not
another design note. No new solver architecture, install, live process or user copy.


## 18. A1 native hardware acceptance protocol (before trials) — 2026-11-11 UTC

Use the accepted §9 binary-fraction fixed-box/sphere fixture through lazy native
activation as well as the unchanged proof mode: same128steps/dt1/64, five report/
swap/zero-iteration arms, enter45/end86, raw zero lambda/penalty/STICK and the same
control/analytic1e-6-or1e-4-relative bounds. Native lifecycle toggles reuse §12's
force-bearing/disable/bit31 cases. Dedicated device storage limit8; no renderer.

On a separately negotiated9-storage hardware device, replace the fixed trigger by
a native convex unit cube at origin: vertices all combinations of±0.5; same moving
sphere and timing/normal/witness criteria. Exercise hull present before activation
and first hull acquired by full replacement after activation, sensor flag restored
after that replacement. This qualifies the two source-selection orders only, not
the full hull-pair matrix. Existing default/custom/hull/G1 regressions remain required.

A bounded dynamic primitive screen uses two radius0.5 spheres at x=±0.375 with
velocities+1/-1m/s, gravity0,dt1/64 for16steps. Test flag pairs[true,false] and
[true,true]; compare each body's position/velocity to an identical mask-excluded
control and analytic coasting with the existing bounds, and inspect zero raw response.
No events, energy, gravity/damping/joints or broad dynamic support is inferred here.

Lead review found that a duplicate batch[true,false] activated resources before
considering final assignment. A failing-before-fix CPU regression is retained;
resolve duplicates before deciding whether untouched native resources are needed.
Public World/pool/capability remain absent/false. Raw files/source hashes and every
failed hardware run must be kept; do not relax criteria after a run.


## 19. A1 result — 2026-11-10 local / 2026-11-11 UTC

The local implementation of lazy activation/atomic native flags passes61 focused
CPU tests, typecheck, builds, packed five-entry imports/strict types and159 selected
actual M4 Max GPU regressions (no failures/skips). Default exported/generated shader
hashes and the separate proof semantics remain intact. [Exact source hashes/results](measurements/native-sensor-activation-2026-11-10.json)
retain dirty run provenance rather than relabeling the later merged tree as the run.

Dedicated8-storage native primitive fixtures pass all frozen §18 arms. Dedicated
9-storage unit-cube trigger/sphere flights pass both existing-hull and later-first-hull
activation orders, including expected enter45/end86. Dynamic sphere[true,false] and
[true,true]16-step coasting screens pass masked/analytic and raw-zero-response checks.
These are bounded compute/readback observations, not rendering, energy/physics,
performance, full native geometry or target-device qualification. GPU prerequisites
were assessed in each process; native fixtures recorded nonfallback Apple hardware.

Lead review added a failing-before-fix duplicate-final-false regression: compute final
batch values before deciding whether activation is needed. The parent's cube fixture
also needed an explicit non-null assertion for type safety; static failure is retained,
no geometry/threshold changed. Existing default hull/command/lifecycle/SDF/G1 behavior
envelopes passed. Masked patches now preserve uploaded geometry/hull leases instead of
acquiring/releasing an unuploaded Rigid shape; full replacement intentionally changes it.

No public Body/World/pool sensor option or capability is enabled. The public coupling,
moving/dynamic full matrix, pooling/pending identity/overflow/consumer gates remain.
Activated solvers retain their no-reuse and non-null-backend refusal for life. First
public coupling must restore authored flags after full reset/replacement and refuse
SDF-preparing admission before metadata/slot/ID mutation. No same-day full gate replay,
registry install/publication or user-copy change occurred.


## 20. Coupled public candidate contract — 2026-11-11T01:41:04.371400+00:00

Next implementation uses main `2f146679e0e44b704949b6494e3e710c074be96c` A1, not a
new design/audit. Add the ratified boolean Body option/getter/setter and copied pool
template; queue flags alongside `reauxes`, restoring authored flags after every full
reset/rewrite and before physics. Keep reporting explicit. Strictly validate booleans
before IDs/slots/pins/metadata; removed handles only change their own validated state.
No new World opt-in, solver architecture, shape/table stride or event kind.

Use eager activation when the first true intent is accepted (after topology/ID/capacity
preflight, before taking ownership); GPU flag upload waits for the normal flush after
new records exist. Scan authored live/pending bodies and pool reservations as well as
uploaded solver shape metadata. Fallback hull mixing is refused in both directions
once native sensors are used; no mask-dependent admission. If removed unsupported
uploaded geometry still prevents activation, reject without an implicit flush and
state that an explicit normal flush is required. No silent loss of pending state.

**Current public-candidate backend boundary is deliberate:** first native activation
locks that solver to standard collision for life, including after flags clear. SDF/
custom/preparing states reject true sensor admission before metadata/activation,
and the existing solver guard rejects direct backend installation before prepare.
Do not add the earlier owner-permit/SDF-switch proposal or an unwired pending callback
now. Public docs must require a separate/recreated World for SDF after sensor use.
Non-sensor Worlds keep existing SDF/custom behavior. Existing preparing state guards
prevent a true sensor intent racing an SDF transaction; test the refusal and state.

The local candidate may compute `WorldCapabilities.sensors: boolean` as true only
for built-in standard native support, false for SDF/custom/proof overrides. This is
not merged/public acceptance until parent qualifies the matrix. Native hull sensors
require negotiated native hull collision; eight-buffer Worlds expose primitives and
refuse authored sensor/fallback hull mixing. Keep all other capability fields honest.
No repeated setup for false/default bodies, pool acquisitions or frame stepping.

Scope: World/Body validation/state/flush, pool template/reservation/lease ownership,
capability calculation and only minimal readonly solver availability/mode getters.
New focused CPU admission/lifecycle/pool fixtures and unrun GPU fixtures for native
box/sphere/hull geometry, moving fixed bodies, dynamic/sensor-sensor, gravity/damping/
forces/joints retention, pending identity/reset/remove/reuse, event loss/overflow and
8/9-buffer cases. Use §9/§18 tolerances and existing lifecycle/event semantics.
Declare cases in source before parent execution; keep raw failed cases, no tuning.
No worker GPU/build/full suite, install, publication, docs or Git writes.

Parent owns API/README/guide, public advanced metadata-version/standard feature-mask
exports and their exact export fixture, hardware/packed-consumer proof and merge.
Public sensor options are not declared delivered until coupled acceptance passes;
otherwise preserve the local candidate with specific blockers. Other-device/large-
scene/performance/CCD/physical/release/human qualification remains separate.


## 21. Coupled public acceptance — 2026-11-10 local / 2026-11-11 UTC

[Exact source hashes, environment, package and limits](measurements/public-sensors-2026-11-10.json)
identify protocol d6ff00a plus the dirty overlay. The public candidate passes109 focused
CPU checks,14 new hardware tests and91 existing wrapper regressions, no failures/skips.
Typecheck/builds and packed five-entry strict types/imports pass. Parent added the
ratified standard raw-contact metadata exports; no worker production claim was assumed.

Actual Apple M4 Max/Metal8/9-storage devices pass216 small geometry/config cases
(box-sphere/box-box/sphere-sphere and native hull-box/hull-sphere/hull-hull), sensor
on either/both endpoint, reporting off/on, zero/four iterations and fixed/dynamic
roles. Existing binary transit and moving translation/rotation fixtures pass exact
detect steps; dynamic gravity/damping/force/impulse and constraints match mask-excluded
controls. Reset/disable/removed lifetime/pending read, copied pool template/release/
newID and native hull pool cases pass. Exact event loss, watch overflow and bounded
upstream capacity loss remain observable, never counted as lossless contact quality.

The packed0.4.0 consumer on an owned default8-storage hardware device emits begin45/
end86 with zero collision impulse, passes through at2m/s, blocks when the same zone
is made solid, and passes again after reset/re-enabling sensor mode. A packed pool
lease restores its sensor template with a new ID; destroying Worlds keeps the caller
device usable. Compatible peers were linked locally; no registry install/publication,
browser rendering, user copy or release-directory change occurred.

This accepts the bounded **native G3 API/ownership/event functionality** for delivery,
not general physics, performance, scale, target-device, release or human acceptance.
SDF/custom sensors remain unsupported. Activation's lifetime backend/no-reuse lock,
fallback-hull exclusion, discrete timing and bounded event loss are public documented
limits. Reuse unchanged A1/kernel evidence; no full gate replay under the daily limit.
