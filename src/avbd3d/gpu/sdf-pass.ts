// Experimental standalone SDF pass. Importing this file never creates a GPU device.
import type { Field } from '../ref/sdf/shapes.ts';
import type { SdfBody } from '../ref/sdf/body.ts';
import { collisionParams, type CollisionParams } from '../ref/sdf/manifold.ts';
import { sdfHistorySource } from './wgsl-sdf-history.ts';
import { sdfNarrowphaseSource } from './wgsl-sdf.ts';
import { packSdfAtlas, packSdfBodies, packSdfPairs, packSdfParams, decodeSdfResults, checkSdfPointCapacity, sdfResultWords, SDF_BODY_WORDS, SDF_MAX_POINTS, type SdfAtlas, type SdfPair, type GpuSdfResult } from './sdf-layout.ts';
export interface SdfPassOptions { maxBodies: number; maxPairs: number; maxAtlasBytes?: number; meshVertexContacts?: boolean;
  /** Points per pair result (default 5): bounds cacheSize ≤ maxPoints−1 and cache + samples ≤ maxPoints. */
  maxPoints?: number }
/** Standalone pass, also used by the internal production collision bridge.
 * Pairs are supplied by the caller; previous slots explicitly remap cache across
 * pair reorderings. Change pair keys when body slots are recycled or fields change.
 */
export class SdfNarrowphasePass {
  readonly device: GPUDevice;
  readonly atlas: SdfAtlas;
  readonly options: SdfPassOptions;
  readonly pipeline: GPUComputePipeline;
  private readonly seedPipeline: GPUComputePipeline | null;
  private readonly seedBuffer: GPUBuffer | null;
  private readonly seedGroup: GPUBindGroup | null;
  private readonly seedStride: number;
  private readonly historyPipeline: GPUComputePipeline;
  private readonly shapeBuffer: GPUBuffer;
  private readonly bodyBuffer: GPUBuffer;
  private readonly pairBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private readonly output: [GPUBuffer, GPUBuffer];
  private readonly groups: [GPUBindGroup, GPUBindGroup];
  private current = 0;
  private count = 0;
  private stepIndex = 0;
  private disposed = false;
  /** Points per pair result, fixed at creation. */
  get maxPoints(): number { return this.options.maxPoints ?? SDF_MAX_POINTS; }
  /** Words per pair result for this pass. */
  get resultWords(): number { return sdfResultWords(this.maxPoints); }
  static async create(device: GPUDevice, fields: readonly Field[], options: SdfPassOptions): Promise<SdfNarrowphasePass> {
    for (const value of [options.maxBodies, options.maxPairs]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('SDF capacities must be positive integers');
    const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
    const maxPoints=checkSdfPointCapacity(options.maxPoints??SDF_MAX_POINTS), resultWords=sdfResultWords(maxPoints);
    if (options.maxBodies*SDF_BODY_WORDS*4>limit || options.maxPairs*resultWords*4>limit || Math.ceil(options.maxPairs/64)>device.limits.maxComputeWorkgroupsPerDimension) throw new Error('SDF pass capacities exceed device limits');
    if (device.limits.maxStorageBuffersPerShaderStage<5 || device.limits.maxComputeInvocationsPerWorkgroup<64) throw new Error('Device cannot run the SDF pass');
    const atlas=packSdfAtlas(fields,Math.min(options.maxAtlasBytes ?? 64*1024*1024,limit),options.meshVertexContacts);
    // Bound the optional per-body seed cache; small scenes and large allocations keep the direct path.
    const stride=fields.reduce((n,f)=>Math.max(n,f.seeds.length),0);
    const seedStride=device.limits.maxStorageBuffersPerShaderStage>=6 && options.maxBodies>=256 && options.maxBodies<=device.limits.maxComputeWorkgroupsPerDimension && Math.ceil(stride/64)<=device.limits.maxComputeWorkgroupsPerDimension && stride*options.maxBodies*16<=Math.min(limit,128*1024*1024)?stride:0;
    const module=device.createShaderModule({ label: 'experimental sdf narrowphase', code: sdfNarrowphaseSource(maxPoints,seedStride) });
    const info=await module.getCompilationInfo(); const errors=info.messages.filter(m=>m.type==='error');
    if(errors.length) throw new Error(errors.map(m=>`${m.lineNum}:${m.linePos} ${m.message}`).join('\n'));
    const pipeline=await device.createComputePipelineAsync({ label:'experimental sdf narrowphase', layout:'auto', compute:{module,entryPoint:'narrowphase'} });
    const seedPipeline=seedStride?await device.createComputePipelineAsync({label:'sdf transform seeds',layout:'auto',compute:{module,entryPoint:'transformSeeds'}}):null;
    const historyModule=device.createShaderModule({label:'sdf history transfer',code:sdfHistorySource(maxPoints)});
    const historyPipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:historyModule,entryPoint:'copyHistory'}});
    return new SdfNarrowphasePass(device,atlas,{...options,maxPoints},pipeline,historyPipeline,seedPipeline,seedStride);
  }
  private constructor(device: GPUDevice, atlas: SdfAtlas, options: SdfPassOptions, pipeline: GPUComputePipeline, historyPipeline: GPUComputePipeline, seedPipeline: GPUComputePipeline | null, seedStride: number) {
    this.device=device; this.atlas=atlas; this.options={...options}; this.pipeline=pipeline;this.historyPipeline=historyPipeline;this.seedPipeline=seedPipeline;this.seedStride=seedStride;
    const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC;
    const allocated: GPUBuffer[] = [];
    const make=(label:string,size:number,usage=storage)=>{
      const buffer=device.createBuffer({label,size,usage}); allocated.push(buffer); return buffer;
    };
    try {
      this.shapeBuffer=make('sdf atlas',atlas.data.byteLength); device.queue.writeBuffer(this.shapeBuffer,0,atlas.data);
      this.bodyBuffer=make('sdf bodies',options.maxBodies*SDF_BODY_WORDS*4);
      this.seedBuffer=seedStride?make('sdf world seeds',options.maxBodies*seedStride*16):null;
      this.seedGroup=seedPipeline?device.createBindGroup({layout:seedPipeline.getBindGroupLayout(0),entries:[{binding:1,resource:{buffer:this.shapeBuffer}},{binding:2,resource:{buffer:this.bodyBuffer}},{binding:6,resource:{buffer:this.seedBuffer!}}]}):null;
      this.pairBuffer=make('sdf pairs',options.maxPairs*16);
      this.paramsBuffer=make('sdf params',80,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);
      this.output=[make('sdf results 0',options.maxPairs*this.resultWords*4),make('sdf results 1',options.maxPairs*this.resultWords*4)];
      const group=(index:number)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[this.paramsBuffer,this.shapeBuffer,this.bodyBuffer,this.pairBuffer,this.output[index^1],this.output[index],...(this.seedBuffer?[this.seedBuffer]:[])].map((buffer,binding)=>({binding,resource:{buffer}}))});
      this.groups=[group(0),group(1)];
    } catch (error) {
      for (const buffer of allocated) buffer.destroy();
      throw error;
    }
  }
  /** Writes and submits exactly one pass, so uniform uploads cannot race an
   * unsubmitted encoder. No implicit readback or solver integration. */
  step(bodies: readonly SdfBody[], pairs: readonly SdfPair[], dt: number, params: CollisionParams=collisionParams()): void {
    if(this.disposed) throw new Error('SDF pass is disposed');
    if(params.meshVertexContacts && !this.options.meshVertexContacts)throw new Error('meshVertexContacts must be enabled when creating the SDF pass');
    if(bodies.length>this.options.maxBodies || pairs.length>this.options.maxPairs) throw new Error('SDF pass capacity exceeded');
    const packedBodies=packSdfBodies(bodies,this.atlas), packedPairs=packSdfPairs(pairs,bodies.length,this.count);
    const packedParams=packSdfParams(pairs.length,this.stepIndex,dt,params,this.maxPoints);
    const next=this.current^1;
    this.device.queue.writeBuffer(this.bodyBuffer,0,packedBodies);
    this.device.queue.writeBuffer(this.pairBuffer,0,packedPairs);
    this.device.queue.writeBuffer(this.paramsBuffer,0,packedParams);
    const encoder=this.device.createCommandEncoder({label:'sdf narrowphase'});
    if(pairs.length) { const pass=encoder.beginComputePass(); this.encodeSeeds(pass,params); pass.setPipeline(this.pipeline); pass.setBindGroup(0,this.groups[next]); pass.dispatchWorkgroups(Math.ceil(pairs.length/64)); pass.end(); }
    this.device.queue.submit([encoder.finish()]); this.current=next; this.count=pairs.length; this.stepIndex=(this.stepIndex+1)>>>0;
  }
  /** Internal bridge bindings; poses may be prepared directly from production GPU bodies. */
  get storage() {
    return { atlas: this.shapeBuffer, bodies: this.bodyBuffer, pairs: this.pairBuffer,
      current: this.output[this.current], previous: this.output[this.current^1] };
  }
  /** The caller submits this pass before preparing another step. No implicit readback. */
  encodeFromGpu(pass: GPUComputePassEncoder, bodyCount: number, pairs: readonly SdfPair[], dt: number, params: CollisionParams, preparePairs?: () => void): void {
    if(this.disposed) throw new Error('SDF pass is disposed');
    if(params.meshVertexContacts && !this.options.meshVertexContacts)throw new Error('meshVertexContacts must be enabled when creating the SDF pass');
    if(bodyCount>this.options.maxBodies || pairs.length>this.options.maxPairs) throw new Error('SDF pass capacity exceeded');
    const packedPairs=packSdfPairs(pairs,bodyCount,this.count);
    const packedParams=packSdfParams(pairs.length,this.stepIndex,dt,params,this.maxPoints);
    this.device.queue.writeBuffer(this.pairBuffer,0,packedPairs);
    this.device.queue.writeBuffer(this.paramsBuffer,0,packedParams);
    preparePairs?.();
    this.encodeSeeds(pass,params);
    const next=this.current^1;
    if(pairs.length) { pass.setPipeline(this.pipeline); pass.setBindGroup(0,this.groups[next]); pass.dispatchWorkgroups(Math.ceil(pairs.length/64)); }
    this.current=next; this.count=pairs.length; this.stepIndex=(this.stepIndex+1)>>>0;
  }
  /** GPU broadphase fills candidates and remaps previous slots before dispatch. */
  encodeGeneratedPairs(pass: GPUComputePassEncoder, dt: number, params: CollisionParams, preparePairs: () => void): void {
    if(this.disposed) throw new Error('SDF pass is disposed');
    if(params.meshVertexContacts && !this.options.meshVertexContacts)throw new Error('meshVertexContacts must be enabled when creating the SDF pass');
    const count=this.options.maxPairs;
    this.device.queue.writeBuffer(this.paramsBuffer,0,packSdfParams(count,this.stepIndex,dt,params,this.maxPoints));
    preparePairs();
    this.encodeSeeds(pass,params);
    const next=this.current^1;
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.groups[next]);pass.dispatchWorkgroups(Math.ceil(count/64));
    this.current=next;this.count=count;this.stepIndex=(this.stepIndex+1)>>>0;
  }
  private encodeSeeds(pass:GPUComputePassEncoder,params:CollisionParams) {
    if(this.seedPipeline && params.curvatureSampling) {
      pass.setPipeline(this.seedPipeline);pass.setBindGroup(0,this.seedGroup!);
      pass.dispatchWorkgroups(Math.ceil(this.seedStride/64),this.options.maxBodies);
    }
  }
  /** Reuse the immutable atlas and pipelines when only candidate capacity changes. */
  resized(maxPairs:number): SdfNarrowphasePass {
    if(this.disposed)throw new Error('SDF pass is disposed');
    const limit=Math.min(this.device.limits.maxBufferSize,this.device.limits.maxStorageBufferBindingSize);
    if(!Number.isSafeInteger(maxPairs)||maxPairs<this.options.maxPairs||maxPairs*this.resultWords*4>limit||
      Math.ceil(maxPairs/64)>this.device.limits.maxComputeWorkgroupsPerDimension)throw new Error('Invalid SDF growth capacity');
    return new SdfNarrowphasePass(this.device,this.atlas,{...this.options,maxPairs},this.pipeline,this.historyPipeline,this.seedPipeline,this.seedStride);
  }
  /** GPU-only migration. The owner must install the replacement before another step. */
  inheritHistory(previous:SdfNarrowphasePass,retained:readonly boolean[]): void {
    if(this.disposed||previous.disposed||this.device!==previous.device||this===previous)throw new Error('Invalid SDF history owner');
    if(retained.length!==this.options.maxBodies)throw new Error('Invalid SDF retained slot count');
    if(previous.maxPoints!==this.maxPoints)throw new Error('SDF history requires matching point capacity');
    const d=this.device, mask=d.createBuffer({size:retained.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    try {
      d.queue.writeBuffer(mask,0,new Uint32Array(retained.map(v=>+v)));
      const group=d.createBindGroup({layout:this.historyPipeline.getBindGroupLayout(0),
        entries:[previous.storage.current,this.storage.current,mask].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(this.historyPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.options.maxPairs/64));pass.end();
      d.queue.submit([encoder.finish()]);
      this.count=Math.min(previous.count,this.options.maxPairs);this.stepIndex=previous.stepIndex;
    } finally {mask.destroy();}
  }
  async readResults(): Promise<GpuSdfResult[]> {
    if(this.disposed) throw new Error('SDF pass is disposed');
    const count=this.count; if(!count) return [];
    const size=count*this.resultWords*4;
    const read=this.device.createBuffer({label:'sdf readback',size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    try {
      const encoder=this.device.createCommandEncoder(); encoder.copyBufferToBuffer(this.output[this.current],0,read,0,size); this.device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ); return decodeSdfResults(read.getMappedRange().slice(0),count,this.maxPoints);
    } finally { read.destroy(); }
  }
  destroy(): void {
    if(this.disposed) return; this.disposed=true;
    this.seedBuffer?.destroy();
    for(const buffer of [this.shapeBuffer,this.bodyBuffer,this.pairBuffer,this.paramsBuffer,...this.output]) buffer.destroy();
  }
}
