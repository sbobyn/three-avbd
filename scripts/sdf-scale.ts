// Paper-scale SDF pile (Giles & Andrews 2026, Table 1 "Bunnies", 4314 bodies): released voxel
// bunnies dropped from a lattice onto the released ground through the World spatial broadphase.
// Checks that the production path runs at that scale (capacity, overflow, stability, penetration).
// Frame times are wall clock on the machine that runs it, including submission; they are not
// target-hardware (M1 / GTX 1080) numbers and not the paper's t_coll. Bounded and sequential.
import { readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { create, globals } from 'webgpu';
import { World } from '../src/lib/world.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { loadReleasedScene, releasedSettings, type ReadAsset } from '../src/sdf-released/scenes.ts';
import type { Quat, Vec3 } from '../src/lib/world.ts';
const output=process.argv[2],count=Number(process.argv[3]??4314),frames=Number(process.argv[4]??300);
// Optional candidate-pair reservation; by default World sizes it (8 per body) and grows it after overflow.
const maxPairs=process.argv[5]===undefined?undefined:Number(process.argv[5]);
if(!output||!Number.isInteger(count)||count<1||count>5000||!Number.isInteger(frames)||frames<1||frames>600||(maxPairs!==undefined&&!(Number.isInteger(maxPairs)&&maxPairs>0)))
  throw new Error('Usage: sdf-scale.ts output.json [bodies 1..5000, default 4314] [frames 1..600, default 300] [maxPairs]');
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);
const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter');
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
(globalThis as typeof globalThis & {__scaleGpu?:unknown}).__scaleGpu=[gpu,adapter,device];
const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
const scene=await loadReleasedScene(9,read),settings=releasedSettings(scene,'mesh-quality'),source=scene.capture.solver;
const ground=scene.bodies[0],template=scene.bodies.find(b=>b.original.shape.kind==='voxel')!;
// Deterministic lattice: side x side columns, 1.2 m apart, layers 1 m apart, random orientations.
let state=0x2545f491;const random=()=>{state=Math.imul(state^state>>>15,0x2c1b3c6d)+0x6d2b79f5>>>0;return state/2**32;};
const side=33,spacing=1.2;
const poses=Array.from({length:count},(_,i)=>{
  const layer=Math.floor(i/(side*side)),cell=i%(side*side);
  const u=[random(),random(),random()],a=Math.sqrt(1-u[0]),b=Math.sqrt(u[0]);
  const q=new THREE.Quaternion(a*Math.sin(2*Math.PI*u[1]),a*Math.cos(2*Math.PI*u[1]),b*Math.sin(2*Math.PI*u[2]),b*Math.cos(2*Math.PI*u[2]));
  return {position:[(cell%side-(side-1)/2)*spacing,1+layer,(Math.floor(cell/side)-(side-1)/2)*spacing] as Vec3,rotation:q.multiply(new THREE.Quaternion(...template.fieldRotation).invert())};
});
const world=await World.create({device,maxBodies:count+1,dt:source.dt/settings.substeps,iterations:source.iterations,gravity:source.gravity});
world.maxSubsteps=settings.substeps;world.readbackEvery=0;
const local=(()=>{const p=template.geometry.getAttribute('position');return Array.from({length:p.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(p,i));})();
const report:Record<string,unknown>={paper:'Giles & Andrews 2026, Table 1 Bunnies (4314 bodies); layout not published, lattice drop used',
  reference:'sdf-dcd-demo 1dcdf1e7fa07d16fda15826ad8c2e6697075a76e',bodies:count,frames,profile:'mesh-quality',substeps:settings.substeps,iterations:source.iterations,
  timing:`wall clock per frame (counter readback each frame included) (${settings.substeps} substeps) after onSubmittedWorkDone, on the machine that ran this; not target hardware, not t_coll`,
  adapter:(adapter as unknown as {info?:{vendor?:string;architecture?:string;description?:string}}).info??null};
try{
  const floor=world.addBox({size:[1,1,1],position:ground.original.position,rotation:ground.rotation,fixed:true,friction:ground.original.friction})!;
  const bodies=poses.map(p=>world.addBox({size:[1,1,1],position:p.position,rotation:p.rotation.toArray() as Quat,friction:template.original.friction,
    massProperties:{mass:template.original.mass,moments:template.moments}})!);
  const setup=performance.now();
  await world.enableSdfCollisions([{body:floor,field:ground.field,scale:ground.original.scale,rotation:ground.fieldRotation},
    ...bodies.map(body=>({body,field:template.field,scale:template.original.scale,rotation:template.fieldRotation}))],settings.collision,maxPairs?{maxPairs}:{});
  report.setupMs=performance.now()-setup;report.maxPairs=maxPairs??'World default (8 per body, grown after overflow)';report.initialPairCapacity=world.sdfCollisionCapacity;
  // Frames whose step overflowed candidate-pair capacity: those pairs were dropped for that step.
  const overflowFrames:number[]=[];
  const groundTop=ground.original.position[1]+(ground.original.shape.halfExtents?.[1]??0);
  const times:number[]=[],samples:unknown[]=[];
  for(let frame=1;frame<=frames;frame++){
    const t=performance.now();
    for(let s=0;s<settings.substeps;s++)world.step();
    await device.queue.onSubmittedWorkDone();times.push(performance.now()-t);
    const counters=await world.solver.readCounters();if(counters.overflow)overflowFrames.push(frame);
    if(frame%30!==0&&frame!==frames)continue;
    await world.read();
    let energy=0,groundDepth=0;
    const rotations=bodies.map(b=>new THREE.Quaternion(...b.rotation));
    bodies.forEach((body,i)=>{
      if(![...body.position,...body.rotation,...body.velocity].every(Number.isFinite))throw new Error(`Non-finite body ${i} at frame ${frame}`);
      const w=new THREE.Vector3(...body.angularVelocity).applyQuaternion(rotations[i].clone().invert()),m=template.moments;
      energy+=.5*(template.original.mass*body.velocity.reduce((s,v)=>s+v*v,0)+m[0]*w.x*w.x+m[1]*w.y*w.y+m[2]*w.z*w.z);
      for(const v of local)groundDepth=Math.max(groundDepth,groundTop-(v.clone().applyQuaternion(rotations[i]).y+body.position[1]));
    });
    // Mesh-mesh penetration on up to 300 nearby pairs (centres within one body diameter), every 60 frames.
    let meshDepth:number|null=null,probed=0;
    if(frame%60===0||frame===frames){
      meshDepth=0;
      const fields=bodies.map((b,i)=>new SdfBody(template.field,b.position,rotations[i].clone().multiply(new THREE.Quaternion(...template.fieldRotation)).toArray() as Quat,template.original.scale));
      for(let i=0;i<bodies.length&&probed<300;i+=7)for(let j=0;j<bodies.length&&probed<300;j++){
        if(i===j||Math.hypot(...bodies[i].position.map((v,k)=>v-bodies[j].position[k]))>1)continue;
        probed++;
        for(const v of local){const p=v.clone().applyQuaternion(rotations[i]).add(new THREE.Vector3(...bodies[i].position));meshDepth=Math.max(meshDepth,-fields[j].sample(p.toArray() as Vec3).phi);}
      }
    }
    const recent=times.slice(-30);
    const sample={frame,pairCapacity:world.sdfCollisionCapacity,pairs:counters.pairs,contacts:counters.contacts,overflow:counters.overflow,kineticEnergy:energy,groundPenetration:Math.max(0,groundDepth),
      meshPenetration:meshDepth,probedPairs:probed,frameMsMean30:recent.reduce((s,v)=>s+v,0)/recent.length};
    samples.push(sample);console.log(JSON.stringify(sample));
  }
  report.overflowFrames=overflowFrames;report.finalPairCapacity=world.sdfCollisionCapacity;report.growthError=world.sdfCollisionError?.message??null;
  const sorted=[...times].sort((a,b)=>a-b);
  report.frameMs={median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.floor(sorted.length*.95)],max:sorted.at(-1)};
  report.samples=samples;
  if(errors.length)throw new Error(errors.join('\n'));
} finally {
  report.errors=errors;await writeFile(output,JSON.stringify(report,null,1)+'\n');
  world.destroy();scene.dispose();device.destroy();
}
