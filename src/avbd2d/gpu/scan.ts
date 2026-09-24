// In-place exclusive prefix sum of a u32 range of a storage buffer. Multi-level: each
// workgroup scans 512 elements and writes its total to the next level, which is scanned the
// same way, then block offsets are added back down. Every level has its own scratch buffer so
// no buffer is bound twice in one dispatch. The length must be known when encoding.

const BLOCK = 512;

const scanWGSL = /* wgsl */ `
struct ScanParams {
  offset: u32,  // first element of the range in data
  n: u32,       // elements in the range
  pad0: u32,
  pad1: u32,
}

@group(0) @binding(0) var<uniform> sp: ScanParams;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
@group(0) @binding(2) var<storage, read_write> sums: array<u32>;

var<workgroup> partial: array<u32, 256>;

fn load(i: u32) -> u32 {
  if (i < sp.n) { return data[sp.offset + i]; }
  return 0u;
}

@compute @workgroup_size(256)
fn scanBlocks(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let base = wid.x * ${BLOCK}u + lid.x * 2u;
  let a = load(base);
  let b = load(base + 1u);
  let own = a + b;
  partial[lid.x] = own;
  workgroupBarrier();
  // Hillis-Steele inclusive scan of the 256 pair sums
  for (var d = 1u; d < 256u; d *= 2u) {
    var v = 0u;
    if (lid.x >= d) { v = partial[lid.x - d]; }
    workgroupBarrier();
    partial[lid.x] += v;
    workgroupBarrier();
  }
  let exclusive = partial[lid.x] - own;
  if (base < sp.n) { data[sp.offset + base] = exclusive; }
  if (base + 1u < sp.n) { data[sp.offset + base + 1u] = exclusive + a; }
  if (lid.x == 255u) { sums[wid.x] = partial[255]; }
}

@compute @workgroup_size(256)
fn addBlocks(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u) {
  let add = sums[wid.x];
  let base = wid.x * ${BLOCK}u + lid.x * 2u;
  if (base < sp.n) { data[sp.offset + base] += add; }
  if (base + 1u < sp.n) { data[sp.offset + base + 1u] += add; }
}
`;

interface Level {
  n: number;
  blocks: number;
  group: GPUBindGroup;
}

export class PrefixScan {
  private readonly levels: Level[] = [];
  private readonly buffers: GPUBuffer[] = [];
  private readonly scanPipeline: GPUComputePipeline;
  private readonly addPipeline: GPUComputePipeline;

  /** Scan data[offset .. offset + n) of `data` (n fixed for this instance). */
  constructor(device: GPUDevice, data: GPUBuffer, offset: number, n: number) {
    const module = device.createShaderModule({ label: 'prefix scan', code: scanWGSL });
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.scanPipeline = device.createComputePipeline({ label: 'scanBlocks', layout: pipelineLayout, compute: { module, entryPoint: 'scanBlocks' } });
    this.addPipeline = device.createComputePipeline({ label: 'addBlocks', layout: pipelineLayout, compute: { module, entryPoint: 'addBlocks' } });

    // Level k scans `target` (n elements at `off`) and writes block totals into `sums`
    let target = data;
    let off = offset;
    let len = n;
    for (;;) {
      const blocks = Math.max(1, Math.ceil(len / BLOCK));
      const sums = device.createBuffer({ label: `scan sums ${this.levels.length}`, size: Math.max(blocks, 4) * 4, usage: GPUBufferUsage.STORAGE });
      const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM, mappedAtCreation: true });
      new Uint32Array(params.getMappedRange()).set([off, len, 0, 0]);
      params.unmap();
      this.buffers.push(sums, params);
      const group = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: { buffer: target } },
          { binding: 2, resource: { buffer: sums } },
        ],
      });
      this.levels.push({ n: len, blocks, group });
      if (blocks === 1) break;
      target = sums;
      off = 0;
      len = blocks;
    }
  }

  encode(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.scanPipeline);
    for (const level of this.levels) {
      pass.setBindGroup(0, level.group);
      pass.dispatchWorkgroups(level.blocks);
    }
    pass.setPipeline(this.addPipeline);
    for (let k = this.levels.length - 2; k >= 0; k--) {
      pass.setBindGroup(0, this.levels[k].group);
      pass.dispatchWorkgroups(this.levels[k].blocks);
    }
  }

  destroy(): void {
    for (const b of this.buffers) b.destroy();
  }
}
