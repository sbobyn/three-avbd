import type { Field } from '../ref/sdf/shapes.ts';
import type { GpuCollisionContext3D } from './solver.ts';
import type { SdfNarrowphasePass } from './sdf-pass.ts';
import { checkSdfPointCapacity, sdfResultWords, SDF_MAX_POINTS } from './sdf-layout.ts';
import { sdfBroadphaseSource } from './wgsl-sdf-broadphase.ts';
import { BindGroupCache } from './bind-group-cache.ts';

export interface SdfBroadphaseOptions {
  /** Grid cell width in world units; default is median field bounding diagonal. */
  cellSize?: number;
  /** Candidate-pair capacity, not contact count. Overflow sets solver overflow bit 1.
   * Default: up to eight pairs per body, bounded by possible pairs/device limits. */
  maxPairs?: number;
  /** World periodically grows capacity after overflow (default true). */
  autoGrow?: boolean;
  /** Points per pair result (default 5, at most 20): the cache-size and sample budget
   * ceiling (cache ≤ points−1). Larger values cost memory and solver contact capacity. */
  maxPointsPerPair?: number;
}
const powerOfTwo=(n:number)=>2**Math.ceil(Math.log2(Math.max(2,n)));
export function sdfBroadphaseOptions(device:GPUDevice,bodies:readonly {field:Field;scale?:number}[],options:SdfBroadphaseOptions) {
  const n=bodies.length, limit=Math.min(device.limits.maxBufferSize,device.limits.maxStorageBufferBindingSize);
  const maxPoints=checkSdfPointCapacity(options.maxPointsPerPair??SDF_MAX_POINTS);
  const maximum=Math.min(Math.floor(limit/(sdfResultWords(maxPoints)*4)),device.limits.maxComputeWorkgroupsPerDimension*64);
  const maxPairs=options.maxPairs??Math.max(1,Math.min(n*(n-1)/2,Math.max(64,n*8),maximum));
  const sizes=bodies.map(b=>Math.hypot(...b.field.bounds.max.map((v,i)=>v-b.field.bounds.min[i]))*(b.scale??1)).sort((a,b)=>a-b);
  const cellSize=Math.fround(options.cellSize??sizes[Math.floor(n/2)]);
  if(!Number.isSafeInteger(maxPairs)||maxPairs<1||maxPairs>maximum)throw new Error('Invalid SDF broadphase pair capacity');
  if(!(cellSize>0)||!Number.isFinite(cellSize))throw new Error('Invalid SDF broadphase cell size');
  const tableSize=powerOfTwo(n*2), cacheSize=powerOfTwo(maxPairs*2);
  const words=tableSize+n+4+cacheSize;
  if(words*4>limit||Math.ceil(Math.max(words,maxPairs)/64)>device.limits.maxComputeWorkgroupsPerDimension)throw new Error('SDF spatial grid exceeds device limits');
  return {maxPairs,maxPoints,cellSize,tableSize,cacheSize,words};
}
export class SdfSpatialBroadphase {
  private readonly grid:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly layout:GPUBindGroupLayout;
  private readonly pipelines:GPUComputePipeline[];
  private readonly device:GPUDevice;
  private readonly size:ReturnType<typeof sdfBroadphaseOptions>;
  private readonly bodyCount:number;
  private disposed=false;
  /** The step's group, by the buffers it binds (the narrowphase output ping-pongs). */
  private readonly groups:BindGroupCache;
  static async create(device:GPUDevice,bodyCount:number,size:ReturnType<typeof sdfBroadphaseOptions>) {
    const module=device.createShaderModule({label:'sdf spatial broadphase',code:sdfBroadphaseSource(size.maxPoints)});
    const info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
    if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    const types:GPUBufferBindingType[]=['uniform','uniform','read-only-storage','storage','storage','read-only-storage','read-only-storage','read-only-storage','read-only-storage','storage'];
    const layout=device.createBindGroupLayout({entries:types.map((type,binding)=>({binding,visibility:GPUShaderStage.COMPUTE,buffer:{type}}))});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    const pipelines:GPUComputePipeline[]=[];
    for(const entryPoint of ['clearGrid','buildGrid','cachePairs','findPairs'])pipelines.push(await device.createComputePipelineAsync({layout:pipelineLayout,compute:{module,entryPoint}}));
    return new SdfSpatialBroadphase(device,bodyCount,size,layout,pipelines);
  }
  private constructor(device:GPUDevice,bodyCount:number,size:ReturnType<typeof sdfBroadphaseOptions>,layout:GPUBindGroupLayout,pipelines:GPUComputePipeline[]) {
    this.device=device;this.bodyCount=bodyCount;this.size=size;this.layout=layout;this.pipelines=pipelines;this.groups=new BindGroupCache(device);
    this.grid=device.createBuffer({label:'sdf spatial grid/cache',size:size.words*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    try {this.uniform=device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});}
    catch(error){this.grid.destroy();throw error;}
  }
  resized(maxPairs:number): SdfSpatialBroadphase {
    const cacheSize=powerOfTwo(maxPairs*2),words=this.size.tableSize+this.bodyCount+4+cacheSize;
    const limit=Math.min(this.device.limits.maxBufferSize,this.device.limits.maxStorageBufferBindingSize);
    if(!Number.isSafeInteger(maxPairs)||maxPairs<this.size.maxPairs||maxPairs*sdfResultWords(this.size.maxPoints)*4>limit||
      words*4>limit||Math.ceil(Math.max(words,maxPairs)/64)>this.device.limits.maxComputeWorkgroupsPerDimension)
      throw new Error('SDF growth exceeds device limits');
    return new SdfSpatialBroadphase(this.device,this.bodyCount,{...this.size,maxPairs,cacheSize,words},this.layout,this.pipelines);
  }
  encode(pass:GPUComputePassEncoder,context:GpuCollisionContext3D,sdf:SdfNarrowphasePass,margin:number) {
    if(this.disposed)throw new Error('SDF spatial broadphase disposed');
    const s=this.size,n=this.bodyCount,data=new Uint32Array(12),f=new Float32Array(data.buffer);
    data.set([n,s.maxPairs,s.tableSize,s.cacheSize,s.tableSize,s.tableSize+n,s.tableSize+n+1,s.tableSize+n+4]);f.set([s.cellSize,margin],8);
    this.device.queue.writeBuffer(this.uniform,0,data);
    const buffers=[context.params,this.uniform,sdf.storage.bodies,this.grid,sdf.storage.pairs,sdf.storage.current,context.statics,context.joints,context.filters,context.counters];
    pass.setBindGroup(0,this.groups.get(this.layout,()=>this.layout,buffers));
    [Math.max(s.words,s.maxPairs),n,s.maxPairs,n].forEach((count,i)=>{pass.setPipeline(this.pipelines[i]);pass.dispatchWorkgroups(Math.ceil(count/64));});
  }
  /** Explicit diagnostic readback; never needed for stepping. */
  async readStats() {
    if(this.disposed)throw new Error('SDF spatial broadphase disposed');
    const read=this.device.createBuffer({size:12,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try {
      const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.grid,(this.size.tableSize+this.bodyCount+1)*4,read,0,12);
      this.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const data=new Uint32Array(read.getMappedRange());return {pairs:data[0],testedPairs:data[1],largeBodies:data[2],capacity:this.size.maxPairs,cellSize:this.size.cellSize};
    } finally {read.destroy();}
  }
  destroy() {if(!this.disposed){this.disposed=true;this.groups.clear();this.grid.destroy();this.uniform.destroy();}}
}
