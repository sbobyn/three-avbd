# Experimental World SDF collisions (source build)

This unpublished API attaches SDF collision fields to existing World bodies. It
uses the production AVBD solver with independent contact normals and persistent
warm starts. It is explicitly enabled and does not change normal World collisions.

```ts
import { World } from 'three-avbd';
import { bakeVoxelSdf } from 'three-avbd/sdf';

const world = await World.create({ device, maxBodies: 16 });
world.addBox({ size: [8, .4, 8], position: [0, -.2, 0], fixed: true });
const body = world.addBox({ size: [1, 1, 1], position: [0, 1, 0], density: 1 })!;
const { field } = bakeVoxelSdf(geometry, { resolution: 32 });
await world.enableSdfCollisions([{ body, field, scale: 1 }]);
world.step();
// Stage topology changes, then await an atlas refresh before the next step:
const added = world.addSphere({ radius: .2, position: [0, 3, 0] });
await world.updateSdfCollisions(); // existing bindings persist
// Replace a field explicitly:
await world.updateSdfCollisions([{ body, field: replacementField }]);
// Or restore standard shape collisions:
world.disableSdfCollisions();
```

`enableSdfCollisions(bindings = [], params = {}, broadphase = {})` returns a promise. The second
argument overrides SDF `CollisionParams`. Unassigned boxes/spheres get analytic
fields matching their size. Hulls require an explicit field. Duplicate bindings,
foreign/removed bodies and invalid scales are rejected.
`sdfCollisionsEnabled` reports whether installation finished.

## Frames, geometry and ownership

Fields subtract their stored `centerOfMass` before uniform scaling. Optional
binding `rotation` maps that centered field frame into the body's principal frame
(identity by default); scale and rotation are copied at setup. Render geometry
must independently use the same principal frame.

`principalInertia(tensor)` from `three-avbd/sdf` diagonalizes a symmetric positive
3×3 inertia tensor. Its quaternion maps principal coordinates into input coordinates.
Set body rotation to source rotation multiplied by that quaternion, and field
rotation to its inverse. `BodyOptions.massProperties: { mass, moments }` overrides
proxy mass/inertia for dynamic bodies (kg and principal kg·m²); fixed bodies remain
static. Values must be finite, positive and representable in float32. This does not
infer a tensor from an SDF or rotate your render geometry automatically.

`await world.readSdfResults()` exposes diagnostic contacts/counters. Do not step,
refresh or dispose the world concurrently with this diagnostic readback.

Only collision geometry changes. Body mass, diagonal inertia and render geometry
are unchanged. Make these appropriate for the SDF yourself. BodyMesh still draws
from the production body buffer without readback. To draw custom geometry, supply
geometry in the same COM frame, divided by `Body.size` because BodyMesh multiplies
it by those dimensions. This API does not generate an SDF surface mesh.

## Automatic candidates

Each step prepares world SDF bounds, then builds a hashed centre-cell grid. Regular
bodies search 27 neighboring cells; oversized bodies use a separate list with no
64-body ceiling. Exact cell checks reject hash aliases. AABB margin, static/static,
mutual collision masks and shared live-joint exclusions filter candidates.
Stepping needs no CPU pose or pair readback.

The optional third argument accepts `{ cellSize, maxPairs }`. Cell width defaults
to the median scaled field bounding diagonal. Candidate capacity defaults to eight
pairs per body (at least 64, capped by possible pairs and device limits). Setup
reserves five solver contacts/manifolds per candidate. Buffers are linear in body
count and configured candidate capacity, rather than every possible body pair.

A GPU hash table matches exact body-pair identities to the preceding compact result
slots, preserving independent normals and warm starts even when output order changes.
Separated or filtered pairs lose their history; re-entry cannot resurrect old forces.

`world.solver.readCounters()` reports accepted candidates in `pairs`.
If candidate capacity is exceeded, overflow bit 1 is set and excess pairs are omitted:
**that frame is incomplete**. World checks counters every ten steps and grows SDF
candidate/history and production contact buffers for later steps. It copies history
on the GPU, preserving unchanged contact identities, normals and world-space forces.
It does not roll back or replay the overflowing step. Preallocate for peak density
when losing even one frame of contacts is unacceptable.

`maxPairs` is the initial capacity. Set `autoGrow: false` to keep it fixed.

`maxPointsPerPair` (default 5, at most 20) is the per-pair point capacity of the GPU narrowphase.
It sets the ceiling `cacheSize ≤ points−1` and `cacheSize + randomSamples ≤ points`. The default
holds four cached points plus one fresh sample. The paper's widest sweep (Fig. 6 and Table 2:
16 cached + 4 samples) needs 20. Memory scales with it: each pair's result is `8 + 28·points`
words, and the solver reserves `points` contacts per candidate pair. The 5-point default is
bit-identical to the previous fixed layout.
`await world.adaptSdfCollisions()` explicitly checks/grows capacity and returns
whether it grew. It reads counters only; it never reads poses or contacts.
`sdfCollisionCapacity` reports current capacity. A device-limit/allocation failure
during automatic growth is exposed as `sdfCollisionError` and suspends automatic
retries; explicit adaptation/update rejects. Successful adaptation/update clears
the error. Candidate order, including the retained subset on overflow, is not
deterministic.

Dense cells, many oversized bodies, or extreme coordinates saturating grid indices
can still approach quadratic work. This is a single-level spatial grid, not a
hierarchical solution for every size distribution.

## Current boundaries

- Bodies can be added/removed while enabled, within World's existing `maxBodies`.
  These mutations mark `sdfCollisionsNeedUpdate`. Await `updateSdfCollisions()`
  before stepping or raycasting; those operations reject while topology is dirty
  or setup/update is pending. Slots may be sparse, reused, or all removed after
  initial setup. Vacant slots are collision/query masked.
- `updateSdfCollisions(bindings = [], broadphase = {})` retains omitted live bindings,
  supplies analytic fields for new boxes/spheres, and replaces explicitly supplied
  fields. New hulls require explicit fields. Changed/recycled slots lose their
  contact history; unrelated pairs retain it. Explicitly resubmitting a field
  invalidates its history even when the values are unchanged.
- Caller fields/scales are snapshots. Mutating a caller's field cannot affect later
  growth or omitted bindings during a refresh. Refresh rebuilds the packed atlas
  and bridge, so batch edits rather than doing this each frame. There is no
  incremental voxel-atlas allocator or automatic body-capacity growth yet.
- Updates lock topology while pending. Failed field updates keep the previous
  backend; staged body edits are not rolled back, so a dirty world requires a
  successful refresh (or disabling SDF) before stepping again.
- Contact events support `reportContacts` before/after enabling. A GPU reporting pass
  combines the independent points into one begin/end per physical body pair.
  The point is the mean of the solved local anchors transformed to world space;
  impulse is the sum of absolute normal-force magnitudes times dt. The representative
  normal is force-weighted (a contact normal is used when forces cancel or are zero).
  Solver normals, anchors, penalties and warm starts are not modified. Reporting
  respects masks, joint exclusions, separation and reporting toggles. Like standard
  World events, pair identity uses non-reused `Body.id` lifetimes (1..0x7fffffff):
  same-slot replacement against the same partner produces end then begin. Up to eight
  removed generations per slot survive until a read includes the following step's end
  pass; events with evicted identities are suppressed and counted in
  `world.droppedContactEvents`, never attributed to a replacement. Force history
  still invalidates on reuse.
- `raycast`/`raycasts` query the **SDF surface**, including non-convex holes, with
  current GPU poses, COM offsets and uniform scale. Masks/ignored bodies and nearest
  ties follow the standard query API. Pending queries retain the submitted rays
  and Body handles even if callers mutate inputs or disable SDF and reuse slots
  before readback completes; a returned Body can therefore already be removed.
  Origins inside return distance zero and the
  opposite ray direction. Disabling SDF restores standard shape raycasts.
- SDF ray batches are limited to **256 rays**. Bounds-clipped sphere tracing uses a
  conservative slope bound computed once from the field snapshot (voxel slopes
  come from phi differences, not the stored shading gradients). Each body/ray has
  at most 512 samples; non-convergence returns a miss. Near-tangent rays or extreme
  warps can therefore miss. Surface tolerance is 0.0001 times the smallest local
  bounds extent (at least 1e-6 local units), multiplied by uniform scale. Hits are
  approximate within this field-value tolerance; this is not exact triangle picking.
  No collision margin is added. Rays require finite origins/directions, a nonzero
  direction and finite nonnegative maxDistance; omit maxDistance for the default.
  Only query results are read back, not all body poses.
- No target-device performance claim or stress-scale validation; spatial tests reach
  256 bodies and deliberately avoid heavy concurrent GPU loads.

Destroying the World during async setup rejects the promise and cleans up any
uninstalled bridge. Disabling restores the standard backend and clears collision
warm starts. Existing joints remain.

See `SDF_PRODUCTION_BRIDGE.md` for contact encoding and force transport.

## Curved contacts and friction

The reference collision distribution regularizer (`CollisionParams.alpha`, default
0.01) can bias curved contact normals and introduce drag even with zero friction.
A three-second torus sliding test starting at 1 m/s ended at approximately
0.95 m/s on GPU and 0.89 m/s on CPU at defaults. For friction-isolation checks,
`{ alpha: 0, tolerance: 0.001, maxIterations: 100 }` reduced this loss to below
0.02% in that scene. Disabling repulsion changes contact distribution and tighter
search costs more; this is not a universal replacement preset. Solver stabilization
alpha is a separate parameter. See FINDINGS.md for the measured cases and limits.

## Current demo release scope

The small interactive playground and original-asset scene viewer have a separate
[release/readiness record](SDF_DEMO_RELEASE.md), including visible-browser frame captures.
These demonstrations do not depend on promoting the large-pile search experiments.
The validation history below is dated implementation evidence, not the latest gate count.

## Validation

The bounded local Dawn suite passed **112 GPU tests and 131 CPU tests**, with
zero skips in the selected suite. Typecheck, Vite build and library build pass
(the existing Vite chunk-size warning remains). Independent re-review found no remaining actionable issues after fixes for
pending-query mutation/slot reuse and small nonzero slab directions. Tests cover
multi-point aggregation, summed impulses, filtering/separation/reporting toggles,
torus holes, nearest ties, masks/ignores, current poses without stepping,
COM/rotation/scale, steep voxel fields, pending-query input/slot snapshots and
large-scale/shallow/parallel slab cases. Five additional non-convex regressions cover
analytic/baked cavities, crossed moving rings and flat/incline friction versus CPU.
Five stress/showcase tests remain
excluded; this is not the unrestricted `pnpm check`. The bounded `/sdf.html` showcase was visually checked in-browser (presets,
spawning, grabbing and contact overlays); no target-device performance test was performed.

Spatial regressions compare candidates with brute force over 96 rotated/scaled fields,
check sparse 256-body coverage and linear capacity, 67 oversized bodies, overflow
recovery, and force-cache continuity/re-entry across pair churn.


Lifecycle regressions cover automatic/manual growth and opt-out, production contact
buffer reallocation with world-space force transport, sparse/all-removed topology,
append and same-step slot reuse, field snapshots/replacement, failed updates,
stale async adaptation and teardown during setup.


Lifecycle review added regressions for reusing an unflushed new-body slot, pending
raycasts through refresh/destruction, rejected device-limit growth and temporary
buffer cleanup after an injected host allocation exception. Real GPU OOM/device
loss was not induced by these tests.

Sticking contacts retain both material anchors and evaluate their normal constraint
from those anchors. The detector's current separation is used only for non-sticking
contacts; mixing a relocated detector point with retained anchors caused residual
mesh motion. The released-scene viewer offers earlier mesh contact activation,
with unchanged resting gap, independently of the library defaults. See
[SDF released comparisons](SDF_RELEASED_COMPARISON.md) for measured improvements
and remaining transient/final mesh intersections.

`collision.signedSeparation` optionally fixes mixed inside/outside optimizer samples
against static analytic boxes: project the two surface offsets onto the static
box's normal instead of taking an unsigned length. The default remains false for
oracle compatibility. It does not change mesh/mesh contacts or contact budgets.

`collision.refreshDeeperContacts` optionally releases a sticking constraint's old
material anchors when the new anchors move more than three optimizer tolerances
and detect separation deeper by more than one tolerance. Identity, independent
normal and basis-transported warm force/penalty survive; tangential anchor error
restarts at zero. This avoids preserving an obsolete support point over a newly
penetrating contact. Default false; the released mesh-quality profile enables it.

`collision.sgdGradientStopOnly` (only with `optimizer: 2`) stops gradient descent only on the
gradient norm or `maxIterations`. It drops the released ‖Δx‖ < τ test, which mostly fires
when the projected iterate stalls on the search box. This matches the paper's Table 5 SGD cost in
aggregate and in pattern (r = 0.73), at about 6.5× the released SGD iterations (Table 5 mean). Default false, which matches the released code.
