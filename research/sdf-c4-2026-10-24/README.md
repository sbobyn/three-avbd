# STE-3006 (SDF C4) recovered research text, 2026-10-24/25

**Not evidence.** The original work lived in an uncommitted worktree under `/private/tmp` and was lost.
These files were rebuilt on 2026-10-31 from agent session transcripts (nothing from the transcripts was
executed). No measurement JSON, capture root or gate log survived, so every number quoted here is
report text that cannot be checked. Original base: `cd3ce901557aa9cf4f7ede489fac385971d383ea`.

Kept outside `src/`, `tests/` and `tests-gpu/` on purpose: nothing here is typechecked, run or
part of the gate. Before any script or test is used to regenerate results it needs review, a
move into the normal tree, and a CPU/GPU gate. Regenerated results must carry new dates and must
not be labelled as the Oct 24-25 results. The replay recorder (`scripts/sdf-replay*.ts`) the
nine-capture comparisons depend on was not recovered.

Each file starts with a header naming its status. The hash is of the recovered text without the header.

| Status | Meaning |
|---|---|
| VERBATIM-FINAL | Exact bytes of a full read taken after the file's last detected write |
| REPLAY-VERIFIED-FULL | Replayed edits equal verbatim reads covering every line, all after the last write |
| REPLAY-WINDOW-VERIFIED | Replay matches 23 of 24 verbatim windows; the last lines are a later literal append |

| File | Status | SHA-256 (recovered text) |
|---|---|---|
| `docs/SDF_C4_MAIN_RECOVERY.md` | VERBATIM-FINAL | `5ed9193a8c0576fc…` |
| `docs/SDF_FIELD_CERTIFICATE.md` | VERBATIM-FINAL | `d76fede57019883c…` |
| `docs/SDF_CELL_REUSE_SAFETY.md` | VERBATIM-FINAL | `0fda920ebd2d2fdd…` |
| `docs/SDF_CELL_PROJECTION.md` | REPLAY-VERIFIED-FULL | `034a0679244f75f6…` |
| `docs/SDF_COVERAGE_DISCOVERY.md` | REPLAY-VERIFIED-FULL | `4c2c9b6f746d5142…` |
| `docs/SDF_REALTIME_POLICY.md` | REPLAY-VERIFIED-FULL | `fcabb1b2ed26625f…` |
| `docs/SDF_REGION_CONTACTS.md` | REPLAY-WINDOW-VERIFIED | `a86650dba3e4a4a2…` |
| `docs/SDF_SEPARATION_SAFETY.md` | REPLAY-VERIFIED-FULL | `f0127bb30f16aae9…` |
| `scripts/sdf-coverage-audit.ts` | REPLAY-VERIFIED-FULL | `9a53d027ec02e6cc…` |
| `scripts/sdf-coverage-discovery.ts` | REPLAY-VERIFIED-FULL | `a280ccc0c248ac9e…` |
| `scripts/sdf-coverage-screen.py` | REPLAY-VERIFIED-FULL | `2965fc4a51eaa3dc…` |
| `scripts/sdf-region-contact-audit.ts` | REPLAY-VERIFIED-FULL | `7c3d1c9e1a61f312…` |
| `scripts/sdf-region-contact-screen.py` | REPLAY-VERIFIED-FULL | `c413db20847ccbbf…` |
| `scripts/sdf-region-native.ts` | REPLAY-VERIFIED-FULL | `4e57864fceff06bc…` |
| `scripts/sdf-region-pile-quality.ts` | REPLAY-VERIFIED-FULL | `3a819f0368031cb1…` |
| `scripts/sdf-sentinel-device.ts` | REPLAY-VERIFIED-FULL | `75ba1acda1fd8ead…` |
| `scripts/sdf-separation-screen.py` | REPLAY-VERIFIED-FULL | `5cd1225e10b9a628…` |
| `tests-gpu/sdf-region-history.gpu.test.ts` | REPLAY-VERIFIED-FULL | `9ca714275ee97e5e…` |
| `tests-gpu/sdf-temporal-refresh.gpu.test.ts` | REPLAY-VERIFIED-FULL | `68de40e7b6e8c72a…` |
| `tests/sdf-coverage-audit.test.ts` | REPLAY-VERIFIED-FULL | `1bea15850d624ccb…` |
| `tests/sdf-f32-enclosure.test.ts` | REPLAY-VERIFIED-FULL | `d51374d9916b4933…` |
| `tests/sdf-field-certificate-audit.test.ts` | REPLAY-VERIFIED-FULL | `bb48cfc769987e42…` |
| `tests/sdf-field-certificate.test.ts` | REPLAY-VERIFIED-FULL | `437c1212ebd83d24…` |
| `tests/sdf-region-contact-audit.test.ts` | REPLAY-VERIFIED-FULL | `8d0440b6ada0a394…` |
| `tests/sdf-sentinel-policy.test.ts` | REPLAY-VERIFIED-FULL | `db0fb8b60151ba90…` |

Not included (recovered only partly or not confirmed, kept in private scratch for forensics):

- `docs/SDF_INTERPOLATION_BOUNDS.md` (REPLAY-UNVERIFIED)
- `scripts/sdf-f32-separation.ts` (REPLAY-UNVERIFIED)
- `scripts/sdf-region-discovery-audit.ts` (REPLAY-UNVERIFIED)
- `scripts/sdf-region-discovery.ts` (REPLAY-PARTIALLY-VERIFIED)
- `scripts/sdf-region-native-audit.ts` (REPLAY-UNVERIFIED)
- `scripts/sdf-region-solver.ts` (REPLAY-PARTIALLY-VERIFIED)
- `scripts/sdf-sentinel-policy.ts` (REPLAY-UNVERIFIED)
- `scripts/sdf-temporal-quality.ts` (REPLAY-PARTIALLY-VERIFIED)
- `scripts/sdf-temporal-refresh.ts` (REPLAY-UNVERIFIED)
- `src/avbd3d/gpu/sdf-bridge.ts` (REPLAY-UNVERIFIED)
- `tests-gpu/sdf-region-discovery.gpu.test.ts` (REPLAY-UNVERIFIED)
- `tests-gpu/sdf-region-solver.gpu.test.ts` (REPLAY-UNVERIFIED)
- `tests/sdf-bricked-atlas.test.ts` (REPLAY-UNVERIFIED)
- `tests/sdf-coverage-discovery.test.ts` (REPLAY-UNVERIFIED)
- `tests/sdf-f32-separation.test.ts` (REPLAY-PARTIALLY-VERIFIED)
- `tests/sdf-region-discovery.test.ts` (REPLAY-UNVERIFIED)

Also not recovered at all: the `docs/measurements/sdf-*-2026-10-2{4,5}.json` files, the GPU
witness and discovery outputs, capture roots, gate logs, and 8 files with no literal base (including
the replay recorder). 28 further files diverged from verbatim reads and are withheld.
