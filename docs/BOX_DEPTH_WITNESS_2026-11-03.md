# Experimental deepest fresh box contact protection

Base: `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`.

## Reproduction and scope

`tests-gpu/box-depth-witness.gpu.test.ts` isolates two rotated boxes. It generates
a manifold, seeds its sticking bits, moves the bodies through direct GPU buffer
writes, and regenerates contacts with zero solver iterations and contact reuse
disabled. This deliberately models retained friction history without an API pose
rewrite invalidating that history. The independent box SAT evaluator sees
0.133905897 m overlap, but the old feature-matched sticking anchors retain only
0.042266987 m of contact depth. The depth assertion failed on the unchanged
collision implementation before the option was added.

The fresh face manifold already contains a sufficiently deep contact. This
reproduction implicates retained sticking anchors, not missing clipping geometry.
It does not establish the cause of the historical 10k-pile outlier or demonstrate
improved pile settling.

## Opt-in contract

Set `world.solver.params.deepestBoxWitness = true` before stepping. The default is
`false`. For built-in box/box face contacts, the deepest existing fresh contact
is marked and protected from sticking-anchor replacement during warm start.
Other contacts retain their friction anchors; normal/tangent warm-start state is
still carried. No synthetic off-face contact or extra manifold slot is added.
Sphere, hull, edge-contact, and reference-solver behavior is unchanged.

Changing the option forces fresh collision generation for that step, bypassing
both contact and manifold reuse. Custom contact shaders reject the option rather
than silently ignoring it. The marker uses a previously unused box feature bit;
buffer layouts and bindings do not change.

## Bounded verification

- The disabled control preserves the old shallow-anchor behavior.
- The enabled reproduction retains SAT depth within 1e-5 m, with exactly one
  protected contact, at most eight contacts, and zero storage overflow.
- Off/on/on/off toggles refresh both reuse paths; separated boxes remain separated.
- Existing narrowphase parity against the reference over 300 random pairs passes.

Targeted serial Dawn tests: five pass, zero fail/skip, exit 0. Typecheck is checked
separately. No performance or older-hardware claim is made. Full GPU suites and
wall/ring/pile measurement batches are deferred: the resumption load was 9.37,
above the agreed 8 threshold. Nightly qualification must examine friction,
torque, energy, and penetration under matched seeds before considering a default
change. This experimental option remains off regardless of the tiny repro result.
