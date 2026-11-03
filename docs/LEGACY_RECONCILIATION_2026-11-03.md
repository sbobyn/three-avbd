# Legacy experiment and PR #66 reconciliation — 2026-11-03

Read-only comparison against `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`.
This is a disposition inventory, not authorization to discard experiments or merge a PR.
No legacy files were copied, staged, reset, stashed or removed.

## Definitions and provenance

- **Merged**: the implementation or exact file is already on current main. This does not
  imply that every historical experiment or measurement has been qualified.
- **Superseded**: main has a newer implementation, validation or configuration. Do not
  transplant the old file wholesale.
- **Novel**: a local implementation or evidence file is absent from main. Novel does not
  mean correct, suitable for release, or approved for disposal.

The legacy snapshot is based on `b3675dea83c78aba9644b059975f48285bf02a47`, with nine
modified tracked files and 24 untracked files (the directory-grouped status has 26 rows).
Main is 113 commits ahead of that base, with no unique committed legacy-base ancestry.
PR #66 is `69451f83127689683a904b7e1ad58dd64615f919`, one commit after
`cd3ce901557aa9cf4f7ede489fac385971d383ea`, and 20 commits behind current main.
Both comparisons used saved files and Git objects, not executed legacy experiments.

## Legacy snapshot: every dirty path

| Paths | Class | Evidence / action |
|---|---|---|
| `src/comparison/physical-quality.ts`, `src/comparison/quality.ts` | Merged, byte-identical | Direct file-to-main comparison. |
| `compare-frame.html`, `compare.html`, `src/comparison/frame.ts`, `src/comparison/main.ts` | Merged foundation; superseded files | #53 ported the harness; #61 adds the separate live side-by-side page. Current pages differ. |
| `src/comparison/adapters.ts`, `src/comparison/run.ts`, `scripts/compare-rapier.ts`, `scripts/compare-suite.ts` | Merged foundation; mixed novel options | #53 ports the runnable comparison. Main's later scene/final-window machinery supersedes the original runner; the local speculative-contact wiring is absent from main. Preserve rather than overwrite. |
| `src/comparison/contact-quality.ts`, `src/comparison/scenes.ts`, `tests/comparison.test.ts`, `tests-gpu/comparison.gpu.test.ts` | Superseded | #60 corrects scene validity; #65 adds final-window and mover diagnostics. The old sphere columns and mid-collapse piles are not valid resting-quality controls. Retain old tests as historical input, not proof against current main. |
| `docs/COMPARISON_TEST_STATUS.md`, `docs/RAPIER_COMPARISON.md` | Superseded narrative; historical evidence retained | Main incorporates the port and newer settling results. References to unported raw files do not make those files committed. |
| `README.md`, `THIRD_PARTY_NOTICES.md`, `package.json`, `pnpm-lock.yaml`, `vite.config.ts` | Superseded integration | Main already carries Rapier 0.21.0, its notices and comparison pages, plus Three r187 and release 0.4.0. Do not restore the old dependency/configuration versions. |
| `src/avbd3d/gpu/layout.ts`, `src/avbd3d/gpu/solver.ts`, `src/avbd3d/gpu/wgsl-collision.ts`, `src/avbd3d/gpu/wgsl-solve.ts` | Mixed: merged margin; novel speculative path | #55 supplies `contactMargin` with unchanged 0.01 default. The local `speculativeSphereBox`, swept sphere/box contact construction, reuse exclusion and speculative solve variant are absent from main. Keep them experimental; do not transplant old layouts over lifecycle/storage additions. |
| `scripts/diagnose-free-fall.ts` | Novel diagnostic | No file at this path on main. No new analytic accuracy claim is established here. |
| `docs/data/contact-comparison.json` | Novel historical evidence | Absent from main; retain provenance before any future import. |
| `docs/data/contact-ring-comparison.json` | Novel historical evidence | Absent from main. |
| `docs/data/expanded-validation.json` | Novel historical evidence | Absent from main. |
| `docs/data/impact-comparison.json` | Novel historical evidence | Absent from main. |
| `docs/data/rendered-validation.json` | Novel historical evidence | Absent from main. |
| `docs/data/speculative-edge-comparison.json` | Novel historical evidence | Absent from main. |
| `docs/data/speculative-impact-comparison.json` | Novel historical evidence | Absent from main. |

The speculative path is not angular CCD. Existing historical results include failures;
an import would need separate layout compatibility, disabled-path parity and physical-quality
regressions. A successful harness process is not a physical-quality pass.

## PR #66: file-level reconciliation

PR #66's merge-base diff contains 37 files. Its subject describes the same audit, body-command,
identity and static-query work integrated by #47, #48, #49 and #50. Comparing the head directly
to main distinguishes already-present files from changes added after that snapshot.

**Merged, byte-identical at the two heads:**

```text
AGENTS.md
docs/PLAN.md
examples/static-projectile.ts
src/avbd3d/gpu/bind-group-cache.ts
src/avbd3d/gpu/no-collide.ts
src/avbd3d/gpu/sdf-bridge.ts
src/avbd3d/gpu/sdf-broadphase.ts
src/lib/body-commands.ts
src/queries/bvh.ts
src/queries/geometry.ts
tests-gpu/world-contracts.gpu.test.ts
tests/bind-group-cache.test.ts
tests/body-commands.test.ts
tests/identity.test.ts
tests/no-collide.test.ts
tests/static-queries.test.ts
```

**Superseded integration or subsequently extended files:**

```text
README.md
docs/API.md
docs/QUERIES.md
docs/SDF_WORLD.md
package.json
pnpm-lock.yaml
src/avbd3d/gpu/body-mover.ts
src/avbd3d/gpu/layout.ts
src/avbd3d/gpu/solver.ts
src/avbd3d/gpu/wgsl-collision.ts
src/avbd3d/gpu/wgsl-solve.ts
src/lib/contacts.ts
src/lib/identity.ts
src/lib/index.ts
src/lib/queries.ts
src/lib/world.ts
src/queries/scene.ts
tests-gpu/body-commands.gpu.test.ts
tests-gpu/step-allocations.gpu.test.ts
tests-gpu/world-observations.gpu.test.ts
tsconfig.lib.json
```

Concrete distinctions, rather than inferred equivalence from PR titles:

- Main adds the slide-cancellation regression at the end of `body-commands.gpu.test.ts`.
  The older snapshot lacks that test and the corresponding newer command handling.
- Main's observation test additionally rejects retirement snapshots when reporting is off.
- Main's `ContactWatch` uses two cached/prewarmed ping-pong groups; #66 uses one replaceable
  group. Main also adds the lifecycle guard to `BodyMover` and checks command slot bounds.
- Main adds `BodyIds.remaining`, activation/reset, fixed storage, pools, capability preflight,
  capsule queries and the margin parameter. Reverting shared layouts or World code to #66
  would lose later functionality.
- The differing step-allocation hashes belong to different parameter uploads; they are not
  evidence of a new allocator fix in #66 and must not be copied to current tests.

**Recommendation:** no novel production fix is established by this comparison. Treat #66
as a saved pre-integration snapshot, not a patch to merge wholesale. Leave its branch and PR
untouched. Any later claim of an additional fix needs a minimal current-main reproducer and
a narrowly scoped new branch. This inventory is not an adversarial review or a runtime gate.

## Verification and owner decisions

Evidence commands: `git diff --name-only cd3ce90 69451f8`, per-file `git show` comparisons,
`git diff 69451f8 afc1442` for changed modules/tests, and read-only comparison of every legacy
dirty file against `afc1442`. No legacy code was executed. Documentation-only whitespace
validation: `git diff --check`.

- Dirty-checkout disposition: skipped; the owner decides whether to archive or reconcile it.
- Publication: skipped; exact-artifact release preparation is separate from publishing.
- Full gates and measurement batches: deferred to nightly; only targeted checks are allowed
  in this work session. No M1 or older discrete-GPU result is inferred from this machine.
