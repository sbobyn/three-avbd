// Table 2 full-size analogue: published sample budgets, reconstructed lattice, M4 Max.
// Timestamp collision includes prepare/broadphase/search/export, not just Algorithm 1.
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { create, globals } from 'webgpu';
import { collisionDispatchProfiler } from './sdf-dispatch-profile.ts';
import { World } from '../src/lib/world.ts';
import type { StepProfile } from '../src/avbd3d/gpu/solver.ts';
import { loadReleasedScene, type ReadAsset } from '../src/sdf-released/scenes.ts';
const output=process.argv[2],count=Number(process.argv[3]??4314),frames=Number(process.argv[4]??360),selected=process.argv[5];
const budgets=[4,6,8,16].flatMap(cacheSize=>[1,2,4].map(randomSamples=>({cacheSize,randomSamples})));
if(!output||!Number.isInteger(count)||count<1||count>4314||!Number.isInteger(frames)||frames<30||frames>360||selected&&!budgets.some(b=>`${b.cacheSize}:${b.randomSamples}`===selected))throw new Error('Usage: sdf-table2.ts OUT [bodies 1..4314] [frames 30..360] [optional cache:random]');
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw new Error('No GPU');
const timestamps=adapter.features.has('timestamp-query');
const device=await adapter.requestDevice({requiredFeatures:timestamps?['timestamp-query']:[],requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
(globalThis as any).__table2=[gpu,adapter,device];const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
const scene=await loadReleasedScene(9,read),source=scene.capture.solver,ground=scene.bodies[0],mesh=scene.bodies.find(b=>b.original.shape.kind==='voxel')!;
let state=0x2545f491;const random=()=>{state=Math.imul(state^state>>>15,0x2c1b3c6d)+0x6d2b79f5>>>0;return state/2**32;};
const poses=Array.from({length:count},(_,i)=>{const u=[random(),random(),random()],a=Math.sqrt(1-u[0]),b=Math.sqrt(u[0]),cell=i%1089;
  return {position:[(cell%33-16)*1.2,1+Math.floor(i/1089),(Math.floor(cell/33)-16)*1.2] as [number,number,number],rotation:new THREE.Quaternion(a*Math.sin(2*Math.PI*u[1]),a*Math.cos(2*Math.PI*u[1]),b*Math.sin(2*Math.PI*u[2]),b*Math.cos(2*Math.PI*u[2])).multiply(new THREE.Quaternion(...mesh.fieldRotation).invert()).toArray() as [number,number,number,number]};});
if(process.env.SDF_DISPATCH_PROFILE==='1'&&!timestamps)throw new Error('Dispatch profiling requires timestamp-query');
const dispatchProfile=process.env.SDF_DISPATCH_PROFILE==='1'?collisionDispatchProfiler(device):null;
const warmup=Math.floor(frames/3),paper=[1.8,2.4,4.2,2.7,3,4.4,3.9,4.2,5,7.7,8.1,8.9];
const report={paper:'Giles & Andrews Table 2',three:THREE.REVISION,dynamicBunnies:count,totalBodies:count+1,frames,warmupFrames:warmup,frameDt:.016,substeps:source.substeps,solverIterations:source.iterations,timestamps,
  adapter:adapter.info,dispatchProfile:!!dispatchProfile,pauseMs:50,protocol:(dispatchProfile?'Diagnostic per-dispatch pass splitting; collision sums dispatch timestamps, GPU total unavailable. Not comparable to unsplit totals. ':'')+'Reconstructed deterministic lattice (paper layout unavailable); reference collision params except NM, tolerance .01 and maxIterations 50; 16ms frames; released AVBD substeps/iterations. GPU collision timestamps sum all substeps on every tenth measured frame; include prepare, spatial broadphase, search and export. Wall timings include per-substep counter readback and timed-frame timestamp waits. Idle excluded. Single run per budget, not hardware-equivalent paper t_coll.',rows:[] as unknown[]};
const summary=(values:number[])=>{if(!values.length)return null;const s=[...values].sort((a,b)=>a-b);return {mean:values.reduce((a,b)=>a+b,0)/values.length,upperMedian:s[Math.floor(s.length/2)],p95:s[Math.min(s.length-1,Math.floor(s.length*.95))]};};
try{
 for(const budget of budgets.filter(b=>!selected||`${b.cacheSize}:${b.randomSamples}`===selected)){
  const world=await World.create({device,maxBodies:count+1,dt:.016/source.substeps,iterations:source.iterations,gravity:source.gravity});world.readbackEvery=0;
  try{
   const floor=world.addBox({size:[1,1,1],position:ground.original.position,rotation:ground.rotation,fixed:true,friction:ground.original.friction})!;
   const bodies=poses.map(p=>world.addBox({size:[1,1,1],...p,friction:mesh.original.friction,massProperties:{mass:mesh.original.mass,moments:mesh.moments}})!);
   const collision={...scene.capture.params,...budget,optimizer:0 as const,tolerance:.01,maxIterations:50};
   await world.enableSdfCollisions([{body:floor,field:ground.field,scale:ground.original.scale,rotation:ground.fieldRotation},...bodies.map(body=>({body,field:mesh.field,scale:mesh.original.scale,rotation:mesh.fieldRotation}))],collision,{maxPairs:64000,maxPointsPerPair:Math.max(5,budget.cacheSize+budget.randomSamples),autoGrow:false});
   const wall:number[]=[],gpuFrames:{frame:number;collision:number;total:number|null}[]=[],samples:unknown[]=[];
   for(let frame=1;frame<=frames;frame++){
    const start=performance.now();let collisionMs=0,totalMs=0,last;
    const timed=timestamps&&frame>warmup&&frame%10===0;
    for(let substep=0;substep<source.substeps;substep++){
     let resolve:((p:StepProfile)=>void)|undefined;
     const pending=timed?new Promise<StepProfile>(r=>{resolve=r;}):null;
     if(resolve&&!dispatchProfile)world.solver.profileNextStep(resolve);
     if(timed&&dispatchProfile)dispatchProfile.arm();
     world.step();last=await world.solver.readCounters();if(last.overflow)throw new Error(`Overflow ${last.overflow}, ${JSON.stringify(budget)} frame ${frame}/${substep}`);
     if(timed&&dispatchProfile){const phases=await dispatchProfile.collect();samples.push({frame,substep,phases});collisionMs+=Object.values(phases).reduce((a,b)=>a+b,0);totalMs=0;}
     if(pending&&!dispatchProfile){let timer:ReturnType<typeof setTimeout>|undefined;try{const p=await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timestamp readback timed out')),10000);})]);collisionMs+=p.collision;totalMs+=p.total;}finally{clearTimeout(timer);}}
    }
    await device.queue.onSubmittedWorkDone();if(frame>warmup)wall.push(performance.now()-start);
    if(timed)gpuFrames.push({frame,collision:collisionMs,total:dispatchProfile?null:totalMs});
    if(frame%60===0||frame===frames){await world.read();if(bodies.some(b=>![...b.position,...b.rotation,...b.velocity,...b.angularVelocity].every(Number.isFinite)))throw new Error('Non-finite pile');samples.push({frame,pairs:last!.pairs,contacts:last!.contacts});console.log(JSON.stringify({...budget,frame,pairs:last!.pairs,contacts:last!.contacts}));}
    if(errors.length)throw new Error(errors.join('\n'));await new Promise(r=>setTimeout(r,50));
   }
   report.rows.push({...budget,collisionParams:collision,paperCollisionMs:paper[budgets.findIndex(b=>b.cacheSize===budget.cacheSize&&b.randomSamples===budget.randomSamples)],wallMs:summary(wall),gpuCollisionMs:summary(gpuFrames.map(p=>p.collision)),gpuTotalMs:dispatchProfile?null:summary(gpuFrames.map(p=>p.total!)),gpuFrames,samples,overflow:0});
   await writeFile(output,JSON.stringify(report,null,1)+'\n');
  }finally{world.destroy();}
  await new Promise(r=>setTimeout(r,500));
 }
}finally{dispatchProfile?.destroy();scene.dispose();device.destroy();}
