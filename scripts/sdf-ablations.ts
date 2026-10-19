// Tables 3/4: released box/gear stacks, optimizer x smoothing/cache ablations.
// GPU AVBD trajectories differ from the paper's CPU sequential-impulse trajectories.
// Counts are per collision call; no CPU t_coll equivalence or timing claim is made.
import { readFile, writeFile } from 'node:fs/promises';
import { create, globals } from 'webgpu';
import { loadReleasedScene, instantiateReleased, type ReadAsset } from '../src/sdf-released/scenes.ts';
import { measuredFrame } from '../src/sdf-released/metrics.ts';
const output=process.argv[2],frames=Number(process.argv[3]??360);
if(!output||!Number.isInteger(frames)||frames<1||frames>1000)throw new Error('Usage: sdf-ablations.ts output.json [frames 1..1000]');
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
Object.assign(globalThis,globals);
const gpu=create([]),adapter=await gpu.requestAdapter();if(!adapter)throw new Error('No WebGPU adapter');
const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:adapter.limits.maxStorageBuffersPerShaderStage}});
(globalThis as typeof globalThis & {__ablationGpu?:unknown}).__ablationGpu=[gpu,adapter,device];
const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
// Paper Tables 3/4, rows ordered optimizer then default/no-softmax/no-cache.
// null is the paper's reported SGD/no-cache gear failure, not a zero measurement.
const paper=[
  [[116,1000,2500],[116,2840,7100],[116,3800,7700],[116,550,550],[116,8100,8100],[116,3600,3600],[116,6600,6000],[116,8700,8700],[116,8500,8500]],
  [[12,180,420],[12,460,980],[12,420,860],[12,160,160],[12,1100,1100],[12,510,510],[12,700,700],[12,1200,1200],null]
];
const rows:unknown[]=[];
const report={reference:'sdf-dcd-demo 1dcdf1e7fa07d16fda15826ad8c2e6697075a76e',frames,
  conventions:'GPU AVBD, released parameters. Iterations/queries are frame sums divided by substeps; contacts/pairs are final-substep snapshots, each averaged over frames. No-cache disables contact sample reuse and corresponding SDF solver multiplier transport, retains 4+1 fresh searches. No-softmax uses epsilon=0 with midpoint subgradient at ties. Not the paper CPU solver or timing reproduction.',rows};
try{
  for(const id of [0,1])for(const optimizer of [0,1,2] as const)for(const variant of ['default','no-softmax','no-cache']){
    const scene=await loadReleasedScene(id,read);
    scene.capture.params={...scene.capture.params,optimizer,...(variant==='no-softmax'?{epsilon:0}:{}),...(variant==='no-cache'?{warmStart:false}:{})};
    const {world,bodies}=await instantiateReleased(scene,{device},'reference');
    const samples=[];let queries=0,iterations=0,contacts=0,pairs=0;
    try{
      const substeps=Math.round(scene.capture.solver.dt/world.dt);
      for(let frame=1;frame<=frames;frame++){
        const s=await measuredFrame(scene,world,bodies,frame,frame===frames);
        queries+=s.stats.queries/substeps;iterations+=s.stats.iterations/substeps;contacts+=s.stats.contacts;pairs+=s.stats.pairs;
        if(frame%30===0||frame===frames)samples.push(s);
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      if(errors.length)throw new Error(errors.join('\n'));
      const baseline=paper[id][optimizer*3+['default','no-softmax','no-cache'].indexOf(variant)];
      const row={scene:id,optimizer,variant,substeps,paper:baseline?{contacts:baseline[0],iterations:baseline[1],queries:baseline[2]}:{status:'FAIL'},mean:{queries:queries/frames,iterations:iterations/frames,contacts:contacts/frames,pairs:pairs/frames},samples};
      rows.push(row);console.log(JSON.stringify({scene:id,optimizer,variant,...row.mean,finalEnergy:samples.at(-1)!.kineticEnergy,finalPenetration:samples.at(-1)!.maxVertexPenetration}));
      await writeFile(output,JSON.stringify(report,null,2)+'\n');
    }finally{world.destroy();scene.dispose();}
  }
}finally{device.destroy();}
