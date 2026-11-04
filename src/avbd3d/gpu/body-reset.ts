// Reset only requested records, using their actual GPU pose. No readback or whole-world pass.
import { PRELUDE_3D } from './layout.ts';

const WGSL = `${PRELUDE_3D}
@group(0) @binding(0) var<storage, read_write> bodies: array<Body>;
@group(0) @binding(1) var<storage, read> indices: array<u32>;
@group(0) @binding(2) var<uniform> count: vec4u;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= count.x) { return; }
  let i = indices[id.x];
  bodies[i].initialPos = vec4f(bodies[i].pos.xyz, bodies[i].initialPos.w);
  bodies[i].inertialPos = vec4f(bodies[i].pos.xyz, bodies[i].inertialPos.w);
  bodies[i].initialRot = bodies[i].rot;
  bodies[i].inertialRot = bodies[i].rot;
  bodies[i].vel = vec4f(0.0);
  bodies[i].angVel = vec4f(vec3f(0.0), bodies[i].angVel.w);
}
`;

export class BodyReset {
  private readonly indices: GPUBuffer;
  private readonly count: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly group: GPUBindGroup;
  private readonly device: GPUDevice;
  private readonly capacity: number;
  constructor(device: GPUDevice, bodies: GPUBuffer, capacity: number) {
    this.device = device;
    this.capacity = capacity;
    this.pipeline = device.createComputePipeline({ label: 'body reset', layout: 'auto', compute: { module: device.createShaderModule({ code: WGSL }), entryPoint: 'main' } });
    this.indices = device.createBuffer({ label: 'body reset indices', size: capacity * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    let count: GPUBuffer | undefined;
    try {
      this.count = count = device.createBuffer({ label: 'body reset count', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.group = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: bodies } }, { binding: 1, resource: { buffer: this.indices } }, { binding: 2, resource: { buffer: this.count } },
      ] });
    } catch (error) {
      this.indices.destroy(); count?.destroy(); throw error;
    }
  }
  apply(indices: number[]): void {
    if (!indices.length) return;
    // Past the buffer, or a slot past the bodies (which the GPU would clamp onto another body)
    if (indices.length > this.capacity) throw new Error('Body reset capacity exceeded');
    for (const i of indices) if (!(Number.isInteger(i) && i >= 0 && i < this.capacity)) throw new Error(`Body reset: no body slot ${i}`);
    this.device.queue.writeBuffer(this.indices, 0, new Uint32Array(indices));
    this.device.queue.writeBuffer(this.count, 0, new Uint32Array([indices.length, 0, 0, 0]));
    const encoder = this.device.createCommandEncoder({ label: 'body reset' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(Math.ceil(indices.length / 64)); pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
  destroy(): void { this.indices.destroy(); this.count.destroy(); }
}
