# Body activation and reset

Development Slice A; these APIs are not in the frozen 0.4 release candidate.

Built-in box, sphere and hull worlds support same-life activation and reset. Check
`world.capabilities.bodyActivation` / `bodyReset`; both are false for SDF/custom
collision backends and custom shader overrides. These APIs do not implement sleep
or a pool. `bodyPooling` and `nativeSleeping` remain false.

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
`reserved` / `reservedAvailable` are zero. Disabled bodies still occupy slots;
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
