# SDF witness PR #36 disposition on current main

Base: `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`. Historical PR head:
`e6753450f050c4d262ff3fe9e9237fb6f7da8442` (implementation `711eb81`).

## Decision: rejected; no runtime port

Keep #36 quarantined. The existing October 24 findings already reject both its
outside-both direction filter and a narrowed inside-both version. Current main
preserves valid opposing supplemental contacts and includes parallel witnesses.
Do not merge the historical branch or revive its filter behind meshVertexContacts.
That opt-in does not make removal of genuine gap contacts correct.

The initial reconciliation commit on this draft attempted a current-main port.
Its five selected tests passed, but that selection missed the existing test
`a mesh witness retains valid opposing gap contacts in the same non-convex pair`.
The light self-check ran that test: the attempted port fails, exit 1, with
`a gap-derived near contact must survive the opposing witness`.
The filter has therefore been removed from this branch. Production source is
identical to the base; no historical PR branch was modified.

## Retained bounded evidence

The added serial/parallel 48-pose fixture demonstrates why direction-only culling
can be tempting: an exact witness and an active optimizer point may oppose one
another with an ambiguous local gradient/sign classification. That observation
is not sufficient to prove a contact spurious. The fixture now guards retention,
not the rejected assumption that all such contacts should disappear.

The existing non-convex two-flank regression is the decisive control: a 2.5 mm
penetration on one flank must not remove valid 12.5 mm gap-derived near contacts
on the other, within the 20 mm margin. The historical narrowed candidate also
failed the full matched chair ensemble (see `SDF_RECONCILIATION.md` and
`FINDINGS.md`); a new tiny passing fixture cannot supersede that evidence.

Targeted recheck covers the two new retention fixtures, genuine opposing-gap
retention, parallel witness history and existing witness supports: six real-Dawn
tests pass, zero fail/skip, exit 0. Typecheck passes, exit 0; staged whitespace
passes, exit 0. No full measurement ensemble or GPU suite is
rerun under the load cap. No penetration, settling or performance improvement is
claimed. A genuinely different topology-aware filter would need a new proposal,
not automatic incorporation of #36.
