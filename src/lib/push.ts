// Impulses and forces on bodies: a compute pass over the solver's body buffer before a step,
// changing each pushed body's velocity (Δv = J/m) and angular velocity (Δω = I⁻¹ r × J, in its
// principal frame), with the mass, moments and pose the GPU holds. The CPU sums each body's pushes
// for the step into one record, so no two threads touch a body.

import { B_ANGVEL, B_MOMENT, B_POS, B_ROT, B_SIZE, B_VEL, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';

/** Per pushed body: the linear impulse (N·s), the part of it applied off-centre, and its moment about the origin (plus any angular impulse). */
const PUSH_FLOATS = 12;

const WGSL = /* wgsl */ `
struct Push {
  lin: vec4f,      // xyz: the whole linear impulse, w: the body (bits)
  offLin: vec4f,   // xyz: the part applied at points
  moment: vec4f,   // xyz: those parts' moment about the origin, plus angular impulses
}
@group(0) @binding(0) var<storage, read_write> bodies: array<vec4f>;
@group(0) @binding(1) var<storage, read> pushes: array<Push>;
@group(0) @binding(2) var<uniform> count: vec4u;

fn turn(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= count.x) { return; }
  let p = pushes[id.x];
  let b = bitcast<u32>(p.lin.w) * ${BODY_FLOATS / 4}u;
  let mass = bodies[b + ${B_SIZE / 4}u].w;
  if (mass <= 0.0) { return; }
  let v = bodies[b + ${B_VEL / 4}u];
  bodies[b + ${B_VEL / 4}u] = vec4f(v.xyz + p.lin.xyz / mass, v.w);
  // The angular impulse about the centre of mass, where the GPU has it now
  let L = p.moment.xyz - cross(bodies[b + ${B_POS / 4}u].xyz, p.offLin.xyz);
  let q = bodies[b + ${B_ROT / 4}u];
  let local = turn(vec4f(-q.xyz, q.w), L) / max(bodies[b + ${B_MOMENT / 4}u].xyz, vec3f(1e-12));
  let w = bodies[b + ${B_ANGVEL / 4}u];
  bodies[b + ${B_ANGVEL / 4}u] = vec4f(w.xyz + turn(q, local), w.w);
}
`;

/** One body's pushes for a step: linear impulse, the off-centre part, and the moment. */
export interface Pushes {
  lin: [number, number, number];
  offLin: [number, number, number];
  moment: [number, number, number];
}

export const noPush = (): Pushes => ({ lin: [0, 0, 0], offLin: [0, 0, 0], moment: [0, 0, 0] });

/** Add impulse `j` at world point `at` (none: at the centre of mass) to `p`. */
export function addImpulse(p: Pushes, j: ArrayLike<number>, at?: ArrayLike<number>): void {
  for (let a = 0; a < 3; a++) p.lin[a] += j[a];
  if (!at) return;
  for (let a = 0; a < 3; a++) p.offLin[a] += j[a];
  p.moment[0] += at[1] * j[2] - at[2] * j[1];
  p.moment[1] += at[2] * j[0] - at[0] * j[2];
  p.moment[2] += at[0] * j[1] - at[1] * j[0];
}

export class Pusher {
  private readonly device: GPUDevice;
  private readonly bodies: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly count: GPUBuffer;
  private buffer: GPUBuffer | null = null;
  private group: GPUBindGroup | null = null;
  private capacity = 0;

  constructor(device: GPUDevice, bodies: GPUBuffer) {
    this.device = device;
    this.bodies = bodies;
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ label: 'pushes', code: WGSL }), entryPoint: 'main' } });
    this.count = device.createBuffer({ label: 'push count', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Apply these pushes (body index → pushes) to the bodies, now (before the next step). */
  apply(pushes: Map<number, Pushes>): void {
    const n = pushes.size;
    if (!n) return;
    if (n > this.capacity) {
      this.buffer?.destroy();
      this.capacity = Math.max(n, 2 * this.capacity, 64);
      this.buffer = this.device.createBuffer({ label: 'pushes', size: this.capacity * PUSH_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.group = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.bodies } },
          { binding: 1, resource: { buffer: this.buffer } },
          { binding: 2, resource: { buffer: this.count } },
        ],
      });
    }
    const data = new Float32Array(n * PUSH_FLOATS);
    const bits = new Uint32Array(data.buffer);
    let k = 0;
    for (const [index, p] of pushes) {
      const o = k++ * PUSH_FLOATS;
      data.set(p.lin, o);
      bits[o + 3] = index;
      data.set(p.offLin, o + 4);
      data.set(p.moment, o + 8);
    }
    this.device.queue.writeBuffer(this.buffer!, 0, data);
    this.device.queue.writeBuffer(this.count, 0, new Uint32Array([n, 0, 0, 0]));
    const encoder = this.device.createCommandEncoder({ label: 'pushes' });
    const pass = encoder.beginComputePass({ label: 'pushes' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group!);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    this.buffer?.destroy();
    this.count.destroy();
  }
}
