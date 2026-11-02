// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 75ba1acda1fd8eade9914044099a8e7dcc71f68e5fddce4146c0ca0718f57528. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// Device-local offline orchestration: probe, untouched reference search, then merge.
import {sdfSentinelProbeSource} from './sdf-sentinel-policy.ts';

export const SENTINEL_SCRATCH_BUDGET=160*1024*1024;

export function createSentinelDevice(raw: GPUDevice, interval=4) {
  if(!Number.isInteger(interval)||interval<1||interval>4)throw new Error('Sentinel interval must be 1..4');
  const allocated:GPUBuffer[]=[];let disposed=false,bytes=0;
  const destroy=()=>{if(disposed)return;disposed=true;for(const b of allocated)b.destroy();};
  const fallback=interval===1?'disabled':raw.limits.maxStorageBuffersPerShaderStage<7?'storage binding limit':null;
  if(fallback)return {device:raw,destroy,get allocatedBytes(){return bytes;},fallback};
  const modules=new WeakMap<GPUShaderModule,string>(),entries=new WeakMap<GPUBindGroup,GPUBindGroupEntry[]>();
  type Pipelines={probe:GPUComputePipeline;merge:GPUComputePipeline};
  const pipelines=new WeakMap<GPUComputePipeline,Pipelines>();
  const scratch=new WeakMap<GPUBuffer,{pairs:GPUBuffer;results:GPUBuffer}>();
  const groups=new WeakMap<GPUBindGroup,Map<GPUComputePipeline,{probe:GPUBindGroup;full:GPUBindGroup;merge:GPUBindGroup}>>();
  const make=(size:number,label:string)=>{if(size>Math.min(raw.limits.maxStorageBufferBindingSize,raw.limits.maxBufferSize))throw Error('Sentinel scratch exceeds device limit');const b=raw.createBuffer({label,size,usage:GPUBufferUsage.STORAGE});allocated.push(b);bytes+=size;return b;};
  const compile=async(code:string,label:string)=>{
    const module=raw.createShaderModule({label,code});const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
    if(errors.length)throw Error(errors.map(m=>m.message).join('\n'));
    return raw.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'narrowphase'}});
  };
  const bind=(pipeline:GPUComputePipeline,group:GPUBindGroup)=>{
    const cached=groups.get(group)?.get(pipeline);if(cached)return cached;
    const list=entries.get(group);if(!list)throw Error('Unobserved sentinel bind group');
    const buffer=(binding:number)=>{const r=list.find(e=>e.binding===binding)?.resource;if(!r||!('buffer'in r)||(r.offset??0)!==0||(r.size??r.buffer.size)!==r.buffer.size)throw Error('Sentinel requires full buffer bindings');return r.buffer;};
    const pairs=buffer(3),target=buffer(5);let temp=scratch.get(pairs);
    if(!temp){
      // Offline fixed-capacity runs only; reject cumulative growth before allocating either buffer.
      if(bytes+pairs.size+target.size>SENTINEL_SCRATCH_BUDGET)throw Error('Sentinel aggregate scratch budget exceeded');
      temp={pairs:make(pairs.size,'sentinel fallback pairs'),results:make(target.size,'sentinel temporary results')};scratch.set(pairs,temp);}
    if(temp.results.size!==target.size)throw Error('Sentinel scratch capacity changed');
    const p=pipelines.get(pipeline)!;
    const probe=raw.createBindGroup({layout:p.probe.getBindGroupLayout(0),entries:[...list.map(e=>e.binding===5?{binding:5,resource:{buffer:temp!.results}}:e),{binding:7,resource:{buffer:temp.pairs}}]});
    const full=raw.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:list.map(e=>e.binding===3?{binding:3,resource:{buffer:temp!.pairs}}:e)});
    const merge=raw.createBindGroup({layout:p.merge.getBindGroupLayout(0),entries:[buffer(0),pairs,temp.pairs,temp.results,target].map((b,binding)=>({binding,resource:{buffer:b}}))});
    const value={probe,full,merge};let byPipeline=groups.get(group);if(!byPipeline){byPipeline=new Map();groups.set(group,byPipeline);}byPipeline.set(pipeline,value);return value;
  };
  const device=new Proxy(raw,{get(target,key){
    if(key==='createShaderModule')return (d:GPUShaderModuleDescriptor)=>{if(disposed)throw Error('Sentinel disposed');const m=raw.createShaderModule(d);if(d.label==='experimental sdf narrowphase')modules.set(m,d.code);return m;};
    if(key==='createComputePipelineAsync')return async(d:GPUComputePipelineDescriptor)=>{
      if(disposed)throw Error('Sentinel disposed');const original=await raw.createComputePipelineAsync(d),source=modules.get(d.compute.module);
      if(source&&d.compute.entryPoint==='narrowphase'){
        const types=source.slice(0,source.indexOf('@group(0)'));
        const probe=await compile(sdfSentinelProbeSource(source,interval),'sdf sentinel probe');
        const merge=await compile(types+`
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage,read> pairs: array<vec4u>;
@group(0) @binding(2) var<storage,read> fallbackPairs: array<vec4u>;
@group(0) @binding(3) var<storage,read> probes: array<Result>;
@group(0) @binding(4) var<storage,read_write> results: array<Result>;
@compute @workgroup_size(64) fn narrowphase(@builtin(global_invocation_id) id: vec3u) {
  let slot=id.x;if(slot>=params.counts.x || pairs[slot].x==0xffffffffu){return;}
  if(fallbackPairs[slot].x==0xffffffffu){results[slot]=probes[slot];}
  else {results[slot].stats.x+=probes[slot].stats.x;results[slot].stats.y+=probes[slot].stats.y;}
}`,'sdf sentinel merge');pipelines.set(original,{probe,merge});
      }
      return original;
    };
    if(key==='createBindGroup')return (d:GPUBindGroupDescriptor)=>{const g=raw.createBindGroup(d);entries.set(g,Array.from(d.entries));return g;};
    if(key==='createCommandEncoder')return (d?:GPUCommandEncoderDescriptor)=>{
      if(disposed)throw Error('Sentinel disposed');const encoder=raw.createCommandEncoder(d);
      return new Proxy(encoder,{get(e,k){
        if(k==='beginComputePass')return (desc?:GPUComputePassDescriptor)=>{
          const pass=e.beginComputePass(desc);let pipeline:GPUComputePipeline|undefined,group:GPUBindGroup|undefined,hasOffsets=false;
          return new Proxy(pass,{get(p,method){
            if(method==='setPipeline')return (value:GPUComputePipeline)=>{pipeline=value;p.setPipeline(value);};
            if(method==='setBindGroup')return (index:number,value:GPUBindGroup|null,offsets?:Iterable<number>|Uint32Array,start?:number,length?:number)=>{
              if(index===0){group=value??undefined;hasOffsets=offsets!==undefined&&Array.from(offsets).some(Boolean);}
              if(offsets instanceof Uint32Array&&start!==undefined)p.setBindGroup(index,value,offsets,start,length!);else p.setBindGroup(index,value,offsets);
            };
            if(method==='dispatchWorkgroups')return (x:number,y=1,z=1)=>{
              const extra=pipeline&&pipelines.get(pipeline);if(!extra){p.dispatchWorkgroups(x,y,z);return;}
              if(disposed||!group||hasOffsets||y!==1||z!==1)throw Error('Unsupported sentinel dispatch');
              const b=bind(pipeline!,group);
              p.setPipeline(extra.probe);p.setBindGroup(0,b.probe);p.dispatchWorkgroups(x);
              p.setPipeline(pipeline!);p.setBindGroup(0,b.full);p.dispatchWorkgroups(x);
              p.setPipeline(extra.merge);p.setBindGroup(0,b.merge);p.dispatchWorkgroups(x);
              p.setPipeline(pipeline!);p.setBindGroup(0,group);
            };
            if(method==='dispatchWorkgroupsIndirect')return (buffer:GPUBuffer,offset:number)=>{if(pipeline&&pipelines.has(pipeline))throw Error('Indirect sentinel dispatch unsupported');p.dispatchWorkgroupsIndirect(buffer,offset);};
            const value=Reflect.get(p,method,p);return typeof value==='function'?value.bind(p):value;
          }});
        };
        const value=Reflect.get(e,k,e);return typeof value==='function'?value.bind(e):value;
      }});
    };
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  },set(target,key,value){return Reflect.set(target,key,value,target);}});
  return {device,destroy,get allocatedBytes(){return bytes;},fallback};
}
