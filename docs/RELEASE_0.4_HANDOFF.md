# 0.4.0 exact-artifact handoff — preparation only

Checked 2026-11-03 against main `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`.
Publication is an owner action. Nothing in this checklist publishes, tags or deploys itself.

## Frozen identity

| Field | Expected value |
|---|---|
| Source | `cef828f17c42b50d44ef97cc577adfebf93fd3a4` (#64) |
| Package | `three-avbd@0.4.0` |
| Artifact basename | `three-avbd-0.4.0.tgz` |
| Artifact SHA-256 | `0b2fcc958431513fb46eabfc4c5e29ab8fd7c41b9a3ca84296132f1c45aa23c1` |
| Archive entries | 268 |
| Export entries | `.`, `./sdf`, `./queries`, `./advanced`, `./pool` |
| Three peer | `>=0.186.0`; qualified consumer uses Three 0.187.0 |

The original artifact is retained outside this repository. Supply its location as `ARTIFACT`
when following the checklist; do not build it from an unrelated or dirty checkout. Do not
commit the archive, credentials, local paths or package-manager caches.

## Evidence already checked

- Recomputed the retained archive's SHA-256: matches the frozen value above.
- Read its package manifest directly: version, five exports and peer match the table.
- Listed the archive: only `package/build/`, `package/package.json`, README, LICENSE and
  THIRD_PARTY_NOTICES; no `.env`, `.git`, `node_modules`, key or media paths were found.
  This is a path inventory, not a new content-level secret audit.
- Compared `cef828f` with `afc1442` over `src/avbd2d`, `src/avbd3d`, `src/lib`, `src/queries`,
  package/lock files, library TypeScript configuration and packaged README/license/notices:
  no differences. #65 adds harness/tests/documentation, not a packaged solver change.
- Read the saved candidate gate: 247 CPU and 260 GPU tests passed, zero failed/skipped;
  both builds completed. This is historical gate evidence, not a new full run.
- Read the saved exact-hash consumer smoke: TypeScript 5.9.3 accepted all five entries with
  Three 0.187.0; the ray, sphere-sweep and capsule-sweep runtime checks passed.
- Read the registry on 2026-11-03: `latest` is 0.3.0. Recheck immediately before publication.

The main-era release notes include newer comparison findings that do not change this artifact.
Keep [RELEASE_0.4.md](RELEASE_0.4.md), its migration instructions and the known limitations
with the handoff. In particular: no sleeping or general CCD; asynchronous observations;
bounded/lossy events and fixed-storage overflow; experimental SDF without full reset/pool
guarantees; and unresolved large-pile contact/motion outliers. Do not call it feature parity
with Rapier or claim target-hardware performance.

## Owner pre-publication checklist

1. Locate the retained archive and verify the exact checksum, manifest and current registry
   state. These commands are read-only (set `ARTIFACT` to the retained archive first):

   ```sh
   shasum -a 256 "$ARTIFACT"
   tar -xOf "$ARTIFACT" package/package.json
   npm view three-avbd version dist-tags --json
   ```

2. If 0.4.0 has already appeared, stop and compare its registry identity; do not overwrite,
   unpublish or substitute a new tarball. If the checksum differs, stop and requalify a
   newly named candidate rather than editing the checksum expectation.
3. Confirm the saved gate and exact-artifact consumer evidence are available to the owner.
   Nightly may refresh the full gate in an isolated checkout; this daytime preparation
   does not rerun a full suite or claim a fresh GPU/browser pass.
4. Confirm that the documented breaking changes (`read(): { step }`, partial body writes,
   lifecycle/storage semantics and experimental SDF) are acceptable for this release.
5. The owner performs any npm publication separately. Use the frozen archive, not a working
   source directory. No release, dist-tag or authentication mutation is authorized here.

## After publication — separately authorized work

- Verify the registry's version, tarball identity/integrity and exports against the retained
  artifact. SHA-256 identifies the local archive; npm's `dist.integrity` uses a different
  representation, so do not compare those strings as if they were the same digest.
- Install the registry package in a fresh consumer, check all five entries, run the CPU query
  smoke and a small GPU World/render lifecycle smoke, recording commands and exit codes.
- Only after owner authorization: set the publication date, tag the exact source, and create
  release metadata. Do not tag current main automatically or change an existing tag.
- The downstream project's dependency/alpha work belongs to its own hub; successful package
  qualification here does not authorize changes in that repository.

## Skipped owner actions

- Publishing 0.4.0: skipped; owner action, no npm mutation performed.
- Dirty-checkout disposition: skipped; preserved experiments remain untouched.

## Preparation verification

Archive digest/inventory, manifest parsing, registry read and packaged-source diff completed
successfully. `git diff --cached --check` validates this documentation change. Full `pnpm check`,
fresh GPU/browser qualification and measurement batches are deferred to nightly. No new
benchmark or physical-quality result is claimed.
