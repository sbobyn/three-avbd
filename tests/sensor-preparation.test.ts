// Recording fakes prove encoding/ownership, never physical nonresponse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { sphere, sail, hull, convexHull } from '../src/avbd3d/shapes.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { BODY_FLOATS, CONTACT_WORDS, MANIFOLD_WORDS, K_RA, B_INITIAL_POS, BODY_DIRTY, BODY_DISABLED, BODY_COLD, PRELUDE_3D, FLAG_REUSE_CONTACTS } from '../src/avbd3d/gpu/layout.ts';
import { IA_CONTACTS } from '../src/avbd2d/gpu/layout.ts';
import { solveWGSL, solveBodyAuxWGSL, sensorProofSolveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { contactsWGSL, contactsHullWGSL, sensorProofContactsWGSL } from '../src/avbd3d/gpu/wgsl-collision.ts';
import { sensorPreparationWGSL } from '../src/avbd3d/gpu/sensor-preparation.ts';
import { resolveFixedStorage, type StorageLimits } from '../src/lib/storage-budget.ts';
const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

interface FakeBuffer { label: string; size: number; usage: number; destroyed: boolean; destroy(): void }
interface Write { buffer: FakeBuffer; offset: number; bytes: Uint8Array }
type Call = ['pipeline', Any] | ['group', number, Any, number[]] | ['dispatch', number?];

function fakeDevice(options: { storage?: number; failPipeline?: string; failSensorGroup?: number } = {}) {
  let sensorGroups = 0;
  const buffers: FakeBuffer[] = [];
  const writes: Write[] = [];
  const passes: Call[][] = [];
  const layouts: Any[] = [];
  const pipelines: Any[] = [];
  const bindGroups: Any[] = [];
  const device: Any = {
    limits: { maxStorageBuffersPerShaderStage: options.storage ?? 8, ...LIMITS },
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
    createBindGroupLayout(desc: GPUBindGroupLayoutDescriptor) { const l = { label: desc.label, entries: [...desc.entries] }; layouts.push(l); return l; },
    createPipelineLayout(desc: GPUPipelineLayoutDescriptor) { return { bindGroupLayouts: [...desc.bindGroupLayouts] }; },
    createShaderModule(desc: GPUShaderModuleDescriptor) { return { code: desc.code }; },
    createComputePipeline(desc: Any) {
      if (options.failPipeline !== undefined && desc.label === options.failPipeline) throw new Error(`fake: ${desc.label} refused`);
      const auto = new Map<number, Any>();
      const p = { label: desc.label, layout: desc.layout, module: desc.compute.module, entryPoint: desc.compute.entryPoint, getBindGroupLayout(i: number) { if (!auto.has(i)) auto.set(i, { auto: true }); return auto.get(i); } };
      pipelines.push(p);
      return p;
    },
    createBindGroup(desc: Any) { if (desc.layout.label === 'sensor preparation' && ++sensorGroups === options.failSensorGroup) throw new Error('fake: sensor parity refused'); if (desc.layout.label === 'sensor preparation' && options.failPipeline === 'sensor binding') throw new Error('fake: sensor binding refused'); bindGroups.push(desc); return desc; },
    createQuerySet() { return { destroy() {} }; },
    createCommandEncoder() {
      return {
        clearBuffer() {}, copyBufferToBuffer() {}, resolveQuerySet() {}, finish: () => ({}),
        beginComputePass() {
          const calls: Call[] = [];
          passes.push(calls);
          return {
            setPipeline(p: Any) { calls.push(['pipeline', p]); },
            setBindGroup(i: number, group: Any, offsets?: Uint32Array | number[], start = 0, length?: number) {
              const list = offsets === undefined ? [] : offsets instanceof Uint32Array ? [...offsets.subarray(start, start + (length ?? offsets.length - start))] : [...offsets];
              calls.push(['group', i, group, list]);
            },
            dispatchWorkgroups() { calls.push(['dispatch']); },
            dispatchWorkgroupsIndirect(_buffer: GPUBuffer, offset: number) { calls.push(['dispatch', offset]); },
            end() {},
          };
        },
      };
    },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device: device as GPUDevice, buffers, writes, passes, layouts, pipelines, bindGroups };
}

type Fake = ReturnType<typeof fakeDevice>;

/** Replay a pass as WebGPU validates a dispatch: every group the pipeline's layout has is bound with that layout. */
function dispatches(calls: Call[]): { name: string; groups: Any[]; offsets: number[][] }[] {
  let pipeline: Any = null;
  const groups: Any[] = [];
  const offsets: number[][] = [];
  const out: { name: string; groups: Any[]; offsets: number[][] }[] = [];
  for (const call of calls) {
    if (call[0] === 'pipeline') pipeline = call[1];
    else if (call[0] === 'group') { groups[call[1]] = call[2]; offsets[call[1]] = call[3]; }
    else {
      assert.ok(pipeline, 'a pipeline is set');
      const want = pipeline.layout === 'auto' ? [0].map((i) => pipeline.getBindGroupLayout(i)) : pipeline.layout.bindGroupLayouts;
      want.forEach((layout: Any, i: number) => {
        assert.ok(groups[i], `${pipeline.label}: group ${i} bound`);
        assert.equal(groups[i].layout, layout, `${pipeline.label}: group ${i} matches its layout`);
        const dynamic = (layout.entries ?? []).filter((e: Any) => e.buffer?.hasDynamicOffset).length;
        assert.equal(offsets[i].length, dynamic, `${pipeline.label}: group ${i} dynamic offsets`);
      });
      out.push({ name: pipeline.label, groups: [...groups], offsets: offsets.map((o) => [...(o ?? [])]) });
    }
  }
  return out;
}

const auxBuffer = (fake: Fake) => fake.buffers.find((b) => b.label === 'body aux')!;
const auxWrites = (fake: Fake, from = 0) => fake.writes.slice(from).filter((w) => w.buffer === auxBuffer(fake));
const f32 = (bytes: Uint8Array) => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];

function scene(): Solver {
  const ref = new Solver();
  new Rigid(ref, [10, 1, 10], 0, 0.5, [0, -0.5, 0]);
  for (let i = 0; i < 3; i++) new Rigid(ref, [0.5, 0.5, 0.5], 1, 0.5, [i * 2, 2, 0]);
  return ref;
}

const proof = { sensorProof: true, hulls: false, spatialSort: false, bodyCapacity: 8 } as const;
test('strict constructor refusal precedes every allocation', () => {
  for (const options of [{sensorProof: null}, {sensorProof: 1}, {sensorProof: true}, {...proof, hulls: true}, {...proof, shaders: {}}, {...proof, shaders: {solve: solveWGSL}}, {...proof, shaders: {contacts: contactsWGSL}}]) {
    const f = fakeDevice();
    assert.throws(() => new GpuSolver3D(f.device, scene(), options as Any), /sensorProof/);
    assert.equal(f.buffers.length, 0);
    assert.equal(f.writes.length, 0);
  }
});
test('flag batches refuse atomically, copy inputs, preserve aux xyz and lifecycle bits', () => {
  const f = fakeDevice(), gpu = new GpuSolver3D(f.device, scene(), proof);
  for (const [slots, flags] of [[[0, 7], [true, false]], [[0, 1], [true, 1]], [[0, -1], [true, false]], [[0, 1.5], [true, false]], [[0], []], [[1], [true]]] as Any[]) {
    const n = f.writes.length;
    assert.throws(() => gpu.setSensorFlags(slots, flags));
    assert.equal(f.writes.length, n);
    assert.deepEqual([...(gpu as Any).sensorFlags], Array(8).fill(0));
  }
  gpu.setBodyAux([0], [2], [3], [4]);
  gpu.setLifecycle(0, BODY_DISABLED | BODY_COLD);
  const n = f.writes.length;
  const flags = [true]; gpu.setSensorFlags([0], flags); flags[0] = false;
  assert.deepEqual(auxWrites(f,n).map(w => [w.offset, f32(w.bytes)]), [[12,[1]]]);
  const dirty = f.writes.slice(n).find(w => w.buffer.label === 'bodies 3d')!;
  assert.equal(dirty.offset, (B_INITIAL_POS + 3)*4);
  assert.deepEqual(f32(dirty.bytes), [BODY_DIRTY | BODY_DISABLED | BODY_COLD]);
  gpu.setBodyAux([0,1], [5,6]);
  assert.equal(f32(auxWrites(f).at(-1)!.bytes)[3], 1);
  gpu.setBodyAux([0], [2], [3], [4]);
  assert.deepEqual(f32(auxWrites(f).at(-1)!.bytes), [2,3,4,1]);
  const before = f.writes.length;
  gpu.setSensorFlags([0],[true]); assert.equal(f.writes.length,before);
  gpu.setSensorFlags([0],[false]); assert.equal((gpu as Any).manifoldsValid,false);
  gpu.destroy();
  const normal = new GpuSolver3D(f.device,scene());
  assert.throws(() => normal.setSensorFlags([0],[false]), /sensorProof/); normal.destroy();
});
test('backend refusal before prepare, even with every flag false', () => {
  const f=fakeDevice(), gpu=new GpuSolver3D(f.device,scene(),proof);
  let prepared=false;
  const n=f.writes.length;
  assert.throws(()=>gpu.setCollisionBackend({prepare(){prepared=true;}} as Any), /sensorProof/);
  assert.equal(prepared,false); assert.equal(f.writes.length,n); gpu.destroy();
});
test('proof prewarms five-storage parity groups, exact ordering/indirect units; fixed steps allocate nothing', () => {
  const f=fakeDevice();
  const fixed=resolveFixedStorage({maxBodies:8}, {growth:'fixed',pairs:4096,contacts:8192,manifolds:4096,joints:256,hullVec4s:4096},LIMITS);
  const gpu=new GpuSolver3D(f.device,scene(),{...proof,fixed});
  const prep=f.layouts.find(l=>l.label==='sensor preparation');
  assert.deepEqual(prep.entries.map((e:Any)=>e.buffer.type),['uniform','read-only-storage','read-only-storage','read-only-storage','read-only-storage','storage']);
  assert.ok(f.layouts.every(l=>l.entries.filter((e:Any)=>e.buffer?.type!=='uniform').length<=8));
  const gs=f.bindGroups.filter(g=>g.layout===prep); assert.equal(gs.length,2);
  for(let i=0;i<2;i++) assert.deepEqual(gs[i].entries.map((e:Any)=>e.resource.buffer),[(gpu as Any).paramsBuffer,gpu.bodyBuffer,auxBuffer(f),gpu.contactStorages()[i].manifolds,gpu.contactStorages()[i].counters,gpu.contactStorages()[i].contacts]);
  gpu.params.iterations=0;
  const created=[f.buffers.length,f.bindGroups.length,f.pipelines.length];
  for(let i=0;i<4;i++) {
    f.passes.length=0; gpu.step({reuseManifolds:true});
    const ds=f.passes.flatMap(dispatches), names=ds.map(d=>d.name), at=names.indexOf('prepareSensors');
    assert.equal(names[at-1],'argsContacts'); assert.equal(names[at+1],'degreeContacts');
    assert.ok(names.includes('narrowphase')); assert.ok(!names.includes('reuseManifolds')); assert.ok(!names.includes('updateRefs'));
    assert.equal(ds[at].groups[0],gs[i%2]);
    let current=''; for(const c of f.passes.flat()) { if(c[0]==='pipeline')current=c[1].label; if(c[0]==='dispatch'&&current==='prepareSensors') assert.equal(c[1],IA_CONTACTS*4); }
    assert.equal((gpu as Any).paramU32[6]&FLAG_REUSE_CONTACTS,0);
    assert.equal(gpu.params.reuseContacts,true);
    gpu.setSensorFlags([0],[i % 2 === 0]);
    assert.deepEqual([f.buffers.length,f.bindGroups.length,f.pipelines.length],created);
  }
  gpu.destroy(); assert.ok(f.buffers.every(b=>b.destroyed));
});
test('partial proof pipeline/binding failures release owned buffers, keep borrowed bodies', () => {
  for(const failPipeline of ['prepareSensors','sensor binding']) {
    const f=fakeDevice({failPipeline});
    const borrowed=f.device.createBuffer({label:'borrowed',size:8*BODY_FLOATS*4,usage:0}) as unknown as FakeBuffer;
    assert.throws(()=>new GpuSolver3D(f.device,scene(),{...proof,bodyBuffer:borrowed as unknown as GPUBuffer}),/refused/);
    assert.equal(borrowed.destroyed,false);
    assert.deepEqual(f.buffers.filter(b=>b!==borrowed&&!b.destroyed),[]);
  }
});
test('baseline source hashes from frozen 6bf85224; private variants guard before PairBody and retain geometry', () => {
  // Exact donor exports evaluated from git show 6bf85224, not reconstructed by regex.
  const fixtures: [string,string][]=[
    [solveWGSL,'f2228d885f039af67798bd759ce25dbfa927d290c9d8d149ae3419cda2ff5df3'],
    [solveBodyAuxWGSL,'3d7691b24223d70c56f5d79e16c2e2f44c9379567cc7d0ffb1b3dcf2e5886cd3'],
    [contactsWGSL,'5fc12264dd42870a6a55dec9201a4966c7f0824c1048c7b01a585ca87e3ac68f'],
    [contactsHullWGSL,'e5e7bc50e5e2a4012337ab9789d3b4226d8e85da5ea9edf2599f1ab6c76432f9'],
    [PRELUDE_3D,'aef9b1be1644d594c6b7adac9a54dd947d54c79b9302731daabb1a27ce45cbcd']];
  for(const [code,hash] of fixtures) assert.equal(createHash('sha256').update(code).digest('hex'),hash);
  for(const fn of ['accumulate','dualManifold']) {
    const code=sensorProofSolveWGSL.slice(sensorProofSolveWGSL.indexOf('fn '+fn+'('));
    assert.ok(code.indexOf('contacts[mf.ids.z].key & 0x04000000u')<code.indexOf('= pairBody('));
    assert.ok(code.indexOf('count == 0u')<code.indexOf('contacts[mf.ids.z].key'));
  }
  assert.ok(sensorProofContactsWGSL.includes('~(STICK_BIT | 0x04000000u)'));
  assert.ok(sensorPreparationWGSL.includes('contacts[c].pen = vec3f(0.0)'));
  assert.ok(sensorPreparationWGSL.includes('contacts[c].lam = vec3f(0.0)'));
  assert.ok(!sensorPreparationWGSL.includes('bitcast'));
  for(const code of [solveWGSL,solveBodyAuxWGSL,contactsWGSL,contactsHullWGSL]) assert.ok(!code.includes('0x04000000u'));
});

test('decoder masks bit26 only for standard proof records; ordinary and SDF keep it', async () => {
  for (const mode of ['ordinary','proof','native','sdf'] as const) {
    const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),mode==='proof'?proof:{hulls:false});
    if(mode==='native')gpu.ensureNativeSensors();
    const mf=new Uint32Array(MANIFOLD_WORDS);mf.set([1,0,0,1]);
    const cf=new Uint32Array(CONTACT_WORDS);cf[K_RA+3]=0x04000000 | (3<<24);
    (gpu as Any).readCounters=async()=>({manifolds:1,contacts:1});
    (gpu as Any).read=async(buffer:GPUBuffer)=>buffer===(gpu as Any).manifoldBuffers[1]?mf.buffer:cf.buffer;
    const backend={destroy(){}};
    if(mode==='sdf')(gpu as Any).collisionBackend=backend;
    assert.equal((await gpu.readContactList())[0].feature, (mode==='proof'||mode==='native')?(3<<24):(0x04000000 | (3<<24)));
    gpu.destroy();
  }
});
test('default and custom modules select original source and create no preparation resources', () => {
  for(const shaders of [undefined,{solve:solveWGSL},{contacts:contactsWGSL}]) {
    const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),{hulls:false,shaders});
    assert.equal(f.layouts.some(l=>l.label==='sensor preparation'),false);
    assert.equal(f.pipelines.find(p=>p.label==='primal')!.module.code,shaders?.solve??solveBodyAuxWGSL);
    assert.equal(f.pipelines.find(p=>p.label==='narrowphase')!.module.code,contactsWGSL);
    gpu.step();assert.equal(f.passes.flatMap(dispatches).some(d=>d.name==='prepareSensors'),false);gpu.destroy();
  }
});
test('adaptive contact replacement rebinds preparation parity through existing ownership', () => {
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),proof);
  const old=gpu.contactStorages();
  gpu.reserveCollisionCapacity(gpu.contactCapacity+1);
  const gs=f.bindGroups.filter(g=>g.layout.label==='sensor preparation').slice(-2);
  assert.equal(gs.length,2);
  for(let i=0;i<2;i++) {
    assert.notEqual(gpu.contactStorages()[i].contacts,old[i].contacts);
    assert.equal(gs[i].entries[3].resource.buffer,gpu.contactStorages()[i].manifolds);
    assert.equal(gs[i].entries[5].resource.buffer,gpu.contactStorages()[i].contacts);
    assert.equal((old[i].contacts as unknown as FakeBuffer).destroyed,true);
  }
  gpu.destroy();assert.ok(f.buffers.every(b=>b.destroyed));
});

test('true flags refuse fixed spheres, sails and moving fixed boxes before any write', () => {
  const ref=new Solver();
  sphere(ref,0.5,0,0.5,[0,0,0]);
  sail(new Rigid(ref,[1,1,1],0,0.5,[2,0,0]));
  new Rigid(ref,[1,1,1],0,0.5,[4,0,0],[1,0,0]);
  const turning=new Rigid(ref,[1,1,1],0,0.5,[6,0,0]);turning.velocityAng[1]=1;
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,ref,proof);
  for(let i=0;i<4;i++) {
    const n=f.writes.length;
    assert.throws(()=>gpu.setSensorFlags([i],[true]),/stationary fixed box/);
    assert.equal(f.writes.length,n);
  }
  gpu.destroy();
});

// A later mass-mode command must not reuse the slot's construction-time eligibility.
test('a fixed-to-dynamic patched slot cannot newly acquire a sensor flag', () => {
  const f = fakeDevice(), gpu = new GpuSolver3D(f.device, scene(), proof);
  const replacement = new Rigid(new Solver(), [10, 1, 10], 1, 0.5, [0, -0.5, 0]);
  gpu.patchBody(0, new Set(), replacement, true);
  const before = f.writes.length;
  assert.throws(() => gpu.setSensorFlags([0], [true]), /stationary fixed box/);
  assert.equal(f.writes.length, before);
  gpu.destroy();
});

const native = { hulls: false, spatialSort: false, bodyCapacity: 8 } as const;
function tetra() {
  const shape = convexHull(new Float32Array([0,0,0, 1,0,0, 0,1,0, 0,0,1]));
  assert.ok(shape);
  return shape;
}

test('native activation is lazy, per-instance, idempotent and replaces only affected pipelines', () => {
  const f = fakeDevice(), gpu = new GpuSolver3D(f.device, scene(), native);
  const other = new GpuSolver3D(f.device, scene(), native);
  const old = { ...(gpu as Any).pipes }, integrate = (gpu as Any).integrateGroup;
  const counts = [f.buffers.length, f.bindGroups.length, f.pipelines.length];
  gpu.setNativeSensorFlags([0,1], [false,false]);
  assert.deepEqual([f.buffers.length, f.bindGroups.length, f.pipelines.length], counts);
  assert.equal((gpu as Any).sensorFlags.length, 0);
  gpu.ensureNativeSensors();
  assert.equal(f.buffers.length, counts[0]);
  assert.equal((gpu as Any).integrateGroup, integrate);
  const changed = ['narrowphase','primal','primalSparse','dual'];
  for (const key of Object.keys(old)) assert.equal((gpu as Any).pipes[key] === old[key], !changed.includes(key), key);
  assert.equal((other as Any).nativeSensors, false);
  assert.equal((other as Any).pipes.primal.module.code, solveBodyAuxWGSL);
  const after = [f.buffers.length, f.bindGroups.length, f.pipelines.length];
  gpu.ensureNativeSensors();
  gpu.setNativeSensorFlags([1,1,2], [true,false,true]);
  assert.deepEqual([...(gpu as Any).sensorFlags], [0,0,1,0,0,0,0,0]);
  gpu.setNativeSensorFlags([2], [false]);
  assert.deepEqual([f.buffers.length, f.bindGroups.length, f.pipelines.length], after);
  gpu.destroy(); other.destroy();
  assert.throws(() => gpu.ensureNativeSensors(), /destroyed/);
});

test('native setup throws at each pipeline/parity boundary without committing and retries', () => {
  for (const failure of ['narrowphase','primal','dual','primalSparse','prepareSensors',1,2]) {
    const options: { failPipeline?: string; failSensorGroup?: number } = {};
    const f = fakeDevice(options);
    const borrowed = f.device.createBuffer({ label:'borrowed', size:8*BODY_FLOATS*4, usage:0 });
    const gpu = new GpuSolver3D(f.device, scene(), {...native,bodyBuffer:borrowed});
    if (typeof failure === 'string') options.failPipeline = failure;
    else options.failSensorGroup = failure;
    const pipes = {...(gpu as Any).pipes}, groups = (gpu as Any).sensorGroups;
    const writes = f.writes.length, buffers = f.buffers.length;
    assert.throws(() => gpu.setNativeSensorFlags([0,1], [true,true]), /fake:/);
    assert.equal((gpu as Any).nativeSensors,false);
    assert.deepEqual((gpu as Any).pipes,pipes);
    assert.equal((gpu as Any).sensorGroups,groups);
    assert.equal((gpu as Any).sensorLayout,null);
    assert.equal((gpu as Any).sensorFlags.length,0);
    assert.equal(gpu.bodyCount,4);
    assert.equal(f.writes.length,writes);
    assert.equal(f.buffers.length,buffers);
    assert.ok(f.buffers.every(b=>!b.destroyed));
    delete options.failPipeline; delete options.failSensorGroup;
    gpu.setNativeSensorFlags([0], [true]);
    assert.equal((gpu as Any).nativeSensors,true);
    gpu.destroy(); assert.equal((borrowed as Any).destroyed,false);
  }
});

test('native batch validation precedes activation and writes, copies inputs, last duplicate wins', () => {
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),native);
  for(const [indices,flags] of [[[0,7],[true,false]],[[0,1],[true,1]],[[0,-1],[true,false]],[[0,1.5],[true,false]],[[0],[]]] as Any[]) {
    const n=[f.writes.length,f.pipelines.length,f.bindGroups.length];
    assert.throws(()=>gpu.setNativeSensorFlags(indices,flags));
    assert.deepEqual([f.writes.length,f.pipelines.length,f.bindGroups.length],n);
    assert.equal((gpu as Any).nativeSensors,false);
  }
  gpu.setLifecycle(1,BODY_DISABLED|BODY_COLD);
  const flags=[true,true]; gpu.setNativeSensorFlags([1,2],flags);flags.fill(false);
  assert.equal((gpu as Any).sensorFlags[1],1);
  const dirty=f.writes.filter(w=>w.buffer===(gpu.bodyBuffer as unknown as FakeBuffer)&&w.offset===(BODY_FLOATS+B_INITIAL_POS+3)*4).at(-1)!;
  assert.deepEqual(f32(dirty.bytes),[BODY_DIRTY|BODY_DISABLED|BODY_COLD]);
  const n=f.writes.length;
  gpu.setNativeSensorFlags([1,1],[false,true]);
  assert.equal(f.writes.length,n);
  gpu.destroy();
});

test('native flags admit dynamic and prescribed bodies, survive masked edits/aux setters; full replacements clear', () => {
  const ref=scene(); sphere(ref,0.5,1,0.5,[0,3,0]);
  const moving=new Rigid(ref,[1,1,1],0,0.5,[0,4,0],[1,0,0]);moving.velocityAng[0]=1;
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,ref,native);
  gpu.setNativeSensorFlags([0,1,4,5],[true,true,true,true]);
  gpu.setBodyAux([0,1],[2,3],[4,5],[6,7]);
  assert.deepEqual(f32(auxWrites(f).at(-1)!.bytes),[2,4,6,1,3,5,7,1]);
  gpu.setBodyAux([0,1],[8,9]);
  assert.deepEqual(f32(auxWrites(f).at(-1)!.bytes),[8,0,0,1,9,0,0,1]);
  const unsupported=sail(new Rigid(new Solver(),[1,1,1],1,0.5,[1,2,3]));
  gpu.patchBody(1,new Set(['position','velocity','angularVelocity']),unsupported,true);
  assert.equal((gpu as Any).bodies[1].nativeShape,'box');
  assert.equal((gpu as Any).sensorFlags[1],1);
  gpu.setNativeSensorFlags([1],[true]);
  const before=f.writes.length;
  gpu.rewriteBodies([1],[ref.bodies[1]]);
  assert.equal((gpu as Any).sensorFlags[1],0);
  assert.deepEqual(auxWrites(f,before).map(w=>[w.offset,f32(w.bytes)]),[[28,[0]]]);
  gpu.rewriteFixed([0],[0,0,0],[1,1,1],0.5);
  assert.equal((gpu as Any).sensorFlags[0],0);
  gpu.addBody(ref.bodies[0]);assert.equal((gpu as Any).sensorFlags[6],0);
  gpu.setLifecycle(4,BODY_DISABLED|BODY_COLD);
  gpu.seedFrom(ref);
  assert.equal((gpu as Any).lifecycle[4],BODY_DISABLED|BODY_COLD);
  const seeded=f.writes.filter(w=>w.buffer===(gpu.bodyBuffer as unknown as FakeBuffer)&&w.offset===0).at(-1)!;
  assert.equal(f32(seeded.bytes)[4*BODY_FLOATS+B_INITIAL_POS+3],BODY_DIRTY|BODY_DISABLED|BODY_COLD);
  assert.ok((gpu as Any).sensorFlags.every((v:number)=>v===0));
  gpu.destroy();
});

test('actual uploaded shape, not later Rigid marks, controls native eligibility', () => {
  const ref=scene(),f=fakeDevice(),gpu=new GpuSolver3D(f.device,ref,native);
  sail(ref.bodies[0]);
  gpu.patchBody(0,new Set(['velocity']),ref.bodies[0]);
  gpu.setNativeSensorFlags([0],[true]);
  assert.equal((gpu as Any).bodies[0].nativeShape,'box');
  gpu.destroy();
});

test('sail/fallback mixing refuses native activation and future add/full rewrite before mutation', () => {
  for(const shape of ['sail','fallback']) {
    const ref=new Solver();
    const bad=shape==='sail'?sail(new Rigid(ref,[1,1,1],1,0.5,[0,0,0])):hull(ref,tetra(),1,0.5,[0,0,0]);
    const f=fakeDevice(),badGpu=new GpuSolver3D(f.device,ref,native);
    const n=[f.writes.length,f.pipelines.length,f.bindGroups.length];
    assert.throws(()=>badGpu.ensureNativeSensors(),/standard boxes/);
    assert.deepEqual([f.writes.length,f.pipelines.length,f.bindGroups.length],n);badGpu.destroy();
    const gpu=new GpuSolver3D(f.device,scene(),native);gpu.ensureNativeSensors();
    for(const change of [()=>gpu.addBodies([scene().bodies[0],bad]),()=>gpu.rewriteBodies([0,1],[scene().bodies[0],bad]),()=>gpu.seedFrom(ref)]) {
      const before=[f.writes.length,gpu.bodyCount,(gpu as Any).hullTop];
      const infos=[...(gpu as Any).bodies];
      assert.throws(change,/standard boxes/);
      assert.deepEqual([f.writes.length,gpu.bodyCount,(gpu as Any).hullTop],before);
      assert.deepEqual((gpu as Any).bodies,infos);
    }
    gpu.destroy();
  }
});

test('native hull source is selected at activation or future first acquisition, with 9/8/5 layouts', () => {
  for(const early of [true,false]) {
    const ref=scene(),shape=tetra();if(early)hull(ref,shape,1,0.5,[0,3,0]);
    const f=fakeDevice({storage:9}),gpu=new GpuSolver3D(f.device,ref,{...native,hulls:true});
    gpu.ensureNativeSensors();
    if(!early)gpu.addBody(hull(new Solver(),shape,1,0.5,[0,3,0]));
    const code=(gpu as Any).pipes.narrowphase.module.code;
    assert.ok(code.includes('~(STICK_BIT | 0x04000000u)'));
    assert.ok(code.includes('fn collidePoly('));
    for(const [name,count] of [['contacts 3d',9],['solve 3d',8],['sensor preparation',5]] as const) assert.equal(f.layouts.find(l=>l.label===name).entries.filter((e:Any)=>e.buffer.type!=='uniform').length,count);
    gpu.setNativeSensorFlags([4],[true]);gpu.destroy();
  }
});

test('native backend refusal lasts with flags cleared; custom/proof cross-mode refusal is inert', () => {
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),native);
  gpu.setNativeSensorFlags([0],[true]);gpu.setNativeSensorFlags([0],[false]);
  let prepared=false;const n=f.writes.length;
  assert.throws(()=>gpu.setCollisionBackend({prepare(){prepared=true;}} as Any),/Native sensors/);
  assert.equal(prepared,false);assert.equal(f.writes.length,n);gpu.destroy();
  for(const options of [proof,{...native,shaders:{} }]) {
    const other=new GpuSolver3D(f.device,scene(),options);
    const before=[f.writes.length,f.pipelines.length,f.bindGroups.length];
    assert.throws(()=>other.ensureNativeSensors(),/built-in standard/);
    assert.throws(()=>other.setNativeSensorFlags([0],[false]),/built-in standard/);
    assert.deepEqual([f.writes.length,f.pipelines.length,f.bindGroups.length],before);other.destroy();
  }
  const backendGpu=new GpuSolver3D(f.device,scene(),native);
  backendGpu.setCollisionBackend({prepare(){},destroy(){}} as Any);
  assert.throws(()=>backendGpu.ensureNativeSensors(),/built-in standard/);backendGpu.destroy();
});

test('native preparation runs before topology at zero iterations, fixed steps/toggles allocate nothing', () => {
  const f=fakeDevice(),fixed=resolveFixedStorage({maxBodies:8},{growth:'fixed',pairs:4096,contacts:8192,manifolds:4096,joints:256,hullVec4s:4096},LIMITS);
  const gpu=new GpuSolver3D(f.device,scene(),{...native,fixed});gpu.ensureNativeSensors();gpu.params.iterations=0;
  const counts=[f.buffers.length,f.bindGroups.length,f.pipelines.length];
  for(let i=0;i<4;i++) {
    gpu.setNativeSensorFlags([0],[i%2===0]);f.passes.length=0;gpu.step({reuseManifolds:true});
    const names=f.passes.flatMap(dispatches).map(d=>d.name),at=names.indexOf('prepareSensors');
    assert.equal(names[at-1],'argsContacts');assert.equal(names[at+1],'degreeContacts');
    assert.ok(names.includes('narrowphase'));assert.ok(!names.includes('reuseManifolds'));assert.ok(!names.includes('updateRefs'));
    assert.equal((gpu as Any).paramU32[6]&FLAG_REUSE_CONTACTS,0);assert.equal(gpu.params.reuseContacts,true);
    assert.deepEqual([f.buffers.length,f.bindGroups.length,f.pipelines.length],counts);
  }
  gpu.destroy();
});


test('native adaptive storage rebuilds both preparation groups without losing slot intent', () => {
  const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),native);
  gpu.setNativeSensorFlags([1],[true]);
  const old=gpu.contactStorages();gpu.reserveCollisionCapacity(gpu.contactCapacity+1);
  const gs=f.bindGroups.filter(g=>g.layout.label==='sensor preparation').slice(-2);
  assert.equal(gs.length,2);
  for(let i=0;i<2;i++) {
    assert.equal(gs[i].entries[3].resource.buffer,gpu.contactStorages()[i].manifolds);
    assert.equal(gs[i].entries[5].resource.buffer,gpu.contactStorages()[i].contacts);
    assert.equal((old[i].contacts as unknown as FakeBuffer).destroyed,true);
  }
  assert.equal((gpu as Any).sensorFlags[1],1);gpu.destroy();
});

test('masked hull commands never pin or release unuploaded geometry; full replacement updates shape', () => {
  const ref=scene(),shape=tetra(),original=hull(ref,shape,1,0.5,[0,3,0]);
  const f=fakeDevice({storage:9}),gpu=new GpuSolver3D(f.device,ref,{...native,hulls:true});
  const replacement=hull(new Solver(),tetra(),1,0.5,[1,2,3]);
  const slots=(gpu as Any).hullSlots, before=[...slots].map(([s,h]:Any)=>[s,{...h}]);
  const top=(gpu as Any).hullTop;
  gpu.patchBody(4,new Set(['position','rotation','velocity','angularVelocity']),replacement,true);
  assert.deepEqual([...slots],before);assert.equal((gpu as Any).hullTop,top);
  assert.equal((gpu as Any).bodies[4].hull,shape);
  gpu.setNativeSensorFlags([4],[true]);
  gpu.rewriteBodies([4],[ref.bodies[0]]);
  assert.equal((gpu as Any).bodies[4].nativeShape,'box');assert.equal(slots.has(shape),false);
  assert.equal((gpu as Any).sensorFlags[4],0);
  gpu.rewriteBodies([4],[original]);
  assert.equal((gpu as Any).bodies[4].nativeShape,'hull');
  assert.equal((gpu as Any).sensorFlags[4],0);gpu.destroy();
});

test('standard feature producer fixtures reserve bit26 for activated metadata', () => {
  // Actual key producers, including the hull insertion, are frozen here. A new producer
  // must update this fixture and justify its bit budget rather than borrowing bit26.
  const lines=contactsHullWGSL.split('\n').map(l=>l.trim());
  assert.deepEqual(lines.filter(l=>l.startsWith('const AXIS_')||l.startsWith('const SPHERE_FEATURE')), [
    'const SPHERE_FEATURE = 50331648u;', 'const AXIS_FACE_A = 0u;', 'const AXIS_FACE_B = 1u;', 'const AXIS_EDGE = 2u;',
  ]);
  assert.deepEqual(lines.filter(l=>l.startsWith('let prefix =')||l.startsWith('let key =')), [
    'let prefix = (select(AXIS_FACE_B, AXIS_FACE_A, refIsA) << 24u) | (refAxis << 16u) | (incAxis << 8u);',
    'let key = (AXIS_EDGE << 24u) | (ia << 8u) | ib;',
    'let prefix = (select(AXIS_FACE_B, AXIS_FACE_A, refIsA) << 24u) | (min(refFace, 255u) << 16u) | (min(inc, 255u) << 8u);',
  ]);
  const producers=lines.filter(l=>l.includes('addFound(&found,'));
  assert.deepEqual(producers,[
    'addFound(&found, select(p, onRef, refIsA), select(onRef, p, refIsA), prefix | i);',
    'if (found.count == 0u) { addFound(&found, support(A, nAB), support(B, -nAB), prefix); }',
    'addFound(&found, p0 + d1 * s, q0 + d2 * t, key);',
    'if (found.count == 0u) { addFound(&found, support(A, nAB), support(B, -nAB), key); }',
    'addFound(&found, A.c + n * A.h.x, B.c - n * B.h.x, SPHERE_FEATURE);',
    'addFound(&found, select(p, onRef, refIsA), select(onRef, p, refIsA), prefix | min(index[pick], 255u));',
    'addFound(&found, polySupport(A, nAB), polySupport(B, -nAB), prefix);',
    'addFound(&found, p0 + d1 * s, q0 + d2 * t, (AXIS_EDGE << 24u) | (min(q.ea, 255u) << 8u) | min(q.eb, 255u));',
    'if (h.hit) { addFound(&found, h.onSphere, h.onBox, SPHERE_FEATURE); }',
    'if (h.hit) { addFound(&found, h.onBox, h.onSphere, SPHERE_FEATURE); }',
    'if (h.hit) { addFound(&found, h.onSphere, h.onBox, SPHERE_FEATURE); }',
    'if (h.hit) { addFound(&found, h.onBox, h.onSphere, SPHERE_FEATURE); }',
  ]);
  for(const axis of [0,1,2,3]) for(const a of [0,2,255]) for(const b of [0,2,255]) for(const point of [0,7,63,255]) {
    const key=(axis<<24)|(a<<16)|(b<<8)|point;
    assert.equal(key&0x04000000,0);
  }
});

test('a duplicate batch ending false does not activate an untouched native solver', () => {
  const f = fakeDevice(), gpu = new GpuSolver3D(f.device, scene(), native);
  const before = [f.writes.length, f.pipelines.length, f.bindGroups.length];
  gpu.setNativeSensorFlags([0, 0], [true, false]);
  assert.equal((gpu as Any).nativeSensors, false);
  assert.equal((gpu as Any).sensorFlags.length, 0);
  assert.deepEqual([f.writes.length, f.pipelines.length, f.bindGroups.length], before);
  gpu.destroy();
});
