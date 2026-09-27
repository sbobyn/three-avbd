// Contact events: after each step, a compute pass over the pairs the step touched, for the pairs
// with a body that reports contacts. Each such pair goes into this step's hash set; one missing
// from last step's set began touching (with where, the normal and how hard), and one in last
// step's set missing from this one's stopped. So only the changes come back, a few bytes each,
// with the next readback; a pile resting quietly costs a pass, not a readback. (A pair is its
// two slots: a reporting body removed and its slot filled, in one step, by a body touching the
// same one reads as the same pair still touching.)

import { B_POS, B_ROT, BODY_FLOATS, C_MANIFOLDS } from '../avbd3d/gpu/layout.ts';

/** Words at the start of the table buffer: events written (may pass the capacity), set full. */
const HEAD_WORDS = 4;
/** vec4s per event: type, bodies and step; point and impulse; normal. */
const EVENT_VEC4S = 3;
export const BEGIN = 1;
export const END = 2;

const WGSL = /* wgsl */ `
struct Manifold { ids: vec4u, geo: vec4f }   // a, b (a > b), first contact, count (low 4 bits); normal (b to a)
struct Contact { rA: vec3f, key: u32, rB: vec3f, c0x: f32, pen: vec3f, c0y: f32, lam: vec3f, c0z: f32 }
struct Params { prev: u32, now: u32, mask: u32, capacity: u32, pairs: u32, step: u32, dt: f32, pad: u32 }

@group(0) @binding(0) var<storage, read> bodies: array<vec4f>;
@group(0) @binding(1) var<storage, read> manifolds: array<Manifold>;
@group(0) @binding(2) var<storage, read> contacts: array<Contact>;
@group(0) @binding(3) var<storage, read> counters: array<u32>;
@group(0) @binding(4) var<storage, read> watch: array<u32>;
@group(0) @binding(5) var<storage, read_write> table: array<atomic<u32>>;   // head, then two sets: per slot a + 1, b
@group(0) @binding(6) var<storage, read_write> events: array<vec4f>;
@group(0) @binding(7) var<uniform> params: Params;

const STRIDE = ${BODY_FLOATS / 4}u;

fn hash32(x0: u32) -> u32 {
  var x = x0;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}

fn turn(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn slotOf(base: u32, h: u32) -> u32 {
  return ${HEAD_WORDS}u + 2u * (base + h);
}

fn insert(base: u32, a: u32, b: u32) {
  var h = hash32((a * 0x9e3779b1u) ^ hash32(b)) & params.mask;
  for (var probe = 0u; probe <= 2u * params.mask + 1u; probe++) {
    let s = slotOf(base, h);
    let r = atomicCompareExchangeWeak(&table[s], 0u, a + 1u);
    if (r.exchanged) {
      atomicStore(&table[s + 1u], b);
      return;
    }
    // (A weak exchange can fail with the slot still empty: try it again)
    if (r.old_value != 0u) { h = (h + 1u) & params.mask; }
  }
  atomicOr(&table[1], 1u);
}

fn has(base: u32, a: u32, b: u32) -> bool {
  var h = hash32((a * 0x9e3779b1u) ^ hash32(b)) & params.mask;
  for (var probe = 0u; probe <= params.mask; probe++) {
    let s = slotOf(base, h);
    let k = atomicLoad(&table[s]);
    if (k == 0u) { return false; }
    if (k == a + 1u && atomicLoad(&table[s + 1u]) == b) { return true; }
    h = (h + 1u) & params.mask;
  }
  return false;
}

fn emit(kind: u32, a: u32, b: u32, point: vec3f, impulse: f32, normal: vec3f) {
  let e = atomicAdd(&table[0], 1u);
  if (e >= params.capacity) { return; }
  events[${EVENT_VEC4S}u * e] = bitcast<vec4f>(vec4u(kind, a, b, params.step));
  events[${EVENT_VEC4S}u * e + 1u] = vec4f(point, impulse);
  events[${EVENT_VEC4S}u * e + 2u] = vec4f(normal, 0.0);
}

/** Per pair this step: into this step's set, and a begin if it wasn't in last step's. */
@compute @workgroup_size(64)
fn touching(@builtin(global_invocation_id) id: vec3u) {
  let m = id.x;
  if (m >= min(counters[${C_MANIFOLDS}u], params.pairs)) { return; }
  let mf = manifolds[m];
  let count = mf.ids.w & 15u;
  let a = mf.ids.x;
  let b = mf.ids.y;
  if (count == 0u || (watch[a] | watch[b]) == 0u) { return; }
  insert(params.now, a, b);
  if (has(params.prev, a, b)) { return; }
  // Where (the points' average, on a) and how hard (the normal force over the step)
  let pA = bodies[a * STRIDE + ${B_POS / 4}u].xyz;
  let qA = bodies[a * STRIDE + ${B_ROT / 4}u];
  var point = vec3f(0.0);
  var force = 0.0;
  for (var i = 0u; i < count; i++) {
    let k = contacts[mf.ids.z + i];
    point += turn(qA, k.rA) + pA;
    force += k.lam.x;
  }
  emit(${BEGIN}u, a, b, point / f32(count), abs(force) * params.dt, mf.geo.xyz);
}

/** Per slot of last step's set: an end if the pair isn't in this step's. */
@compute @workgroup_size(64)
fn ended(@builtin(global_invocation_id) id: vec3u) {
  if (id.x > params.mask) { return; }
  let s = slotOf(params.prev, id.x);
  let k = atomicLoad(&table[s]);
  if (k == 0u) { return; }
  let b = atomicLoad(&table[s + 1u]);
  if (!has(params.now, k - 1u, b)) { emit(${END}u, k - 1u, b, vec3f(0.0), 0.0, vec3f(0.0)); }
}
`;

/** One event as read back: begin or end, the bodies' slots, and for a begin where and how hard. */
export interface RawContactEvent {
  kind: typeof BEGIN | typeof END;
  a: number;
  b: number;
  step: number;
  point: [number, number, number];
  normal: [number, number, number];
  impulse: number;
}

export class ContactWatch {
  private readonly device: GPUDevice;
  private readonly pipelines: Record<'touching' | 'ended', GPUComputePipeline>;
  private readonly layout: GPUBindGroupLayout;
  /** Per body: reports its contacts (1) or not. */
  private readonly watch: GPUBuffer;
  private readonly table: GPUBuffer;
  private readonly events: GPUBuffer;
  private readonly params: GPUBuffer;
  /** Slots per set (a power of two). */
  private readonly setSlots: number;
  readonly capacity: number;
  private group: GPUBindGroup | null = null;
  private bound: GPUBuffer[] = [];
  /** Which set is this step's. */
  private flip = 0;
  private readonly bodies: GPUBuffer;

  constructor(device: GPUDevice, bodies: GPUBuffer, maxBodies: number, pairs: number, capacity: number) {
    this.device = device;
    this.bodies = bodies;
    this.capacity = capacity;
    this.setSlots = 2 ** Math.ceil(Math.log2(Math.max(64, 2 * pairs)));
    const module = device.createShaderModule({ label: 'contact events', code: WGSL });
    const types: GPUBufferBindingType[] = ['read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'read-only-storage', 'storage', 'storage', 'uniform'];
    this.layout = device.createBindGroupLayout({ label: 'contact events', entries: types.map((type, binding) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } })) });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (entryPoint: string) => device.createComputePipeline({ label: `contact events ${entryPoint}`, layout, compute: { module, entryPoint } });
    this.pipelines = { touching: make('touching'), ended: make('ended') };
    const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    this.watch = device.createBuffer({ label: 'contact watch', size: Math.max(16, maxBodies * 4), usage: storage });
    this.table = device.createBuffer({ label: 'contact sets', size: (HEAD_WORDS + 4 * this.setSlots) * 4, usage: storage });
    this.events = device.createBuffer({ label: 'contact events', size: capacity * EVENT_VEC4S * 16, usage: storage });
    this.params = device.createBuffer({ label: 'contact params', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Which bodies report their contacts. */
  setWatched(indices: number[], on: boolean[]): void {
    indices.forEach((index, k) => this.device.queue.writeBuffer(this.watch, index * 4, new Uint32Array([on[k] ? 1 : 0])));
  }

  /** After a step: its pairs against the last step's. */
  run(storage: { manifolds: GPUBuffer; contacts: GPUBuffer; counters: GPUBuffer }, pairs: number, step: number, dt: number): void {
    const d = this.device;
    const buffers = [this.bodies, storage.manifolds, storage.contacts, storage.counters, this.watch, this.table, this.events, this.params];
    if (!this.group || buffers.some((b, k) => b !== this.bound[k])) {
      this.bound = buffers;
      this.group = d.createBindGroup({ layout: this.layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    }
    this.flip = 1 - this.flip;
    const [old, now] = this.flip ? [0, this.setSlots] : [this.setSlots, 0];
    const params = new Uint32Array([old, now, this.setSlots - 1, this.capacity, pairs, step, 0, 0]);
    new Float32Array(params.buffer)[6] = dt;
    d.queue.writeBuffer(this.params, 0, params);
    const encoder = d.createCommandEncoder({ label: 'contact events' });
    encoder.clearBuffer(this.table, (HEAD_WORDS + 2 * now) * 4, 2 * this.setSlots * 4);
    const pass = encoder.beginComputePass({ label: 'contact events' });
    pass.setBindGroup(0, this.group);
    pass.setPipeline(this.pipelines.touching);
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(pairs / 64)));
    pass.setPipeline(this.pipelines.ended);
    pass.dispatchWorkgroups(Math.ceil(this.setSlots / 64));
    pass.end();
    d.queue.submit([encoder.finish()]);
  }

  /** The events since the last read (and how many didn't fit), clearing them. */
  async read(): Promise<{ events: RawContactEvent[]; dropped: number; full: boolean }> {
    const d = this.device;
    const size = 16 + this.capacity * EVENT_VEC4S * 16;
    const staging = d.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const encoder = d.createCommandEncoder({ label: 'read contact events' });
    encoder.copyBufferToBuffer(this.table, 0, staging, 0, 16);
    encoder.copyBufferToBuffer(this.events, 0, staging, 16, size - 16);
    encoder.clearBuffer(this.table, 0, 16);
    d.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const bytes = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();
    const u = new Uint32Array(bytes);
    const f = new Float32Array(bytes);
    const n = Math.min(u[0], this.capacity);
    const events: RawContactEvent[] = [];
    for (let e = 0; e < n; e++) {
      const o = 4 + e * EVENT_VEC4S * 4;
      events.push({
        kind: u[o] as typeof BEGIN | typeof END,
        a: u[o + 1],
        b: u[o + 2],
        step: u[o + 3],
        point: [f[o + 4], f[o + 5], f[o + 6]],
        impulse: f[o + 7],
        normal: [f[o + 8], f[o + 9], f[o + 10]],
      });
    }
    // In step order (within a step, as the GPU wrote them)
    events.sort((x, y) => x.step - y.step);
    return { events, dropped: u[0] - n, full: u[1] !== 0 };
  }

  destroy(): void {
    for (const b of [this.watch, this.table, this.events, this.params]) b.destroy();
  }
}
