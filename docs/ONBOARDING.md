# Developer onboarding acceptance — 2026-11-06

Applied the project-readme/setup and product-onboarding criteria to this **library**, reusing
existing lead/candidate/evidence. Base main `afc1442e64e4b36f2d49be70bf35ea0c9b85cf6c`;
this records the pre-delivery working snapshot and its acceptance limits. No new product hierarchy, audit or release channel.
[Start with README](../README.md), [setup and recovery](SETUP.md), [candidate evidence](REVIEW_20261106.md).
The frozen review-20261106-1 and its hashes are unchanged; these subsequent docs are not in it.

## Applicable journey and states

Intended user: Three.js developer. First useful result: independently installed physics consumer,
editable ground/crate/sphere scene and impulse interaction, with durable source/lockfile/package.
Delivery today: source checkout for development, frozen local source/tarball for exact candidate review.
Published 0.3.0 and candidate 0.4.0 are different. Ship-demo is a separate repository/ownership obligation,
not the fresh consumer or an AVBD package example to fold into this repository.

| Stream | Current state and evidence | Existing work / next acceptance / owner |
| --- | --- | --- |
| First useful session | **Verified**, bounded Nov 6 install/build/browser settling and impulse; **planned** real user walkthrough | [STE-3003](https://linear.app/sbobyn/issue/STE-3003): Steven follows own-copy README in 15–25 minutes, changes body/material/interaction, records help/time/bugs. Lead triages raw feedback against existing work. |
| Dependencies/configuration | **Verified** Three 0.187.0 + local package consumer, Vite 8.3.6 build; **implemented but unverified** broader platforms/minimum Node | Same ticket: supported matrix/capability failures; [SETUP.md](SETUP.md#configuration-and-storage) distinguishes authored physics, process port and browser preferences. No provider/secrets UI needed. |
| Persistence/recovery | **Implemented but unverified** source/lockfile/tarball recipe; live-world autosave **not applicable** to current library contract | Same ticket: stop/reopen saved consumer and restore to a separate copy without losing originals; demonstrate reconstructed scene and exported JSON limits. Lead owns focused verification. |
| Exact distribution/updates | Local candidate/hashes **verified**; update/rollback walkthrough **planned**; registry release **blocked** on exact artifact qualification and Steven publication decision/access | Same ticket retains ESM/types/SDF bake/contact/raycast/lifecycle, package contents, source/tag/changelog/registry tests. Lead prepares; Steven chooses publication timing. No automatic updates. |
| Public page/media | Existing README/GIF and hosted links **implemented but unverified** for current-build parity | Same ticket: current exact-build media and page/version agreement; [MEDIA.md](MEDIA.md) preserves historical provenance. No new public page/deploy required for local review. |
| User acceptance | **Planned**, Steven has not reported the walkthrough result | Same ticket: preserve raw findings; label defect/confusing guidance/unsupported behavior/feature request, deduplicate before issue changes. Prepared code/tests do not close acceptance. |
| Large-scene quality/performance | **Blocked** on matched accepted candidate and hardware evidence | [STE-3001](https://linear.app/sbobyn/issue/STE-3001) parent; [STE-3006](https://linear.app/sbobyn/issue/STE-3006) C4 In Progress; [STE-3007](https://linear.app/sbobyn/issue/STE-3007) C5/C6 Backlog. Lead retains draft PR 70/71 isolation and paired quality gates. Not a prerequisite for small-session review. |
| Downstream integration | **Planned**, not qualified by standalone consumer | [STE-2834](https://linear.app/sbobyn/issue/STE-2834), Backlog in M8.5: separate Destruction owner tests exact AVBD dependency/replay/performance. No consumer repo edits here. |

## Milestone/task reconciliation

Linear read on 2026-11-06: these AVBD issues live in the existing **three-destruction** project,
P-STE-27, UUID `d5b52da6-00c1-4c30-b7f9-6603650d9451`; this shared tracker location does not
combine source repositories. STE-3001/3003/3006/3007 have no milestone. STE-3003 is In Progress,
assigned Steven, parent STE-3001; it was extended in place with this acceptance sequence. No issue
was created, closed, reassigned or moved. Historical descriptions remain, with a dated correction.

Reuse **M9 · Game scale and release**, ID `5740530f-292e-4708-b2b8-5871f7b454c1`, as the
broader existing release umbrella. **Proposed** AVBD slice: “Developer review and deliberate package
release”: first useful consumer → source/recovery/update verification → exact release acceptance.
Do not rename/restructure the shared game milestone or make all game-scale work a prerequisite.
M9's older “three-destruction 0.1” publication wording is historical/planned, not evidence of a current
approved version; its peer/dependency release timing belongs to the Destruction lead.
STE-2834 remains linked to M8.5, ID `d15a983f-696e-40aa-ad92-ac8515624fa5`.

Source conflicts reconciled in STE-3003's dated addition: October Three availability is superseded
by tested 0.187.0; October candidate checksum is distinct from November review; package preparation
is not registry publication. Existing SDF consumer criteria remain stronger than the new basic-body
browser smoke and are still open. Existing project home is Obsidian Project Inventory → Three AVBD;
that shared historical note was read, not edited. The lead's unique receipt records this work.

## Next bounded sequence and decisions

1. **Now:** Steven uses the already frozen candidate and its own README; no cleanup dependency.
2. **Lead:** focused saved-consumer reopen/restore and current-candidate SDF/type/package checks;
  keep exact version evidence and do not replay broad physics suites merely for docs.
3. **After feedback:** deduplicate and extend existing issues; finish matched release/update/public-page
  acceptance. Publication/source delivery and target support direction require Steven's actual choice.

No decision is needed to begin local review. Steven subsequently authorized merging this documentation/candidate work to remote main.
Publication, unrelated PR closure, deployment and personal installation changes remain separate decisions.
Hands-on readiness: bounded verified exploration. Release readiness: incomplete. User acceptance:
open. Cleanup/audit completion: open; preserve shared Git/live sessions, unique dirty/untracked/ignored
and unpushed work, five checkpoints/three stash objects, recovery copies and distinct ship-demo evidence.

## Validation limits

Documentation pass only: local links/anchors, source command/config/storage checks and existing GIF
metadata/signature. Reused Nov 6 gate 255 CPU/260 GPU and fresh-consumer evidence; no full-suite repeat,
new install, browser launch, GPU rendering or publication. Current media, save/reopen/restore/update,
minimum runtime and non-M4 platforms remain unverified. Frozen artifacts were not rewritten.
