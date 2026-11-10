# Library and demo guide

[Start with the README](../README.md) for setup. This guide describes the local 0.4.0
candidate source; 0.3.0 on npm lacks the new APIs. Historical measurements below retain
their original scope and are not release or cross-device acceptance.

## What's new in 0.4

Partial body writes that keep the GPU state you didn't set, GPU kinematic targets, lifetime body
IDs and step-stamped reads, body activation and reset, fixed storage with `three-avbd/pool`,
CPU static queries (`three-avbd/queries`), capability and hull preflight, an opt-in contact
margin, and the experimental `three-avbd/sdf` entry point. `body.set` and `world.read()` changed
behaviour: read [the 0.4.0 release notes and migration](RELEASE_0.4.md) before upgrading
from 0.3.

## three-avbd or Rapier?

**[three-avbd vs Rapier](COMPARISON.md)**: features side by side, the measurements so far,
the cons and how to shrink each one today. In short, why three-avbd (M4 Max, sources in that page):

- **Scale.** A 110,000-brick ring steps in 9.3 ms headless (10.4 ms in Chrome), 4 iterations. On a 9,132-body ring,
 Rapier 0.21 took 67 ms a step and three-avbd 2.1 ms (serialized, 4 iterations each; neither met
 the shared quality target).
- **No copy to draw.** `BodyMesh` renders straight from the solver's GPU buffer.
- **Structures that break and bend.** Breakable and plastic joints run on the GPU; Rapier has
 neither built in.
- **Churn without allocation.** Fixed-storage body pools acquire, release and step with no new GPU
 buffers or pipelines.

Where Rapier is better: small scenes (at 1,000 resting boxes it was slightly faster per step and rested tighter), sleeping,
CCD, more joint types and shapes, character and vehicle controllers, synchronous queries,
cross-machine determinism, and it runs without WebGPU.

## Experimental SDF collisions (new in 0.4)

The experimental `three-avbd/sdf` entry point is new in 0.4.0; 0.3.0 does not contain it.
Its API may change. It provides mesh-to-voxel baking,
analytic/voxel sampling, mass properties and curvature seeds, plus a cancellable
worker helper. [CPU baking/API usage](SDF_BAKING.md) feeds the experimental
[`World.enableSdfCollisions()` API](SDF_WORLD.md): automatic GPU candidate
spatial filtering, runtime body/field refresh, automatic capacity growth,
independent normals and warm starts.
Pair-level contact events and bounded SDF surface raycasts are supported.

Run `pnpm dev` and open `/sdf.html` for the interactive SDF playground: rings,
twisted solids and a mesh-baked gear pile. Start with **Play**, grab a body with
left-drag, right-drag to orbit, or drop another shape. It starts paused with 12
bodies and caps spawning at 36. Rendering follows the browser's animation frames;
physics retains its fixed timestep and bounded catch-up. Hidden tabs pause, and
paused views stop rendering once camera motion settles. Contact points/normals are
an optional throttled readback; body drawing reads the GPU buffer directly.
Mass/inertia use box proxies, so this is a collision playground, not a paper benchmark.

Open `/sdf-gears.html` for a contact-driven gear train. One motorized input drives
20/12/28-tooth gears through baked SDF collisions; follower rotations are not scripted.
Drag the gold gear or handwheel, reverse the motor, and toggle the contact-load overlay.
Disabling tooth collisions resets the train with stationary followers as a negative control.
The gears use polygon-integrated mass/inertia and two ball joints per follower axle.
See [gear-demo validation and limitations](SDF_GEARS.md).

Open `/sdf-released.html` for eleven scenes using the released resolution-100 fields,
original geometry, poses, mass and full inertia: box/gear stacks, plain and distorted
planks, chairs, cows on spikes, bunnies, a spiky wheel and analytic primitives.
Default **smooth playback** runs without per-substep reference readbacks. Expand
**Reference comparison** to reset into the bounded six-second diagnostic mode with
CPU-reference metrics; that mode is for numerical inspection, not FPS measurement.

The playground and reference-scene pages offer **Measure 4s**: one second of warmup, four seconds of visible browser
frame intervals, then automatic pause. The report separates frame cadence from simulation
speed and records final GPU drain time; **Save JSON** exports the raw intervals and context.
The historical SDF package checkpoint is in [SDF_RELEASE_0.4.md](SDF_RELEASE_0.4.md).
Current local desktop results, verification and release boundaries are in
[SDF demo release notes](SDF_DEMO_RELEASE.md). These are short observations on one device,
not a promise of 60 FPS across browsers or a reproduction of paper GPU performance.
See [API & limitations](SDF_WORLD.md) and
[released-scene comparisons](SDF_RELEASED_COMPARISON.md).
See [paper reproduction status](SDF_REPRODUCTION_STATUS.md) and
[research reconciliation](SDF_RECONCILIATION.md) for historical evidence and acceptance limits.

`three-avbd/queries` provides CPU-only static triangle BVHs, nearest rays, bounded sphere
and capsule overlaps and translational sweeps, with no GPU or Three runtime import. See
[static queries](QUERIES.md) and the [Node projectile example](../examples/static-projectile.ts).
These queries are independent of solver collisions and GPU bodies.

## Use it in your project

For a complete standalone consumer, follow [the setup guide](SETUP.md#fresh-threejs-consumer).

The shorter API sketch below assumes you have already created `scene` and `camera`
as in a normal Three.js application. For a runnable starting point, use the complete example above.

```ts
import * as THREE from 'three/webgpu';
import { World, BodyMesh } from 'three-avbd';

const renderer = new THREE.WebGPURenderer();
const world = await World.create({ renderer, maxBodies: 50_000 }); // y-up, gravity -9.81

world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
const crate = world.addBox({ size: [1, 1, 1], position: [0, 5, 0] })!;
const ball = world.addSphere({ radius: 0.5, position: [0, 7, 0], density: 3 })!;
world.addJoint(crate, ball, { anchorA: [0, 0.5, 0], anchorB: [0, -0.5, 0], breakForce: 200 });

// Every box, drawn straight from the solver's GPU buffer (a mesh per material or shape)
scene.add(new BodyMesh(world, { bodies: 'box', material: new THREE.MeshStandardNodeMaterial() }));
scene.add(new BodyMesh(world, { bodies: 'sphere' }));

let previous = performance.now(); // THREE.Clock is deprecated: use the loop's timestamp (ms)
renderer.setAnimationLoop((now) => {
 world.update(Math.min((now - previous) / 1000, 0.1)); // fixed steps; the gap is capped at 0.1 s
 previous = now;
 renderer.render(scene, camera);
});

// Poses come back from the GPU on request (an async copy): after this, crate.position is current
await world.read();
```

- **Bodies**: `addBox`, `addSphere`, `addHull({ points })` (convex hulls; pass the renderer
 `requiredLimits: await recommendedLimits()` so they collide as hulls;
 use `World.create({ ..., requireHulls: true })` to reject unsupported devices and
 `world.capabilities` to inspect the installed collision backend), with position, rotation,
 velocity, density, friction, `fixed`;
 `body.applyImpulse(J, point)`, `applyForce(F, point)` (every step until `clearForces()`; calls add up, and the world-space `point` stays put while the body moves),
 `applyTorque`, collision groups (`group`, `collidesWith`), `body.moveTo(position, rotation)` (a
 fixed body as a moving platform or door, carrying what it touches), `body.set({ position, velocity, ... })`,
 `body.setFixed()`, `body.remove()` (its slot is
 reused). Adds, changes and removals go to the GPU together at the next step.
- **Joints**: `addJoint(a, b, { anchorA, anchorB, type: 'fixed' | 'ball', breakForce, breakOnPull, rest, yieldForce, breakBend })`,
 `addSpring(a, b, { stiffness, rest })`, `joint.remove()`, and `world.onBreak(joint => ...)` at
 each readback. A fixed joint can hold two bodies turned apart (`rest`: a rotation, or
 `'current'`, which takes the rotations as last read, so read first or add the joint before the
 bodies move), bend for good under load (`yieldForce`: a plastic hinge, on the GPU with no
 readback) and break once it has bent too far (`breakBend`, in radians: a `breakForce` above the
 yield only catches a sudden jump, and with `breakOnPull` it is in newtons);
 `world.readJoints()` then `joint.force` and `joint.bend` say what it carries and how far it has
 given.
- **Drawing**: `BodyMesh` takes any node material, geometry (scaled to each body's size) and
 a set of bodies (a shape, a list or a test), with `setColor(body, color)` per body.
- **Raycasts**: `await world.raycast(origin, direction)` gives the first body hit, the point and
 the normal; `world.raycasts([...])` casts many rays in one GPU pass.
- **Contact events**: `reportContacts: true` on a body and `world.onContact(e => ...)` for
 begin and end, with where, the normal and how hard (for sounds, damage, triggers).
- **Reading back**: `await world.read()` (or `world.readbackEvery = n`) for positions,
 rotations and velocities, and to learn which joints broke. `world.read(bodies)` and
 `world.track(bodies)` read only the bodies you need (160 bytes each, not the whole world).
- **Headless**: `World.create({ device })` runs without a renderer (Node with Dawn, workers).
- **Advanced**: `three-avbd/advanced` exposes the solver underneath (`world.solver`) and the
 layout of its body, joint and contact buffers and counters, for your own compute passes and
 readbacks. `appendJoints` takes each joint's own break threshold, rest rotation, yield and bend
 limit. (0.3 grew the joint record to 40 floats: stride by `JOINT_FLOATS`.)

The design and what's planned: [docs/API.md](API.md). Runnable examples are indexed at
`/examples/index.html` (`pnpm dev`, then
`/examples/`): [basic](../examples/basic.ts), [body lifecycle](../examples/body-lifecycle.ts),
[body pool](../examples/body-pool.ts), and experimental SDF examples
([gears](../examples/sdf-gear.ts), [balls in a torus](../examples/sdf-hollow.ts),
[mesh baked in a worker](../examples/sdf-from-mesh.ts)).

## Per-body gravity scale

Candidate source supports `gravityScale` on box, sphere and hull options. In your small
consumer, replace the existing ball creation line to try a floatier mechanic. Try each
setter separately while the simulation is running; running all calls before the first step
would leave only the final value:

```ts
const ball = world.addSphere({ radius: 0.5, position: [0, 7, 0], gravityScale: 0.35 })!;
// Step/update the same World as before; rendering and fixed timing are unchanged.
ball.setGravityScale(0);  // from the next step: existing velocity continues, with no gravity
ball.setGravityScale(-1); // reversed gravity; other forces and wind are not scaled
console.log(ball.gravityScale, world.capabilities.gravityScale);
```

Default1 is ordinary gravity. Values must be finite as f32 and within[-1000,1000] as f32;
the effective gravity product must also be finite. Invalid changes throw before changing
configuration, including a `world.gravity` change that would overflow a live body's or pool
template's scale. These are numeric input bounds, not a guarantee of stable extreme scenes.
Tiny values can flush to zero on a device. Fixed/kinematic bodies store the configuration but
do not fall. Reset/disable keep it; pool reacquisition restores the template, not the previous
lease. Read the capability again after switching advanced backends; custom solve shaders are
unsupported for per-body scaling. Standard and experimental SDF paths have bounded M4 Max
checks; no M1/GTX1080 or performance claim follows.

This is current source, not registry0.3.0. Rebuild/repack deliberately using the setup recipe
before trying it in your own consumer. Damping, restitution, sleeping and CCD remain separate
unsupported features. [API and data flow](API.md#per-body-gravity-scale).

## Capture poses and play them back

A small, end-to-end use of the public API: step a `World` headless, record every body's pose, and
play the result back with plain Three.js and no physics. It is an example-local workflow
(STE-3003, partial), separate from the realtime demo and not a release or format claim.

Prerequisites: a source checkout with its dependencies already installed (Node with
`--experimental-transform-types`, the `webgpu` Dawn binding from `devDependencies`) and a **hardware**
WebGPU adapter. Fallback, software and unidentified adapters are refused, with no override, and
nothing is written when they are. Run from the repository root:

```bash
node --experimental-transform-types --no-warnings examples/pose-capture.ts --out ~/pose-track.json --bodies 12 --steps 120
pnpm dev    # then open http://127.0.0.1:5317/examples/pose-playback.html and choose the file
```

- `--out` is required, must end in `.json`, and must be a **new** file in an existing directory
  (never overwritten; write it outside the repository). Bad arguments, an existing file or a missing
  directory are refused before any GPU is requested. `--bodies` is 1 to 63 dynamic bodies (a fixed
  floor is added; default 12), `--steps` 1 to 300 (default 120). Time step 1/60 s and 10 iterations
  are fixed and written into the file.
- The scene is a fixed floor and a staggered grid of dropped boxes and spheres. It is authored in
  [pose-capture.ts](../examples/pose-capture.ts), not a scene editor.
- The track records, per step actually read (`world.read().step`), each body's id, shape, size,
  position and unit quaternion (y-up, metres, seconds), plus the capture record: package version,
  Git head and change counts (no paths), adapter identity, requested limits (no optional features),
  configuration, and **one run's** wall-clock capture and readback times and the file's byte size.
  Those times are not GPU time, a performance comparison or a first-load measurement.
- The playback page checks the 8 MiB byte limit before reading the file. After parsing JSON it
  validates counts, poses and a frame span of at most 300 steps (64 bodies, 301 frames) before
  allocating pose arrays or meshes. An invalid file keeps the previous track loaded. Play,
  pause, scrub and orbit; it loops.
  The file stays in the browser. No sample track ships with the site.
- **Transforms only.** No velocities, joints, contacts or events are recorded, so the file cannot
  restore a World, resume a simulation or support a claim of repeatable replay. The schema
  (`three-avbd.example.pose-track/v0-provisional`) is private to these examples, not a package
  export or interchange format (no USD/Alembic/glTF).

Status (2026-11-09, source base `fc12420` plus the pose-example patch): focused CPU checks
cover validation, sampling and CLI refusals. A Node 25.2.1/Dawn 0.6.1 run on Apple M4 Max,
Metal 3 (not a fallback adapter), captured six dynamic bodies plus the floor for 30 steps:
31 frames, 13,574 bytes. Capture wall time was 91.6 ms, including 65.5 ms awaiting reads;
these are one run's observations, not a performance qualification. In the Three 0.187.0
hardware WebGPU player, selecting that file, pause, scrubbing to the end/back to zero,
reloading and rejecting a bad file while keeping the previous track all worked. No sample
file is shipped. Large scenes, pixel quality, touch, memory stress, other devices and
deterministic re-simulation remain unqualified.

## What's in the demo

- **The paper's scenes.** Brick Ring (110,000 bricks, Fig. 1), Brick Walls (Fig. 3), Wall
 Smash, Breakable Wall, Chain Mail, Ragdolls on Cloth (Fig. 14), Heavy Pendulum (a 50,000:1
 mass ratio), a Flag in the Wind (pressure drag and skin friction on bodies marked as sails),
 and scale tests: Jointed Drop, box piles and Box Columns (100,000 boxes).
- **Plastic Beam**: a cantilever welded to a wall with a weight on its end. The welds are
 plastic: they hold up to a moment, bend past it and keep the bend (take the weight off and the
 beam stays bent), and the wall's weld tears under a heavy enough weight.
- **Starry Night** pours 20,000 spheres into a glass-fronted box and they come to rest as the
 painting. **Mona Lisa Tower** drops 50,000 bricks that stack into the Mona Lisa. Both lean
 on the solver being deterministic: the scene runs once off screen to find where each body
 lands, colours it from the painting there, and then runs again for real.
- **The 2D demo**: the 19 scenes of the authors' 2D demo (stacks, ropes, springs, soft
 bodies, a motor, fracture), on the CPU reference or the GPU, plus scalable box rain.
- **Custom** builds any showcase scene at a size you pick.

Controls, 3D: left-drag a body to grab it (it glows under the pointer), left-drag elsewhere to
orbit, right-drag to pan, wheel to zoom. Space, B or middle-click fires a cannonball (its
radius, mass and speed are in the scene panel, and under Settings → Advanced). P pauses, `.`
steps, R resets. 2D: left-drag grabs, right-click spawns a box, wheel zooms, shift-drag or
middle-drag pans, WASD/QE move the camera.

On a device's first visit the demo times a few solver steps off screen and remembers what
the GPU can run: a weaker GPU lands on a smaller scene, scenes that would run under 60 fps are
marked "slow here" and those under 30 fps ask before loading. Settings → Advanced measures
again.

## Physics concepts and configuration

The public `World` uses metres, kilograms and seconds, **y-up**, quaternion `[x,y,z,w]` rotations,
and default gravity `[0,-9.81,0]`. Some research/showcase scenes use z-up internally; don't copy
those coordinates blindly into a library scene. Bodies are rigid: deformation comes from collections
of bodies joined by constraints, not deformable meshes. Density sets mass from geometry; `fixed`
makes a body immovable. Contacts resist overlap; friction resists sliding. Joint anchors are local
to their bodies. Springs, plastic yielding and breaking have distinct parameters and units.

`World.create({renderer, maxBodies, dt: 1/60, iterations: 10, gravity: [0,-9.81,0]})`
sets the basic budget. More iterations generally improve constraint convergence at extra GPU cost;
they do not guarantee stable large piles. `world.update(seconds)` manages fixed steps; `world.step()`
is for explicit stepping. Keep the timestep fixed when comparing quality. Body creation can fail at
capacity, so check its result. Use fixed storage and `BodyPool` only after sizing capacities;
see [pooling](API.md) and [release/migration contracts](RELEASE_0.4.md).

Rendering reads GPU storage directly; CPU body poses are stale until `await world.read()`.
Readback is asynchronous and adds cost. In 0.4, `body.set` changes only supplied fields; it does
not implicitly reset the rest of the motion. Use the lifecycle example for intentional resets.
CPU static queries are a separate service, not live solver-body collision queries.
Destroy a world when your app retires it (`world.destroy()`); dispose your renderer/materials
according to Three.js ownership. GPU device loss requires recreating app-owned GPU resources.

There is no CCD or sleeping comparable to mature CPU engines; small fast bodies can tunnel.
Cross-device bitwise determinism is not promised. The SDF interface is experimental, fixed
storage pools use standard collisions, and a convex hull is not an arbitrary concave mesh.
See [API and architecture](API.md), [queries](QUERIES.md),
[SDF contracts](SDF_WORLD.md) and [migration](RELEASE_0.4.md).

### Timing diagnostics

`world.update(seconds)` retains its existing fixed-step and `maxSubsteps` policy. Read
`world.droppedTime` for the cumulative seconds discarded by its catch-up clamp, starting at 0
per World. Simulated time and the at-most-one-dt carried remainder are excluded. If your app
caps a frame delta before passing it to `update`, that earlier loss is invisible to the World;
keep host-clock accounting separately if needed. The value is not GPU time or a speed score.
It has no reset setter; creating a new World starts a new total, and body reset does not.

## Troubleshooting and updates

- **Blank canvas / WebGPU error:** inspect DevTools console, confirm localhost/HTTPS and a
 hardware WebGPU device. A renderer's WebGL fallback cannot execute this solver. Don't disable
 browser security or force software rendering to claim support.
- **Port in use:** choose another port; don't kill an existing project's server.
- **Cannot resolve package export:** run `pnpm build:lib` before packing and reinstall the new
 tarball in the consumer. Registry 0.3.0 lacks candidate 0.4 subpaths such as SDF.
- **Hull fallback / device limit failure:** use `recommendedLimits()` when creating the renderer;
 inspect capabilities or require hull support explicitly. Lower body/storage budgets on small devices.
- **Slow / unstable scene:** start small, keep the tab visible, separate frame cadence from solver
 time, and record iterations, timestep and device. Avoid extreme mass ratios and oversized time steps.
- **Install fails:** check Node/pnpm versions and network access. Don't silently regenerate the lockfile.
- **Updates:** retain this snapshot and its manifest. Obtain an explicitly chosen newer version,
 read migration notes, test it in a separate copy, then update your consumer's pinned dependency
 and lockfile. Updates are chosen explicitly by the user; no automatic installation is performed.

## How it works

The whole step runs on the GPU, following the paper's Algorithm 1: a hashed-grid broadphase,
an OBB SAT narrowphase with up to eight contacts per pair, contact persistence through a hash
table (warm-started penalties and multipliers), a CSR adjacency, Jones-Plassmann graph
colouring, and then per-colour primal solves (a 6×6 LDLᵀ per body, cone friction) with a
dual update per iteration, all dispatched indirectly so the CPU never reads a count back.
Rendering is zero-copy: Three.js draws the instances from the solver's body buffer.

The GPU solvers are validated against faithful TypeScript ports of the authors' C++ demos,
which are themselves checked bit for bit against the upstream code. A seeded single step on
the GPU matches the 3D reference to 3e-6; behaviour suites cover stacking, friction, joints,
fracture and scale. Deterministic replay observations are scoped to the measured device, build and setup;
this is not a cross-device or arbitrary-scene replay guarantee.

Measured on an M4 Max in Chrome, against the paper's numbers on an RTX 4090:

| scene | ours | paper |
|---|---|---|
| Brick ring, 110k bricks, 4 iterations | 10.4 ms | 9.8 ms |
| Jointed drop, 34k bodies + 71k joints, 10 iterations | 6.4 ms | 16 ms (incl. cloth) |
| Brick gables, 506k bricks, 3 iterations | 25.5 ms | 17.6 ms |

Every measured decision, with how it was measured, is in [docs/FINDINGS.md](FINDINGS.md);
the stages the project went through are in [docs/PLAN.md](PLAN.md). The
[results page](https://three-avbd.vercel.app/results.html) compares machines; add yours from
[bench3d.html](https://three-avbd.vercel.app/bench3d.html) with "Download results".

## Running it locally

```bash
pnpm install
pnpm dev    # http://127.0.0.1:5317 (3D), /2d.html, /bench.html, /bench3d.html, /results.html
pnpm check   # typecheck + CPU tests + GPU tests (headless Dawn) + production build
```

URL parameters: `?scene=Pyramid`, `&backend=gpu` or `cpu`, `&paused`.

Benchmarks and studies, headless through Dawn (the `webgpu` package):

```bash
pnpm compare:rapier # experimental Rapier/AVBD batched-throughput comparison (Node + Dawn)
pnpm bench3d:gpu # 3D suite: the paper's large scenes and small ones (args: tiers or case names)
pnpm bench2d:gpu # 2D GPU benchmark with per-phase timing
pnpm bench2d   # 2D CPU scaling baseline
pnpm sweep2d   # iteration count: cost vs quality on the GPU
pnpm scaling2d  # box rain 10k-250k, writes docs/data/scaling2d-<adapter>.json
```

`pnpm bench3d:gpu <tiers> --json <file> --machine <name>` writes a report for the results
page (they live in `docs/data/bench3d/`). Keep a browser benchmark's tab visible while it runs.

The experimental [Rapier comparison](RAPIER_COMPARISON.md) also runs at `/compare.html`
(`/compare-frame.html` for a rendered workflow, `/compare-side.html` for a live side-by-side view). Its completed-batch timing is not a rendered FPS
comparison, and the numbers in that document are historical (see its header).

