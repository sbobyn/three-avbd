// Paper Fig. 6 (Giles & Andrews 2026, Sec. 4.3): bunny and cow dropped onto a ground plane
// from randomized orientations; maximum penetration depth per frame, sweeping the cache size,
// the stochastic sample budget and uniform vs curvature sampling. Runs on the production GPU
// path with the released parameters. All rollouts of one configuration share a World, spaced
// so that only body/ground pairs exist. Penetration is exact against the plane: the lowest
// source mesh vertex below y = 0. A wide floor approximates the plane; any edge or bottom escape
// invalidates the plane comparison and is retained in the report. 'dense' uses an independent
// 1000-point mesh-surface plane-contact analogue; the paper's exact sample set is unavailable. Bounded and sequential; no timing claims.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DensePlaneOracle, denseSurfacePoints } from './sdf-dense-plane.ts';
import * as THREE from 'three';
import { create, globals } from 'webgpu';
import { World } from '../src/lib/world.ts';
import { AnalyticField } from '../src/lib/sdf.ts';
import { loadReleasedScene, type ReadAsset } from '../src/sdf-released/scenes.ts';
const output=process.argv[2],rollouts=Number(process.argv[3]??100),frames=Number(process.argv[4]??500);
const shapes=(process.argv[5]??'bunny,cow').split(',');
const budget=process.argv[6],dense=budget==='dense';
if(budget!==undefined&&!dense&&!['4:1','4:4','8:1','8:4','16:1','16:4'].includes(budget))throw new Error('Budget must be cache:samples (4/8/16:1/4)');
if(!output||!Number.isInteger(rollouts)||rollouts<1||rollouts>100||!Number.isInteger(frames)||frames<1||frames>1000||shapes.some(s=>!['bunny','cow'].includes(s)))
  throw new Error('Usage: sdf-fig6.ts output.json [rollouts 1..100] [frames 1..1000] [bunny,cow] [optional cache:samples or dense]');
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);
const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter');
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
(globalThis as typeof globalThis & {__fig6Gpu?:unknown}).__fig6Gpu=[gpu,adapter,device];
const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
// Deterministic orientations shared by every configuration (uniform on SO(3), Shoemake).
let state=0x9e3779b9;const random=()=>{state=Math.imul(state^state>>>15,0x2c1b3c6d)+0x6d2b79f5>>>0;return state/2**32;};
const orientations=Array.from({length:rollouts},()=>{const u=[random(),random(),random()],a=Math.sqrt(1-u[0]),b=Math.sqrt(u[0]);
  return new THREE.Quaternion(a*Math.sin(2*Math.PI*u[1]),a*Math.cos(2*Math.PI*u[1]),b*Math.sin(2*Math.PI*u[2]),b*Math.cos(2*Math.PI*u[2]));});
const configs=[];
for(const curvatureSampling of [false,true])for(const cacheSize of [4,8,16])for(const randomSamples of [1,4])if(!dense&&(!budget||budget===`${cacheSize}:${randomSamples}`))configs.push({cacheSize,randomSamples,curvatureSampling});
if(dense)configs.push({cacheSize:0,randomSamples:0,curvatureSampling:false});
const report={contactPolicy:dense?'one constraint per active surface point; no manifold reduction':'Algorithm 1 ranked contact set',sampleCoordinates:dense?'solver body-local, source mesh COM centered, scaled and principal-axis rotated':null,oracle:dense?'1000 area-stratified mesh surface points, exhaustive analytic plane contacts, GPU AVBD; not the paper grid-sample set':null,threeRevision:THREE.REVISION,floorHalfExtents:[10000,1,10000],rolloutIsolation:dense?'backend emits only drop-to-floor contacts (floor slot 0, dynamic slots 1..N)':'collision masks: floor group1/mask2, drops group2/mask1; no drop-drop contacts',budget:budget??'all',paper:'Giles & Andrews 2026, Fig. 6 (Sec. 4.3)',reference:'sdf-dcd-demo 1dcdf1e7fa07d16fda15826ad8c2e6697075a76e',rollouts,frames,
  conventions:'released parameters; per frame, the deepest source-mesh vertex below the ground plane per rollout (penetration), and below the solver rest gap margin-allowedPenetration (intrusion), then the mean and max over rollouts. Drop height: lowest vertex 0.25 m above the ground; random orientations shared by all configurations.',
  shapes:[] as unknown[]};
try{
  for(const shape of shapes){
    const scene=await loadReleasedScene(shape==='bunny'?9:8,read);
    const ground=scene.bodies[0],floorHalf:[number,number,number]=[10000,1,10000],floorField=new AnalyticField({kind:'box',halfExtents:floorHalf}),template=scene.bodies.find(b=>b.original.shape.kind==='voxel')!;
    const vertices=template.geometry.getAttribute('position'),principal=new THREE.Quaternion(...template.fieldRotation).invert();
    const local=Array.from({length:vertices.count},(_,i)=>new THREE.Vector3().fromBufferAttribute(vertices,i));
    const samples=dense?denseSurfacePoints(template.geometry):[];
    const runs=[];
    try{
      for(const config of configs){
        const solver=scene.capture.solver,substeps=solver.substeps;
        const world=await World.create({device,maxBodies:rollouts+1,dt:solver.dt/substeps,iterations:solver.iterations,gravity:solver.gravity});
        world.maxSubsteps=substeps;world.readbackEvery=0;
        try{
          const floor=world.addBox({size:[1,1,1],position:ground.original.position,rotation:ground.rotation,fixed:true,group:1,collidesWith:2,friction:ground.original.friction})!;
          const side=Math.ceil(Math.sqrt(rollouts)),spacing=4*template.original.scale;
          const bodies=orientations.map((q,i)=>{
            const rotation=q.clone().multiply(principal);
            const lowest=Math.min(...local.map(v=>v.clone().applyQuaternion(rotation).y));
            const position:[number,number,number]=[(i%side-(side-1)/2)*spacing,.25-lowest,(Math.floor(i/side)-(side-1)/2)*spacing];
            return world.addBox({size:[1,1,1],position,rotation:rotation.toArray() as [number,number,number,number],friction:template.original.friction,group:2,collidesWith:1,
              massProperties:{mass:template.original.mass,moments:template.moments}})!;
          });
          const points=Math.max(5,config.cacheSize+config.randomSamples);
          if(dense){
            await world.read();
            world.solver.setCollisionBackend(await DensePlaneOracle.create(world.solver,samples,rollouts,scene.capture.params.margin,scene.capture.params.allowedPenetration));
          }else{
          await world.enableSdfCollisions([{body:floor,field:floorField,scale:ground.original.scale,rotation:ground.fieldRotation},
            ...bodies.map(body=>({body,field:template.field,scale:template.original.scale,rotation:template.fieldRotation}))],
            {...scene.capture.params,...config},{maxPointsPerPair:dense?1000:points,maxPairs:rollouts*2});
          }
          // Rest-gap intrusion: depth below the solver's target separation (margin - allowed
          // penetration, 1 cm released), which separates configurations even when no geometry overlaps.
          const gap=scene.capture.params.margin-scene.capture.params.allowedPenetration;
          const mean:number[]=[],max:number[]=[],intrusionMean:number[]=[],intrusionMax:number[]=[];
          const escapes:{frame:number;body:number;position:number[];lowest:number;reason:string}[]=[];
          let peakContacts=0;
          const escaped=new Set<number>(),radius=Math.max(...local.map(v=>v.length()));

          for(let frame=1;frame<=frames;frame++){
            for(let s=0;s<substeps;s++){
              world.step();
              const counters=await world.solver.readCounters();if(counters.overflow)throw new Error(`Collision overflow ${counters.overflow} at frame ${frame} substep ${s}`);peakContacts=Math.max(peakContacts,counters.contacts);
            }
            await world.read();
            let sum=0,worst=0,intrusion=0,intrusionWorst=0;
            for(const [bodyIndex,body] of bodies.entries()){
              if(![...body.position,...body.rotation].every(Number.isFinite))throw new Error(`Non-finite pose at frame ${frame}`);
              const rotation=new THREE.Quaternion(...body.rotation),y=body.position[1];
              let lowest=Infinity;for(const v of local)lowest=Math.min(lowest,v.clone().applyQuaternion(rotation).y+y);
              const edge=Math.abs(body.position[0])+radius>floorHalf[0]||Math.abs(body.position[2])+radius>floorHalf[2];
              if(!escaped.has(bodyIndex)&&(edge||lowest < -2*floorHalf[1])){
                escaped.add(bodyIndex);escapes.push({frame,body:bodyIndex,position:[...body.position],lowest,reason:edge?'finite-floor-edge':'below-floor-bottom'});
              }
              const depth=Math.max(0,-lowest);sum+=depth;worst=Math.max(worst,depth);
              const inside=Math.max(0,gap-lowest);intrusion+=inside;intrusionWorst=Math.max(intrusionWorst,inside);
            }
            mean.push(sum/bodies.length);max.push(worst);intrusionMean.push(intrusion/bodies.length);intrusionMax.push(intrusionWorst);
            await device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,10));
            if(frame%100===0){
              if(!dense){const pairs=await world.readSdfResults();
                if(pairs.some(p=>p.a!==0&&p.b!==0))throw new Error('Cross-rollout collision pair');}
              console.log(shape,JSON.stringify(config),`frame ${frame}/${frames}`,`escapes ${escapes.length}`);
            }
          }
          const counters=await world.solver.readCounters();if(counters.overflow)throw new Error(`Collision overflow ${counters.overflow}`);
          const average=(list:number[])=>list.reduce((s,v)=>s+v,0)/list.length;
          const run={mode:dense?'dense-plane':'algorithm-1',...config,peakContacts,escapes,validPlaneComparison:escapes.length===0,maxPointsPerPair:dense?1000:points,meanDepth:mean,maxDepth:max,meanIntrusion:intrusionMean,maxIntrusion:intrusionMax,
            summary:{meanOverFrames:average(mean),peakMean:Math.max(...mean),peakMax:Math.max(...max),settledMean:average(mean.slice(-100)),
              intrusionMeanOverFrames:average(intrusionMean),intrusionPeakMax:Math.max(...intrusionMax)}};
          runs.push(run);
          console.log(shape.padEnd(6),`${config.curvatureSampling?'curvature':'uniform  '} cache ${String(config.cacheSize).padStart(2)} sto ${config.randomSamples}`,
            `penetration mean ${(run.summary.meanOverFrames*1000).toFixed(3)} / peak ${(run.summary.peakMax*1000).toFixed(2)} mm; gap intrusion mean ${(run.summary.intrusionMeanOverFrames*1000).toFixed(3)} / peak ${(run.summary.intrusionPeakMax*1000).toFixed(2)} mm`);
        } finally {world.destroy();}
      }
    } finally {scene.dispose();}
    report.shapes.push({shape,scale:template.original.scale,...(dense?{surfaceSamples:samples.map(p=>p.toArray()),surfaceUploadHash:createHash('sha256').update(new Uint8Array(new Float32Array(samples.flatMap(p=>[...p.toArray(),0])).buffer)).digest('hex'),surfaceSampleHash:createHash('sha256').update(JSON.stringify(samples.map(p=>p.toArray()))).digest('hex')} : {}),runs});
    await writeFile(output,JSON.stringify(report)+'\n');
  }
  if(errors.length)throw new Error(errors.join('\n'));
} finally {device.destroy();}
