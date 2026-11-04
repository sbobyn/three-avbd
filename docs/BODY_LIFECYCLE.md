# Body activation and reset

New in 0.4.0.

Built-in box, sphere and hull worlds support same-life activation and reset. Check
`world.capabilities.bodyActivation` / `bodyReset`; both are false for SDF/custom
collision backends and custom shader overrides. These APIs do not implement sleep;
`nativeSleeping` remains false. Pools are below ([Body pools](#body-pools)).

```ts
const prop = world.addBox({ size: [1, 1, 1], enabled: false })!;
prop.set({ position: [0, 5, 0] });
prop.setEnabled(true);
world.step();
prop.setEnabled(false);             // same ID and occupied slot, retained GPU state
prop.reset({ velocity: [2, 0, 0] }); // retained GPU pose; zero omitted angular velocity
prop.setEnabled(true);
world.step();
prop.remove();                      // ends this life and removes incident joints
```

Disabled bodies retain actual GPU pose, velocity, mass, shape and configuration.
They do not integrate, collide, answer GPU spatial queries or constrain an enabled
joint partner. An incident joint remains `holding` and reports `suspended` until
both endpoints are enabled. Its GPU-owned plastic rest and broken state survive;
resuming clears numerical warm starts without healing a joint. Re-enable uses
ordinary overlap response; it does not find a safe placement or provide CCD.

Pre-existing forces, impulses and prescribed fixed-body motion pause. The remaining
target duration counts enabled simulation steps. New force/impulse/torque or fixed
`moveTo` commands throw `BodyDisabledError` while disabled; `clearForces`, `set`,
`setFixed` and `reset` are allowed. Dynamic `moveTo` retains its ordinary `set`
semantics. `reset` clears previous forces/impulses/targets, zeros omitted velocities
and adaptive history, preserves omitted GPU position/rotation, and synchronizes
the starting/inertial pose mirrors. Last explicit assignment wins per field:
`set({position}); reset({velocity})` preserves both assignments, while
`reset({velocity}); set({velocity})` uses the later velocity. Reset never changes
identity, filters, shape, mass, enabled state or joint anchors/rest.

`flushCommands()` submits topology, absolute assignments and lifecycle commands.
It does not step, consume targets, apply impulses or accrue force time. Reads,
rays and BodyMesh's render hook also flush. GPU submission is asynchronous;
`read()` returns its existing simulation-step stamp. A late read cannot override
newer explicit fields. Removed getters freeze the last known own observation,
including unobserved-field limitations, and never read a replacement's slot.
Previously submitted rays may return their original handle even after removal;
check `hit.body?.alive && hit.body.enabled` before a new action.

Contact events remain simulation-step observations. Disable ends a touching pair
on its next disabled step, delivered by a later read. Flush/read alone produces no
end. Disable/enable between two steps preserves membership but makes physical
history cold. Reset does not synthesize end/begin for an unchanged same-ID pair.
Existing fixed-fixed, overflow, retired-history and contact-watch-growth limits
still apply; activation is not a reliable sensor/resynchronization API.

BodyMesh hides disabled bodies by default; `includeDisabled: true` draws retained
poses for debugging. Rendering flushes pending uploads even when simulation is
paused. Paint stays with an ID through reset/disable and defaults on replacement;
foreign handles are rejected, and removed handles throw `BodyLifecycleError` from `setColor`. Caller geometry/materials
remain caller-owned. Remove meshes before disposing their geometry or World;
rendering released storage throws. World also retains `error` on device loss or
automatic GPU-map failure; stop, destroy and recreate explicitly.

`world.bodyStats` is an immutable snapshot of capacity, live/enabled/disabled,
available, allocated high-water slots and remaining non-reused 31-bit IDs.
`reserved` / `reservedAvailable` count pool reservations (zero without pools). Disabled bodies still occupy slots;
`maxBodies` must be a positive safe integer; fractional capacities are rejected.
Ordinary adds return null at capacity. Dispatch still traverses high-water slots,
and contacts/joints/queries can allocate independently. No whole-engine memory,
allocation-free acquisition, reduced dispatch count or speedup is promised.

Advanced ABI 1 keeps all record strides/bindings unchanged. `initialPos.w` is a
numeric finite f32 flag word: `BODY_DIRTY=1`, `BODY_DISABLED=2`, `BODY_COLD=4`.
Masked writes preserve CPU lifecycle flags; full advanced rewrites reinitialize
them to enabled. Do not interleave raw writes/`seedFrom` with World lifecycle
commands. Backend installation rejects pending disabled/cold/reset state before
preparing or destroying a backend; submit an enabled standard step first. After removing
a disabled body, `flushCommands()` can clear its parked slot without a step. Fixed colour
maps are snapshots: recompute `sequentialColors()` after enabling a body that was disabled
when the map was captured, or after changing fixed/dynamic membership. SDF
lifecycle needs a separate implementation, rather than interpreting its different
record lanes as production flags.

Public device-only example: [body-lifecycle.ts](../examples/body-lifecycle.ts).

## Body pools

New in 0.4.0 (`three-avbd/pool`). A pool needs a
**fixed-storage** World: every solver and helper capacity explicit, checked against the
device's negotiated limits before anything is allocated, and never grown afterwards.

```ts
import { World } from 'three-avbd';
import { BodyPool } from 'three-avbd/pool';

const world = await World.create({ renderer, maxBodies: 33, storage: {
  growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } });
const created = await BodyPool.create(world, { capacity: 32,
  template: { kind: 'sphere', options: { radius: 0.1, density: 7800, reportContacts: true } } });
if (!created.ok) throw new Error(created.reason);
const pool = created.pool;
const shot = pool.tryAcquire({ position: [0, 1, 0], rotation: [0, 0, 0, 1], velocity: [0, 0, -40] });
if (shot.ok) setTimeout(() => pool.release(shot.body), 2000); // or shot.body.remove()
```

**Fixed storage.** `storage: { growth: 'fixed', pairs, contacts, manifolds, joints, hullVec4s }`.
P1 policy floors (the adaptive solver's own startup minimums, not numerical necessities):
pairs ≥ max(4096, 4N), contacts ≥ max(8192, 4N), manifolds ≥ max(4096, N) and ≤ pairs,
joints ≥ 256, hullVec4s ≥ 4096. Requested counts are kept exactly; a smaller, malformed or
device-exceeding plan throws `StorageLimitError` from `World.create` before any attribute or
buffer exists. `world.storageInfo` reports the resolved plan: the counts, `maxContactPairs` /
`maxContactEvents`, derived sizes (watch slots, grid and manifold hashes, statics, 64 colours,
65 pass entries, 8 retired identities per slot) and per-buffer and total retained bytes. That
total excludes driver overhead, renderer meshes and per-call read/ray staging: it is not a
VRAM budget. Fixed means bounded retained physics storage, not zero allocation: reads, rays,
JS handles and results still allocate.

A fixed World never grows: past `joints` (placed plus queued), `addJoint`/`addSpring` throw
`StorageCapacityError`, and an ordinary hull whose geometry doesn't fit the remaining hull
storage throws it from `addHull` (hull room is taken when the body is added, and a removed
hull body's room is freed when its removal is flushed: the next step, read or `flushCommands()`;
`BodyPool.create` flushes first when a hull template doesn't fit). Contact, pair and
contact-event overflow are dropped and counted as before (`contactSetOverflows`,
`droppedContactEvents`) but never repaired by resizing: size them for the worst case. A fixed
World stays on built-in standard collisions for its life: SDF and custom backends are refused;
create an adaptive World for those. All helpers (pushes, `moveTo`, reset, contact events) are
made at full size at creation, with the ray pipeline; each raycast still makes its own small
buffers and bind group, as reads make their staging.

**Pools.** `BodyPool.create(world, { capacity, template })` resolves `{ ok: true, pool }` or
`{ ok: false, reason }`: `'fixed-storage-required'`, `'capacity'` (not enough free slots),
`'unsupported-backend'`, or `'resource-limit'` (a hull template on a device without native
hull collisions, or hull storage that can't fit it). A failure reserves nothing; an invalid
template or capacity rejects. It reserves free holes first, then tail slots (ordinary adds
never take reserved slots), pins a hull template's geometry once, submits its vacant records
(parked, disabled, no filters or report ID) and waits for the GPU. A GPU error during setup
rejects and invalidates the World (`world.error`): submitted work can't be rolled back.

Templates are copied and validated once: shape (`box` size, `sphere` radius, or a cooked
`hull` shape from `convexHull`), density or `massProperties`, friction, `fixed`, filters and
`reportContacts`. Pose, velocity and `enabled` are per spawn and rejected in a template.
Later changes to the objects passed in don't affect the pool.

`tryAcquire({ position, rotation, velocity?, angularVelocity? })` validates the spawn (finite
f32, nonzero rotation, normalized) then returns `{ ok: true, body }` — a **new** `Body` with a new
lifetime ID, enabled, in one of the pool's vacant slots — or `{ ok: false, reason }`:
`'capacity'`, `'id-exhausted'` or `'disposed'`. A hull spawn places the body itself (its centre
of mass on its principal axes, as `Body.position`/`rotation` read), not the points' frame. Old
handles stay dead and frozen; IDs are never reused. `pool.release(body)` (or `body.remove()`)
ends the life: its joints go, its pending forces, impulses and targets are cancelled, and its
slot returns to the pool. Releasing another pool's or World's body throws `BodyLifecycleError`;
releasing an already released one is ignored. Disabled leases still occupy pool slots.
`pool.stats` is `{ capacity, leased, enabled, disabled, available }`. `pool.dispose()` removes
the live leases, returns the slots to ordinary use and drops the hull pin; idempotent.
`World.destroy()` or device loss invalidates every pool (`tryAcquire` returns `'disposed'`).

Acquire and release only queue CPU commands. After `BodyPool.create` resolves, acquire, release,
flush and step create no GPU buffers, bind groups, shader modules or pipelines and upload no
hull geometry (tests-gpu/pool.gpu.test.ts asserts this over warmed churn and a 10,000-life run).
No speedup over ordinary add/remove is claimed.

A hull lease's `body.hull` is its own copy (the pinned geometry stays private), so
`new BodyMesh(world, { bodies: shape })` doesn't select pooled hulls by identity: select with a
predicate over your leases, e.g. `bodies: b => leases.has(b)`, with `geometry: hullGeometry(shape)`,
made before churn.

Not covered: per-pool helper limits, sharing one hull pin between pools, compaction of
fragmented hull storage (a fragmented fixed World can refuse a hull that would fit in total),
query/read admission limits, and any whole-engine memory or no-GC guarantee.

Device-only example: [body-pool.ts](../examples/body-pool.ts).
