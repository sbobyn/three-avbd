// The 3D broadphase's classification of bodies by radius (GpuSolver3D.uploadStatics, and the CPU pair estimate):
// the few largest are tested against everything, the rest size the grid's cells. It runs again whenever a body's
// radius changes (a game resizing a body to carry a falling section does, often), so it finds the median and the
// cut-off by selection rather than sorting: sorting a hundred thousand radii took 13-22 ms of the frame each time.

/**
 * Bodies with radius above LARGE_FACTOR × median radius are tested brute-force against every
 * body instead of sizing the grid cells, up to MAX_LARGE of the largest (each costs a test
 * per body). Showcase balls are ~3x the median brick; at the 2D factor of 4 they set 4 m
 * cells and the wall-smash broadphase took most of an 8 ms step.
 */
export const LARGE_FACTOR = 2;
export const MAX_LARGE = 64;

/**
 * The k-th smallest of `a` (0-based), reordering `a` in place: Wirth's selection, linear on average, and balanced
 * on runs of equal values (a city's voxels are all one radius).
 */
export function select(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (lo < hi) {
    const pivot = a[k];
    let i = lo;
    let j = hi;
    do {
      while (a[i] < pivot) i++;
      while (pivot < a[j]) j--;
      if (i <= j) {
        const t = a[i];
        a[i] = a[j];
        a[j] = t;
        i++;
        j--;
      }
    } while (i <= j);
    if (j < k) lo = i;
    if (k < i) hi = j;
  }
  return a[k];
}

/**
 * The largest radius still small (it sizes the grid cells): at most LARGE_FACTOR × the median, or past MAX_LARGE
 * larger bodies, the largest left. Reorders `radii`.
 */
export function largestSmall(radii: Float64Array): number {
  const n = radii.length;
  const median = n > 0 ? select(radii, n >> 1) : 1;
  let maxSmall = 0;
  for (let i = 0; i < n; i++) if (radii[i] <= LARGE_FACTOR * median) maxSmall = Math.max(maxSmall, radii[i]);
  // Beyond MAX_LARGE candidates, the rest stay small (and size the cells)
  if (n > MAX_LARGE) maxSmall = Math.max(maxSmall, select(radii, n - MAX_LARGE - 1));
  return maxSmall;
}
