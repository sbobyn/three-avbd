# Released SDF scene comparison

`/sdf-released.html` reproduces all eleven released sdf-dcd-demo scenes. Since 2026-10-18 that
includes the analytic Falling Boxes, Bend, Twist, Displace, Spiky Wheel, Cows on Spikes and
Primitives scenes; see FINDINGS 2026-10-18 for their comparison table. The sections below are a
dated history, starting with the four scenes compared on 2026-10-14.

The viewer starts paused. Run advances at most 30 reference frames per wall-clock second and
stops after 360 frames (six simulated seconds). Orbit/zoom and scene selection remain available.
The interactive spawning/dragging showcase remains at `/sdf.html`.

## Inputs and interpretation

Source: `sdf-dcd-demo` commit `1dcdf1e7fa07d16fda15826ad8c2e6697075a76e`.
The immutable oracle captures supply poses, COM, mass, full inertia, collision
parameters, curvature seeds, normalized source triangles and resolution-100 grids.
Decompressed grid/surface hashes are verified. Mass and inertia retain the captured
scale³/scale⁵ factors. Full tensors are diagonalized; physics runs in principal axes,
with the original field and render surface transformed into that frame. No rebaking
or grid resampling is used. Ground has no curvature seeds, matching the release.

The released reference solver is CPU sequential impulses, with 20 velocity and
20 split-correction iterations per substep. Here the production GPU AVBD solver
uses 20 iterations. Both use four substeps per 1/60-second frame and the source
gravity. Search RNG, solver stabilization, contact anchors and ordering differ.
The paper's GPU results used AVBD; these comparisons are against its released CPU
code, not a numerical reproduction of the paper's GPU experiments.

## Six-second results

| Scene (bodies including ground) | Final contacts GPU / reference | Final kinetic energy GPU / reference (J) | Final sampled penetration GPU / reference (m) |
|---|---:|---:|---:|
| Boxes (29) | 196 / 196 | 4.09e-7 / 1.96e-7 | 0 / 0 |
| Gears (11) | 50 / 47 | 8.30e-8 / 6.65e-8 | 0 / 0 |
| Chairs (28) | 169 / 130 | 0.03349 / 5.35e-19 | 0.00327 / 0 |
| Bunnies (28) | 177 / 89 | 0.014130 / 0.014126 | 0 / 0 |

Peak sampled penetration across the run was 0, 0.01452, 0.05498 and 0.04379 m
respectively; the captured reference peaks were 0, 0, 0.00911 and 0 m.
These are vertex-sampled lower bounds, sampled every 30 frames, not exact volume
penetration or evidence of zero intersection between samples. Our expanded triangle
corners duplicate probes compared with the reference's indexed vertices; vertex-query
counts are therefore not directly comparable. All final contact-record depths were
zero even where the independent surface probe found chair penetration: contact depth
alone is not a sufficient quality metric.

No nonfinite state or capacity overflow was reported. Boxes/gears settle; chair
residual motion and transient mesh penetration remain quality gaps. Bunny final energy
agreement does not establish trajectory or contact-manifold parity. Next: isolate
penetration and settling under controlled impact/friction tests, compare stabilization
and contact coverage, then reconstruct the paper's quantitative experiments. Do not
claim paper parity or performance from this bounded diagnostic run.

## Reproduce

```sh
node --experimental-transform-types scripts/sdf-released-compare.ts 360 docs/measurements/sdf-released-2026-10-14.json
```

The [raw measurements](measurements/sdf-released-2026-10-14.json) contain sampled GPU
and reference traces, configuration and final metrics. Scenes run sequentially with
GPU readback/draining every substep and a 5 ms yield per frame. This deliberately
limits queued work and is not a throughput benchmark. CPU priority was nice 15;
this cannot guarantee zero contention with other GPU users.

## Mesh contact / settling correction

The bridge previously retained material anchors for sticking friction while using
normal separation from a newly relocated optimizer point. That combines different
constraints: the force/torque is applied at the old anchors while error correction
uses another point. Both GPU and opt-in CPU bridges now evaluate normal separation
from the retained anchors when sticking; non-sticking contacts still use the detector's
separation. Independent normals, point identities and transported warm forces remain.

The viewer defaults to **Mesh quality**, which activates voxel contacts at 4 cm
instead of 2 cm. The allowed-penetration offset increases by the same amount, so
`margin - allowedPenetration` (the intended resting gap) is unchanged. There are
still four substeps, twenty iterations and at most five candidates per pair.
**Released settings** restores the captured collision parameters; both modes use
the corrected bridge. Box settings remain unchanged. No damping or sleeping was
added to hide residual motion. Library collision defaults remain unchanged.

The fresh [quality traces](measurements/sdf-mesh-quality-2026-10-14.json) show:

| Scene | Final energy before → after (J) | Final sampled penetration before → after (m) | Peak sampled penetration before → after (m) |
|---|---:|---:|---:|
| Boxes | 4.09e-7 → 5.66e-7 | 0 → 0 | 0 → 0 |
| Gears | 8.30e-8 → 2.05e-6 | 0 → 0 | 0.01452 → 0 |
| Chairs | 0.03349 → 0.000470 | 0.00327 → 0 | 0.05498 → 0.03329 |
| Bunnies | 0.014130 → 0.000249 | 0 → 0.01044 | 0.04379 → 0.02202 |

Chair final energy fell about 98.6%, but results vary with GPU contact ordering.
A separate chair-only run reached 0.000050 J, 0.15 mm final sampled penetration and
7.3 mm peak; this is not substituted for the less favorable full-run result above.
The larger peak in the full run and final bunny overlap remain unresolved. These
are improvements, not zero-intersection guarantees or CPU trajectory parity.

Exploratory changes to contact count, seed selection, projected signs, smoothing,
stabilization and substeps were rejected because improvements were not consistent
across motion and penetration. Their [summary measurements](measurements/sdf-contact-experiments-2026-10-14.json)
are retained. The final change does not expand GPU buffer layouts or contact budgets.
Earlier activation can increase overlapping pairs and contact work; no throughput
benchmark was performed.

To reproduce the new profile or the corrected-bridge comparison:

```sh
node --experimental-transform-types scripts/sdf-released-compare.ts 360 output.json mesh-quality
node --experimental-transform-types scripts/sdf-released-compare.ts 360 output.json reference
```

## Static-surface sign correction

The next diagnostic records the worst penetrating vertex, its directed body pair,
and the detector's last-substep active contacts. This exposed bunny vertices below
the floor whose nearby contacts reported positive separation: mixed inside/outside
optimizer samples used an unsigned projected distance. `signedSeparation` is an
opt-in CPU/GPU correction against static analytic boxes. It uses that box's normal
and the signed projected surface gap. Mesh quality enables it; released settings
and library defaults keep the oracle behavior. Independent normals and warm starts
are unchanged. This is not a general mesh/mesh sign correction.

A bounded six-second sequential run with the correction measured:

| Scene | Peak sampled penetration | Final sampled penetration | Final kinetic energy |
|---|---:|---:|---:|
| Chairs | 21.75 mm | 0 | 0.00004254 J |
| Bunnies | 8.79 mm | 4.54 mm | 0.0003006 J |

[Raw trace with penetration witnesses](measurements/sdf-static-projection-2026-10-14.json).
The remaining final bunny witness is a bunny/bunny pair, not the floor. Peak
penetration and remaining overlap still need work; these sampled measurements do
not prove intersection-free motion. A broader mixed-sign correction was rejected:
it reduced chair peak depth but raised final energy to 0.01190 J, above the existing
chair regression limit. No test envelope was relaxed.

Run only the two mesh piles to bound investigative GPU work:

```sh
node --experimental-transform-types scripts/sdf-released-compare.ts 360 /tmp/sdf-piles.json mesh-quality 6,9
```

### Deeper-contact anchor refresh

Static projection alone was insufficient across runs: the bounded gate measured
chair final depth 5.13 mm (limit 5 mm) and bunny final depth 12.77 mm (limit 10 mm).
Both failures were retained; neither test limit was relaxed. Extending signed
projection to opposed moving mesh surfaces was also rejected because bunny energy
rose to 0.03026 J and final overlap to 19.24 mm.

The retained change adds opt-in `refreshDeeperContacts` to the CPU/GPU bridge.
A sticking contact refreshes its anchors only if the new anchors moved more than
three optimizer tolerances and the new separation is deeper by more than one
tolerance. Normal evaluation stays consistent with the chosen anchors. Contact IDs,
independent normals, transported warm forces and penalties are preserved. Mesh
quality enables both options; reference/library defaults do not. No sample budget,
substeps, damping, sleeping or resting gap changed.

The next six-second run measured chair peak 14.11 mm, final depth 0 and energy
0.00005674 J; bunny peak 17.58 mm, final depth 0 and energy 0.0001905 J. See the
[raw trace](measurements/sdf-anchor-refresh-2026-10-14.json). This is sampled evidence,
not a guarantee of no overlap between samples. The static-only run's lower bunny
peak did not survive the regression gate; it is not the accepted configuration.

Final bounded gate passed 138 CPU and 122 GPU tests plus both builds. Browser
bunny playback completed and auto-paused, but its energy was 0.0102 J versus the
headless comparison's 0.0001905 J. The viewer's contact depth was zero; it does not
probe vertices. This remaining runtime variation is not resolved by the passing
headless gate and needs follow-up alongside transient penetration.

## Stable SDF contact accumulation

The 3D topology secondary sort key was always zero because standard collision
pairs have one manifold. SDF pairs instead have multiple one-point manifolds.
Their tied keys left accumulation ordered by atomic scheduling, changing floating
point sums and long-run poses. Topology now uses the persistent contact feature
ID (without its sticking bit) after the other body ID. Independent normals and
warm starts remain intact. This is a general ordering fix, not a quality-profile
parameter change. Topology uses eight storage bindings, within the baseline limit.

Two independent 180-frame bunny runs match physical state bit-for-bit on the same
device. Six-second comparisons with probes every 30 versus every 5 frames have
identical final metrics; probe timing no longer changes the observed trajectory.
These checks do not promise determinism across GPU models or shader compilers.

[Five-frame probe trace](measurements/sdf-stable-order-2026-10-14.json):

| Scene | Peak sampled depth | Final sampled depth | Final energy |
|---|---:|---:|---:|
| Chairs | 8.10 mm (frame 95) | 1.12 mm | 0.0002561 J |
| Bunnies | 6.78 mm (frame 215) | 0 | 0.0021134 J |

Thirty-frame probes missed these peaks (3.46 mm and zero respectively). Transient
intersection is improved, not eliminated. Existing chair limits are unchanged.
The viewer now independently probes surface vertices on the final frame and
shows that depth separately from detector contact depth.

```sh
node --experimental-transform-types scripts/sdf-released-compare.ts 360 /tmp/sdf-dense.json mesh-quality 6,9 5
```

Two six-second browser bunny replays produced identical displayed metrics, matching
headless: 189 contacts, 111 pairs, 53,856 paired queries, 24,772 optimizer iterations,
energy 0.0021 J, lowest COM 0.3 m and final sampled surface depth zero. Both runs
auto-paused. Browser comparisons use displayed precision, not bitwise readback;
the headless repeatability regression compares full float32 physical state.

## Substep impact diagnosis

The bounded tracer isolates a body/floor pair without changing the scene settings:

```sh
node --experimental-transform-types scripts/sdf-impact-trace.ts 6 6 90 96 chair-impact.json
node --experimental-transform-types scripts/sdf-impact-trace.ts 9 10 205 225 bunny-impact.json
```

The traced chair/bunny minima are 9.081/8.926 mm below the floor, at frame
94/substep 1 and frame 214/substep 2 respectively. The chair's lowest curvature
seed remains 21.285 mm above the floor at its worst substep. Contact records alone
therefore under-report visible surface overlap. These target-body substep traces
are not whole-scene maxima. See `measurements/sdf-impact-trace-2026-10-14.json`.

Additional support-seed trials regressed bunny impact or settling and were removed.
The current stable quality profile is unchanged; transient penetration remains an
open issue. The next experiment should ensure deterministic extremity coverage and
contact retention, with single-body fixtures before repeating the piles.


## Mesh vertex contacts (enabled in Mesh quality)

`meshVertexContacts: true` (formerly `meshPlaneContacts`) can be passed to
`World.enableSdfCollisions` for mesh fields that carry `surfaceTriangles`. The atlas packs
every unique source vertex, up to 4096 per field.
- **Static box top face:** the deepest vertex becomes one supplemental support contact. The
  face must cover the moving AABB completely; other cases fall back to the general search.
- **Two dynamic meshes:** the deepest vertex of either body inside the other's field (within
  the trigger distance) becomes one supplemental witness contact.

Each supplemental contact fills the fifth slot of the five-point pair budget and keeps a
persistent vertex ID. The witness also settles the pair's contact direction. An optimizer
contact whose normal opposes the witness is deactivated when its own normal is ambiguous:
- it lies inside both fields with aligned gradients; or
- it lies outside both fields, where the unsigned gap normal can flip.

Other optimizer contacts are unchanged, including clearly opposed ones such as a genuine
interlock. Those checks cost two extra field samples per opposed contact. The CPU reference
rejects this GPU-only option. Standalone `SdfNarrowphasePass` users must also request it in
construction options. Without the option, snapshots and atlases carry no vertex data.
Query statistics with the option include vertex evaluations.

Mesh quality enables it for the mesh scenes. Released settings do not. The 11-seed ensembles,
decision rule and costs are in FINDINGS (2026-10-17) and
`measurements/sdf-mesh-witness-ensemble-2026-10-17.json`. The earlier hull-only trials are in
`measurements/sdf-plane-supports-2026-10-14.json`.

The retained-anchor audit can be reproduced with:

```sh
node --experimental-transform-types scripts/sdf-contact-audit.ts 9 360 audit.json mesh-plane
```

It reports detector separation, post-step projected material-anchor gap, local
anchor displacement, stick state and contact-basis forces. The optional `mesh-plane` argument enables the experimental supports; omitting
it audits the unchanged default quality settings. The recorded trial also used
the rejected tighter refresh threshold; its bunny result was identical before
and after that threshold change.
