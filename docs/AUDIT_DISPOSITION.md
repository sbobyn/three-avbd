# Audit disposition ledger — 0.4.0 (opened 2026-11-01)

Scope: the original AVBD audit IDs in [audit-remediation](audit-remediation.md),
plus remaining cross-project findings explicitly required by the release roadmap.
Baseline `0e11c7f6f2dcf584ee800906903d1b3ef66c4e25`. A merged PR is not evidence
that every finding is closed. “Fixed” below means source and named regression
exist; current GPU requalification remains open for every GPU-dependent row.
CPU/declaration/package results and exact candidate provenance are recorded in the
R0-A execution handoff. Original audit reasoning and historical measurements remain
in audit-remediation; do not treat those measurements as newly executed here.

| Finding | Disposition | Source / regression and remaining qualification |
|---|---|---|
| A1: C4 evidence loss | Documented limitation | audit-remediation A1: recovered report/tool text only, no measurement data; no C4 qualification inferred or regenerated |
| A2: reused joint exclusion | Fixed; GPU rerun open | gpu/no-collide.ts, solver.ts; tests/no-collide.test.ts and tests-gpu/world-contracts.gpu.test.ts cover queued/released/reused joint slots |
| A3: ignored contact-set overflow | Fixed with lossy recovery | lib/contacts.ts, World.read/contactSetOverflows; world-contracts GPU growth case; starts fresh after bounded growth, not lossless replay |
| A4: speculative sphere/box branch | Deferred research | Preserved old comparison checkout only; not ported, no CCD claim; AH-3 folded here |
| A5: insufficient in-flight read coverage | Fixed; GPU rerun open | World.read/readCovers; world-contracts GPU subsets/writes, world-observations GPU intervening steps |
| A6: use/destroy races | Fixed for explicit destroy; loss unqualified | World guards and post-await checks; world-contracts and sdf-lifecycle GPU tests. Previously submitted rays retain snapshots. Device loss is separate below |
| AS: stale API/status/pointers | Documentation reconciled within release scope | API now lists four entries; audit summary distinguishes final historical gate; old SDF release page labeled historical. PLAN/FINDINGS retain dated history, not fresh qualification |
| AC-1: eager shader strings | Disproved as a release blocker by historical measurement | audit-remediation AC-1 reports negligible construction time; strings are not re-exported by package entries. No new timing claim |
| AC-2: duplicated quaternion helpers | Documented limitation / no change | audit-remediation AC-2 traces differing signatures/precision/TSL use; broad consolidation deferred |
| AC-3: SDF per-step bind groups | Fixed in audited bridge/broadphase scope | gpu/bind-group-cache.ts, sdf-bridge.ts, sdf-broadphase.ts; tests/bind-group-cache.test.ts and tests-gpu/step-allocations.gpu.test.ts. Standard ContactWatch cache is outside this finding |
| AH-1: old standard manifold after replacement | Fixed; GPU rerun open | layout initialPos.w marker, standard collision hash insertion and warmStartBodies; world-contracts GPU replacement with reuse on/off and fixed floor; seedFrom preserves imported matching history |
| AH-2: quadratic adjacency insertion sort | Deferred measurement | wgsl-topology adjacency sorting is O(degree²), not bounded to “a few dozen”; no stress run authorized here. Target-device phase measurement needed before algorithm change |
| AH-3: speculative extra body loads | Deferred with A4 | Old optional O(spheres × bodies) branch; no runtime port |
| Comparison harness provenance/sphere rendering | Deferred / preserved externally | audit-remediation harness notes; protected comparison source and recovered patches untouched. Harness-only port/rebaseline is separate from physics |
| Partial set uploads stale CPU lanes | Fixed; GPU rerun open | lib/body-commands.ts, World.write/flush, GpuSolver3D.patchBody (gpu/solver.ts); tests/body-commands.test.ts and tests-gpu/body-commands.gpu.test.ts |
| Fixed move start/retarget/read consumption | Fixed; GPU rerun open | gpu/body-mover.ts, World.move/slide; body-commands GPU target/cancel regressions; nonempty set cancels active slide |
| Contact-reference reuse after slot replacement | Fixed for public World lifetime observations | lib/identity.ts and lifetime watch IDs; tests/identity.test.ts, tests-gpu/world-observations.gpu.test.ts cover reuse, listener mutation, bounded retirement and ray snapshots. Raw downstream adapter references need its own review |
| SDF teleport warm-start invalidation | Open / experimental | Standard initialPos.w invalidation does not prove SDF pair-history invalidation: sdf-bridge.ts and wgsl-sdf-history.ts use a separate cache. No teleport-history regression executed. Do not advertise full SDF reset guarantees; reproduce and design separately |
| Capability fallback hidden from callers | Fixed; GPU rerun open | lib/capabilities.ts and World.create preflight; tests/capabilities.test.ts covers 8/9 boundary; tests-gpu/capabilities.gpu.test.ts uses actual eight-buffer device and zero-allocation rejection |
| Static query collidesWith accepted but ineffective | Documented reserved field | queries/scene.ts and QUERIES.md: mesh.group & query.collidesWith selects, mesh.collidesWith does not. Not symmetric pair filtering; no silent support claim |
| Capsule unresolved interval mistaken for miss | Documented explicit result; regression coverage | queries scene/sweep and capsule tests: indeterminate fraction is unresolved, not a safe displacement. Application stop/subdivide policy required |
| Raw-layout coupling / multi-manifold assumptions | Open integration constraint | advanced exports remain unstable, JOINT_FLOATS=40 and rewrite marker must be respected; downstream impact aggregation and current packed pair require R0-D validation. No ABI redesign in R0-A |
| Calibration after damage | Open downstream / R0-D owner | Release roadmap requires intact-baseline calibration before damage; AVBD tests cannot close an adapter calibration bug. No destruction source edited or runtime qualified here |
| Statics sequence matching | Open downstream / R0-D owner | Need current packed-pair fixture proving statics and readback transaction matching. Historical adapter/gate evidence does not close current sequence correctness |
| Callback/worker/setup teardown | Partially fixed AVBD; downstream qualification open | world-contracts/sdf-lifecycle GPU and CPU SDF async/worker tests cover AVBD cases; destruction worker death, setup abort and pending fracture disposal require R0-D browser fixture |
| Deformation/fracture ordering | Open downstream / R0-D owner | Must reproduce ordered handoff on current destruction candidate; not established by solver tests or PR merges |
| Controller interaction under sustained stall | Open downstream / R0-D owner | Need presentation and tier/dynamic-resolution/shed interaction fixture. No performance benchmark in this slice |
| Removed-handle pose getters can alias a reused slot | Fixed; GPU rerun open | Independent P0 review F6. 426762a freezes the last known own observation at removal (lib/world.ts `Body.frozen`); tests-gpu/body-activation.gpu.test.ts covers outstanding reads and same-slot replacement |
| Device loss and recovery | Open qualification | World observes device.lost, retains it on world.error and rejects later GPU work. Dawn induced-loss/automatic-read and fresh-recreation tests pass; no automatic recovery. The paired-qualification AbortError (loss while only `World.step`'s periodic counter map is pending) is handled since 426762a and pinned in tests-gpu/lib-lifecycle.gpu.test.ts (#58). Recreate from application definitions; browser/loss-time checks remain required |

The downstream open rows are ownership handoffs, not claims of reproduced defects
in the current destruction head. Any reproduced silent correctness defect in an
advertised downstream path blocks that release until fixed or removed from scope.
SDF experimental status does not close its outstanding correctness investigation.
