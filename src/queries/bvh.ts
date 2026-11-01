import type { Triangle, Vec3 } from './geometry.ts';

export interface QueryStats { nodesVisited: number; trianglesTested: number }
/** Flat binary tree: six bounds and four integers (left, right, start, count) per node. */
export class TriangleBvh {
  readonly bounds: Float64Array;
  readonly nodes: Int32Array;
  readonly order: Uint32Array;
  constructor(triangles: Triangle[]) {
    const boxes: number[] = [], nodes: number[] = [], order = triangles.map((_, i) => i);
    const build = (start: number, end: number): number => {
      const id = nodes.length / 4, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let j = start; j < end; j++) for (const p of triangles[order[j]]) for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]);
      }
      boxes.push(...min, ...max); nodes.push(-1, -1, start, end - start);
      if (end - start > 8) {
        const extent = max.map((v, i) => v - min[i]), axis = extent.indexOf(Math.max(...extent));
        const centroid = (i: number) => triangles[i].reduce((s, p) => s + p[axis] / 3, 0);
        const sorted = order.slice(start, end).sort((a, b) => centroid(a) - centroid(b) || a - b);
        for (let i = 0; i < sorted.length; i++) order[start + i] = sorted[i];
        const mid = (start + end) >>> 1;
        nodes[id * 4] = build(start, mid); nodes[id * 4 + 1] = build(mid, end); nodes[id * 4 + 3] = 0;
      }
      return id;
    };
    if (triangles.length) build(0, triangles.length);
    this.bounds = new Float64Array(boxes); this.nodes = new Int32Array(nodes); this.order = new Uint32Array(order);
  }
  visit(origin: Vec3, direction: Vec3, radius: number, limit: () => number, test: (triangle: number) => void, stats?: QueryStats): void {
    const stack = this.nodes.length ? [0] : [];
    while (stack.length) {
      const id = stack.pop()!;
      if (stats) stats.nodesVisited++;
      let lo = 0, hi = limit();
      for (let k = 0; k < 3; k++) {
        const min = this.bounds[id * 6 + k] - radius, max = this.bounds[id * 6 + k + 3] + radius;
        if (direction[k] === 0) { if (origin[k] < min || origin[k] > max) hi = -1; }
        else {
          const a = (min - origin[k]) / direction[k], b = (max - origin[k]) / direction[k];
          lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
      }
      if (lo > hi) continue;
      const base = id * 4, count = this.nodes[base + 3];
      if (count) for (let i = 0; i < count; i++) {
        if (stats) stats.trianglesTested++;
        test(this.order[this.nodes[base + 2] + i]);
      }
      else stack.push(this.nodes[base + 1], this.nodes[base]);
    }
  }
}
