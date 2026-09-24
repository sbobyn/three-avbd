# three-avbd

Augmented Vertex Block Descent ([Giles, Diaz, Yuksel — SIGGRAPH 2025](https://graphics.cs.utah.edu/research/projects/avbd/))
in TypeScript, Three.js and raw WGSL WebGPU compute. The goal is maximum performance on
slightly older hardware (Apple M1, GTX 1080-class laptops).

Status and staged plan: [docs/PLAN.md](docs/PLAN.md). Measured results: [docs/FINDINGS.md](docs/FINDINGS.md).

## Run

```bash
pnpm install
pnpm dev        # 2D: http://127.0.0.1:5317  3D: /index3d.html  (?scene=Pyramid, &backend=gpu, &paused)
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
the paper's figures: Wall Smash, Breakable Wall, Chain Mail, Heavy Pendulum 50000:1, Brick Ring
(110k, Fig. 1), Jointed Drop (34k bodies, 71k joints), box piles.

3D demo controls: left-drag on a body grabs it, left-drag elsewhere orbits, right-drag pans,
wheel zooms, middle-click or B shoots a box, P pauses, `.` steps, R resets.

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

## Reference sources

`pnpm fetch-reference` clones the upstream demos
([avbd-demo2d](https://github.com/savant117/avbd-demo2d), [avbd-demo3d](https://github.com/savant117/avbd-demo3d),
© Chris Giles) into `reference/` (git-ignored). Then `tools/cpp-oracle/build.sh` and
`tools/cpp-oracle/gen2d.sh` / `gen3d.sh` rebuild the oracles and regenerate the fixtures.
