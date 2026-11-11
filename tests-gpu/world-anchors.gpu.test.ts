// STE-3335: explicit opt-in invocation amendment in WORLD_ANCHORS_DESIGN.md.
// Same physical fixtures/criteria; original legacy failures and exact fixtures retained separately. Compute only, not rendering or a benchmark.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { create, globals } from 'webgpu';
import { assessAdapter } from '../src/comparison/interlocking-trial.ts';
import { World, type Body } from '../src/lib/world.ts';
import { rotate } from '../src/avbd3d/ref/math.ts';
Object.assign(globalThis, globals);
const retained: unknown[] = [];
async function owned(fn: (device: GPUDevice, info: object) => Promise<void>) {
  const gpu = create([]), adapter = await gpu.requestAdapter();
  assert.ok(adapter, 'hardware adapter required');
  retained.push(gpu, adapter);
  const info = { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description };
  assert.equal(assessAdapter(info, (adapter as GPUAdapter & {isFallbackAdapter?: boolean}).isFallbackAdapter).ok, true, 'identified non-software adapter');
  const device = await adapter.requestDevice({requiredLimits: { maxStorageBuffersPerShaderStage: 8 }});
  retained.push(device);
  const errors: string[] = [];
  device.addEventListener('uncapturederror', e => errors.push(e.error.message));
  console.log('world-anchor-device', JSON.stringify({info, fallback: (adapter as GPUAdapter & {isFallbackAdapter?: boolean}).isFallbackAdapter ?? null, storageBuffers: device.limits.maxStorageBuffersPerShaderStage}));
  try { await fn(device, info); await device.queue.onSubmittedWorkDone(); assert.deepEqual(errors, []); }
  finally { device.destroy(); }
}
function error(body: Body, local: [number, number, number], target: [number, number, number]) {
  const r = rotate(new Float64Array(3), body.rotation, local);
  return Math.hypot(...body.position.map((x, i) => x + r[i] - target[i]));
}
test('inertial-hard world ball: 10-second one-body pendulum stays within 1 mm on default-eight hardware', async () => owned(async (device, info) => {
  const w = await World.create({device, maxBodies: 1, dt: 1/120, iterations: 20, gravity: [0,-9.81,0]});
  const q: [number,number,number,number] = [0,0,Math.sin(Math.PI/18),Math.cos(Math.PI/18)];
  const local: [number,number,number] = [0,.5,0], target: [number,number,number] = [0,0,0];
  const offset = rotate(new Float64Array(3), q, local);
  const b = w.addBox({size:[.1,1,.1],density:100,rotation:q,position:[-offset[0],-offset[1],-offset[2]]})!;
  w.addWorldJoint(b,{anchorWorld:target,anchorBody:local,policy:'inertial-hard'});
  const stats = w.bodyStats, version = w.version;
  const samples: {step:number;errorM:number;position:number[];rotation:number[]}[] = [];
  let maxAngle = 0;
  try {
    for (let step=0;step<=1200;step++) {
      if(step) w.step();
      const read = await w.read([b]);
      assert.equal(read.step,step);
      const position=[...b.position], rotation=[...b.rotation];
      assert.ok([...position,...rotation,...b.velocity,...b.angularVelocity].every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...rotation)-1)<=1e-4);
      samples.push({step,errorM:error(b,local,target),position,rotation});
      maxAngle=Math.max(maxAngle,2*Math.acos(Math.min(1,Math.abs(rotation.reduce((sum,x,i)=>sum+x*q[i],0)))));
    }
    const max = samples.reduce((a,b)=>a.errorM>b.errorM?a:b);
    const result={at:new Date().toISOString(),info,protocol:'WORLD_ANCHORS_DESIGN.md/explicit-inertial-hard-arm/1mm-1200',dt:w.dt,iterations:w.iterations,samples,maxErrorM:max.errorM,worstStep:max.step,rmsErrorM:Math.sqrt(samples.reduce((s,x)=>s+x.errorM*x.errorM,0)/samples.length),maxAngleRad:maxAngle};
    if(process.env.WORLD_ANCHOR_REPORT) await writeFile(process.env.WORLD_ANCHOR_REPORT,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log('world-anchor-result',JSON.stringify({...result,samples: samples.length}));
    assert.ok(max.errorM<=.001,`maximum pivot error ${max.errorM} m at step ${max.step}`);
    assert.ok(maxAngle>.01,'free rotation is observable');
    assert.deepEqual(w.bodyStats,stats); assert.equal(w.version,version); assert.equal(w.solver.bodyCount,1);
  } finally { w.destroy(); }
}));
test('inertial-hard world target boundary, disable/reset/fixed/force and safe remove on hardware', async () => owned(async(device,info)=>{
  const w=await World.create({device,maxBodies:1,dt:1/120,iterations:20,gravity:[0,0,0]});
  const b=w.addBox({size:[.1,1,.1],position:[0,-.5,0]})!;
  const local:[number,number,number]=[0,.5,0];
  const j=w.addWorldJoint(b,{anchorWorld:[0,0,0],anchorBody:local,policy:'inertial-hard'});
  try {
    await w.read([b]); const start=[...b.position];
    j.setWorldAnchor([.1,0,0]);j.setWorldAnchor([.2,0,0]);
    await w.read([b]); assert.equal(w.stepCount,0); assert.deepEqual([...b.position],start);
    b.setEnabled(false);for(let i=0;i<3;i++)w.step();await w.read([b]);
    assert.equal(j.holding,true);assert.equal(j.suspended,true);assert.deepEqual([...b.position],start);
    b.reset({position:[.2,-.5,0]});b.setEnabled(true);b.setFixed(true);
    j.setWorldAnchor([.3,0,0]);w.step();await w.read([b]);
    assert.ok(Math.abs(b.position[0]-.2)<1e-6,'prescribed fixed pose is not moved to anchor');
    b.setFixed(false);b.applyForce([1,0,0]);j.setWorldAnchor([.25,0,0]);
    for(let i=0;i<240;i++)w.step();await w.read([b]);b.clearForces();
    const retarget = {at:new Date().toISOString(),info,step:w.stepCount,retargetSteps:240,errorM:error(b,local,[.25,0,0]),limitM:.001,position:[...b.position],rotation:[...b.rotation],velocity:[...b.velocity],angularVelocity:[...b.angularVelocity],anchorWorld:j.anchorWorld,anchorBody:j.anchorBody};
    console.log('world-anchor-retarget',JSON.stringify(retarget));
    if(process.env.WORLD_ANCHOR_RETARGET_REPORT) await writeFile(process.env.WORLD_ANCHOR_RETARGET_REPORT,JSON.stringify(retarget,null,2)+'\n',{flag:'wx'});
    assert.ok(retarget.errorM<=.001,'bounded retarget convergence within 1 mm');
    assert.ok([...b.position,...b.velocity,...b.rotation].every(Number.isFinite));
    j.remove();assert.equal(j.holding,false);assert.throws(()=>j.setWorldAnchor([0,0,0]));
    const next=w.addWorldJoint(b,{anchorWorld:[.25,0,0],anchorBody:local,policy:'inertial-hard'});
    w.step();await w.read([b]);assert.equal(next.holding,true);assert.equal(w.solver.jointCount,1);
  } finally {w.destroy();}
}));


test('legacy default equals explicit legacy; mixed policy/sensor/ordinary slots retain their own metadata', async () => owned(async device=>{
  const legacy=await World.create({device,maxBodies:1,dt:1/120,iterations:20});
  const explicit=await World.create({device,maxBodies:1,dt:1/120,iterations:20});
  try {
    const a=legacy.addBox({size:[.1,1,.1],position:[0,-.5,0]})!;
    const b=explicit.addBox({size:[.1,1,.1],position:[0,-.5,0]})!;
    legacy.addWorldJoint(a,{anchorWorld:[0,0,0],anchorBody:[0,.5,0]});
    explicit.addWorldJoint(b,{anchorWorld:[0,0,0],anchorBody:[0,.5,0],policy:'legacy'});
    for(let i=0;i<32;i++){legacy.step();explicit.step();}
    await legacy.read();await explicit.read();
    for(const field of ['position','rotation','velocity','angularVelocity'] as const)assert.deepEqual([...a[field]],[...b[field]]);
    assert.equal(legacy.solver.jointInfo()[3],0);assert.equal(explicit.solver.jointInfo()[3],0);
  } finally {legacy.destroy();explicit.destroy();}
  for(const fixed of [false,true]) {
    const storage={growth:'fixed',pairs:4096,contacts:8192,manifolds:4096,joints:256,hullVec4s:4096} as const;
    const w=await World.create({device,maxBodies:4,dt:1/120,iterations:20,...(fixed?{storage}:{})});
    try {
      const a=w.addBox({size:[.1,1,.1],position:[0,-.5,0],density:100})!;
      const pin=w.addBox({size:[.1,.1,.1],position:[4,0,0],fixed:true})!;
      const b=w.addBox({size:[.1,1,.1],position:[4,-.5,0]})!;
      const ordinary=w.addJoint(pin,b,{type:'ball',anchorB:[0,.5,0]});
      const j=w.addWorldJoint(a,{anchorWorld:[0,0,0],anchorBody:[0,.5,0],policy:'inertial-hard'});
      for(let i=0;i<16;i++)w.step();await w.read();
      a.setSensor(true);for(let i=0;i<16;i++)w.step();await w.read();
      assert.ok(error(a,[0,.5,0],[0,0,0])<=.001,'sensor pipeline activation retains world policy');
      assert.equal(w.solver.jointInfo()[j.slot*4+3],1);assert.equal(w.solver.jointInfo()[ordinary.slot*4+3],0);
      const slot=j.slot;j.remove();const replacement=w.addJoint(pin,a,{type:'ball'});w.flushCommands();
      assert.equal(replacement.slot,slot);assert.equal(w.solver.jointInfo()[slot*4+3],0);
      replacement.remove();const fresh=w.addWorldJoint(a,{anchorWorld:[0,0,0],anchorBody:[0,.5,0],policy:'inertial-hard'});
      w.step();await w.read();assert.equal(fresh.slot,slot);assert.equal(w.solver.jointInfo()[slot*4+3],1);
      assert.ok(error(a,[0,.5,0],[0,0,0])<=.001);
      assert.ok([...a.position,...b.position,...a.velocity,...b.velocity].every(Number.isFinite));
    } finally {w.destroy();}
  }
}));
