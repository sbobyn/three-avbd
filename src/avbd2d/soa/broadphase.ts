// Uniform-grid broadphase (spatial hash + counting sort), shaped like the GPU version:
// every step is a flat loop over bodies or buckets. Bodies much larger than typical (the
// ground) would span thousands of cells, so they go on a "large" list and are tested against
// every other body instead.
//
// Pair test is identical to the reference: bounding circles overlap, not both static, and
// not connected by any constraint. Pairs are keyed A * 2^21 + B with A > B (the reference
// makes the newer body A), and returned sorted by key.

export const PAIR_SHIFT = 2 ** 21;
export const pairKey = (a: number, b: number): number => (a > b ? a * PAIR_SHIFT + b : b * PAIR_SHIFT + a);

/** Bodies with radius above LARGE_FACTOR × median radius are tested brute-force. */
const LARGE_FACTOR = 4;

function lowerBound(keys: Float64Array, count: number, key: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function containsKey(keys: Float64Array, count: number, key: number): boolean {
  const i = lowerBound(keys, count, key);
  return i < count && keys[i] === key;
}

export class GridBroadphase {
  cellSize = 1;
  pairs = new Float64Array(1024);
  pairCount = 0;

  private configuredFor = -1;
  private large = new Int32Array(0);
  private isLarge = new Uint8Array(0);
  private cellX = new Int32Array(0);
  private cellY = new Int32Array(0);
  private tableSize = 0;
  private bucketStart = new Int32Array(0);
  private sorted = new Int32Array(0);

  /** Choose the cell size and the large-body list; bodies' radii never change once created. */
  private configure(n: number, props: ArrayLike<number>): void {
    this.configuredFor = n;
    const radii = Float64Array.from({ length: n }, (_, i) => props[i * 4 + 1]).sort();
    const median = n > 0 ? radii[n >> 1] : 1;
    let maxSmall = 0;
    for (let i = 0; i < n; i++) if (radii[i] <= LARGE_FACTOR * median) maxSmall = Math.max(maxSmall, radii[i]);
    // Two touching circles of radius <= maxSmall have centres within 2·maxSmall, so a cell of
    // that size means every overlapping pair is in the same or an adjacent cell.
    this.cellSize = Math.max(2 * maxSmall, 1e-3);

    this.isLarge = new Uint8Array(n);
    const large: number[] = [];
    for (let i = 0; i < n; i++) {
      if (props[i * 4 + 1] > maxSmall) {
        this.isLarge[i] = 1;
        large.push(i);
      }
    }
    this.large = Int32Array.from(large);
    this.cellX = new Int32Array(n);
    this.cellY = new Int32Array(n);
    this.tableSize = 1;
    while (this.tableSize < 2 * n) this.tableSize <<= 1;
    this.bucketStart = new Int32Array(this.tableSize + 1);
    this.sorted = new Int32Array(n);
  }

  private hash(ix: number, iy: number): number {
    return (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) & (this.tableSize - 1);
  }

  /** `pose` and `props` are stride-4 body arrays; props[i*4 + 1] is the bounding radius. */
  findPairs(
    n: number,
    pose: ArrayLike<number>,
    props: ArrayLike<number>,
    dynamic: Uint8Array,
    noCollide: Float64Array,
    noCollideCount: number,
  ): void {
    if (n !== this.configuredFor) this.configure(n, props);
    this.pairCount = 0;
    const { cellX, cellY, isLarge, bucketStart, sorted } = this;
    const inv = 1 / this.cellSize;

    // Counting sort of small bodies by hash bucket
    bucketStart.fill(0);
    for (let i = 0; i < n; i++) {
      if (isLarge[i]) continue;
      cellX[i] = Math.floor(pose[i * 4] * inv);
      cellY[i] = Math.floor(pose[i * 4 + 1] * inv);
      bucketStart[this.hash(cellX[i], cellY[i]) + 1]++;
    }
    for (let h = 0; h < this.tableSize; h++) bucketStart[h + 1] += bucketStart[h];
    const cursor = bucketStart.slice(0, this.tableSize);
    for (let i = 0; i < n; i++) {
      if (isLarge[i]) continue;
      sorted[cursor[this.hash(cellX[i], cellY[i])]++] = i;
    }

    const test = (a: number, b: number): void => {
      if (!dynamic[a] && !dynamic[b]) return;
      const dx = pose[a * 4] - pose[b * 4];
      const dy = pose[a * 4 + 1] - pose[b * 4 + 1];
      const r = props[a * 4 + 1] + props[b * 4 + 1];
      if (dx * dx + dy * dy > r * r) return;
      const key = pairKey(a, b);
      if (containsKey(noCollide, noCollideCount, key)) return;
      if (this.pairCount === this.pairs.length) {
        const grown = new Float64Array(this.pairs.length * 2);
        grown.set(this.pairs);
        this.pairs = grown;
      }
      this.pairs[this.pairCount++] = key;
    };

    // Small vs small: scan the 3x3 neighbourhood, emit each pair once (from the higher index)
    for (let i = 0; i < n; i++) {
      if (isLarge[i]) continue;
      const cx = cellX[i];
      const cy = cellY[i];
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const h = this.hash(cx + ox, cy + oy);
          for (let k = bucketStart[h]; k < bucketStart[h + 1]; k++) {
            const j = sorted[k];
            // Different cells can share a bucket; only accept bodies really in this cell
            if (j >= i || cellX[j] !== cx + ox || cellY[j] !== cy + oy) continue;
            test(i, j);
          }
        }
      }
    }

    // Large vs everything (large-large pairs once)
    for (const l of this.large) {
      for (let k = 0; k < n; k++) {
        if (k === l || (isLarge[k] && k > l)) continue;
        test(l, k);
      }
    }

    this.pairs.subarray(0, this.pairCount).sort();
  }
}
