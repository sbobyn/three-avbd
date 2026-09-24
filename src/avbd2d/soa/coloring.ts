// Graph colouring of dynamic bodies so that bodies sharing a constraint get different colours
// and each colour can be solved in parallel. Incremental Jones-Plassmann, shaped like the GPU
// algorithm (Jacobi rounds that read only the previous round's state):
//
// 1. Compact: a body whose hashed priority beats all its neighbours may drop to the smallest
//    colour its neighbours leave free. Neighbours don't move in the same round, so this never
//    creates a clash, and colour counts don't creep up as contacts come and go.
// 2. Pending: bodies with no colour, or sharing a colour with a higher-priority neighbour.
// 3. Rounds: a pending body whose priority beats all its pending neighbours takes the smallest
//    colour not used by its settled neighbours. Winners are never adjacent, so each round
//    settles an independent set; random priorities make that take O(log n) rounds, where
//    index order would take O(chain length) (a rope would need one round per link).
//
// Bodies still pending after `maxRounds` keep a clashing colour and are solved Jacobi-style
// with their neighbour. Measured in Stage 2: Jacobi between hard-jointed neighbours is
// unstable, so the round budget must be enough to reach zero clashes.

export const MAX_COLORS = 64;

/** Index of the lowest set bit of a 32-bit value (x != 0). */
const ctz = (x: number): number => 31 - Math.clz32(x & -x);

/** Deterministic pseudo-random priority (lowbias32 hash); ties broken by index. */
export function priority(i: number): number {
  let x = i + 0x9e3779b9;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

const beats = (pi: number, i: number, pj: number, j: number): boolean => pi > pj || (pi === pj && i > j);

export interface ColoringResult {
  numColors: number;
  /** Bodies still sharing a colour with a neighbour after the last round. */
  conflicts: number;
  rounds: number;
}

export class Coloring {
  colors = new Int32Array(0);
  /** Bodies bucketed by colour: colorBodies[colorStart[c] .. colorStart[c + 1]). */
  colorStart = new Int32Array(MAX_COLORS + 1);
  colorBodies = new Int32Array(0);
  private next = new Int32Array(0);
  private pending = new Uint8Array(0);
  private prio = new Uint32Array(0);

  resize(n: number): void {
    if (this.colors.length === n) return;
    const colors = new Int32Array(n).fill(-1);
    colors.set(this.colors.subarray(0, Math.min(n, this.colors.length)));
    this.colors = colors;
    this.next = new Int32Array(n);
    this.pending = new Uint8Array(n);
    this.colorBodies = new Int32Array(n);
    this.prio = Uint32Array.from({ length: n }, (_, i) => priority(i));
  }

  run(
    n: number,
    dynamic: Uint8Array,
    adjStart: Int32Array,
    adjList: Int32Array,
    info: Int32Array,
    maxRounds: number,
  ): ColoringResult {
    this.resize(n);
    const { colors, next, pending, prio } = this;
    const other = (c: number, b: number): number => {
      const a = info[c * 4 + 1];
      const o = a === b ? info[c * 4 + 2] : a;
      return o >= 0 && dynamic[o] ? o : -1;
    };

    // Smallest colour not used by neighbours (skipping pending ones when `skipPending`)
    const smallestFree = (b: number, skipPending: boolean): number => {
      let lo = 0;
      let hi = 0;
      for (let k = adjStart[b]; k < adjStart[b + 1]; k++) {
        const j = other(adjList[k], b);
        if (j < 0 || (skipPending && pending[j])) continue;
        const col = colors[j];
        if (col < 0) continue;
        if (col < 32) lo |= 1 << col;
        else hi |= 1 << (col - 32);
      }
      if (~lo !== 0) return ctz(~lo);
      if (~hi !== 0) return 32 + ctz(~hi);
      return MAX_COLORS - 1;
    };

    // 1. Compaction by local priority maxima
    for (let b = 0; b < n; b++) {
      next[b] = colors[b];
      if (!dynamic[b] || colors[b] < 0) continue;
      let isMax = true;
      for (let k = adjStart[b]; k < adjStart[b + 1] && isMax; k++) {
        const j = other(adjList[k], b);
        if (j >= 0 && !beats(prio[b], b, prio[j], j)) isMax = false;
      }
      if (isMax) next[b] = Math.min(colors[b], smallestFree(b, false));
    }
    colors.set(next);

    // 2. Pending: uncoloured, or clashing with a higher-priority neighbour
    const markPending = (): number => {
      let count = 0;
      for (let b = 0; b < n; b++) {
        pending[b] = 0;
        if (!dynamic[b]) continue;
        if (colors[b] < 0) pending[b] = 1;
        else {
          for (let k = adjStart[b]; k < adjStart[b + 1]; k++) {
            const j = other(adjList[k], b);
            if (j >= 0 && colors[j] === colors[b] && beats(prio[j], j, prio[b], b)) {
              pending[b] = 1;
              break;
            }
          }
        }
        count += pending[b];
      }
      return count;
    };
    let remaining = markPending();

    // 3. Jones-Plassmann rounds over pending bodies
    let rounds = 0;
    while (remaining > 0 && rounds < maxRounds) {
      rounds++;
      for (let b = 0; b < n; b++) {
        next[b] = -2; // unchanged
        if (!pending[b]) continue;
        let isMax = true;
        for (let k = adjStart[b]; k < adjStart[b + 1] && isMax; k++) {
          const j = other(adjList[k], b);
          if (j >= 0 && pending[j] && !beats(prio[b], b, prio[j], j)) isMax = false;
        }
        if (isMax) next[b] = smallestFree(b, true);
      }
      for (let b = 0; b < n; b++) {
        if (next[b] === -2) continue;
        colors[b] = next[b];
        pending[b] = 0;
        remaining--;
      }
    }

    // Leftover clashes (only if the round budget ran out)
    let conflicts = 0;
    if (remaining > 0) {
      for (let b = 0; b < n; b++) {
        if (!pending[b]) continue;
        if (colors[b] < 0) colors[b] = 0;
      }
      conflicts = markPending();
    }

    // Bucket bodies by colour (counting sort; ascending index within a colour)
    const start = this.colorStart;
    start.fill(0);
    let numColors = 0;
    for (let b = 0; b < n; b++) {
      if (!dynamic[b]) continue;
      start[colors[b] + 1]++;
      numColors = Math.max(numColors, colors[b] + 1);
    }
    for (let c = 0; c < MAX_COLORS; c++) start[c + 1] += start[c];
    const cursor = start.slice(0, MAX_COLORS);
    for (let b = 0; b < n; b++) if (dynamic[b]) this.colorBodies[cursor[colors[b]]++] = b;

    return { numColors, conflicts, rounds };
  }
}
