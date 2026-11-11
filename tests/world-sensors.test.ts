// CPU recording only: real World and solver command ownership, never physics proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { convexHull } from '../src/avbd3d/shapes.ts';
import { BEGIN, END } from '../src/lib/contacts.ts';
import { MAX_BODY_ID } from '../src/lib/identity.ts';
import { BODY_AUX_FLOATS } from '../src/avbd3d/gpu/layout.ts';
import type { StorageLimits } from '../src/lib/storage-budget.ts';
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
interface FakeBuffer { label: string; size: number; destroyed: boolean }
interface Write { buffer: FakeBuffer; offset: number; bytes: Uint8Array }

function fakeDevice() {
  const buffers: FakeBuffer[] = [];
  const writes: Write[] = [];
  const counts = { bindGroups: 0, pipelines: 0 };
  const device: Any = {
    limits: { maxStorageBuffersPerShaderStage: 8, ...LIMITS },
    features: new Set<string>(),
    lost: new Promise(() => undefined),
    queue: {
      writeBuffer(buffer: FakeBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) {
        const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        const unit = (view as Any).BYTES_PER_ELEMENT ?? 1;
        const all = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        writes.push({ buffer, offset, bytes: all.slice(dataOffset * unit, size === undefined ? undefined : (dataOffset + size) * unit) });
      },
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
    createBuffer(desc: GPUBufferDescriptor) {
      const b: Any = { label: desc.label ?? '', size: desc.size, usage: desc.usage, destroyed: false, destroy() { b.destroyed = true; }, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {}, mapAsync: () => new Promise(() => undefined) };
      buffers.push(b);
      return b;
    },
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) { return { label: desc.label, entries: [...desc.entries] }; },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) { return { bindGroupLayouts: [...desc.bindGroupLayouts] }; },
    createShaderModule(desc: GPUShaderModuleDescriptor) { return { code: desc.code }; },
    createComputePipeline(desc: Any) {
      counts.pipelines++;
      return { label: desc.label, layout: desc.layout, getBindGroupLayout: () => ({ auto: true }) };
    },
    createBindGroup(desc: Any) { counts.bindGroups++; return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createQuerySet() { return { destroy() {} }; },
    createCommandEncoder() {
      return {
        clearBuffer() {}, copyBufferToBuffer() {}, resolveQuerySet() {}, finish: () => ({}),
        beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {} }),
      };
    },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device: device as GPUDevice, buffers, writes, counts };
}

type Fake = ReturnType<typeof fakeDevice>;

const auxBuffer = (fake: Fake) => fake.buffers.find((b) => b.label === 'body aux')!;
const auxWrites = (fake: Fake, from = 0) => fake.writes.slice(from).filter((w) => w.buffer === auxBuffer(fake));
const f32 = (bytes: Uint8Array) => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];


/** Slot → whole aux record (scale, linear, angular, reserved) for each aux write since `from`. */
function auxRecords(fake: Fake, from: number): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const w of auxWrites(fake, from)) {
    const v = f32(w.bytes);
    assert.equal(w.offset % 16, 0, 'whole records');
    assert.equal(v.length % BODY_AUX_FLOATS, 0, 'whole records');
    for (let k = 0; k < v.length / 4; k++) out.set(w.offset / 16 + k, v.slice(4 * k, 4 * k + 4));
  }
  return out;
}


const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;
async function world(fixed = false, limit = 8) {
  const fake = fakeDevice();
  (fake.device.limits as Any).maxStorageBuffersPerShaderStage = limit;
  const w = await World.create({ device: fake.device, maxBodies: 16, ...(fixed ? { storage: FIXED } : {}) });
  return { fake, w };
}
function cube() {
  const points = [-.5,.5].flatMap(x => [-.5,.5].flatMap(y => [-.5,.5].flatMap(z => [x,y,z])));
  return convexHull(points)!;
}

test('sensor defaults are inert; strict errors precede IDs, slots, metadata and setup', async () => {
  const { w, fake } = await world();
  let initial = fake.counts.pipelines;
  const a = w.addBox({size:[1,1,1]})!;
  assert.equal(a.sensor, false);
  w.flushCommands();
  assert.equal(w.solver.nativeSensorsActive,false);
  assert.equal((w.solver as Any).pipes.prepareSensors,undefined);
  initial = fake.counts.pipelines;
  const writes = fake.writes.length;
  for (const sensor of [null, 0, 1, 'true', {}, []]) {
    assert.throws(() => w.addSphere({radius:.5, sensor: sensor as Any}), /sensor must be boolean/);
    assert.throws(() => a.setSensor(sensor as Any), /sensor must be boolean/);
  }
  assert.throws(() => a.setSensor(undefined as Any), /sensor must be boolean/);
  assert.throws(() => w.addBox({size:[1,1,1],sensor:true,massProperties:{mass:-1,moments:[1,1,1]}}));
  assert.throws(() => w.addBox({size:[1,1,1],sensor:true,velocity:[NaN,0,0]}));
  w.flushCommands();
  assert.equal(fake.writes.length, writes);
  assert.equal(fake.counts.pipelines, initial);
  const b = w.addSphere({radius:.5,sensor:undefined})!;
  assert.equal(b.id, a.id+1);
  assert.equal(b.index,a.index+1);
  assert.equal((w as Any).contactWatch,null);
  w.destroy();
});

test('queued sensor flags precede first step; xyz, resets, masked fixed/pose/velocity edits and lifecycle retain intent', async () => {
  const { w, fake } = await world();
  const a = w.addBox({size:[1,1,1],sensor:true,gravityScale:2,damping:{linear:3,angular:4},group:0x80000000,collidesWith:0xffffffff})!;
  assert.equal(a.sensor,true);
  assert.equal(a.reportContacts,false);
  assert.equal(w.solver.nativeSensorsActive,true);
  w.flushCommands();
  assert.equal((w.solver as Any).sensorFlags[a.index],1);
  a.reset({position:[2,0,0]});
  a.setFixed(true); a.moveTo([3,0,0]); a.set({velocity:[1,0,0],angularVelocity:[0,1,0]});
  a.setEnabled(false);w.flushCommands();
  assert.equal((w.solver as Any).sensorFlags[a.index],1);
  a.setEnabled(true);a.setDamping({linear:5,angular:6});
  const from=fake.writes.length; w.flushCommands();
  assert.deepEqual(auxRecords(fake,from).get(a.index),[2,5,6,1]);
  assert.equal(a.group,0x80000000);assert.equal(a.collidesWith,0xffffffff);
  a.setSensor(false);assert.equal(a.sensor,false);w.flushCommands();
  assert.equal((w.solver as Any).sensorFlags[a.index],0);
  a.setSensor(true);w.step();w.step();
  // Adaptive reset/mover helpers have now been created; subsequent stepping stays allocation-free.
  const after={...fake.counts,buffers:fake.buffers.length};
  for(let i=0;i<4;i++)w.step();
  assert.deepEqual({...fake.counts,buffers:fake.buffers.length},after);
  assert.equal((w as Any).contactWatch,null);
  w.destroy();
});

test('full replacement restores current flags, new lives default false, removed setter never touches former slot', async () => {
  const { w, fake }=await world();
  const a=w.addSphere({radius:.5,sensor:true})!;w.flushCommands();
  (w as Any).stage(a.index,a);w.flushCommands();
  assert.equal((w.solver as Any).sensorFlags[a.index],1);
  a.remove();w.flushCommands();
  assert.equal((w.solver as Any).sensorFlags[a.index],0);
  const b=w.addBox({size:[1,1,1]})!;w.flushCommands();
  assert.equal(b.index,a.index);assert.notEqual(b.id,a.id);assert.equal(b.sensor,false);
  const from=fake.writes.length;
  a.setSensor(false);a.setSensor(true);w.flushCommands();
  assert.equal(fake.writes.length,from);assert.equal(b.sensor,false);
  assert.throws(()=>a.setSensor(null as Any),TypeError);
  w.destroy();assert.throws(()=>a.setSensor(false),/destroyed/i);
});

test('authored and uploaded fallback hulls refuse activation without flushing; activated lifetime refuses fallback', async () => {
  const { w, fake }=await world();
  const hull=w.addHull({shape:cube(),group:0,collidesWith:0})!;
  const before=fake.writes.length;
  assert.throws(()=>w.addSphere({radius:.5,sensor:true}),/fallback hulls/);
  assert.equal(fake.writes.length,before);assert.equal(w.solver.nativeSensorsActive,false);
  w.flushCommands();hull.remove();
  assert.throws(()=>w.addSphere({radius:.5,sensor:true}),/native hulls/);
  w.flushCommands();
  const a=w.addSphere({radius:.5,sensor:true})!;a.setSensor(false);
  assert.throws(()=>w.addHull({shape:cube()}),/fallback hulls/);
  assert.throws(()=>w.solver.setCollisionBackend({prepare(){throw Error('must not prepare');}} as Any),/Native sensors/);
  w.destroy();
});

test('SDF preparing race and custom backends refuse true intent; SDF enable guard precedes preparation/flush', async () => {
  const {w,fake}=await world();const a=w.addBox({size:[1,1,1]})!;
  const before=fake.writes.length;
  (w as Any).sdfState='preparing';
  assert.throws(()=>a.setSensor(true),/standard collisions/);
  const pool=await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5,sensor:true}}});
  assert.deepEqual(pool,{ok:false,reason:'fixed-storage-required'});
  assert.equal(a.sensor,false);assert.equal(fake.writes.length,before);
  (w as Any).sdfState='off';
  const backend={prepare(){},destroy(){}} as Any;w.solver.setCollisionBackend(backend);
  assert.equal(w.capabilities.sensors,false);assert.throws(()=>a.setSensor(true),/standard collisions/);
  w.solver.setCollisionBackend(null);a.setSensor(true);
  await assert.rejects(w.enableSdfCollisions(),/Native sensors/);
  assert.equal((w as Any).sdfState,'off');assert.equal(fake.writes.length,before);
  w.destroy();
});

test('native hull capability and admission use negotiated geometry; exhausted ID/capacity never activates',async()=>{
  const {w}=await world(false,9);w.addHull({shape:cube()});w.addSphere({radius:.5,sensor:true});w.flushCommands();
  assert.equal(w.capabilities.sensors,true);assert.equal(w.capabilities.hullCollisions,'native');w.destroy();
  const x=await world();(x.w as Any).bodyIds.next=MAX_BODY_ID+1;
  assert.throws(()=>x.w.addSphere({radius:.5,sensor:true}),/IDs exhausted/);
  assert.equal(x.w.solver.nativeSensorsActive,false);x.w.destroy();
  const y=await world();for(let i=0;i<16;i++)y.w.addSphere({radius:.5});
  assert.equal(y.w.addSphere({radius:.5,sensor:true}),null);assert.equal(y.w.solver.nativeSensorsActive,false);y.w.destroy();
});

test('pending read keeps captured sensor lifetimes and end-before-begin, never the replacement or its current flag',async()=>{
 const {w}=await world();const a=w.addBox({size:[1,1,1],sensor:true,reportContacts:true})!;
 const b=w.addSphere({radius:.5})!;w.flushCommands();
 (w as Any).readBodies=async()=>{};
 let complete!:(value:Any)=>void;
 (w as Any).contactWatch.read=()=>new Promise(resolve=>{complete=resolve;});
 const received:Any[]=[];w.onContact(e=>received.push(e));
 const pending=w.read();a.remove();const replacement=w.addBox({size:[1,1,1]})!;
 a.setSensor(false);replacement.setSensor(true);
 complete({events:[{kind:BEGIN,step:2,a:a.id,b:b.id,point:[0,0,0],normal:[1,0,0],impulse:0},{kind:END,step:2,a:a.id,b:b.id,point:[0,0,0],normal:[0,0,0],impulse:0}],dropped:3,full:false});
 await pending;
 assert.deepEqual(received.map(e=>e.type),['end','begin']);
 assert.ok(received.every(e=>e.a===a && e.b===b));
 assert.notEqual(replacement.id,a.id);assert.equal(w.droppedContactEvents,3);
 w.destroy();
});

test('custom shader/proof availability and activation failures refuse authored changes before ownership',async()=>{
 const {w,fake}=await world();const a=w.addSphere({radius:.5})!;
 (w.solver as Any).sensorProof=true;assert.equal(w.capabilities.sensors,false);
 assert.throws(()=>a.setSensor(true),/standard collisions/);(w.solver as Any).sensorProof=false;
 (w.solver as Any).customShaders=true;assert.equal(w.capabilities.sensors,false);
 assert.throws(()=>a.setSensor(true),/standard collisions/);(w.solver as Any).customShaders=false;
 const create=fake.device.createComputePipeline;fake.device.createComputePipeline=()=>{throw Error('setup failure');};
 const stats=w.bodyStats;
 assert.throws(()=>w.addSphere({radius:.5,sensor:true}),/setup failure/);
 assert.deepEqual(w.bodyStats,stats);assert.equal(w.solver.nativeSensorsActive,false);
 assert.equal(a.sensor,false);fake.device.createComputePipeline=create;
 a.setSensor(true);assert.equal(a.sensor,true);w.destroy();
});

test('actual asynchronous SDF setup enters preparing before a competing true setter can mutate intent',async()=>{
 const {w,fake}=await world();const body=w.addSphere({radius:.5})!;
 const setup=w.enableSdfCollisions();
 assert.equal((w as Any).sdfState,'preparing');
 const writes=fake.writes.length,stats=w.bodyStats;
 assert.throws(()=>body.setSensor(true),/standard collisions/);
 assert.equal(body.sensor,false);assert.equal(w.solver.nativeSensorsActive,false);
 assert.deepEqual(w.bodyStats,stats);assert.equal(fake.writes.length,writes);
 // Stop before bridge creation: exercises the real async transaction, no real GPU required.
 w.destroy();await assert.rejects(setup,/destroyed during SDF setup/);
 assert.equal((w as Any).sdfState,'off');
});
