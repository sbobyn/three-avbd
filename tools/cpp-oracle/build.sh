#!/bin/sh
# Build the headless C++ oracle from the upstream sources (run `pnpm fetch-reference` first).
set -e
cd "$(dirname "$0")"
SRC=../../reference/avbd-demo2d/source
SDK=$(xcrun --show-sdk-path 2>/dev/null || true)
mkdir -p bin
# bin/oracle2d: upstream as written (f32). bin/oracle2d-f64: same sources compiled in double
# precision, which the f64 TypeScript port must match to round-off.
build() {
S=$1; shift
c++ -O2 -std=c++17 ${SDK:+-isysroot "$SDK"} -Istub -I"$S" oracle2d.cpp \
  "$S/solver.cpp" "$S/rigid.cpp" "$S/force.cpp" "$S/joint.cpp" "$S/spring.cpp" \
  "$S/motor.cpp" "$S/manifold.cpp" "$S/collide.cpp" \
  $( [ "$(uname)" = Darwin ] && echo "-framework OpenGL -Wno-deprecated-declarations" ) "$@"
}
build "$SRC" -o bin/oracle2d
rm -rf bin/src-f64 && mkdir -p bin/src-f64
for f in "$SRC"/*.cpp "$SRC"/*.h; do
  perl -pe 's/\bfloat\b/double/g; s/\b(sqrt|fabs|pow)f\(/$1(/g; s/(\d+\.\d*|\.\d+)f\b/$1/g' "$f" > "bin/src-f64/$(basename "$f")"
done
build bin/src-f64 -o bin/oracle2d-f64
