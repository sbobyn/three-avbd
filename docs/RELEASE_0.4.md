# 0.4.0 candidate: capabilities and migration

Prepared 2026-11-01 from `0e11c7f6f2dcf584ee800906903d1b3ef66c4e25`.
This is an unpublished candidate. Registry inspection on this date returned 0.3.0
as latest. Candidate qualification is incomplete until the serialized GPU gate
and installed-package browser workflow pass; historical Dawn results are not browser evidence.
See [audit dispositions](AUDIT_DISPOSITION.md) and [API](API.md).

## Development activation/reset follow-up

The separate development Slice A candidate adds [body activation and reset](BODY_LIFECYCLE.md);
it is not part of the frozen lifecycle-correction archive. Its migration changes include
`BodyMesh.setColor` throwing `BodyLifecycleError` for a removed handle and `World.create`
requiring `maxBodies` to be a positive safe integer (fractional capacities are rejected).
SDF activation, pooling and sleeping remain deferred.

## Package and capability boundary

ESM and declarations ship for four entries. Rendering is exported from the root;
there is no separate `/rendering` entry.

| Entry | Public surface |
|---|---|
| `three-avbd` | World, Body, Joint, BodyMesh, hullGeometry, convexHull, recommendedLimits, deviceCapabilities and API types |
| `three-avbd/queries` | StaticQueryScene, boxMesh and query types; Node works without Three or WebGPU initialization |
| `three-avbd/advanced` | GPU solver, reference utilities and raw buffer layouts; unstable 0.x integration contract |
| `three-avbd/sdf` | Experimental fields, baking, workers and mass/inertia preparation |

| Capability | Candidate support |
|---|---|
| GPU boxes/spheres, fixed/ball joints, springs, forces/impulses | Supported primitive path; discrete collision |
| Convex hull SAT | Requires negotiated device storage-buffer limit >= 9; otherwise bounding-box fallback |
| Solid contact events, selective reads, GPU rays | Asynchronous, bounded observations; track loss and lifetime IDs |
| Fixed-body move/retarget | GPU-authoritative start; consumed by steps, not reads/rays |
| Static triangle CPU rays/sphere/capsule queries | Copied immutable geometry, independent of GPU World |
| SDF nonconvex collisions | Experimental; see SDF limits and open teleport-history finding below |
| Native capsules, compounds, solver mesh/heightfield, sensors | Unavailable; reportContacts still produces solid response |
| Native sleep/wake, public pooling, hinge motor/limits, general CCD | Unavailable |
| Save/restore, cross-device deterministic replay | Unavailable |

Development dependency pair is Three.js/@types 0.187.0. The declared peer range
`three >=0.186.0` is wider than the qualified pair; it does not certify future versions.
No new performance claim is made. Older demo timings in README/FINDINGS retain their
original scenario, source and hardware scope.

## Changes since 0.3

- Partial body writes preserve omitted GPU lanes instead of uploading stale observations.
  Fixed/dynamic transitions retain current GPU pose and reset velocities.
- Fixed-body targets start from the GPU pose, retarget safely and wait for a simulation step.
- Bodies have world-local lifetime IDs; observations are stamped with submitted step boundaries.
- Joint-slot exclusion reuse, standard manifold history on rewritten slots, read coverage,
  destroy races and bounded contact-watch overflow handling are corrected.
- CPU static sphere/capsule queries and immutable capability snapshots are added.
- SDF preparation/collisions remain opt-in and experimental; changes are not a maturity claim.

## Body writes and explicit resets

`body.set({ position })` teleports while preserving current GPU velocity, angular
velocity and rotation. `set({})` does nothing. Getters remain last-read observations;
do not spread a stale getter snapshot into a patch to preserve dynamic state.
A supplied nonempty patch cancels a pending fixed-body target; cancelling an active
slide also clears its generated velocities unless explicitly supplied in the patch.
`moveTo` on a dynamic body is a position/rotation patch, not a kinematic controller.

For a pose/velocity reset, supply every lane you intend to reset:

```ts
body.clearForces(); // persistent force/torque only
body.set({ position: [0, 2, 0], rotation: [0, 0, 0, 1],
  velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
world.step();
const { step } = await world.read([body]);
```

This is not a full pool reset: previously queued impulses are not cleared by
`clearForces()`. To discard all pending commands and incident joints, remove the
old body and create a new one, checking the nullable add result. The new handle
has a new ID even if its storage index is reused. Filters, reporting, rendering
bindings and application metadata must be configured for that new lifetime.
Do not resurrect an old handle. Explicit state writes invalidate standard contact
history; experimental SDF teleport warm-start invalidation remains unqualified.

`moveTo` on a fixed body targets the next `update`'s steps (one for bare `step`).
A read/ray flush does not advance it. A later target supersedes the earlier target;
`set({ velocity: [0,0,0], angularVelocity: [0,0,0] })` cancels it without a pose reset.

## Read and event migration

`read()` now returns `Promise<{ step: number }>` rather than `Promise<void>`.
Await-only callers continue working; wrappers explicitly typed `Promise<void>`
must await and discard the result or change their return type. The stamp is the
submitted simulation boundary captured when the copy was issued, not completion
time and not an immutable body-state snapshot. Another step prevents coalescing;
a request not covered by an in-flight read queues its own copy.

Key application references by World plus `body.id`, never by reusable `body.index`.
Check `body.isAlive` before acting on a delayed event or ray. Retired events/hits
retain their captured handles; removal does not retarget them to the replacement.
Events sort by step, with ends before begins within a step. A finite retirement
history (eight removed lifetimes per slot) suppresses unverifiable events and
increments `droppedContactEvents`. Event storage exhaustion also increments that
counter. `contactSetOverflows` counts pair-set overflow windows; bounded growth
starts a fresh set, so old contacts can begin again and some ends are absent.
Neither counter provides replayable event recovery. Treat changed counters as
incomplete history and rebuild application state using an appropriate observation
policy; there is no public complete overlap snapshot of the dynamic World.

## Capability preflight and lifetime

```ts
import { World, recommendedLimits, deviceCapabilities } from 'three-avbd';
// Pass requiredLimits: await recommendedLimits() when constructing WebGPURenderer.
const caps = deviceCapabilities(device); // negotiated device limits, no allocation
if (!caps.standardHullCollisions) throw new Error('Native hulls unavailable');
const world = await World.create({ device, maxBodies: 128, requireHulls: true });
console.log(world.capabilities.hullCollisions);
```

`requireHulls: true` rejects before solver buffers/renderer attributes on devices
negotiated below nine bindings. Without it, hulls use boxes and warn once.
Capability snapshots are frozen; request another snapshot after changing backend.
Custom shaders report unknown hull behavior; SDF requires explicit fields rather
than implying native hull SAT. Unsupported WebGPU setup must be handled by the
application; there is no automatic CPU physics fallback.

Stop animation/submission first, then call `world.destroy()` (idempotent), dispose
owned BodyMesh geometry/materials as appropriate, and dispose the renderer if the
application owns it. World does not destroy a caller-supplied device. World methods
and retained handle mutations reject/throw after destroy; pending reads reject,
whereas previously submitted ray queries may complete with captured identities.
World observes the supplied device's `lost` promise and retains the failure on
`world.error`; later GPU work throws or rejects. Check this status while paused too.
Stop submissions, drain/catch pending operations, destroy the world, and recreate
a device/renderer and world from application-owned definitions. Automatic recovery
is not provided. Induced loss and explicit recreation pass on Dawn; browser/loss-time
qualification of this corrected candidate remains pending.

## Static query policy

See [queries](QUERIES.md). Capsule sweep `indeterminate` means unresolved work,
not free space. Its fraction starts an unresolved interval and is not a safe move
distance. Stop or subdivide conservatively. Queries are surface tests, not volume
containment, rotating sweeps or GPU-body collision. Mesh `collidesWith` is validated
reserved metadata and has no effect: selection uses mesh.group & query.collidesWith
and ignore handles. Mesh placement is immutable; moving-platform refit is deferred.

## Reproducible consumer

Install the exact reviewed tarball plus `three@0.187.0`; use TypeScript 5.9 with
`@types/three@0.187.0` and `@webgpu/types` when checking declarations. Import
`World` and `BodyMesh` from the root and queries from `/queries`; do not import
`src` or a sibling checkout. Use a strict NodeNext declaration check with
`skipLibCheck: false`, then a Vite build for rendering imports. A runtime smoke
must separately step/read a real WebGPU World and render a package-only scene.
CPU queries and a successful build alone do not establish this browser gate.
