// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 3a819f0368031cb1fab6f3adc8d95cd11d2e1b38d1904eb91946c080032ac9ef. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// Bounded changed-path pile qualification. Explicit pairs and capacities are matched;
// original released mass/inertia/geometry and all native collision work are retained.
import {readFile,writeFile} from 'node:fs/promises';
import {create,globals} from 'webgpu';
import {loadReleasedScene,instantiateReleased,releasedSettings,type ReadAsset} from '../src/sdf-released/scenes.ts';
import {measuredFrame} from '../src/sdf-released/metrics.ts';
import {SdfCollisionBridge} from '../src/avbd3d/gpu/sdf-bridge.ts';
import {decodeSdfResults} from '../src/avbd3d/gpu/sdf-layout.ts';
import {RegionProposalBridge} from './sdf-region-solver.ts';
import {jitterReleased} from './sdf-jitter.ts';
import {policySources,digest} from './sdf-policy-evidence.ts';

const [out,idArg,mode,seedArg='0',framesArg='360']=process.argv.slice(2),id=Number(idArg),seed=Number(seedArg),frames=Number(framesArg);
if(!out||![6,9].includes(id)||!['native','region'].includes(mode)||!Number.isInteger(seed)||seed<0||seed>10||![60,360].includes(frames))throw Error('Usage: sdf-region-pile-quality.ts OUT SCENE(6|9) MODE(native|region) SEED(0..10) FRAMES(60|360)');
const watchdog=setTimeout(()=>{console.error('Pile qualification watchdog expired');process.exit(2);},240_000);watchdog.unref();
const files=['scripts/sdf-region-pile-quality.ts','scripts/sdf-region-discovery.ts','scripts/sdf-region-solver.ts','scripts/sdf-region-native.ts','scripts/sdf-region-contacts.ts','scripts/sdf-coverage-discovery.ts'];
const source=await policySources(files),assets:Record<string,string>={};
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));assets[path]=digest(b);return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw Error('No GPU');
const device=await adapter.requestDevice({requiredFeatures:adapter.features.has('timestamp-query')?['timestamp-query']:[],requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage,maxStorageBufferBindingSize:adapter.limits.maxStorageBufferBindingSize,maxBufferSize:adapter.limits.maxBufferSize}});
(globalThis as any).__regionPile=[gpu,adapter,device];const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
const original=await loadReleasedScene(id,read),scene=jitterReleased(original,seed),instance=await instantiateReleased(scene,{device}),{world,bodies}=instance;
try{
  world.disableSdfCollisions();const pairs=scene.bodies.flatMap((_,a)=>Array.from({length:a},(_,b)=>({a,b,key:a*scene.bodies.length+b+1}))),bindings=scene.bodies.map(b=>({field:b.field,scale:b.original.scale,rotation:b.fieldRotation})),settings=releasedSettings(scene);
  world.solver.reserveCollisionCapacity(pairs.length*9);
  const start=performance.now();
  const bridge=mode==='region'?await RegionProposalBridge.create(world.solver,bindings,pairs,settings.collision,5,{gpuDiscovery:true}):await SdfCollisionBridge.create(world.solver,bindings,pairs,settings.collision);
  world.solver.setCollisionBackend(bridge);const bridgeSetupMs=performance.now()-start,region=bridge instanceof RegionProposalBridge?bridge:null,native=region?region.native:bridge as SdfCollisionBridge;
  let steps=0,active=0,warm=0,changedSubsteps=0;const work=new Float64Array(8);
  const facade=new Proxy(world,{get(target,key){
    if(key==='step')return ()=>{steps++;world.solver.step();};
    if(key==='readSdfResults')return async()=>{
      const rows=await native.readResults();
      if(region){const history=await region.readHistory(),extra=decodeSdfResults(history.buffer as ArrayBuffer,pairs.length,4);let added=0;
        for(let i=0;i<rows.length;i++){const points=extra[i].points.filter(p=>p.active);added+=points.length;warm+=points.filter(p=>p.cached).length;rows[i].points.push(...points);}
        active+=added;changedSubsteps+=+(added>0);const stats=await region.readDiscoveryStats();for(let i=0;i<stats.length;i++)work[i%8]+=stats[i];
      }
      if(steps%16===0)world.solver.adaptColors(await world.solver.readCounters());return rows;
    };const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  const samples=[];
  for(let frame=1;frame<=frames;frame++){
    samples.push(await measuredFrame(scene,facade,bodies,frame,frame%5===0));if(errors.length)throw Error(errors.join('\n'));
    await device.queue.onSubmittedWorkDone();await new Promise(r=>setTimeout(r,10));
  }
  // Separate bounded throughput sample AFTER the physical screen. No diagnostic readback
  // or timestamp instrumentation within a timed frame; includes CPU encode and GPU drain.
  const timing:number[]=[];
  for(let frame=0;frame<40;frame++){
    const t=performance.now();for(let s=0;s<settings.substeps;s++)world.solver.step();await device.queue.onSubmittedWorkDone();const ms=performance.now()-t;if(frame>=10)timing.push(ms);
    const counters=await world.solver.readCounters();if(counters.overflow)throw Error('Timing overflow');world.solver.adaptColors(counters);await new Promise(r=>setTimeout(r,10));
  }
  const after=await policySources(files);if(JSON.stringify(source)!==JSON.stringify(after))throw Error('Source changed during measurement');
  const probes=samples.filter(s=>s.maxVertexPenetration!==undefined),last=samples.at(-1)!,sorted=timing.slice().sort((a,b)=>a-b);
  const summary={peakPenetration:Math.max(...probes.map(p=>p.maxVertexPenetration!)),finalPenetration:last.maxVertexPenetration,energy:last.kineticEnergy,probesOver5mm:probes.filter(s=>s.maxVertexPenetration!>=.005).length,optionalContactObservations:active,optionalCachedObservations:warm,changedSubsteps,discoveryWork:{visits:work[0],probes:work[1],hints:work[2],pending:work[3],dropped:work[4],invalid:work[5],samples:work[6]},bridgeSetupMs,frameMs:{median:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)]}};
  const report={kind:'GPU witness discovery full released 27-body pile screen; not browser FPS or replacement search',id,mode,seed,frames,steps,pairCount:pairs.length,substeps:settings.substeps,source,assets,adapter:adapter.info,settings,solver:scene.capture.solver,discovery:region?.discoveryInfo??null,summary,timing,samples};
  await writeFile(out,JSON.stringify(report)+'\n',{flag:'wx'});console.log(JSON.stringify(summary));
}finally{world.destroy();original.dispose();device.destroy();clearTimeout(watchdog);}
