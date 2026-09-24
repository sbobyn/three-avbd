// GPU-shaped CPU implementation of 2D AVBD. Same math as the reference (../ref), laid out the
// way the WebGPU solver will be:
//
// - Bodies are struct-of-arrays with a vec4 stride (pose, initial, inertial, velocity, ...).
// - Constraints are fixed-stride records (Int32 info + float data), one per joint, spring,
//   motor or contact *point*: persistent joints first, then this step's contacts.
// - Each body gathers its constraints through a CSR adjacency list (primal pass), and each
//   constraint updates only its own dual state (dual pass), so no pass needs float atomics.
// - Bodies are graph-coloured; bodies of one colour are solved Jacobi-style (compute all,
//   then write), which is exactly what a GPU dispatch per colour does.
// - Contacts persist across steps by (pair key, feature) lookup in last step's sorted list.
//
// `order: 'sequential'` + `precision: 'f64'` reproduces the reference (and so the upstream
// C++) to round-off; `order: 'colored'` + `precision: 'f32'` is what the GPU will run.

import { COLLISION_MARGIN, PENALTY_MAX, PENALTY_MIN, STICK_THRESH } from '../ref/body.ts';
import { Joint, Motor, Spring, IgnoreCollision } from '../ref/forces.ts';
import { clamp, min, sign } from '../ref/math.ts';
import { defaultParams, type Solver, type SolverParams } from '../ref/solver.ts';
import { containsKey, GridBroadphase, PAIR_SHIFT, pairKey } from './broadphase.ts';
import { collideBoxes, CONTACT_OUT_STRIDE, OUT_FEATURE, OUT_N, OUT_RA, OUT_RB } from './collide.ts';
import { Coloring } from './coloring.ts';

// Constraint types (info[c*4 + 0])
export const T_NONE = 0;
export const T_JOINT = 1;
export const T_SPRING = 2;
export const T_MOTOR = 3;
export const T_CONTACT = 4;
const ROWS = [0, 3, 1, 1, 2];
/** matchNearest tolerance, as a fraction of the smaller box's smallest side. */
export const NEAREST_FRACTION = 0.05;

/** Int32 per constraint: type, bodyA (-1 = world), bodyB, feature key (contacts). */
export const INFO_STRIDE = 4;
/** Floats per constraint record. */
export const CS = 32;
// Per-row blocks (3 rows each)
export const PEN = 0;
export const LAM = 3;
export const STIFF = 6;
export const FMIN = 9;
export const FMAX = 12;
export const FRAC = 15;
export const C0 = 18;
// Anchors in body-local space (joint/spring/contact); A is a world point for world joints
export const RA = 21;
export const RB = 23;
// Type parameters: joint (restAngle, torqueArm), spring (rest), motor (speed),
// contact (friction, normal x, normal y, stick flag)
export const P0 = 25;
export const P1 = 26;
export const P2 = 27;
export const STICK = 28;

type Real = Float32Array | Float64Array;

export interface SoaOptions {
  precision: 'f32' | 'f64';
  order: 'sequential' | 'colored';
  /** Colouring rounds per step before leftover clashes fall back to Jacobi. */
  colorRounds: number;
}

export interface JointHandle {
  slot: number;
  alive: boolean;
}

export class SoaSolver2D {
  readonly params: SolverParams = defaultParams();
  readonly options: SoaOptions;

  // --- Bodies (stride 4) ---
  bodyCount = 0;
  pose: Real;
  initial: Real;
  inertial: Real;
  velocity: Real;
  prevVelocity: Real;
  /** width, height, mass, moment */
  shape: Real;
  /** friction, bounding radius */
  props: Real;
  dynamic = new Uint8Array(0);

  // --- Constraints: joints (incl. springs, motors) in [0, jointCount), contacts after ---
  jointCount = 0;
  contactCount = 0;
  info = new Int32Array(0);
  data: Real;
  private handles: (JointHandle | null)[] = [];

  // Last step's contacts, sorted by pair key, for warm-start matching
  private prevCount = 0;
  private prevKeys = new Float64Array(0);
  private prevInfo = new Int32Array(0);
  private prevData = new Float64Array(0);

  // Pairs that never collide (connected by a constraint or IgnoreCollision), sorted
  private ignorePairs: number[] = [];
  private noCollide = new Float64Array(0);
  private noCollideCount = 0;
  private noCollideDirty = true;

  // Per-body constraint adjacency (CSR over dynamic bodies)
  adjStart = new Int32Array(1);
  adjList = new Int32Array(0);

  readonly broadphase = new GridBroadphase();
  readonly coloring = new Coloring();
  numColors = 0;
  colorConflicts = 0;
  colorRounds = 0;

  /** Accumulated milliseconds per phase while `profiling` is set (see resetProfile). */
  profiling = false;
  readonly profile: Record<string, number> = {};
  private phaseStart = 0;

  private readonly contactOut = new Float64Array(2 * CONTACT_OUT_STRIDE);
  private dxBuf = new Float64Array(0);

  constructor(options: Partial<SoaOptions> = {}) {
    this.options = { precision: 'f32', order: 'colored', colorRounds: 32, ...options };
    this.pose = this.real(0);
    this.initial = this.real(0);
    this.inertial = this.real(0);
    this.velocity = this.real(0);
    this.prevVelocity = this.real(0);
    this.shape = this.real(0);
    this.props = this.real(0);
    this.data = this.real(0);
  }

  private real(n: number): Real {
    return this.options.precision === 'f32' ? new Float32Array(n) : new Float64Array(n);
  }

  private grow<T extends Real | Int32Array | Uint8Array>(arr: T, size: number): T {
    if (arr.length >= size) return arr;
    const next = new (arr.constructor as new (n: number) => T)(Math.max(size, arr.length * 2, 16));
    next.set(arr);
    return next;
  }

  // --- Scene construction --------------------------------------------------------------

  clear(): void {
    this.bodyCount = 0;
    this.jointCount = 0;
    this.contactCount = 0;
    this.prevCount = 0;
    this.handles = [];
    this.ignorePairs = [];
    this.noCollideDirty = true;
    this.coloring.resize(0);
  }

  addBody(
    size: [number, number],
    density: number,
    friction: number,
    pose: ArrayLike<number>,
    velocity: ArrayLike<number> = [0, 0, 0],
  ): number {
    const i = this.bodyCount++;
    const n4 = this.bodyCount * 4;
    this.pose = this.grow(this.pose, n4);
    this.initial = this.grow(this.initial, n4);
    this.inertial = this.grow(this.inertial, n4);
    this.velocity = this.grow(this.velocity, n4);
    this.prevVelocity = this.grow(this.prevVelocity, n4);
    this.shape = this.grow(this.shape, n4);
    this.props = this.grow(this.props, n4);
    this.dynamic = this.grow(this.dynamic, this.bodyCount);

    const mass = size[0] * size[1] * density;
    this.pose.set([pose[0], pose[1], pose[2] ?? 0, 0], i * 4);
    this.velocity.set([velocity[0], velocity[1], velocity[2] ?? 0, 0], i * 4);
    this.prevVelocity.set(this.velocity.subarray(i * 4, i * 4 + 4), i * 4);
    this.shape.set([size[0], size[1], mass, (mass * (size[0] * size[0] + size[1] * size[1])) / 12], i * 4);
    this.props.set([friction, Math.hypot(size[0] * 0.5, size[1] * 0.5), 0, 0], i * 4);
    this.dynamic[i] = mass > 0 ? 1 : 0;
    return i;
  }

  private allocConstraint(): number {
    const c = this.jointCount++;
    const end = this.jointCount + this.contactCount;
    this.info = this.grow(this.info, end * INFO_STRIDE);
    this.data = this.grow(this.data, end * CS);
    // Contacts live right after the joints; shift them up one slot to make room
    if (this.contactCount > 0) {
      this.info.copyWithin((c + 1) * INFO_STRIDE, c * INFO_STRIDE, (end - 1) * INFO_STRIDE);
      this.data.copyWithin((c + 1) * CS, c * CS, (end - 1) * CS);
    }
    this.data.fill(0, c * CS, c * CS + CS);
    for (let r = 0; r < 3; r++) {
      this.data[c * CS + STIFF + r] = Infinity;
      this.data[c * CS + FMIN + r] = -Infinity;
      this.data[c * CS + FMAX + r] = Infinity;
      this.data[c * CS + FRAC + r] = Infinity;
    }
    this.handles[c] = null;
    this.noCollideDirty = true;
    return c;
  }

  private setInfo(c: number, type: number, a: number, b: number): void {
    this.info.set([type, a, b, 0], c * INFO_STRIDE);
  }

  addJoint(
    a: number,
    b: number,
    rA: [number, number],
    rB: [number, number],
    stiffness: [number, number, number] = [Infinity, Infinity, Infinity],
    fracture = Infinity,
  ): JointHandle {
    const c = this.allocConstraint();
    this.setInfo(c, T_JOINT, a, b);
    const d = this.data;
    const o = c * CS;
    d.set(stiffness, o + STIFF);
    d[o + FMAX + 2] = fracture;
    d[o + FMIN + 2] = -fracture;
    d[o + FRAC + 2] = fracture;
    d.set(rA, o + RA);
    d.set(rB, o + RB);
    d[o + P0] = (a >= 0 ? this.pose[a * 4 + 2] : 0) - this.pose[b * 4 + 2];
    const sx = (a >= 0 ? this.shape[a * 4] : 0) + this.shape[b * 4];
    const sy = (a >= 0 ? this.shape[a * 4 + 1] : 0) + this.shape[b * 4 + 1];
    d[o + P1] = sx * sx + sy * sy;
    const handle = { slot: c, alive: true };
    this.handles[c] = handle;
    return handle;
  }

  /** Move the world anchor of a world joint (the mouse drag joint). */
  setJointWorldAnchor(handle: JointHandle, x: number, y: number): void {
    if (!handle.alive) return;
    this.data[handle.slot * CS + RA] = x;
    this.data[handle.slot * CS + RA + 1] = y;
  }

  /** Remove a joint: it is disabled now and dropped at the start of the next step. */
  removeJoint(handle: JointHandle): void {
    if (!handle.alive) return;
    this.disable(handle.slot);
    handle.alive = false;
  }

  addSpring(a: number, b: number, rA: [number, number], rB: [number, number], stiffness: number, rest: number): void {
    const c = this.allocConstraint();
    this.setInfo(c, T_SPRING, a, b);
    const o = c * CS;
    this.data[o + STIFF] = stiffness;
    this.data.set(rA, o + RA);
    this.data.set(rB, o + RB);
    this.data[o + P0] = rest;
  }

  addMotor(a: number, b: number, speed: number, maxTorque: number): void {
    const c = this.allocConstraint();
    this.setInfo(c, T_MOTOR, a, b);
    const o = c * CS;
    this.data[o + FMAX] = maxTorque;
    this.data[o + FMIN] = -maxTorque;
    this.data[o + P0] = speed;
  }

  /** Pair keys (see broadphase pairKey) of the IgnoreCollision pairs. */
  ignoredPairs(): readonly number[] {
    return this.ignorePairs;
  }

  addIgnoreCollision(a: number, b: number): void {
    this.ignorePairs.push(pairKey(a, b));
    this.noCollideDirty = true;
  }

  /** Load a scene built with the reference solver (same bodies, same constraint order). */
  loadFromReference(ref: Solver): void {
    this.clear();
    // Every solver parameter (keyed off the defaults, so new ones can't be forgotten)
    const keys = Object.keys(defaultParams()) as (keyof SolverParams)[];
    Object.assign(this.params, Object.fromEntries(keys.map((key) => [key, ref[key]])));
    const index = new Map(ref.bodies.map((b, i) => [b, i]));
    for (const b of ref.bodies) {
      const i = this.addBody(b.size, 0, b.friction, b.position, b.velocity);
      // Keep the exact mass properties (density was folded into mass by the reference)
      this.shape[i * 4 + 2] = b.mass;
      this.shape[i * 4 + 3] = b.moment;
      this.dynamic[i] = b.mass > 0 ? 1 : 0;
    }
    for (const f of ref.forces) {
      const a = f.bodyA ? index.get(f.bodyA)! : -1;
      const b = index.get(f.bodyB)!;
      if (f instanceof Joint) {
        const h = this.addJoint(a, b, f.rA, f.rB, [f.stiffness[0], f.stiffness[1], f.stiffness[2]], f.fracture[2]);
        this.data[h.slot * CS + P0] = f.restAngle;
        this.data[h.slot * CS + P1] = f.torqueArm;
      } else if (f instanceof Spring) this.addSpring(a, b, f.rA, f.rB, f.stiffness[0], f.rest);
      else if (f instanceof Motor) this.addMotor(a, b, f.speed, f.fmax[0]);
      else if (f instanceof IgnoreCollision) this.addIgnoreCollision(a, b);
    }
  }

  // --- Step ----------------------------------------------------------------------------

  step(): void {
    const p = this.params;
    const postStabilize = p.postStabilize && !p.vbd;
    const alpha = p.vbd ? 0 : p.alpha;

    this.phaseStart = this.profiling ? performance.now() : 0;
    this.saveContacts();
    this.findPairs();
    this.mark('broadphase');
    this.initJoints();
    this.narrowphase();
    this.mark('narrowphase');
    this.warmStartConstraints(postStabilize, alpha);
    this.buildAdjacency();
    this.mark('adjacency');
    this.colorBodies();
    this.mark('coloring');
    this.warmStartBodies();

    const totalIterations = p.iterations + (postStabilize ? 1 : 0);
    for (let it = 0; it < totalIterations; it++) {
      const currentAlpha = postStabilize ? (it < p.iterations ? 1 : 0) : alpha;
      this.primal(currentAlpha);
      this.mark('primal');
      if (it < p.iterations) this.dual(currentAlpha);
      if (it === p.iterations - 1) this.updateVelocities();
      this.mark('dual');
    }
    // The reference's last constraint evaluation (post-stabilization primal) refreshes the
    // stick flags from the final lambdas.
    if (postStabilize) this.refreshStick();
  }

  private mark(phase: string): void {
    if (!this.profiling) return;
    const now = performance.now();
    this.profile[phase] = (this.profile[phase] ?? 0) + now - this.phaseStart;
    this.phaseStart = now;
  }

  resetProfile(): void {
    for (const k of Object.keys(this.profile)) delete this.profile[k];
  }

  /** Keep this step's contacts (already sorted by pair key) for next step's matching. */
  private saveContacts(): void {
    const n = this.contactCount;
    const base = this.jointCount;
    if (this.prevKeys.length < n) {
      this.prevKeys = new Float64Array(n * 2);
      this.prevInfo = new Int32Array(n * 2 * INFO_STRIDE);
      this.prevData = new Float64Array(n * 2 * CS);
    }
    for (let k = 0; k < n; k++) {
      const c = base + k;
      this.prevKeys[k] = pairKey(this.info[c * INFO_STRIDE + 1], this.info[c * INFO_STRIDE + 2]);
    }
    this.prevInfo.set(this.info.subarray(base * INFO_STRIDE, (base + n) * INFO_STRIDE));
    this.prevData.set(this.data.subarray(base * CS, (base + n) * CS));
    this.prevCount = n;
    this.contactCount = 0;
  }

  private findPairs(): void {
    if (this.noCollideDirty) {
      const keys = [...this.ignorePairs];
      for (let c = 0; c < this.jointCount; c++) {
        const a = this.info[c * INFO_STRIDE + 1];
        const b = this.info[c * INFO_STRIDE + 2];
        if (this.info[c * INFO_STRIDE] !== T_NONE && a >= 0) keys.push(pairKey(a, b));
      }
      this.noCollide = Float64Array.from(keys).sort();
      this.noCollideCount = keys.length;
      this.noCollideDirty = false;
    }
    this.broadphase.findPairs(this.bodyCount, this.pose, this.props, this.dynamic, this.noCollide, this.noCollideCount);
  }

  /** Cache C(x-) for joints and drop disabled ones (compacting the joint block). */
  private initJoints(): void {
    const { info, data, pose } = this;
    let w = 0;
    for (let c = 0; c < this.jointCount; c++) {
      const o = c * CS;
      const type = info[c * INFO_STRIDE];
      if (type === T_JOINT) {
        if (data[o + STIFF] === 0 && data[o + STIFF + 1] === 0 && data[o + STIFF + 2] === 0) {
          const h = this.handles[c];
          if (h) h.alive = false;
          continue;
        }
        const a = info[c * INFO_STRIDE + 1];
        const b = info[c * INFO_STRIDE + 2];
        this.jointC(a, b, o, pose, data, o + C0);
      }
      if (w !== c) {
        info.copyWithin(w * INFO_STRIDE, c * INFO_STRIDE, (c + 1) * INFO_STRIDE);
        data.copyWithin(w * CS, o, o + CS);
        this.handles[w] = this.handles[c];
        if (this.handles[w]) this.handles[w]!.slot = w;
      }
      w++;
    }
    if (w !== this.jointCount) {
      for (let c = w; c < this.jointCount; c++) this.handles[c] = null;
      this.jointCount = w;
      this.noCollideDirty = true;
    }
  }

  /** Raw joint constraint (position x, y and scaled angle) into out[at..at+3]. */
  private jointC(a: number, b: number, o: number, pose: Real, data: Real, at: number, out: Real | Float64Array = data): void {
    let ax: number, ay: number, aa: number;
    if (a >= 0) {
      const c = Math.cos(pose[a * 4 + 2]);
      const s = Math.sin(pose[a * 4 + 2]);
      const rx = data[o + RA];
      const ry = data[o + RA + 1];
      ax = c * rx - s * ry + pose[a * 4];
      ay = s * rx + c * ry + pose[a * 4 + 1];
      aa = pose[a * 4 + 2];
    } else {
      ax = data[o + RA];
      ay = data[o + RA + 1];
      aa = 0;
    }
    const c = Math.cos(pose[b * 4 + 2]);
    const s = Math.sin(pose[b * 4 + 2]);
    const rx = data[o + RB];
    const ry = data[o + RB + 1];
    out[at] = ax - (c * rx - s * ry + pose[b * 4]);
    out[at + 1] = ay - (s * rx + c * ry + pose[b * 4 + 1]);
    out[at + 2] = (aa - pose[b * 4 + 2] - data[o + P0]) * data[o + P1];
  }

  /** Narrowphase over this step's pairs; merge warm-start state from last step's contacts. */
  private narrowphase(): void {
    const { pose, shape, props } = this;
    const pairs = this.broadphase.pairs;
    const out = this.contactOut;

    for (let k = 0; k < this.broadphase.pairCount; k++) {
      const key = pairs[k];
      const a = Math.floor(key / PAIR_SHIFT);
      const b = key - a * PAIR_SHIFT;
      const count = collideBoxes(
        pose[a * 4], pose[a * 4 + 1], pose[a * 4 + 2], shape[a * 4] * 0.5, shape[a * 4 + 1] * 0.5,
        pose[b * 4], pose[b * 4 + 1], pose[b * 4 + 2], shape[b * 4] * 0.5, shape[b * 4 + 1] * 0.5,
        out,
      );
      if (count === 0) continue;

      // Last step's contacts for this pair (sorted by key)
      let lo = 0;
      let hi = this.prevCount;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (this.prevKeys[mid] < key) lo = mid + 1;
        else hi = mid;
      }
      const prevFirst = lo;

      const friction = Math.sqrt(props[a * 4] * props[b * 4]);
      for (let i = 0; i < count; i++) {
        const c = this.jointCount + this.contactCount++;
        this.info = this.grow(this.info, (c + 1) * INFO_STRIDE);
        this.data = this.grow(this.data, (c + 1) * CS);
        const d = this.data;
        const o = c * CS;
        const w = i * CONTACT_OUT_STRIDE;
        const feature = out[w + OUT_FEATURE];
        this.info.set([T_CONTACT, a, b, feature], c * INFO_STRIDE);

        d.fill(0, o, o + CS);
        d[o + STIFF] = d[o + STIFF + 1] = Infinity;
        d[o + FMIN] = -Infinity;
        d[o + FMAX] = 0;
        d[o + FRAC] = d[o + FRAC + 1] = Infinity;
        d[o + RA] = out[w + OUT_RA];
        d[o + RA + 1] = out[w + OUT_RA + 1];
        d[o + RB] = out[w + OUT_RB];
        d[o + RB + 1] = out[w + OUT_RB + 1];
        d[o + P0] = friction;
        d[o + P1] = out[w + OUT_N];
        d[o + P2] = out[w + OUT_N + 1];

        // Warm start from the matching contact (same pair, same feature) of last step; with
        // matchNearest, fall back to the pair's contact nearest in A-local anchor position
        let match = -1;
        for (let j = prevFirst; j < this.prevCount && this.prevKeys[j] === key; j++) {
          if (this.prevInfo[j * INFO_STRIDE + 3] === feature) match = j;
        }
        if (match < 0 && this.params.matchNearest) {
          let best = NEAREST_FRACTION * Math.min(shape[a * 4], shape[a * 4 + 1], shape[b * 4], shape[b * 4 + 1]);
          for (let j = prevFirst; j < this.prevCount && this.prevKeys[j] === key; j++) {
            const dist = Math.hypot(this.prevData[j * CS + RA] - d[o + RA], this.prevData[j * CS + RA + 1] - d[o + RA + 1]);
            if (dist <= best) {
              best = dist;
              match = j;
            }
          }
        }
        if (match >= 0) {
          const po = match * CS;
          d[o + PEN] = this.prevData[po + PEN];
          d[o + PEN + 1] = this.prevData[po + PEN + 1];
          d[o + LAM] = this.prevData[po + LAM];
          d[o + LAM + 1] = this.prevData[po + LAM + 1];
          // Static friction last step: keep the old anchors
          if (this.prevData[po + STICK]) {
            d[o + RA] = this.prevData[po + RA];
            d[o + RA + 1] = this.prevData[po + RA + 1];
            d[o + RB] = this.prevData[po + RB];
            d[o + RB + 1] = this.prevData[po + RB + 1];
          }
        }

        // C(x-) in the contact basis (normal, tangent)
        const [rAx, rAy] = rot(pose[a * 4 + 2], d[o + RA], d[o + RA + 1]);
        const [rBx, rBy] = rot(pose[b * 4 + 2], d[o + RB], d[o + RB + 1]);
        const nx = d[o + P1];
        const ny = d[o + P2];
        const dx = pose[a * 4] + rAx - pose[b * 4] - rBx;
        const dy = pose[a * 4 + 1] + rAy - pose[b * 4 + 1] - rBy;
        d[o + C0] = nx * dx + ny * dy + COLLISION_MARGIN;
        d[o + C0 + 1] = ny * dx - nx * dy;
      }
    }
  }

  private warmStartConstraints(postStabilize: boolean, alpha: number): void {
    const p = this.params;
    const d = this.data;
    const total = this.jointCount + this.contactCount;
    for (let c = 0; c < total; c++) {
      const rows = ROWS[this.info[c * INFO_STRIDE]];
      const o = c * CS;
      for (let r = 0; r < rows; r++) {
        if (p.vbd) {
          d[o + PEN + r] = min(d[o + STIFF + r], p.vbdStiffness);
          continue;
        }
        if (!postStabilize) d[o + LAM + r] = d[o + LAM + r] * alpha * p.gamma;
        d[o + PEN + r] = min(clamp(d[o + PEN + r] * p.gamma, PENALTY_MIN, PENALTY_MAX), d[o + STIFF + r]);
      }
    }
  }

  /**
   * Build the adjacency lists and (in coloured order) the colouring for the current
   * constraints without stepping. The GPU solver uses this for its topology.
   */
  prepareTopology(): void {
    this.buildAdjacency();
    this.colorBodies();
  }

  private buildAdjacency(): void {
    const n = this.bodyCount;
    const total = this.jointCount + this.contactCount;
    this.adjStart = this.grow(this.adjStart, n + 1);
    this.adjList = this.grow(this.adjList, total * 2);
    const start = this.adjStart;
    start.fill(0, 0, n + 1);
    for (let c = 0; c < total; c++) {
      for (let s = 1; s <= 2; s++) {
        const body = this.info[c * INFO_STRIDE + s];
        if (body >= 0 && this.dynamic[body]) start[body + 1]++;
      }
    }
    for (let i = 0; i < n; i++) start[i + 1] += start[i];
    const cursor = start.slice(0, n);
    for (let c = 0; c < total; c++) {
      for (let s = 1; s <= 2; s++) {
        const body = this.info[c * INFO_STRIDE + s];
        if (body >= 0 && this.dynamic[body]) this.adjList[cursor[body]++] = c;
      }
    }
  }

  private colorBodies(): void {
    if (this.options.order !== 'colored') return;
    const result = this.coloring.run(this.bodyCount, this.dynamic, this.adjStart, this.adjList, this.info, this.options.colorRounds);
    this.numColors = result.numColors;
    this.colorConflicts = result.conflicts;
    this.colorRounds = result.rounds;
  }

  private warmStartBodies(): void {
    const { dt, gravity } = this.params;
    const { pose: p, velocity: v, initial, inertial, prevVelocity } = this;
    for (let i = 0; i < this.bodyCount; i++) {
      const o = i * 4;
      v[o + 2] = clamp(v[o + 2], -50, 50);

      inertial[o] = p[o] + v[o] * dt;
      inertial[o + 1] = p[o + 1] + v[o + 1] * dt;
      inertial[o + 2] = p[o + 2] + v[o + 2] * dt;
      if (this.dynamic[i]) inertial[o + 1] += gravity * dt * dt;

      const accelExt = ((v[o + 1] - prevVelocity[o + 1]) / dt) * sign(gravity);
      let accelWeight = clamp(accelExt / Math.abs(gravity), 0, 1);
      if (!Number.isFinite(accelWeight)) accelWeight = 0;

      initial[o] = p[o];
      initial[o + 1] = p[o + 1];
      initial[o + 2] = p[o + 2];
      p[o] = p[o] + v[o] * dt;
      p[o + 1] = p[o + 1] + v[o + 1] * dt + gravity * accelWeight * dt * dt;
      p[o + 2] = p[o + 2] + v[o + 2] * dt;
    }
  }

  // --- Constraint evaluation (shared by primal and dual) --------------------------------

  // Output of evalConstraint: per row C, bounds, and (for the primal) the Jacobian row
  // eJ[r*3..] and the diagonal geometric-stiffness weights eG[r*3..] (column norms of the
  // row's Hessian, Sec. 3.5), both with respect to the body being solved.
  private readonly eC = new Float64Array(3);
  private readonly eMin = new Float64Array(3);
  private readonly eMax = new Float64Array(3);
  private readonly eJ = new Float64Array(9);
  private readonly eG = new Float64Array(9);

  /**
   * Evaluate constraint c at the current poses. With body >= 0 also compute its Jacobian and
   * Hessian weights with respect to that body. Returns the row count.
   */
  private evalConstraint(c: number, alpha: number, body: number): number {
    const { info, data: d, pose, initial } = this;
    const type = info[c * INFO_STRIDE];
    const a = info[c * INFO_STRIDE + 1];
    const b = info[c * INFO_STRIDE + 2];
    const o = c * CS;
    const { eC, eMin, eMax, eJ, eG } = this;
    const rows = ROWS[type];
    for (let r = 0; r < rows; r++) {
      eMin[r] = d[o + FMIN + r];
      eMax[r] = d[o + FMAX + r];
    }
    const isA = body === a;
    eG.fill(0);

    if (type === T_JOINT) {
      this.jointC(a, b, o, pose, d, 0, eC);
      for (let r = 0; r < 3; r++) if (d[o + STIFF + r] === Infinity) eC[r] -= d[o + C0 + r] * alpha;
      if (body >= 0) {
        const ang = pose[body * 4 + 2];
        const [rx, ry] = rot(ang, d[o + (isA ? RA : RB)], d[o + (isA ? RA : RB) + 1]);
        const sgn = isA ? 1 : -1;
        eJ[0] = sgn; eJ[1] = 0; eJ[2] = -sgn * ry;
        eJ[3] = 0; eJ[4] = sgn; eJ[5] = sgn * rx;
        eJ[6] = 0; eJ[7] = 0; eJ[8] = sgn * d[o + P1];
        eG[2] = Math.abs(rx);
        eG[5] = Math.abs(ry);
      }
    } else if (type === T_SPRING) {
      const [pax, pay] = xform(pose, a, d[o + RA], d[o + RA + 1]);
      const [pbx, pby] = xform(pose, b, d[o + RB], d[o + RB + 1]);
      const dx = pax - pbx;
      const dy = pay - pby;
      const len2 = dx * dx + dy * dy;
      const len = Math.sqrt(len2);
      eC[0] = len - d[o + P0];
      if (body >= 0 && len2 !== 0) {
        const nx = dx / len;
        const ny = dy / len;
        const d00 = (1 - nx * nx) / len;
        const d01 = -nx * ny / len;
        const d11 = (1 - ny * ny) / len;
        const ang = pose[body * 4 + 2];
        const lr = isA ? RA : RB;
        const [srx, sry] = rot(ang, -d[o + lr + 1], d[o + lr]);
        const [rx, ry] = rot(ang, d[o + lr], d[o + lr + 1]);
        const dxr0 = d00 * srx + d01 * sry;
        const dxr1 = d01 * srx + d11 * sry;
        const nr = nx * rx + ny * ry;
        const nSr = nx * srx + ny * sry;
        const sgn = isA ? 1 : -1;
        eJ[0] = sgn * nx; eJ[1] = sgn * ny; eJ[2] = sgn * nSr;
        const drr = isA ? -nr - nr : nr + nr;
        eG[0] = Math.hypot(d00, d01, dxr0);
        eG[1] = Math.hypot(d01, d11, dxr1);
        eG[2] = Math.hypot(dxr0, dxr1, drr);
      } else if (body >= 0) {
        // Degenerate spring: the reference keeps the previous derivatives; zero is the
        // closest well-defined choice (it never happens in the demo scenes).
        eJ.fill(0, 0, 3);
      }
    } else if (type === T_MOTOR) {
      const dA = a >= 0 ? pose[a * 4 + 2] - initial[a * 4 + 2] : 0;
      const dB = pose[b * 4 + 2] - initial[b * 4 + 2];
      eC[0] = dA - dB - d[o + P0] * this.params.dt;
      if (body >= 0) {
        eJ[0] = 0; eJ[1] = 0; eJ[2] = isA ? 1 : -1;
      }
    } else if (type === T_CONTACT) {
      // Taylor expansion about x- (Sec. 4): C = (1 - alpha) C0 + J (x - x-)
      const nx = d[o + P1];
      const ny = d[o + P2];
      const tx = ny;
      const ty = -nx;
      const [rAx, rAy] = rot(initial[a * 4 + 2], d[o + RA], d[o + RA + 1]);
      const [rBx, rBy] = rot(initial[b * 4 + 2], d[o + RB], d[o + RB + 1]);
      const jAn2 = rAx * ny - rAy * nx;
      const jBn2 = -(rBx * ny - rBy * nx);
      const jAt2 = rAx * ty - rAy * tx;
      const jBt2 = -(rBx * ty - rBy * tx);
      const a0 = pose[a * 4] - initial[a * 4], a1 = pose[a * 4 + 1] - initial[a * 4 + 1], a2 = pose[a * 4 + 2] - initial[a * 4 + 2];
      const b0 = pose[b * 4] - initial[b * 4], b1 = pose[b * 4 + 1] - initial[b * 4 + 1], b2 = pose[b * 4 + 2] - initial[b * 4 + 2];
      eC[0] = d[o + C0] * (1 - alpha) + nx * a0 + ny * a1 + jAn2 * a2 + -nx * b0 + -ny * b1 + jBn2 * b2;
      eC[1] = d[o + C0 + 1] * (1 - alpha) + tx * a0 + ty * a1 + jAt2 * a2 + -tx * b0 + -ty * b1 + jBt2 * b2;
      // Friction bounds from the current normal force
      const bound = Math.abs(d[o + LAM]) * d[o + P0];
      eMax[1] = bound;
      eMin[1] = -bound;
      if (body >= 0) {
        if (isA) {
          eJ[0] = nx; eJ[1] = ny; eJ[2] = jAn2;
          eJ[3] = tx; eJ[4] = ty; eJ[5] = jAt2;
        } else {
          eJ[0] = -nx; eJ[1] = -ny; eJ[2] = jBn2;
          eJ[3] = -tx; eJ[4] = -ty; eJ[5] = jBt2;
        }
      }
    }
    return rows;
  }

  // --- Primal / dual ---------------------------------------------------------------------

  /** Newton step for one body; writes -dx into dxBuf[i*3..]. */
  private solveBody(i: number, alpha: number): void {
    const p = this.params;
    const { shape, pose, inertial, data: d } = this;
    const dt2 = p.dt * p.dt;
    const mdt = shape[i * 4 + 2] / dt2;
    const idt = shape[i * 4 + 3] / dt2;
    let h00 = mdt, h10 = 0, h11 = mdt, h20 = 0, h21 = 0, h22 = idt;
    let r0 = mdt * (pose[i * 4] - inertial[i * 4]);
    let r1 = mdt * (pose[i * 4 + 1] - inertial[i * 4 + 1]);
    let r2 = idt * (pose[i * 4 + 2] - inertial[i * 4 + 2]);

    const { eC, eMin, eMax, eJ, eG } = this;
    const adjStart = this.adjStart;
    const adjList = this.adjList;
    // Iterate newest constraint first, like the reference's head-inserted force lists
    for (let k = adjStart[i + 1] - 1; k >= adjStart[i]; k--) {
      const c = adjList[k];
      const rows = this.evalConstraint(c, alpha, i);
      const o = c * CS;
      const hard = !p.vbd;
      for (let r = 0; r < rows; r++) {
        const stiff = d[o + STIFF + r];
        const lambda = hard && stiff === Infinity ? d[o + LAM + r] : 0;
        let pen = d[o + PEN + r];
        const C = eC[r];
        const fRaw = pen * C + lambda;
        const f = clamp(fRaw, eMin[r], eMax[r]);
        const af = Math.abs(f);
        if (p.stiffnessRescale && C !== 0) {
          if (fRaw < eMin[r]) pen = Math.abs((eMin[r] - lambda) / C);
          else if (fRaw > eMax[r]) pen = Math.abs((eMax[r] - lambda) / C);
        }
        const j0 = eJ[r * 3], j1 = eJ[r * 3 + 1], j2 = eJ[r * 3 + 2];
        r0 += j0 * f;
        r1 += j1 * f;
        r2 += j2 * f;
        h00 += j0 * j0 * pen + eG[r * 3] * af;
        h10 += j1 * j0 * pen;
        h11 += j1 * j1 * pen + eG[r * 3 + 1] * af;
        h20 += j2 * j0 * pen;
        h21 += j2 * j1 * pen;
        h22 += j2 * j2 * pen + eG[r * 3 + 2] * af;
      }
    }

    // LDLᵀ solve of the 3x3 SPD system
    const D1 = h00;
    const L21 = h10 / h00;
    const L31 = h20 / h00;
    const D2 = h11 - L21 * L21 * D1;
    const L32 = (h21 - L21 * L31 * D1) / D2;
    const D3 = h22 - (L31 * L31 * D1 + L32 * L32 * D2);
    const y2 = r1 - L21 * r0;
    const y3 = r2 - L31 * r0 - L32 * y2;
    const x2 = y3 / D3;
    const x1 = y2 / D2 - L32 * x2;
    const x0 = r0 / D1 - L21 * x1 - L31 * x2;
    this.dxBuf[i * 3] = x0;
    this.dxBuf[i * 3 + 1] = x1;
    this.dxBuf[i * 3 + 2] = x2;
  }

  private applyDx(i: number): void {
    this.pose[i * 4] -= this.dxBuf[i * 3];
    this.pose[i * 4 + 1] -= this.dxBuf[i * 3 + 1];
    this.pose[i * 4 + 2] -= this.dxBuf[i * 3 + 2];
  }

  private primal(alpha: number): void {
    if (this.dxBuf.length < this.bodyCount * 3) this.dxBuf = new Float64Array(this.bodyCount * 3);
    if (this.options.order === 'sequential') {
      // Gauss-Seidel in the reference's order (newest body first)
      for (let i = this.bodyCount - 1; i >= 0; i--) {
        if (!this.dynamic[i]) continue;
        this.solveBody(i, alpha);
        this.applyDx(i);
      }
      return;
    }
    // One colour at a time; within a colour every body reads the same poses (Jacobi), as a
    // GPU dispatch would.
    const { colorStart, colorBodies } = this.coloring;
    for (let col = 0; col < this.numColors; col++) {
      for (let k = colorStart[col]; k < colorStart[col + 1]; k++) this.solveBody(colorBodies[k], alpha);
      for (let k = colorStart[col]; k < colorStart[col + 1]; k++) this.applyDx(colorBodies[k]);
    }
  }

  private dual(alpha: number): void {
    const p = this.params;
    const d = this.data;
    const { eC, eMin, eMax } = this;
    const total = this.jointCount + this.contactCount;
    for (let c = 0; c < total; c++) {
      const type = this.info[c * INFO_STRIDE];
      if (type === T_NONE) continue;
      const rows = this.evalConstraint(c, alpha, -1);
      const o = c * CS;
      if (type === T_CONTACT) {
        // Stick test uses the bounds from before this update, like the reference
        d[o + STICK] = Math.abs(d[o + LAM + 1]) < eMax[1] && Math.abs(d[o + C0 + 1]) < STICK_THRESH ? 1 : 0;
      }
      for (let r = 0; r < rows; r++) {
        const stiff = d[o + STIFF + r];
        const lambda = !p.vbd && stiff === Infinity ? d[o + LAM + r] : 0;
        const lam = clamp(d[o + PEN + r] * eC[r] + lambda, eMin[r], eMax[r]);
        d[o + LAM + r] = lam;
        if (Math.abs(lam) >= d[o + FRAC + r]) this.disable(c);
        if (!p.vbd && lam > eMin[r] && lam < eMax[r]) {
          d[o + PEN + r] = min(d[o + PEN + r] + p.beta * Math.abs(eC[r]), min(PENALTY_MAX, d[o + STIFF + r]));
        }
      }
    }
  }

  private refreshStick(): void {
    const d = this.data;
    for (let k = 0; k < this.contactCount; k++) {
      const o = (this.jointCount + k) * CS;
      const bound = Math.abs(d[o + LAM]) * d[o + P0];
      d[o + STICK] = Math.abs(d[o + LAM + 1]) < bound && Math.abs(d[o + C0 + 1]) < STICK_THRESH ? 1 : 0;
    }
  }

  private disable(c: number): void {
    const o = c * CS;
    this.data.fill(0, o + PEN, o + PEN + 3);
    this.data.fill(0, o + LAM, o + LAM + 3);
    this.data.fill(0, o + STIFF, o + STIFF + 3);
  }

  private updateVelocities(): void {
    const { dt } = this.params;
    const { pose, initial, velocity: v, prevVelocity } = this;
    for (let i = 0; i < this.bodyCount; i++) {
      const o = i * 4;
      prevVelocity[o] = v[o];
      prevVelocity[o + 1] = v[o + 1];
      prevVelocity[o + 2] = v[o + 2];
      if (!this.dynamic[i]) continue;
      v[o] = (pose[o] - initial[o]) / dt;
      v[o + 1] = (pose[o + 1] - initial[o + 1]) / dt;
      v[o + 2] = (pose[o + 2] - initial[o + 2]) / dt;
    }
  }

  // --- Queries -------------------------------------------------------------------------

  pick(x: number, y: number): { body: number; local: [number, number] } | null {
    for (let i = this.bodyCount - 1; i >= 0; i--) {
      const [lx, ly] = rot(-this.pose[i * 4 + 2], x - this.pose[i * 4], y - this.pose[i * 4 + 1]);
      if (Math.abs(lx) <= this.shape[i * 4] * 0.5 && Math.abs(ly) <= this.shape[i * 4 + 1] * 0.5) return { body: i, local: [lx, ly] };
    }
    return null;
  }

  kineticEnergy(): number {
    let e = 0;
    for (let i = 0; i < this.bodyCount; i++) {
      if (!this.dynamic[i]) continue;
      const o = i * 4;
      const v = this.velocity;
      e += 0.5 * this.shape[o + 2] * (v[o] * v[o] + v[o + 1] * v[o + 1]) + 0.5 * this.shape[o + 3] * v[o + 2] * v[o + 2];
    }
    return e;
  }

  /** Largest positional error of any hard joint anchor (same metric as ref/metrics.ts). */
  maxJointError(): number {
    let m = 0;
    const C = new Float64Array(3);
    for (let c = 0; c < this.jointCount; c++) {
      if (this.info[c * INFO_STRIDE] !== T_JOINT) continue;
      const o = c * CS;
      this.jointC(this.info[c * INFO_STRIDE + 1], this.info[c * INFO_STRIDE + 2], o, this.pose, this.data, 0, C);
      for (let r = 0; r < 2; r++) if (this.data[o + STIFF + r] === Infinity) m = Math.max(m, Math.abs(C[r]));
    }
    return m;
  }

  isContactPairIgnored(a: number, b: number): boolean {
    return containsKey(this.noCollide, this.noCollideCount, pairKey(a, b));
  }
}

function rot(angle: number, x: number, y: number): [number, number] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c * x - s * y, s * x + c * y];
}

function xform(pose: Real, body: number, x: number, y: number): [number, number] {
  const c = Math.cos(pose[body * 4 + 2]);
  const s = Math.sin(pose[body * 4 + 2]);
  return [c * x - s * y + pose[body * 4], s * x + c * y + pose[body * 4 + 1]];
}
