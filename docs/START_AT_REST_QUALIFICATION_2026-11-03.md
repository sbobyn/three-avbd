# startAtRest on/off qualification checkpoint

Base: `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`.

## Decision and bounded evidence

Keep the solver and comparison defaults **on**, including at ten iterations.
The historical single-seed 10k result is a reason to qualify, not enough evidence
to change the default. This checkpoint prepares controlled comparisons and verifies
their wiring; large-scene settling qualification remains incomplete.

`compare:rapier` now accepts `--avbd-start-at-rest on|off`. Any other value or
missing value fails before device acquisition. The selected boolean appears in
the report's `options.avbdStartAtRest` and the actual adapter's
`settings.params.startAtRest`. Both timed run and validation replay construct an
adapter with that setting. Scene geometry/hash is independent of the mode.

Targeted checks on Dawn:

- At zero solver iterations and zero gravity, the on mode holds a slow dynamic
  body's initial guess; off extrapolates velocity. Faster translation, angular
  speed, and kinematic motion do not trigger that hold. This isolates warm-start
  semantics rather than claiming a physical zero-iteration simulation.
- A two-body contact smoke test at 4 and 10 iterations, each on and off, runs eight
  steps, checks reported settings, finite state, overflow and color clashes.
- Three GPU tests pass, zero fail/skip, exit 0. Twenty-six targeted comparison CPU
  tests pass, exit 0. Final typecheck passes, exit 0; an initial test-only boolean
  cast type error was corrected before that final run.

At the measurement checkpoint, `uptime` reported one-minute load **8.34**, above
the agreed 8 threshold. No measurement batch or full gate was run. No latency,
throughput, wall stability, or pile settling improvement is claimed.

## Matched batch recipe (not executed)

Run sequentially only when the one-minute load is at most 8. Record `uptime` and
source revision/dirty state beside the report; abort on failed replay, overflow,
clashes, nonfinite state, or lost floor coverage. Do not compare timing under
contention. Keep the box witness option off to isolate this heuristic.

For each iteration count 4 and 10 and each seed 1 through 5, alternate on/off
execution order by seed. Use the same scene, dt, contact margin, jitter and
lead/window in a pair. A repeat is not a new seed. Example single member:

```sh
pnpm compare:rapier pile-10k-settled --engines avbd \
  --avbd-iterations 10 --avbd-start-at-rest off --avbd-margin 0.01 \
  --dt 0.016666666666666666 --jitter 0.001 --jitter-seed 1 \
  --lead 2400 --steps 600 --final-window 60 --dump-movers 10 --repeats 1 \
  --json start-at-rest-pile-10it-seed1-off.json
```

Also run the original `pile-10k` geometry with those matched options to revisit
the historical outlier. Do not relabel its invalid initial/mid-collapse scene as
a qualified resting layout. Inspect `sceneValidity` and independent pair depths.
Run `ring-110k` at both iteration counts and both modes with a fixed 600-step
window and no jitter to preserve the existing construction. It is an impact
scene, not evidence that a settled pile is at rest.

The historical 40-course wall needs a matched stationary-wall quality driver:
the comparison CLI does not expose that scene. Do not substitute the impacted
brick ring or a timing-only benchmark as wall-stability qualification. Adding
that bounded quality driver is the next implementation task, not an executed
result in this checkpoint.

## Acceptance before proposing a default change

Use all five seeds, not a best run. Compare final-window max/p95 pair and floor
penetration, max speed, kinetic energy, rest fraction and mover bursts; preserve
worst-over-window diagnostics too. Reject any newly failed settling seed under
the existing 1%-of-body-size contact target and 0.01 m/s settled-speed bound.
Require the suspected 10k burst reduction to reproduce across seeds, with no
new wall collapse, ring instability, or gross energy/penetration regression at
either iteration count. Retain per-seed reports and an explicit decision; do not
replace these checks with a median timing improvement. If results disagree,
leave defaults unchanged and document the tradeoff. Target-hardware performance
qualification remains separate.
