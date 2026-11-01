# Static CPU queries

`three-avbd/queries` exports `StaticQueryScene`, `boxMesh` and their TypeScript
input/result types. It has no Three, renderer or WebGPU runtime imports. It owns
copied static triangles and a flat typed-array binary BVH per mesh (longest-axis
median splits, at most eight triangles per leaf). Queries traverse a scene mesh
list, then prune each mesh's BVH. Nothing attaches to a `World` or reads GPU data.

```ts
import { StaticQueryScene, boxMesh } from 'three-avbd/queries';
const scene = new StaticQueryScene();
const wall = scene.addMesh({ ...boxMesh([.02, 4, 4]), position: [5, 1, 0], group: 1 });
const result = scene.sweepSphere({
  center: [0, 1, 0], radius: .025, translation: [2, 0, 0],
});
const ray = scene.raycast([0, 1, 0], [1, 0, 0], { maxDistance: 10 });
const overlaps = scene.overlapSphere([4.99, 1, 0], .1, { maxResults: 16 });
scene.remove(wall);
scene.destroy();
```

`addMesh({ positions, indices?, position?, rotation?, group?, collidesWith? })`
accepts flat xyz `ArrayLike<number>` vertices and optional triangle indices.
Without indices, each three consecutive vertices is a triangle. Position defaults
to zero; rotation is xyzw, normalized on entry, and defaults to identity. Geometry
and placement are copied and baked into world space. Inputs must have complete
vertices/triangles, finite coordinates, in-range integer indices and a finite
nonzero quaternion; arithmetic overflow during cooking is rejected. Exactly
zero-area triangles are discarded, counted in `handle.discardedTriangles`.
`triangle` in results is the original zero-based triangle index, including gaps
from discarded triangles. Empty meshes are allowed. `boxMesh(size)` returns
positions and indices for a centered 12-triangle box with positive full side lengths.

Mesh handles are frozen and have a nonzero scene-local u32 `id`, never reused.
`revision` starts at zero and increases after each successful add/remove. Failed
adds and repeated removals do not change it. `remove` returns whether it removed
a mesh; foreign/forged handles throw. Removed handles may still occur in `ignore`.
`destroy` releases owned scene data and is idempotent; subsequent queries, edits
and revision reads throw. There is no geometry mutation, refit or dynamic attachment.

All surfaces are double-sided; `side` is unsupported. These are triangle **surface**
queries, not closed-volume containment: a small sphere wholly inside a box may
have no overlapping triangles, and an inside-origin ray finds the exit surface.
A ray beginning on a triangle returns distance zero; coplanar rays can hit edges.

## Results and units

Use consistent world units (metres in the example). Ray direction is normalized;
zero/nonfinite directions throw. `maxDistance` defaults to infinity and must be
nonnegative. `raycast` returns the nearest `{ meshId, triangle, distance, point,
normal }` or null. The normal is the face normal oriented against the ray (winding
normal for coplanar rays).

`overlapSphere` returns `{ hits, complete }`; each hit is `{ meshId, triangle,
point, normal, distance }`, with point the closest triangle feature and distance
the unsigned center-to-surface distance. It reports per triangle, so a box face
can produce multiple hits. `maxResults` defaults to 64 and accepts nonnegative
safe integers, including zero. Output is sorted by mesh ID then source triangle;
only the first `maxResults` hits are retained in bounded result storage.
`complete` is false exactly when additional matching triangles exist. The query
still traverses candidates to determine completeness.

`sweepSphere({ center, radius, translation }, options)` returns `{ status: 'miss' }`
or `{ status: 'hit', hit: { meshId, triangle, fraction, point, normal,
startedOverlapping } }`. Radius must be finite and nonnegative (zero is supported).
Fraction lies in `[0, 1]`; the sphere center at contact is
`center + fraction * translation`. Point is on the triangle, not the sphere center.
The sweep tests the face slab, three finite edge cylinders and three vertex spheres
with closed-form linear/quadratic equations. A radius-expanded segment/AABB test
only prunes candidates; it does not determine the final contact. No substeps or
iterative advancement are used. Thin walls remain hittable at large displacements.
Zero translation behaves as overlap, returning the lowest-ID/triangle contact.
Initial touching/overlap returns fraction zero and `startedOverlapping: true`,
even when moving away. Normals point from the closest feature toward the center;
when separation is numerically zero, the triangle winding normal is used.
Nearest ray/sweep ties use lower mesh ID, then lower source triangle index.

## Filters, tolerance and diagnostics

All three query methods accept `{ collidesWith?, ignore?, stats? }`. Masks are
unsigned u32 integers. Mesh `group` defaults to 1; query `collidesWith` defaults
to `0xffffffff`. A mesh participates exactly when `(mesh.group & query.collidesWith)
!== 0` and its handle is not in `ignore`. Query filtering is one-way, matching ray
mask semantics: there is no query group. Mesh `collidesWith` defaults to all bits
and is validated/copied metadata reserved for future pair queries; it does **not**
reject these queries. In particular, mesh `collidesWith: 0` still permits rays and
spheres selected by its group. Filters run before BVH/triangle work.

Calculations use JavaScript doubles. For triangle edge lengths `e1`, `e2`, radius
`r`, and largest absolute triangle coordinate `c`, the contact length tolerance is
`1e-10 * max(1, r, e1, e2) + 64 * Number.EPSILON * c`. Initial overlap and feature
acceptance include this tolerance; broadphase bounds include a conservative mesh
maximum. Quadratic discriminants within 64 machine epsilons of their contributing
terms are clamped to zero for tangency. Analytic times use the actual radius,
without padding it; results are subject to floating-point roundoff. Prefer coordinates
near the origin and geometry sizes well above the tolerance. This is not an exact
arithmetic geometry kernel.

Pass `stats: { nodesVisited: 0, trianglesTested: 0 }` to accumulate traversal work
across calls; counters are not reset. No stats object is allocated when omitted.

These queries are **not solver collision**, CCD against GPU bodies, rigid-body
CCD, rotational sweeps, deforming mesh queries, a contact manifold or an impulse
response. No moving GPU body is included. The CPU projectile example stops at a
static hit and creates no physics body:

```sh
node --experimental-transform-types examples/static-projectile.ts
```

## Capsule queries

`overlapCapsule({ start, end, radius }, options)` queries the entire capsule,
including its cylindrical interior. Endpoints are the two cap centers in world
space; the full upright height is `length(end - start) + 2 * radius`. The segment
can have any orientation. `distance` is the unsigned closest segment-to-triangle
distance; `point` is on the triangle and `normal` points toward the segment
(winding normal at zero separation). Result caps, sorting, completeness, filters,
handles and surface-only semantics match `overlapSphere`. Equal endpoints delegate
to `overlapSphere` exactly.

`sweepCapsule({ start, end, radius, translation }, options)` translates both
endpoints without rotation. It returns the existing hit/miss shapes, or
`{ status: 'indeterminate', fraction }`. **Indeterminate is not a miss**: the
nearest result could not be established within the numerical/work budget.
`fraction` is the start of an unresolved interval, not a contact time or a safe
movement recommendation. An earlier unresolved candidate takes precedence over
a known later hit. Equal endpoints delegate to `sweepSphere` exactly, retaining
its closed-form behavior and unchanged result contract.

General capsule sweeps use segment/triangle feature distance and conservative
advancement: translating by fraction `dt` can reduce distance by at most
`length(translation) * dt`. Each advance takes 90% of the separation bound;
there is no endpoint sampling or chain of spheres. Contact accepts twice the
length tolerance described above. This can report contact slightly before the
mathematical surface; the reported gap is within that tolerance. Overlap accepts
one tolerance, matching sphere overlap. Start touching uses the sweep tolerance.
`maxIterations` defaults to 256 distance evaluations **per candidate triangle**
and accepts integers 1–4096. Exhaustion, numerical stagnation or nonfinite
calculation returns indeterminate. Difficult grazing motion can exhaust even the
larger budget. Ordinary wall, step-nose, ceiling and corner fixtures converge at
the default budget. Total work also depends on candidate triangles; result caps
bound overlap storage, not traversal work.

Broadphase uses a sphere enclosing the whole segment, enlarged by radius and
tolerance, so long capsules may visit more triangles. The narrowphase enumerates
endpoint/face, segment/edge and segment/face intersection features. Randomized
BVH/brute-force tests check traversal only; separate analytic fixtures check math.
Extreme coordinates can exceed floating-point intermediate range: overlaps throw
when a nonfinite distance is detected; sweeps return indeterminate. Keep geometry
near the origin and above numerical tolerance.

```ts
const capsule = { start: [0, .3, 0], end: [0, 1.5, 0], radius: .3 }; // height 1.8
const clearance = scene.overlapCapsule(capsule);
const motion = scene.sweepCapsule({ ...capsule, translation: [4, 0, 0] });
if (motion.status === 'indeterminate') {
  // Resolve conservatively in application policy; do not move as though clear.
}
```

Meshes remain immutable snapshots placed at `addMesh` time. Prescribed platform
pose updates are deferred to a separate slice defining BVH refit, scene revision
and tick/temporal semantics. This API makes no moving-target CCD claim and adds no
character controller, GPU capsule body, rotational sweep or solver integration.
