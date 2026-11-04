import { capsuleContact, sweepCapsuleTriangle } from './capsule.ts';
import { TriangleBvh, type QueryStats } from './bvh.ts';
import { add, sub, mul, cross, dot, length, unit, normal, vector, tolerance, contact, rayTriangle, sweepTriangle, type Triangle, type Vec3 } from './geometry.ts';
export type { Vec3, QueryStats };
export interface MeshInput {
  positions: ArrayLike<number>;
  indices?: ArrayLike<number>;
  position?: ArrayLike<number>;
  /** Quaternion xyzw; normalized on entry. */
  rotation?: ArrayLike<number>;
  group?: number;
  collidesWith?: number;
}
export interface MeshHandle { readonly id: number; readonly discardedTriangles: number }
export interface QueryOptions {
  collidesWith?: number;
  ignore?: readonly MeshHandle[];
  stats?: QueryStats;
}
export interface RayOptions extends QueryOptions { maxDistance?: number }
export interface OverlapOptions extends QueryOptions { maxResults?: number }
export interface RayHit { meshId: number; triangle: number; distance: number; point: Vec3; normal: Vec3 }
export interface OverlapHit { meshId: number; triangle: number; point: Vec3; normal: Vec3; distance: number }
export interface SphereSweep { center: ArrayLike<number>; radius: number; translation: ArrayLike<number> }
export interface SweepHit { meshId: number; triangle: number; fraction: number; point: Vec3; normal: Vec3; startedOverlapping: boolean }
export type SweepResult = { status: 'hit'; hit: SweepHit } | { status: 'miss' };
/** Endpoints are cap centers; full height = segment length + twice radius. */
export interface Capsule { start: ArrayLike<number>; end: ArrayLike<number>; radius: number }
export interface CapsuleSweep extends Capsule { translation: ArrayLike<number> }
export interface CapsuleSweepOptions extends QueryOptions { maxIterations?: number }
export type CapsuleSweepResult = SweepResult | { status: 'indeterminate'; fraction: number };
interface Mesh {
  handle: MeshHandle; triangles: Triangle[]; indices: number[]; bvh: TriangleBvh;
  group: number; collidesWith: number; epsilon: number;
}
function mask(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`${name} must be a u32 mask`);
  return value;
}
function radiusValue(radius: number): number {
  if (!Number.isFinite(radius) || radius < 0) throw new Error('radius must be finite and nonnegative');
  return radius;
}
const order = (a: { meshId: number; triangle: number }, b: { meshId: number; triangle: number }) => a.meshId - b.meshId || a.triangle - b.triangle;

export class StaticQueryScene {
  private meshes = new Map<MeshHandle, Mesh>();
  private handles = new WeakSet<MeshHandle>();
  private nextId = 1;
  private version = 0;
  private dead = false;
  get revision(): number { this.live(); return this.version; }
  private live(): void { if (this.dead) throw new Error('StaticQueryScene is destroyed'); }
  addMesh(input: MeshInput): MeshHandle {
    this.live();
    if ('side' in input) throw new Error('side is unsupported; surfaces are double-sided');
    const group = mask(input.group ?? 1, 'group'), collidesWith = mask(input.collidesWith ?? 0xffffffff, 'collidesWith');
    const position = vector(input.position ?? [0, 0, 0], 'position'), q = Array.from(input.rotation ?? [0, 0, 0, 1]);
    if (q.length !== 4 || !q.every(Number.isFinite) || !(Math.hypot(...q) > 0) || !Number.isFinite(Math.hypot(...q))) throw new Error('rotation must be a finite nonzero quaternion');
    const ql = Math.hypot(...q); for (let i = 0; i < 4; i++) q[i] /= ql;
    const u: Vec3 = [q[0], q[1], q[2]], positions = Array.from(input.positions);
    if (positions.length % 3 || !positions.every(Number.isFinite)) throw new Error('positions must contain complete finite vertices');
    const vertices: Vec3[] = [];
    for (let i = 0; i < positions.length; i += 3) {
      const p: Vec3 = [positions[i], positions[i + 1], positions[i + 2]], v = mul(cross(u, p), 2);
      const transformed = add(position, add(p, add(mul(v, q[3]), cross(u, v))));
      if (!transformed.every(Number.isFinite)) throw new Error('transformed positions exceed numeric range');
      vertices.push(transformed);
    }
    const source = input.indices ? Array.from(input.indices) : vertices.map((_, i) => i);
    if (source.length % 3) throw new Error('indices must contain complete triangles');
    if (!source.every(i => Number.isInteger(i) && i >= 0 && i < vertices.length)) throw new Error('triangle index out of range');
    const triangles: Triangle[] = [], indices: number[] = []; let discardedTriangles = 0, epsilon = 0;
    for (let i = 0; i < source.length; i += 3) {
      const t: Triangle = [vertices[source[i]], vertices[source[i + 1]], vertices[source[i + 2]]];
      const area = length(cross(sub(t[1], t[0]), sub(t[2], t[0])));
      if (!Number.isFinite(area) || !Number.isFinite(dot(sub(t[1], t[0]), sub(t[1], t[0])))) throw new Error('triangle exceeds numeric range');
      if (area === 0) { discardedTriangles++; continue; }
      triangles.push(t); indices.push(i / 3); epsilon = Math.max(epsilon, tolerance(t));
    }
    if (this.nextId > 0xffffffff) throw new Error('mesh IDs exhausted');
    const bvh = new TriangleBvh(triangles), handle = Object.freeze({ id: this.nextId++, discardedTriangles });
    this.meshes.set(handle, { handle, triangles, indices, bvh, group, collidesWith, epsilon }); this.handles.add(handle); this.version++;
    return handle;
  }
  remove(handle: MeshHandle): boolean {
    this.live();
    if (!this.handles.has(handle)) throw new Error('foreign mesh handle');
    if (!this.meshes.delete(handle)) return false;
    this.version++; return true;
  }
  destroy(): void {
    if (this.dead) return;
    this.meshes.clear(); this.version++; this.dead = true;
  }
  private selected(options: QueryOptions): Mesh[] {
    this.live();
    const bits = mask(options.collidesWith ?? 0xffffffff, 'collidesWith'), ignored = new Set(options.ignore ?? []);
    for (const h of ignored) if (!this.handles.has(h)) throw new Error('foreign mesh handle');
    if (options.stats && (!Number.isFinite(options.stats.nodesVisited) || !Number.isFinite(options.stats.trianglesTested))) throw new Error('stats counters must be finite');
    return [...this.meshes.values()].filter(m => (m.group & bits) !== 0 && !ignored.has(m.handle));
  }
  raycast(origin: ArrayLike<number>, direction: ArrayLike<number>, options: RayOptions = {}): RayHit | null {
    const meshes = this.selected(options), o = vector(origin, 'origin'), d = vector(direction, 'direction');
    if (!(length(d) > 0) || !Number.isFinite(length(d))) throw new Error('direction must be nonzero and have finite length');
    const dir = unit(d), max = options.maxDistance ?? Infinity;
    if (max < 0 || (max !== Infinity && !Number.isFinite(max))) throw new Error('maxDistance must be nonnegative');
    let best: RayHit | null = null;
    for (const m of meshes) m.bvh.visit(o, dir, m.epsilon, () => best?.distance ?? max, i => {
      const distance = rayTriangle(o, dir, m.triangles[i], best?.distance ?? max);
      if (distance === null) return;
      const hit = { meshId: m.handle.id, triangle: m.indices[i], distance, point: add(o, mul(dir, distance)), normal: normal(m.triangles[i]) };
      if (dot(hit.normal, dir) > 0) hit.normal = mul(hit.normal, -1);
      if (!best || distance < best.distance || (distance === best.distance && order(hit, best) < 0)) best = hit;
    }, options.stats);
    return best;
  }
  overlapSphere(center: ArrayLike<number>, radius: number, options: OverlapOptions = {}): { hits: OverlapHit[]; complete: boolean } {
    const meshes = this.selected(options), c = vector(center, 'center'); radiusValue(radius);
    const max = options.maxResults ?? 64;
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('maxResults must be a nonnegative safe integer');
    const hits: OverlapHit[] = []; let count = 0;
    for (const m of meshes) m.bvh.visit(c, [0, 0, 0], radius + m.epsilon + 1e-10 * radius, () => 0, i => {
      const hit = contact(c, m.triangles[i]);
      if (hit.distance > radius + tolerance(m.triangles[i], radius)) return;
      count++;
      if (max === 0) return;
      hits.push({ meshId: m.handle.id, triangle: m.indices[i], ...hit }); hits.sort(order);
      if (hits.length > max) hits.pop();
    }, options.stats);
    return { hits, complete: count <= max };
  }
  private capsule(input: Capsule) {
    const start = vector(input.start, 'start'), end = vector(input.end, 'end'), radius = radiusValue(input.radius);
    const segment = sub(end, start), segmentLength = length(segment);
    const bound = radius + segmentLength / 2;
    if (!segment.every(Number.isFinite) || !Number.isFinite(bound)) throw new Error('capsule exceeds numeric range');
    const center = add(mul(start, .5), mul(end, .5));
    return { start, end, radius, segmentLength, center, bound };
  }
  overlapCapsule(input: Capsule, options: OverlapOptions = {}): { hits: OverlapHit[]; complete: boolean } {
    const meshes = this.selected(options), c = this.capsule(input);
    if (c.segmentLength === 0) return this.overlapSphere(c.start, c.radius, options);
    const max = options.maxResults ?? 64;
    if (!Number.isSafeInteger(max) || max < 0) throw new Error('maxResults must be a nonnegative safe integer');
    const hits: OverlapHit[] = []; let count = 0;
    for (const m of meshes) m.bvh.visit(c.center, [0, 0, 0], c.bound + m.epsilon + 1e-10 * c.bound, () => 0, i => {
      const hit = capsuleContact(c.start, c.end, m.triangles[i]);
      if (!Number.isFinite(hit.distance) || !hit.normal.every(Number.isFinite)) throw new Error('capsule distance exceeds numeric range');
      if (hit.distance > c.radius + tolerance(m.triangles[i], c.radius)) return;
      count++;
      if (max === 0) return;
      hits.push({ meshId: m.handle.id, triangle: m.indices[i], ...hit }); hits.sort(order);
      if (hits.length > max) hits.pop();
    }, options.stats);
    return { hits, complete: count <= max };
  }
  sweepCapsule(input: CapsuleSweep, options: CapsuleSweepOptions = {}): CapsuleSweepResult {
    const meshes = this.selected(options), c = this.capsule(input), translation = vector(input.translation, 'translation');
    const budget = options.maxIterations ?? 256;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 4096) throw new Error('maxIterations must be an integer from 1 to 4096');
    if (!Number.isFinite(length(translation)) || !add(c.start, translation).every(Number.isFinite) || !add(c.end, translation).every(Number.isFinite)) throw new Error('sweep exceeds numeric range');
    if (c.segmentLength === 0) return this.sweepSphere({ center: c.start, radius: c.radius, translation }, options);
    let best: SweepHit | null = null, unresolved = Infinity;
    for (const m of meshes) m.bvh.visit(c.center, translation, c.bound + 2 * (m.epsilon + 1e-10 * c.bound), () => best?.fraction ?? 1, i => {
      const result = sweepCapsuleTriangle(c.start, c.end, c.radius, translation, m.triangles[i], budget);
      if (result.status === 'indeterminate') { unresolved = Math.min(unresolved, result.fraction); return; }
      if (result.status === 'miss') return;
      const { status: _, ...contact } = result;
      const hit = { meshId: m.handle.id, triangle: m.indices[i], ...contact };
      if (!best || hit.fraction < best.fraction || (hit.fraction === best.fraction && order(hit, best) < 0)) best = hit;
    }, options.stats);
    // An unresolved earlier candidate prevents a claim that a known hit is nearest.
    if (unresolved <= ((best as SweepHit | null)?.fraction ?? 1)) return { status: 'indeterminate', fraction: unresolved };
    return best ? { status: 'hit', hit: best } : { status: 'miss' };
  }
  sweepSphere(input: SphereSweep, options: QueryOptions = {}): SweepResult {
    const meshes = this.selected(options), center = vector(input.center, 'center'), translation = vector(input.translation, 'translation'), radius = radiusValue(input.radius);
    if (!Number.isFinite(length(translation)) || !add(center, translation).every(Number.isFinite)) throw new Error('sweep exceeds numeric range');
    let best: SweepHit | null = null;
    for (const m of meshes) m.bvh.visit(center, translation, radius + m.epsilon + 1e-10 * radius, () => best?.fraction ?? 1, i => {
      const result = sweepTriangle(center, radius, translation, m.triangles[i]);
      if (!result) return;
      const hit = { meshId: m.handle.id, triangle: m.indices[i], ...result };
      if (!best || hit.fraction < best.fraction || (hit.fraction === best.fraction && order(hit, best) < 0)) best = hit;
    }, options.stats);
    return best ? { status: 'hit', hit: best } : { status: 'miss' };
  }
}

/** Full side lengths; centered at the origin. */
export function boxMesh(size: ArrayLike<number>): { positions: Float64Array; indices: Uint32Array } {
  const s = vector(size, 'size'); if (!s.every(v => v > 0)) throw new Error('size must be positive');
  const positions = new Float64Array(24);
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) positions[i * 3 + k] = (i & (1 << k) ? .5 : -.5) * s[k];
  return { positions, indices: new Uint32Array([0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5]) };
}
