// A solver step re-uses its upload buffers and dynamic offsets instead of allocating them, and
// still encodes exactly what it did before: the same writes (bytes and lengths), the same
// pipelines, bind groups, dynamic offsets and dispatches, in the same order. The queue and
// compute-pass methods are wrapped for the duration of a test and record every call.
//
// TRACE_* are the trace digests of the solvers at 2bb1a31, from before the reuse.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PASS_STRIDE } from '../src/avbd2d/gpu/layout.ts';
import { GpuSolver2D } from '../src/avbd2d/gpu/solver.ts';
import { parallelParams, Solver as Solver2D } from '../src/avbd2d/ref/solver.ts';
import { sceneByName as sceneByName2D } from '../src/avbd2d/sim.ts';
import { SoaSolver2D } from '../src/avbd2d/soa/solver.ts';
import { SPARSE_COLOR_START } from '../src/avbd3d/gpu/layout.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { sceneByName } from '../src/avbd3d/ref/scenes.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { gpuTest } from './device.ts';

const TRACE_3D = '498931f2a6fc470b3b7adfc03623adbba9286ae7b55a4724e61fc29e416460ce';
const TRACE_3D_SPARSE = 'a2dfbef9e93ec1e7c3397054d73dc18a57e4868b635de467d14fa9347863d248';
const TRACE_2D = 'a97496892d4c264083ad0080b4f101f43302e4e2f43815addb20363452c25a7c';

interface Write {
  label: string;
  offset: number;
  bytes: Uint8Array;
  /** The memory the data argument views, to tell a reused upload buffer from a new one */
  source: ArrayBufferLike;
}

interface StepLog {
  writes: Write[];
  /** setBindGroup(1, ...): the dynamic offsets and the argument that carried them */
  passOffsets: number[];
  offsetArgs: unknown[];
  trace: string[];
}

/** Record the queue writes and compute-pass calls made by each `step()`. */
function record(steps: number, step: (k: number) => void): StepLog[] {
  const Q = GPUQueue.prototype;
  const P = GPUComputePassEncoder.prototype;
  const E = GPUCommandEncoder.prototype;
  const saved = { writeBuffer: Q.writeBuffer, setPipeline: P.setPipeline, setBindGroup: P.setBindGroup, dispatchWorkgroups: P.dispatchWorkgroups, dispatchWorkgroupsIndirect: P.dispatchWorkgroupsIndirect, end: P.end, beginComputePass: E.beginComputePass };
  const ids = new Map<object, number>();
  const id = (o: object) => ids.get(o) ?? (ids.set(o, ids.size), ids.size - 1);
  let log!: StepLog;
  Q.writeBuffer = function (this: GPUQueue, buffer: GPUBuffer, offset: number, data: BufferSource, dataOffset?: number, size?: number) {
    const unit = ArrayBuffer.isView(data) && !(data instanceof DataView) ? (data as Uint8Array).BYTES_PER_ELEMENT : 1;
    const base = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const start = (dataOffset ?? 0) * unit;
    const bytes = base.slice(start, size === undefined ? undefined : start + size * unit);
    log.writes.push({ label: buffer.label, offset, bytes, source: ArrayBuffer.isView(data) ? data.buffer : data });
    log.trace.push(`write ${buffer.label} @${offset} ${createHash('sha256').update(bytes).digest('hex')}`);
    return saved.writeBuffer.apply(this, [buffer, offset, data, dataOffset, size] as Parameters<GPUQueue['writeBuffer']>);
  } as GPUQueue['writeBuffer'];
  E.beginComputePass = function (this: GPUCommandEncoder, descriptor?: GPUComputePassDescriptor) {
    log.trace.push(`begin ${descriptor?.label} ${descriptor?.timestampWrites ? 'timed' : ''}`);
    return saved.beginComputePass.call(this, descriptor);
  };
  P.setPipeline = function (this: GPUComputePassEncoder, pipeline: GPUComputePipeline) {
    log.trace.push(`pipeline ${pipeline.label}`);
    return saved.setPipeline.call(this, pipeline);
  };
  P.setBindGroup = function (this: GPUComputePassEncoder, index: number, group: GPUBindGroup | null, offsets?: Iterable<number> | Uint32Array, start?: number, length?: number) {
    const list = offsets === undefined ? [] : offsets instanceof Uint32Array ? [...offsets.subarray(start ?? 0, (start ?? 0) + (length ?? offsets.length - (start ?? 0)))] : [...offsets];
    if (index === 1) {
      log.passOffsets.push(...list);
      log.offsetArgs.push(offsets);
    }
    log.trace.push(`group ${index} #${group ? id(group) : -1} [${list}]`);
    return (saved.setBindGroup as (...a: unknown[]) => void).apply(this, [...arguments]);
  } as GPUComputePassEncoder['setBindGroup'];
  P.dispatchWorkgroups = function (this: GPUComputePassEncoder, x: number, y?: number, z?: number) {
    log.trace.push(`dispatch ${x} ${y ?? 1} ${z ?? 1}`);
    return saved.dispatchWorkgroups.call(this, x, y, z);
  };
  P.dispatchWorkgroupsIndirect = function (this: GPUComputePassEncoder, buffer: GPUBuffer, offset: number) {
    log.trace.push(`indirect ${buffer.label} @${offset}`);
    return saved.dispatchWorkgroupsIndirect.call(this, buffer, offset);
  };
  P.end = function (this: GPUComputePassEncoder) {
    log.trace.push('end');
    return saved.end.call(this);
  };
  const logs: StepLog[] = [];
  try {
    for (let k = 0; k < steps; k++) {
      log = { writes: [], passOffsets: [], offsetArgs: [], trace: [] };
      step(k);
      logs.push(log);
    }
  } finally {
    Object.assign(Q, { writeBuffer: saved.writeBuffer });
    Object.assign(P, { setPipeline: saved.setPipeline, setBindGroup: saved.setBindGroup, dispatchWorkgroups: saved.dispatchWorkgroups, dispatchWorkgroupsIndirect: saved.dispatchWorkgroupsIndirect, end: saved.end });
    Object.assign(E, { beginComputePass: saved.beginComputePass });
  }
  return logs;
}

const digest = (logs: StepLog[]) => createHash('sha256').update(logs.map((l) => l.trace.join('\n')).join('\n--\n')).digest('hex');

/** The pass constants as the 0.2.2 solvers wrote them: (colour, alpha) at each entry's start, zero elsewhere. */
function expectedPassBytes(entries: number, filled: number, perIteration: number, alphaFor: (it: number) => number): Uint8Array {
  const data = new ArrayBuffer(entries * PASS_STRIDE);
  const u32 = new Uint32Array(data);
  const f32 = new Float32Array(data);
  for (let e = 0; e < filled; e++) {
    u32[(e * PASS_STRIDE) / 4] = e % perIteration;
    f32[(e * PASS_STRIDE) / 4 + 1] = alphaFor(Math.floor(e / perIteration));
  }
  return new Uint8Array(data);
}

/** Checks that every step uploads its params once, and from the same memory. */
function checkParams(logs: StepLog[], paramsLabel: string): void {
  const paramSources = new Set<ArrayBufferLike>();
  logs.forEach((log, k) => {
    const params = log.writes.filter((w) => w.label === paramsLabel);
    assert.equal(params.length, 1, `step ${k}: one params upload`);
    paramSources.add(params[0].source);
  });
  assert.equal(paramSources.size, 1, 'every step uploads its params from the same memory');
}

/** Checks each step's one pass-constant upload, and that every params upload re-uses one buffer. */
function checkUploads(logs: StepLog[], expected: (k: number) => Uint8Array, paramsLabel: string): void {
  logs.forEach((log, k) => {
    const pass = log.writes.filter((w) => w.label === 'pass constants');
    assert.equal(pass.length, 1, `step ${k}: one pass-constant upload`);
    assert.equal(pass[0].offset, 0);
    assert.deepEqual(pass[0].bytes, expected(k), `step ${k}: pass-constant bytes`);
  });
  checkParams(logs, paramsLabel);
}

/** The 3D pass constants: (colour, alpha) at the start of each of `entries` entries, zero elsewhere. */
const expectedPassBytes3D = (entries: number, alpha: number) => expectedPassBytes(entries, entries, entries, () => Math.fround(alpha));

/** The 3D dynamic offsets: entry 0, then per iteration the dense primal colours and the dual's entry. */
function expectedOffsets3D(iterations: number, primalColors: number, colorCap: number): number[] {
  const offsets = [0];
  for (let it = 0; it < iterations; it++) {
    for (let col = 0; col < primalColors; col++) offsets.push(col * PASS_STRIDE);
    offsets.push(colorCap * PASS_STRIDE);
  }
  return offsets;
}

gpuTest('3D step: same uploads, offsets and dispatches, from re-used buffers', async (device) => {
  const ref = new Solver();
  sceneByName('Breakable').build(ref);
  const gpu = new GpuSolver3D(device, ref);
  const cap0 = gpu.colorCap;
  // Shrink, none, then grow; the colour cap grows (the pass constants with it) and shrinks; the
  // last step repeats its alpha, which uploads no pass constants
  const runs = [
    { iterations: 4, alpha: 0.95, colorCap: cap0 },
    { iterations: 4, alpha: 0.94, colorCap: cap0 },
    { iterations: 2, alpha: 0.93, colorCap: cap0 },
    { iterations: 0, alpha: 0.92, colorCap: cap0 },
    { iterations: 6, alpha: 0.91, colorCap: cap0 + 8 },
    { iterations: 6, alpha: 0.9, colorCap: cap0 + 8 },
    { iterations: 3, alpha: 0.89, colorCap: cap0 },
    { iterations: 3, alpha: 0.89, colorCap: cap0 },
  ];
  const logs = record(runs.length, (k) => {
    Object.assign(gpu.params, { iterations: runs[k].iterations, alpha: runs[k].alpha });
    gpu.colorCap = runs[k].colorCap;
    gpu.step();
  });
  // The pass-constant buffer only grows: it holds one entry per colour of the largest cap so far
  const entries = (k: number) => Math.max(...runs.slice(0, k + 1).map((r) => r.colorCap + 1));
  const sources = new Set<ArrayBufferLike>();
  logs.forEach((log, k) => {
    const pass = log.writes.filter((w) => w.label === 'pass constants');
    if (k === runs.length - 1) assert.equal(pass.length, 0, 'an unchanged alpha uploads no pass constants');
    else {
      assert.equal(pass.length, 1, `step ${k}: one pass-constant upload`);
      assert.equal(pass[0].offset, 0);
      assert.deepEqual(pass[0].bytes, expectedPassBytes3D(entries(k), runs[k].alpha), `step ${k}: pass-constant bytes`);
      sources.add(pass[0].source);
    }
    assert.deepEqual(log.passOffsets, expectedOffsets3D(runs[k].iterations, runs[k].colorCap, runs[k].colorCap), `step ${k}: dynamic offsets`);
  });
  checkParams(logs, 'params 3d');
  assert.equal(sources.size, 2, 'the pass-constant upload memory is allocated once, and again only to grow');
  const args = new Set(logs.flatMap((l) => l.offsetArgs));
  assert.equal(args.size, 1, 'every dynamic offset is passed in the same array');
  assert.equal(digest(logs), TRACE_3D, `3D trace ${digest(logs)}`);
  gpu.destroy();
});

gpuTest('3D step with sparse colours: same uploads, offsets and dispatches, from re-used buffers', async (device) => {
  const count = 80;
  const ref = new Solver();
  for (let i = 0; i < count; i++) new Rigid(ref, [0.1, 0.1, 0.1], 1, 0.5, [i * 0.3, 0, 3]);
  const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
  gpu.fuseSparseColors = true;
  gpu.appendJoints(Array.from({ length: 63 }, (_, i) => ({ a: i, b: i + 1, rA: [0.15, 0, 0], rB: [-0.15, 0, 0] })));
  gpu.fixedColors = Uint32Array.from({ length: count }, (_, i) => i % 64);
  const runs = [
    { iterations: 4, alpha: 0.95 },
    { iterations: 2, alpha: 0.9 },
    { iterations: 5, alpha: 0.85 },
  ];
  const logs = record(runs.length, (k) => {
    Object.assign(gpu.params, runs[k]);
    gpu.step();
  });
  assert.ok(logs.every((l) => l.trace.includes('pipeline primalSparse')), 'the steps take the sparse-colour path');
  logs.forEach((log, k) => {
    const pass = log.writes.filter((w) => w.label === 'pass constants');
    assert.equal(pass.length, 1, `step ${k}: one pass-constant upload`);
    assert.deepEqual(pass[0].bytes, expectedPassBytes3D(gpu.colorCap + 1, runs[k].alpha), `step ${k}: pass-constant bytes`);
    assert.deepEqual(log.passOffsets, expectedOffsets3D(runs[k].iterations, SPARSE_COLOR_START, gpu.colorCap), `step ${k}: dynamic offsets`);
  });
  checkParams(logs, 'params 3d');
  assert.equal(new Set(logs.flatMap((l) => l.offsetArgs)).size, 1, 'every dynamic offset is passed in the same array');
  assert.equal(digest(logs), TRACE_3D_SPARSE, `3D sparse trace ${digest(logs)}`);
  gpu.destroy();
});

gpuTest('2D step: same uploads, offsets and dispatches, from re-used buffers', async (device) => {
  const ref = new Solver2D();
  Object.assign(ref, parallelParams());
  sceneByName2D('Rope').build!(ref);
  const soa = new SoaSolver2D();
  soa.loadFromReference(ref);
  const gpu = new GpuSolver2D(device, soa);
  const runs = [
    { iterations: 4, postStabilize: true, vbd: false },
    { iterations: 4, postStabilize: true, vbd: false },
    { iterations: 2, postStabilize: false, vbd: false },
    { iterations: 3, postStabilize: true, vbd: true },
    { iterations: 6, postStabilize: true, vbd: false },
    { iterations: 6, postStabilize: true, vbd: false },
    { iterations: 1, postStabilize: false, vbd: false },
  ];
  const logs = record(runs.length, (k) => {
    Object.assign(gpu.params, runs[k]);
    gpu.params.alpha = 0.95 - 0.01 * k;
    gpu.step();
  });
  const per = gpu.colorCap + 1;
  const total = (k: number) => runs[k].iterations + (runs[k].postStabilize && !runs[k].vbd ? 1 : 0);
  const alphaFor = (k: number) => (it: number) => {
    const { iterations, postStabilize, vbd } = runs[k];
    if (postStabilize && !vbd) return it < iterations ? 1 : 0;
    return vbd ? 0 : Math.fround(0.95 - 0.01 * k);
  };
  checkUploads(logs, (k) => expectedPassBytes(total(k) * per, total(k) * per, per, alphaFor(k)), 'params');
  const sources = new Set(logs.map((l) => l.writes.find((w) => w.label === 'pass constants')!.source));
  assert.equal(sources.size, 2, 'the pass-constant upload memory is allocated once, and again only to grow');

  logs.forEach((log, k) => {
    const offsets = [0];
    for (let it = 0; it < total(k); it++) {
      for (let col = 0; col < gpu.colorCap; col++) offsets.push((it * per + col) * PASS_STRIDE);
      if (it < runs[k].iterations) offsets.push((it * per + gpu.colorCap) * PASS_STRIDE);
    }
    assert.deepEqual(log.passOffsets, offsets, `step ${k}: dynamic offsets`);
  });
  const args = new Set(logs.flatMap((l) => l.offsetArgs));
  assert.equal(args.size, 1, 'every dynamic offset is passed in the same array');
  assert.equal(digest(logs), TRACE_2D, `2D trace ${digest(logs)}`);
});
