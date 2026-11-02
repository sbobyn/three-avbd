# three-avbd 0.4 release candidate

**Historical SDF checkpoint (2026-10-24).** Current release scope and migration are in
[RELEASE_0.4.md](RELEASE_0.4.md); later merged work supersedes the source/dependency
boundary below. The recorded checks here were not rerun for the current candidate.

Tracking: [STE-3003](https://linear.app/sbobyn/issue/STE-3003).
This prepares the next npm version; it is not a publication announcement. The published 0.3.0
package does not export `three-avbd/sdf`. The release starts from main's merged small-demo
checkpoint, PR #40. Open paper PRs #36–#38 and experimental large-pile search changes are excluded.

## Package scope

- Existing `three-avbd` and `three-avbd/advanced` entry points remain available.
- Experimental `three-avbd/sdf` exports analytic/voxel fields, synchronous/asynchronous/worker
  mesh baking, curvature seeds, mass properties, principal inertia and collision parameter scaling.
- `World.enableSdfCollisions()` integrates non-convex contacts, spatial candidates, field/body
  refresh, contact events and raycasts. Independent contact normals and identity-based warm starts
  are preserved. See [World limitations](SDF_WORLD.md) and [baking conventions](SDF_BAKING.md).
- SDF is opt-in and its API may change. Existing non-SDF World usage keeps its collision path.
- Three.js 0.186.1 is the verified version; 0.187.0 was unavailable from npm on 2026-10-24.
  The declared peer range is not a claim that every future Three.js version was tested.

The method follows the released SDF reference with documented AVBD and mesh-quality extensions.
It is not an exact reproduction of the paper's unavailable GPU implementation. Low search budgets
can miss contact regions and allow transient penetration; neither penetration-free simulation nor
4,314-body 60 FPS is promised. The small browser-demo measurements are short M4 Max observations,
not guarantees for other GPUs. See [measurement scope](SDF_DEMO_RELEASE.md).

## Release procedure

1. Freeze the release commit and run every component of `pnpm check`. For this task, run GPU files
   with `node --experimental-transform-types --test --test-concurrency=1 tests-gpu/*.gpu.test.ts`
   instead of the unconstrained default command. Pause browser simulation and run GPU jobs
   sequentially; no skipped adapter tests count as passes.
2. Build and pack from that source. Inspect the file list and hash the tarball. Install that exact
   archive in a fresh external project; verify all three imports, TypeScript types, a bounded
   CPU bake and an actual WebGPU World contact/raycast/cleanup workflow.
3. Obtain independent review of the exact release diff and resolve findings. Record the final
   SHA, gate results and tarball digest with the release ticket. Rebuild/recheck if runtime changes.
4. Steven performs the npm publication from an authenticated terminal. Publish the verified
   archive with `npm publish /path/to/three-avbd-0.4.0.tgz --access public --ignore-scripts`.
   Here `--ignore-scripts` avoids rerunning the package's unconstrained GPU prepublish hook;
   it is valid only after the complete sequential gate and archive checks above pass.
5. Verify registry version/exports/integrity, install the registry package in a fresh consumer,
   and repeat its smoke checks. Record a release tag at the published source commit and update
   candidate/publication wording after publication is confirmed. Coordinate downstream adoption
   with [STE-2834](https://linear.app/sbobyn/issue/STE-2834).

Production demo deployment is tracked separately in [STE-3002](https://linear.app/sbobyn/issue/STE-3002).
Neither a local preview nor a Vercel Preview deployment confirms the stable public URLs work.

## Candidate verification — 2026-10-24

The candidate changes package metadata and documentation only, on top of main `a6a95d7`.
Typecheck, 161 CPU tests, 178 sequential GPU tests (zero failures/skips), production site build
and library build pass. GPU tests ran after confirming the browser demo was paused.

The archive contains 204 files, approximately 312 kB compressed / 1.32 MB unpacked. All three
entry points and declarations are present; demo assets, tests and research measurements are
excluded. A fresh consumer installed the archive with Three.js 0.186.1 and passed ESM imports,
TypeScript 5.9 full declaration checking, a bounded CPU mesh bake, and a 120-step real-GPU public
World workflow: baked-body settling, contact events, raycast, removal/field refresh and cleanup.
That consumer requested no optional GPU features and reported no uncaptured GPU errors.
Independent review found no actionable issues in the release-preparation diff. These checks
validate the candidate archive; registry publication and the post-publication consumer check
remain outstanding.
