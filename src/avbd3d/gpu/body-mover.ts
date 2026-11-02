// On-demand, bounded commands over active kinematics only. Existing solver bindings stay intact.
import { BODY_LIFECYCLE_WGSL, PRELUDE_3D } from './layout.ts';

const WGSL = `${PRELUDE_3D}
${BODY_LIFECYCLE_WGSL}
struct Move { position: vec4f, rotation: vec4f, timing: vec4f }
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> moves: array<Move>;
@group(0) @binding(2) var<uniform> count: vec4u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= count.x) { return; }
  let m = moves[id.x];
  let i = bitcast<u32>(m.position.w);
  if (!bodyEnabled(i)) { return; }
  let b = bodies[i];
  let time = m.timing.x * m.timing.y;
  bodies[i].vel = vec4f((m.position.xyz - b.pos.xyz) / time, b.vel.w);
  var omega = vec3f(0.0);
  if (m.timing.z != 0.0) {
    var d = normalize(qmul(m.rotation, qconj(b.rot)));
    if (d.w < 0.0) { d = -d; }
    let sine = length(d.xyz);
    if (sine > 1e-7) {
      // qadd uses normalized Euler integration. tan gives exactly the requested
      // shortest-arc fraction on this step, including a large final rotation.
      let halfAngle = atan2(sine, max(d.w, 0.0)) / m.timing.x;
      omega = d.xyz / sine * (2.0 * tan(min(halfAngle, 1.5706963)) / m.timing.y);
    }
  }
  bodies[i].angVel = vec4f(omega, b.angVel.w);
}
`;

export interface MoveCommand {
  index: number;
  position: ArrayLike<number>;
  rotation?: ArrayLike<number>;
  left: number;
  dt: number;
}

export class BodyMover {
  private readonly pipeline: GPUComputePipeline;
  private readonly buffer: GPUBuffer;
  private readonly count: GPUBuffer;
  private readonly group: GPUBindGroup;
  private readonly data: Float32Array<ArrayBuffer>;
  private readonly bits: Uint32Array;

  private readonly device: GPUDevice;
  private readonly capacity: number;

  constructor(device: GPUDevice, bodies: GPUBuffer, capacity: number) {
    this.device = device;
    this.capacity = capacity;
    this.pipeline = device.createComputePipeline({ label: 'body commands', layout: 'auto', compute: { module: device.createShaderModule({ label: 'body commands', code: WGSL }), entryPoint: 'main' } });
    this.buffer = device.createBuffer({ label: 'body commands', size: Math.max(1, capacity) * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.count = device.createBuffer({ label: 'body command count', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.data = new Float32Array(capacity * 12);
    this.bits = new Uint32Array(this.data.buffer);
    this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: bodies } },
      { binding: 1, resource: { buffer: this.buffer } },
      { binding: 2, resource: { buffer: this.count } },
    ] });
  }

  apply(commands: MoveCommand[]): void {
    if (!commands.length) return;
    if (commands.length > this.capacity) throw new Error('Body command capacity exceeded');
    // (A slot past the bodies would be clamped onto another body by the GPU)
    for (const c of commands) if (!(Number.isInteger(c.index) && c.index >= 0 && c.index < this.capacity)) throw new Error(`Body command: no body slot ${c.index}`);
    commands.forEach((c, k) => {
      const o = k * 12;
      this.data.set(Array.from(c.position), o);
      this.bits[o + 3] = c.index;
      this.data.set(c.rotation ? Array.from(c.rotation) : [0, 0, 0, 1], o + 4);
      this.data.set([c.left, c.dt, c.rotation ? 1 : 0, 0], o + 8);
    });
    this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, commands.length * 12);
    this.device.queue.writeBuffer(this.count, 0, new Uint32Array([commands.length, 0, 0, 0]));
    const encoder = this.device.createCommandEncoder({ label: 'body commands' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(commands.length / 64));
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  destroy(): void { this.buffer.destroy(); this.count.destroy(); }
}
