# AGENTS.md — three-avbd

Read `docs/PLAN.md` (stages and check-ins) and `docs/FINDINGS.md` (measured decisions) first.

## Gate

`pnpm check` (typecheck, CPU tests, GPU tests via headless Dawn, vite build). Run it before
declaring any change done. GPU tests skip (never pass) when no adapter is available.

## Rules specific to this repo

- `src/avbd2d/ref/` is the oracle and must stay a faithful port of avbd-demo2d. Default
  parameters must reproduce `tests/fixtures/oracle2d` to round-off. New behaviour goes behind
  an opt-in parameter (see `stiffnessRescale`, `vbd`). Never regenerate fixtures to make a
  change pass. Regenerate only from the upstream C++ via `tools/cpp-oracle/`.
- Later solvers (SoA CPU, WebGPU) are validated against the reference with single-step diffs
  and metric envelopes (f32 and GPU ordering make long trajectories diverge).
- GPU buffers never hold ±Infinity (WGSL may assume finite floats); use the BIG/HARD
  sentinels in `src/avbd2d/gpu/shaders.ts`.
- The dev machine is an M4 Max; performance claims for the M1/GTX 1080 target must be
  measured there, not extrapolated.
- Performance target is older hardware (M1, GTX 1080). Optional WebGPU features
  (`subgroups`, `timestamp-query`) must have fallbacks.
- Dev server port is 5317 (`--strictPort`). Sibling projects occupy 5190–5210.
