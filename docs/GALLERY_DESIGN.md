# Demo gallery design — STE-3288

Prepared 2026-11-09 on branch `feat/ste-3288-demo-gallery-20261109`, base
`34a8f78a1da40a69ed839bec09e44c32e6194490`. Parent: STE-3003 / M9.
**Status: implemented source candidate, lead-reviewed; not Steven-approved.** Routine spacing and copy
can change without another design round; structural changes should come back here.

## Paper

The Opus authoring session could not discover Paper tools; its original local design was
source-authored. During lead integration Paper was available. The lead created the project design home:
[Three AVBD — Demo Gallery](https://app.paper.design/file/01M70T16Q4HAQ4G6W2GG68F1EE/p-1-0).
The desktop reference artboard holds the identity, filter layout, four original thumbnails and
paired-study component; it is a representative reference, not a full-page or interactive export.

Transfer is **source → Paper**, manually mapped from `src/gallery/gallery.css`, `catalog.ts` and
`public/gallery/`, based on main34a8f78 plus this ticket's overlay. No live/two-way sync or
prior human approval is claimed. Paper system-ui was unavailable; the verified Arial400/700
reference differs from the app's system-ui400/600. Paper token aliases map `--color-paper` to
CSS `--paper`, `--color-ink` to `--ink`, etc. Source remains authoritative for behavior,
responsive layout and runtime styling. No private receipt or engine/paper artwork was uploaded.

## Goal

One page at `/examples/` (the existing route; no new Vite input) where Steven or a visitor can pick
a useful demo or paired study quickly, and where every existing human-selectable scene can still be
found. It replaces the previous bulleted examples list; all existing page URLs are unchanged.

## Directions explored

**A. Filterable catalog (implemented, recommended).** A short *Start here* row of four first picks
(see it move, compare with Rapier, nonconvex shapes, write your own), with a sticky search and filter
bar above it, then cards grouped by topic. Large scene collections are single cards whose scene chips each
open the scene directly. Strengths: everything is discoverable and searchable by scene name; dense
enough for Steven's repeated use; the first row still gives a newcomer a single obvious action.

**B. Guided paths.** Three large path panels (*Play*, *Compare with Rapier*, *Build with it*), each
expanding into a curated list, with the full index behind a "Show everything" link. Friendlier for
a first visit, but it hides most scenes behind a second click, makes scene-name search a separate
mode, and forces the paired study, SDF work and benchmarks into paths they only partly fit.

A keeps B's strength (the *Start here* row is B's three paths plus SDF) without hiding content.

## Structure

Groups, derived from the actual content and the viewers' own menu kinds (`src/ui/scene-menu.ts`):

| Group | Entries |
|---|---|
| Contacts and stacks | 3D playground, 3D and 2D stack/friction collections |
| Joints, springs and breaking | 3D ropes/bridge/breakable/plastic, 2D ropes/nets/motor/fracture |
| Large GPU scenes | Paper scenes, paintings, 3D and 2D scale tests, Custom (3D and 2D) |
| Nonconvex SDF collisions | SDF playground, gear train, released SDF studies, three focused SDF examples |
| Rapier comparisons | Interlocking pair, side by side (+ rendered workflow benchmark), quality runner, CLI |
| Build with the library | Basic world, body lifecycle, body pool, static projectile (Node), fresh project |
| Results and benchmarks | Results vs the paper, 3D and 2D GPU benchmarks |

Filters (combine with AND; pressing an active chip or *All* turns it off):
- **Search**: every word must prefix a word in the title, description, labels, command, source path or
  any contained scene name (case, accents and punctuation folded). Matched scene chips are highlighted.
- **Topic**: the seven groups. **Type**: Playable, Headless, Diagnostic, Benchmark, Command.
- **Engine**: *three-avbd only* or *Includes Rapier*.

Result count is a polite live region; *Clear* appears only while filtered; the empty state names the
query and offers *Clear filters*. `/` focuses search and Escape clears it. Filter state is kept in the
query string (`?q=&group=&kind=&engine=`) so a filtered view can be linked; unknown values are ignored.

Cards: illustration (labelled *Illustration*), title, badges (type, Experimental, 2D/3D,
*Rapier + three-avbd*, requirement), one what-to-try sentence, then either the paired Rapier/AVBD
buttons, a command, or the scene chips, an optional *Limits* disclosure, and Open / extra links / Source.

## Coverage and links

- Every scene in the 3D and 2D viewer menus links directly with the existing `?scene=` parameter
  (`/` and `/2d.html`). The menus' unlisted sandboxes (`Ground`, `Empty`) are intentionally omitted.
- Every comparison case is reachable from the side-by-side card: 27 case chips each select their exact input
  with `compare-side.html?scene=`, and search matches every case id (e.g. `impact-1000`).
- Pages without a scene parameter (`sdf.html` presets, `sdf-released.html` scenes, `compare.html` cases)
  list their contents as plain names with *Choose with the Scene menu on the page*. The SDF pages'
  `?preset=` / `?scene=` parameters exist only in qualification mode (`?qualify=1`) and are not used.
- `compare-frame.html` is an internal diagnostic page; it appears only as a link on the side-by-side
  card, labelled *Rendered workflow benchmark*, not as its own demo.
- Proposed studies in `docs/DEMO_REFERENCES.md` are not listed; the page says planned studies appear
  only once they exist. The separate ship-demo repository is not linked or merged.

`tests/gallery.test.ts` enforces this against the real registries (`allScenes2D`, `allScenes3D` via
`sceneMenu`, `CASES`, `releasedScenes`, the static `<select>` options in `sdf.html` and
`sdf-released.html`) and the Vite page inputs, and checks that every link selects a scene the page
accepts, every thumbnail exists and is referenced, and the page imports only gallery code.

## Comparison honesty

The interlocking card leads with *1 Rapier first*, then *2 AVBD counterpart*, and its Limits state the
geometry difference (16–64 convex pieces vs analytic torus fields), async AVBD readback, no native
sleeping/CCD, restitution not modelled and SDF regularization drag, and that results are
observations, not a winner or benchmark. Comparison tools are typed *Diagnostic* and say quality
targets come before timing. The footer states thumbnails are illustrations, not screenshots or
measured results.

## Tokens (manual transfer source)

From `src/ui/page.css` and the brand mark `public/favicon.svg`; defined in `src/gallery/gallery.css`.

| Token | Light | Dark |
|---|---|---|
| paper / surface / sunk | `#f6f3ec` / `#fffdf9` / `#ece7dc` | `#12161b` / `#1a1f26` / `#232a33` |
| ink / muted | `#1f2328` / `#5b6168` | `#e8eaed` / `#a2aab3` |
| accent (brand floor) | `#b8503f` | `#e1795b` |
| link / focus (brand tile) | `#2e5a78` | `#9cc9ea` |
| badge hues (brand blocks) | playable `#b8d68e`, headless `#a3c1e8`, diagnostic `#ece08c`, benchmark `#f2bf8c`, command `#c4a5df`, experimental `#e79aa3` | same, dark ink |

Type: system UI stack, 15px base; h1 28px, group h2 20px, card h3 17px. Radius 12px cards, 999px chips.
Layout: 1200px max, 16px gutter, card grid `minmax(320px, 1fr)`, one column under 520px where
filter rows scroll horizontally and the toolbar stops being sticky; *Start here* is 4 → 2 columns.

## Thumbnails

28 original SVG illustrations in `public/gallery/` (320×180, brand palette, each with a `<title>`,
no scripts, images or external references), lazy-loaded. Drawn for this gallery; no screenshots,
engine/paper artwork, external images or generated imagery. They were produced once by a scratch
script and are committed as static files; edit them directly.

## Verification and limits

Worker verification: eight focused gallery tests, typecheck and site build passed. Lead review
corrected comparison-family links that selected a different size (all27 cases now have exact links),
moved filters above featured content, aligned featured heights and clarified runtime copy.

Lead `pnpm check` passes:331CPU +260actual DawnGPU tests, zero failures/skips, typecheck and both
builds. Actual adapter preflight: Apple M4 Max, Metal3, fallback=false, macOS26.6.2. Full GPU gate
~54.6s was the largest check cost; run once on Nov9, reuse its unchanged physics evidence.

Real static-gallery browser workflow:28cards/7groups, search `impact-1000` selects that exact case;
empty query result, Escape, combined IncludesRapier+Playable filter, Clear→search focus and `/`
shortcut work. All28SVGs+favicon return200. No canvas or Three/Rapier/WASM/solver resource loads.
Phone390×844, DPR2, dark mode: single card column, horizontal filter rows, no document overflow;
keyboard focus ring visible. Desktop light page and Paper reference inspected; final screenshot
capture extent is separately recorded in the receipt (host screenshot clipping is not layout overflow).
This did not open/run a physics scene or establish any new performance/physical/human acceptance.

No installations, CI changes or production deployment are part of local visual acceptance.
Current source/ticket/head/PR evidence is in the lead receipt; update this reference alongside
relevant gallery/catalog/token changes, without blanket regeneration or a new CI gate.
