import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LARGE_FACTOR, MAX_LARGE, largestSmall, select } from '../src/avbd3d/gpu/radii.ts';

/** The classification as it was, by sorting: what selection must reproduce exactly. */
function bySort(radii: number[]): number {
  const sorted = [...radii].sort((x, y) => x - y);
  const n = sorted.length;
  const median = n > 0 ? sorted[n >> 1] : 1;
  let maxSmall = 0;
  for (const r of sorted) if (r <= LARGE_FACTOR * median) maxSmall = Math.max(maxSmall, r);
  if (n > MAX_LARGE) maxSmall = Math.max(maxSmall, sorted[n - MAX_LARGE - 1]);
  return maxSmall;
}

/** A deterministic generator (mulberry32). */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('select finds each order statistic, runs of equal values included', () => {
  const rand = random(1);
  for (const n of [1, 2, 3, 10, 257]) {
    const values = Array.from({ length: n }, () => Math.floor(rand() * 5));
    const sorted = [...values].sort((x, y) => x - y);
    for (let k = 0; k < n; k++) assert.equal(select(Float64Array.from(values), k), sorted[k], `n ${n}, k ${k}`);
  }
});

test('largestSmall matches the sort-based classification', () => {
  const rand = random(2);
  const cases: number[][] = [
    [],
    [0.5],
    // A city: one voxel radius, a ground body, a few large sections
    [...Array.from({ length: 5000 }, () => 0.2165), 2000, ...Array.from({ length: 40 }, () => 1 + rand() * 6)],
    // Past MAX_LARGE large bodies: the largest left sizes the cells
    [...Array.from({ length: 3000 }, () => 0.2165), ...Array.from({ length: 90 }, () => 1 + rand() * 6)],
    // Mixed sizes, fewer bodies than MAX_LARGE
    Array.from({ length: 40 }, () => 0.1 + rand()),
    Array.from({ length: 20000 }, () => 0.05 + rand() * rand() * 3),
  ];
  for (const [i, radii] of cases.entries()) assert.equal(largestSmall(Float64Array.from(radii)), bySort(radii), `case ${i}`);
});
