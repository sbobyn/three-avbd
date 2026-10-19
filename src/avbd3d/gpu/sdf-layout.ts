// Experimental SDF-only pass ABI. Kept separate from the production solver layout.
import { meshSurfaceVertices } from './sdf-supports.ts';
import { AnalyticField, type Field } from '../ref/sdf/shapes.ts';
import { VoxelField } from '../ref/sdf/voxel.ts';
import { SdfBody } from '../ref/sdf/body.ts';
import { collisionParams, type CollisionParams } from '../ref/sdf/manifold.ts';
export const SDF_HEADER_WORDS = 32;
export const SDF_BODY_WORDS = 28;
/** Point record: position/depth, normal/separation, anchors, flags, then the symmetric ellipsoid
 * warm start (e00 e01 e02 e11 | e12 e22) used by optimizer 1. */
export const SDF_POINT_WORDS = 28;
/** Default points per pair result: four cached plus one fresh sample. */
export const SDF_MAX_POINTS = 5;
/** Largest per-pass point capacity (the paper's widest sweep is 16 cached + 4 sampled). */
export const SDF_POINT_LIMIT = 20;
/** Words per pair result for a pass built with `maxPoints` points. */
export const sdfResultWords = (maxPoints: number = SDF_MAX_POINTS) => 8 + maxPoints * SDF_POINT_WORDS;
export const SDF_RESULT_WORDS = sdfResultWords();
export function checkSdfPointCapacity(maxPoints: number): number {
  if (!Number.isInteger(maxPoints) || maxPoints < 2 || maxPoints > SDF_POINT_LIMIT) throw new Error(`SDF point capacity must be an integer 2–${SDF_POINT_LIMIT}`);
  return maxPoints;
}
export const SDF_NO_CACHE = 0xffffffff;
export interface SdfPair { a: number; b: number; key: number; previous?: number }
export interface SdfAtlas { data: Uint32Array<ArrayBuffer>; offsets: ReadonlyMap<Field, number> }
const kinds = { box: 0, sphere: 1, capsule: 2, cylinder: 3, cone: 4, torus: 5, warp: 6, 'spike-plate': 8, 'spiky-wheel': 9 } as const;
function finite(data: Float32Array, label: string): void {
  if (!data.every(Number.isFinite)) throw new Error(`${label} exceeds finite float32 range`);
}
/** Float4 reference storage first: no optional GPU features or lossy quantization. */
export function packSdfAtlas(fields: readonly Field[], maxBytes = 64 * 1024 * 1024, meshVertexContacts = false): SdfAtlas {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 16) throw new Error('Invalid SDF atlas byte limit');
  const unique = [...new Set(fields)], offsets = new Map<Field, number>(); let words = 0;
  const supports=new Map(unique.map(field=>[field,meshVertexContacts?meshSurfaceVertices(field):[]]));
  for (const field of unique) {
    if (!(field instanceof VoxelField) && !(field instanceof AnalyticField && Object.hasOwn(kinds, field.spec.kind))) throw new Error('Unsupported GPU SDF: bake custom fields to voxels first');
    offsets.set(field, words / 4); words += SDF_HEADER_WORDS + (field.seeds.length + supports.get(field)!.length) * 4 + (field instanceof VoxelField ? field.grid.length : 0);
    if (!Number.isSafeInteger(words) || words * 4 > maxBytes || words > 0xffffffff) throw new Error('SDF atlas exceeds byte/index limit');
  }
  const data = new Uint32Array(Math.max(4, words)), floats = new Float32Array(data.buffer);
  for (const field of unique) {
    const at = offsets.get(field)! * 4, gridAt = at + SDF_HEADER_WORDS, seedAt = gridAt + (field instanceof VoxelField ? field.grid.length : 0);
    data.set([field instanceof VoxelField ? 7 : kinds[(field as AnalyticField).spec.kind as keyof typeof kinds], +field.convex, seedAt / 4, field.seeds.length], at);
    floats.set([...field.bounds.min, field instanceof VoxelField ? field.cell : 0], at + 8);
    floats.set([...field.bounds.max, 0], at + 12); floats.set([...field.centerOfMass, 0], at + 16);
    if (field instanceof VoxelField) {
      data.set([gridAt / 4, ...field.dimensions], at + 4); floats.set(field.origin, at + 28); floats.set(field.grid, gridAt);
    } else {
      const s = (field as AnalyticField).spec;
      if (s.kind === 'box') floats.set(s.halfExtents, at + 20);
      else if (s.kind === 'sphere') floats[at + 20] = s.radius;
      else if (s.kind === 'capsule') floats.set([s.radius, s.halfLength], at + 20);
      else if (s.kind === 'cone' || s.kind === 'cylinder') floats.set([s.radius, s.halfHeight], at + 20);
      else if (s.kind === 'torus') floats.set([s.majorRadius, s.minorRadius], at + 20);
      else if (s.kind === 'spike-plate') {
        if (s.count >= 2**24) throw new Error('GPU SDF spike count exceeds exact float32 range');
        floats.set([...s.halfExtents,s.count],at+20); floats.set([s.spikeRadius,s.minHeight,s.maxHeight,0],at+24);
      } else if (s.kind === 'spiky-wheel') {
        if (s.spikes >= 2**24) throw new Error('GPU SDF spike count exceeds exact float32 range');
        floats.set([s.hubRadius,s.hubHalfWidth,s.spikeRadius,s.spikeHalfHeight],at+20); floats[at+24]=s.spikes;
      }
      else if (s.kind === 'warp') { floats.set([...s.halfExtents, s.k], at + 20); data[at + 24] = s.type; }
    }
    field.seeds.forEach((p, i) => floats.set(p, seedAt + 4 * i));
    const extra=supports.get(field)!;data[at+15]=extra.length;
    extra.forEach((p,i)=>floats.set(p,seedAt+4*(field.seeds.length+i)));
    // Integer metadata is not float data (some bit patterns represent NaN).
    finite(floats.subarray(at + 8, at + 24), 'SDF header');
    finite(floats.subarray(at + 28, at + 32), 'SDF origin');
    if (data[at] !== 6) finite(floats.subarray(at + 24, at + 28), 'SDF secondary parameters');
    finite(floats.subarray(gridAt, seedAt + (field.seeds.length + supports.get(field)!.length) * 4), 'SDF grid/seeds');
  }
  return { data, offsets };
}
export function packSdfBodies(bodies: readonly SdfBody[], atlas: SdfAtlas): Uint32Array<ArrayBuffer> {
  const data = new Uint32Array(Math.max(4, bodies.length * SDF_BODY_WORDS)), f = new Float32Array(data.buffer);
  bodies.forEach((body, i) => {
    const at = i * SDF_BODY_WORDS, h = atlas.offsets.get(body.field);
    if (h === undefined) throw new Error('Body field is absent from SDF atlas');
    const scale = Math.fround(body.scale);
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(Math.hypot(...body.orientation) - 1) > 1e-4) throw new Error('Invalid GPU SDF body transform');
    const box = body.bounds;
    f.set([...body.position, body.scale, ...body.orientation, ...body.velocity, +body.isStatic, ...body.angularVelocity, 0, ...box.min, 0, ...box.max, 0, 0, 0, 0, 1], at);
    finite(f.subarray(at, at + SDF_BODY_WORDS), 'SDF body');
    data[at + 15] = h;
  });
  return data;
}
export function packSdfPairs(pairs: readonly SdfPair[], bodyCount: number, previousCount: number): Uint32Array<ArrayBuffer> {
  const data = new Uint32Array(Math.max(4, pairs.length * 4)), keys = new Set<number>();
  pairs.forEach((p, i) => {
    if (![p.a, p.b].every(v => Number.isSafeInteger(v) && v >= 0 && v < bodyCount) || p.a === p.b) throw new Error('Invalid SDF pair body IDs');
    if (!Number.isSafeInteger(p.key) || p.key < 0 || p.key >= SDF_NO_CACHE || keys.has(p.key)) throw new Error('SDF pair keys must be unique uint32 IDs');
    if (p.previous !== undefined && (!Number.isInteger(p.previous) || p.previous < 0 || p.previous >= previousCount)) throw new Error('Invalid previous SDF pair slot');
    keys.add(p.key); data.set([p.a, p.b, p.key, p.previous ?? SDF_NO_CACHE], i * 4);
  });
  return data;
}
/** `maxPoints` is the pass's point capacity: cache ≤ maxPoints−1, cache + samples ≤ maxPoints. */
export function packSdfParams(pairCount: number, step: number, dt: number, p: CollisionParams = collisionParams(), maxPoints: number = SDF_MAX_POINTS): Uint32Array<ArrayBuffer> {
  if (!Number.isInteger(pairCount) || pairCount < 0 || pairCount > 0xffffffff || !Number.isInteger(step) || step < 0 || step > 0xffffffff || !Number.isFinite(dt) || dt < 0) throw new Error('Invalid SDF dispatch parameters');
  checkSdfPointCapacity(maxPoints);
  if (![0, 1, 2].includes(p.optimizer)) throw new Error(`Unknown SDF optimizer ${p.optimizer}`);
  // Only gradient descent reads stepSize; other optimizers pack 0 so no unchecked float reaches the GPU.
  if (p.optimizer === 2 && !(Math.fround(p.stepSize) > 0 && Number.isFinite(Math.fround(p.stepSize)))) throw new Error('SDF gradient descent needs a finite positive stepSize');
  if (!Number.isInteger(p.cacheSize) || p.cacheSize < 0 || p.cacheSize > maxPoints - 1 || !Number.isInteger(p.randomSamples) || p.randomSamples < 0 || p.cacheSize + p.randomSamples > maxPoints || !Number.isInteger(p.maxIterations) || p.maxIterations < 1 || p.maxIterations > 512) throw new Error(`This GPU SDF pass supports at most ${maxPoints - 1} cached/${maxPoints} total samples and 1–512 iterations`);
  if (!(p.epsilon === 0 || Math.fround(p.epsilon) > 0) || ![p.tolerance].every(v => Math.fround(v) > 0 && Number.isFinite(Math.fround(v))) || ![p.epsilon, p.alpha, p.margin, p.replacementThreshold].every(v => v >= 0 && Number.isFinite(Math.fround(v)))) throw new Error('Invalid SDF collision distances');
  const data = new Uint32Array(20), f = new Float32Array(data.buffer);
  data.set([pairCount, step, p.cacheSize, p.randomSamples]);
  f.set([dt, p.epsilon, p.alpha, p.tolerance], 4);
  f.set([p.margin, p.replacementThreshold, +(p.signedSeparation ?? false), +(p.meshVertexContacts ?? false)], 8);
  data.set([p.maxIterations, +p.warmStart, +p.curvatureSampling, +p.skipConvexSamples], 12);
  data[16] = p.optimizer; f[17] = p.optimizer === 2 ? p.stepSize : 0; data[18] = +(p.optimizer === 2 && (p.sgdGradientStopOnly ?? false));
  finite(f.subarray(4, 12), 'SDF parameters'); return data;
}
export interface GpuSdfPoint { x: number[]; depth: number; normal: number[]; separation: number; anchorA: number[]; anchorB: number[]; rank: number; active: boolean; cached: boolean; id: number }
export interface GpuSdfResult { a: number; b: number; key: number; queries: number; iterations: number; points: GpuSdfPoint[] }
export function decodeSdfResults(buffer: ArrayBuffer, count: number, maxPoints: number = SDF_MAX_POINTS): GpuSdfResult[] {
  const stride = sdfResultWords(checkSdfPointCapacity(maxPoints));
  if (!Number.isSafeInteger(count) || count < 0 || buffer.byteLength < count * stride * 4) throw new Error('SDF result buffer too short');
  const u = new Uint32Array(buffer), f = new Float32Array(buffer), results: GpuSdfResult[] = [];
  for (let i = 0; i < count; i++) {
    const at = i * stride, n = u[at + 3];
    if (n > maxPoints) throw new Error('Invalid SDF result count');
    const points: GpuSdfPoint[] = [];
    for (let j = 0; j < n; j++) {
      const o = at + 8 + j * SDF_POINT_WORDS; finite(f.subarray(o, o + 16), 'SDF output');
      points.push({ x: Array.from(f.slice(o, o+3)), depth: f[o+3], normal: Array.from(f.slice(o+4,o+7)), separation: f[o+7], anchorA: Array.from(f.slice(o+8,o+11)), anchorB: Array.from(f.slice(o+12,o+15)), rank: f[o+15], active: !!u[o+16], cached: !!u[o+17], id: u[o+18] });
    }
    results.push({ a: u[at], b: u[at+1], key: u[at+2], queries: u[at+4], iterations: u[at+5], points });
  }
  return results;
}
