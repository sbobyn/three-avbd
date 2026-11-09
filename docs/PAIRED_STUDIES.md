# Rapier-first paired studies — STE-3282

Steven's direction, 2026-11-08: build each selected demo in Rapier first, then three-avbd.
Use the result to discover strengths, extra application work and adoption/correctness/performance
weaknesses. No preset winner. Related release/adoption work remains in STE-3003; this study is
[STE-3282](https://linear.app/sbobyn/issue/STE-3282), existing M9 release umbrella.

## First study: interlocking sculpture

Run the repository's normal `pnpm dev`, then `/examples/interlocking-rapier.html`.
Rapier0.21.0, Three0.187.0; existing dependencies, hardware WebGPU rendering required.
The scene starts paused. Two already-linked, orthogonal rings hang from a fixed peg;
Play, push the lower ring, orbit, reset, and vary16/32/64convex pieces per ring.
Reset reconstructs only this owned physics world, retaining the camera and selected detail.
It is not possible to pass closed solid rings through each other without an intersection;
the authored linked starting arrangement is intentional, not a linking trick.

The model uses genuine convex-sector compound colliders that preserve the opening, not a
single hull that fills it. Visible meshes remain the same96segment tori at every collider detail.
The tube cross-section approximation uses8sample points; this is disclosed rather than called
exact geometry. Mass and analytic torus principal inertia are specified independently of
collider count; zero-density colliders prevent duplicate mass. Default timestep1/120s,
10Rapier solver iterations, gravity−9.81m/s², friction0.5, restitution0, sleeping/CCDoff.
Rendered geometry has smooth node materials; no graphics/performance result is implied.

Shared authored inputs: `src/comparison/interlocking-scene.ts`. Rapier-specific setup/compound
creation/lifecycle: `src/comparison/interlocking-rapier.ts`. Three.js controls/rendering/report
export: `examples/interlocking-rapier.ts`. This separation exposes engine-specific work; it
is not a generic adapter that hides adoption friction. The AVBD counterpart is deliberately
not implemented before this first Rapier baseline is reviewed.

Observation JSON includes exact build/dirty provenance, authored inputs, settings, poses,
steps/push count, dropped simulation time, device/browser/viewport and limitations. It is not a
benchmark or editable-project save. Reset returns to authored initial state; it does not restore
an exported observation. Hidden tabs pause; the loop bounds catch-up to4steps/frame and reports
dropped time. Renderer, controls/listeners, materials/geometry, Rapier world and the owned device
have explicit teardown. No user data, unrelated scene or shared session is reset/disposed.

## Evaluate before porting

1. Does contact alone support the linked rings on the peg? No ring-to-ring joints or scripted poses.
2. Can the user clearly see the openings and push/reset without hidden setup?
3. Does changing collider detail alter contacts or visible motion? Preserve awkward/failing cases.
4. Does reinitialization preserve chosen inputs/camera and release old resources?
5. Record actual confusion, documentation/API lookup and extra glue while implementing/reviewing.
   Agent elapsed effort is not a measured human onboarding time.

Device-free CPU tests cover openings at all3detail settings, mass invariance, supported hanging
before a push, finite bounded240step trajectory, reset reconstruction and idempotent world disposal.
They do not certify browser rendering, leak-free repeated browser mounting, arbitrary forces,
long-duration topological preservation or physical correctness. No GPU benchmark was run.

## Matched AVBD counterpart and comparison

After useful Rapier review, reproduce the same authored inputs, visible geometry, actions, camera,
render resolution and task in AVBD using public World/BodyMesh/SDF entry points. Use true SDFs
and matching mass/inertia; log baking/setup memory/time. A smooth SDF and a convex compound are
not identical approximations: expose geometric error and representation budget rather than
pretending piece count equals voxel resolution. Do not count precomputation as free.

Run separate views:
- **Feature/DX:** best supported implementation of the intended behavior in each engine. Record
  missing native features, extra glue, docs/type/dependency friction and lifecycle responsibilities.
  Count engine-specific code separately from common scene/render/UI/test/generated code; LOC is
  a supporting observation, not a quality score. Record actual time/help only when observed.
- **Controlled physics:** identical body mass/inertia, starting poses, timestep, interactions and
  physical intent. Disclose solver settings; equal iteration numbers do not imply equal work or accuracy.
  Controlled sleeping/CCD settings are distinct from a best-supported product configuration.
- **Performance:** only after both meet predeclared behavior/quality criteria. Pin commit/patch,
  package/device/browser/resolution/DPR, seed/input sequence and settings. Separate setup/bake,
  solver CPU encode/step and completed GPU work, CPU pose transfer, queries/events and rendering.
  Alternate serialized runs, warmup/repeats, preserve raw intervals and simulation/wall speed.
  The existing compare-frame/side/physics harnesses provide reusable evidence conventions; a live
  side-by-side view itself is not a benchmark. Don't sum unlike overlapping timers into false totals.

Physical acceptance must include finite state, absence of capacity overflow, no geometry escape,
contact/penetration tolerance and supported hanging/rest behavior—not FPS alone. Define the
geometric tolerance and observation window from both approximations before measurements; numbers
are pending rather than invented here. Never report speed ratios for cases that miss acceptance.

## Fix-and-retest loop

Keep raw observations with engine/source/settings and distinguish application mistake, docs/API
friction, missing feature, correctness bug and performance issue. Small known-cause fixes get
focused regression/consumer verification; rerun both on the same case after a material fix and
preserve original baselines. Larger solver/API changes remain explicit proposals with acceptance
and dependencies. Don't tune only AVBD until it wins, weaken a quality threshold or use the
Rapier implementation's accidental mistakes as a selling point. Existing Rapier0.21 soft-body
plasticity/tearing also rules out a blanket “Rapier cannot bend or break” claim.

Next sequence: Rapier interlocking review → matched AVBD implementation → paired evidence →
prioritized fixes/showcase claims. Then consider bend/hold/snap, gear workshop and kinetic/art
studies through the same process; no second large demo is a prerequisite to learning from this one.
Source PR delivery does not authorize a new production deploy or package publication.
