# CPU SDF baking and preparation API

The experimental `three-avbd/sdf` subpath is available in this source build (not
published yet). It has no renderer/device dependency. It prepares and samples
fields on CPU. The experimental `World.enableSdfCollisions()` API (new in 0.4.0) accepts them;
see `SDF_WORLD.md` for its fixed-topology limits and rendering/frame contract.
There is no `World.addSdf` or automatic SDF mesh generation.

```ts
import { bakeVoxelSdf, finalizeSdf } from 'three-avbd/sdf';

// geometry: indexed or non-indexed Three.js BufferGeometry, or
// { positions: ArrayLike<number>, indices?: ArrayLike<number> }.
const baked = bakeVoxelSdf(geometry, { resolution: 32 });
console.log(baked.warnings);
const properties = finalizeSdf(baked.field);
const { phi, gradient } = baked.field.sample([0, 0, 0]);
```

Positions are geometry-local, not mesh/world transforms. No input buffer is
modified. Units and axes are preserved by default. With `normalize: true`,
`bakedPoint = (originalPoint - transform.center) * transform.scale`; the longest
bounding-box dimension becomes one. Apply the same transform to rendered
geometry when placing it alongside the field. Sampling coordinates remain in
geometry space even after finalization computes the center of mass.

`resolution` counts cells on the longest axis (default 32, accepted 4–256).
The grid has three padding cells on each side. It stores four float32 values
per node (distance and gradient), with x varying fastest. The default 64 MiB
`maxGridBytes` ceiling is checked before grid allocation. It excludes input
copies, the BVH, winding votes (one byte/node), retained surface triangles
(36 bytes/triangle), and temporary allocations.
Increasing resolution cannot recover features absent from the source mesh.

Meshes should be closed, consistently oriented, and free of self intersections.
Exact duplicate vertices are welded for the edge diagnostic only. Open edges,
non-manifold edges, or inconsistent winding produce a warning, not an automatic
mesh repair. Consistently inward-facing meshes are reversed on the copied
triangles. Multiple shells must use consistent solid/cavity winding. Edge counts
do not prove absence of self intersections; thin features may disappear at coarse
resolution. Degenerate triangles and malformed/non-finite input are rejected.

### Differences from upstream sdf-dcd-demo defaults

The defaults are deliberately lighter than the released C++ baker, which always
normalizes the mesh to a unit box and bakes at resolution 100. That is a 100³-node,
roughly 16 MB float32 grid and a long synchronous bake, too heavy as a browser
default. To match upstream's grids, pass both options explicitly:

```ts
bakeVoxelSdf(geometry, { resolution: 100, normalize: true });
```

Other intentional differences, from the 2026-10-18 audit:
- **Degenerate triangles.** Zero-area and malformed triangles throw here. Upstream welds
  positions within 1e-5 of the extent and silently drops index-degenerate triangles.
  Clean such meshes before baking.
- **Welding.** Only exactly equal positions are welded, and only for the edge
  diagnostic. Upstream's tolerance weld also affects which triangles survive.
- **Empty interiors.** `finalizeSdf` throws when no interior sample is found. Upstream
  clamps the volume to 1e-6 and uses the bounds centre as the centre of mass.
- **Fields without source triangles.** A `VoxelField` built from a raw grid falls back to
  projected random points for curvature seeds. Upstream always samples its mesh by area.
- **Numerics.** The determinant and zero-distance gradient cutoffs are relative to the
  cell size (upstream uses absolute 1e-12 and 1e-6). Distances agree; gradients can
  differ at medial-axis ties, as noted below.

The released scenes are unaffected: they load upstream's captured resolution-100 grids
and seeds rather than rebaking.

The baker uses a median triangle BVH for nearest-surface distances and the
oracle's three-axis jittered winding-vote approach for signs. Triangle ordering
and arithmetic differ from the C++ baker, so baked grids are not claimed to be
bit-identical to the upstream mesh baker. `VoxelField` interpolation itself is
covered by the existing upstream fixtures.

`finalizeSdf` integrates unit-density volume, COM, and the **full row-major 3×3**
inertia tensor using 48 cells on the longest axis by default. Multiply volume
and tensor by density to obtain mass and inertia. These properties refer to the
baked units, including any normalization. Nonuniform runtime scaling requires a
new bake; the reference body's scale is uniform. Finalization updates field COM
and curvature seeds only when it succeeds, and rejects a field with no sampled
interior. The mass and inertia approximation improves with resolution; it is not
an exact mesh-volume integration.

Seeds use deterministic area-weighted triangle samples for baked voxel fields,
and projected samples for analytic fields. Curvature thresholds and spacing scale
with the field bounds. All four voxel assets (bunny, gear, cow, chair) match the
pinned C++ seed counts and ordered positions when given the same oracle grid and
normalized mesh. This establishes seed-stage parity, not whole-baker bit parity.
The mesh sampler preserves source triangle/corner order independently of BVH
sorting and the canonical ordering used for distance queries.

`curvatureSeeds(field, { candidateCount, signal })` returns seeds without mutating
the field or computing mass. `finalizeSdf` uses it and assigns the results only on
success. `candidateCount` defaults to 8000 and can be zero for mass-only preparation.
Both synchronous functions belong in offline tools/workers for substantial fields.

`VoxelField.surfaceTriangles` retains nine float32 values per triangle in field
coordinates. Baking and worker transfer preserve this data automatically. When
restoring a saved field, pass it as the optional sixth `VoxelField` constructor
argument along with the original grid metadata. A grid-only field still uses
projected candidates; it cannot reproduce area-weighted mesh seeds without the
source surface. Treat grid and surface buffers as owned field data, not mutable
scratch space.

### Collision units

`scaleCollisionParams(lengthScale, params = collisionParams())` converts the
unit-scene collision settings to a common uniformly scaled scene/pair: tolerance,
margin, allowed penetration, replacement threshold and step size scale linearly;
**epsilon scales with length squared**, because it occurs under the softmax square
root. Alpha, flags and iteration/sample counts remain unchanged. The Nelder–Mead
path derives its actual simplex step from overlap bounds and tolerance, as in the
oracle; the retained `stepSize` parameter is unused on that path.

This conversion is explicit, not automatic per-body scaling: two bodies in one
contact must share the same world-unit parameters. It is not a policy for mixing
wildly different object sizes. Seed/curvature scale and collision objective/contact
geometry are tested at 1/8 and 8 times the baseline scale. Scale parameters before
passing them to the CPU collision adapter; defaults remain oracle-compatible.

## Worker usage

Create a module worker in your application:

```ts
// sdf-worker.ts
import { installSdfWorker, type SdfWorkerScope } from 'three-avbd/sdf';
// The cast is needed when the project type-checks with DOM (not WebWorker) typings.
installSdfWorker(self as unknown as SdfWorkerScope);
```

```ts
import { bakeVoxelSdfInWorker } from 'three-avbd/sdf';

const worker = new Worker(new URL('./sdf-worker.ts', import.meta.url), {
  type: 'module',
});
const cancellation = new AbortController();
try {
  const baked = await bakeVoxelSdfInWorker(worker, {
    positions, // packed xyz array; extract from geometry before sending
    indices,   // optional triangle indices
  }, {
    resolution: 32,
    signal: cancellation.signal,
    onProgress: fraction => console.log(fraction),
  });
  console.log(baked.field.sample([0, 0, 0]));
} finally {
  worker.terminate(); // caller owns lifetime
}
```

The helper copies input arrays before transfer so renderer-owned buffers stay attached.
The output grid and retained surface triangles are transferred back together.
Only one job may run on a worker at once. Cancellation is checked between slices;
input validation, BVH construction, and an individual slice are synchronous.
Cancellation is cooperative rather than a hard latency guarantee. The worker is
reusable after a cancelled job settles. A dedicated worker should be terminated
only after the returned promise settles; external termination has no browser
notification and can leave that promise pending. Applications needing hard
cancellation should own their worker/promise lifecycle.

`bakeVoxelSdfAsync` is also available for custom workers or small interactive jobs.
It yields between slices, but it still computes on its calling thread; it does
not create a worker or change OS scheduling priority. Progress spans sign/distance
passes, not equal units of elapsed time. The synchronous bake has the same
options and progress notifications.

## Verification boundary

CPU tests cover every node of a translated cube against the analytic box SDF,
nonconvex torus holes, exact reversed-winding invariance, normalization, input
ownership, malformed input/budgets, sync/async parity, and real Node worker
transfer/cancellation/reuse. Analytic and four voxel finalizations check unchanged C++ fixtures.
The browser worker API uses the same protocol; no browser/GPU runtime was started
for this pass. See `SDF_CPU_REFERENCE.md` for collision-port coverage.

## Direct baker and robustness checks

Resolution-16 grids for all four oracle meshes are independently generated from
pinned C++. Across 26,082 nodes, signs agree away from the 2e-6 surface tolerance;
maximum observed distance error is 1.41e-6 in normalized units. The symmetric gear
has nonunique nearest-surface gradients: tests independently project both
implementations' directions onto the source triangles rather than require one
arbitrary tie winner. No mesh/grid/seed golden was adjusted to fit TypeScript.

Additional CPU regressions cover a closed cavity with reversed inner winding,
disconnected solids, non-manifold duplicate faces, malformed/nonfinite fields,
float32 overflow/underflow, worker callback failure/reuse, and a 30-second
three-body mixed-size settling run. These are bounded checks, not claims about
all meshes or long-horizon stability for arbitrary scenes. Sub-cell features and
self-intersecting input retain the limitations described above.
