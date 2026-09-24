#!/bin/sh
# Build the headless C++ oracles from the upstream sources (run `pnpm fetch-reference` first).
set -e
cd "$(dirname "$0")"
SDK=$(xcrun --show-sdk-path 2>/dev/null || true)
mkdir -p bin
GL=$( [ "$(uname)" = Darwin ] && echo "-framework OpenGL -Wno-deprecated-declarations" )

# bin/oracleNd: upstream as written (f32). bin/oracleNd-f64: same sources compiled in double
# precision, which the f64 TypeScript port must match to round-off.
build() {
  S=$1; DRIVER=$2; shift 2
  c++ -O2 -std=c++17 ${SDK:+-isysroot "$SDK"} -Istub -I"$S" "$DRIVER" "$@" $GL
}
to_f64() {
  rm -rf "$2" && mkdir -p "$2"
  for f in "$1"/*.cpp "$1"/*.h; do
    perl -pe "$3" "$f" > "$2/$(basename "$f")"
  done
}

SRC2=../../reference/avbd-demo2d/source
FILES2="solver.cpp rigid.cpp force.cpp joint.cpp spring.cpp motor.cpp manifold.cpp collide.cpp"
build "$SRC2" oracle2d.cpp $(for f in $FILES2; do echo "$SRC2/$f"; done) -o bin/oracle2d
to_f64 "$SRC2" bin/src-f64 's/\bfloat\b/double/g; s/\b(sqrt|fabs|pow)f\(/$1(/g; s/(\d+\.\d*|\.\d+)f\b/$1/g'
build bin/src-f64 oracle2d.cpp $(for f in $FILES2; do echo "bin/src-f64/$f"; done) -o bin/oracle2d-f64

# The 3D f64 build also disables FMA contraction so each operation rounds exactly like the
# TypeScript port (which cannot fuse).
SRC3=../../reference/avbd-demo3d/source
FILES3="solver.cpp rigid.cpp force.cpp joint.cpp spring.cpp manifold.cpp collide.cpp"
build "$SRC3" oracle3d.cpp $(for f in $FILES3; do echo "$SRC3/$f"; done) -o bin/oracle3d
to_f64 "$SRC3" bin/src3d-f64 's/\bfloat\b/double/g; s/\b(sqrt|fabs|pow|sin|cos|tan)f\(/$1(/g; s/(\d+\.\d*|\.\d+)f\b/$1/g'
build bin/src3d-f64 oracle3d.cpp $(for f in $FILES3; do echo "bin/src3d-f64/$f"; done) -ffp-contract=off -o bin/oracle3d-f64
