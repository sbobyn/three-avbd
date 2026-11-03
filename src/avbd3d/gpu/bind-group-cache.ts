// Bind groups kept by the exact buffers they bind, so a pass that binds ping-ponged buffers each
// step makes its groups once instead of every step. A buffer replaced (grown, refreshed) is a
// different object, so it misses and makes a new group; the oldest groups go past `size`.

interface Entry {
  key: object;
  buffers: readonly GPUBuffer[];
  group: GPUBindGroup;
}

export class BindGroupCache {
  private entries: Entry[] = [];
  private readonly device: GPUDevice;
  private readonly size: number;

  constructor(device: GPUDevice, size = 8) {
    this.device = device;
    this.size = size;
  }

  /**
   * The group binding `buffers` (binding k: buffers[k], whole) for `key` (the pipeline or layout
   * it is for), made with `layout()` only when no kept group binds exactly these buffers.
   */
  get(key: object, layout: () => GPUBindGroupLayout, buffers: readonly GPUBuffer[]): GPUBindGroup {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (e.key !== key || e.buffers.length !== buffers.length || !e.buffers.every((b, k) => b === buffers[k])) continue;
      if (i !== this.entries.length - 1) this.entries.push(...this.entries.splice(i, 1));
      return e.group;
    }
    const group = this.device.createBindGroup({ layout: layout(), entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    this.entries.push({ key, buffers: [...buffers], group });
    if (this.entries.length > this.size) this.entries.shift();
    return group;
  }

  /** Drop every kept group (their buffers are going). */
  clear(): void {
    this.entries = [];
  }
}
