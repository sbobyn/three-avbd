// CPU recording only: real World and solver command ownership, never physics proof.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { convexHull } from '../src/avbd3d/shapes.ts';
import { MAX_BODY_ID } from '../src/lib/identity.ts';
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

test('copied sensor template prewarms once; leases/reset/release/reacquire/ordinary reuse own their flags and IDs',async()=>{
 const {w,fake}=await world(true);
 const options={radius:.5,sensor:true};
 const made=await BodyPool.create(w,{capacity:2,template:{kind:'sphere',options}});assert.ok(made.ok);
 options.sensor=false;const p=made.pool;const resources={...fake.counts,buffers:fake.buffers.length};
 const state={position:[0,0,0],rotation:[0,0,0,1]} as const;
 const acquire=()=>{const r=p.tryAcquire({position:[...state.position],rotation:[...state.rotation]});assert.ok(r.ok);return r.body;};
 const a=acquire();assert.equal(a.sensor,true);w.flushCommands();assert.equal((w.solver as Any).sensorFlags[a.index],1);
 a.setSensor(false);a.reset();w.flushCommands();assert.equal(a.sensor,false);
 p.release(a);w.flushCommands();assert.equal((w.solver as Any).sensorFlags[a.index],0);
 const b=acquire();assert.equal(b.index,a.index);assert.notEqual(b.id,a.id);assert.equal(b.sensor,true);
 w.flushCommands();assert.equal((w.solver as Any).sensorFlags[b.index],1);
 let current=b;
 for(let i=0;i<4;i++){p.release(current);current=acquire();w.step();}
 assert.deepEqual({...fake.counts,buffers:fake.buffers.length},resources);
 p.dispose();w.flushCommands();assert.equal((w.solver as Any).sensorFlags[b.index],0);
 const ordinary=w.addBox({size:[1,1,1]})!;w.flushCommands();assert.equal(ordinary.sensor,false);
 assert.deepEqual(p.tryAcquire({position:[0,0,0],rotation:[0,0,0,1]}),{ok:false,reason:'disposed'});
 w.destroy();
});

test('pool errors are atomic: strict template, capacity, preparing/backend, ID exhaustion and native hull support',async()=>{
 const {w,fake}=await world(true);const before=fake.counts.pipelines;
 for(const bad of [null,1,'true',{}])await assert.rejects(BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5,sensor:bad as Any}}}),/sensor must be boolean/);
 const full=await BodyPool.create(w,{capacity:17,template:{kind:'sphere',options:{radius:.5,sensor:true}}});assert.deepEqual(full,{ok:false,reason:'capacity'});
 assert.equal(w.bodyStats.reserved,0);assert.equal(fake.counts.pipelines,before);
 (w as Any).sdfState='preparing';
 assert.deepEqual(await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5,sensor:true}}}),{ok:false,reason:'unsupported-backend'});
 (w as Any).sdfState='off';
 assert.deepEqual(await BodyPool.create(w,{capacity:1,template:{kind:'hull',shape:cube(),options:{sensor:true}}}),{ok:false,reason:'resource-limit'});
 const r=await BodyPool.create(w,{capacity:1,template:{kind:'box',options:{size:[1,1,1],sensor:true}}});assert.ok(r.ok);
 (w as Any).bodyIds.next=MAX_BODY_ID+1;
 const from=fake.writes.length;
 assert.deepEqual(r.pool.tryAcquire({position:[0,0,0],rotation:[0,0,0,1]}),{ok:false,reason:'id-exhausted'});
 assert.equal(r.pool.stats.available,1);assert.equal(fake.writes.length,from);w.destroy();
});

test('independent pools and ordinary slots never borrow sensor intent; template getter copied as validated',async()=>{
 const {w}=await world(true);let reads=0;
 const on=await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5,get sensor(){return ++reads===1;}}}});assert.ok(on.ok);
 const off=await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5}}});assert.ok(off.ok);
 const state={position:[0,0,0] as [number,number,number],rotation:[0,0,0,1] as [number,number,number,number]};
 const a=on.pool.tryAcquire(state),b=off.pool.tryAcquire(state);assert.ok(a.ok);assert.ok(b.ok);
 assert.equal(a.body.sensor,true);assert.equal(b.body.sensor,false);w.flushCommands();
 assert.deepEqual([a.body,b.body].map(body=>(w.solver as Any).sensorFlags[body.index]),[1,0]);
 a.body.setSensor(false);b.body.setSensor(true);on.pool.release(a.body);off.pool.release(b.body);w.flushCommands();
 const c=on.pool.tryAcquire(state),d=off.pool.tryAcquire(state);assert.ok(c.ok);assert.ok(d.ok);
 assert.equal(c.body.sensor,true);assert.equal(d.body.sensor,false);w.flushCommands();
 on.pool.dispose();off.pool.dispose();w.flushCommands();
 assert.throws(()=>w.solver.setCollisionBackend({prepare(){throw Error('must not run');}} as Any),/Native sensors/);
 w.destroy();
});
