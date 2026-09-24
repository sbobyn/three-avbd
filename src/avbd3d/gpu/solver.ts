// WebGPU host code for the 3D AVBD solver. Same step structure as the 2D solver
// (../../avbd2d/gpu/solver.ts), whose colouring, adjacency, indirect-argument and prefix-scan
// kernels it shares:
//
//   clears → beginFrame → hashInsert(prev contacts) → grid count / scan / scatter → pairs
//   → narrowphase (+ warm start) → adjacency (degree / scan / fill)
//   → colouring (compact, mark, rounds, count, scan, scatter) → joint and body warm start
//   → iterations × (primal per colour, dual) → velocities
//
// Scenes are built with the 3D CPU reference (../ref) and loaded from it. The host keeps what
// the CPU owns: body shapes (broadphase configuration), joint endpoints and no-collide pairs.

import { makeArgsWGSL, ARGS_WORDS, BIG, COLOR_WG, C_CLASHES, C_CONTACTS, C_NUM_COLORS, C_OVERFLOW, C_PAIRS, COUNTER_WORDS, IA_COLOR, IA_CONSTRAINTS, IA_CONTACTS, IA_PAIRS, IA_PREV, MAX_COLORS, NO_COLOR, PASS_STRIDE, WORKGROUP_SIZE } from '../../avbd2d/gpu/layout.ts';
import { PrefixScan } from '../../avbd2d/gpu/scan.ts';
import { type GpuCounters, PHASES, type StepProfile } from '../../avbd2d/gpu/solver.ts';
import { makeTopologyWGSL } from '../../avbd2d/gpu/wgsl-topology.ts';
import type { Rigid } from '../ref/body.ts';
import { IgnoreCollision, Joint, Spring } from '../ref/forces.ts';
import { Manifold } from '../ref/manifold.ts';
import { defaultParams, type Solver, type SolverParams } from '../ref/solver.ts';
import {
  B_ANGVEL, B_MOMENT, B_POS, B_ROT, B_SIZE, B_VEL, BODY_FLOATS, CONTACT_WORDS, FLAG_FACE_BIAS, FLAG_MATCH_NEAREST, J_C0_ANG, J_C0_LIN, J_LAM_ANG,
  J_LAM_LIN, J_PEN_ANG, J_PEN_LIN, J_RA, J_RB, JOINT_FLOATS, PARAM_WORDS, PRELUDE_3D, SHAPE_BOX, SHAPE_SPHERE, T_JOINT, T_SPRING,
  TOPOLOGY_ACCESSORS_3D,
} from './layout.ts';
import { isSphere } from '../shapes.ts';
import { broadphaseWGSL, contactsWGSL } from './wgsl-collision.ts';
import { solveWGSL } from './wgsl-solve.ts';

export { PHASES, type GpuCounters, type StepProfile };

const finite = (x: number): number => (x === Infinity ? BIG : x === -Infinity ? -BIG : x);
const groups = (n: number): number => Math.ceil(n / WORKGROUP_SIZE);
const pow2AtLeast = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(n, 2)));

/** Byte size of a body buffer holding `n` bodies. */
export const bodyBufferSize = (n: number): number => Math.max(n, 1) * BODY_FLOATS * 4;

/**
 * Bodies with radius above LARGE_FACTOR × median radius are tested brute-force against every
 * body instead of sizing the grid cells, up to MAX_LARGE of the largest (each costs a test
 * per body). Showcase balls are ~3x the median brick; at the 2D factor of 4 they set 4 m
 * cells and the wall-smash broadphase took most of an 8 ms step.
 */
const LARGE_FACTOR = 2;
const MAX_LARGE = 64;

/** GPU solver parameters: the reference's, plus nearest-anchor warm starts (see 2D findings). */
export interface GpuParams3D extends SolverParams {
  /** Warm-start unmatched contacts from the pair's nearest previous contact (2D findings). */
  matchNearest: boolean;
  /** Box2D-style face-over-edge preference in the narrowphase (see wgsl-collision.ts). */
  faceBias: boolean;
}

export const gpuParams3D = (): GpuParams3D => ({ ...defaultParams(), matchNearest: true, faceBias: true });

export interface GpuSolverOptions {
  /** Pre-allocated body buffer (STORAGE | COPY_SRC | COPY_DST), e.g. one Three.js renders from. */
  bodyBuffer?: GPUBuffer;
  /** Bodies the buffers can hold (default: current count + 1024); a supplied buffer's size wins. */
  bodyCapacity?: number;
  /** Jones-Plassmann rounds per step (even). */
  colorRounds?: number;
  /** A/B timing of kernel variants: replacement WGSL for a module. */
  shaders?: { contacts?: string; solve?: string };
}

/** Per-body static data the host needs: broadphase radius and whether the body moves. */
interface BodyInfo {
  radius: number;
  dynamic: boolean;
  sphere: boolean;
  size: [number, number, number];
}

/** Evaluated lazily: under Node the WebGPU globals appear only once a device module loads. */
const storageUsage = () => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;

export class GpuSolver3D {
  readonly device: GPUDevice;
  readonly params: GpuParams3D = gpuParams3D();

  bodyCount = 0;
  readonly bodyCapacity: number;
  readonly bodies: BodyInfo[] = [];
  jointCount = 0;
  private jointCapacity = 0;
  /** Per joint slot: type, bodyA (-1 = world), bodyB, 0. */
  private info = new Int32Array(0);
  /** IgnoreCollision pairs as [hi, lo]. */
  private readonly ignored: [number, number][] = [];
  pairCapacity = 0;
  contactCapacity = 0;
  /** Colours the colouring may use and the solver dispatches (grows via `adapt`). */
  colorCap = 12;
  /**
   * Validation: when set, bodies take these colours (primal passes run in colour order) and
   * the colouring kernels are skipped. See `sequentialColors`.
   */
  fixedColors: Uint32Array<ArrayBuffer> | null = null;
  /** Encode each phase as its own compute pass even when not profiling. */
  splitPasses = false;
  private shrinkVotes = 0;
  readonly colorRounds: number;

  private get colorHistOffset(): number {
    return 3 * this.bodyCapacity + 65;
  }

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

  private readonly timing: { querySet: GPUQuerySet; resolve: GPUBuffer; read: GPUBuffer } | null;
  private timingCallback: ((profile: StepProfile) => void) | null = null;
  private timingBusy = false;

  constructor(device: GPUDevice, ref: Solver, options: GpuSolverOptions = {}) {
    this.device = device;
    const { dt, gravity, iterations, alpha, betaLin, betaAng, gamma } = ref;
    Object.assign(this.params, { dt, gravity, iterations, alpha, betaLin, betaAng, gamma });
    this.bodyCount = ref.bodies.length;
    this.colorRounds = options.colorRounds ?? 16;

    this.ownsBodyBuffer = !options.bodyBuffer;
    this.bodyCapacity = options.bodyBuffer
      ? Math.floor(options.bodyBuffer.size / (BODY_FLOATS * 4))
      : Math.max(options.bodyCapacity ?? this.bodyCount + 1024, this.bodyCount, 1);
    if (this.bodyCapacity < this.bodyCount) throw new Error('body buffer too small');
    this.bodyBuffer = options.bodyBuffer ?? device.createBuffer({ label: 'bodies 3d', size: bodyBufferSize(this.bodyCapacity), usage: storageUsage() });

    const cap = this.bodyCapacity;
    this.tableSize = pow2AtLeast(2 * cap);
    this.gridBuffer = device.createBuffer({ label: 'grid 3d', size: (2 * this.tableSize + 1 + 4 * cap) * 4, usage: storageUsage() });
    this.counterBuffer = device.createBuffer({ label: 'counters', size: COUNTER_WORDS * 4, usage: storageUsage() });
    this.argsBuffer = device.createBuffer({ label: 'indirect args', size: ARGS_WORDS * 4, usage: storageUsage() | GPUBufferUsage.INDIRECT });
    this.colorGroups = Math.ceil(cap / COLOR_WG);
    this.colorBuffer = device.createBuffer({ label: 'colours', size: (3 * cap + 65 + MAX_COLORS * this.colorGroups + 1) * 4, usage: storageUsage() });
    this.paramsBuffer = device.createBuffer({ label: 'params 3d', size: PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
    this.createPipelines(options.shaders ?? {});
    this.gridScan = new PrefixScan(device, this.gridBuffer, 0, this.tableSize + 1);
    this.colorHistScan = new PrefixScan(device, this.colorBuffer, this.colorHistOffset, MAX_COLORS * this.colorGroups + 1);

    // Joints and springs in the reference's creation order; IgnoreCollision only filters pairs
    const index = new Map<Rigid, number>(ref.bodies.map((b, i) => [b, i]));
    const joints = ref.forces.filter((f): f is Joint | Spring => f instanceof Joint || f instanceof Spring);
    for (const f of ref.forces) {
      if (!(f instanceof IgnoreCollision)) continue;
      const a = index.get(f.bodyA!)!;
      const b = index.get(f.bodyB)!;
      this.ignored.push([Math.max(a, b), Math.min(a, b)]);
    }
    this.allocateJoints(joints.length + 256);
    for (const f of joints) this.writeJoint(this.jointCount++, f, index);
    this.allocateContacts(Math.max(4096, 8 * cap));
    this.writeBodies(0, ref.bodies);
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
      broad: layout('broadphase 3d', [U, R, W, W, W, R, R]),
      contacts: layout('contacts 3d', [U, R, R, W, R, W, W]),
      topo: layout('topology 3d', [U, R, R, R, R, W, W, W]),
      solve: layout('solve 3d', [U, W, W, R, W, R, R, R]),
      pass: d.createBindGroupLayout({
        label: 'pass',
        entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 16 } }],
      }),
      args: layout('args 3d', [U, R, R, W]),
    };
  }

  private createPipelines(shaders: NonNullable<GpuSolverOptions['shaders']>): void {
    const d = this.device;
    const make = (code: string, layouts: GPUBindGroupLayout[], entries: string[]) => {
      const module = d.createShaderModule({ code });
      const layout = d.createPipelineLayout({ bindGroupLayouts: layouts });
      for (const entryPoint of entries) this.pipes[entryPoint] = d.createComputePipeline({ label: entryPoint, layout, compute: { module, entryPoint } });
    };
    const L = this.layouts;
    make(broadphaseWGSL, [L.broad], ['beginFrame', 'gridCount', 'gridScatter', 'findPairs']);
    make(shaders.contacts ?? contactsWGSL, [L.contacts], ['hashInsert', 'narrowphase']);
    make(makeTopologyWGSL(PRELUDE_3D, TOPOLOGY_ACCESSORS_3D), [L.topo], [
      'degreeJoints', 'degreeContacts', 'fillJoints', 'fillContacts',
      'colorCompact', 'colorMark', 'colorRoundAB', 'colorRoundBA', 'colorCount', 'colorStarts', 'colorScatter',
    ]);
    make(shaders.solve ?? solveWGSL, [L.solve, L.pass], ['warmStartJoints', 'warmStartBodies', 'primal', 'dual', 'updateVelocities']);
    make(makeArgsWGSL(PRELUDE_3D), [L.args], ['argsPrev', 'argsPairs', 'argsContacts', 'argsColors']);
  }

  private allocateJoints(capacity: number): void {
    const d = this.device;
    const joints = d.createBuffer({ label: 'joints 3d', size: Math.max(capacity, 1) * JOINT_FLOATS * 4, usage: storageUsage() });
    const infoBuffer = d.createBuffer({ label: 'joint info', size: Math.max(capacity, 1) * 16, usage: storageUsage() });
    if (this.jointBuffer) {
      const encoder = d.createCommandEncoder();
      encoder.copyBufferToBuffer(this.jointBuffer, 0, joints, 0, this.jointCapacity * JOINT_FLOATS * 4);
      encoder.copyBufferToBuffer(this.infoBuffer, 0, infoBuffer, 0, this.jointCapacity * 16);
      d.queue.submit([encoder.finish()]);
      this.jointBuffer.destroy();
      this.infoBuffer.destroy();
    }
    const info = new Int32Array(capacity * 4);
    info.set(this.info.subarray(0, Math.min(this.info.length, info.length)));
    this.info = info;
    this.jointBuffer = joints;
    this.infoBuffer = infoBuffer;
    this.jointCapacity = capacity;
    if (this.contactBuffers) this.rebuildBindings();
  }

  /**
   * (Re)allocate pair and contact storage. When growing, both contact buffers are copied over
   * and the counters are left alone, so warm starts survive the reallocation.
   */
  private allocateContacts(requested: number, requestedPairs = requested): void {
    const d = this.device;
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
      d.createBuffer({ label: `contacts 3d ${i}`, size: capacity * CONTACT_WORDS * 4, usage: storageUsage() }),
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

  /** Pack reference bodies into GPU records and upload them in one write, starting at `first`. */
  private writeBodies(first: number, bodies: Rigid[]): void {
    const f = new Float32Array(Math.max(bodies.length, 1) * BODY_FLOATS);
    bodies.forEach((b, k) => {
      const o = k * BODY_FLOATS;
      f.set(b.positionLin, o + B_POS);
      f[o + B_POS + 3] = b.friction;
      f.set(b.positionAng, o + B_ROT);
      f.set(b.size, o + B_SIZE);
      f[o + B_SIZE + 3] = b.mass;
      f.set(b.moment, o + B_MOMENT);
      f[o + B_MOMENT + 3] = b.radius;
      f.set(b.initialLin, o + 16);
      f.set(b.initialAng, o + 20);
      f.set(b.inertialLin, o + 24);
      f.set(b.inertialAng, o + 28);
      f.set(b.velocityLin, o + B_VEL);
      f[o + B_VEL + 3] = b.prevVelocityLin[2];
      f.set(b.velocityAng, o + B_ANGVEL);
      const sphere = isSphere(b);
      f[o + B_ANGVEL + 3] = sphere ? SHAPE_SPHERE : SHAPE_BOX;
      this.bodies[first + k] = { radius: b.radius, dynamic: b.mass > 0, sphere, size: [b.size[0], b.size[1], b.size[2]] };
    });
    this.device.queue.writeBuffer(this.bodyBuffer, first * BODY_FLOATS * 4, f, 0, bodies.length * BODY_FLOATS);
    this.staticsDirty = true;
  }

  /** Upload a joint or spring (with its warm-start state) into `slot`. */
  private writeJoint(slot: number, f: Joint | Spring, index: Map<Rigid, number>): void {
    const o = new Float32Array(JOINT_FLOATS);
    const a = f.bodyA ? index.get(f.bodyA)! : -1;
    const b = index.get(f.bodyB)!;
    if (f instanceof Joint) {
      o.set(f.penaltyLin, J_PEN_LIN);
      o[J_PEN_LIN + 3] = finite(f.broken ? 0 : f.stiffnessLin);
      o.set(f.penaltyAng, J_PEN_ANG);
      o[J_PEN_ANG + 3] = finite(f.broken ? 0 : f.stiffnessAng);
      o.set(f.lambdaLin, J_LAM_LIN);
      o[J_LAM_LIN + 3] = finite(f.fracture);
      o.set(f.lambdaAng, J_LAM_ANG);
      o[J_LAM_ANG + 3] = f.torqueArm;
      o.set(f.C0Lin, J_C0_LIN);
      o.set(f.C0Ang, J_C0_ANG);
      o.set(f.rA, J_RA);
      o.set(f.rB, J_RB);
    } else {
      o[J_PEN_LIN + 3] = f.stiffness;
      o.set(f.rA, J_RA);
      o[J_RA + 3] = f.rest;
      o.set(f.rB, J_RB);
    }
    this.info.set([f instanceof Joint ? T_JOINT : T_SPRING, a, b, 0], slot * 4);
    this.device.queue.writeBuffer(this.jointBuffer, slot * JOINT_FLOATS * 4, o);
    this.device.queue.writeBuffer(this.infoBuffer, slot * 16, this.info, slot * 4, 4);
    if (a >= 0) this.staticsDirty = true;
  }

  /** Broadphase configuration (cell size, large bodies) and the sorted no-collide list. */
  private uploadStatics(): void {
    const n = this.bodyCount;
    const radii = Float64Array.from({ length: n }, (_, i) => this.bodies[i].radius).sort();
    const median = n > 0 ? radii[n >> 1] : 1;
    let maxSmall = 0;
    for (let i = 0; i < n; i++) if (radii[i] <= LARGE_FACTOR * median) maxSmall = Math.max(maxSmall, radii[i]);
    // Beyond MAX_LARGE candidates, the rest stay small (and size the cells)
    if (n > MAX_LARGE) maxSmall = Math.max(maxSmall, radii[n - MAX_LARGE - 1]);
    // Threshold midway to the next radius up, so f32 noise can't flip a body's class
    let minLarge = Infinity;
    for (let i = 0; i < n; i++) if (radii[i] > maxSmall) minLarge = Math.min(minLarge, radii[i]);
    const threshold = minLarge === Infinity ? maxSmall * 1.5 : (maxSmall + minLarge) / 2;
    this.maxSmallRadius = threshold;
    this.cellSize = Math.max(2 * maxSmall * (1 + 1e-4), 1e-3);
    const large: number[] = [];
    for (let i = 0; i < n; i++) if (this.bodies[i].radius > threshold) large.push(i);

    // No-collide entries (hi, lo, joint slot or 0xffffffff for IgnoreCollision), sorted
    const entries: [number, number, number][] = [];
    for (let c = 0; c < this.jointCount; c++) {
      const a = this.info[c * 4 + 1];
      const b = this.info[c * 4 + 2];
      if (a >= 0) entries.push([Math.max(a, b), Math.min(a, b), c]);
    }
    for (const [hi, lo] of this.ignored) entries.push([hi, lo, 0xffffffff]);
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
   * Validation hook: make the GPU state equal to the reference solver's mid-simulation, bodies,
   * joints (with warm-start state) and contacts (as the next step's warm-start source), so the
   * next GPU step can be diffed against the next reference step. The reference must be the one
   * this solver was built from, with no bodies or joints added since.
   */
  seedFrom(ref: Solver): void {
    const index = new Map<Rigid, number>(ref.bodies.map((b, i) => [b, i]));
    this.writeBodies(0, ref.bodies);
    let slot = 0;
    for (const f of ref.forces) if (f instanceof Joint || f instanceof Spring) this.writeJoint(slot++, f, index);
    if (slot !== this.jointCount) throw new Error('seedFrom: joints differ from the reference');

    const manifolds = ref.forces.filter((f): f is Manifold => f instanceof Manifold);
    const n = manifolds.reduce((sum, m) => sum + m.contacts.length, 0);
    if (n > this.contactCapacity) throw new Error('seedFrom: too many contacts');
    const words = new ArrayBuffer(Math.max(n, 1) * CONTACT_WORDS * 4);
    const u = new Uint32Array(words);
    const f = new Float32Array(words);
    let k = 0;
    for (const m of manifolds) {
      const a = index.get(m.bodyA!)!;
      const b = index.get(m.bodyB)!;
      for (const c of m.contacts) {
        const o = k++ * CONTACT_WORDS;
        u.set([a, b, c.feature >>> 0, c.stick ? 1 : 0], o);
        f.set([...c.penalty, m.friction, ...c.lambda, 0], o + 4);
        f.set([...c.rA, m.basis[0], ...c.rB, m.basis[1], ...c.C0, m.basis[2]], o + 12);
      }
    }
    // The next step reads last step's contacts from the buffer it does not write
    this.device.queue.writeBuffer(this.contactBuffers[1 - this.parity], 0, words);
    const counters = new Uint32Array(COUNTER_WORDS);
    counters[C_CONTACTS] = n;
    this.device.queue.writeBuffer(this.counterBuffer, 0, counters);
  }

  /**
   * Colours reproducing the reference's Gauss-Seidel order (newest dynamic body first, one
   * body per colour). Only for scenes with at most MAX_COLORS dynamic bodies.
   */
  sequentialColors(): Uint32Array<ArrayBuffer> {
    const colors = new Uint32Array(this.bodyCount).fill(NO_COLOR);
    let next = 0;
    for (let i = this.bodyCount - 1; i >= 0; i--) if (this.bodies[i].dynamic) colors[i] = next++;
    if (next > MAX_COLORS) throw new Error(`sequentialColors: ${next} dynamic bodies, at most ${MAX_COLORS}`);
    return colors;
  }

  // --- Scene edits -----------------------------------------------------------------------------

  /** Append a body (refused beyond the capacity). Returns its index or -1. */
  addBody(body: Rigid): number {
    if (this.bodyCount >= this.bodyCapacity) return -1;
    const i = this.bodyCount++;
    this.writeBodies(i, [body]);
    this.device.queue.writeBuffer(this.colorBuffer, i * 4, new Uint32Array([NO_COLOR]));
    this.adjScan!.destroy();
    this.adjScan = new PrefixScan(this.device, this.adjBuffer!, 0, this.bodyCount + 1);
    return i;
  }

  /** Append a joint between body indices (a = -1: world point rA) with fresh state. */
  appendJoint(a: number, b: number, rA: ArrayLike<number>, rB: ArrayLike<number>, stiffnessLin: number, stiffnessAng: number): number {
    const slot = this.jointCount;
    if (slot >= this.jointCapacity) this.allocateJoints(this.jointCapacity * 2);
    this.jointCount++;
    const o = new Float32Array(JOINT_FLOATS);
    o[J_PEN_LIN + 3] = finite(stiffnessLin);
    o[J_PEN_ANG + 3] = finite(stiffnessAng);
    o[J_LAM_LIN + 3] = BIG;
    o.set([rA[0], rA[1], rA[2]], J_RA);
    o.set([rB[0], rB[1], rB[2]], J_RB);
    // Torque arm as in the reference Joint constructor
    const sa = a >= 0 ? this.bodies[a].size : [0, 0, 0];
    const sb = this.bodies[b].size;
    o[J_LAM_ANG + 3] = (sa[0] + sb[0]) ** 2 + (sa[1] + sb[1]) ** 2 + (sa[2] + sb[2]) ** 2;
    this.info.set([T_JOINT, a, b, 0], slot * 4);
    this.device.queue.writeBuffer(this.jointBuffer, slot * JOINT_FLOATS * 4, o);
    this.device.queue.writeBuffer(this.infoBuffer, slot * 16, this.info, slot * 4, 4);
    if (a >= 0) this.staticsDirty = true;
    return slot;
  }

  /** Move the world anchor of a world joint (the mouse drag). */
  setWorldAnchor(slot: number, p: ArrayLike<number>): void {
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_RA) * 4, new Float32Array([p[0], p[1], p[2]]));
  }

  /** Stop a joint acting: zero its penalties, stiffness and lambdas (keeps fracture/torque arm). */
  disableConstraint(slot: number): void {
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_PEN_LIN) * 4, new Float32Array(8));
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_LAM_LIN) * 4, new Float32Array(3));
    this.device.queue.writeBuffer(this.jointBuffer, (slot * JOINT_FLOATS + J_LAM_ANG) * 4, new Float32Array(3));
  }

  // --- Step ------------------------------------------------------------------------------------

  /** Time the next step's phases on the GPU (timestamp queries), if supported and not busy. */
  profileNextStep(callback: (profile: StepProfile) => void): void {
    if (this.timing && !this.timingBusy) this.timingCallback = callback;
  }

  private writeParams(): void {
    const p = this.params;
    const cap = this.bodyCapacity;
    const buf = new ArrayBuffer(PARAM_WORDS * 4);
    const f = new Float32Array(buf);
    const u = new Uint32Array(buf);
    f[0] = p.dt;
    f[1] = p.gravity;
    f[2] = p.betaLin;
    f[3] = p.betaAng;
    f[4] = p.gamma;
    f[5] = p.alpha;
    u[6] = (p.matchNearest ? FLAG_MATCH_NEAREST : 0) | (p.faceBias ? FLAG_FACE_BIAS : 0);
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

  /** Pass constants: per iteration, one entry per colour (primal), then one for the dual. */
  private writePassConstants(iterations: number, alpha: number): void {
    const perIteration = this.colorCap + 1;
    // At least one entry: the warm-start dispatches bind entry 0 even with no iterations
    const entries = Math.max(iterations * perIteration, 1);
    if (entries > this.passEntries || !this.passGroup) {
      this.passBuffer?.destroy();
      this.passBuffer = this.device.createBuffer({ label: 'pass constants', size: entries * PASS_STRIDE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.passEntries = entries;
      this.passGroup = this.device.createBindGroup({ layout: this.layouts.pass, entries: [{ binding: 0, resource: { buffer: this.passBuffer, size: 16 } }] });
    }
    const data = new ArrayBuffer(entries * PASS_STRIDE);
    const u32 = new Uint32Array(data);
    const f32 = new Float32Array(data);
    for (let it = 0; it < iterations; it++) {
      for (let col = 0; col <= this.colorCap; col++) {
        const w = ((it * perIteration + col) * PASS_STRIDE) / 4;
        u32[w] = col;
        f32[w + 1] = alpha;
      }
    }
    this.device.queue.writeBuffer(this.passBuffer!, 0, data);
  }

  step(): void {
    if (this.staticsDirty) this.uploadStatics();
    const p = this.params;
    if (this.fixedColors) {
      this.device.queue.writeBuffer(this.colorBuffer, 0, this.fixedColors);
      this.colorCap = Math.max(1, ...this.fixedColors.map((c) => (c === NO_COLOR ? 0 : c + 1)));
    }
    this.writeParams();
    this.writePassConstants(p.iterations, p.alpha);

    const cur = this.parity;
    const cap = this.bodyCapacity;
    const N = this.bodyCount;
    const J = this.jointCount;
    const encoder = this.device.createCommandEncoder({ label: 'avbd3d step' });
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
        label: split ? PHASES[phase] : 'avbd3d step',
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

    // Collision
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

    // Colouring
    beginPhase();
    if (!this.fixedColors) {
      run('colorCompact', G.topo[cur], groups(N));
      run('colorMark', G.topo[cur], groups(N));
      for (let r = 0; r < this.colorRounds; r++) run(r % 2 === 0 ? 'colorRoundAB' : 'colorRoundBA', G.topo[cur], groups(N));
    }
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
    for (let it = 0; it < p.iterations; it++) {
      pass.setPipeline(this.pipes.primal);
      for (let col = 0; col < this.colorCap; col++) {
        setPass(it * perIteration + col);
        pass.dispatchWorkgroupsIndirect(this.argsBuffer, (IA_COLOR + 3 * col) * 4);
      }
      setPass(it * perIteration + this.colorCap);
      pass.setPipeline(this.pipes.dual);
      pass.dispatchWorkgroupsIndirect(this.argsBuffer, IA_CONSTRAINTS * 4);
    }
    pass.setPipeline(this.pipes.updateVelocities);
    pass.dispatchWorkgroups(groups(N));
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
      read.mapAsync(GPUMapMode.READ).then(() => {
        const t = new BigUint64Array(read.getMappedRange()).slice();
        read.unmap();
        this.timingBusy = false;
        const ms = (a: number, b: number) => Number(t[b] - t[a]) / 1e6;
        const profile = { total: ms(0, stamps - 1) } as StepProfile;
        PHASES.forEach((name, i) => (profile[name] = ms(2 * i, 2 * i + 1)));
        callback(profile);
      }, () => {
        // Destroyed before the timing came back
        this.timingBusy = false;
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

  /** Joint slot types and endpoints (type, bodyA, bodyB, 0 per slot). */
  jointInfo(): Int32Array {
    return this.info.subarray(0, this.jointCount * 4);
  }

  /** Adapt the colour cap and pair/contact capacity to a recent counters readback. */
  adapt(counters: GpuCounters): void {
    if (this.fixedColors) return;
    // Colour cap = colours in use + 2 (each colour below the cap costs a dispatch per
    // iteration): grow at once when the colouring runs into it, shrink after three quiet reads
    const used = counters.colors;
    if (counters.clashes > 0 || used >= this.colorCap - 1) {
      this.colorCap = Math.min(MAX_COLORS, Math.max(used + 4, this.colorCap + 4));
      this.shrinkVotes = 0;
    } else if (used + 2 < this.colorCap) {
      if (++this.shrinkVotes >= 3) {
        this.colorCap = Math.max(4, used + 2);
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

  private capacityCanGrow(contacts: number, pairs: number): boolean {
    const maxBinding = this.device.limits.maxStorageBufferBindingSize;
    const maxContacts = Math.min(Math.floor(maxBinding / (CONTACT_WORDS * 4)), Math.floor(maxBinding / 16));
    return Math.min(contacts, maxContacts) > this.contactCapacity || Math.min(pairs, Math.floor(maxBinding / 8)) > this.pairCapacity;
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
