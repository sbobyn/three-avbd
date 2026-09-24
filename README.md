# three-avbd

Augmented Vertex Block Descent ([Giles, Diaz, Yuksel — SIGGRAPH 2025](https://graphics.cs.utah.edu/research/projects/avbd/))
in TypeScript, Three.js and raw WGSL WebGPU compute. The goal is maximum performance on
slightly older hardware (Apple M1, GTX 1080-class laptops).

Status and staged plan: [docs/PLAN.md](docs/PLAN.md). Measured results: [docs/FINDINGS.md](docs/FINDINGS.md).

## Run

```bash
pnpm install
pnpm dev        # http://127.0.0.1:5317  (?scene=Pyramid, &paused)
pnpm check      # typecheck + CPU tests + GPU tests (headless Dawn) + production build
pnpm bench2d    # CPU scaling baseline
pnpm bench2d:gpu # GPU benchmark with per-phase timing (headless)
pnpm sweep2d    # iteration count: cost vs quality on the GPU
pnpm scaling2d  # box rain 10k-250k, writes docs/data/scaling2d-<adapter>.json
```

Browser benchmark for any machine: http://127.0.0.1:5317/bench.html (runs the GPU suite,
"Copy results" gives JSON to paste back).

2D demo controls: left-drag grabs a body, right-click spawns a box, wheel zooms,
space/shift + drag or middle-drag pans, WASD/QE move the camera, P pauses, `.` steps, R resets.

## Layout

| Path | What |
|---|---|
| `src/avbd2d/ref/` | 2D CPU reference: faithful port of `avbd-demo2d` (the oracle for later solvers) |
| `src/avbd2d/soa/` | GPU-shaped CPU solver: SoA buffers, grid broadphase, colouring, CSR (the GPU's template) |
| `src/avbd2d/gpu/` | WebGPU solver: WGSL kernels (`shaders.ts`), host code, Sim2D adapter |
| `src/avbd2d/sim.ts` | Common `Sim2D` interface over all backends; scene registry |
| `src/app2d/` | 2D demo app: Three.js WebGPU renderer (CPU instancing or zero-copy GPU bodies), GUI, input |
| `tests/` | `node --test` suites; `fixtures/oracle2d` holds golden trajectories from the C++ demo |
| `tests-gpu/` | GPU tests on a real device through Dawn (`webgpu` package); skipped without an adapter |
| `tools/cpp-oracle/` | Builds the upstream C++ solver headless (f32 and f64) and regenerates fixtures |

## Reference sources

`pnpm fetch-reference` clones the upstream demos
([avbd-demo2d](https://github.com/savant117/avbd-demo2d), [avbd-demo3d](https://github.com/savant117/avbd-demo3d),
© Chris Giles) into `reference/` (git-ignored). Then `tools/cpp-oracle/build.sh` and
`tools/cpp-oracle/gen2d.sh` rebuild the oracle and regenerate the fixtures.
