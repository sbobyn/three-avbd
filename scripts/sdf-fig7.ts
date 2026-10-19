// Figure 7 analogue: five jittered released piles, uniform/curvature Algorithm 1 vs dense surface-to-SDF.
// Released Bunny Pile is NOT the unpublished Bunny Iron Maiden layout. Dense samples are fixed surface
// points, not 1000 optimized seeds: contact multiplicity and sampling differ from the paper baseline.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { create, globals } from 'webgpu';
import { World } from '../src/lib/world.ts';
import { loadReleasedScene, instantiateReleased, type ReadAsset } from '../src/sdf-released/scenes.ts';
import { jitterReleased } from './sdf-jitter.ts';
import { DensePileOracle } from './sdf-dense-pile.ts';
const output=process.argv[2],frames=Number(process.argv[3]??500),rollouts=Number(process.argv[4]??5);
const ids=(process.argv[5]??'6,9').split(',').map(Number),modes=(process.argv[6]??'uniform,curvature,dense').split(',');
if(!output||!Number.isInteger(frames)||frames<1||frames>500||!Number.isInteger(rollouts)||rollouts<1||rollouts>5||ids.some(i=>![6,9].includes(i))||modes.some(m=>!['uniform','curvature','dense'].includes(m)))throw new Error('Usage: sdf-fig7.ts OUT [frames1..500] [rollouts1..5] [6,9] [uniform,curvature,dense]');
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw new Error('No GPU');
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
(globalThis as any).__fig7=[gpu,adapter,device];const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
const report={paper:'Figure 7 protocol analogue',three:THREE.REVISION,frames,rollouts,adapter:adapter.info,
 protocol:'Released chair pile and Bunny Pile proxy (NOT Iron Maiden). Five deterministic per-body ±10um position jitter seeds; same seed matched across modes. Released masses/inertia/friction, 4 substeps and 20 AVBD iterations. Uniform/curvature use released 4+1 collision params; dense uses1000 area-stratified fixed surface points/dynamic body against all other SDFs, one contact per active directed sample, no optimizer or manifold reduction. Not the paper 1000-optimized-seed baseline. Post-step kinetic energy; 10ms idle/frame.',runs:[] as any[],aggregates:[] as any[]};
try{
 for(const id of ids)for(let seed=1;seed<=rollouts;seed++)for(const mode of modes){
  const original=await loadReleasedScene(id,read),scene=jitterReleased({...original,capture:{...original.capture,params:{...original.capture.params,curvatureSampling:mode==='curvature'}}},seed);
  let world:World|undefined;
  try{
   let bodies;let sampleHash:string|null=null;
   if(mode==='dense'){
    const source=scene.capture.solver;world=await World.create({device,maxBodies:scene.bodies.length,dt:source.dt/source.substeps,iterations:source.iterations,gravity:source.gravity});world.readbackEvery=0;
    bodies=scene.bodies.map(b=>world!.addBox({size:[1,1,1],position:b.original.position,rotation:b.rotation,velocity:b.original.velocity,angularVelocity:b.original.angularVelocity,fixed:b.original.static,friction:b.original.friction,...(!b.original.static?{massProperties:{mass:b.original.mass,moments:b.moments}}:{})})!);
    await world.read();const oracle=await DensePileOracle.create(world.solver,scene,scene.capture.params.margin,scene.capture.params.allowedPenetration);world.solver.setCollisionBackend(oracle);
    sampleHash=createHash('sha256').update(new Uint8Array(new Float32Array(oracle.pointSets.flat().flatMap(p=>[...p.toArray(),0])).buffer)).digest('hex');
   }else{({world,bodies}=await instantiateReleased(scene,{device},'reference'));}
   const energy:number[]=[],contacts:number[]=[];let minimumY=Infinity;const escaped=new Set<number>();
   for(let frame=1;frame<=frames;frame++){
    let count=0;
    for(let substep=0;substep<scene.capture.solver.substeps;substep++){world.step();const c=await world.solver.readCounters();if(c.overflow)throw new Error(`Overflow ${c.overflow} scene${id} ${mode} seed${seed} frame${frame}`);count=c.contacts;}
    await world.read();let e=0;
    bodies.forEach((b,i)=>{const src=scene.bodies[i];if(src.original.static)return;
      if(![...b.position,...b.rotation,...b.velocity,...b.angularVelocity].every(Number.isFinite))throw new Error('Non-finite pile state');
      const w=new THREE.Vector3(...b.angularVelocity).applyQuaternion(new THREE.Quaternion(...b.rotation).invert()),m=src.moments;
      e+=.5*(src.original.mass*b.velocity.reduce((s,v)=>s+v*v,0)+m[0]*w.x*w.x+m[1]*w.y*w.y+m[2]*w.z*w.z);minimumY=Math.min(minimumY,b.position[1]);if(b.position[1]<0)escaped.add(i);});
    energy.push(e);contacts.push(count);if(errors.length)throw new Error(errors.join('\n'));
    await new Promise(r=>setTimeout(r,10));if(frame%100===0)console.log(JSON.stringify({id,mode,seed,frame,energy:e,contacts:count}));
   }
   report.runs.push({id,scene:id===6?'Pile of Chairs':'Bunny Pile (Iron Maiden proxy only)',mode,seed,bodies:bodies.length,collisionParams:scene.capture.params,sampleUploadHash:sampleHash,energy,contacts,minimumCenterY:minimumY,escapedBodyIndices:[...escaped],noBelowGroundCenter:escaped.size===0,finalEnergy:energy.at(-1),tailMeanEnergy:energy.slice(-100).reduce((s,v)=>s+v,0)/Math.min(100,frames)});
   report.aggregates=ids.flatMap(sceneId=>modes.map(sampleMode=>{
    const runs=report.runs.filter(r=>r.id===sceneId&&r.mode===sampleMode);if(!runs.length)return null;
    return {id:sceneId,mode:sampleMode,completedRollouts:runs.length,noBelowGroundCenter:runs.every(r=>r.noBelowGroundCenter),
      meanEnergy:Array.from({length:frames},(_,f)=>runs.reduce((sum,r)=>sum+r.energy[f],0)/runs.length),
      meanTailEnergy:runs.reduce((sum,r)=>sum+r.tailMeanEnergy,0)/runs.length};
   })).filter(Boolean);
   await writeFile(output,JSON.stringify(report)+'\n');
  }finally{world?.destroy();original.dispose();}
  await new Promise(r=>setTimeout(r,100));
 }
}finally{device.destroy();}
