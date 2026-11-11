// Recording fakes prove encoding/ownership, never physical nonresponse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { sphere, sail } from '../src/avbd3d/shapes.ts';
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

function fakeDevice(options: { storage?: number; failPipeline?: string } = {}) {
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
    createBindGroup(desc: Any) { if (desc.layout.label === 'sensor preparation' && options.failPipeline === 'sensor binding') throw new Error('fake: sensor binding refused'); bindGroups.push(desc); return desc; },
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
  for (const mode of ['ordinary','proof','sdf'] as const) {
    const f=fakeDevice(),gpu=new GpuSolver3D(f.device,scene(),mode==='proof'?proof:{hulls:false});
    const mf=new Uint32Array(MANIFOLD_WORDS);mf.set([1,0,0,1]);
    const cf=new Uint32Array(CONTACT_WORDS);cf[K_RA+3]=0x04000000 | (3<<24);
    (gpu as Any).readCounters=async()=>({manifolds:1,contacts:1});
    (gpu as Any).read=async(buffer:GPUBuffer)=>buffer===(gpu as Any).manifoldBuffers[1]?mf.buffer:cf.buffer;
    const backend={destroy(){}};
    if(mode==='sdf')(gpu as Any).collisionBackend=backend;
    assert.equal((await gpu.readContactList())[0].feature, mode==='proof'?(3<<24):(0x04000000 | (3<<24)));
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
