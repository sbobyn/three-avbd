# three-avbd

Augmented Vertex Block Descent ([Giles, Diaz, Yuksel — SIGGRAPH 2025](https://graphics.cs.utah.edu/research/projects/avbd/))
in TypeScript, Three.js and raw WGSL WebGPU compute. The goal is maximum performance on
slightly older hardware (Apple M1, GTX 1080-class laptops).

Status and staged plan: [docs/PLAN.md](docs/PLAN.md). Measured results: [docs/FINDINGS.md](docs/FINDINGS.md).

## Run

```bash
pnpm install
pnpm dev        # 3D: http://127.0.0.1:5317  2D: /2d.html  (?scene=Pyramid, &backend=gpu, &paused)
pnpm check      # typecheck + CPU tests + GPU tests (headless Dawn) + production build
pnpm bench2d    # CPU scaling baseline
pnpm bench2d:gpu # GPU benchmark with per-phase timing (headless)
pnpm bench3d:gpu # 3D GPU benchmark: the paper's large scenes and small ones (args: tiers or case names)
pnpm sweep2d    # iteration count: cost vs quality on the GPU
pnpm scaling2d  # box rain 10k-250k, writes docs/data/scaling2d-<adapter>.json
```

Browser benchmarks for any machine: http://127.0.0.1:5317/bench.html (2D) and
/bench3d.html (3D, including the paper's 110k and 510k scenes). Each runs the GPU suite;
"Copy results" gives JSON to paste back. Keep the tab visible while it runs. Results against
the paper, one column per machine: /results.html (reports in `docs/data/bench3d/`; add one
with bench3d.html's "Download results" or `pnpm bench3d:gpu <tiers> --json <file> --machine <name>`).

2D demo controls: left-drag grabs a body, right-click spawns a box, wheel zooms,
space/shift + drag or middle-drag pans, WASD/QE move the camera, P pauses, `.` steps, R resets.

3D scenes: the 14 demo scenes (CPU reference or WebGPU) plus GPU-only showcase scenes after
the paper's figures: Brick Ring (Fig. 1), Brick Walls (Fig. 3), Wall Smash, Breakable Wall,
Chain Mail, Ragdolls on Cloth (Fig. 14), Heavy Pendulum 50000:1, a Flag in the Wind (the GPU solver's
wind: pressure drag and skin friction on bodies marked as sails), plus scale tests (Jointed Drop,
box piles and columns). How bodies are drawn (capsules, chain-mail rings, cloth sheets, springs as
coils) is cosmetic, tagged by the scenes in `src/avbd3d/visuals.ts`.

3D demo controls: left-drag on a body grabs it (the body under the pointer glows), left-drag
elsewhere orbits, right-drag pans, wheel zooms, Space, B or middle-click fires a cannonball, P
pauses, `.` steps, R resets. The smash, pile and Custom scenes have a panel for the cannonball's
radius, mass and launch speed (also under Settings → Advanced everywhere).

On a device's first visit both demos time a few solver steps off screen (`src/ui/device-budget.ts`)
and remember what the GPU can run: a weaker GPU lands on a smaller scene, scenes that would run
under 60 fps are marked "slow here" and those under 30 fps "too heavy here" (asking before they
load, as Custom builds do past that size), and a GPU reset shows a message instead of a frozen
page. Settings → Advanced measures again. Scenes build behind a progress bar
(`src/ui/build-progress.ts`) whose stages are timed per device.

## Layout

| Path | What |
|---|---|
| `src/avbd2d/ref/` | 2D CPU reference: faithful port of `avbd-demo2d` (the oracle for later solvers) |
| `src/avbd2d/soa/` | GPU-shaped CPU solver: SoA buffers, grid broadphase, colouring, CSR (the GPU's template) |
| `src/avbd2d/gpu/` | WebGPU solver: WGSL kernels (`shaders.ts`), host code, Sim2D adapter |
| `src/avbd2d/sim.ts` | Common `Sim2D` interface over all backends; scene registry |
| `src/app2d/` | 2D demo app: Three.js WebGPU renderer (CPU instancing or zero-copy GPU bodies), GUI, input |
| `src/avbd3d/ref/` | 3D CPU reference: faithful port of `avbd-demo3d` (quaternions, 6x6 LDLᵀ, OBB SAT, cone friction) |
| `src/avbd3d/gpu/` | 3D WebGPU solver: WGSL broadphase, OBB narrowphase, 6-DOF solve; reuses the 2D colouring kernels |
| `src/avbd3d/sim.ts` | `Sim3D` interface the 3D app drives (CPU reference or WebGPU); scene registry |
| `src/avbd3d/bench-scenes.ts`, `shapes.ts` | GPU showcase / benchmark scenes; spheres (GPU-only) |
| `src/avbd3d/bench-cases.ts`, `src/bench3d` | 3D benchmark suite and its browser page (`bench3d.html`) |
| `src/app3d/` | 3D demo app: z-up orbit camera, shadowed boxes (CPU instancing or zero-copy GPU bodies), drag, box shooting |
| `tests/` | `node --test` suites; `fixtures/oracle2d`, `fixtures/oracle3d` hold golden trajectories from the C++ demos |
| `tests-gpu/` | GPU tests on a real device through Dawn (`webgpu` package); skipped without an adapter |
| `tools/cpp-oracle/` | Builds the upstream C++ solver headless (f32 and f64) and regenerates fixtures |

## Credits and licences

This project is MIT-licensed ([LICENSE](LICENSE)).

This is an implementation of *Augmented Vertex Block Descent* (Chris Giles, Elie Diaz, Cem
Yuksel, SIGGRAPH 2025). The CPU reference solvers are TypeScript ports of the authors' demos
([avbd-demo2d](https://github.com/savant117/avbd-demo2d),
[avbd-demo3d](https://github.com/savant117/avbd-demo3d), MIT, © Chris Giles), whose 2D
collision comes from [box2d-lite](https://github.com/erincatto/box2d-lite) (MIT, © Erin Catto).
Their notices, and three.js's, are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the build copies both files into the site.

## Reference sources

`pnpm fetch-reference` clones the upstream demos
([avbd-demo2d](https://github.com/savant117/avbd-demo2d), [avbd-demo3d](https://github.com/savant117/avbd-demo3d),
© Chris Giles) into `reference/` (git-ignored). Then `tools/cpp-oracle/build.sh` and
`tools/cpp-oracle/gen2d.sh` / `gen3d.sh` rebuild the oracles and regenerate the fixtures.
