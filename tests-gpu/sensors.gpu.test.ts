// Frozen STE-3330 internal standard-only proof. Written before hardware execution.
// This does not qualify public sensor lifecycle, pools, moving sensors, hulls, SDF or custom backends.
// See docs/SENSORS_DESIGN.md §§9,11. Do not relax thresholds after a failed run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu, skip } from './device.ts';
import { assessAdapter } from '../src/comparison/interlocking-trial.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { sphere } from '../src/avbd3d/shapes.ts';
import { ContactWatch, BEGIN, END, type RawContactEvent } from '../src/lib/contacts.ts';
import { B_POS, B_VEL, B_ANGVEL, BODY_FLOATS, CONTACT_WORDS, K_RA, K_LAM, K_PEN, STICK_BIT, BODY_DISABLED } from '../src/avbd3d/gpu/layout.ts';
import { STANDARD_SENSOR_BIT } from '../src/avbd3d/gpu/sensor-preparation.ts';
import { solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { contactsWGSL } from '../src/avbd3d/gpu/wgsl-collision.ts';
const DT=1/64;
const near=(actual:number,expected:number,why:string)=>{
  assert.ok(Number.isFinite(actual),why+': finite');
  assert.ok(Math.abs(actual-expected)<=Math.max(1e-6,Math.abs(expected)*1e-4), `${why}: ${actual} vs ${expected}`);
};
function fixture(device:GPUDevice, options:{control?:boolean;swap?:boolean;report?:'sensor'|'partner'|'none';iterations?:number;ordinary?:boolean;custom?:boolean}={}) {
  const ref=new Solver(); ref.gravity=0; ref.dt=DT;
  const addBox=()=>new Rigid(ref,[1,4,4],0,0.5,[0,0,0]);
  const addSphere=()=>sphere(ref,1/8,1,0.5,[-2,0,0],[2,0,0]);
  let box:Rigid,ball:Rigid;
  if(options.swap){ball=addSphere();box=addBox();}else{box=addBox();ball=addSphere();}
  const gpu=new GpuSolver3D(device,ref,{hulls:false,spatialSort:false,bodyCapacity:2,sensorProof:!options.ordinary,...(options.custom?{shaders:{solve:solveWGSL,contacts:contactsWGSL}}:{})});
  gpu.params.gravity=0; gpu.params.up=[0,1,0];
  if(options.iterations!==undefined)gpu.params.iterations=options.iterations;
  const boxSlot=options.swap?1:0,ballSlot=1-boxSlot;
  if(!options.ordinary)gpu.setSensorFlags([boxSlot],[!options.control]);
  if (options.custom) assert.throws(() => gpu.setBodyAux([0,1],[1,1],[0,0],[0,0]), /built-in solve shaders/);
  else gpu.setBodyAux([0,1],[1,1],[0,0],[0,0]);
  if(options.control)gpu.setFilters([boxSlot],[1],[0]);
  const watch=new ContactWatch(device,gpu.bodyBuffer,2,8,16);
  watch.prewarm(gpu.contactStorages());
  const report=options.report??'sensor';
  // Lifetime IDs are explicit and independent of watch opt-in. Creation order defines IDs.
  watch.setWatched([boxSlot,ballSlot],[boxSlot+1,ballSlot+1],[report==='sensor',report==='partner']);
  return {gpu,watch,box,ball,boxSlot,ballSlot,mass:ball.mass,destroy(){watch.destroy();gpu.destroy();}};
}
async function readBuffer(device:GPUDevice, buffer:GPUBuffer,size:number) {
  const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try {
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,read,0,size);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);return read.getMappedRange().slice(0);
  }finally{read.destroy();}
}
async function assertRawZero(device:GPUDevice,gpu:GpuSolver3D,expected:boolean) {
  const counts=await gpu.readCounters();assert.equal(counts.overflow,0);
  assert.equal(counts.manifolds,expected?1:0);assert.equal(counts.contacts,expected?1:0);
  if(!expected)return;
  const raw=await readBuffer(device,gpu.contactStorage.contacts,counts.contacts*CONTACT_WORDS*4);
  const u=new Uint32Array(raw),f=new Float32Array(raw);
  for(let i=0;i<counts.contacts;i++) {
    const at=i*CONTACT_WORDS,key=u[at+K_RA+3];
    assert.equal(key&STANDARD_SENSOR_BIT,STANDARD_SENSOR_BIT);assert.equal(key&STICK_BIT,0);
    assert.deepEqual([...f.slice(at+K_LAM,at+K_LAM+3)],[0,0,0]);
    assert.deepEqual([...f.slice(at+K_PEN,at+K_PEN+3)],[0,0,0]);
  }
  const decoded=await gpu.readContactList();
  assert.ok(decoded.every(c=>c.feature===(3<<24)), 'standard proof decoder hides only marker');
}
async function flight(device:GPUDevice,report:'sensor'|'partner'|'none',swap=false,iterations?:number) {
  const a=fixture(device,{report,swap,iterations}),b=fixture(device,{control:true,report:'none',swap,iterations});
  const events:RawContactEvent[]=[];
  try {
    assert.equal(a.boxSlot,swap?1:0);assert.equal(a.ballSlot,swap?0:1);
    for(let step=1;step<=128;step++) {
      a.gpu.step({reuseManifolds:true}); b.gpu.step({reuseManifolds:true});
      a.watch.run(a.gpu.contactStorage,a.gpu.manifoldCapacity,step,DT);
      const [x,y]=await Promise.all([a.gpu.readBodies(),b.gpu.readBodies()]);
      const o=a.ballSlot*BODY_FLOATS;
      for(const field of [B_POS,B_VEL])for(let c=0;c<3;c++)near(x[o+field+c],y[o+field+c],`step${step} field${field} axis${c}`);
      for(let c=0;c<3;c++) {
        near(x[o+B_POS+c],c===0?-2+step/32:0,`step${step} analytic position${c}`);
        near(x[o+B_VEL+c]*a.mass,c===0?2*a.mass:0,`step${step} momentum${c}`);
        near(x[o+B_VEL+c],c===0?2:0,`step${step} velocity${c}`);
      }
      assert.ok(Math.hypot(...x.slice(o+B_ANGVEL,o+B_ANGVEL+3))<=1e-6);
      await assertRawZero(device,a.gpu,step>=45&&step<=85);
      const result=await a.watch.read();assert.equal(result.dropped,0);assert.equal(result.full,false);events.push(...result.events);
    }
    if(report==='none'){assert.deepEqual(events,[]);return;}
    assert.deepEqual(events.map(e=>[e.kind,e.step,e.a,e.b]),[[BEGIN,45,2,1],[END,86,2,1]]);
    const [begin,end]=events;
    assert.equal(begin.impulse,0);assert.equal(end.impulse,0);
    for(let c=0;c<3;c++) {
      assert.ok(Math.abs(begin.normal[c]-(c===0?(swap?1:-1):0))<=1e-6);
      // Swapped A is the fixed box: its local witness reconstructs at the detecting surface.
      assert.ok(Math.abs(begin.point[c]-(c===0?(swap?-0.5:-0.46875):0))<=1e-6);
    }
    assert.deepEqual(end.point,[0,0,0]);assert.deepEqual(end.normal,[0,0,0]);
  }finally{a.destroy();b.destroy();}
}
async function lifecycleAndToggle(device:GPUDevice) {
  const f=fixture(device,{report:'partner'});
  try {
    // Establish a real force-bearing old contact before enabling the proof flag.
    f.gpu.setSensorFlags([0],[false]);
    f.ball.positionLin.set([-0.55,0,0]);f.ball.velocityLin.fill(0);
    f.gpu.patchBody(1,new Set(['position','velocity']),f.ball);
    f.gpu.step();
    const old=await f.gpu.readContactList();assert.ok(old.some(c=>c.lam.some(v=>v!==0)&&c.pen.some(v=>v!==0)), 'old contact carries force and penalty');
    // Restore a known detecting pose. Flag changes must invalidate all history.
    f.gpu.patchBody(1,new Set(['position','velocity']),f.ball);
    f.gpu.setSensorFlags([0],[true]);f.gpu.step({reuseManifolds:true});await assertRawZero(device,f.gpu,true);
    let step=1;
    const observe=async()=>{f.gpu.step({reuseManifolds:true});f.watch.run(f.gpu.contactStorage,f.gpu.manifoldCapacity,step++,DT);return (await f.watch.read()).events;};
    assert.equal((await observe())[0]?.kind,BEGIN);
    f.gpu.setLifecycle(0,BODY_DISABLED);assert.equal((await observe())[0]?.kind,END);
    f.gpu.setLifecycle(0,0);assert.equal((await observe())[0]?.kind,BEGIN);
    f.gpu.setFilters([0,1],[0x80000000,0x80000000],[0x80000000,0x80000000]);
    assert.deepEqual(await observe(),[]);await assertRawZero(device,f.gpu,true);
    f.gpu.setFilters([1],[0x80000000],[0]);assert.equal((await observe())[0]?.kind,END);
    f.gpu.setFilters([1],[0x80000000],[0x80000000]);assert.equal((await observe())[0]?.kind,BEGIN);
    await assertRawZero(device,f.gpu,true);
    f.gpu.setSensorFlags([0],[false]);f.gpu.step({reuseManifolds:true});
    assert.ok((await f.gpu.readContactList()).some(c=>c.pen.some(v=>v>0)), 'turning off restores ordinary response from fresh detection');
  }finally{f.destroy();}
}

test('qualified default-eight device: frozen flight/events/raw response, reporting, swap, iterations0 and toggles', {skip},async(t)=>{
  const adapter=await createGpu().requestAdapter();assert.ok(adapter);
  assert.equal(assessAdapter(adapter.info,(adapter as GPUAdapter & {isFallbackAdapter?:boolean}).isFallbackAdapter).ok,true,'hardware adapter required');
  const device=await adapter.requestDevice();const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
  try {
    assert.equal(device.limits.maxStorageBuffersPerShaderStage,8);
    t.diagnostic(JSON.stringify({at:new Date().toISOString(),adapter:{vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description},isFallbackAdapter:(adapter as GPUAdapter & {isFallbackAdapter?:boolean}).isFallbackAdapter??null,deviceStorageLimit:device.limits.maxStorageBuffersPerShaderStage}));
    device.pushErrorScope('validation');
    await flight(device,'sensor');await flight(device,'none');await flight(device,'partner');await flight(device,'sensor',true);await flight(device,'sensor',false,0);
    await lifecycleAndToggle(device);
    // Ordinary built-in and public custom source retain the same result without proof resources.
    const a=fixture(device,{ordinary:true}),b=fixture(device,{ordinary:true,custom:true});
    try { for(let i=0;i<64;i++){a.gpu.step();b.gpu.step();} assert.deepEqual(await a.gpu.readBodies(),await b.gpu.readBodies()); }finally{a.destroy();b.destroy();}
    assert.equal(await device.popErrorScope(),null);await device.queue.onSubmittedWorkDone();assert.deepEqual(errors,[]);
  }finally{device.destroy();}
});
