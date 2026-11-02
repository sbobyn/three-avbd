# three-avbd 0.4.0 release notes

**Release date: 2026-11-0X** (set on publication). Source: `main` at or after `0eb5ee1`; changes
since 0.3.0 (published from `9b9c27b`). The repository keeps no separate CHANGELOG; these notes
are the 0.4.0 changelog entry.

0.4.0 makes body state safe to write and observe, adds body lifecycle, fixed storage and pools,
CPU static queries and capability preflight, and ships the experimental SDF entry point. It
also adds a Rapier comparison harness and an honest [three-avbd vs Rapier](COMPARISON.md) page.
Read [breaking changes and migration](#breaking-changes-and-migration) before upgrading.

## Highlights

- **Body writes only touch what you set.** `body.set({ position })` teleports a body and keeps its
  current GPU velocity, angular velocity and rotation, instead of uploading the last values you
  read back. `setFixed` keeps the current GPU pose.
- **Kinematic targets on the GPU.** `moveTo` on a fixed body starts from its GPU pose, slides over
  the next `update`'s steps carrying what it touches, and can be retargeted or cancelled safely.
- **Lifetime IDs and stamped reads.** Every body has a `body.id` that is never reused in its World.
  Contact events and ray hits keep the handle they captured. `await world.read()` now resolves
  `{ step }`, the simulation step the copy covers.
- **Activation and reset.** `body.setEnabled(false)` takes a body out of the solve and collision
  while it keeps its slot, ID and GPU state. `body.reset({...})` clears forces, impulses, targets
  and adaptive history in place ([Body lifecycle](BODY_LIFECYCLE.md)).
- **Fixed storage and body pools.** `World.create({ storage: { growth: 'fixed', ... } })` sizes every
  solver buffer up front, checked against the device limits before anything is allocated.
  `three-avbd/pool`'s `BodyPool` hands out fresh bodies from reserved slots. After the pool is
  created, acquire, release and step create no GPU buffers, bind groups or pipelines
  ([Body pools](BODY_LIFECYCLE.md#body-pools)).
- **CPU static queries (`three-avbd/queries`).** `StaticQueryScene` over static triangle meshes,
  with nearest rays, sphere and capsule overlaps, and sphere and capsule translational sweeps.
  It runs in Node or a worker with no GPU and no Three.js runtime import ([static queries](QUERIES.md)).
- **Capabilities and hull preflight.** `deviceCapabilities(device)` and `world.capabilities`
  report what the device and installed backend support. `requireHulls: true` refuses a device
  that would collide hulls as boxes, instead of warning once.
- **Opt-in contact margin.** `world.solver.params.contactMargin` (default 0.01 m, unchanged). Use
  `0.001` where resting depth matters: a 100-sphere close-packed stack then meets the comparison's
  1 % contact-depth target ([COMPARISON.md](COMPARISON.md#3-performance)).
- **Experimental SDF collisions (`three-avbd/sdf`).** Non-convex bodies from analytic or
  mesh-baked voxel fields, a cancellable worker baker, mass and inertia preparation, and
  `world.enableSdfCollisions()`. The API may change ([baking](SDF_BAKING.md), [World](SDF_WORLD.md)).
- **Examples and comparison.** An [examples index](../examples/index.html) (basic, body lifecycle,
  body pool, SDF gears, balls in a torus, a mesh baked in a worker). Also `pnpm compare:rapier`,
  a Node + Dawn harness against Rapier 0.21.0 whose scenes are labelled valid or invalid for
  quality claims, the live `/compare-side.html` page, and [COMPARISON.md](COMPARISON.md).

## Changes since 0.3.0

Bodies and commands
- Partial body writes preserve omitted GPU lanes. Fixed/dynamic transitions keep the current GPU
  pose and zero velocities (#48).
- Fixed-body targets start from the GPU pose, retarget safely and are consumed by simulation
  steps, not by reads or rays (#48).
- Body activation (`setEnabled`, `enabled`, `Joint.suspended`), `body.reset`, `flushCommands()`,
  `world.bodyStats`, and `enabled: false` at creation (426762a).
- Fixed storage (`WorldOptions.storage`, `world.storageInfo`, `StorageLimitError`,
  `StorageCapacityError`, `STORAGE_FLOORS`) and `three-avbd/pool` (dbc8617).
- `massProperties: { mass, moments }` on body options.

Observations
- Lifetime body IDs; events and rays keep captured handles. A bounded retirement history (eight
  removed lifetimes per slot) suppresses events it cannot verify. `read()` returns
  `{ step }` (#49).
- A removed body's getters freeze its last known observation and never read a replacement in
  the same slot (426762a).
- Reused joint exclusions, contact history on rewritten slots, in-flight read coverage,
  destroy races and contact-set overflow recovery are fixed (#47, #49).

Queries and capabilities
- `three-avbd/queries`: static triangle BVH, rays, sphere overlaps (#50), capsule overlaps and
  bounded translational sweeps (#52).
- `deviceCapabilities`, `world.capabilities`, `requireHulls` (#51).

Solver
- `contactMargin` is a GPU solver parameter, default 0.01 (#55).
- `step({ reuseManifolds: true })` reuses the previous contact set for explicitly managed
  substeps. Further performance switches, off by default, are on the solver in
  `three-avbd/advanced`.
- `convexHull` terminates on degenerate input: quickhull order, scale-relative tolerances and a
  fold check. A 238-point fracture fragment that previously never finished now builds; it is kept
  as a regression fixture (#63).

Lifetime and errors
- World observes device loss and keeps it on `world.error`, and later GPU work throws. Loss while
  only the periodic counter read is pending no longer leaves an unhandled `AbortError` (426762a;
  pinned in a GPU test by #58).
- Renderer storage attributes owned by a World and its BodyMeshes are released when both are
  destroyed or disposed, in either order, so repeated World resets return to the baseline
  (426762a).

Experimental SDF
- The `three-avbd/sdf` entry point and `World.enableSdfCollisions` / `updateSdfCollisions` /
  `disableSdfCollisions`: GPU narrowphase, spatial candidates, mesh vertex contacts, contact
  events and SDF surface raycasts. The demos are `/sdf.html`, `/sdf-gears.html` and
  `/sdf-released.html`.

Tooling and docs
- Three.js and `@types/three` dev pair 0.187.0 (#46). The peer range is unchanged at `>=0.186.0`.
- Rapier comparison harness (#53), scene-validity labels and valid settled piles (#60), live
  side-by-side page (#61), [COMPARISON.md](COMPARISON.md) (#62), examples index (#59).

## Breaking changes and migration

### `body.set` is a partial patch

In 0.3, `set` filled every omitted field from the body's last-read getters and uploaded all four.
In 0.4 only the fields you pass are written; the rest keep their current GPU values.

- `set({ position })` keeps the body moving at its current GPU velocity. To stop it, pass the
  velocities too. `set({})` does nothing.
- Do not spread a stale getter snapshot into a patch "to preserve" state: that writes the stale
  values.
- A nonempty patch cancels a pending fixed-body `moveTo` target. Cancelling an active slide also
  clears its generated velocity unless the patch supplies one.
- `moveTo` on a dynamic body is a position/rotation patch, not a kinematic controller.

```ts
// Full pose/velocity reset of a live body
body.clearForces(); // persistent force/torque only; queued impulses remain
body.set({ position: [0, 2, 0], rotation: [0, 0, 0, 1],
  velocity: [0, 0, 0], angularVelocity: [0, 0, 0] });
// or, also clearing queued impulses, targets and adaptive history:
body.reset({ position: [0, 2, 0], rotation: [0, 0, 0, 1] }); // omitted velocities become zero
```

`body.setFixed()` now keeps the current GPU pose, where 0.3 rewrote the last-read pose, and
still zeroes velocities.

### `read()` resolves `{ step }`

`world.read()` returns `Promise<ReadResult>` (`{ step: number }`) instead of `Promise<void>`.
Callers that only `await` keep working. A wrapper typed `Promise<void>` must change its return
type or await and discard the result. The stamp is the submitted simulation boundary when the
copy was issued. It is not the completion time, and not an immutable snapshot.

### `World.create` validates `maxBodies`

`maxBodies` must be a positive safe integer. Fractional, zero, negative or non-finite values
throw `World.create: maxBodies must be a positive safe integer`.

### `BodyMesh.setColor` rejects removed and foreign handles

`setColor(body, color)` throws `BodyLifecycleError` for a removed body, where 0.3 painted
whatever slot the index pointed at. It also rejects a body from another World. Paint stays with
a body's ID through reset and disable; a replacement in the same slot starts unpainted.

### Handles are checked

- Passing a body from another World to a World method throws `Body belongs to another world`.
- After `world.destroy()` (idempotent), World methods and handle mutations throw or reject, and
  pending reads reject. Rays already submitted may still complete with their captured handles.
- Key application state by World and `body.id`, never by `body.index`, which is reused.
  Check `body.alive` (and `body.enabled`) before acting on a delayed event or ray hit.
- New commands on a disabled body (`applyImpulse`, `applyForce`, `applyTorque`, fixed `moveTo`)
  throw `BodyDisabledError`. `clearForces`, `set`, `setFixed` and `reset` are allowed.

### Contact events

Events sort by step, with ends before begins within a step. `droppedContactEvents` counts events
lost to the retirement history or to event storage. `contactSetOverflows` counts pair-set
overflow windows, after which a fresh set starts, so some contacts begin again and some ends are
absent. Treat a changed counter as incomplete history; neither counter supports replay.

### Hull fallback is visible

On a device negotiated below nine storage buffers per stage, hulls still collide as their
bounding boxes, but now warn once. `World.create({ requireHulls: true })` rejects before
allocating anything. Pass `requiredLimits: await recommendedLimits()` to the renderer to get
native hulls where the adapter supports them.

### `three-avbd/advanced` (unstable 0.x contract)

- `initialPos.w` in the body record is a finite f32 flag word (`BODY_DIRTY=1`,
  `BODY_DISABLED=2`, `BODY_COLD=4`). Masked writes preserve it. Full raw rewrites reset it to
  enabled. Do not interleave raw writes or `seedFrom` with World lifecycle commands.
- The params uniform carries `contactMargin` in the former `gust.y` pad. Its size and layout are
  unchanged.
- Record strides are unchanged from 0.3 (`JOINT_FLOATS` = 40).

### Contact margin

The default is still 0.01 m, so 0.3 scenes rest the same way. A resting contact sits about a
margin deep. For scenes where that matters:

```ts
world.solver.params.contactMargin = 0.001; // validated at the next step
```

On the valid 100-sphere stack this met the 1 % depth target at 4 and 10 iterations, with no
change in step time (M4 Max, 2026-11-02, [COMPARISON.md](COMPARISON.md#3-performance)). Tall
walls and the small benchmark tier have not been re-measured at 0.001. Choosing a new default is
deferred to 0.5.

## Package

Five ESM entries with declarations. Rendering is exported from the root.

| Entry | Public surface |
|---|---|
| `three-avbd` | World, Body, Joint, BodyMesh, hullGeometry, convexHull, recommendedLimits, deviceCapabilities, lifecycle and storage errors, API types |
| `three-avbd/queries` | StaticQueryScene, boxMesh and query types; no GPU or Three.js runtime import |
| `three-avbd/pool` | BodyPool and its template/result types; needs a fixed-storage World |
| `three-avbd/advanced` | GPU solver, reference utilities and raw buffer layouts; unstable 0.x integration contract |
| `three-avbd/sdf` | Experimental fields, baking, workers and mass/inertia preparation |

Peer dependency `three >=0.186.0`. The tested pair is Three.js and `@types/three` 0.187.0; the
range does not certify later versions.

## Capability summary

| Capability | 0.4.0 |
|---|---|
| GPU boxes/spheres, fixed/ball joints, springs, forces/impulses | Supported; discrete collision |
| Breakable and plastic joints | Supported, on the GPU |
| Convex hull SAT | Needs a negotiated storage-buffer limit of at least 9; otherwise a bounding-box fallback (warned) or rejection (`requireHulls`). At most 32 vertices |
| Contact events, selective reads, GPU rays | Asynchronous and bounded; lifetime IDs and loss counters |
| Fixed-body move/retarget | GPU-authoritative; consumed by steps |
| Activation/reset, fixed storage, pools | Built-in box/sphere/hull backends only; not SDF or custom backends |
| Static triangle CPU rays and sphere/capsule queries | Copied immutable geometry, independent of the GPU World |
| SDF non-convex collisions | Experimental; adaptive-storage Worlds only |
| Capsule bodies, compounds, solver mesh/heightfield, sensors | Unavailable |
| Sleeping, CCD, hinge/prismatic joints, motors, restitution, damping | Unavailable |
| Save/restore, cross-device deterministic replay, CPU fallback | Unavailable |

## Known limitations

- **No sleeping.** Every enabled body is solved every step. On the valid settled piles,
  three-avbd settles more slowly than Rapier. Its 10k-body pile was still moving at the end of the
  600-step window. In the browser side by side, the 1k pile was still moving at 10 s while
  Rapier's was at rest ([COMPARISON.md](COMPARISON.md#3-performance)).
- **Pile quality is not yet isolated.** Neither engine meets the worst-over-window depth target
  on the pile scenes, so there is no quality-matched pile comparison yet. Worst transient depths
  are larger than Rapier's.
- **Resting depth at the default margin** is about 1 cm. See the margin above.
- **Discrete collision only.** Fast bodies can tunnel. Use smaller `dt`, and CPU sweeps against
  static geometry.
- **Observations are asynchronous.** Poses, events and rays arrive a frame or two later. There is
  no synchronous query against GPU bodies.
- **Event history is bounded and lossy** under overflow (counters above).
- **Device loss** is reported on `world.error` with no automatic recovery. Stop, destroy, and
  recreate the device and World from your own definitions.
- **Fixed storage** never grows: overflow is dropped and counted, and fragmented hull storage
  is not compacted. Fixed means bounded retained physics storage, not zero allocation: reads,
  rays and JS handles still allocate.
- **Same-device determinism through `World`** is unverified; the solver-level bit-identical runs
  need fixed storage.
- **SDF** is experimental. Teleport warm-start invalidation for SDF pair history is open; do not
  rely on full SDF reset guarantees. Activation, reset and pooling do not apply to SDF.
- **Adjacency sorting** is O(degree²) per body (audit AH-2, deferred measurement).
- **WebGPU required.** There is no CPU physics fallback; only `three-avbd/queries` runs without a
  GPU.
- Open downstream integration rows (three-destruction) are listed in
  [audit dispositions](AUDIT_DISPOSITION.md).

## Verification

Recorded for the release commit. GPU and browser results are added by whoever runs those gates;
nothing below is claimed until it is filled in.

| Check | Where | Result |
|---|---|---|
| `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm build:lib` | CPU, release-notes branch | pass; 247/247 CPU tests |
| `pnpm pack` contents | CPU, release-notes branch | 268 files, ~394 kB compressed / 1.65 MB unpacked: `build/` JS, declarations and source maps for all five entries, README, LICENSE, THIRD_PARTY_NOTICES, package.json; no tests, fixtures, demos or docs |
| Fresh consumer: install the tarball with `three@0.187.0`, `@webgpu/types`, TypeScript 5.9.3; strict NodeNext declaration check (`skipLibCheck: false`) of all five entries and the migration and worker snippets; Node run of `three-avbd/queries` installed without peers (no `three`) | CPU, release-notes branch | pass |
| `pnpm check` with GPU tests run serially | GPU, release commit | **pending** |
| Installed-package browser workflow (step, read, render) | Chrome | **pending** |
| Rapier settling batch on the valid scenes | GPU, #60 head `57c7c23`, 2026-11-02 | recorded in [COMPARISON.md](COMPARISON.md#3-performance) |

Historical Dawn results are not browser evidence. Older demo timings in the README and FINDINGS
keep their original scenario, source and hardware.

## Publishing

1. Run the full gate on the release commit with GPU tests serial:
   `pnpm typecheck && pnpm test && node --experimental-transform-types --test --test-concurrency=1 tests-gpu/*.gpu.test.ts && pnpm build && pnpm build:lib`.
2. `pnpm pack`, inspect `tar -tzf`, and record the tarball's SHA-256.
3. Install that tarball in a fresh consumer and repeat the declaration and runtime smoke checks.
4. Publish that exact archive: `npm publish three-avbd-0.4.0.tgz --access public --ignore-scripts`.
   `--ignore-scripts` skips the unconstrained `prepublishOnly` GPU run, and is valid only after
   step 1 passed.
5. Check `npm view three-avbd@0.4.0` (version, exports, integrity), install from the registry
   in a fresh consumer, tag `v0.4.0` at the published commit, and set the release date above.

See [audit dispositions](AUDIT_DISPOSITION.md), [API](API.md) and
[historical SDF verification](SDF_RELEASE_0.4.md).
