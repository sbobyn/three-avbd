# Body auxiliary record: design note (F2, STE-3327)

Status: **reviewed and implemented for the gravity-scale slice**, 2026-11-10. Initial Fable
source reading was at `0b48ebf`, with no code or executable checks by that worker. The tables
and proposals below retain that analysis context; sections11–12 record the subsequent lead
implementation decisions and actual hardware checks. Damping/restitution/sensor/CCD extensions
remain proposals.

Scope: where per-body gravity scale and damping live, how they reach the solver, and how the same
record extends to restitution, sensors and CCD. It ends with one implementation brief for the
gravity-scale slice of G1 ([STE-3328](https://linear.app/sbobyn/issue/STE-3328)). It is not a
solver redesign and makes no physical, performance or determinism claim.

## 1. Result in short

- **The roadmap's proposed route does not reach the solver.** Roadmap F2 recommends widening the
  filter buffer into a body-aux record. Gravity is applied in `warmStartBodies`, which is compiled
  with the `solve` layout, and that layout already binds **eight storage buffers**, the WebGPU
  default per-stage limit. No buffer, widened or new, can be added to it on a default device.
- **The Body record has no spare lane.** All ten `vec4f` are used, including every `w`
  (section 2.3). Keeping `BODY_FLOATS = 40` means the values go in a side buffer.
- **Recommendation:** leave the Body record and the filter buffer exactly as they are. Add one new
  buffer, `bodyAux` (one `vec4f` per body slot), and give `warmStartBodies` its own small bind
  group layout (params, bodies, aux: two storage buffers). No existing layout gains a binding, the
  nine-buffer hull rule is untouched, and no SDF module changes.
- **ABI effect:** additive only. `filterStorage` stays two `u32` per body. `solveWGSL` gains one
  binding declaration and one changed line. The aux buffer stays internal until G2/G3 settle its
  final width.
- **Widening the filter buffer is deferred, not rejected.** It is the natural home for the sensor
  and CCD *flag bits*, because the broadphases already bind it. It changes a documented advanced
  stride, so it is a reviewed migration for G3/G4, not part of this slice.

## 2. Current bindings, verified

Counts are storage buffers per compute stage; uniforms do not count toward
`maxStorageBuffersPerShaderStage`. "Spare" is against the default limit of 8.

### 2.1 Standard solver (`GpuSolver3D`)

Layouts: `createLayouts`, `src/avbd3d/gpu/solver.ts:828-850`. Bind groups: `rebuildBindings`,
`solver.ts:975-989`. Pipelines: `createPipelines`, `solver.ts:852-882`.

| Layout | Module and entry points | Bindings (group 0) | Storage | Spare |
|---|---|---|---|---|
| `broad` | `broadphaseWGSL` (`wgsl-collision.ts:80-94`): `beginFrame`, `gridCount`, `gridScatter`, `findPairs`, `findFixedLarge` | 0 params U · 1 bodies R · 2 grid W · 3 pairs W · 4 counters W · 5 statics R · 6 joints R · **7 filters R** | 7 | 1 |
| `refs` | `refsWGSL` (`wgsl-collision.ts:20-31`): `updateRefs` | 0 params U · 1 bodies W · 2 refs W | 2 | 6 |
| `contacts` | `makeContactsWGSL` (`wgsl-collision.ts:330-342`): `hashInsert`, `narrowphase`, `reuseManifolds` | 0 params U · 1 bodies R · 2 pairs R · 3 contacts W · 4 prevContacts R · 5 manifolds W · 6 prevManifolds R · 7 table W · 8 counters W · **9 hulls R (only when `solver.hulls`)** | 8, or 9 with hulls | 0 |
| `topo` | `makeTopologyWGSL` + `TOPOLOGY_ACCESSORS_3D` (`avbd2d/gpu/wgsl-topology.ts:51-60`, `layout.ts:322-348`): degree, fill, sort and colour kernels | 0 params U · 1 bodies R · 2 joints R · 3 info R · 4 manifolds R · 5 counters W · 6 adj W · 7 color W · 8 contactPoints R | 8 | 0 |
| `solve` + `pass` | `solveWGSL` (`wgsl-solve.ts:21-30`): `warmStartJoints`, `warmStartBodies`, `primal`, `primalSparse`, `dual`, `updateVelocities` | 0 params U · 1 bodies W · 2 joints W · 3 info R · 4 contacts W · 5 adj R · 6 color R · 7 counters R · 8 manifolds R; group 1: 0 pass constants U (dynamic offset) | 8 | 0 |
| `args` | `makeArgsWGSL`: `argsPrev`, `argsPairs`, `argsContacts`, `argsColors` | 0 params U · 1 counters R · 2 color R · 3 args W | 3 | 5 |

The nine-buffer requirement: `solver.hulls` is true only when
`device.limits.maxStorageBuffersPerShaderStage >= 9` (`solver.ts:694`); the `contacts` layout then
adds binding 9 (`solver.ts:840`, `978-979`). `deviceCapabilities` reports it as
`standardHullCollisions` (`src/lib/capabilities.ts:8-11`) and `requireHulls` rejects a device
without it (`capabilities.ts:44-48`). A device that grants exactly 9 has **no** spare slot in
`contacts` either.

### 2.2 Helpers and queries over the same buffers

| Pass | Source | Storage |
|---|---|---|
| `BodyReset` | `gpu/body-reset.ts:5-7` (bodies W, indices R) | 2 |
| `BodyMover` | `gpu/body-mover.ts:7-9` (bodies W, moves R) | 2 |
| `Pusher` | `lib/push.ts:19-21` (bodies W, pushes R) | 2 |
| `ContactWatch` | `lib/contacts.ts:22-29` | 7 |
| Standard raycast | `lib/raycast.ts:52-58` (bodies, hulls, rays, best, hits, **6 filters**) | 6 |

### 2.3 Body record

`BODY_FLOATS = 40` (`gpu/layout.ts:15`), struct at `layout.ts:197-208`, packed by
`GpuSolver3D.pack` (`solver.ts:1093-1121`). Every `w` is taken:

| Field | `w` holds |
|---|---|
| `pos` | friction |
| `rot`, `initialRot`, `inertialRot` | quaternion `w` |
| `initialPos` | lifecycle flags DIRTY / DISABLED / COLD as a number 0–7 (`layout.ts:17-27`) |
| `size` | mass |
| `moment` | bounding radius |
| `inertialPos` | step it last moved from its reference pose (`u32`) |
| `vel` | previous velocity along up (adaptive warm start) |
| `angVel` | shape code, or `SHAPE_HULL` + hull offset |

`Params` has two unused floats (`pad0`, `pad1`, `layout.ts:279-280`; words 38–39 are not written
in `writeParams`, `solver.ts:1689-1742`). They are global, so they cannot hold per-body values.

### 2.4 Custom shader interface

`GpuSolverOptions.shaders = { contacts?, solve? }` replaces a whole module (`solver.ts:249-256`).
A custom `solve` module must keep `primalChunks` (checked by regex, `solver.ts:683-685`) and must
supply the entry points `warmStartJoints`, `warmStartBodies`, `primal`, `dual`,
`updateVelocities` (`solver.ts:871`). `customShaders` is true whenever `options.shaders` is
passed (`solver.ts:687`); lifecycle already refuses it (`solver.ts:1801`), and capabilities turn
activation, reset and pooling off (`capabilities.ts:34-37`). `World` never passes `shaders`
(`world.ts:716`), so this affects only `three-avbd/advanced` users.

The advanced entry exports the body, joint, contact and manifold strides and offsets
(`src/lib/advanced.ts:19-43`) and the solver's `filterStorage` getter, documented as "two u32 per
body" (`solver.ts:589-592`).

### 2.5 SDF boundary

SDF replaces collision only; the solve stage is the standard `solveWGSL`. The backend is encoded
between `beginFrame` and `argsContacts` (`solver.ts:1900-1924`) through `GpuCollisionContext3D`
(`solver.ts:490-494`), which hands it `bodies, params, counters, statics, joints, filters,
contacts, previousContacts, manifolds`.

| SDF pass | Source | Storage | Reads `filters` |
|---|---|---|---|
| `prepare` | `wgsl-sdf-bridge.ts:9-13` | 4 | no |
| SDF broadphase | `wgsl-sdf-broadphase.ts:17-26`, groups at `sdf-broadphase.ts:76` | 8 | **yes, binding 8** |
| `filterPairs` | `wgsl-sdf-bridge.ts:112-118`, group at `sdf-bridge.ts:155` | 5 | **yes, binding 6** |
| SDF narrowphase | `wgsl-sdf.ts:21-35` | 5 or 6 | no |
| `exportContacts` | `wgsl-sdf-bridge.ts:34-43` | 8 | no |
| `reportPairs` | `wgsl-sdf-bridge.ts:138-143` | 5 | no |
| SDF raycast | `sdf-raycast.ts:37-43` | 6 | **yes, binding 6** |

The bridge itself requires eight storage bindings (`sdf-bridge.ts:60`). No SDF module reads
`params.gravity`: the only shader read in `src/` is `wgsl-solve.ts:288`.

### 2.6 What the table means for F2

- `solve`, `topo` and `contacts` are full. `contacts` is full at both 8 and 9.
- The SDF broadphase and `exportContacts` are full.
- The only passes with room are `broad` (one slot), `refs`, `args`, `filterPairs`, the SDF
  narrowphase and the small helpers.
- Filters are read in five WGSL declarations as `array<vec2u>`: `wgsl-collision.ts:94`,
  `wgsl-sdf-broadphase.ts:25`, `wgsl-sdf-bridge.ts:118`, `sdf-raycast.ts:43`, `lib/raycast.ts:58`.
  The buffer is sized `capacity × 8` bytes (`solver.ts:707`), written by `setFilters`
  (`solver.ts:1657-1667`) and budgeted as `filters: N * 8` (`lib/storage-budget.ts:146`).

## 3. Options compared

| | A. Widen the filter record | B. New `bodyAux` buffer (recommended) | C. Grow the Body record |
|---|---|---|---|
| Reaches `warmStartBodies` on a default device | Only with the dedicated layout that B also needs | Yes, with a dedicated layout | Yes, with no new binding |
| Body record | Unchanged | Unchanged | `BODY_FLOATS` 40 → 44 or more |
| Filter stride | 8 → 16 or 32 bytes | Unchanged | Unchanged |
| Internal edits | 5 `array<vec2u>` declarations, `setFilters`, the fill at `solver.ts:708`, budget | One declaration and one line in `solveWGSL`, one layout, one bind group | Every body reader: `pack`, `patchBody`, `rewriteFixed`, readbacks, `BodyMesh`, `ContactWatch`, raycasts, `Pusher`, SDF `prepare`, budget |
| Advanced ABI | **Silent break**: an external pass that declares `array<vec2u>` over `filterStorage` reads the wrong bodies with no error | Additive | **Break** of the exported body stride |
| Sensor and CCD flags in the broadphases | Free: already bound there | Standard `broad` has one slot; the SDF broadphase has none | Free (body record is bound) |
| Retained memory | +8 or +24 B per body | +16 B per body | +16 B per body, and wider traffic in every pass that copies bodies |

A alone does not solve the first slice: the obstacle is the `solve` layout, not the choice of
buffer. C is the only route that needs no layout change, and it is the largest ABI break
available, so it is ruled out by the compatibility rule (roadmap D6).

**B is the smallest compatible option.** The one thing A does better, collision-phase flag bits,
is not needed until G3.

## 4. Proposed record and interface

### 4.1 Record

```
bodyAux: array<vec4f>, one per body slot, 16 bytes
  x  gravityScale     dimensionless multiplier of world gravity   default 1.0
  y  linearDamping    1/s                                         default 0.0   (written 0, unread until the damping slice)
  z  angularDamping   1/s                                         default 0.0   (written 0, unread until the damping slice)
  w  reserved         must be 0.0                                              (no reader)
```

Proposed constants in `gpu/layout.ts`: `BODY_AUX_FLOATS = 4`, `A_GRAVITY_SCALE = 0`,
`A_LINEAR_DAMPING = 1`, `A_ANGULAR_DAMPING = 2`, `BODY_AUX_ABI_VERSION = 1`. They stay out of
`src/lib/advanced.ts` in the first slice (section 4.4).

Required for the first slice: the buffer, `x`, and its upload. Optional and deliberately not
designed here: `y`, `z` semantics (damping slice of G1), and anything in `w`.

### 4.2 How the solve stage reads it

A pipeline needs layout entries only for the bindings its entry point statically uses, and a
layout may hold entries the entry point ignores. The repository already relies on this: the hull
buffer sits in the `contacts` layout while the non-hull module never declares it
(`solver.ts:862-866`). So the aux binding can live in `solveWGSL` itself and be used by one entry
point:

- `solveWGSL` gains `@group(0) @binding(9) var<storage, read> bodyAux: array<vec4f>;`.
- `warmStartBodies` statically uses only `params` and `bodies` today (`wgsl-solve.ts:279-320`,
  including `bodyEnabled` and `windAccel`). It gets a new layout, `integrate`: group 0 with
  binding 0 params (uniform), binding 1 bodies (storage), binding 9 aux (read-only storage);
  group 1 the existing `pass` layout, kept so group 1 stays compatible across the solve phase.
  **Two storage buffers.**
- Every other entry point keeps the `solve` layout unchanged at eight.

The `integrate` bind group holds params, the body buffer and the aux buffer. None of the three is
ever reallocated, so it is created once at construction and is valid for fixed storage, where
nothing may be rebound after assembly (`solver.ts:884-887`).

### 4.3 Custom shader impact (to be stated in the migration notes)

- A custom `solve` module derived from the current `solveWGSL` picks the new line up and works.
- A custom module derived from an older `solveWGSL` still compiles and still creates its
  `warmStartBodies` pipeline (the extra layout entry is unused), but it ignores the aux buffer.
  A non-default gravity scale would then silently do nothing. So `setBodyAux` must **throw when
  `customShaders` is true**, as `setLifecycle` does (`solver.ts:1801`), and
  `world.capabilities.gravityScale` must be false there. Defaults keep working.
- The custom `contacts` interface is untouched.
- A stricter option, a regex check that a custom module mentions `bodyAux` (as the `primalChunks`
  check does), is possible later; the first slice does not need it.

### 4.4 Advanced ABI

- Unchanged: `BODY_FLOATS`, all `B_*`, `JOINT_FLOATS`, contact and manifold records,
  `filterStorage` and its stride, `GpuCollisionContext3D`.
- Changed text: `solveWGSL` (one declaration, one line).
- New: a private aux buffer and `GpuSolver3D.setBodyAux`. No public `auxStorage` getter and no
  `advanced.ts` export yet. Reason: five per-body values are already foreseen (gravity scale, two
  dampings, restitution, a flags word) and 16 bytes hold four. Publishing the stride before
  G2/G3 decide would create an ABI we expect to change. This is the main contract decision left
  to the lead (section 9, D1).

## 5. Semantics

### 5.1 Defaults, units, validation

| Field | Default | Unit | Proposed validation (before any slot, ID or GPU write) |
|---|---|---|---|
| `gravityScale` | 1 | none; the body's gravity is `world.gravity × gravityScale` | a number, finite as f32, `|s| ≤ 1000`. 0 means no gravity. Negative is allowed and reverses gravity for that body (D2) |
| `damping.linear`, `damping.angular` | 0 | 1/s | later slice: finite as f32, `≥ 0`, with a stated maximum |

Checks follow the `world-validation.ts` pattern (`checkBodyMaterial`, lines 34-43): `RangeError`
with the calling method's name, thrown before `World.add` takes a slot (`world.ts:1000-1011`).
The limit 1000 is a proposed finite documented limit, not a measured stability bound.

Fixed bodies (`mass = 0`) and kinematic movers ignore gravity today (`wgsl-solve.ts:289-293`) and
keep doing so; the value is stored and takes effect if the body is later made dynamic.

### 5.2 Lifecycle

The aux value is **configuration**, like friction and collision groups, not state.

| Event | Behaviour | Source precedent |
|---|---|---|
| `addBox/addSphere/addHull({ gravityScale })` | Validated, stored on the `Body` handle, aux write queued for the next flush | `occupy` queues filters for every new body, `world.ts:1029-1044` |
| `body.setGravityScale(s)` | Validated, stored, queued; applies from the next step. Does not mark the body dirty or cold, does not invalidate manifolds, allowed while disabled | `setCollisionGroups`, `world.ts:361-366`, `1523-1526` |
| `body.reset(state)` | Kept. Reset changes pose and velocities only | `resetBodyPatch`, `lib/lifecycle.ts:16-18`; `docs/BODY_LIFECYCLE.md:38` |
| `body.setEnabled(false/true)` | Kept. A disabled body is skipped by `warmStartBodies` (`wgsl-solve.ts:281`) | — |
| `body.remove()`, non-pool | Handle keeps its last value for reading. The slot's aux is rewritten to the default at the next flush | parking write, `world.ts:1249-1262` |
| Pool release | Same default rewrite, with the vacant-slot writes | `world.ts:1589-1595` |
| Slot reuse, pool acquire | The new body's value is always written, so the previous occupant's value cannot leak | `refilters`, `world.ts:667-668`, `1040` |
| Pool template | `gravityScale` is a template option, validated in `checkOptions`; a per-lease `setGravityScale` does not carry to the next lease, which is a new `Body` built from the template | `lib/pool.ts:60-75` |
| SDF enable, disable, update | Unaffected; the aux buffer is per slot and backend-independent | — |
| `world.destroy()` | Aux buffer destroyed with the solver's other buffers | `solver.ts:2150-2158` |
| Device loss | No new behaviour and no recovery promise. The authored value survives on the handle | — |
| Solver-level `addBodies`, `rewriteBodies`, `rewriteFixed` (advanced) | Aux is untouched, exactly as filters are; a caller below `World` calls `setBodyAux` itself. Never-written slots hold the default from construction | filter fill, `solver.ts:706-708` |

`pool.ts` copies unknown template keys through (`{ ...options }`, line 67), so without an explicit
check a bad `gravityScale` in a template would reach `World.add` only at acquire time. The check
belongs in `checkOptions`.

### 5.3 Upload, ownership, retention

- **CPU-authoritative, write-only.** The value lives on the `Body` handle. The GPU buffer is a
  mirror the solver only reads. It is never read back and never written by a shader.
- **When:** in `World.flush` (`world.ts:1557-1621`), from a set like `refilters`, after body
  records and lifecycle flags. One `writeBuffer` per run of consecutive slots, as `setFilters`.
  It needs its own set rather than reusing `refilters`, because `setFilters` invalidates manifold
  reuse (`solver.ts:1658`) and a gravity change should not.
- **Retention is bounded by capacity:** `bodyCapacity × 16` bytes on the GPU, allocated once at
  construction and initialised to `(1, 0, 0, 0)` for every slot. No CPU mirror in the solver, no
  per-step allocation, no growth, no history.

### 5.4 Failure, memory and capacity

- **Memory:** +16 B per body slot (the body record is 160 B, filters 8 B). 100 000 slots: 1.6 MB.
- **Fixed plan:** `resolveFixedStorage` gains `bodyAux: N * 16` in `buffers`
  (`storage-budget.ts:144-170`), so `totalBytes` rises by `16 N` and the existing per-binding
  limit check covers it. Any document that quotes fixed-plan totals needs the new number; that
  edit is the lead's.
- **Capacity:** no new capacity kind, no overflow, nothing dropped or counted.
- **Binding limits:** no existing layout changes. The minimum device stays at the default 8;
  hulls still need 9.
- **Failure:** invalid input throws before any change. `setBodyAux` under custom shaders throws.
  Buffer creation failure surfaces as today's construction failure (`world.ts:733-737` cleans up).

## 6. Default behaviour

With every scale at 1.0, the only arithmetic change is `params.gravity * 1.0` in
`warmStartBodies`. Multiplying by exactly 1.0 is exact in IEEE f32, and no other entry point or
buffer is touched. The CPU oracle (`src/avbd3d/ref`) is not modified, so its fixtures are
untouched by construction.

This is **not** a GPU-bitwise guarantee. `solveWGSL`'s text changes, `warmStartBodies` is
compiled against a different layout, and a shader compiler is free to contract or reorder the
changed expression differently. The claim to test is the roadmap's: default scenes stay inside
the existing documented f32 and ordering envelopes.

Narrow fallback if the hardware gate shows default drift outside those envelopes: keep today's
`warmStartBodies` on the `solve` layout as the default pipeline, and compile the aux-reading
variant only when the first non-default value is set, as the hull narrowphase is compiled on the
first hull (`solver.ts:862-866`, `1282-1283`). Default worlds then submit the same pipelines as
today. It costs a second copy of the function, a non-default counter and a first-use pipeline
compile, so it is the fallback, not the proposal.

## 7. Extension path

Only the first row is designed. The rest record which pass would need the value and what the
binding table allows, so later notes start from facts.

| Feature | Per-body value | Where it would be read | What the tables allow |
|---|---|---|---|
| Gravity scale (G1, slice 1) | `aux.x` | `warmStartBodies` | `integrate` layout, this note |
| Damping (G1, slice 2) | `aux.y`, `aux.z` | `updateVelocities` (`wgsl-solve.ts:651-663`), which also uses only params and bodies, so it can move to the same `integrate` layout | No new buffer. Note for that slice: G1's acceptance asks for decay within 1 % of the analytic curve and within 2 % across `dt` 1/60 and 1/240. `v /= 1 + c·dt` is about 1.7 % from `exp(−c·t)` after 2 s at `c = 1`, `dt = 1/60` (arithmetic, not a measurement), so `v *= exp(−c·dt)` is the form to evaluate first. The damped velocity also feeds `vel.w` and the adaptive warm start |
| Restitution (G2) | one f32 | Undecided: the method is G2's open question. `primal` and `dual` cannot bind another buffer | Either a separate pass after `updateVelocities` with its own layout, or a per-pair value written into the manifold by a pass that can see the aux |
| Sensors (G3) | one flag bit | A collision pass must mark the pair, and the solve must skip its rows | Narrowphase, topology and solve are full. The standard broadphase has one spare slot and already binds filters; the SDF broadphase is full and already binds filters; `filterPairs` has room |
| CCD (G4) | one flag bit | Broadphase bounds and the narrowphase margin | Same as sensors |

For the two flag bits, the per-body word has to be visible in **both** broadphases, and the SDF
broadphase can take no new buffer. That is the case for widening the filter record to
`vec4u(groups, collidesWith, flags, reserved)` in G3: a reviewed migration covering the five
declarations in section 2.6, `setFilters`, the construction fill, the budget line and a
release-note line for `filterStorage` readers. This note does not approve it.

Not proposed: a per-feature flag uniform, a second solver path, or any change to colouring,
adjacency or the contact records.

## 8. Tests

Thresholds are proposals to be fixed in STE-3328 before any run. GPU tests need a verified
hardware adapter and are the lead's to run; a skipped GPU test is not a pass.

**CPU (`tests/`)**

1. `world-validation.test.ts`: `gravityScale` accepts 1, 0, −1, 1000; rejects `NaN`, `Infinity`,
   a string, `1e39` (not finite as f32) and 1001, each with a `RangeError` naming the method.
2. `storage-budget.test.ts`: `plan.buffers.bodyAux === N * 16`; `totalBytes` is still the sum of
   `buffers` (existing assertion at line 26).
3. A layout test: `BODY_AUX_FLOATS === 4`; the offsets; `BODY_FLOATS === 40` and the filter
   stride of 8 bytes unchanged; `solveWGSL` declares binding 9 exactly once; `contactsWGSL` and
   `broadphaseWGSL` do not mention `bodyAux`.
4. `capabilities.test.ts`: `gravityScale` is true for `standard` and `sdf` without custom
   shaders, false with them.
5. `advanced-exports.test.ts`: the export list is unchanged.
6. Pool template: a bad `gravityScale` is rejected at `BodyPool` creation, not at acquire.

**GPU (`tests-gpu/`), one new file**

7. Free fall, four dynamic spheres far apart with scales 1, 2, 0 and −1, 60 steps. Displacement
   along up of the scale-2 and scale-−1 bodies is 2× and −1× the scale-1 body's within a relative
   tolerance stated beforehand (proposal 1e-4); the scale-0 body does not move.
8. Default equivalence: the scale-1 body matches a body created with no option in the same world,
   and the existing default-scene GPU tests pass with unchanged thresholds.
9. Setter: change 1 → 0 mid-run; velocity along up stops changing from the next step.
10. Slot reuse: remove a scale-0 body, add a default body, confirm it lands in the same slot and
    falls like the scale-1 body.
11. Lifecycle: `reset` and `setEnabled(false/true)` keep the scale.
12. Pool: template scale 0; acquire, set 1, release, acquire again: the new lease has scale 0.
13. Fixed storage: the same free-fall case in a fixed `World`; `step-allocations.gpu.test.ts`
    still passes.
14. SDF: the free-fall case with SDF collisions enabled (`sdf-world.gpu.test.ts` style). If it
    cannot pass, the capability is false under SDF and the setter throws there.
15. Custom shaders: a `GpuSolver3D` built with `shaders.solve` constructs and steps;
    `setBodyAux` throws.
16. A fixed body with scale 2 does not move; a resting box on a floor with scale 1 stays within
    the existing rest envelope.

## 9. Open decisions and known uncertainty

| ID | Question | Recommendation |
|---|---|---|
| D1 | Aux stride: 16 B now, or 32 B now to leave room for restitution and a flags word | 16 B and keep the buffer internal, so a later change breaks no published ABI. 32 B is safe too and costs 16 B more per slot |
| D2 | Allow a negative gravity scale | Allow; the warm-start weight already uses the sign and size of `g` (`wgsl-solve.ts:303`) |
| D3 | Public shape: option plus `body.gravityScale` getter and `setGravityScale(s)`, or a property setter | Method setter, matching `setCollisionGroups` |
| D4 | Capability name and whether `gravityScale` under SDF ships in the first slice | `capabilities.gravityScale`; ship under SDF only if test 14 passes |

Known uncertainty:

- **Per-entry-point layout.** Section 4.2 rests on WebGPU validating a pipeline against only the
  bindings its entry point statically uses. The repository uses the same rule for hulls, but
  `warmStartBodies` with a three-entry layout has not been compiled here. A mistake shows up as an
  immediate pipeline validation error on the first GPU run. Narrow alternative: a separate small
  module holding only `warmStartBodies` and its helpers.
- **Default drift.** Section 6. Expected to be none or last-bit; unmeasured.
- **Free bodies are solved.** The colouring gives every dynamic body a colour
  (`avbd2d/gpu/wgsl-topology.ts:281-285`, read not run), so an unconstrained body should reach its
  inertial target each step. Test 7 confirms it.
- **Tiny effective gravity.** The warm-start weight divides by `|g|`. A very small non-zero
  `world.gravity × gravityScale` has the same exposure a very small world gravity has today; this
  note does not add a guard.
- **Wind.** `windAccel` for sails is not scaled by `gravityScale` (it is not gravity). Stated so
  it is a choice, not an oversight.
- Nothing here was measured on M1 or GTX 1080, and nothing here is a performance statement.

## 10. Implementation brief: STE-3328, gravity scale only

**Outcome.** A per-body `gravityScale` on `World`, default 1, working on the standard backend and,
if test 14 passes, under SDF. Damping, `droppedTime`, restitution, sensors and CCD are out of
scope. First-slice completion does not close STE-3328.

**Root, branch, delivery.** Set by the lead. The solver files below are the roadmap's
one-writer-at-a-time set (section 9 of the roadmap); no parallel writer.

**Files (smallest ownership).**

| File | Change |
|---|---|
| `src/avbd3d/gpu/layout.ts` | `BODY_AUX_FLOATS`, `A_*`, `BODY_AUX_ABI_VERSION` |
| `src/avbd3d/gpu/wgsl-solve.ts` | binding 9 declaration; line 288 becomes `let g = params.gravity * bodyAux[i].x;` |
| `src/avbd3d/gpu/solver.ts` | aux buffer, `integrate` layout and bind group, pipeline creation, `setBodyAux`, step encoding, `destroy` |
| `src/lib/world.ts` | `BodyOptions.gravityScale`, `Body` field, getter and setter, flush upload, removal default, capability argument |
| `src/lib/world-validation.ts` | `checkGravityScale`, called from `checkBodyMaterial` or beside it |
| `src/lib/capabilities.ts` | `gravityScale: boolean` |
| `src/lib/pool.ts` | template check in `checkOptions` |
| `src/lib/storage-budget.ts` | `bodyAux: N * 16` |
| tests | the cases in section 8 |

Not touched: `wgsl-collision.ts`, `wgsl-hull.ts`, every `sdf-*` and `wgsl-sdf*` file,
`body-reset.ts`, `body-mover.ts`, `push.ts`, `contacts.ts`, `raycast.ts`, `advanced.ts`,
`src/avbd3d/ref`, `src/avbd2d`. `docs/API.md`, `USER_GUIDE.md`, `COMPARISON.md` and the roadmap
are the lead's.

**Insertion points in `solver.ts`.**

1. Construction, after the filter buffer (`:707-708`): create `bodyAux`, `max(bodyCapacity, 1) ×
   16` bytes, `storageUsage()`, filled with `(1, 0, 0, 0)` per slot.
2. `createLayouts` (`:828-850`): add `integrate` with explicit entries at bindings 0 (uniform),
   1 (storage) and 9 (read-only storage). The `layout()` helper numbers bindings consecutively,
   so this one is written out.
3. `createPipelines` (`:871`): keep one module from `shaders.solve ?? solveWGSL`; create
   `warmStartBodies` with pipeline layout `[integrate, pass]` and the other entry points with
   `[solve, pass]` as now. `make` builds one layout per call, so it needs to return the module or
   take a per-entry layout.
4. The `integrate` bind group: created once in the constructor (params, body buffer, aux), not in
   `rebuildBindings`, which a fixed solver may not call after assembly.
5. `step` (`:1956-1957`): set the `warmStartBodies` pipeline, `setBindGroup(0, integrate)`,
   dispatch, then `setBindGroup(0, G.solve[cur])` before the iteration loop. Group 1 is already
   set at `:1951`.
6. `setBodyAux(indices, gravityScale)` beside `setFilters` (`:1657`): same run-of-consecutive
   upload, writing one f32 at `index × 16 + A_GRAVITY_SCALE × 4`. Throws if `customShaders`.
   It does not set `manifoldsValid = false`.
7. `destroy` (`:2154-2157`): add the aux buffer to the list.

**Insertion points in `world.ts`.** `BodyOptions` (`:75-93`); the `Body` constructor (`:332-336`);
a setter beside `setCollisionGroups` (`:361`); a `reauxes` set beside `refilters` (`:668`);
`occupy` (`:1040`); `removeBody` (`:1253-1262`) to queue the default; the flush block beside the
filters upload (`:1613-1621`); `capabilities` (`:798-801`).

**Public contract proposal.**

```ts
interface BodyOptions { /** Multiplier of world gravity for this body. Default 1; 0: none. */ gravityScale?: number }
class Body {
  get gravityScale(): number;
  /** From the next step. Throws RangeError unless finite (as f32) and |s| <= 1000. */
  setGravityScale(scale: number): void;
}
interface WorldCapabilities { readonly gravityScale: boolean }
```

`GpuSolver3D.setBodyAux` is `@internal` in this slice.

**Checks.** `pnpm typecheck` and the focused CPU tests by the implementer. GPU tests 7–16 and the
existing default-scene GPU tests on a verified hardware adapter by the lead, with tolerances
written into the ticket first and raw output kept.

**Hardware gate.** Pipeline creation for `warmStartBodies` with the `integrate` layout must raise
no validation error, on a device at the default limit of 8 and on one granting 9 with hulls on.
No software adapter. No timing is reported from this slice.

**Source-proven obstacle and alternatives.** The `solve` layout is full (section 2.1), so the
roadmap's "widen the filter buffer" cannot deliver gravity scale by itself. If the per-entry
layout fails validation, use a separate module for `warmStartBodies`. If default scenes drift
outside their envelopes, use the lazily selected variant in section 6. Either fallback keeps the
record, the public contract and the tests in this note.


## 11. Lead review and first-slice resolutions — 2026-11-10

The lead checked the cited solve/layout/World/capability/storage paths and accepts option B for
the bounded gravity-scale implementation. Keep the body and filter strides unchanged. Resolve
D1 to16B internal storage, D2 to signed scale in[-1000,1000], D3 to option/getter/method setter.
D4 remains an actual standard/SDF hardware acceptance gate. Damping/restitution/sensor/CCD
semantics and any future record widening remain separate work.

The [WebGPU programmable-stage validation rules](https://www.w3.org/TR/webgpu/#abstract-opdef-validating-gpuprogrammablestage)
validate the bindings statically used by the selected entry point. Lead-only pipeline preflight
on2026-11-10 at20:05:46Z used actual AppleM4Max/Metal3, fallbackfalse, Node25.2.1/Dawn0.6.1.
The existing solve module, transformed in memory only to declare/read aux, compiled both
`warmStartBodies` with the small integrate layout and `primal` with the unchanged full layout,
on fresh devices negotiated to8 and9 storage buffers. No validation errors were reported.
This was pipeline compilation only, not dispatch/free-fall/lifecycle/SDF/default-equivalence
or performance acceptance. The first preflight attempt reused a Dawn adapter after device
creation and was refused as consumed; the successful repeat used a fresh instance/adapter
for each device. Neither result is a rendering observation. Private raw evidence is preserved
by the lead, without adding machine paths to source.

Implementation review conditions beyond the original brief:

- Validate the effective f32 gravity product as well as each operand before any mutation. A
  future `world.gravity` change must refuse an overflow for an existing body's scale atomically;
  a finite scalar/world gravity separately does not guarantee their product is finite. Cover
  pool templates/acquisition and setter rollback. The1000 cap is an API bound, not a stability
  qualification. Tiny effective gravity remains a numerical test case, not an assumed guarantee.
- Make bind-group selection explicit across warm-start and normal-solve pipelines; restore the
  full group and dynamic pass constants before the next entry point, including zero iterations.
- Cover constructor/resource ownership and destruction of the additional buffer; do not create
  new orphan resources or destroy caller-owned buffers/devices. No new per-step allocation.
- CPU layout/budget/validation fixtures and actual GPU behavior remain pending. F2 is not fully
  accepted merely because this design or the pipeline preflight passed.


## 12. Implemented compatibility resolution and hardware checks

The lead replaced source-text declaration inference with an explicit built-in variant generated
from the same shader template. Exported `solveWGSL` keeps the previous custom-shader binding
contract; its actual string SHA-256 equals the0b48ebf baseline. Internal `solveBodyAuxWGSL`
adds the aux read, selected only for the built-in solver path. A declaration in a comment
cannot accidentally change a custom module's pipeline layout. This supersedes the original
section4.3 suggestion that every custom shader should inherit the new declaration.

Gravity scaling is an integrator capability, including an advanced custom collision backend
using the built-in solve; collision shape support remains independently unknown there. Custom
solve overrides still refuse aux writes. All applicable public body/filter/joint strides remain
unchanged; the auxiliary record stays internal.

Final affected hardware gate:115GPUtests passed, zero failures/skips, actualM4Max/Metal3,
Node25.2.1/Dawn0.6.1. Includes standard/SDF/freefall/lifecycle/pool/fixed-storage8-buffer cases,
custom sources, default3D envelopes and allocation/command-trace checks. The first custom
fixture checked Y on the reference solver's Z-up coordinates; it now projects onto its
actual up vector at the same threshold. A combined no-process-isolation run caused three
shared instrumentation failures, including unchanged2D; normal isolated files with serialized
workers passed. No test threshold/digest was loosened and raw failures are retained. This
is feature/integration evidence, not full-suite repetition, renderer, timing, other-device
or broad physical/large-scene acceptance.


## 13. Damping implementation — 2026-11-10

G1 uses the existing record's y/z lanes for linear/angular rates in 1/s, leaving x as gravity
scale and w at zero. No storage, stride, bind-group, pipeline-layout or fixed-budget expansion.
The built-in warm-start predictor decays incoming dynamic velocities exponentially and stores
them as its starting-velocity history; zero rates skip that branch. Exported `solveWGSL` remains
byte-identical. World uploads complete scale/rate records when configuration changes; previous
advanced/internal callers may still omit rate arrays. Custom solve overrides refuse aux writes.

The public [damping contract](API.md#per-body-velocity-damping) includes copied immutable pairs,
validation before mutation, atomic effective-rate/dt checks, and pool/slot/reset ownership. The
removed-handle setter follows gravityScale: metadata only, no former-slot upload. Misspelled keys
are rejected at this new boundary. This does not add spring damping or a fluid model.

Actual M4 Max / Metal3 nonfallback checks: nine damping GPU cases, including standard/SDF,
fixed storage/default8-buffer, lifecycle and custom compatibility;115 existing affected GPU
checks;118 focused CPU checks. The packed consumer also passed strict types/five entries and
numerical decay/setter/reset/disposal on an8-buffer device. See the
[dated source-qualified evidence](measurements/damping-2026-11-10.json). No full-suite replay,
renderer, timing, target-device or broad physical qualification follows.
