# Gallery and demo UI audit — round 1 (2026-11-09)

Read-only UI audit of the demo gallery and every public page, for the Three AVBD lead to adjudicate.
Nothing here is implemented, approved or release acceptance. No simulation speed or physical quality
was rated.

| | |
|---|---|
| Source | branch `feat/ste-3288-demo-gallery-20261109`, HEAD `da7c6197189ae69f1970b2381219e594ea50d801`, base main `34a8f78a1da40a69ed839bec09e44c32e6194490` (PR 79) |
| Overlay | clean before and after; the only write is this file (untracked, local-only) |
| When | 2026-11-09, about 13:05–14:25 MST (browser pass 21:12–21:25Z) |
| Scope | UI, panels, controls, style, navigation and labels of every Vite entry plus the gallery catalog |
| Auditor | one temporary audit worker; no delegation, no implementation, no Git delivery |

**Next action for the lead:** assign Lane A first (G-01, G-02, G-06, G-07, G-08): it fixes the two
public-facing confirmed defects and the honesty labels with static HTML/CSS/catalog edits only, and
it does not overlap the other two lanes.

## What was and was not checked

**Hardware preflight (before any scene), in this worker's own preview tab:** WebGL
`ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Max)`; WebGPU adapter `apple` / `metal-3`,
`isFallbackAdapter: false`, timestamp-query present; DPR 2, 1280×800, Chrome 152 (Electron 44).
The 3D viewer reported `renderer.isWebGPU: true` with `GpuSim3D`; the interlocking pages reported
`Graphics: apple metal-3`. No software renderer was used or accepted.

**Auto-calibration was not triggered.** `localStorage` on `localhost:5318` already held
`avbd-device-budget-3d-v2` and `-2d-v2` for `apple · metal-3`, so the viewers skipped the
first-visit GPU probe. Nothing was written to storage by this audit.

**Missing capability: no screenshots or accessibility tree.** `preview_snapshot` failed twice with
`Preview automation snapshot timed out after 15000ms` (with and without an image; the tab reported
`visible: false` throughout). Every browser observation below is a DOM/computed-style measurement
through `preview_evaluate`, not a visual review. Pixel-level appearance (illustrations, colour
rendering, canvas contents, overlap of floating panels) is **not reviewed**. The final desktop
gallery capture remains unknown, as it was for the lead.

**Not run:** `pnpm check`, CPU/GPU tests, typecheck, builds, benchmarks, any `Run`/`Measure` button,
any scene above 211 bodies, phone or dark-mode re-check (the lead's 390 px dark check is reused),
touch input, a browser without WebGPU, the Vercel preview (login-protected).

### Coverage

"Observed" means loaded in the browser and measured through the DOM; scenes were paused or tiny.

| Route / family | UI source | Evidence | Shared, conditional and omitted parts |
|---|---|---|---|
| `/examples/` gallery (28 cards, 7 groups) | `examples/index.html`, `src/gallery/{main,catalog,filter}.ts`, `gallery.css` | Observed 1280×800 light; source | Search/filter behaviour reused from the lead's checks. Dark and 390 px not repeated |
| `/` 3D viewer, 29 listed scenes | `index.html`, `src/app3d/main.ts`, `scene-extras.ts`, `src/ui/*` | Observed `?scene=Pyramid&paused` (137 bodies): dock, both popovers, Advanced, Cannonball panel, Solver switch, Restart | One shared UI. 17 scenes have a panel, read in source only apart from Pyramid's: Smash ×4, Cannonball-only ×4, Welded wall, Chain mail, Plastic beam, Mass ratio, Ragdolls, Mona Lisa, Starry Night, Custom, Rope. Flag has only the wind dial; 11 scenes have no panel. GPU-only and heavy scenes not opened |
| `/2d.html` 2D viewer, 29 listed scenes | `2d.html`, `src/app2d/main.ts`, `src/ui/*` | Observed `?scene=Pyramid&paused` (211 bodies, CPU reference) | One shared UI; only `Custom` has a panel (source only) |
| `/sdf.html` playground, 3 presets | `sdf.html`, `src/sdf-showcase/{main,performance}.ts`, `style.css` | Observed default Rings, paused (12 bodies) | Presets share one panel. `?qualify=1` mode and Measure not run |
| `/sdf-gears.html` | `sdf-gears.html`, `src/sdf-gears/{main,model}.ts`, `style.css` | Observed (4 bodies; autoplays, paused after about a second) | Single scene |
| `/sdf-released.html`, 11 scenes | `sdf-released.html`, `src/sdf-released/main.ts`, both style sheets | Observed scene 0 Box Stack, paused | Scenes share one panel; scenes 1–10, Reference comparison and Measure source only |
| `/examples/interlocking-{rapier,avbd}.html` | both HTML files, `examples/interlocking-view.ts`, `headless.css` | Both observed, paused; Push and Reset exercised on AVBD | One shared view; `pieces` select is live on Rapier, disabled on AVBD |
| `/examples/basic.html` | `basic.html`, `basic.ts` | Observed (147 bodies) | — |
| `/examples/body-lifecycle.html`, `body-pool.html` | HTML, `run-headless.ts`, `headless.css` | Lifecycle observed; pool source only (same shell) | — |
| `/examples/sdf-{gear,hollow,from-mesh}.html` | HTML, the three `.ts`, `example.css` | Hollow observed; gear and from-mesh source only (same shell) | — |
| `examples/fresh-project/` | `index.html`, `main.js` | Source only: not a Vite entry, runs only in a copied project | — |
| `/compare-side.html`, 27 cases | `compare-side.html`, `src/comparison/{side,side-model}.ts` | Observed `?scene=free-fall&paused=1` (1 body) | One UI; scale menu is conditional per family. Cases of 1k bodies and up not opened |
| `/compare.html` | `compare.html`, `src/comparison/main.ts` | Source only | Manual-run measurement page; opening it adds nothing the HTML does not show |
| `/compare-frame.html` (internal helper) | `compare-frame.html`, `src/comparison/frame.ts` | Source only | Classified correctly: linked only from the side-by-side card |
| `/results.html` | `results.html`, `src/results/main.ts` | Source only | Dense report; time bound |
| `/bench.html`, `/bench3d.html` | both HTML, `src/bench{2d,3d}/main.ts` | Source only | Manual-run benchmarks, deliberately not opened |

All 20 Vite inputs in `vite.config.ts` and all 28 catalog entries are accounted for above.

**Count discrepancy to reconcile:** the brief cites 31 listed 3D and 40 listed 2D scenes. The
browser showed 29 in each viewer menu (3D: 9+2+4+5+8+1; 2D: 6+11+6+5+1), and the gallery rendered
85 linked chips = 29 + 29 + 27 comparison cases. The cause of the difference was not investigated.

## Findings

Severity is for a public visitor. **Status** is one of: implementable, evidence-gated, hypothesis,
large proposal, taste. "Observed" findings were seen in the browser; "source" findings were traced
in code but their trigger was not reproduced.

### Confirmed defects

**G-01 · Medium-high · implementable · Lane A — The featured "Write your own" page has no chrome and no error path**
- Where: `examples/basic.html:18-20`, `examples/basic.ts:9,29`; same missing error path in
  `examples/sdf-gear.ts`, `sdf-hollow.ts`, `sdf-from-mesh.ts` (no `catch` in any of them).
- Evidence (observed): `<body>` holds only the script and a canvas; no text, links or buttons.
  It is the fourth *Start here* tile (`catalog.ts:304`).
- Evidence (source, not reproduced): the top-level `await World.create(...)` has no handler, and
  `World.create` throws without WebGPU (`src/lib/world.ts:750,757`). A visitor without WebGPU gets a
  blank dark page; the SDF examples stay on "Starting…" / "Baking…" forever.
- Now: no title, instructions, way back, source link or failure message.
- Proposed: give `basic.html` the existing `.note` card from `examples/example.css` (title, one line
  on orbiting, *Demo gallery* and *Source* links, a status line). Wrap startup in the four examples
  in a `try/catch` that writes the message to the status line, as `examples/fresh-project/main.js:50-58`
  and `run-headless.ts` already do.
- Accept: `basic.html` has an `h1`, a gallery link and a source link; with `navigator.gpu` removed
  the four pages show a readable message. Keep `basic.ts` short enough to stay a copyable example.
- Confidence: high for the missing chrome; high from source for the failure path.

**G-02 · Medium · implementable · Lane A — "Study protocol" link will 404 on the deployed site**
- Where: `examples/interlocking-rapier.html:33`, `examples/interlocking-avbd.html:33`
  (`href="../docs/PAIRED_STUDIES.md"`).
- Evidence: the link returns 200 on the dev server because Vite serves the repository root. The
  build emits only `LICENSE` and `THIRD_PARTY_NOTICES.md` (`vite.config.ts:11-19`) and `dist/` has
  no `docs/`. The deployed 404 itself was not observed (the preview is login-protected).
- Proposed: use the GitHub URL, as `body-lifecycle.html:20` does.
- Accept: no `../docs/` href in any page; extend the link test in `tests/gallery.test.ts` to the
  relative hrefs of the example pages so this cannot recur.

**G-03 · Medium · implementable · Lane B — Changing Solver silently discards edited settings**
- Where: `src/app3d/main.ts:393-397` (`Object.assign(params, defaults())`),
  `src/app2d/main.ts:204-208` (`resetParams()`).
- Evidence (observed, 3D Pyramid): Iterations set to 17 and Gravity to −4; choosing
  *Reference (CPU)* returned them to 10 and −10. Camera was kept. *Restart* kept both.
- Related (source): on a GPU-only scene, choosing *Reference (CPU)* snaps back to WebGPU with no
  message (`app3d/main.ts:182-185`, `app2d/main.ts:105`).
- Proposed: in 3D keep the user's values and apply only the two backend-specific defaults
  (`matchNearest`, `faceBias`). In 2D the two backend families have different defaults on purpose,
  so keep the reset but say so in the row (for example "Solver · resets settings"). Disable the CPU
  option with a short reason on GPU-only scenes.
- Accept: the observed sequence keeps 17 and −4 in 3D; GPU-only scenes show a disabled CPU option.

**G-04 · Medium · implementable · Lane B — No-WebGPU and fallback messages vanish within half a second**
- Where: `src/app2d/main.ts:23-25,108`, `src/app3d/main.ts:188` write to `#hud`; `updateHud`
  (`app2d/main.ts:433-452`, `app3d/main.ts:718-739`) overwrites it every 500 ms. `#hud` is hidden
  below 760 px (`2d.html:24-28`, `index.html:84-87`). The 2D page has no `#no-webgpu` card warning;
  the 3D page does (`index.html:112-115`).
- Evidence: source only (WebGPU was available here).
- Proposed: add the same card warning to `2d.html`, and show the solver-fallback notice in a
  persistent element using the existing `.warning` style.
- Accept: with WebGPU unavailable, both viewers show a lasting message at desktop and phone width.

**G-05 · Medium · implementable · Lane B — Paused state is invisible and Step is buried**
- Where: dock button `app3d/main.ts:379`, `app2d/main.ts:194`; `controls.ts:147` sets
  `aria-pressed` only when a `pressed` callback is given; `ICONS.step` (`controls.ts:39`) is unused;
  *Step once (.)* sits under Settings › Advanced (`app3d/main.ts:411`, `app2d/main.ts:219`).
- Evidence (observed): while paused the HUD read "137 bodies · 120 fps · WebGPU solver" and the
  button had no `aria-pressed`; its label is always "Play / pause (P)". Other pages do better:
  compare-side shows Pause/Step/Reset and "· paused"; the SDF pages show "paused / live".
- Proposed: pass `pressed`, let a dock label be a function ("Play (P)" / "Pause (P)"), append
  "· paused" to the HUD summary, and add a Step dock button (enabled when paused) in both viewers.
- Accept: paused state is readable in text and to assistive tech; one click steps a paused scene.

**G-06 · Medium · implementable · Lane A (pages) and B (viewer cards) — Most pages cannot get back to the gallery**
- Evidence (observed and source): only `index.html:122` and `compare-side.html:23` link to the
  gallery. No gallery link on `2d.html` (links: 3D demo, Paper, Results), `sdf.html`,
  `sdf-gears.html`, `sdf-released.html` (brand and study link both go to `/sdf.html`; no home link,
  no brand mark), `compare.html` ("Back to demo"), `compare-frame.html`, `bench.html` (no nav at
  all), `bench3d.html`, `results.html`, `basic.html`.
- Back-link wording differs: "← All examples" (`body-lifecycle.html:12`), "← Examples"
  (`interlocking-*.html:16`), "All examples" (`sdf-*.html`), "Demo gallery" (index, compare-side),
  while the page calls itself "three-avbd gallery".
- Also: the 2D card's "Results vs the paper" opens the 3D-only results page (`2d.html:48`).
- Proposed: one label, "Demo gallery", linked from every page's existing header, nav or card. No new
  shared header component is needed.
- Accept: every Vite entry except `compare-frame.html` has a "Demo gallery" link (the helper may
  keep linking to its parent); a test can assert it from the built HTML.

**G-07 · Medium · implementable · Lane A — Labels that imply features the library does not have**
- (a) "Soft Body" chips (`catalog.ts:114,121`): the scene is rigid boxes on soft joints
  (`src/avbd3d/ref/scenes.ts:127-141`), not a continuum or FEM soft body.
- (b) "drop ragdolls on cloth" and "Flag in the Wind" (`catalog.ts:125,128`): the cloth is a grid of
  thin rigid plates on ball joints (`src/avbd3d/bench-scenes.ts:324-348,366-410`). `results.html:250`
  already says the paper's cloth is not simulated.
- (c) Gear train "Motor speed" and "Only the gold gear has a motor" (`sdf-gears.html:11,14`): the
  input is a kinematic `moveTo` drive (`src/sdf-gears/model.ts:110-123`). `docs/DEMO_REFERENCES.md`
  says not to imply a motor solver.
- (d) The 2D cards do not say the 2D solver is the reference port and not part of the published
  package (`package.json` exports only `.`, `sdf`, `queries`, `advanced`, `pool`; `src/lib` takes
  only GPU layout constants from `avbd2d`).
- (e) "Opens on the largest scene your GPU can run in real time" (`catalog.ts:91`): the page picks
  one of three fixed scenes (`app3d/main.ts:74`), never larger than 28k.
- (f) The Results card carries the badge "Small scenes: CPU physics available" (`catalog.ts:278`),
  but it is a static report that needs no GPU.
- Proposed: keep upstream scene names. Add a `limits` line to `joints-3d`, `joints-2d`, `paper-3d`
  and the 2D cards; reword (e); add a `none` requirement for (f); change the gear copy to "Drive
  speed" and "Only the gold gear is driven".
- Accept: each claim above is either reworded or carries a visible Limits line; gallery tests pass.

**G-08 · Medium-low · implementable (catalog) / evidence-gated (page guard) · Lane A then C — Heavy comparison chips load and run at once**
- Where: `catalog.ts:219-227` links `rest-grid-10k`, `pile-10k`, `pile-10k-settled`, `ring-9k` and
  `ring-110k` directly. `SIDE_DEFAULTS.paused` is false (`side-model.ts:48-50`); the page marks
  "(heavy)" only inside its own menu (`side.ts:63-73`) and never asks, unlike the 3D viewer's
  `confirmHeavy` (`src/ui/device-budget.ts:126`).
- Evidence: source only; these cases were deliberately not opened, so the cost is unmeasured.
- Proposed: in the catalog, add `&paused=1` (already parsed, `side-model.ts:73`) and a "heavy" mark
  on chips of 10k bodies and up. A page-side "Load heavy scene" step is a separate, optional change.
- Accept: the heavy chips open paused and are visibly marked; exact-case link tests still pass.

### Consistency and smaller defects

**G-09 · Low-medium · implementable · Lane C — Reset means different things**
`sdf-released` Reset and a change of *Contact settings* re-frame the camera (`load()` calls
`frameView()`, `src/sdf-released/main.ts:119,129-130`). The 3D Restart, `sdf.html` Reset, the
interlocking Reset and compare-side Reset (`side.ts:197`) all keep it. Source only (no camera handle
is exposed). Fix: frame only when the scene changes, as `side.ts` does with `fittedScene`.

**G-10 · Low-medium · implementable · Lane B — The 2D viewer has no camera reset**
Observed dock: scene, play/pause, restart, source, settings. 3D also has *Reset the camera*.
Restart keeps the camera (`app2d/main.ts:195`), so after panning away only re-choosing the scene
restores the view. Fix: add the same dock button using `ICONS.focus` and the framing at
`app2d/main.ts:164-165`.

**G-11 · Low-medium · implementable · Lane A (examples) and C (compare) — Default light buttons on dark pages**
Observed: buttons are `rgb(239,239,239)` with black text on `rgb(16,18,22)` on the interlocking and
SDF example pages, and on compare-side; inputs are white. "Drop again" is 81×22 px, below the 24 px
minimum target. Cause: `examples/headless.css`, `example.css` and the inline styles of
`compare-side.html` / `compare-frame.html` set dark backgrounds without `color-scheme: dark` or a
button rule. Fix: add `color-scheme: dark` and one small shared button/select rule.

**G-12 · Low-medium · part implementable, part large proposal · Lanes A and C — Five unrelated visual systems**
Warm paper (viewers, gallery), teal and gold with a headline (SDF pages; the gear page asks for
Inter, which is not loaded), dark blue-link examples, a dark compare page beside an unstyled
`compare.html`, and neutral benchmark pages whose two files differ (`bench.html` is monospace on
`#f4f4f1`; `bench3d.html` is system-ui on `#f6f3ec`). Page titles follow seven patterns.
- Implementable now: one title pattern ("Page · three-avbd"); the brand mark and a home/gallery link
  on every page; `bench.html` adopts `bench3d.html`'s tokens and `nav.site`; the viewers' accent,
  link and focus colours come from one place.
- Smallest mechanism: move the `:root` token blocks of `src/gallery/gallery.css:4-32` into a new
  `src/ui/tokens.css` imported by `gallery.css`, `page.css` and the example style sheets. No new
  framework, font download or dependency. The gallery must still import only gallery/UI CSS; the
  import test at `tests/gallery.test.ts:126-132` needs its pattern widened to allow it.
- Large proposal, not for this round: re-skinning the SDF pages or giving the viewers a dark mode.
- Keep as they are: full-canvas scenes stay dark, headless pages stay text-only, benchmark and
  results pages stay dense tables.

**G-13 · Low · implementable · Lane C — Text at 9–11 px on the SDF pages**
Observed: gear train status, footer and labels 10 px, legend 9 px; `sdf.html` eyebrow 10 px, details
11 px, performance `pre` 10 px. Proposed floor: 12 px for anything a visitor must read (status,
hints, details); uppercase eyebrows may stay at 11 px.

**G-14 · Low · implementable · Lane B — Two cannonball controls with different limits**
Settings › Advanced has radius 0.2–2 and speed 5–80 (`app3d/main.ts:421-423`); the scene panel has
radius 0.2–3 and "Launch speed" 5–100 (`scene-extras.ts:71-73`). Both edit the same state. Fix: one
exported definition, or drop the Advanced copies.

**G-15 · Low · implementable · Lane B — "Reset settings to defaults" resets solver parameters only**
`app3d/main.ts:426`, `app2d/main.ts:235`. Display toggles, cannonball and right-click-box values are
untouched. Fix: rename to "Reset solver settings", or reset everything.

**G-16 · Low · implementable · Lane B — Dock accessibility gaps**
Observed: popovers are `role="dialog"` with no label and receive no focus when opened; the scene and
settings buttons have no `aria-expanded` until first closed and no `aria-haspopup`; the current
scene has no `aria-current`; `#card-toggle` has only a `title`; the build bar is a `progressbar`
with no label. Source: Space is always consumed (`app3d/main.ts:605-612`), so a focused
`role="switch"` cannot be toggled with Space. Sources: `controls.ts:81-82,91-111,191-199,233`,
`title-card.ts:12-16`, `build-progress.ts:40`.

**G-17 · Low · implementable · Lane B — Shortcuts fire with Cmd/Ctrl held**
`app3d/main.ts:613-614`, `app2d/main.ts:347-348`: Cmd+R restarts the scene before reloading and
Ctrl+P toggles pause. Fix: return early when a modifier is held.

**G-18 · Low · implementable / taste · Lane A — Gallery polish**
- Observed: the sticky toolbar is 212 px tall at 1280×800, about a quarter of the viewport. Option:
  keep only the search row sticky. Taste, but measured.
- Observed: three links carry an empty `title=""` (`main.ts:63`); omit it when there is no note.
- *Fresh project setup* shows "See docs/SETUP.md (examples/fresh-project/)" as a command
  (`catalog.ts:273`); it is not one.
- Card titles drift from the viewer menu groups ("Paintings made of blocks" vs "Just for fun",
  "Contacts and stacks" vs "Contacts & friction"). Taste.
- The breadcrumb offers only "← 3D demo".

**G-19 · Low · proposal · Lanes C and A — One comparison case, three names**
The gallery says "Settled box pile · 1k" and "Impact · mass ratio 1000". Observed on compare-side:
"pile-N-settled", "impact-N" with a separate scale menu; `compare.html` lists raw ids
(`comparison/main.ts:9`). Proposed: a small DOM-free label map beside `CASES`, used by both pages,
with a test that the catalog labels match it (the catalog must stay import-free).

**G-20 · Low · implementable · Lane C — Interlocking pages give little feedback**
Observed: *Push lower ring* while paused changes nothing visible, and the status shows no step, time
or paused/live state. The AVBD page shows a permanently disabled "Rapier-only convex pieces" select
(`interlocking-avbd.html:23`). Fix: add "step N · t s · paused" to the status, and replace the
disabled select with one line of text.

**G-21 · Low · implementable · Lane C — "↗" on same-tab internal links, and three names for one page**
`sdf.html:5`, `sdf-gears.html:5`, `sdf-released.html:5`. The released page is called "Reference
scenes", "Collision studies" and "SDF collision studies" in three places.

**G-22 · Low · taste · Lane C — Gear train status is in capitals**
Observed "AUTO · SDF contacts on · 6 points · 117 fps · 0.98× sim" and "PAUSED". Other pages use
sentence case. Autoplay is appropriate here and already honours reduced motion; keep it.

**G-23 · Low · proposal — Heavy-scene prompt is a native `confirm()`**
`src/ui/device-budget.ts:131`, called before first paint for a deep link (`app3d/main.ts:99`). It
works. An in-page panel in the style of `.gpu-lost` would match the rest; not needed this round.

**G-24 · Low · hypothesis, evidence-gated · Lane C — Touch users may be unable to orbit the SDF playground**
The capture-phase `pointerdown` at `src/sdf-showcase/main.ts:149-151` disables OrbitControls for
every primary pointer, and the hint mentions only right-drag (`sdf.html:21`). Needs a touch device
to confirm before any change. The gear train handles touch explicitly (`sdf-gears/main.ts:30`).

**G-25 · Low · implementable · Lane A — Headless output is not announced and cannot be re-run**
`body-lifecycle.html:21`, `body-pool.html:22`: the `pre` has no `role="status"`. Tiny.

## Already correct: do not redo in round 2

- Gallery: 28 cards in 7 groups, no canvas and no GPU request, zero horizontal overflow at 1280,
  equal featured heights (247 px), logical heading order, skip link, live result count, URL state,
  "Illustration" captions, Limits disclosures, and the Rapier-first paired buttons.
- Viewers: 2 px accent focus ring on dock buttons; Escape closes popovers; Restart keeps camera and
  settings; URL carries scene and backend; HUD names the solver ("WebGPU solver" / "CPU solver",
  "Reference (CPU)"); units are shown (m/s², ms, kg, m/s); touch and pointer hints are separate;
  heavy scenes are marked "slow here" / "too heavy here"; device loss has its own panel.
- SDF playground and released studies start paused, disable controls while busy, report
  "paused / live", cancel a capture when the tab hides, and state their limits in place.
- Interlocking pages refuse software and fallback adapters, start paused, keep the camera on Reset,
  and state geometry, sleeping, CCD and restitution differences on the page.
- Compare-side: visible Pause/Step/Reset, per-engine headings "Rapier (WASM, CPU)" and
  "three-avbd (WebGPU)", validity classes, linked cameras, URL state, Defaults.
- Benchmarks and comparisons never start on load; headless pages print a result or a failure.
- `compare-frame.html` is correctly treated as an internal helper.

## Implementation lanes (non-overlapping files)

No claim is made about model availability; the lead assigns.

| Lane | Suggested fit | Findings | Files it may touch | Must not touch |
|---|---|---|---|---|
| **A — Gallery, examples, static chrome** | Sonnet 5.5 High | G-01, G-02, G-06 (static pages), G-07, G-08 (catalog part), G-11 (examples), G-12 (tokens file, titles, `bench.html`), G-18, G-25 | `src/gallery/*`, `examples/*.html`, `examples/*.css`, `examples/{basic,sdf-gear,sdf-hollow,sdf-from-mesh}.ts` (startup error handling only), `bench.html`, `bench3d.html`, `results.html`, `compare.html` (nav line and title only), new `src/ui/tokens.css`, `tests/gallery.test.ts`, `docs/GALLERY_DESIGN.md` | `src/ui/controls.*`, `src/app*`, `src/sdf-*`, `src/comparison/*` |
| **B — Viewer dock and panels** | Opus 5.5 Medium | G-03, G-04, G-05, G-06 (viewer cards), G-10, G-14, G-15, G-16, G-17 | `src/ui/{controls.ts,controls.css,page.css,title-card.ts,build-progress.ts}`, `src/app3d/{main,scene-extras}.ts`, `src/app2d/main.ts`, `index.html`, `2d.html` | everything in Lane A and C |
| **C — SDF pages and comparison tools** | Sonnet 5.5 High | G-06 (SDF headers), G-07c (gear copy), G-09, G-11 (compare pages), G-13, G-19, G-20, G-21, G-22; G-24 only after touch evidence | `sdf.html`, `sdf-gears.html`, `sdf-released.html`, `src/sdf-showcase/{main.ts,style.css}`, `src/sdf-gears/{main.ts,style.css}`, `src/sdf-released/{main.ts,style.css}`, `compare-side.html`, `compare-frame.html`, `src/comparison/{side,side-model,main}.ts`, `examples/interlocking-view.ts`, `examples/interlocking-*.html` (status and select only) | solver, library and scene code |

Shared seams to settle before work starts:
- `page.css` (Lane B) importing `tokens.css` (Lane A): Lane A lands the file first, or Lane B leaves
  the import to a follow-up.
- `examples/interlocking-*.html` is touched by Lane A (G-02 link, back-link label) and Lane C (G-20
  status and select). Give both edits to one lane, or sequence them.
- G-19 needs one exported label map (Lane C) and one test (Lane A).
- G-07c is one line of gear-page copy; it sits in Lane C because that lane owns the file.

Focused checks for every lane: `tests/gallery.test.ts`, typecheck and the site build. Lane B also
needs a short real-browser pass on one small paused scene per viewer (hardware verified first). No
lane needs the full GPU suite unless it touches solver or library code, which none should.

## Non-goals

No new UI framework, font download or dependency. No redesign of the Paper reference. No renaming
of upstream scene names. No forcing full-canvas scenes, headless output or dense benchmark tables
into the gallery's card style. No change to solver, library, scene physics, thumbnails, CI or
deployment. No performance or physical-quality claim follows from this audit.
