#!/bin/sh
# Regenerate the golden 3D trajectories from the upstream C++ solver, compiled in double
# precision so the f64 TypeScript port must match it to round-off.
# Requires `pnpm fetch-reference` and tools/cpp-oracle/build.sh.
set -e
cd "$(dirname "$0")"
OUT=../../tests/fixtures/oracle3d
mkdir -p "$OUT"
FRAMES=1,10,60,120,180
for i in $(seq 0 13); do
  ./bin/oracle3d-f64 "$i" "$FRAMES" > "$OUT/scene-$i.json"
done
