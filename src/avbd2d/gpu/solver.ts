// WebGPU host code for the 2D AVBD solver: the whole step runs on the GPU, the CPU only
// encodes commands. Per step:
//
//   clears → beginFrame → hashInsert(prev contacts) → grid count / scan / scatter → pairs
//   → narrowphase (+ warm start) → adjacency (degree / scan / fill)
//   → colouring (compact, mark, rounds, count, scan, scatter) → joint and body warm start
//   → iterations × (primal per colour, dual joints, dual contacts) → velocities
//
// Every count the GPU produces (pairs, contacts, bodies per colour) sizes the next kernels
// through indirect dispatch, so nothing is read back while stepping. A CPU-side SoaSolver2D
// mirror holds what the CPU owns: body shapes (for the broadphase configuration), joint
// definitions, and the no-collide pairs.

import { parallelParams, type SolverParams } from '../ref/solver.ts';
import { PAIR_SHIFT } from '../soa/broadphase.ts';
import { C0, CS, FMAX, FMIN, FRAC, INFO_STRIDE, LAM, P0, P1, P2, PEN, RA, RB, type SoaSolver2D, STICK, STIFF, T_JOINT } from '../soa/solver.ts';
import {
  ARGS_WORDS, argsWGSL, BIG, BODY_FLOATS, COLOR_WG, C_CLASHES, C_CONTACTS, C_NUM_COLORS, C_OVERFLOW, C_PAIRS, CONTACT_WORDS,
  COUNTER_WORDS, FLAG_MATCH_NEAREST, FLAG_POST_STABILIZE, FLAG_RESCALE, FLAG_VBD, IA_COLOR, IA_CONSTRAINTS, IA_CONTACTS, IA_PAIRS, IA_PREV, J_ANCHORS, J_C0,
  J_FMAX, J_FMIN, J_FRAC, J_LAM, J_PARAM, J_PEN, J_STIFF, JOINT_FLOATS, MAX_COLORS, NO_COLOR, PARAM_WORDS, PASS_STRIDE,
  WORKGROUP_SIZE,
} from './layout.ts';
import { PrefixScan } from './scan.ts';
import { broadphaseWGSL, contactsWGSL } from './wgsl-collision.ts';
import { solveWGSL } from './wgsl-solve.ts';
import { topologyWGSL } from './wgsl-topology.ts';

const finite = (x: number): number => (x === Infinity ? BIG : x === -Infinity ? -BIG : x);
const groups = (n: number): number => Math.ceil(n / WORKGROUP_SIZE);
const pow2AtLeast = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(n, 2)));

/** Byte size of a body buffer holding `n` bodies. */
export const bodyBufferSize = (n: number): number => Math.max(n, 1) * BODY_FLOATS * 4;

/** Bodies with radius above LARGE_FACTOR × median radius are tested brute-force (as on the CPU). */
const LARGE_FACTOR = 4;

export interface GpuSolverOptions {
  /** Pre-allocated body buffer (STORAGE | COPY_SRC | COPY_DST), e.g. one Three.js renders from. */
  bodyBuffer?: GPUBuffer;
  /** Bodies the buffers can hold (default: current count + 1024); a supplied buffer's size wins. */
  bodyCapacity?: number;
  /** Jones-Plassmann rounds per step (even). Enough to reach zero clashes in practice. */
  colorRounds?: number;
}

/** The step's phases, each encoded as its own compute pass (so each can be timestamped). */
export const PHASES = ['collision', 'adjacency', 'coloring', 'solve'] as const;
export type Phase = (typeof PHASES)[number];

/** GPU milliseconds per phase, and from the first phase's start to the last one's end. */
export type StepProfile = Record<Phase, number> & { total: number };

export interface GpuCounters {
  pairs: number;
  contacts: number;
  overflow: number;
  clashes: number;
  colors: number;
}

/** Evaluated lazily: under Node the WebGPU globals appear only once a device module loads. */
const storageUsage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

export class GpuSolver2D {
  readonly device: GPUDevice;
  readonly params: SolverParams = parallelParams();
  /** CPU mirror: body shapes, joint definitions, no-collide pairs (poses live on the GPU). */
  readonly topology: SoaSolver2D;

  bodyCount = 0;
  readonly bodyCapacity: number;
  jointCount = 0;
  private jointCapacity = 0;
  pairCapacity = 0;
  contactCapacity = 0;
  /** Colours the colouring may use and the solver dispatches (grows via `adapt`). */
  colorCap = 12;
  /**
   * Encode each phase as its own compute pass even when not profiling. Pass boundaries cost
   * time on some drivers, so by default the step is one pass unless a profile is requested.
   */
  splitPasses = false;
  /** Primal dispatch: 'bucket' (bodies of the colour, compact) or 'scan' (all bodies, skip others). */
  primalMode: 'bucket' | 'scan' = 'bucket';
  private shrinkVotes = 0;

  private get colorHistOffset(): number {
    return 3 * this.bodyCapacity + 65;
  }
  readonly colorRounds: number;

  readonly bodyBuffer: GPUBuffer;
  private readonly ownsBodyBuffer: boolean;
  private jointBuffer!: GPUBuffer;
  private infoBuffer!: GPUBuffer;
  private contactBuffers!: [GPUBuffer, GPUBuffer];
  private pairBuffer!: GPUBuffer;
  private tableBuffer!: GPUBuffer;
  private readonly gridBuffer: GPUBuffer;
  private staticBuffer: GPUBuffer | null = null;
  private readonly counterBuffer: GPUBuffer;
  private readonly argsBuffer: GPUBuffer;
  private adjBuffer: GPUBuffer | null = null;
  private readonly colorBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private passBuffer: GPUBuffer | null = null;
  private passEntries = 0;

  /** Which contact buffer this step writes (the other holds last step's contacts). */
  private parity = 0;
  private readonly tableSize: number;
  private hashSize = 0;
  private cellSize = 1;
  private maxSmallRadius = 0;
  private largeCount = 0;
  private noCollideCount = 0;
  private staticsDirty = true;

  private readonly layouts: Record<'broad' | 'contacts' | 'topo' | 'solve' | 'pass' | 'args', GPUBindGroupLayout>;
  private readonly pipes: Record<string, GPUComputePipeline> = {};
  private groups!: {
    broad: GPUBindGroup;
    contacts: [GPUBindGroup, GPUBindGroup];
    topo: [GPUBindGroup, GPUBindGroup];
    solve: [GPUBindGroup, GPUBindGroup];
    args: GPUBindGroup;
  };
  private passGroup: GPUBindGroup | null = null;
  private readonly gridScan: PrefixScan;
  private readonly colorHistScan: PrefixScan;
  private readonly colorGroups: number;
  private adjScan: PrefixScan | null = null;

  // GPU timing with timestamp queries (when the device has 'timestamp-query'): a begin/end
  // pair around each phase's compute pass
  private readonly timing: { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer } | null;
  private timingCallback: ((profile: StepProfile) => void) | null = null;
  private timingBusy = false;

  constructor(device: GPUDevice, topology: SoaSolver2D, options: GpuSolverOptions = {}) {
    this.device = device;
    this.topology = topology;
    Object.assign(this.params, topology.params);
    this.bodyCount = topology.bodyCount;
    this.colorRounds = options.colorRounds ?? 16;

    this.ownsBodyBuffer = !options.bodyBuffer;
    this.bodyCapacity = options.bodyBuffer
      ? Math.floor(options.bodyBuffer.size / (BODY_FLOATS * 4))
      : Math.max(options.bodyCapacity ?? this.bodyCount + 1024, this.bodyCount, 1);
    if (this.bodyCapacity < this.bodyCount) throw new Error('body buffer too small');
    this.bodyBuffer = options.bodyBuffer ?? device.createBuffer({ label: 'bodies', size: bodyBufferSize(this.bodyCapacity), usage: storageUsage() });

    const cap = this.bodyCapacity;
    this.tableSize = pow2AtLeast(2 * cap);
    this.gridBuffer = device.createBuffer({ label: 'grid', size: (2 * this.tableSize + 1 + 3 * cap) * 4, usage: storageUsage() });
    this.counterBuffer = device.createBuffer({ label: 'counters', size: COUNTER_WORDS * 4, usage: storageUsage() });
    this.argsBuffer = device.createBuffer({ label: 'indirect args', size: ARGS_WORDS * 4, usage: storageUsage() | GPUBufferUsage.INDIRECT });
    this.colorGroups = Math.ceil(cap / COLOR_WG);
    this.colorBuffer = device.createBuffer({ label: 'colours', size: (3 * cap + 65 + MAX_COLORS * this.colorGroups + 1) * 4, usage: storageUsage() });
    this.paramsBuffer = device.createBuffer({ label: 'params', size: PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // Every body starts uncoloured
    device.queue.writeBuffer(this.colorBuffer, 0, new Uint32Array(cap).fill(NO_COLOR));

    const stamps = 2 * PHASES.length;
    this.timing = device.features.has('timestamp-query')
      ? {
          querySet: device.createQuerySet({ type: 'timestamp', count: stamps }),
          resolve: device.createBuffer({ size: stamps * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }),
          read: device.createBuffer({ size: stamps * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
        }
      : null;

    this.layouts = this.createLayouts();
    this.createPipelines();
    this.gridScan = new PrefixScan(device, this.gridBuffer, 0, this.tableSize + 1);
    this.colorHistScan = new PrefixScan(device, this.colorBuffer, this.colorHistOffset, MAX_COLORS * this.colorGroups + 1);

    this.jointCount = topology.jointCount;
    this.allocateJoints(topology.jointCount + 256);
    this.uploadJoints(0, topology.jointCount);
    this.allocateContacts(Math.max(4096, 4 * cap));
    this.uploadBodies();
  }

  // --- Setup ---------------------------------------------------------------------------------

  private createLayouts() {
    const d = this.device;
    const layout = (label: string, types: GPUBufferBindingType[]) =>
      d.createBindGroupLayout({
        label,
        entries: types.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })),
      });
    const R: GPUBufferBindingType = 'read-only-storage';
    const W: GPUBufferBindingType = 'storage';
    const U: GPUBufferBindingType = 'uniform';
    return {
      broad: layout('broadphase', [U, R, W, W, W, R, R]),
      contacts: layout('contacts', [U, R, R, W, R, W, W]),
      topo: layout('topology', [U, R, R, R, R, W, W, W]),
      solve: layout('solve', [U, W, W, R, W, R, R, R]),
      pass: d.createBindGroupLayout({
        label: 'pass',
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }],
      }),
      args: layout('args', [U, R, R, W]),
    };
  }

  private createPipelines(): void {
    const d = this.device;
    const make = (code: string, layouts: GPUBindGroupLayout[], entries: string[]) => {
      const module = d.createShaderModule({ code });
      const layout = d.createPipelineLayout({ bindGroupLayouts: layouts });
      for (const entryPoint of entries) this.pipes[entryPoint] = d.createComputePipeline({ label: entryPoint, layout, compute: { module, entryPoint } });
    };
    const L = this.layouts;
    make(broadphaseWGSL, [L.broad], ['beginFrame', 'gridCount', 'gridScatter', 'findPairs']);
    make(contactsWGSL, [L.contacts], ['hashInsert', 'narrowphase']);
    make(topologyWGSL, [L.topo], [
      'degreeJoints', 'degreeContacts', 'fillJoints', 'fillContacts', 'sortAdjacency',
      'colorCompact', 'colorMark', 'colorRoundAB', 'colorRoundBA', 'colorCount', 'colorStarts', 'colorScatter',
    ]);
    make(solveWGSL, [L.solve, L.pass], ['warmStartJoints', 'warmStartBodies', 'primal', 'primalScan', 'dual', 'refreshStick', 'updateVelocities']);
    make(argsWGSL, [L.args], ['argsPrev', 'argsPairs', 'argsContacts', 'argsColors']);
  }

  private allocateJoints(capacity: number): void {
    const d = this.device;
    const joints = d.createBuffer({ label: 'joints', size: Math.max(capacity, 1) * JOINT_FLOATS * 4, usage: storageUsage() });
    const info = d.createBuffer({ label: 'joint info', size: Math.max(capacity, 1) * 16, usage: storageUsage() });
    if (this.jointBuffer) {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(this.jointBuffer, 0, joints, 0, this.jointCapacity * JOINT_FLOATS * 4);
      encoder.copyBufferToBuffer(this.infoBuffer, 0, info, 0, this.jointCapacity * 16);
      d.queue.submit([encoder.finish()]);
      this.jointBuffer.destroy();
      this.infoBuffer.destroy();
    }
    this.jointBuffer = joints;
    this.infoBuffer = info;
    this.jointCapacity = capacity;
    if (this.contactBuffers) this.rebuildBindings();
  }

  /**
   * (Re)allocate pair and contact storage. Pairs get twice the room (8 bytes each against 80
   * per contact; box piles have ~4 bounding-circle pairs per body). When growing, both contact
   * buffers are copied over and the counters are left alone, so warm starts and the colour
   * statistics survive the reallocation.
   */
  private allocateContacts(requested: number, requestedPairs = 2 * requested): void {
    const d = this.device;
    // Never exceed what one storage binding may hold (128 MB by default): beyond that the
    // bind groups would be invalid. Overflow is then reported through the counters instead.
    const maxBinding = d.limits.maxStorageBufferBindingSize;
    const capacity = Math.min(requested, Math.floor(maxBinding / (CONTACT_WORDS * 4)), Math.floor(maxBinding / 16));
    const pairCapacity = Math.min(requestedPairs, Math.floor(maxBinding / 8));
    const old = this.contactBuffers;
    const oldCapacity = this.contactCapacity;
    for (const b of [this.pairBuffer, this.tableBuffer]) b?.destroy();
    this.contactCapacity = capacity;
    this.pairCapacity = pairCapacity;
    // Up to one entry per contact plus one per manifold: keep the load factor below ~1/2
    this.hashSize = pow2AtLeast(4 * capacity);
    this.pairBuffer = d.createBuffer({ label: 'pairs', size: pairCapacity * 8, usage: storageUsage() });
    this.tableBuffer = d.createBuffer({ label: 'contact hash', size: this.hashSize * 4, usage: storageUsage() });
    this.contactBuffers = [0, 1].map((i) =>
      d.createBuffer({ label: `contacts ${i}`, size: capacity * CONTACT_WORDS * 4, usage: storageUsage() }),
    ) as [GPUBuffer, GPUBuffer];
    if (old) {
      const encoder = d.createCommandEncoder();
      const bytes = Math.min(oldCapacity, capacity) * CONTACT_WORDS * 4;
      old.forEach((buffer, i) => encoder.copyBufferToBuffer(buffer, 0, this.contactBuffers[i], 0, bytes));
      d.queue.submit([encoder.finish()]);
      old.forEach((buffer) => buffer.destroy());
    }
    this.rebuildBindings();
  }

  /** Adjacency storage and every bind group (they reference reallocated buffers). */
  private rebuildBindings(): void {
    const d = this.device;
    const cap = this.bodyCapacity;
    this.adjBuffer?.destroy();
    this.adjBuffer = d.createBuffer({ label: 'adjacency', size: (2 * cap + 1 + 2 * (this.jointCapacity + this.contactCapacity)) * 4, usage: storageUsage() });
    this.adjScan?.destroy();
    this.adjScan = new PrefixScan(d, this.adjBuffer, 0, this.bodyCount + 1);
    this.staticBuffer ??= d.createBuffer({ label: 'statics', size: 16, usage: storageUsage() });

    const group = (layout: GPUBindGroupLayout, buffers: GPUBuffer[]) =>
      d.createBindGroup({ layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const P = this.paramsBuffer;
    const [c0, c1] = this.contactBuffers;
    const adj = this.adjBuffer;
    this.groups = {
      broad: group(this.layouts.broad, [P, this.bodyBuffer, this.gridBuffer, this.pairBuffer, this.counterBuffer, this.staticBuffer, this.jointBuffer]),
      contacts: [
        group(this.layouts.contacts, [P, this.bodyBuffer, this.pairBuffer, c0, c1, this.tableBuffer, this.counterBuffer]),
        group(this.layouts.contacts, [P, this.bodyBuffer, this.pairBuffer, c1, c0, this.tableBuffer, this.counterBuffer]),
      ],
      topo: [c0, c1].map((c) =>
        group(this.layouts.topo, [P, this.bodyBuffer, this.jointBuffer, this.infoBuffer, c, this.counterBuffer, adj, this.colorBuffer]),
      ) as [GPUBindGroup, GPUBindGroup],
      solve: [c0, c1].map((c) =>
        group(this.layouts.solve, [P, this.bodyBuffer, this.jointBuffer, this.infoBuffer, c, adj, this.colorBuffer, this.counterBuffer]),
      ) as [GPUBindGroup, GPUBindGroup],
      args: group(this.layouts.args, [P, this.counterBuffer, this.colorBuffer, this.argsBuffer]),
    };
  }

  // --- CPU-owned data ------------------------------------------------------------------------

  /** Upload bodies from the CPU mirror (pose.w carries friction for the narrowphase). */
  uploadBodies(first = 0, count = this.topology.bodyCount - first): void {
    const s = this.topology;
    const data = new Float32Array(Math.max(count, 1) * BODY_FLOATS);
    for (let k = 0; k < count; k++) {
      const i = first + k;
      const o = k * BODY_FLOATS;
      data.set(s.pose.subarray(i * 4, i * 4 + 3), o);
      data[o + 3] = s.props[i * 4];
      data.set(s.initial.subarray(i * 4, i * 4 + 4), o + 4);
      data.set(s.inertial.subarray(i * 4, i * 4 + 4), o + 8);
      data.set(s.velocity.subarray(i * 4, i * 4 + 4), o + 12);
      data.set(s.prevVelocity.subarray(i * 4, i * 4 + 4), o + 16);
      data.set(s.shape.subarray(i * 4, i * 4 + 4), o + 20);
    }
    this.device.queue.writeBuffer(this.bodyBuffer, first * BODY_FLOATS * 4, data);
    this.staticsDirty = true;
  }

  private uploadJoints(first: number, count: number): void {
    if (count === 0) return;
    const s = this.topology;
    const out = new Float32Array(count * JOINT_FLOATS);
    for (let k = 0; k < count; k++) {
      const src = (first + k) * CS;
      const dst = k * JOINT_FLOATS;
      for (let r = 0; r < 3; r++) {
        out[dst + J_PEN + r] = s.data[src + PEN + r];
        out[dst + J_LAM + r] = s.data[src + LAM + r];
        out[dst + J_STIFF + r] = finite(s.data[src + STIFF + r]);
        out[dst + J_FMIN + r] = finite(s.data[src + FMIN + r]);
        out[dst + J_FMAX + r] = finite(s.data[src + FMAX + r]);
        out[dst + J_FRAC + r] = finite(s.data[src + FRAC + r]);
        out[dst + J_C0 + r] = s.data[src + C0 + r];
      }
      out[dst + J_ANCHORS] = s.data[src + RA];
      out[dst + J_ANCHORS + 1] = s.data[src + RA + 1];
      out[dst + J_ANCHORS + 2] = s.data[src + RB];
      out[dst + J_ANCHORS + 3] = s.data[src + RB + 1];
      out[dst + J_PARAM] = s.data[src + P0];
      out[dst + J_PARAM + 1] = s.data[src + P1];
    }
    this.device.queue.writeBuffer(this.jointBuffer, first * JOINT_FLOATS * 4, out);
    this.device.queue.writeBuffer(this.infoBuffer, first * 16, s.info, first * INFO_STRIDE, count * INFO_STRIDE);
  }

  /** Broadphase configuration (cell size, large bodies) and the sorted no-collide list. */
  private uploadStatics(): void {
    const s = this.topology;
    const n = this.bodyCount;
    const radii = Float64Array.from({ length: n }, (_, i) => s.props[i * 4 + 1]).sort();
    const median = n > 0 ? radii[n >> 1] : 1;
    let maxSmall = 0;
    for (let i = 0; i < n; i++) if (radii[i] <= LARGE_FACTOR * median) maxSmall = Math.max(maxSmall, radii[i]);
    // The GPU recomputes each radius in f32, so a threshold equal to a body's radius could
    // classify that body as large there and small here, dropping it from both the grid and
    // the large list (it happened: Box Rain lost every pair of its largest small box). Put
    // the threshold midway to the next radius up, and pad the cell size, so noise can't flip it.
    let minLarge = Infinity;
    for (let i = 0; i < n; i++) if (radii[i] > maxSmall) minLarge = Math.min(minLarge, radii[i]);
    const threshold = minLarge === Infinity ? maxSmall * 1.5 : (maxSmall + minLarge) / 2;
    this.maxSmallRadius = threshold;
    // A cell of 2·maxSmall puts every overlapping pair of small bodies in the same or an
    // adjacent cell (same choice as the CPU grid)
    this.cellSize = Math.max(2 * maxSmall * (1 + 1e-4), 1e-3);
    const large: number[] = [];
    for (let i = 0; i < n; i++) if (s.props[i * 4 + 1] > threshold) large.push(i);

    // No-collide entries (hi, lo, joint slot or 0xffffffff for IgnoreCollision), sorted
    const entries: [number, number, number][] = [];
    for (let c = 0; c < s.jointCount; c++) {
      const a = s.info[c * INFO_STRIDE + 1];
      const b = s.info[c * INFO_STRIDE + 2];
      if (a >= 0) entries.push([Math.max(a, b), Math.min(a, b), c]);
    }
    for (const key of s.ignoredPairs()) {
      const hi = Math.floor(key / PAIR_SHIFT);
      entries.push([hi, key - hi * PAIR_SHIFT, 0xffffffff]);
    }
    entries.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    this.largeCount = large.length;
    this.noCollideCount = entries.length;
    const data = new Uint32Array(Math.max(large.length + 3 * entries.length, 4));
    data.set(large, 0);
    entries.forEach((e, k) => data.set(e, large.length + 3 * k));
    if (this.staticBuffer!.size < data.byteLength) {
      this.staticBuffer!.destroy();
      this.staticBuffer = this.device.createBuffer({ label: 'statics', size: data.byteLength, usage: storageUsage() });
      this.rebuildBindings();
    }
    this.device.queue.writeBuffer(this.staticBuffer!, 0, data);
    this.staticsDirty = false;
  }

  /**
   * Validation hook: make the GPU state equal to a CPU solver's, including its contacts (as
   * this step's warm-start source) and colouring, so the next GPU step can be diffed against
   * the next CPU step. Bodies and joints must already come from `soa` (pass it as topology).
   */
  seedContactsFrom(soa: SoaSolver2D): void {
    const n = soa.contactCount;
    if (n > this.contactCapacity) throw new Error('seedContactsFrom: too many contacts');
    const words = new ArrayBuffer(Math.max(n, 1) * CONTACT_WORDS * 4);
    const u = new Uint32Array(words);
    const f = new Float32Array(words);
    for (let k = 0; k < n; k++) {
      const c = soa.jointCount + k;
      const src = c * CS;
      const o = k * CONTACT_WORDS;
      u[o] = soa.info[c * INFO_STRIDE + 1];
      u[o + 1] = soa.info[c * INFO_STRIDE + 2];
      u[o + 2] = soa.info[c * INFO_STRIDE + 3];
      u[o + 3] = soa.data[src + STICK] ? 1 : 0;
      f.set([soa.data[src + PEN], soa.data[src + PEN + 1], soa.data[src + LAM], soa.data[src + LAM + 1]], o + 4);
      f.set([soa.data[src + RA], soa.data[src + RA + 1], soa.data[src + RB], soa.data[src + RB + 1]], o + 8);
      f.set([soa.data[src + C0], soa.data[src + C0 + 1], soa.data[src + P1], soa.data[src + P2]], o + 12);
      f[o + 16] = soa.data[src + P0];
    }
    // The next step reads last step's contacts from the buffer it does not write
    this.device.queue.writeBuffer(this.contactBuffers[1 - this.parity], 0, words);
    const counters = new Uint32Array(COUNTER_WORDS);
    counters[C_CONTACTS] = n;
    this.device.queue.writeBuffer(this.counterBuffer, 0, counters);
    const colors = Uint32Array.from({ length: this.bodyCount }, (_, i) => (soa.coloring.colors[i] ?? -1) < 0 ? NO_COLOR : soa.coloring.colors[i]);
    this.device.queue.writeBuffer(this.colorBuffer, 0, colors);
  }

  // --- Scene edits -----------------------------------------------------------------------------

  /** Append a body (refused beyond the capacity). Returns its index or -1. */
  addBody(size: [number, number], density: number, friction: number, pose: [number, number, number], velocity: [number, number, number]): number {
    if (this.bodyCount >= this.bodyCapacity) return -1;
    const i = this.topology.addBody(size, density, friction, pose, velocity);
    this.bodyCount = this.topology.bodyCount;
    this.uploadBodies(i, 1);
    this.device.queue.writeBuffer(this.colorBuffer, i * 4, new Uint32Array([NO_COLOR]));
    this.adjScan!.destroy();
    this.adjScan = new PrefixScan(this.device, this.adjBuffer!, 0, this.bodyCount + 1);
    return i;
  }

  /**
   * Add a joint (bodyA = -1 attaches bodyB to the world point rA) without disturbing the GPU
   * state of existing constraints. Returns its slot.
   */
  appendJoint(a: number, b: number, rA: [number, number], rB: [number, number], stiffness: [number, number, number], fracture = Infinity): number {
    const s = this.topology;
    if (s.contactCount > 0) throw new Error('appendJoint: the CPU mirror must not hold contacts');
    const slot = s.addJoint(a, b, rA, rB, stiffness, fracture).slot;
    if (slot >= this.jointCapacity) this.allocateJoints(Math.max(slot + 1, this.jointCapacity * 2));
    this.jointCount = slot + 1;
    this.uploadJoints(slot, 1);
    if (a >= 0) this.staticsDirty = true;
    return slot;
  }

  /** Move the world anchor of a world joint (the mouse drag). */
  setWorldAnchor(slot: number, x: number, y: number): void {
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_ANCHORS) * 4, new Float32Array([x, y]));
  }

  /** Stop a joint acting: zero its penalty, lambda and stiffness (contiguous vec4s). */
  disableConstraint(slot: number): void {
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_PEN) * 4, new Float32Array(12));
    this.topology.data.fill(0, slot * CS + STIFF, slot * CS + STIFF + 3);
  }

  // --- Step ------------------------------------------------------------------------------------

  /**
   * Time the next step's phases on the GPU (timestamp queries). Ignored without
   * 'timestamp-query' or while a previous profile is still being read back.
   */
  profileNextStep(callback: (profile: StepProfile) => void): void {
    if (this.timing && !this.timingBusy) this.timingCallback = callback;
  }

  private writeParams(alpha: number, postStabilize: boolean): void {
    const p = this.params;
    const cap = this.bodyCapacity;
    const buf = new ArrayBuffer(PARAM_WORDS * 4);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.dt;
    f[1] = p.gravity;
    f[2] = p.beta;
    f[3] = p.gamma;
    f[4] = alpha;
    f[5] = p.vbdStiffness;
    u[6] =
      (p.vbd ? FLAG_VBD : 0) |
      (p.stiffnessRescale ? FLAG_RESCALE : 0) |
      (postStabilize ? FLAG_POST_STABILIZE : 0) |
      (p.matchNearest ? FLAG_MATCH_NEAREST : 0);
    u[7] = this.bodyCount;
    u[8] = this.jointCount;
    u[9] = this.colorCap;
    f[10] = this.cellSize;
    u[11] = this.tableSize - 1;
    f[12] = this.maxSmallRadius;
    u[13] = this.largeCount;
    u[14] = this.noCollideCount;
    u[15] = this.pairCapacity;
    u[16] = this.contactCapacity;
    u[17] = this.hashSize - 1;
    u[18] = cap + 1; // adjFillOffset
    u[19] = 2 * cap + 1; // adjListOffset
    u[20] = this.tableSize + 1; // gridCursorOffset
    u[21] = 2 * this.tableSize + 1; // gridSortedOffset
    u[22] = 2 * this.tableSize + 1 + cap; // gridCellOffset
    u[23] = cap; // stateBOffset
    u[24] = this.colorHistOffset;
    u[25] = 2 * cap; // colorStartOffset
    u[26] = this.colorGroups;
    u[27] = 2 * cap + 65; // colorBodiesOffset
    u[28] = this.colorRounds;
    this.device.queue.writeBuffer(this.paramsBuffer, 0, buf);
  }

  /** Pass constants: per iteration, one entry per colour (primal), then one for the duals. */
  private writePassConstants(totalIterations: number, alphaFor: (it: number) => number): void {
    const perIteration = this.colorCap + 1;
    const entries = totalIterations * perIteration;
    if (entries > this.passEntries || !this.passGroup) {
      this.passBuffer?.destroy();
      this.passBuffer = this.device.createBuffer({ label: 'pass constants', size: entries * PASS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passEntries = entries;
      this.passGroup = this.device.createBindGroup({ layout: this.layouts.pass, entries: [{ binding: 0, resource: { buffer: this.passBuffer, size: 16 } }] });
    }
    const data = new ArrayBuffer(entries * PASS_STRIDE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);
    for (let it = 0; it < totalIterations; it++) {
      for (let col = 0; col <= this.colorCap; col++) {
        const w = ((it * perIteration + col) * PASS_STRIDE) / 4;
        u32[w] = col;
        f32[w + 1] = alphaFor(it);
      }
    }
    this.device.queue.writeBuffer(this.passBuffer!, 0, data);
  }

  step(): void {
    if (this.staticsDirty) this.uploadStatics();
    const p = this.params;
    const postStabilize = p.postStabilize && !p.vbd;
    const alpha = p.vbd ? 0 : p.alpha;
    const totalIterations = p.iterations + (postStabilize ? 1 : 0);
    this.writeParams(alpha, postStabilize);
    this.writePassConstants(totalIterations, (it) => (postStabilize ? (it < p.iterations ? 1 : 0) : alpha));

    const cur = this.parity;
    const cap = this.bodyCapacity;
    const N = this.bodyCount;
    const J = this.jointCount;
    const encoder = this.device.createCommandEncoder({ label: 'avbd2d step' });
    // Per-step scratch: grid counts and cursors, hash table, degrees and fill counts, colour counts
    encoder.clearBuffer(this.gridBuffer, 0, (2 * this.tableSize + 1) * 4);
    encoder.clearBuffer(this.tableBuffer);
    encoder.clearBuffer(this.adjBuffer!, 0, (2 * cap + 1) * 4);

    const timed = this.timingCallback !== null && this.timing !== null;
    let pass!: GPUComputePassEncoder;
    let phase = 0;
    const split = timed || this.splitPasses;
    const beginPhase = () => {
      if (pass && !split) return;
      pass?.end();
      pass = encoder.beginComputePass({
        label: split ? PHASES[phase] : 'avbd2d step',
        timestampWrites: timed ? { querySet: this.timing!.querySet, beginningOfPassWriteIndex: 2 * phase, endOfPassWriteIndex: 2 * phase + 1 } : undefined,
      });
      phase++;
    };
    const G = this.groups;
    const run = (name: string, group: GPUBindGroup, x: number) => {
      if (x <= 0) return;
      pass.setPipeline(this.pipes[name]);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(x);
    };
    const runIndirect = (name: string, group: GPUBindGroup, argsWord: number) => {
      pass.setPipeline(this.pipes[name]);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroupsIndirect(this.argsBuffer, argsWord * 4);
    };

    // Collision: previous contacts into the hash table, grid, pairs, narrowphase
    beginPhase();
    run('beginFrame', G.broad, 1);
    run('argsPrev', G.args, 1);
    runIndirect('hashInsert', G.contacts[cur], IA_PREV);
    run('gridCount', G.broad, groups(N));
    this.gridScan.encode(pass);
    run('gridScatter', G.broad, groups(N));
    run('findPairs', G.broad, groups(N));
    run('argsPairs', G.args, 1);
    runIndirect('narrowphase', G.contacts[cur], IA_PAIRS);
    run('argsContacts', G.args, 1);

    // Adjacency
    beginPhase();
    run('degreeJoints', G.topo[cur], groups(J));
    runIndirect('degreeContacts', G.topo[cur], IA_CONTACTS);
    this.adjScan!.encode(pass);
    run('fillJoints', G.topo[cur], groups(J));
    runIndirect('fillContacts', G.topo[cur], IA_CONTACTS);
    run('sortAdjacency', G.topo[cur], groups(N));

    // Colouring
    beginPhase();
    run('colorCompact', G.topo[cur], groups(N));
    run('colorMark', G.topo[cur], groups(N));
    for (let r = 0; r < this.colorRounds; r++) run(r % 2 === 0 ? 'colorRoundAB' : 'colorRoundBA', G.topo[cur], groups(N));
    run('colorCount', G.topo[cur], this.colorGroups);
    this.colorHistScan.encode(pass);
    run('colorStarts', G.topo[cur], 1);
    run('argsColors', G.args, 1);
    run('colorScatter', G.topo[cur], this.colorGroups);

    // Solve
    beginPhase();
    const perIteration = this.colorCap + 1;
    const setPass = (entry: number) => pass.setBindGroup(1, this.passGroup!, [entry * PASS_STRIDE]);
    pass.setBindGroup(0, G.solve[cur]);
    setPass(0);
    if (J > 0) {
      pass.setPipeline(this.pipes.warmStartJoints);
      pass.dispatchWorkgroups(groups(J));
    }
    pass.setPipeline(this.pipes.warmStartBodies);
    pass.dispatchWorkgroups(groups(N));
    for (let it = 0; it < totalIterations; it++) {
      const scan = this.primalMode === 'scan';
      pass.setPipeline(scan ? this.pipes.primalScan : this.pipes.primal);
      for (let col = 0; col < this.colorCap; col++) {
        setPass(it * perIteration + col);
        if (scan) pass.dispatchWorkgroups(groups(N));
        else pass.dispatchWorkgroupsIndirect(this.argsBuffer, (IA_COLOR + 3 * col) * 4);
      }
      if (it < p.iterations) {
        // One dual pass over joints and contacts together
        setPass(it * perIteration + this.colorCap);
        pass.setPipeline(this.pipes.dual);
        pass.dispatchWorkgroupsIndirect(this.argsBuffer, IA_CONSTRAINTS * 4);
      }
      if (it === p.iterations - 1) {
        pass.setPipeline(this.pipes.updateVelocities);
        pass.dispatchWorkgroups(groups(N));
      }
    }
    if (postStabilize) {
      pass.setPipeline(this.pipes.refreshStick);
      pass.dispatchWorkgroupsIndirect(this.argsBuffer, IA_CONTACTS * 4);
    }
    pass.end();

    const stamps = 2 * PHASES.length;
    if (timed) {
      const { querySet, resolve, read } = this.timing!;
      encoder.resolveQuerySet(querySet, 0, stamps, resolve, 0);
      encoder.copyBufferToBuffer(resolve, 0, read, 0, stamps * 8);
    }
    this.device.queue.submit([encoder.finish()]);
    this.parity = 1 - cur;

    if (timed) {
      const callback = this.timingCallback!;
      this.timingCallback = null;
      this.timingBusy = true;
      const read = this.timing!.read;
      void read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(read.getMappedRange()).slice();
        read.unmap();
        this.timingBusy = false;
        const ms = (a: number, b: number) => Number(t[b] - t[a]) / 1e6;
        const profile = { total: ms(0, stamps - 1) } as StepProfile;
        PHASES.forEach((name, i) => (profile[name] = ms(2 * i, 2 * i + 1)));
        callback(profile);
      });
    }
  }

  // --- Readback ----------------------------------------------------------------------------------

  async readBodies(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.bodyBuffer, this.bodyCount * BODY_FLOATS * 4));
  }

  async readJoints(): Promise<Float32Array> {
    return new Float32Array(await this.read(this.jointBuffer, this.jointCount * JOINT_FLOATS * 4));
  }

  async readCounters(): Promise<GpuCounters> {
    const c = new Uint32Array(await this.read(this.counterBuffer, COUNTER_WORDS * 4));
    return { pairs: c[C_PAIRS], contacts: c[C_CONTACTS], overflow: c[C_OVERFLOW], clashes: c[C_CLASHES], colors: c[C_NUM_COLORS] };
  }

  /** Contacts written by the last step (CONTACT_WORDS words each; ids are u32, the rest f32). */
  async readContacts(): Promise<ArrayBuffer> {
    const { contacts } = await this.readCounters();
    const n = Math.min(contacts, this.contactCapacity);
    return this.read(this.contactBuffers[1 - this.parity], n * CONTACT_WORDS * 4);
  }

  /** Pairs found by the last step's broadphase (bodyA > bodyB), unordered. */
  async readPairs(): Promise<Uint32Array> {
    const { pairs } = await this.readCounters();
    return new Uint32Array(await this.read(this.pairBuffer, Math.min(pairs, this.pairCapacity) * 8));
  }

  /** Final colour of each body (NO_COLOR for static bodies). */
  async readColors(): Promise<Uint32Array> {
    return new Uint32Array(await this.read(this.colorBuffer, this.bodyCount * 4));
  }

  /** The adjacency CSR from the last step: start[bodies + 1] and the constraint ids. */
  async readAdjacency(): Promise<{ start: Uint32Array; list: Uint32Array }> {
    const words = new Uint32Array(await this.read(this.adjBuffer!, this.adjBuffer!.size));
    const start = words.slice(0, this.bodyCount + 1);
    const listOffset = 2 * this.bodyCapacity + 1;
    return { start, list: words.slice(listOffset, listOffset + start[this.bodyCount]) };
  }

  /**
   * Adapt the colour cap and pair/contact capacity to what the GPU reported (pass a recent
   * counters readback; changes apply from the next step).
   */
  adapt(counters: GpuCounters): void {
    // Colour cap = colours in use + 2. Each colour below the cap costs one (possibly empty)
    // primal dispatch per iteration (~12 µs each on an M4 Max), so keep it tight: grow at once
    // when the colouring runs into it, shrink only after three quiet readbacks.
    const used = counters.colors;
    if (counters.clashes > 0 || used >= this.colorCap - 1) {
      this.colorCap = Math.min(MAX_COLORS, Math.max(used + 4, this.colorCap + 4));
      this.shrinkVotes = 0;
    } else if (used + 2 < this.colorCap) {
      if (++this.shrinkVotes >= 3) {
        this.colorCap = Math.min(MAX_COLORS, Math.max(4, used + 2));
        this.shrinkVotes = 0;
      }
    } else {
      this.shrinkVotes = 0;
    }
    const contactsFull = (counters.overflow & 2) !== 0 || counters.contacts > 0.8 * this.contactCapacity;
    const pairsFull = (counters.overflow & 1) !== 0 || counters.pairs > 0.8 * this.pairCapacity;
    const contacts = this.contactCapacity * (contactsFull ? 2 : 1);
    const pairs = this.pairCapacity * (pairsFull ? 2 : 1);
    if ((contactsFull || pairsFull) && this.capacityCanGrow(contacts, pairs)) this.allocateContacts(contacts, pairs);
  }

  /** Whether a reallocation to these capacities would actually grow anything (limits apply). */
  private capacityCanGrow(contacts: number, pairs: number): boolean {
    const maxBinding = this.device.limits.maxStorageBufferBindingSize;
    const maxContacts = Math.min(Math.floor(maxBinding / (CONTACT_WORDS * 4)), Math.floor(maxBinding / 16));
    return Math.min(contacts, maxContacts) > this.contactCapacity || Math.min(pairs, Math.floor(maxBinding / 8)) > this.pairCapacity;
  }

  /** Kinetic energy, hard-joint error and live joint count, from a readback (async, slow). */
  /** Kinetic energy and joint stats, from `poses` (a readBodies result) if given. */
  async readStats(poses?: Float32Array): Promise<{ kineticEnergy: number; maxJointError: number; joints: number }> {
    const [bodies, joints] = await Promise.all([poses ?? this.readBodies(), this.readJoints()]);
    let kineticEnergy = 0;
    for (let i = 0; i < this.bodyCount; i++) {
      const o = i * BODY_FLOATS;
      const mass = bodies[o + 22];
      const vx = bodies[o + 12], vy = bodies[o + 13], w = bodies[o + 14];
      if (mass > 0) kineticEnergy += 0.5 * mass * (vx * vx + vy * vy) + 0.5 * bodies[o + 23] * w * w;
    }
    // Same metric as ref/metrics.ts: largest anchor separation of any hard joint row
    let maxJointError = 0;
    let live = 0;
    const info = this.topology.info;
    const worldPoint = (b: number, x: number, y: number): [number, number] => {
      const o = b * BODY_FLOATS;
      const c = Math.cos(bodies[o + 2]);
      const s = Math.sin(bodies[o + 2]);
      return [c * x - s * y + bodies[o], s * x + c * y + bodies[o + 1]];
    };
    for (let c = 0; c < this.jointCount; c++) {
      if (info[c * INFO_STRIDE] !== T_JOINT) continue;
      const o = c * JOINT_FLOATS;
      if (joints[o + J_STIFF] === 0 && joints[o + J_STIFF + 1] === 0 && joints[o + J_STIFF + 2] === 0) continue;
      live++;
      const a = info[c * INFO_STRIDE + 1];
      const b = info[c * INFO_STRIDE + 2];
      const pa = a >= 0 ? worldPoint(a, joints[o + J_ANCHORS], joints[o + J_ANCHORS + 1]) : [joints[o + J_ANCHORS], joints[o + J_ANCHORS + 1]];
      const pb = worldPoint(b, joints[o + J_ANCHORS + 2], joints[o + J_ANCHORS + 3]);
      for (let r = 0; r < 2; r++) if (joints[o + J_STIFF + r] >= 1e30) maxJointError = Math.max(maxJointError, Math.abs(pa[r] - pb[r]));
    }
    return { kineticEnergy, maxJointError, joints: live };
  }

  private async read(buffer: GPUBuffer, size: number): Promise<ArrayBuffer> {
    if (size === 0) return new ArrayBuffer(0);
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    return out;
  }

  destroy(): void {
    if (this.ownsBodyBuffer) this.bodyBuffer.destroy();
    const buffers = [
      this.jointBuffer, this.infoBuffer, ...this.contactBuffers, this.pairBuffer, this.tableBuffer, this.gridBuffer, this.staticBuffer,
      this.counterBuffer, this.argsBuffer, this.adjBuffer, this.colorBuffer, this.paramsBuffer, this.passBuffer, this.timing?.resolve, this.timing?.read,
    ];
    for (const b of buffers) b?.destroy();
    this.timing?.querySet.destroy();
    this.gridScan.destroy();
    this.colorHistScan.destroy();
    this.adjScan?.destroy();
  }
}
