# three-avbd v0.1: library API (design for review)

Status: v0.1 published (npm `three-avbd`); 0.2 in progress (see `PLAN.md` stage 10).

## Goal

Let a Three.js WebGPU project add GPU rigid-body physics in a few lines: boxes and spheres,
joints that can break, tens of thousands of bodies drawn straight from the solver's buffer. 3D
only. 2D and the reference solvers stay in the repo as the oracle and demos; they aren't
published.

## Package

- `three-avbd` on npm. ESM only, with type declarations. Peer dependency `three >= 0.186` (it
  uses `three/webgpu` and `three/tsl`). No other runtime dependencies.
- **`three-avbd`**: the stable surface described below (`World`, body and joint handles,
  `BodyMesh`).
- **`three-avbd/advanced`**: the escape hatch. It exports `GpuSolver3D` (with the reference
  `Solver`, `Rigid` and `sphere` it's seeded from), the body and joint buffer layout, and the device and buffers of a `World`, for people writing their own compute
  passes over the bodies (the voxel city's blast shader). No stability promise in 0.x.
- Built by `tsc` from a new `src/lib/` into `dist/`. The package `files` list is `dist` only,
  so demos, benchmarks, fixtures and the reference ports stay out of the tarball.

## Core API

```ts
import * as THREE from 'three/webgpu';
import { World, BodyMesh } from 'three-avbd';

const renderer = new THREE.WebGPURenderer();
await renderer.init();
const world = await World.create({ renderer, maxBodies: 50_000 }); // y-up, gravity [0, -9.81, 0]

const ground = world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
const crate = world.addBox({ size: [1, 1, 1], position: [0, 5, 0], density: 1, friction: 0.5 });
const ball = world.addSphere({ radius: 0.5, position: [0, 8, 0], velocity: [0, 0, -3] });
const weld = world.addJoint(crate, ball, { anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0], breakForce: 500 });

scene.add(new BodyMesh(world, { material: new THREE.MeshStandardNodeMaterial() }));
renderer.setAnimationLoop(() => {
  world.update(clock.getDelta()); // fixed steps from an accumulator
  renderer.render(scene, camera);
});
```

### World

- `World.create({ renderer | device, maxBodies, gravity?, dt?, iterations? })`. With a renderer,
  it uses the renderer's GPUDevice, which zero-copy drawing requires. With a bare `device` it
  runs headless (Node with Dawn, tests, workers).
- `maxBodies` fixes the body buffer's size; adds past it fail and return `null`. Contacts,
  pairs, joints and colours grow on their own, through the existing `adapt()` readbacks.
- `step()` advances one fixed step. `update(seconds)` runs the steps that time is owed, at
  most `maxSubsteps` (default 4).
- `params`: `gravity` (a vector, default `[0, -9.81, 0]`), `dt`, `iterations`, and the solver's stiffness
  terms (`alpha`, `betaLin`, `betaAng`, `gamma`), with the paper's defaults.
- `destroy()` releases the GPU buffers.

### Bodies

- `addBox({ size, position, rotation?, velocity?, angularVelocity?, density?, friction?, fixed? })`
  and `addSphere({ radius, ... })` return a `Body` handle.
- `addHull({ points | shape, ... })` (0.2): a convex hull of points (a mesh's vertices), or a
  `shape` from `convexHull(points)` shared by many bodies (one GPU record per shape). `position`
  and `rotation` place the points' own frame; the body sits at the centre of mass on its
  principal axes. Hulls collide as hulls where the device allows a ninth storage buffer per stage
  (`world.hullsEnabled`), else as their bounding box: `recommendedLimits()` gives the renderer the
  limits to ask for. `BodyMesh` draws a shape's bodies with `bodies: shape` (`hullGeometry`).
- A handle's `index` is its slot in the GPU buffer, for custom shaders. It's stable for the
  body's life (bodies are added at runtime, into a world that starts empty, so the solver's
  spatial reordering of an initial scene never applies).
- `body.set({ position?, rotation?, velocity?, angularVelocity? })` (what's left out keeps its
  value as of the last readback), `body.setFixed(fixed)` (both through `rewriteBodies`), and
  `body.remove()` (its joints go, it's parked far off, and its slot is reused). All of these are
  batched into the next step.
- Kinematic bodies (0.2): `body.moveTo(position, rotation?)` on a fixed body slides it to the
  pose over the next update's steps, pushing and carrying what it touches (platforms, doors,
  hands); a fixed body given a velocity with `set` keeps moving (a conveyor). In the solver a
  fixed body with a velocity is kinematic: it advances by it at the start of each step from its
  starting pose, so contacts see it slide (teleported between steps, friction never saw it
  move and nothing was carried).
- Collision groups (0.2): `group` and `collidesWith` bitmasks (32 groups) on a body, or
  `body.setCollisionGroups(group, collidesWith)` later; two bodies collide when each is in a group
  the other collides with (default: group 1, colliding with all). The broadphase reads them from a
  buffer of their own (`GpuSolver3D.setFilters`), not the body record, which has no spare word.
  Raycasts take `collidesWith` too.
- Pushing (0.2): `body.applyImpulse(J, point?)` and `applyAngularImpulse(L)` act at the next
  step; `applyForce(F, point?)` and `applyTorque(T)` act every step until `clearForces()`. A
  small compute pass over the body buffer (`src/lib/push.ts`) turns each body's pushes, summed on
  the CPU, into Δv = J/m and Δω = I⁻¹ r × J with the mass, moments and pose the GPU holds, so a
  point is exact even though the CPU's poses are a readback old. (The solver's implicit step
  loses about 0.1% of a spin per step.)
- Reading back: `await world.read()` refreshes a snapshot, after which `body.position`,
  `body.rotation` and `body.velocity` are plain arrays as of that readback. Readback is async
  and costs a buffer copy, so it's explicit. A `world.readbackEvery` option keeps a snapshot
  refreshed automatically for gameplay that needs recent poses.
- Tracked readback (0.2): `world.read(bodies)` copies only those bodies' records (160 bytes
  each; runs of neighbouring slots in one copy) into a small staging buffer, where a full read
  is 16 MB at 100k bodies. The rest keep their last readback: each body remembers when it was
  last read, not the world. `world.track(bodies)` (null: all) points `readbackEvery` at a subset,
  the player and what's near it, say.

### Queries (0.2)

- `await world.raycast(origin, direction, { maxDistance?, ignore? })` gives the first body along
  a ray and where: `{ body, distance, point, normal }`, or null. `world.raycasts(rays)` casts many
  at once (up to 65,535). Against boxes, spheres and hulls (as they collide), where the GPU has
  them after the steps taken so far; the answer comes back a frame or two later, like a readback.
- On the GPU (`src/lib/raycast.ts`): every ray against every body, the nearest hit per ray by an
  atomic minimum on the distance's bits, ties to the lowest body index, then the normal. Brute
  force, so the cost grows with rays × bodies; a pass through the broadphase grid can come later.
  `ignore` (up to 16 bodies) lets a ray start inside its caster.

### Joints

- `addJoint(a, b, { anchorA?, anchorB?, type?, breakForce?, breakOnPull? })` returns a `Joint`:
  `type` 'fixed' (rigid, the default) or 'ball' (held at the anchors, free to turn: the joint
  with no angular stiffness). `breakForce` is the paper's torque-based fracture; `breakOnPull`
  also breaks on linear force (the new negative-threshold mode). A ball joint carries no torque,
  so it breaks only on pull.
- `addSpring(a, b, { anchorA?, anchorB?, stiffness, rest? })` (0.2): the solver's springs, added
  at runtime (`GpuSolver3D.appendSprings`); `rest` defaults to the anchors' distance when added.
- `joint.remove()` (`releaseJoints`, whose slots are reused). `joint.broken` and
  `world.onBreak(cb)` report breaks seen at a readback (a broken joint's penalties are zeroed on
  the GPU); the world then releases it, so its bodies collide again.

### Drawing: `BodyMesh`

- A `THREE.Mesh` that draws bodies straight from the solver's buffer (the existing
  `app3d/gpu-bodies3d.ts` technique): a storage attribute over the solver's GPUBuffer, and a TSL
  `positionNode` that places and rotates each instance. No copies, no readback.
- Options: `bodies?` (a shape, `'box'` by default, or a list, or a test; the mesh follows
  bodies as they come and go), `geometry?` (default: a unit box, or a sphere for `'sphere'`),
  and `material` (any node material; one already drawing another `BodyMesh` is copied, since each
  mesh sets its own nodes on it). A colour per body: `bodyMesh.setColor(body, color)`.
- Several `BodyMesh`es can share one world, for different materials per group of bodies.

## Decisions to make now

1. **Up axis: decided, y-up.** The GPU solver now has an `up` parameter, `[0, 1, 0]` by
   default, and gravity pulls against it (it used to act on z only). A solver seeded from the
   reference solver takes z-up (`REF_UP`), because the reference stays a faithful z-up port and
   its scenes, the demos, benchmarks and parity tests are built that way. The library is y-up
   throughout; `World` takes `gravity` as a vector and sets `up` and the scalar from it.
2. **Shapes in v0.1.** Boxes and spheres, which the GPU solver already collides. Capsules and
   convex hulls come later.
3. **Contact events.** Out of v0.1. `readContactList` exists, but a good event API (filtering,
   batching, cost) deserves its own design. v0.1 has joint breaks only.
4. **Raycasts and picking.** Out of v0.1 (CPU picking from a snapshot is easy to add later).

## What moves where

- New `src/lib/`: `world.ts` (World, Body, Joint), `mesh.ts` (BodyMesh), `index.ts` and
  `advanced.ts`. These are facades over `avbd3d/gpu/solver.ts`; the solver itself doesn't move.
- `app3d/gpu-bodies3d.ts` uses the same zero-copy technique as `BodyMesh` (with the demo's own
  looks). Moving it onto `BodyMesh` is for later; for now the placement code is duplicated.
- The voxel city moved to its own repo, `three-voxel-destruction`, and runs on
  `three-avbd/advanced`. As the API's acceptance test it found one gap: the reference `Solver`,
  `Rigid` and `sphere` a `GpuSolver3D` is seeded from, now exported there. It stays below the
  `World` because it runs its own compute pass over the bodies.

## Tests and release

- GPU tests (headless Dawn, `tests-gpu/lib.gpu.test.ts`) that use only the public API: a box
  comes to rest on the ground, a joint that breaks on pull lets go and reports it while an
  unbreakable one holds, and removed bodies' slots are reused.
- `BodyMesh` needs a renderer, so it's checked in the browser: `examples/basic.html` runs in the
  dev server (pyramid, raining spheres removed as new ones come, a breakable chain).
- `pnpm build:lib` then `pnpm pack`: installed into a blank Vite project, it typechecks with
  full library checking on TypeScript 5.9 (with `@webgpu/types`) and 7, and builds. The first
  publish is `0.1.0`, with the README's section on using it.
