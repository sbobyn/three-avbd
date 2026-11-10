# Setup, saved work and updates

## Source checkout

The normal development path is the README's Git clone → frozen install → `pnpm dev`.
Use Node 22.18+ and pnpm 10.18.0; actual November verification used Node 25.2.1,
npm 11.6.2 and pnpm 10.18.0 on macOS/M4 Max. Minimum-runtime and other-OS installs
have not been separately verified. Vite 8.3.6 is the current working dependency;
Three 0.187.0 was tested (declared peer range >=0.186.0 is broader than the tested matrix).

The prepared `review-20261106-1` snapshot includes the standalone consumer below.
Local documentation revisions made after freezing it are not present in that archive.
The repository includes the standalone example and the newer setup guides. For the exact
frozen candidate, extract its supplied source archive into your chosen folder and use
its own README; the source checkout can also follow the recipe below. [Candidate evidence and outstanding work](REVIEW_20261106.md).
No bare Git dependency is supported without building: compiled exports are not committed.

## Fresh Three.js consumer

The 0.4 candidate is not published, and a bare Git dependency (`github:sbobyn/three-avbd`) installs
source without the compiled `build/` that every export points to, so imports fail. Build and pack
the exact local source instead (no publication). From your source checkout after
`pnpm install --frozen-lockfile`, or from an extracted snapshot after the same install:

```sh
pnpm build:lib
npm pack --ignore-scripts
# Produces three-avbd-0.4.0.tgz in this source directory (untracked; do not commit it).
export AVBD_SOURCE="$PWD"
```

`build:lib` replaces the ignored `build/` folder. `npm pack --ignore-scripts` creates a local
archive without running pack lifecycle hooks; it does not publish or run the verification gate.
The `prepublishOnly` gate runs on `npm publish`. The tarball exposes five entry points: `three-avbd`,
`/advanced`, `/sdf`, `/queries` and `/pool`. Its version stays `0.4.0` for every local build,
so keep your tarball's SHA-256 (`shasum -a 256`) with it to tell builds apart.
Registry 0.3.0 (last recorded November 10) lacks `/sdf` and other 0.4 APIs.

In the same terminal, create a **new empty directory of your choice**, outside any existing
project. Replace the example path before running it. Keep `AVBD_SOURCE` pointing at the snapshot:

```sh
mkdir /path/you/choose/avbd-first-scene
cd /path/you/choose/avbd-first-scene
npm init -y
npm install --save-exact "$AVBD_SOURCE/three-avbd-0.4.0.tgz" three@0.187.0
npm install --save-dev --save-exact vite@8.3.6
cp "$AVBD_SOURCE/examples/fresh-project/index.html" ./index.html
cp "$AVBD_SOURCE/examples/fresh-project/main.js" ./main.js
npx vite --host 127.0.0.1 --port 5319 --strictPort
```

Open **http://127.0.0.1:5319** (use a free port if occupied). This is an independent consumer,
not a source alias or symlink. [main.js](../examples/fresh-project/main.js) contains the complete
scene, camera, lights, error handling and resize loop. `npx vite build` validates its production
bundle. The local tarball deliberately contains the built library, not the demo site; keep this
source snapshot for its README, examples and documentation. A bare Git dependency is not the
recommended installation: build output is not committed and no prepare hook builds it.


## Configuration and storage

| Setting/data | Where it lives | Apply/restart behavior |
| --- | --- | --- |
| Physics timestep, gravity, iterations, body/material/interaction choices | Your consumer source and authored scene data; `World` options/methods | Edit source; Vite reload recreates this example's world |
| Port/host | Vite startup arguments; default 127.0.0.1:5317 | Restart server; changing port changes browser storage origin |
| Showcase calibration/build estimates/panel collapse | Browser localStorage, keyed by demo/device | UI remeasurement supported; browser-local preferences, not scene backups |
| Pasted benchmark reports | Results page localStorage | Same browser/profile/origin only; private storage may not persist |
| SDF timing capture | Page memory until explicitly saved as JSON | Download before reset/reload/close; JSON contains timings/context, not an editable world |
| Consumer implementation and dependency versions | Your new project files plus package.json/package-lock.json | Save files; restart server to reopen; lockfile pins the installed tarball |

No API key, provider, account, `.env` or paid service is required. Installation uses the package
registry; demos fetch their own assets. No model download or hosted inference is part of this path.
Normal physical choices belong in consumer code, not environment flags or a new settings service.
Do not store credentials in demo browser storage. There is no application-managed world save/load,
autosave, checkpoint restore or portable scene format promised by this library.

## Keep and reopen your first result

Save `main.js`, `index.html`, package.json and package-lock.json in your consumer. Keep the exact
local AVBD tarball accessible too: the lockfile can refer to that local path. Stop your server with
Ctrl-C, reopen a terminal in the same consumer and run the documented `npx vite` command again.
The scene is reconstructed from code; transient physics state and camera movement are not restored.
The November 6 initial install/build/runtime was tested (a dated record, not a claim about today's `main`); [November 7 bounded source/input recovery](REVIEW_20261107.md) now passes in a separate copy. A browser-origin preference backup and cross-version update/rollback are still unverified.

For a portable copy, copy those source/configuration files and the exact tarball together, avoiding
node_modules/dist caches. Reinstall from that tarball in a **new** directory, update its local dependency
path if necessary, and build/run. Keep originals until the copy works. A source hash inventory does not
back up your consumer or browser storage. Export any desired timing JSON separately before closing.
Browser reports/preferences do not migrate automatically between localhost and 127.0.0.1, ports,
profiles or devices. Recovering an arbitrary live World is unsupported; author serialization in your
consumer only if needed and treat it as a separate feature/format contract.

## Deliberate updates

For an unmodified Git checkout, stop your own dev server, then from the source root:

```sh
git pull
pnpm install --frozen-lockfile
pnpm dev
```

This is the ordinary development update path, not an immutable release channel. It was source-checked,
not executed against your checkout. Read [0.4 migration notes](RELEASE_0.4.md) before moving from 0.3.
For a packed consumer, build/pack the chosen new source as above, install that specific tarball and keep
the changed lockfile. A candidate semver alone cannot distinguish local builds; retain its manifest/hash.
There is no background updater or version notification service.

If you changed source locally, preserve a copy of your files, untracked data and exact old package
before updating. Resolve Git conflicts deliberately; don't reset/stash/discard changes just to follow
these instructions. For rollback, restore a **separate copy** of the old source plus matching package,
lockfile and authored inputs. Verify it before changing your working copy. Browser-only preferences
are separate and live GPU state cannot be rolled back. No cross-version saved-world compatibility
is asserted. Never overwrite a personal installation as part of an agent update.

## Verification and troubleshooting

[Review evidence](REVIEW_20261106.md) records exact build/device and exclusions.
`pnpm check` is the maintainer gate (typecheck, CPU/GPU tests and both builds), not required to
try a demo. Verify the actual hardware adapter before expensive GPU tests/benchmarks; no silent
software-rendering performance claims. [Troubleshooting](USER_GUIDE.md#troubleshooting-and-updates)
covers ports, module exports, device limits and unstable/slow scenes.


### Local overnight overlay — 2026-11-07

The standalone example now displays constructor/initialization failures including non-Error
rejections, and disposes its own failed-start resources. `World.create` retains caller ownership
and the original initialization rejection as `Error.cause`; use its WebGPU/localhost/HTTPS guidance
without discarding authored source. The loop uses zero elapsed time on start/resume, a bounded
nonnegative delta thereafter, and a current DPR capped at 2 on resize. No automatic reload/reset
is used to recover. Device-free fixtures cover failure/time/handle-preservation behavior; the
new overlay subsequently passed bounded browser/basic and packed-SDF hardware checks; see [November 7 evidence](REVIEW_20261107.md). Real context-loss injection remains unverified. It is not part of the frozen review-20261106-1.
