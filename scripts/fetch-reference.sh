#!/bin/sh
# Fetch the upstream AVBD C++ demos (Chris Giles) into reference/ for porting side by side.
set -e
cd "$(dirname "$0")/.."
mkdir -p reference
for repo in avbd-demo2d avbd-demo3d; do
  if [ ! -d "reference/$repo" ]; then
    git clone --depth 1 "https://github.com/savant117/$repo" "reference/$repo"
  fi
done
