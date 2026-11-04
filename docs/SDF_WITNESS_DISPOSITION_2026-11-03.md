# SDF witness PR #36 disposition on current main

Base: `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`. Historical PR head:
`e6753450f050c4d262ff3fe9e9237fb6f7da8442` (parent implementation `711eb81`).

## Decision

Port only the narrow witness filter and a current-main regression on a new branch. Do not
merge the old branch wholesale or import its measurements as fresh evidence. #36's branch
is untouched. Current main has the parallel witness path added after #36; both scalar and
parallel support sources need the same filtering rule.

The filter is confined to existing opt-in `meshVertexContacts`. A successful exact witness
supplies the contact direction. An optimizer point is disabled only when its normal opposes
that witness and its sample is either inside both fields with aligned gradients, or outside
both fields. Other points remain available. No witness means no filter; default SDF collision
does not enable vertex witnesses. Two field evaluations count as one paired query, consistent
with the existing SDF statistics convention.

This is separate from the rigid box-box face manifold investigation. It adds no general CCD,
changes no reference solver, and makes no claim that every genuine mesh interlock is solved.

## Reproduction before implementation

The new `tests-gpu/sdf-witness-filter.gpu.test.ts` tests 48 seeded, tilted two-box overlaps
using a baked resolution-8 field and exact vertex witnesses. Each pose also runs with
vertex witnesses disabled. It checks that active optimizer points cannot oppose an exact
witness where their own normal is ambiguous, and that the fixture actually filters points.

On unchanged current main, both scalar and parallel tests failed at pose 17:

```text
active optimizer contact opposes its witness with an ambiguous normal
tests 2; pass 0; fail 2; skipped 0; exit 1
```

After the narrow port, the new tests pass. Existing plane-edge/default-off behavior,
mesh witness identity and scalar/parallel history equality also pass in the targeted run:

```sh
node --experimental-transform-types --test --test-concurrency=1 \
  --test-name-pattern='SDF witnesses|cooperative mesh witnesses|mesh plane contacts retain|mesh-to-mesh vertex witness' \
  tests-gpu/sdf-witness-filter.gpu.test.ts \
  tests-gpu/sdf-witness-parallel.gpu.test.ts tests-gpu/sdf-supports.gpu.test.ts
pnpm typecheck
```

Results: five real-device GPU tests passed, zero failed/skipped, exit 0; typecheck exit 0.
The serial targeted GPU command took about 1.5 seconds on this machine with shader caches.
That duration is a test observation under contention, not a performance benchmark.

## Qualification still outstanding

`uptime` before broader qualification reported one-minute load 10.03 (>8). The old chair/bunny
multi-seed measurement batch and full GPU gate were not run. Nightly should compare current
baseline and this branch with the same seeds/settings and explicitly check genuine opposed
contacts, penetration, energy and retention. Historical #36 numbers do not establish that
envelope on this implementation. Keep this PR draft until that evidence is available.
