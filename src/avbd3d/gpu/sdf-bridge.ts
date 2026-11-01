// Internal collision replacement, with spatial automatic or explicit candidate pairs.
import type { Field } from '../ref/sdf/shapes.ts';
import { collisionParams, type CollisionParams } from '../ref/sdf/manifold.ts';
import { packSdfPairs, packSdfParams, checkSdfPointCapacity, sdfResultWords, SDF_MAX_POINTS, type SdfPair } from './sdf-layout.ts';
import { SdfSpatialBroadphase, sdfBroadphaseOptions, type SdfBroadphaseOptions } from './sdf-broadphase.ts';
import { SdfNarrowphasePass } from './sdf-pass.ts';
import type { GpuSolver3D, GpuCollisionBackend3D, GpuCollisionContext3D } from './solver.ts';
import { sdfPrepareWGSL, sdfExportSource, sdfFilterWGSL, sdfEventsSource } from './wgsl-sdf-bridge.ts';
import { BindGroupCache } from './bind-group-cache.ts';

import { Raycaster, type Ray } from '../../lib/raycast.ts';
import { sdfRaycastWGSL, sdfRayLipschitz } from './sdf-raycast.ts';


export interface SdfBridgeBody { field: Field; scale?: number; rotation?: [number,number,number,number] }
/** GPU slot indices, with a > b. Key changes invalidate both sampling and force caches. */
export type SdfBridgePair = Omit<SdfPair, 'previous'>;

/** Replaces ALL collision detection while installed. Automatic mode spatially indexes a
 * fixed topology; explicit mode accepts candidates. Both apply GPU bounds/mask/joint filters.
 * Fields are snapshotted at construction. Solver mass/inertia and poses remain authoritative.
 * Install with solver.setCollisionBackend(bridge); detach through the same setter.
 */
export class SdfCollisionBridge implements GpuCollisionBackend3D {
  private pairs: SdfBridgePair[] = [];
  private prior: SdfBridgePair[] = [];
  private disposed = false;
  private readonly config: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly prepareGroup: GPUBindGroup;
  private readonly buffers: GPUBuffer[] = [];
  private readonly eventManifolds: GPUBuffer;
  private readonly eventContacts: GPUBuffer;
  private readonly eventCounters: GPUBuffer;
  private raycaster: Raycaster | null = null;
  private readonly eventPipeline: GPUComputePipeline;
  private readonly spatial:SdfSpatialBroadphase|null;
  private readonly bindings:readonly SdfBridgeBody[];
  readonly params: CollisionParams;
  private readonly solver: GpuSolver3D;
  private readonly sdf: SdfNarrowphasePass;
  private readonly preparePipeline: GPUComputePipeline;
  private readonly exportPipeline: GPUComputePipeline;
  private readonly filterPipeline: GPUComputePipeline;
  /** The per-step groups (filter, export, events), by the buffers they bind: those ping-pong. */
  private readonly groups: BindGroupCache;
  /** Generate spatial candidates and remap pair history entirely on the GPU. */
  static async createAutomatic(solver: GpuSolver3D, bodies: readonly SdfBridgeBody[], params: Partial<CollisionParams> = {}, options: SdfBroadphaseOptions = {}): Promise<SdfCollisionBridge> {
    if(solver.isDestroyed) throw new Error('SDF solver was destroyed');
    if(!bodies.length || bodies.length!==solver.bodyCount) throw new Error('SDF bridge requires a field for every GPU body slot');
    const size=sdfBroadphaseOptions(solver.device,bodies,options);
    solver.reserveCollisionCapacity(size.maxPairs*size.maxPoints);
    return this.create(solver,bodies,[],params,size);
  }
  /** `maxPoints` (points per pair result, default 5) applies to explicit pairs; spatial sizes carry their own. */
  static async create(solver: GpuSolver3D, bodies: readonly SdfBridgeBody[], pairs: readonly SdfBridgePair[], params: Partial<CollisionParams> = {}, spatialSize?: ReturnType<typeof sdfBroadphaseOptions>, maxPoints: number = SDF_MAX_POINTS): Promise<SdfCollisionBridge> {
    if(solver.isDestroyed) throw new Error('SDF solver was destroyed');
    if(bodies.length!==solver.bodyCount || !bodies.length) throw new Error('SDF bridge requires a field for every GPU body slot');
    if(Math.ceil(bodies.length/64)>solver.device.limits.maxComputeWorkgroupsPerDimension) throw new Error('SDF body preparation exceeds workgroup limit');
    if(solver.device.limits.maxStorageBuffersPerShaderStage<8) throw new Error('SDF bridge requires eight storage bindings');
    for(const body of bodies) if(!(Math.fround(body.scale??1)>0) || !Number.isFinite(Math.fround(body.scale??1))) throw new Error('Invalid SDF bridge scale');
    for (const body of bodies) if (body.rotation && (body.rotation.length !== 4 || !body.rotation.every(Number.isFinite) || Math.abs(Math.hypot(...body.rotation)-1)>1e-5)) throw new Error('SDF field rotation must be a unit quaternion');
    const collision={...collisionParams(),...params};
    if(!Number.isFinite(Math.fround(collision.allowedPenetration)) || collision.allowedPenetration<0) throw new Error('Invalid SDF allowed penetration');
    const points=checkSdfPointCapacity(spatialSize?.maxPoints??maxPoints);
    packSdfParams(pairs.length,0,solver.params.dt,collision,points);
    const maxPairs=spatialSize?.maxPairs??Math.max(1,pairs.length);
    if(maxPairs*points>Math.min(solver.contactCapacity,solver.manifoldCapacity)) throw new Error(`SDF bridge requires capacity for ${points} contacts/manifolds per candidate pair`);
    const sdf=await SdfNarrowphasePass.create(solver.device,bodies.map(b=>b.field),{maxBodies:bodies.length,maxPairs,meshVertexContacts:collision.meshVertexContacts,maxPoints:points});
    let spatial:SdfSpatialBroadphase|null=null;
    try {
      const compile=async(code:string,entryPoint:string)=>{
        const module=solver.device.createShaderModule({code});
        const info=await module.getCompilationInfo(); const errors=info.messages.filter(m=>m.type==='error');
        if(errors.length) throw new Error(errors.map(m=>m.message).join('\n'));
        return solver.device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
      };
      const prepare=await compile(sdfPrepareWGSL,'prepare');
      const output=await compile(sdfExportSource(points),'exportContacts');
      const filter=await compile(sdfFilterWGSL,'filterPairs');
      const events=await compile(sdfEventsSource(points),'reportPairs');
      if(spatialSize)spatial=await SdfSpatialBroadphase.create(solver.device,bodies.length,spatialSize);
      if(solver.isDestroyed) throw new Error('SDF solver was destroyed during setup');
      return new SdfCollisionBridge(solver,bodies,pairs,collision,sdf,prepare,output,filter,events,spatial);
    } catch(error) {spatial?.destroy();sdf.destroy();throw error;}
  }
  private constructor(solver: GpuSolver3D, bodies: readonly SdfBridgeBody[], pairs: readonly SdfBridgePair[], params: CollisionParams,
    sdf: SdfNarrowphasePass, preparePipeline: GPUComputePipeline, exportPipeline: GPUComputePipeline, filterPipeline: GPUComputePipeline, eventPipeline: GPUComputePipeline, spatial:SdfSpatialBroadphase|null) {
    this.bindings=bodies.map(b=>({...b,rotation:b.rotation?[...b.rotation] as [number,number,number,number]:undefined}));this.spatial=spatial;this.solver=solver;this.sdf=sdf;this.preparePipeline=preparePipeline;this.exportPipeline=exportPipeline;this.filterPipeline=filterPipeline;
    this.params=params;this.eventPipeline=eventPipeline;
    const d=solver.device;
    this.groups=new BindGroupCache(d);
    try {
      this.config=d.createBuffer({size:bodies.length*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}); this.buffers.push(this.config);
      this.uniform=d.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}); this.buffers.push(this.uniform);
      const storage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST;
      this.eventManifolds=d.createBuffer({size:sdf.options.maxPairs*32,usage:storage});this.buffers.push(this.eventManifolds);
      this.eventContacts=d.createBuffer({size:sdf.options.maxPairs*64,usage:storage});this.buffers.push(this.eventContacts);
      this.eventCounters=d.createBuffer({size:64,usage:storage});this.buffers.push(this.eventCounters);
      const data=new Uint32Array(bodies.length*8), floats=new Float32Array(data.buffer);
      const slopes=new Map<number,number>();
      bodies.forEach((body,i)=>{
        const h=sdf.atlas.offsets.get(body.field)!;
        if(!slopes.has(h))slopes.set(h,sdfRayLipschitz(sdf.atlas,h));
        data[i*8]=h;floats[i*8+1]=body.scale??1;floats[i*8+2]=slopes.get(h)!; floats.set(body.rotation??[0,0,0,1],i*8+4);
      });
      d.queue.writeBuffer(this.config,0,data);
      this.prepareGroup=this.group(preparePipeline,[solver.bodyBuffer,this.config,sdf.storage.atlas,sdf.storage.bodies]);
      if(!spatial)this.setPairs(pairs);
    } catch(error) {for(const b of this.buffers)b.destroy();throw error;}
  }
  private group(pipeline:GPUComputePipeline,buffers:GPUBuffer[]): GPUBindGroup {
    return this.groups.get(pipeline,()=>pipeline.getBindGroupLayout(0),buffers);
  }
  /** Reorder/remove candidates without losing identities. New fields/slot occupants need new keys.
   * Capacity is fixed at construction; recreate the bridge to grow it or replace fields. */
  setPairs(pairs: readonly SdfBridgePair[]): void {
    if(this.disposed) throw new Error('SDF bridge is disposed');
    if(this.spatial)throw new Error('Automatic SDF candidates are GPU generated');
    if(pairs.length>this.sdf.options.maxPairs) throw new Error('SDF candidate capacity exceeded');
    const next=pairs.map(({a,b,key})=>({a,b,key}));
    packSdfPairs(next,this.sdf.options.maxBodies,0);
    const seen=new Set<string>();
    for(const pair of next) {
      const id=`${pair.a}:${pair.b}`;
      if(pair.a<=pair.b || seen.has(id)) throw new Error('SDF candidates require unique body pairs with a > b');
      seen.add(id);
    }
    this.pairs=next;
  }
  prepare(solver: GpuSolver3D): void {
    if(this.disposed || solver!==this.solver) throw new Error('Invalid SDF bridge owner/lifecycle');
    if(solver.bodyCount!==this.sdf.options.maxBodies) throw new Error('Recreate SDF bridge after changing body slots');
    if((this.spatial?this.sdf.options.maxPairs:this.pairs.length)*this.sdf.maxPoints>Math.min(solver.contactCapacity,solver.manifoldCapacity)) throw new Error('Insufficient SDF solver contact capacity');
    if(!Number.isFinite(Math.fround(this.params.allowedPenetration)) || this.params.allowedPenetration<0) throw new Error('Invalid SDF allowed penetration');
    packSdfParams(this.pairs.length,0,solver.params.dt,this.params,this.sdf.maxPoints);
  }
  encode(pass: GPUComputePassEncoder, context: GpuCollisionContext3D): void {
    pass.setPipeline(this.preparePipeline); pass.setBindGroup(0,this.prepareGroup);
    pass.dispatchWorkgroups(Math.ceil(this.sdf.options.maxBodies/64));
    const data=new Uint32Array(8), floats=new Float32Array(data.buffer);
    const count=this.spatial?this.sdf.options.maxPairs:this.pairs.length;
    data[0]=count; floats[4]=this.params.margin; floats[5]=this.params.allowedPenetration; floats[6]=this.params.refreshDeeperContacts?this.params.tolerance:0;
    this.solver.device.queue.writeBuffer(this.uniform,0,data);
    if(this.spatial) {
      this.sdf.encodeGeneratedPairs(pass,this.solver.params.dt,this.params,()=>this.spatial!.encode(pass,context,this.sdf,this.params.margin));
    } else {
      const slots=new Map(this.prior.map((p,i)=>[p.key,i]));
      const pairs=this.pairs.map(p=>{
        const slot=slots.get(p.key), old=slot===undefined?undefined:this.prior[slot];
        const previous=old&&old.a===p.a&&old.b===p.b?slot!:-1;
        return {...p,...(previous>=0?{previous}:{})};
      });
      const before=this.sdf.storage;
      const filter=this.group(this.filterPipeline,[context.params,this.uniform,before.bodies,before.pairs,context.statics,context.joints,context.filters]);
      this.sdf.encodeFromGpu(pass,this.sdf.options.maxBodies,pairs,this.solver.params.dt,this.params,()=>{
        if(pairs.length) {pass.setPipeline(this.filterPipeline);pass.setBindGroup(0,filter);pass.dispatchWorkgroups(Math.ceil(pairs.length/64));}
      });
    }
    const s=this.sdf.storage;
    const group=this.group(this.exportPipeline,[context.params,this.uniform,context.bodies,s.current,s.previous,s.pairs,
      context.previousContacts,context.contacts,context.manifolds,context.counters]);
    if(count) {pass.setPipeline(this.exportPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));}
    this.prior=this.pairs.map(p=>({...p}));
  }
  /** Aggregate only for reporting, after solving; no CPU pose or force readback. */
  contactEventStorage() {
    this.prepare(this.solver);
    const d=this.solver.device, encoder=d.createCommandEncoder(), pass=encoder.beginComputePass();
    const group=this.group(this.eventPipeline,[this.uniform,this.sdf.storage.current,this.solver.contactStorage.contacts,
      this.eventManifolds,this.eventContacts,this.eventCounters]);
    pass.setPipeline(this.eventPipeline);pass.setBindGroup(0,group);
    pass.dispatchWorkgroups(Math.max(1,Math.ceil((this.spatial?this.sdf.options.maxPairs:this.prior.length)/64)));pass.end();d.queue.submit([encoder.finish()]);
    return {manifolds:this.eventManifolds,contacts:this.eventContacts,counters:this.eventCounters};
  }
  /** Current GPU poses, including writes since the last step. Small batches bound query work. */
  raycasts(rays: Ray[], ignore: number[], mask: number) {
    this.prepare(this.solver);
    if(rays.length>256)throw new Error('SDF raycasts support at most 256 rays per call');
    for(const r of rays) {
      const values=[r.origin[0],r.origin[1],r.origin[2],r.direction[0],r.direction[1],r.direction[2],r.maxDistance??3e38];
      if(!values.every(v=>Number.isFinite(Math.fround(v))) || Math.hypot(...values.slice(3,6))===0 || values[6]<0)
        throw new Error('SDF ray requires finite origin, nonzero direction and nonnegative distance');
    }
    this.raycaster??=new Raycaster(this.solver.device,sdfRaycastWGSL);
    const encoder=this.solver.device.createCommandEncoder(), pass=encoder.beginComputePass();
    pass.setPipeline(this.preparePipeline);pass.setBindGroup(0,this.prepareGroup);
    pass.dispatchWorkgroups(Math.ceil(this.sdf.options.maxBodies/64));pass.end();this.solver.device.queue.submit([encoder.finish()]);
    return this.raycaster.cast(this.sdf.storage.bodies,this.sdf.storage.atlas,this.solver.filterStorage,this.sdf.options.maxBodies,rays,ignore,mask);
  }
  get capacity():number {return this.sdf.options.maxPairs;}
  /** Caller installs this replacement synchronously, before another solver step. */
  grown(required:number):SdfCollisionBridge {
    if(this.disposed||!this.spatial)throw new Error('SDF growth requires an active spatial bridge');
    if(!Number.isSafeInteger(required)||required<=this.capacity)throw new Error('Invalid SDF requested capacity');
    const limit=Math.min(this.solver.device.limits.maxBufferSize,this.solver.device.limits.maxStorageBufferBindingSize);
    let capacity=Math.max(required,Math.min(this.capacity*2,Math.floor(limit/(sdfResultWords(this.sdf.maxPoints)*4))));
    let spatial:SdfSpatialBroadphase;
    try {spatial=this.spatial.resized(capacity);}
    catch(error) {
      if(capacity===required)throw error;
      capacity=required;spatial=this.spatial.resized(capacity);
    }
    let sdf:SdfNarrowphasePass|undefined,bridge:SdfCollisionBridge|undefined;
    try {
      sdf=this.sdf.resized(capacity);
      this.solver.reserveCollisionCapacity(capacity*this.sdf.maxPoints);
      bridge=new SdfCollisionBridge(this.solver,this.bindings,[],{...this.params},sdf,
        this.preparePipeline,this.exportPipeline,this.filterPipeline,this.eventPipeline,spatial);
      bridge.inheritHistory(this,Array(this.bindings.length).fill(true));
      return bridge;
    } catch(error) {if(bridge)bridge.destroy();else {sdf?.destroy();spatial.destroy();}throw error;}
  }
  /** Preserve solved-contact indices only for unchanged body identities and fields. */
  inheritHistory(previous:SdfCollisionBridge,retained:readonly boolean[]):void {
    if(this.disposed||previous.disposed||this.solver!==previous.solver||!this.spatial||!previous.spatial)
      throw new Error('Invalid SDF bridge history transfer');
    this.sdf.inheritHistory(previous.sdf,retained);
  }
  /** Explicit diagnostic readback only; stepping never reads bodies/contacts to CPU. */
  async readResults() {const results=await this.sdf.readResults();return this.spatial?results.filter(r=>r.a!==0xffffffff):results;}
  readBroadphaseStats() {if(!this.spatial)throw new Error('Explicit candidates have no spatial grid');return this.spatial.readStats();}
  destroy(): void {
    if(this.disposed)return;
    this.disposed=true;this.groups.clear();this.spatial?.destroy();this.sdf.destroy();for(const buffer of this.buffers)buffer.destroy();
  }
}
