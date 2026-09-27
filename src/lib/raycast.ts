// Raycasts on the GPU: every ray against every body, where the solver has them now. The nearest
// hit per ray is found in three passes: each (ray, body) pair's distance into an atomic minimum
// (a non-negative float's bits order as an integer's), then the lowest body index at that
// distance (ties), then per ray the hit's normal. The rays and hits are small buffers; the hits
// come back with an async read.

import { B_ANGVEL, B_POS, B_ROT, B_SIZE, BODY_FLOATS, SHAPE_HULL, SHAPE_SPHERE } from '../avbd3d/gpu/layout.ts';

/** Bodies a cast can skip (the caster's own body, say). */
export const MAX_IGNORED = 16;
/** Rays a call (one dispatch row per ray). */
export const MAX_RAYS = 65535;

const WGSL = /* wgsl */ `
struct Ray { o: vec4f, d: vec4f }   // o.w: the most distance, d: unit direction
struct Params { bodies: u32, rays: u32, ignored: u32, pad: u32, ignore: array<vec4u, ${MAX_IGNORED / 4}> }
struct Hit { t: f32, n: vec3f }

@group(0) @binding(0) var<storage, read> bodies: array<vec4f>;
@group(0) @binding(1) var<storage, read> hulls: array<vec4u>;
@group(0) @binding(2) var<storage, read> rays: array<Ray>;
@group(0) @binding(3) var<storage, read_write> best: array<atomic<u32>>;   // per ray: distance bits, body
@group(0) @binding(4) var<storage, read_write> hits: array<vec4f>;         // per ray: normal + distance, body bits
@group(0) @binding(5) var<uniform> params: Params;

const STRIDE = ${BODY_FLOATS / 4}u;
const NONE = 0xffffffffu;
const MISS = Hit(-1.0, vec3f(0.0));

fn turn(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn ignored(b: u32) -> bool {
  for (var i = 0u; i < params.ignored; i++) {
    if (params.ignore[i / 4u][i % 4u] == b) { return true; }
  }
  return false;
}

/** Ray r against body b: the distance to its surface (0 from inside) and the normal there, in the body's frame. */
fn trace(b: u32, r: Ray) -> Hit {
  let base = b * STRIDE;
  let q = bodies[base + ${B_ROT / 4}u];
  let size = bodies[base + ${B_SIZE / 4}u].xyz;
  let shape = bodies[base + ${B_ANGVEL / 4}u].w;
  let inv = vec4f(-q.xyz, q.w);
  let o = turn(inv, r.o.xyz - bodies[base + ${B_POS / 4}u].xyz);
  let d = turn(inv, r.d.xyz);
  var t: f32;
  var n: vec3f;
  if (abs(shape - ${SHAPE_SPHERE}.0) < 0.5) {
    let radius = size.x * 0.5;
    let bh = dot(o, d);
    let c = dot(o, o) - radius * radius;
    let disc = bh * bh - c;
    if (disc < 0.0) { return MISS; }
    t = -bh - sqrt(disc);
    if (c <= 0.0) { t = 0.0; } else if (t < 0.0) { return MISS; }
    n = select(normalize(o + d * t), -d, c <= 0.0);
  } else {
    // A convex shape as planes: entering through the last plane crossed inwards, out at the first crossed outwards
    var tin = -3.0e38;
    var tout = 3.0e38;
    let isHull = shape > ${SHAPE_HULL}.0 - 0.5;
    var faces = 6u;
    var fs = 0u;
    if (isHull) {
      let head = hulls[u32(shape - ${SHAPE_HULL}.0 + 0.5)];
      fs = head.z;
      faces = head.w;
    }
    for (var k = 0u; k < faces; k++) {
      var plane: vec4f;
      if (isHull) { plane = bitcast<vec4f>(hulls[fs + 2u * k]); }
      else {
        // A box's faces: +x -x +y -y +z -z, half its size out
        let axis = k / 2u;
        var e = vec3f(0.0);
        e[axis] = select(-1.0, 1.0, k % 2u == 0u);
        plane = vec4f(e, size[axis] * 0.5);
      }
      let denom = dot(plane.xyz, d);
      let dist = plane.w - dot(plane.xyz, o);
      if (abs(denom) < 1.0e-12) {
        if (dist < 0.0) { return MISS; }
        continue;
      }
      let s = dist / denom;
      if (denom < 0.0) {
        if (s > tin) { tin = s; n = plane.xyz; }
      } else {
        tout = min(tout, s);
      }
      if (tin > tout) { return MISS; }
    }
    if (tout < 0.0) { return MISS; }
    t = tin;
    if (t <= 0.0) { t = 0.0; n = -d; }
  }
  if (t > r.o.w) { return MISS; }
  // (Never -0: its bits would sort as a huge distance)
  return Hit(select(t, 0.0, t <= 0.0), n);
}

@compute @workgroup_size(64)
fn nearest(@builtin(global_invocation_id) id: vec3u) {
  let b = id.x;
  if (b >= params.bodies || ignored(b)) { return; }
  let h = trace(b, rays[id.y]);
  if (h.t >= 0.0) { atomicMin(&best[2u * id.y], bitcast<u32>(h.t)); }
}

@compute @workgroup_size(64)
fn owner(@builtin(global_invocation_id) id: vec3u) {
  let b = id.x;
  if (b >= params.bodies || ignored(b)) { return; }
  let h = trace(b, rays[id.y]);
  if (h.t >= 0.0 && bitcast<u32>(h.t) == atomicLoad(&best[2u * id.y])) { atomicMin(&best[2u * id.y + 1u], b); }
}

@compute @workgroup_size(64)
fn finish(@builtin(global_invocation_id) id: vec3u) {
  let r = id.x;
  if (r >= params.rays) { return; }
  let b = atomicLoad(&best[2u * r + 1u]);
  if (b == NONE) {
    hits[2u * r] = vec4f(0.0, 0.0, 0.0, -1.0);
    return;
  }
  let h = trace(b, rays[r]);
  let q = bodies[b * STRIDE + ${B_ROT / 4}u];
  hits[2u * r] = vec4f(normalize(turn(q, h.n)), h.t);
  hits[2u * r + 1u] = vec4f(bitcast<f32>(b), 0.0, 0.0, 0.0);
}
`;

export interface Ray {
  origin: ArrayLike<number>;
  /** Normalised here. */
  direction: ArrayLike<number>;
  /** Default: as far as it goes. */
  maxDistance?: number;
}

/** A ray's nearest hit: the body's slot, how far along, and the surface normal there (world). */
export interface RawHit {
  index: number;
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
}

export class Raycaster {
  private readonly device: GPUDevice;
  private readonly pipelines: Record<'nearest' | 'owner' | 'finish', GPUComputePipeline>;
  private readonly layout: GPUBindGroupLayout;

  constructor(device: GPUDevice) {
    this.device = device;
    const module = device.createShaderModule({ label: 'raycast', code: WGSL });
    const storage = (type: GPUBufferBindingType) => ({ visibility: GPUShaderStage.COMPUTE, buffer: { type } });
    this.layout = device.createBindGroupLayout({
      label: 'raycast',
      entries: [storage('read-only-storage'), storage('read-only-storage'), storage('read-only-storage'), storage('storage'), storage('storage'), { binding: 5, ...storage('uniform') }].map(
        (e, binding) => ({ ...e, binding }),
      ),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const make = (entryPoint: string) => device.createComputePipeline({ label: `raycast ${entryPoint}`, layout, compute: { module, entryPoint } });
    this.pipelines = { nearest: make('nearest'), owner: make('owner'), finish: make('finish') };
  }

  /** The nearest hit of each ray among bodies 0 to `count`, skipping `ignore` (slots). */
  async cast(bodies: GPUBuffer, hulls: GPUBuffer, count: number, rays: Ray[], ignore: number[] = []): Promise<(RawHit | null)[]> {
    const n = rays.length;
    if (!n) return [];
    if (ignore.length > MAX_IGNORED) throw new Error(`raycast: at most ${MAX_IGNORED} bodies to ignore`);
    if (n > MAX_RAYS) throw new Error(`raycast: at most ${MAX_RAYS} rays a call`);
    const d = this.device;
    const rayData = new Float32Array(n * 8);
    const dirs: number[][] = [];
    rays.forEach((r, k) => {
      const l = Math.hypot(r.direction[0], r.direction[1], r.direction[2]) || 1;
      const dir = [r.direction[0] / l, r.direction[1] / l, r.direction[2] / l];
      dirs.push(dir);
      rayData.set([r.origin[0], r.origin[1], r.origin[2], r.maxDistance ?? 3.0e38, dir[0], dir[1], dir[2], 0], k * 8);
    });
    const params = new Uint32Array(4 + MAX_IGNORED);
    params.set([count, n, ignore.length, 0]);
    params.set(ignore, 4);
    const best = new Uint32Array(2 * n);
    for (let k = 0; k < n; k++) best.set([0x7f800000, 0xffffffff], 2 * k);
    const buffer = (data: ArrayBufferView<ArrayBuffer>, usage: number) => {
      const b = d.createBuffer({ size: Math.max(16, data.byteLength), usage: usage | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(b, 0, data);
      return b;
    };
    const rayBuffer = buffer(rayData, GPUBufferUsage.STORAGE);
    const bestBuffer = buffer(best, GPUBufferUsage.STORAGE);
    const hitBuffer = d.createBuffer({ size: n * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const paramBuffer = buffer(params, GPUBufferUsage.UNIFORM);
    const read = d.createBuffer({ size: n * 32, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const group = d.createBindGroup({
      layout: this.layout,
      entries: [bodies, hulls, rayBuffer, bestBuffer, hitBuffer, paramBuffer].map((b, binding) => ({ binding, resource: { buffer: b } })),
    });
    const encoder = d.createCommandEncoder({ label: 'raycast' });
    const pass = encoder.beginComputePass({ label: 'raycast' });
    pass.setBindGroup(0, group);
    const across = Math.max(1, Math.ceil(count / 64));
    for (const name of ['nearest', 'owner'] as const) {
      pass.setPipeline(this.pipelines[name]);
      pass.dispatchWorkgroups(across, n);
    }
    pass.setPipeline(this.pipelines.finish);
    pass.dispatchWorkgroups(Math.ceil(n / 64));
    pass.end();
    encoder.copyBufferToBuffer(hitBuffer, 0, read, 0, n * 32);
    d.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.unmap();
    for (const b of [rayBuffer, bestBuffer, hitBuffer, paramBuffer, read]) b.destroy();
    const bits = new Uint32Array(out.buffer);
    return rays.map((r, k) => {
      const t = out[k * 8 + 3];
      if (t < 0) return null;
      const dir = dirs[k];
      return {
        index: bits[k * 8 + 4],
        distance: t,
        point: [r.origin[0] + dir[0] * t, r.origin[1] + dir[1] * t, r.origin[2] + dir[2] * t],
        normal: [out[k * 8], out[k * 8 + 1], out[k * 8 + 2]],
      };
    });
  }
}
