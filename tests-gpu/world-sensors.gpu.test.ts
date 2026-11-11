// STE-3330 LOCAL CANDIDATE: source-frozen BEFORE parent hardware trials. Worker did not run.
// dt=1/64; binary positions; scalar tolerance max(1e-6,abs(expected)*1e-4), q norm 1e-4.
// Matched mask-excluded controls test collision nonresponse, not energy/physical accuracy.
// Detection precedes integration: moving fixed commands below begin at step2/end at step4.
// Upstream overflow screens below use unchanged public storage floors and bounded demand.
// They do not claim collision quality/lossless membership under overflow. No CCD/perf claim.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGpu, skip } from './device.ts';
import { assessAdapter } from '../src/comparison/interlocking-trial.ts';
import { World, type Body, type BodyOptions, type ContactEvent, type Vec3 } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { convexHull } from '../src/avbd3d/shapes.ts';
import { CONTACT_WORDS, K_LAM, K_PEN, K_RA, STICK_BIT } from '../src/avbd3d/gpu/layout.ts';
import { STANDARD_SENSOR_BIT } from '../src/avbd3d/gpu/sensor-preparation.ts';
const DT=1/64;
const FIXED={growth:'fixed',pairs:4096,contacts:8192,manifolds:4096,joints:256,hullVec4s:4096} as const;
const near=(a:number,b:number,why:string)=>assert.ok(Number.isFinite(a)&&Math.abs(a-b)<=Math.max(1e-6,Math.abs(b)*1e-4),`${why}: ${a} vs ${b}`);
function valid(body:Body) {
  assert.ok([...body.position,...body.velocity,...body.angularVelocity,...body.rotation].every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...body.rotation)-1)<=1e-4);
}
function same(a:Body,b:Body) {
  valid(a);valid(b);
  for(const field of ['position','velocity','angularVelocity','rotation'] as const)a[field].forEach((v,i)=>near(v,b[field][i],field+i));
}
const cube=()=>convexHull([-.5,.5].flatMap(x=>[-.5,.5].flatMap(y=>[-.5,.5].flatMap(z=>[x,y,z]))))!;
type Shape='box'|'sphere'|'hull';
function add(w:World,shape:Shape,options:BodyOptions):Body {
  return (shape==='box'?w.addBox({size:[1,1,1],...options}):shape==='sphere'?w.addSphere({radius:.5,...options}):w.addHull({shape:cube(),...options}))!;
}
async function world(device:GPUDevice,extra:Partial<Parameters<typeof World.create>[0]>={}) {
  return World.create({device,maxBodies:8,gravity:[0,0,0],dt:DT,...extra});
}
async function hardware(t:{diagnostic(s:string):void;skip(s:string):void},limit:8|9,run:(device:GPUDevice)=>Promise<void>) {
  const adapter=await createGpu().requestAdapter();
  if(!adapter){t.skip('no adapter');return;}
  const assessment=assessAdapter(adapter.info,(adapter as GPUAdapter & {isFallbackAdapter?:boolean}).isFallbackAdapter);
  assert.equal(assessment.ok,true,'qualified actual hardware required; never software fallback');
  if(adapter.limits.maxStorageBuffersPerShaderStage<limit){t.skip('native hull device limit unavailable');return;}
  const device=await adapter.requestDevice({requiredLimits:{maxStorageBuffersPerShaderStage:limit}});
  const errors:string[]=[];device.onuncapturederror=e=>errors.push(e.error.message);
  t.diagnostic(JSON.stringify({assessment,limit,adapter:adapter.info.description,at:new Date().toISOString()}));
  try {
    assert.equal(device.limits.maxStorageBuffersPerShaderStage,limit);
    device.pushErrorScope('validation');await run(device);await device.queue.onSubmittedWorkDone();
    assert.equal(await device.popErrorScope(),null);assert.deepEqual(errors,[]);
  }finally{device.destroy();}
}
async function rawZero(device:GPUDevice,w:World) {
  const counters=await w.solver.readCounters();assert.equal(counters.overflow,0);
  assert.ok(counters.manifolds>0);assert.ok(counters.contacts>0);
  const size=counters.contacts*CONTACT_WORDS*4;
  const read=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  try {
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(w.solver.contactStorage.contacts,0,read,0,size);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const data=read.getMappedRange();const f=new Float32Array(data),u=new Uint32Array(data);
    for(let k=0;k<counters.contacts;k++) {
      const o=k*CONTACT_WORDS;assert.equal(u[o+K_RA+3]&STANDARD_SENSOR_BIT,STANDARD_SENSOR_BIT);assert.equal(u[o+K_RA+3]&STICK_BIT,0);
      assert.deepEqual([...f.slice(o+K_LAM,o+K_LAM+3)],[0,0,0]);assert.deepEqual([...f.slice(o+K_PEN,o+K_PEN+3)],[0,0,0]);
    }
  }finally{read.destroy();}
}

for(const limit of [8,9] as const)test(`public native ${limit}-storage geometry/roles/reporting/zero-iteration matrix`,{skip},async t=>{
 await hardware(t,limit,async device=>{
  const pairs: [Shape,Shape][]=[['box','sphere'],['box','box'],['sphere','sphere'],...(limit===9?[['hull','box'],['hull','sphere'],['hull','hull']] as [Shape,Shape][]:[])];
  for(const [left,right] of pairs)for(const endpoint of [0,1,2])for(const report of [false,true])for(const iterations of [0,4])for(const fixed of [false,true]) {
   const a=await world(device,{iterations}),b=await world(device,{iterations});
   try {
    const opts=(i:number,control:boolean):BodyOptions=>({position:[i? .375:-.375,0,0],velocity:[i?-1:fixed?0:1,0,0],fixed:i===0&&fixed,sensor:!control&&(endpoint===2||endpoint===i),reportContacts:report&&i===0,...(control?{collidesWith:0}:{})});
    const actual=[add(a,left,opts(0,false)),add(a,right,opts(1,false))];
    const control=[add(b,left,opts(0,true)),add(b,right,opts(1,true))];
    const events:ContactEvent[]=[];a.onContact(e=>events.push(e));
    for(let step=1;step<=16;step++) {
      a.step({reuseManifolds:true});b.step({reuseManifolds:true});await a.read();await b.read();
      actual.forEach((body,i)=>{same(body,control[i]);near(body.position[0],(i?.375:-.375)+(i?-1:fixed?0:1)*step*DT,'analytic coasting');});
      if(step===1)await rawZero(device,a);
    }
    assert.deepEqual(events.map(e=>[e.type,e.step,e.impulse]),report?[['begin',1,0]]:[]);
   }finally{a.destroy();b.destroy();}
  }
 });
});

test('public moving fixed translation/rotation through moveTo and prescribed velocities: exact detect steps', {skip},async t=>{
 await hardware(t,8,async device=>{
  for(const rotation of [false,true])for(const drive of ['moveTo','velocity'] as const) {
   const w=await world(device);const events:ContactEvent[]=[];w.onContact(e=>events.push(e));
   try {
    const sensor=w.addBox({size:rotation?[4,.5,.5]:[1,1,1],fixed:true,sensor:true,reportContacts:true,position:rotation?[0,0,0]:[-2,0,0]})!;
    const ball=w.addSphere({radius:1/8,position:rotation?[0,1,0]:[0,0,0]})!;
    const target:Vec3=[0,0,0],q:[number,number,number,number]=[0,0,Math.SQRT1_2,Math.SQRT1_2];
    // Translation: -2 -> 0 -> 2; rotation: identity -> 90deg z -> identity.
    // normalized Euler qadd maps omega.z=2/dt to 90deg in one step (body-mover.ts).
    const command=(inside:boolean)=>{
      if(drive==='moveTo')sensor.moveTo(rotation?target:inside?target:[2,0,0],rotation?(inside?q:[0,0,0,1]):undefined);
      else sensor.set(rotation?{angularVelocity:[0,0,(inside?2:-2)/DT]}:{velocity:[2/DT,0,0]});
    };
    command(true);w.step();await w.read();assert.equal(events.length,0);
    if(drive==='velocity')sensor.set({velocity:[0,0,0],angularVelocity:[0,0,0]});
    w.step();await w.read();assert.deepEqual(events.map(e=>[e.type,e.step]),[['begin',2]]);
    command(false);w.step();await w.read();
    if(drive==='velocity')sensor.set({velocity:[0,0,0],angularVelocity:[0,0,0]});
    w.step();await w.read();assert.deepEqual(events.map(e=>[e.type,e.step,e.impulse]),[['begin',2,0],['end',4,0]]);
    assert.deepEqual(ball.position,rotation?[0,1,0]:[0,0,0]);valid(sensor);valid(ball);
   }finally{w.destroy();}
  }
 });
});

test('public dynamic sensor gravity/damping/forces/impulses and constraints retain matched noncollision control', {skip},async t=>{
 await hardware(t,8,async device=>{
  for(const constraint of ['none','joint','spring'] as const) {
   const a=await world(device,{gravity:[0,-1,0]}),b=await world(device,{gravity:[0,-1,0]});
   try {
    const scene=(w:World,control:boolean)=>{
      const body=w.addSphere({radius:.5,sensor:!control,position:[0,.375,0],velocity:[1,0,0],angularVelocity:[0,.5,0],gravityScale:2,damping:{linear:1,angular:1},collidesWith:control?0:0xffffffff})!;
      const anchor=w.addBox({size:[1,1,1],fixed:true,reportContacts:true})!;
      if(constraint==='joint')w.addJoint(anchor,body,{type:'ball'});
      if(constraint==='spring')w.addSpring(anchor,body,{stiffness:8,rest:.5});
      body.applyForce([1,0,0]);body.applyImpulse([.125,0,0]);body.applyAngularImpulse([0,.03125,0]);
      return body;
    };
    const actual=scene(a,false),control=scene(b,true);
    for(let step=1;step<=16;step++){a.step();b.step();await a.read();await b.read();same(actual,control);}
    assert.ok(Math.abs(actual.velocity[0]-1)>1e-4,'external effects acted');
    if(constraint!=='none')assert.equal((await a.solver.readCounters()).manifolds,0,'existing connected-pair exclusion');
   }finally{a.destroy();b.destroy();}
  }
 });
});

test('public sensor toggle/reset/disable/identity reuse/pending read preserve event membership and IDs', {skip},async t=>{
 await hardware(t,8,async device=>{
  const w=await world(device);const events:ContactEvent[]=[];w.onContact(e=>events.push(e));
  try {
   w.addBox({size:[1,1,1],fixed:true,reportContacts:true});
   const old=w.addSphere({radius:.5,position:[0,.75,0]})!;
   w.step();await w.read();assert.ok((await w.solver.readContactList()).some(c=>c.pen.some(v=>v>0)));
   old.setSensor(true);old.reset({position:[0,.75,0]});w.step();await w.read();await rawZero(device,w);
   assert.deepEqual(events.map(e=>e.type),['begin'],'toggle/reset retains membership');
   old.setEnabled(false);w.step();await w.read();old.setEnabled(true);w.step();await w.read();
   assert.deepEqual(events.map(e=>[e.type,e.step]),[['begin',1],['end',3],['begin',4]]);
   const pending=w.read();old.remove();const next=w.addSphere({radius:.5,position:[0,.75,0],sensor:true})!;
   assert.equal(next.index,old.index);assert.notEqual(next.id,old.id);await pending;
   w.step();await w.read();
   assert.deepEqual(events.slice(-2).map(e=>[e.type,e.step]),[['end',5],['begin',5]]);
   assert.ok([events[0].a,events[0].b].includes(old));assert.ok([events.at(-1)!.a,events.at(-1)!.b].includes(next));
   next.setSensor(false);w.step();await w.read();assert.ok((await w.solver.readContactList()).some(c=>c.pen.some(v=>v>0)));
  }finally{w.destroy();}
 });
});

test('public pool template/lease flags, release/newID and exact event-buffer loss', {skip},async t=>{
 await hardware(t,8,async device=>{
  const w=await world(device,{storage:FIXED,maxContactEvents:1});const events:ContactEvent[]=[];w.onContact(e=>events.push(e));
  try {
   w.addBox({size:[1,1,1],fixed:true,reportContacts:true});
   const made=await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5,sensor:true}}});assert.ok(made.ok);
   const acquire=()=>{const r=made.pool.tryAcquire({position:[0,.75,0],rotation:[0,0,0,1]});assert.ok(r.ok);return r.body;};
   const first=acquire();w.step();await w.read();await rawZero(device,w);
   first.setSensor(false);first.reset({position:[0,.75,0]});made.pool.release(first);w.step();await w.read();
   const second=acquire();assert.equal(second.sensor,true);assert.notEqual(first.id,second.id);w.step();await w.read();await rawZero(device,w);
   second.setEnabled(false);w.step();second.setEnabled(true);w.step();
   await w.read();assert.equal(w.droppedContactEvents,1,'one end retained, one begin dropped before read');
   made.pool.dispose();w.flushCommands();
   await assert.rejects(w.enableSdfCollisions(),/fixed|Native sensors/);
  }finally{w.destroy();}
 });
});

test('public tiny watch set loss is observable and bounded; fixed-fixed and bit31 filtering unchanged', {skip},async t=>{
 await hardware(t,8,async device=>{
  const w=await world(device,{maxBodies:80,storage:FIXED,maxContactPairs:1,maxContactEvents:128});
  try {
   w.addBox({size:[128,4,4],fixed:true,sensor:true,reportContacts:true,group:0x80000000,collidesWith:1});
   // watchSlots(1)=64; 65 disjoint balls fill it regardless of insertion order.
   for(let k=0;k<65;k++)w.addSphere({radius:.125,position:[k-32,0,0],group:1,collidesWith:0x80000000});
   w.step();await w.read();assert.equal(w.contactSetOverflows,1);assert.equal(w.droppedContactEvents,0);
   // Set overflow is not a promise about which pair survives. Upstream capacity did not overflow.
   assert.equal((await w.solver.readCounters()).overflow,0);
  }finally{w.destroy();}
  const x=await world(device);const events:ContactEvent[]=[];x.onContact(e=>events.push(e));
  try {
   x.addBox({size:[1,1,1],fixed:true,sensor:true,reportContacts:true});
   x.addSphere({radius:.5,fixed:true});x.addSphere({radius:.5,collidesWith:0});
   x.step();await x.read();assert.equal(events.length,0);assert.equal((await x.solver.readCounters()).manifolds,0);
  }finally{x.destroy();}
 });
});

test('public default bodies and explicit sensor:false have identical ordinary response', {skip},async t=>{
 await hardware(t,8,async device=>{
  const a=await world(device),b=await world(device);
  try {
   const create=(w:World,explicit:boolean)=>{w.addBox({size:[4,1,4],fixed:true});return w.addSphere({radius:.5,position:[0,.75,0],...(explicit?{sensor:false}:{})})!;};
   const first=create(a,false),second=create(b,true);
   for(let i=0;i<16;i++){a.step();b.step();}await a.read();await b.read();
   assert.deepEqual(first.position,second.position);assert.deepEqual(first.velocity,second.velocity);
   assert.equal(a.solver.nativeSensorsActive,false);assert.equal(b.solver.nativeSensorsActive,false);
  }finally{a.destroy();b.destroy();}
 });
});

// These bounded overflow screens assert observability and valid poses only, not surviving
// membership/geometry quality. Identical stationary sensor spheres avoid response explosions.
for(const resource of ['pairs','manifolds','contacts'] as const)test(`public fixed upstream ${resource} overflow is observable without GPU OOB`,{skip},async t=>{
 await hardware(t,8,async device=>{
  const storage={...FIXED,...(resource==='manifolds'?{pairs:16384,contacts:65536}:resource==='contacts'?{pairs:16384,manifolds:16384}:{})};
  const w=await world(device,{maxBodies:130,iterations:0,storage});
  try {
   for(let i=0;i<130;i++)w.addSphere({radius:.5,sensor:true});
   w.step();await w.read();
   const counters=await w.solver.readCounters();assert.equal(counters.overflow & (resource==='pairs'?1:resource==='contacts'?2:4),resource==='pairs'?1:resource==='contacts'?2:4);
   for(const body of w.bodies){valid(body);body.position.forEach(v=>near(v,0,'stationary overflow pose'));}
  }finally{w.destroy();}
 });
});

test('public native hull pool prewarm/replacement and release keep exact sensor geometry', {skip},async t=>{
 await hardware(t,9,async device=>{
  const w=await world(device,{storage:FIXED});
  try {
   w.addBox({size:[1,1,1],fixed:true,reportContacts:true});
   const made=await BodyPool.create(w,{capacity:1,template:{kind:'hull',shape:cube(),options:{sensor:true}}});assert.ok(made.ok);
   for(let k=0;k<3;k++) {
    const lease=made.pool.tryAcquire({position:[0,.75,0],rotation:[0,0,0,1]});assert.ok(lease.ok);
    w.step();await w.read();await rawZero(device,w);valid(lease.body);
    lease.body.reset({position:[0,.75,0]});w.step();await w.read();await rawZero(device,w);
    made.pool.release(lease.body);w.step();await w.read();
   }
   made.pool.dispose();
  }finally{w.destroy();}
 });
});

// Public equivalent of §§9/18: incoming x=-2 at 2 m/s; detect positions use (step-1)/32.
// Inclusive tangency at x=-.625 and +.625 gives begin45/end86, before any trial.
for(const limit of [8,9] as const)test(`public ${limit}-storage frozen transit: begin45/end86, endpoint order/report/iterations0`,{skip},async t=>{
 await hardware(t,limit,async device=>{
  for(const arm of [{swap:false,report:'sensor',iterations:4},{swap:true,report:'partner',iterations:4},{swap:false,report:'none',iterations:4},{swap:false,report:'sensor',iterations:0}]) {
   const w=await world(device,{iterations:arm.iterations});const events:ContactEvent[]=[];w.onContact(e=>events.push(e));
   try {
    const trigger=()=>limit===9?w.addHull({shape:cube(),fixed:true,sensor:true,reportContacts:arm.report==='sensor'})!:w.addBox({size:[1,4,4],fixed:true,sensor:true,reportContacts:arm.report==='sensor'})!;
    const moving=()=>w.addSphere({radius:1/8,position:[-2,0,0],velocity:[2,0,0],reportContacts:arm.report==='partner'})!;
    let sensor:Body,ball:Body;
    if(arm.swap){ball=moving();sensor=trigger();}else{sensor=trigger();ball=moving();}
    for(let step=1;step<=128;step++) {
     w.step({reuseManifolds:true});await w.read();valid(sensor);valid(ball);
     near(ball.position[0],-2+step/32,'frozen transit x');near(ball.velocity[0],2,'frozen transit vx');
     const c=await w.solver.readCounters();assert.equal(c.overflow,0);assert.equal(c.manifolds,step>=45&&step<=85?1:0);
     if(step>=45&&step<=85)await rawZero(device,w);
    }
    assert.deepEqual(events.map(e=>[e.type,e.step,e.impulse]),arm.report==='none'?[]:[['begin',45,0],['end',86,0]]);
    for(const event of events)assert.deepEqual([event.a.id,event.b.id],[2,1],'existing descending slot endpoint order');
   }finally{w.destroy();}
  }
 });
});
