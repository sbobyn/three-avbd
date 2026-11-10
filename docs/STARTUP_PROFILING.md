# Startup, reload and reset profiling: specification (STE-3003)

Status: **specification only, 2026-11-10**. Nothing here has been measured. Source read at
`e3552bb` (branch `night/ste-3003-startup-20261110`); installed three 0.187.0, webgpu (Dawn
binding) 0.6.1, Node 25.2.1, TypeScript 5.9.3, Vite 8.3.6.

Scope: one tiny scene (the existing interlocking AVBD SDF study), a diagnostic probe, and the
acceptance rules any pipeline reuse must meet *before* it is written. Not a benchmark, not a
new demo, no gallery card, no CI gate, no cache framework, no persistent format.

Prior observation, kept only as a reason to measure: a private native-Dawn run (one box, one
step, three Worlds on one device, M4 Max / Metal, non-fallback) saw `World.create` drop from
about 189 ms to about 1.3 ms on the second and third World. It was native, not a browser, no
cache was cleared, and it proves neither a browser cache hit nor a benefit from an app cache.
It rejects unmeasured "we should cache pipelines" claims. It is not evidence for this document.

## 1. What the source does today

| Step | Where | Calls |
|---|---|---|
| Solver pipelines | `GpuSolver3D.createPipelines`, `src/avbd3d/gpu/solver.ts:852` | 6 modules, synchronous `createComputePipeline`, explicit layouts from `createLayouts` (`:827`); stored in the per-solver `pipes` dictionary |
| Lazy hull narrowphase | `acquireHull`, `solver.ts:1278` | `contactShaders.make(contactsHullWGSL)` **overwrites** `pipes.hashInsert/narrowphase/reuseManifolds` on the first hull |
| Custom shaders | `GpuSolverOptions.shaders`, `solver.ts:256`, `:864`–`:868` | replaces contacts/solve WGSL, drops `reuseManifolds`/`primalSparse` |
| Layout variant | `createLayouts`, `solver.ts:840` | contacts layout has one extra binding when `this.hulls` |
| World helpers | `World` constructor, `src/lib/world.ts:710` | `Pusher` always (`push.ts:87`, `layout:'auto'`); `Raycaster`, `BodyMover`, `BodyReset`, `ContactWatch` at create only for fixed storage (`world.ts:726`) |
| SDF narrowphase | `SdfNarrowphasePass.create`, `sdf-pass.ts:44` | 2 modules, `getCompilationInfo`, 2–4 `createComputePipelineAsync`, all `layout:'auto'`, each awaited in turn; WGSL generated from `maxPoints`, `seedStride`, `parallelSupports`, a device limit |
| SDF bridge | `SdfCollisionBridge.create`, `sdf-bridge.ts:55` | 4 modules, 4 `createComputePipelineAsync` (`layout:'auto'`), awaited in turn (`:78`–`:81`) |
| SDF broadphase | `SdfSpatialBroadphase.create`, `sdf-broadphase.ts:46` | 1 module, explicit layout, 4 `createComputePipelineAsync` awaited in a loop (`:54`) |
| SDF growth | `SdfCollisionBridge.grown`, `sdf-bridge.ts:193` | reuses the bridge's four pipelines; `sdf.resized`/`spatial.resized` not read here |
| Study reset | `createStudySlot.reset`, `examples/interlocking-rapier-lifecycle.ts:49`; `createAvbdInterlocking`, `src/comparison/interlocking-avbd.ts:44` | dispose, then a new `World` and a new SDF bridge on the same device: every call above repeats |
| Render pipelines | three `WebGPUPipelineUtils.js:262` | synchronous `createRenderPipeline` at first `render()`; `:291` async only through `compileAsync` |

The earlier count of 11 modules and 40 compute-pipeline calls per World was not re-derived
here. The probe's counters replace it for each configuration.

Facts that bound every conclusion:

- A full reload or new page navigation creates a new device for this probe; no application
  pipeline handle survives it. Browser/driver reuse of compiled GPU artifacts is opaque.
  Faster loading can also reflect asset, JavaScript and system work; do not attribute it all
  to shader caching. A back/forward-cache restoration is a different lifecycle and is not tested here.
- HTTP caching of JS/WGSL text is not compiled-pipeline caching.
- `createComputePipeline` returns before compilation is necessarily finished; the cost may land
  at first use. `createComputePipelineAsync` and three's `compileAsync` move that work earlier.
  They do not remove it.
- With `layout:'auto'`, bind groups made from `pipeline.getBindGroupLayout()` work only with
  that pipeline object.
- `GPUComputePipeline` has no `destroy()`. `SdfNarrowphasePass.destroy` (`sdf-pass.ts:185`) and
  `SdfCollisionBridge.destroy` (`sdf-bridge.ts:223`) free buffers only.

The last three bullets are from the WebGPU specification and MDN as recalled, with no network
lookup in this task. Check them against https://www.w3.org/TR/webgpu/ (pipeline creation,
default pipeline layout, `GPUPipelineError`, `device.lost`) before quoting them elsewhere.

## 2. Probe: files and interfaces

Slice 1 changes no library runtime file, no existing page and no default.

| File | Content |
|---|---|
| `src/comparison/startup-profile.ts` (new) | Device-free core: schema constant, `unavailable(reason)`, `instrumentDevice`, `profileCycle`, `validateStartupReport` |
| `scripts/startup-profile.ts` (new) | Node + Dawn runner, modelled on `scripts/interlocking-trial.ts` (adapter refusal via `assessAdapter`, `gitProvenance`, `--json` with `wx`, never overwrite, same exit codes) |
| `examples/startup-profile.html`, `examples/startup-profile.ts` (new) | Browser page: same device → renderer → model order as `examples/interlocking-view.ts:62`–`:95`, same four meshes and two lights, fixed canvas |
| `tests/startup-profile.test.ts` (new) | CPU fixtures, section 6 |
| `docs/API.md` | One line in the examples/scripts map |

The page must **not** be added to `vite.config.ts` inputs. `tests/gallery.test.ts:61` requires
every build input to be linked from the gallery, and the gallery (STE-3288) stays separate. The
page is therefore served by a Vite dev server only, and its asset timings are labelled as such.

```ts
export const STARTUP_SCHEMA = 'three-avbd/startup-profile/v1';
export type Unavailable = { value: null; reason: string };
export type Ms = { value: number } | Unavailable;           // never 0 for "not measured"

export interface DeviceCalls {                              // one per window, or Unavailable
  shaderModules: number;
  computePipelinesSync: number;   computePipelinesAsync: number;
  renderPipelinesSync: number;    renderPipelinesAsync: number;
  bindGroupLayouts: number;       pipelineLayouts: number;   autoLayoutPipelines: number;
  syncPipelineCallWallMs: number;        // main-thread time inside the calls; NOT compile time
  asyncRequestToSettleMs: number[];      // raw, one per async request, in request order
  asyncRejected: number;  maxAsyncInFlight: number;
  distinctModuleSources: number;  distinctPipelineKeys: number;  // computed after the window closes
  buffersCreated: number; bufferBytesCreated: number;
  queueWrites: number;    queueWriteBytes: number;
}
export function instrumentDevice(device: GPUDevice, now: () => number):
  { window(name: string): { end(): DeviceCalls }; restore(): void };
```

`instrumentDevice` shadows the creation methods (and `queue.writeBuffer`) with configurable own
properties that call the originals with the real `this`. `restore()` deletes them. It never
wraps the device in a `Proxy`: the same object goes to `World` and to three. If shadowing throws
(a sealed native object), the report carries `deviceCalls: unavailable('…')` and the timed
windows still run. Source strings are kept by reference inside a window and compared after it
closes, so comparison cost stays out of the timings. `?instrument=0` / `--no-instrument` skips
shadowing; one sequence in each mode shows whether the wrapper distorts the windows.

## 3. Phases and timer boundaries

Clock: `performance.now()`, raw values, no rounding. The report records `crossOriginIsolated`
and the smallest non-zero difference seen as `observedTimerStepMs`.

| Phase | Start → end | Notes and known overlap |
|---|---|---|
| `navigation` | `PerformanceNavigationTiming`: `type`, `responseEnd`, `domContentLoadedEventEnd` | browser only |
| `assets` | every `PerformanceResourceTiming` entry: name, `startTime`, `duration`, `transferSize`, `encodedBodySize` | raw list; HTTP cache only; dev-server module graph is not representative |
| `adapter` | `requestAdapter()` call → resolve | |
| `device` | `requestDevice()` call → resolve | |
| `rendererInit` | `new WebGPURenderer({ device })` → `await renderer.init()` | browser only; context and three setup are not separable |
| `modelImport` | `import('../src/comparison/interlocking-avbd.ts')` → resolve | cycle 0 only |
| `seeds` | `metadata.setupMs.seeds` (`interlocking-avbd.ts:49`) | CPU |
| `worldCreate` | `metadata.setupMs.worldCreate` (`:52`) | the solver's and Pusher's module and synchronous pipeline *requests*; compile may be deferred |
| `sdfEnable` | `metadata.setupMs.sdfEnable` (`:62`) | lazy imports of `sdf-bridge`/`sdf-broadphase` (`world.ts:882`), atlas packing, `getCompilationInfo`, async pipeline completion, buffer creation and uploads, all inside one window |
| `sdfAtlasPackReplay` | `packSdfAtlas` (`sdf-layout.ts:31`) on the plan's fields, run **after** the cycle | a CPU replay, flagged `replay: true`; the in-window share is `unavailable` |
| `setupDrain` | after `sdfEnable` → `queue.onSubmittedWorkDone()` | uploads and creation work still queued |
| `stepEncode[i]` | `model.step()` call → return, i = 1..3 | main-thread encode and submit, plus first-use bind groups |
| `stepDrain[i]` | that return → `onSubmittedWorkDone()` | deferred pipeline compilation can land here; not equal to GPU execution time |
| `read[i]` | `model.readPoses()` call → resolve, after `stepDrain[i]` | copy and `mapAsync` |
| `renderCall` | first `renderer.render(scene, camera)` call → return | browser, cycle 0; render-pipeline requests |
| `renderDrain` | that return → `onSubmittedWorkDone()` | |
| `nextFrame` | that return → next `requestAnimationFrame` callback | approximation of presentation; `unavailable` in Node |
| `dispose` | `model.dispose()` call → return | every cycle, always attempted |
| `cycleWall` | cycle start → `read[1]` resolved | the only end-to-end figure; measured directly |

Rules:

- Phases overlap (queue work, deferred compilation, lazy imports). The report has **no** summed
  total and no "compile time" field. `cycleWall` is measured, never added up.
- `stepEncode` and `stepDrain` are different things. Neither equals pipeline completion.
- A field that cannot be measured is `{ value: null, reason }`. `0` means a measured zero.
- Each window carries its own `DeviceCalls`.
- A failed phase records `{ phase, message }` (through `sanitizeMessage`), later phases are
  `unavailable('not reached')`, `dispose` is still attempted, and the report is still emitted
  with `status: 'failed'`.

## 4. Report schema

```ts
interface StartupReport {
  schema: typeof STARTUP_SCHEMA;
  status: 'completed' | 'failed' | 'refused';
  diagnostic: true; benchmark: false;
  observedAt: string;                                   // ISO
  source: { package: { name: string; version: string }; git: GitProvenance;   // head, dirty, changes
            declaredDependencies: Record<string, string | null> };            // three, webgpu, typescript, vite
  environment: {
    host: 'browser' | 'node-dawn';
    userAgent: string | null; userAgentData: object | Unavailable;            // brands, platform
    runtime: string | null; platform: string | null; cpu: string | null;      // Node
    adapter: AdapterRecord;                // vendor, architecture, device, description, fallback
    backend: string | Unavailable;         // browsers do not expose Metal/D3D/Vulkan: operator note
    limits: Record<string, number>;        // the three raised limits
    viewport: { cssWidth: number; cssHeight: number; devicePixelRatio: number;
                rendererPixelRatio: number; canvasWidth: number; canvasHeight: number } | Unavailable;
    visibility: { atStart: string; changed: boolean } | Unavailable;
    crossOriginIsolated: boolean | null; observedTimerStepMs: number | null;
    serving: 'vite-dev' | 'node' | 'other';
  };
  settings: { scene: 'interlocking-avbd'; dt: number; iterations: number; maxBodies: 4;
              ringSeedCandidates: number; collisionParams: object; sdfCapacity: number;
              cycles: number; stepsPerCycle: 3; instrument: boolean };
  run: { label: string;                    // operator supplied: nav1, reload1, …
         navigationType: string | null;    // navigate | reload | back_forward
         loadIndexInTab: number | null;    // sessionStorage counter
         orderInSequence: number | null; operatorNote: string | null;
         cacheState: 'unknown' };          // always; hits are never inferred
  cycles: Array<{ index: number; kind: 'first-on-device' | 'same-device-recreate';
                  phases: Record<string, Ms | Ms[]>;
                  deviceCalls: Record<string, DeviceCalls | Unavailable>;
                  poseStep: number | null; error?: { phase: string; message: string } }>;
  uncapturedGpuErrors: string[]; deviceLost: string | null;
  limits: string[];                        // fixed caveat text from this document
}
```

Scene settings are read from the model (`INTERLOCKING`, `metadata`), not retyped. The probe sets
no physics parameter.

## 5. Run protocol

Fixed for every run: the interlocking AVBD scene as authored; `{ device }` World; four cycles on
one device (cycle 0, then three dispose-and-recreate cycles); three steps per cycle; no push.
Browser page: canvas 960×540 CSS px, `renderer.setPixelRatio(1)`, `antialias: true`,
`window.devicePixelRatio` recorded. The page refuses a missing, fallback or software adapter
with the test at `interlocking-view.ts:66` and refuses three's WebGL fallback (`:82`). A run
whose tab was hidden at any time is kept and marked `visibility.changed`.

Never: clear a cache or site data, change a browser flag, use a software adapter, stop or
restart the user's browser, or reuse port 5317/5318.

**Node sequence** (three separate processes, each a new device):

    node --experimental-transform-types --no-warnings scripts/startup-profile.ts --cycles 4 --json <new file>

**Browser sequence**, one foreground tab, DevTools closed, isolated dev server on its own port:

1. New tab, navigate to `/examples/startup-profile.html?label=nav1`.
2. Reload: `reload1`. Reload again: `reload2`.
3. Close the tab, open a new one, navigate: `nav2`.
4. Only with Steven's approval and an isolated browser instance: quit, relaunch, navigate:
   `relaunch1`. Otherwise this run is absent and the write-up says so.

Each load yields one report (a download button and `window.__startupProfile`). Run the sequence
three times. Keep every report, failures included, as new files under
`docs/measurements/startup-profile-2026-11-10/`.

What the labels can support: `nav1` is "first load in this tab, cache state unknown", not
"cold". Reload and revisit differences are described as observed differences with an unknown
cause. Same-device cycles 1–3 against cycle 0 is the only comparison where the app's own
behaviour is isolated.

## 6. CPU fixtures for the probe (`tests/startup-profile.test.ts`)

Fake device and a scripted clock; no GPU.

1. `instrumentDevice` counts each creation kind, classifies `layout:'auto'`, records the async
   settle intervals in request order and `maxAsyncInFlight` for overlapping and serial promises.
2. A rejected async request is counted and rethrown unchanged.
3. `restore()` leaves no own properties on the device or queue; calls then reach the originals.
4. `distinctModuleSources`/`distinctPipelineKeys` separate two sources that differ by one
   character and two entry points of one module.
5. A device that refuses shadowing yields `unavailable(reason)` and the cycle still completes.
6. A phase that throws: later phases `unavailable('not reached')`, `dispose` called once, status
   `failed`, message sanitised.
7. `validateStartupReport` rejects `NaN`, a bare `null`, any key named `total`/`compileMs`, and
   a `cacheState` other than `'unknown'`.
8. Cycle kinds are `first-on-device` then `same-device-recreate`; each cycle disposes its own
   model exactly once.

## 7. Hardware observations the parent must make before any optimisation

Smallest real check: one Node sequence and one browser sequence (steps 1–3) on a verified
hardware adapter, with zero uncaptured GPU errors and the three poses read in every cycle.

| # | Observation | Decides |
|---|---|---|
| O1 | Browser, cycles 1–3: `worldCreate`, `stepDrain[1]`, `cycleWall` against cycle 0 | whether same-device reuse of the **synchronous** solver pipelines has anything left to save |
| O2 | Browser, cycles 1–3: `sdfEnable` and its `asyncRequestToSettleMs` | whether same-device reuse of the **async SDF** pipelines has anything to save on reset |
| O3 | Cycle 0: `sdfEnable` against its settle intervals, with `maxAsyncInFlight` (expected 1 from source) | whether issuing the SDF requests concurrently is worth trying |
| O4 | Cycle 0: where first-use cost lands, `worldCreate` call wall or `stepDrain[1]` | whether any prewarm is meaningful, and what it may be called |
| O5 | `nav1` / `reload` / `nav2` `cycleWall` for cycle 0, with `assets` | description only; no app change follows from it |
| O6 | Instrumented against uninstrumented windows | whether the counters can be trusted alongside the timings |

Decision rule accepted by the lead before any browser results: a reuse point is worth
building only if, in the browser, the median over cycles 1–3 of the window it would shorten is
at least 50 ms **and** at least a quarter of that cycle's `cycleWall`, in all three sequences.
The 50 ms and the quarter are engineering prioritisation limits, not physical or measured thresholds. If no window passes, the
deliverable is the probe and a dated results section, with no cache.

## 8. Reuse candidates, in order, each gated on section 7

**C1. Concurrent SDF requests (gate O3). Not a cache.** In `SdfNarrowphasePass.create`,
`SdfCollisionBridge.create` and `SdfSpatialBroadphase.create`, create all modules and issue all
`getCompilationInfo` and `createComputePipelineAsync` requests first, then await them in the
present order so the first reported error is unchanged. Already-async API, no shared state, no
lifetime change. It may be described only as "requests issued concurrently", with the measured
wall difference.

**C2. Per-device SDF pipeline reuse (gate O2).** The narrowest point with a real reset path:
`enableSdfCollisions` is already async and the study recreates its bridge on every reset.

**C3. Per-device synchronous solver pipelines (gate O1).** Expected to fail its gate if the
browser behaves as the native observation did. Do not build it on expectation either way.

Acceptance for C2 or C3, to be met before merge:

- **Key.** The exact `GPUDevice` object (a `WeakMap`), then the full WGSL source string, entry
  point, pipeline constants (sorted, if ever used), and the layout variant: `'auto'`, or the
  ordered binding-type lists of every explicit bind group layout. No hash stands in for the
  source. Labels are not part of the key.
- **Isolation.** The shared value is one immutable pipeline (with its explicit layouts, where it
  has them). Each solver keeps its own `pipes` dictionary and fills it by lookup.
  `acquireHull`'s swap and custom `shaders` change only that solver's dictionary. A custom
  source is simply a different key.
- **Layouts.** An auto-layout pipeline is shared as the same object; each world makes its own
  bind groups from that pipeline's `getBindGroupLayout`. Explicit-layout pipelines are cached
  together with the layout objects each world must use for its bind groups.
- **Never cached.** World state, buffers, bind groups, command encoders, poses, the SDF atlas,
  or any caller-owned resource. `destroy()` paths stay as they are and touch no shared entry.
- **Bounded.** At most 64 entries per device, least recently used dropped. Dropping an entry
  only drops the reference; worlds holding the pipeline are unaffected.
- **Coalescing.** Async entries store the promise: concurrent identical requests share one
  creation. Synchronous lookups never wait on an async entry and never turn a sync constructor
  async; C3 keeps a separate synchronous table.
- **Failure.** A rejected creation, or a module with compilation errors, removes its entry
  before the rejection is delivered. All coalesced waiters get the same error. The next request
  retries.
- **Loss.** `device.lost` drops the device's table through a `WeakRef`, as `world.ts:742` does.
  A destroyed or lost device never yields a cached pipeline to a new World.
- **API.** No public option, no export from `three-avbd/advanced`, no signature change.

CPU fixtures for the reuse helper (fake device, `tests/pipeline-reuse.test.ts`): key separation
on each key part including `hulls` and one-character source differences; two solvers where one
acquires a hull or uses custom shaders and the other's dictionary is unchanged; a rejected
promise then a successful retry, with both coalesced waiters rejected; device loss and a second
device giving distinct pipelines; eviction at the bound while an evicted pipeline stays usable
by its holder; destroying world A twice and then using world B, with no call reaching a shared
object.

Hardware check for C2/C3 (Dawn, added to `tests-gpu/sdf-bridge.gpu.test.ts`): two Worlds with
SDF collisions on one device, destroy the first, step and read the second, no uncaptured error;
then the same with a third World created after the destroy. Then rerun section 5 and report the
same windows before and after.

## 9. Implementation brief

**Opus, one slice.** Build section 2's files with sections 3–6 as acceptance. Checks:
`pnpm typecheck`, `node --experimental-transform-types --test tests/startup-profile.test.ts`,
then `pnpm check` once. No vite input, no gallery link, no library runtime edit, no default
changed. Hand the parent the two commands of section 5. Stop there: C1–C3 start only after the
parent records O1–O6 and the lead applies the decision rule.

**Sonnet, only if the probe yields results.** Add a dated results section to this file from the
saved reports (raw per-run tables, no averages across browsers, failures listed) and the
`docs/FINDINGS.md` entry. No code.

## 10. Unknowns and gates

- Whether Chrome's sync pipeline calls defer compilation on this machine (O4). Unknown until run.
- Whether instance shadowing works on Dawn's and Chrome's `GPUDevice` (fixture 5 covers the
  fallback; hardware decides).
- `SdfNarrowphasePass.resized` and `SdfSpatialBroadphase.resized` were not read; whether growth
  recompiles is unverified.
- Browser and driver compiled-shader caches: lifetime, keying and eviction are not specified by
  WebGPU and are not assumed here.
- The M4 Max is the dev machine. Nothing measured on it transfers to the M1 / GTX 1080 target
  (`AGENTS.md`).
- Gates owned by the lead or Steven: the decision rule's thresholds; step 4 of the browser
  sequence; committing measurement files; any second browser.


## 10. Lead qualification and implementation amendments — 2026-11-10

These corrections take precedence over the initial implementation sketch above. No browser
startup result has been read at this decision point.

- Primary references checked: [WebGPU default pipeline layouts](https://www.w3.org/TR/webgpu/#default-pipeline-layout)
  restrict auto-layout bind-group reuse to the owning pipeline;
  [compute pipelines](https://www.w3.org/TR/webgpu/#gpucomputepipeline) provide no destroy method.
  [MDN createComputePipelineAsync](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createComputePipelineAsync)
  documents readiness without a later compilation stall on fulfillment. These APIs do not
  expose persistent pipeline binaries or browser cache hits. Keep measured call/settle/drain
  intervals distinct.
- Source follow-up: `SdfNarrowphasePass.resized` and `SdfSpatialBroadphase.resized` pass their
  existing pipelines/layout into the replacement buffer-owning object. Capacity growth is not
  evidence of repeated compilation; the reset/recreate path remains the relevant question.
- **Measurement budget:** start with one bounded Node sequence and one browser sequence plus
  an uninstrumented companion. Run three sequences only if a potential reuse window passes
  the predeclared screen or evidence is materially inconsistent. Keep all raw attempts and
  label missing runs. Do not launch/restart a browser or clear site data for a cold-cache claim.
  Optional relaunch is omitted, not an overnight approval request.
- **Instrumentation:** save each original own property descriptor and restore it exactly,
  deleting a shadow only when there was no original. Roll back every installed hook if any
  later hook fails; test partial installation and prior own methods. Interception is confined
  to the newly owned probe device/queue, never a shared user context.
- `createAvbdInterlocking` exposes phase durations, not phase callback boundaries. Without
  adding a hook, call counters can honestly cover the whole model-creation window; per-seed/
  World/SDF counters that cannot be separated are unavailable with a reason. Never reconstruct
  exact subphase counters from guessed timing. No existing model/library edit is needed for
  the first probe. Atlas replay is optional and unavailable when the exact fields cannot be
  reconstructed; it is never called the original in-window cost.
- **Descriptor identity:** the future cache key must include every relevant layout field,
  not only buffer types: binding, visibility, resource kind, type, dynamic-offset flag, minimum
  binding size and other present resource/pipeline constants. Preserve ordered group layout
  structure. An opaque explicit layout must fall back to object identity or refuse reuse;
  serialising a native GPU object as `{}` is never a key. Descriptor/source fingerprints in
  the probe are request-variant diagnostics, not evidence of native compiler cache hits.
- A refused/failed acquisition can have an unavailable adapter/viewport/backend; report it
  rather than fabricating a required adapter record. Preserve unsupported/sealed-device
  reasons and real errors. Full GPU source/descriptor objects remain internal, not report data.
- Resource timings must omit credentials/query tokens and redact Vite `@fs` machine paths.
  Raw GPU traces stay in private lead-owned storage; any versioned summary is sanitised.
- **Isolation:** live5318 serves the original managed worktree and must not receive runtime
  edits or checkout updates. The next worker uses host `isolation:worktree`; saved project
  scripts are empty, so no automatic setup/install runs. It reads/copies this contract into
  its own checkout and writes all implementation there. Parent runs any required short-lived,
  isolated diagnostic server only for the bounded probe, then stops only that owned process;
  no duplicate long-lived app, reused user runtime or source HMR.
- Build/typecheck/focused CPU fixtures first. Reuse valid unrelated evidence. The parent
  decides the one stable project/day full gate after actual hardware preflight; no worker
  starts a broad suite or graphics run automatically. No optimization in the diagnostic slice.

- **C1 screen differs from cache reuse:** concurrent requests target an observed serial async
  window in the first-on-device cycle, even when reset is already fast. Apply the same50ms/25%
  prioritisation screen to that relevant window, not silently to an unrelated reset metric.
  Any concurrency change must attach rejection handlers immediately and preserve ordered
  error reporting/cleanup; awaiting raw rejected promises in sequence can create unhandled
  rejections.
- **Observed device lifetime:** WebGPU exposes no synchronous destroyed-device flag. A future
  cache must invalidate on observed `device.lost` and explicit owned teardown hooks, and never
  treat a cache hit as proof of liveness. Do not claim instantaneous detection of external
  destroy, wrap another caller's destroy method, or swallow normal GPU errors to satisfy a test.

## 11. Slice 1 implementation refinements — 2026-11-10 (worker, CPU-verified only)

Implemented on `e3552bb` in an isolated worktree. Sections 2–6 and the lead amendments of
section 10 are the acceptance; sections 7–8 (decision rule, C1–C3) are unchanged. **No hardware,
browser or rendering run was made in this slice**: every statement below about GPU behaviour is
unverified until the parent runs section 5.

Files: `src/comparison/startup-profile.ts` (core), `scripts/startup-profile.ts` (Node + Dawn),
`examples/startup-profile.html` / `.ts` (dev-only page; not a Vite input, not in the gallery),
`tests/startup-profile.test.ts` (13 CPU fixtures).

Schema refinements against sections 2–4:

- `cycleWall` runs from the model-creation call to `read[1]` resolving. It **excludes**
  `modelImport` (cycle 0 only, its own window) so cycle 0 and cycles 1–3 cover the same work.
- `modelCreate` is a new directly measured phase: the whole `createAvbdInterlocking` call. It is
  the only window with device-call counters for setup; `seeds`/`worldCreate`/`sdfEnable` are the
  model's own `metadata.setupMs` values and their `deviceCalls` are
  `unavailable('no phase hooks …: counters only in aggregate (modelCreate)')`. A missing
  `setupMs` value is `unavailable`, never 0.
- `sdfAtlasPackReplay` is always `unavailable`: the exact `packSdfAtlas` inputs are internal to
  World and were not reconstructed.
- `DeviceCalls` adds `shaderModuleCallWallMs` and `asyncUnsettledAtEnd`;
  `asyncRequestToSettleMs` lists only requests issued in the window that settled before it ended,
  in request order. `maxAsyncInFlight` starts at the number already in flight when the window
  opens. `cycleWall` and `modelCreate` windows overlap, so their counters overlap too.
- `distinctPipelineKeys` is a request-variant diagnostic: plain descriptor data is serialised with
  labels dropped, shader modules map to their source by value (compared only after the window
  closes), and every other object (explicit layouts, modules created outside instrumentation) is
  an opaque per-object identity, never `{}`. It is not a proposed cache key and not a cache hit.
- A failed phase is `unavailable('phase failed: see cycle error')`; its successors
  `unavailable('not reached')`; a failure in the post-drain GPU error check is phase `gpuCheck`.
  Cycles after a failed cycle are listed with every phase unavailable. `disposeError` is recorded
  separately and makes the status `failed`.
- Reports also carry `instrumentation: { requested, available, reason }`,
  `environment.acquisitionMs` (adapter, device, browser `rendererInit`) and, in the browser,
  `environment.rendererInitDeviceCalls`, `navigation` and sanitised `assets`.
- `validateStartupReport` runs before every emit. A report that fails validation is still
  emitted, with `status: 'failed'` and `validationProblems`, never dropped. It rejects non-finite
  numbers, bare `null` phases, `{value, reason}` mixtures, keys named `total*`/`compile*`/`sum*`,
  `cacheState !== 'unknown'`, and strings containing absolute machine paths or unredacted `/@fs/`.

Instrumentation as built: own-property shadows on the probe's device and its queue (no Proxy);
each prior own descriptor is saved and redefined exactly, a shadow with no prior is deleted, and
a failure installing any hook rolls back all earlier hooks and yields
`available: false` with the reason (a frozen device or queue is the fixture). Async wrappers
return the original promise; the observation `.then(ok, fail)` never rejects. One side effect:
attaching that handler marks the original promise as handled, so an application that ignored a
rejected pipeline request would no longer see an unhandled-rejection report while instrumented.
The uninstrumented companion has no such effect.

Known overlap of the `modelImport` window: the core statically imports `interlocking-scene.ts`
and `interlocking-trial.ts` (shared CPU modules), and the browser page statically imports
`three/webgpu`; any of these already loaded are not inside `modelImport`. The Node host has no
rendering: render phases are `unavailable('no renderer in this host')` and `backend`/`viewport`
are unavailable. Dev-server resource names keep only the same-origin path; `@fs` paths become
`/@fs/<path>`, queries/credentials are dropped, cross-origin entries keep only their origin.

Commands for the parent (hardware, isolated port; not run here):

    node --experimental-transform-types --no-warnings scripts/startup-profile.ts --cycles 4 --label node1 --json <new file>
    node --experimental-transform-types --no-warnings scripts/startup-profile.ts --cycles 4 --label node1-noinst --no-instrument --json <new file>
    pnpm exec vite --host 127.0.0.1 --port <isolated port> --strictPort
    → /examples/startup-profile.html?label=nav1   (and ?label=nav1-noinst&instrument=0)

The page shows the report, offers a download and sets `window.__startupProfile`.


## 12. Lead review and first screen — 2026-11-10

The isolated probe was exercised on Apple M4 Max / Metal 3, non-fallback, using the
authored four-body scene only. Node instrumented/companion runs and browser navigation,
two actual reloads, revisit and companion all completed without reported GPU/teardown
errors. Raw reports remain in private lead-owned storage with a source manifest.

Lead regression fixtures first reproduced post-acquisition clock failure bypassing model
disposal and sequence replacement after a throwing dispose. Both are fixed. Synchronous
phase intervals no longer include an artificial await; final report emission follows teardown,
so cleanup/loss errors cannot leave an exported completed status. Original GPU method
descriptors are restored, unknown plain-prototype handles retain opaque identity, and bad
output directories are refused before GPU acquisition. Typecheck and 34 focused CPU tests pass.

The observed same-device reset cycles fail the predeclared 50ms opportunity screen; no
per-device pipeline cache is justified by this tiny workload. First-device SDF-enable time
varied, but this window also contains lazy imports, packing and shader-module compilation-info
awaits. Current counters observe pipeline waits, not compilation-info awaits. This attribution
gap must be measured before deciding C1; the whole SDF-enable interval is never compile time.
The next bounded diagnostic refinement records getCompilationInfo request/settle intervals
without changing its results, callers' promise identity, physics or public API. It is not a cache.

Browser profiles stayed visible and no user data/cache was cleared. QA port5321 was occupied
and left untouched; a short-lived server on5322 was used and stopped, and own tabs closed.
The original live5317/5318 sources/processes remain preserved. No browser restart or production
load-time, target-device, cache-hit or performance-winner claim is made.
