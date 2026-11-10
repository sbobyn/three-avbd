# World same-device determinism probe

Status: tool and CPU tests written 2026-11-10 against source `0b48ebf` (STE-3003, roadmap F1, first slice).
**No hardware run has been made.** Whether a `World` repeats on one device is still unknown; this
document describes how to find out and what a result would and would not show.

## What it is

`tools/world-determinism.ts` is an opt-in Node + Dawn tool (no browser, no rendering, not part of
`pnpm test`). It builds a `World` through the public API twice, one after the other, on one device the
process owns, steps both identically, reads each once, and compares the bytes.

```
node --experimental-transform-types --no-warnings tools/world-determinism.ts \
  [--steps 1..600 (240)] [--bodies 2..4095 (16, dynamic; a fixed floor is added)] \
  [--pacing sync|yield (sync)] [--json <new file>.json]
```

The pure parts (arguments, scene, runner, comparison, report) are in `tools/world-determinism-core.ts`
and are exercised on the CPU by `tests/world-determinism.test.ts` with a fake World, device and clock.

## The configuration

| Item | Value |
|---|---|
| Storage | `growth: 'fixed'`, explicit `pairs 16×N`, `contacts 32×N`, `manifolds 8×N` (each at least the library's floor of 4096 / 8192 / 4096), `joints 256`, `hullVec4s 4096`, N = bodies + 1 |
| Step | `dt` 1/60 s, `iterations` 10, gravity `[0, -9.81, 0]`, every step on the standard collision backend |
| Scene | A fixed 48 × 1 × 48 floor; a ball-jointed pair of 1 m boxes beside the lattice (the joint cannot break or yield); then boxes and spheres dropped from a staggered 8 × 8 lattice, layer on layer. No randomness: every value is a function of the body count |
| Readback | `readbackEvery` stays 0 (the runner requires it and never sets it). No `read()` before the end. One `world.read()` per run, after the last step |
| Runs | World A is built, stepped, read and destroyed; then World B from the same inputs. The device is shared and is destroyed only by the tool at exit |
| Bounds | Steps at most 600, bodies at most 4096 including the floor. Derived fixed storage, not measured: about 2 MB of retained buffers at the default size and about 22 MB at 4096 bodies (library arithmetic, `resolveFixedStorage`; excludes staging and driver overhead) |

`--pacing` is a probe parameter, not a library setting:

- `sync` calls `step()` back to back. `World.step()` starts a solver-counters readback every 10 steps; in a
  tight loop nothing yields, so those reads cannot land until the loop ends.
- `yield` waits one event-loop turn after every `step()`, as an application's frame loop does, so those
  reads can land between steps. This is the interleaving in which audit M-08 expects a difference.

Neither is the default for any user: both are conditions to run and report separately.

## What is compared

After the final step and one `world.read()`: for every body, in creation order, the float32 bit patterns
of `Body.position` (3), `Body.rotation` (4), `Body.velocity` (3) and `Body.angularVelocity` (3). That is 13 values,
52 bytes a body. Equal means every 32-bit word is identical. There is **no tolerance**: one unit in the last place
is a mismatch, and `+0` against `-0` is a mismatch. A value that is not a finite number, not exactly a float32,
or a record of the wrong length fails the run instead of being compared. The report carries the first differing
body and field, counts, and a position gap in metres that is informational only and never decides the result.

Each run also records the step `read()` reported and `stepCount` afterwards; both must equal the step count, or
the run fails. The FNV-1a digest in each run record is for matching reports between invocations. It is not a
security hash and not the comparison.

## What is not compared, and what a result cannot show

- Internal solver state (contact and manifold persistence, warm-start state, colourings, hashes, counters,
  overflow flags). The public API does not expose it and the probe does not use the advanced export. If the
  storage capacities were exceeded, records would be dropped in a thread-timing-dependent order and the probe
  could not tell; the capacities are roomy for that reason, and that is a precaution, not an observation.
- Joint state and forces, contact events, and every intermediate step. With one final read, a mismatch
  **cannot be placed at a step**: this slice produces no first-divergent-step result. That needs checkpoint
  reads (which change the no-read condition) and is a later slice.
- Anything about another device, driver, Dawn version, build or scene.
- A match is two runs of one configuration. It shows nothing about hidden state, other scenes, longer runs or
  future runs, and is not a replay or checkpoint guarantee. A mismatch is evidence of a difference in these
  observable fields; the cause is not identified by the probe.

### The automatic counters readback

`World.step()` reads the solver counters every 10 steps (`ADAPT_EVERY`) and, when that read lands, applies the
colour-scheduling part of its adaptation (`GpuSolver3D.adapt` runs `adaptColors` before its fixed-storage early
return). Storage capacity stays fixed; the colour cap and colouring rounds can change. The step at which the
read lands depends on timing, and the public API has no switch to turn this off. The probe therefore does
**not** achieve "no automatic readbacks" in the strict sense; it achieves "no body readbacks and no
`readbackEvery`", and `sync` pacing keeps the counters reads from landing mid-run. This is audit M-08.
Per the roadmap, a public adaptation policy is added only if the probe diverges; this tool adds none.

## The report

JSON, schema `three-avbd.world-determinism/1`, to stdout or to the `--json` file (created with `wx`, never overwritten).
It contains no local path (messages are sanitized), no shader text and no adapter output beyond the identity strings
already recorded by the other tools. Contents: `status` (`matched`, `mismatch`, `failed`, `refused`), a verdict
sentence, `generatedAt`, source (package, Git head, dirty flag and change counts, declared dependencies),
environment (Node, OS, CPU model, installed `webgpu` version, qualified adapter record, required limits), config,
a per-run record (step stamp, step count, bytes, digest, resolved storage plan, error, dispose error), the
comparison, the declared scope above, and `notRun`.

`notRun` always lists what this first slice does not do: the adaptive-storage variant, `readbackEvery`
variants, checkpoint reads, and cross-device or cross-build comparison. They are not reported as passes.

Exit codes: `0` matched · `1` failed · `2` usage or input refusal (before any GPU module is requested) ·
`3` GPU refusal or unavailable · `4` completed with a mismatch (a result, not a failure).

## Safety

- `--help`, bad arguments and an existing `--json` target exit before the `webgpu` module is imported.
- The adapter is qualified with the existing `assessAdapter` before `requestDevice`: fallback, software and
  unidentified adapters are refused with no override. The Dawn instance, adapter and device stay alive for the
  process.
- The runner destroys every World it made, on success and on every failure path, before making the next.
  The second run is not attempted after the first fails. The tool destroys only its own device at exit.
- Uncaptured GPU errors and device loss are recorded and fail the run. No setting is retuned and no tolerance
  is loosened to make a result match.

## Running it (lead, on verified hardware)

One tiny probe first, for each pacing, then a larger one if both behave:

```
node --experimental-transform-types --no-warnings tools/world-determinism.ts --steps 60 --bodies 16 --json <new>.json
node --experimental-transform-types --no-warnings tools/world-determinism.ts --steps 60 --bodies 16 --pacing yield --json <new>.json
```

Repeat each invocation to see whether the digest repeats across processes. Record the result, the adapter
and the commit in a dated file under `docs/measurements/`. Until that run exists, same-device determinism
through `World` stays unverified, and the cache and replay claims that depend on it (roadmap B4, L2) stay open.


Lead review: the host drains and destroys its owned device before publishing. Any late device
or teardown failure makes the report failed, preserves an earlier runner error and comparison,
and is not reported as an accepted byte match. Hardware evidence is still pending.


## First bounded hardware observation — 2026-11-10

[Source-qualified record](measurements/world-determinism-2026-11-10.json): a frozen archive of
committed library source `0b48ebf3a3829e64da3feb44815f9aee1b0a8650` plus the reviewed probe
(overlay hashes in the record), using existing dependencies without installing. The archive
has no usable Git metadata; raw reports retain that unknown rather than borrowing a parent
checkout's HEAD. The separate archive/overlay manifest establishes source identity.

Apple M4 Max, Metal3, non-fallback adapter, Node25.2.1/Dawn0.6.1/macOS26.6.2. Two processes each
for `sync` and `yield`; each process created two sequential Worlds,16dynamic bodies plus floor,
60steps at dt1/60,10iterations, gravity[0,-9.81,0], fixedstorage, readbackEvery0. All four pairs
matched every compared word (884bytes per pair); all eight observations had digest`42a16c51`.
No device/teardown error was reported. This does not show first divergence or identical
internal counter/warm-start/contact state. Internal counter reads remain enabled; event-loop
yielding does not prove any particular adaptation callback landed. No longer-run, adaptive,
automatic-body-readback, cross-device, checkpoint, replay, physics or speed qualification.

The separate frozen source avoids testing a partially edited solver while other implementation
work proceeds. Future solver changes need their own source-qualified checks.
