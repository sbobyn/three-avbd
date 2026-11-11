// CPU command recording only: no GPU execution or physical acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { solveWGSL } from '../src/avbd3d/gpu/wgsl-solve.ts';
import { worldAnchorFloor } from '../src/avbd3d/gpu/world-anchor-policy.ts';
import { test } from 'node:test';
import { World, Body, WorldJoint, type Vec3 } from '../src/lib/world.ts';
import { BodyPool } from '../src/lib/pool.ts';
import { StorageCapacityError } from '../src/lib/storage-budget.ts';
import type { StorageLimits } from '../src/lib/storage-budget.ts';
import { JOINT_FLOATS, J_RA, J_RB, J_PEN_LIN, J_PEN_ANG, J_LAM_LIN, J_LAM_ANG, J_REST, J_REST_START, J_YIELD, J_BREAK_BEND, T_JOINT } from '../src/avbd3d/gpu/layout.ts';
import { BIG } from '../src/avbd2d/gpu/layout.ts';
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const g = globalThis as Any;
g.GPUBufferUsage ??= { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 };
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
g.GPUMapMode ??= { READ: 1, WRITE: 2 };

const LIMITS: StorageLimits = { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: 2 ** 30, maxComputeWorkgroupsPerDimension: 65535, minUniformBufferOffsetAlignment: 256, maxUniformBufferBindingSize: 65536 };
interface FakeBuffer { label: string; size: number; destroyed: boolean }
interface Write { buffer: FakeBuffer; offset: number; bytes: Uint8Array }

function fakeDevice() {
  const pipelines: Any[] = [];
  const trace: string[] = [];
  const faults = { policyPipeline: false };
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
      if (desc.label === 'prepareWorldAnchors' && faults.policyPipeline) throw new Error('policy pipeline failure');
      pipelines.push(desc);
      counts.pipelines++;
      return { label: desc.label, layout: desc.layout, getBindGroupLayout: () => ({ auto: true }) };
    },
    createBindGroup(desc: Any) { counts.bindGroups++; return { label: desc.label, layout: desc.layout, entries: desc.entries }; },
    createQuerySet() { return { destroy() {} }; },
    createCommandEncoder() {
      return {
        clearBuffer() {}, copyBufferToBuffer() {}, resolveQuerySet() {}, finish: () => ({}),
        beginComputePass: () => ({ setPipeline(p: Any) { trace.push(p.label); }, setBindGroup() {}, dispatchWorkgroups() {}, dispatchWorkgroupsIndirect() {}, end() {} }),
      };
    },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
  };
  return { device: device as GPUDevice, buffers, writes, counts, trace, faults, pipelines };
}

const FIXED = { growth: 'fixed', pairs: 4096, contacts: 8192, manifolds: 4096, joints: 256, hullVec4s: 4096 } as const;
async function setup(fixed = false) {
  const fake = fakeDevice();
  const w = await World.create({ device: fake.device, maxBodies: 16, ...(fixed ? {storage: FIXED} : {}) });
  const body = w.addBox({size: [1, 2, 3]})!;
  return { w, body, fake };
}
const floats = (bytes: Uint8Array) => [...new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)];
const jointWrites = (w: World, fake: ReturnType<typeof fakeDevice>, from = 0) => fake.writes.slice(from).filter(x => x.buffer === (w.solver as Any).jointBuffer);
const targetWrites = (w: World, fake: ReturnType<typeof fakeDevice>, from = 0) => jointWrites(w, fake, from).filter(x => x.bytes.length === 12);
function snapshot(w: World, fake: ReturnType<typeof fakeDevice>) {
  const s = w.solver as Any, a = w as Any;
  return {writes: fake.writes.length, count: s.jointCount, free: [...s.freeSlots], info: [...s.info], pending: [...a.pendingWorldJoints], placed: [...a.worldJoints], targets: [...a.worldRetargets], bodies: w.bodyStats};
}

test('world ball record has no hidden body or exclusion; commands copy and coalesce without a clock/read', async () => {
  const { w, body, fake } = await setup();
  const target: Vec3 = [1, 2, 3], local: Vec3 = [0, .5, 0];
  const stats = w.bodyStats;
  const j = w.addWorldJoint(body, {anchorWorld: target, anchorBody: local});
  assert.ok(j instanceof WorldJoint);
  assert.equal(j.type, 'ball'); assert.equal(j.world, w); assert.equal(j.body, body);
  target[0] = 99; local[1] = 99;
  j.anchorWorld[0] = 88; j.anchorBody[1] = 88;
  assert.deepEqual(j.anchorWorld, [1,2,3]); assert.deepEqual(j.anchorBody, [0,.5,0]);
  assert.deepEqual(w.bodyStats, stats);
  assert.equal((w as Any).joints.size, 0);
  const reads = () => { throw new Error('unexpected automatic read'); };
  w.readJoints = reads; w.solver.readBodies = reads;
  const p: Vec3 = [4,5,6]; j.setWorldAnchor([2,3,4]); j.setWorldAnchor(p); p[0] = 44;
  assert.equal(j.slot, -1);
  w.update(0); assert.equal(j.slot, -1);
  w.flushCommands();
  assert.equal(w.stepCount, 0); assert.equal(w.solver.bodyCount, 1);
  const record = floats(jointWrites(w, fake).at(-1)!.bytes);
  assert.equal(record.length, JOINT_FLOATS);
  assert.deepEqual(record.slice(J_RA,J_RA+3), [4,5,6]);
  assert.deepEqual(record.slice(J_RB,J_RB+3), [0,.5,0]);
  assert.equal(record[J_PEN_LIN+3], Math.fround(BIG)); assert.equal(record[J_PEN_ANG+3],0);
  assert.equal(record[J_LAM_ANG+3],14);
  for (const offset of [J_REST,J_REST_START]) assert.deepEqual(record.slice(offset,offset+4),[0,0,0,1]);
  for (const offset of [J_LAM_LIN,J_LAM_ANG,J_PEN_LIN,J_PEN_ANG]) assert.deepEqual(record.slice(offset,offset+3),[0,0,0]);
  for (const offset of [J_LAM_LIN+3,J_YIELD,J_BREAK_BEND]) assert.equal(record[offset],Math.fround(BIG));
  assert.ok(record.every(Number.isFinite));
  assert.deepEqual([...(w.solver as Any).info.slice(j.slot*4,j.slot*4+4)], [T_JOINT,-1,body.index,0]);
  assert.equal((w.solver as Any).noCollideTable.flush().length, 0);
  const from = fake.writes.length;
  j.setWorldAnchor([7,8,9]); j.setWorldAnchor([10,11,12]);
  assert.equal(fake.writes.length,from);
  w.flushCommands();
  assert.deepEqual(targetWrites(w,fake,from).map(x => [x.offset,floats(x.bytes)]), [[(j.slot*JOINT_FLOATS+J_RA)*4,[10,11,12]]]);
  assert.equal(jointWrites(w,fake,from).length,1);
  assert.equal(w.stepCount,0); assert.equal((w as Any).joints.size,0);
  w.destroy();
});

test('strict public admission and retarget errors leave all queues, slots, IDs and writes untouched', async () => {
  const {w,body,fake} = await setup();
  const other = await setup();
  const dead = w.addSphere({radius:.5})!; dead.remove();
  const badVectors = [null, undefined, [], [1,2], [1,2,3,4], [NaN,0,0], [Infinity,0,0], [1e40,0,0], ['1',0,0], '123', {}];
  const invalid: Any[] = [null, undefined, [], 1, {}, ...badVectors.map(anchorWorld => ({anchorWorld})), ...badVectors.filter(x => x !== undefined).map(anchorBody => ({anchorWorld:[0,0,0],anchorBody}))];
  for (const key of ['type','rest','anchorA','anchorB','yieldForce','breakForce','breakOnPull','breakBend','stiffness','damping']) invalid.push({anchorWorld:[0,0,0],[key]:undefined});
  invalid.push({anchorWorld:[0,0,0],[Symbol('unknown')]:1});
  invalid.push(Object.assign(Object.create({type:'fixed'}),{anchorWorld:[0,0,0]}));
  invalid.push(Object.assign(Object.create(Object.defineProperty({},'type',{value:'fixed'})),{anchorWorld:[0,0,0]}));
  for (const options of invalid) {
    const before = snapshot(w,fake);
    assert.throws(() => w.addWorldJoint(body,options));
    assert.deepEqual(snapshot(w,fake),before);
  }
  for (const b of [null, {}, {world:w,alive:true,index:body.index}, Object.assign(Object.create(Body.prototype),{world:w,index:body.index}), other.body, dead]) {
    const before = snapshot(w,fake);
    assert.throws(() => w.addWorldJoint(b as Any,{anchorWorld:[0,0,0]}));
    assert.deepEqual(snapshot(w,fake),before);
  }
  const j = w.addWorldJoint(body,{anchorWorld:[0,0,0]});
  for (const point of badVectors) {
    const before = snapshot(w,fake);
    assert.throws(() => j.setWorldAnchor(point as Any));
    assert.deepEqual(snapshot(w,fake),before); assert.deepEqual(j.anchorWorld,[0,0,0]);
  }
  j.remove(); const before = snapshot(w,fake);
  j.remove(); assert.throws(() => j.setWorldAnchor([1,2,3]),/removed/);
  assert.deepEqual(snapshot(w,fake),before);
  w.destroy(); other.w.destroy();
  assert.throws(() => w.addWorldJoint(body,{anchorWorld:[0,0,0]}),/destroyed/);
});

for (const fixed of [false,true]) {
  test(`released world slots reuse across ordinary and world constraints (${fixed ? 'fixed' : 'adaptive'})`, async () => {
    const {w,body,fake} = await setup(fixed);
    const b = w.addSphere({radius:.5})!;
    const j = w.addWorldJoint(body,{anchorWorld:[0,0,0]}); w.flushCommands();
    const slot = j.slot; j.setWorldAnchor([9,9,9]); j.remove(); j.remove();
    const ordinary = w.addJoint(body,b); w.flushCommands(); assert.equal(ordinary.slot,slot);
    const from = fake.writes.length;
    assert.throws(() => j.setWorldAnchor([3,3,3])); w.flushCommands(); assert.equal(fake.writes.length,from);
    ordinary.remove();
    for (let i=0;i<20;i++) {
      const next = w.addWorldJoint(body,{anchorWorld:[i,0,0]}); w.flushCommands();
      assert.equal(next.slot,slot); assert.equal(w.solver.jointCount,1); next.remove();
    }
    w.destroy();
  });
}

test('fixed capacity counts all pending/placed joints and springs; cancellation gives room immediately', async () => {
  const {w,body,fake} = await setup(true), b = w.addSphere({radius:.5})!;
  const ordinary = w.addJoint(body,b);
  w.addSpring(body,b,{stiffness:1});
  const handles = Array.from({length:254},() => w.addWorldJoint(body,{anchorWorld:[0,0,0]}));
  let before = snapshot(w,fake);
  for (const add of [() => w.addWorldJoint(body,{anchorWorld:[0,0,0]}), () => w.addJoint(body,b), () => w.addSpring(body,b,{stiffness:1})]) assert.throws(add,StorageCapacityError);
  assert.deepEqual(snapshot(w,fake),before);
  handles[0].remove(); const next = w.addWorldJoint(body,{anchorWorld:[1,2,3]});
  w.flushCommands(); assert.equal(w.solver.jointCount,256);
  before = snapshot(w,fake);
  assert.throws(() => w.solver.appendWorldJoint(body.index,[0,0,0],[0,0,0]),StorageCapacityError);
  assert.deepEqual(snapshot(w,fake),before);
  ordinary.remove(); next.setWorldAnchor([2,3,4]); next.remove();
  const replacement = w.addJoint(body,b); w.flushCommands(); assert.ok(replacement.holding);
  w.destroy();
});

test('body removal cancels pending and placed handles by identity before body/constraint slot reuse', async () => {
  const {w,body,fake} = await setup();
  const placed = w.addWorldJoint(body,{anchorWorld:[0,0,0]}); w.flushCommands();
  const pending = w.addWorldJoint(body,{anchorWorld:[1,0,0]});
  placed.setWorldAnchor([9,9,9]); body.remove();
  assert.equal(placed.holding,false); assert.equal(pending.holding,false);
  const b = w.addBox({size:[1,1,1]})!; assert.equal(b.index,body.index); assert.notEqual(b.id,body.id);
  const fresh = w.addWorldJoint(b,{anchorWorld:[3,4,5]}); w.flushCommands();
  assert.equal(fresh.slot,placed.slot);
  const from = fake.writes.length;
  for (const j of [placed,pending]) { assert.throws(() => j.setWorldAnchor([9,0,0])); j.remove(); }
  w.flushCommands(); assert.equal(fake.writes.length,from);
  assert.equal(fresh.holding,true); w.destroy();
});

test('disable, reset, fixed, sensor, pose and force commands retain target and capacity', async () => {
  const {w,body} = await setup(true);
  body.setSensor(true);
  const j = w.addWorldJoint(body,{anchorWorld:[3,4,5]});
  body.setEnabled(false); assert.equal(j.holding,true); assert.equal(j.suspended,true); w.flushCommands();
  const slot = j.slot; body.reset({position:[1,2,3]}); body.setFixed(true);
  assert.throws(() => body.moveTo([2,3,4]), /disabled/);
  w.flushCommands(); assert.equal(j.slot,slot); assert.deepEqual(j.anchorWorld,[3,4,5]);
  body.setEnabled(true); body.moveTo([2,3,4]); body.setFixed(false); body.applyForce([1,0,0]);
  j.setWorldAnchor([4,5,6]);
  const force = (w as Any).forces.get(body); w.flushCommands();
  assert.equal((w as Any).forces.get(body),force); assert.equal(j.suspended,false);
  assert.deepEqual(j.anchorWorld,[4,5,6]); assert.equal(w.solver.jointCount,1); w.destroy();
});

test('pool release and despawn cancel both forms; a reused lease cannot revive old retargets', async () => {
  const {w,fake} = await setup(true);
  const result = await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5}}});
  assert.ok(result.ok); const pool = result.pool;
  const acquire = () => { const result = pool.tryAcquire({position:[0,0,0],rotation:[0,0,0,1]}); assert.ok(result.ok); return result.body; };
  let b = acquire();
  const placed = w.addWorldJoint(b,{anchorWorld:[0,0,0]}); w.flushCommands();
  const pending = w.addWorldJoint(b,{anchorWorld:[1,0,0]}); placed.setWorldAnchor([9,9,9]);
  pool.release(b); assert.equal(placed.holding,false); assert.equal(pending.holding,false);
  const old = b; b = acquire(); assert.equal(old.index,b.index); assert.notEqual(old.id,b.id);
  const next = w.addWorldJoint(b,{anchorWorld:[2,0,0]}); w.flushCommands();
  const from = fake.writes.length; assert.throws(() => placed.setWorldAnchor([9,0,0])); w.flushCommands(); assert.equal(fake.writes.length,from);
  pool.dispose(); assert.equal(next.holding,false); w.destroy();
});

test('backend admission, live retarget and SDF enabling refuse before mutation/preparation', async () => {
  const {w,body,fake} = await setup();
  const j = w.addWorldJoint(body,{anchorWorld:[0,0,0]});
  for (const placed of [false,true]) {
    if (placed) w.flushCommands();
    body.setEnabled(false);
    const before = snapshot(w,fake);
    await assert.rejects(w.enableSdfCollisions(),/Remove world joints/);
    assert.equal((w as Any).sdfState,'off'); assert.deepEqual(snapshot(w,fake),before);
  }
  const a = w as Any, s = w.solver as Any;
  for (const [owner,key,value] of [[a,'sdfState','preparing'],[a,'sdfState','on'],[s,'collisionBackend',{}],[s,'customShaders',true]] as const) {
    const original = owner[key]; owner[key] = value;
    const before = snapshot(w,fake);
    assert.throws(() => w.addWorldJoint(body,{anchorWorld:[0,0,0]}),/standard/);
    assert.throws(() => j.setWorldAnchor([1,2,3]),/standard/);
    assert.deepEqual(j.anchorWorld,[0,0,0]); assert.deepEqual(snapshot(w,fake),before);
    owner[key] = original;
  }
  j.remove();
  let switches = 0; w.solver.assertBackendSwitchAllowed = () => { switches++; throw new Error('past guard'); };
  await assert.rejects(w.enableSdfCollisions(),/past guard/); assert.equal(switches,1);
  w.destroy();
});

test('destroy and pool cleanup after device error do not issue writes or throw mid-cleanup', async () => {
  for (const error of [false,true]) {
    const {w,body,fake} = await setup(true);
    const result = await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5}}}); assert.ok(result.ok);
    const lease = result.pool.tryAcquire({position:[0,0,0],rotation:[0,0,0,1]}); assert.ok(lease.ok);
    const placed = w.addWorldJoint(lease.body,{anchorWorld:[0,0,0]}); w.flushCommands();
    const pending = w.addWorldJoint(lease.body,{anchorWorld:[1,0,0]});
    const ordinaryBodyJoint = w.addWorldJoint(body,{anchorWorld:[2,0,0]});
    placed.setWorldAnchor([4,5,6]);
    const from = fake.writes.length;
    if (error) { (w as Any).gpuError = new Error('device failed'); result.pool.dispose(); assert.equal(placed.holding,false); assert.equal(pending.holding,false); }
    w.destroy(); w.destroy(); result.pool.dispose();
    assert.equal(fake.writes.length,from);
    for (const j of [placed,pending,ordinaryBodyJoint]) {
      assert.equal(j.holding,false); assert.equal(j.suspended,false); assert.throws(() => j.setWorldAnchor([1,2,3]));
    }
    assert.throws(() => ordinaryBodyJoint.remove(),/destroyed/);
    assert.equal((w as Any).worldRetargets.size,0); assert.equal((w as Any).pendingWorldJoints.length,0);
  }
});

test('internal validation precedes free-slot/count/write mutation; advanced pair API still rejects -1', async () => {
  const {w,body,fake} = await setup(); w.flushCommands();
  const slot = w.solver.appendWorldJoint(body.index,[0,0,0],[0,0,0]); w.solver.releaseJoints([slot]);
  for (const b of [-1,.5,1,NaN]) {
    const before = snapshot(w,fake); assert.throws(() => w.solver.appendWorldJoint(b,[0,0,0],[0,0,0])); assert.deepEqual(snapshot(w,fake),before);
  }
  for (const v of [null,[1,2],[1,2,3,4],[NaN,0,0],[Infinity,0,0],[1e40,0,0],['1',0,0]]) {
    for (const local of [false,true]) {
      const before = snapshot(w,fake); assert.throws(() => w.solver.appendWorldJoint(body.index,local ? [0,0,0] : v as Any,local ? v as Any : [0,0,0])); assert.deepEqual(snapshot(w,fake),before);
    }
  }
  const before = snapshot(w,fake);
  assert.throws(() => w.solver.appendJoints([{a:-1,b:body.index,rA:[0,0,0],rB:[0,0,0]}])); assert.deepEqual(snapshot(w,fake),before);
  assert.equal(w.solver.appendWorldJoint(body.index,[1,2,3],[0,0,0]),slot); w.destroy();
});


test('read flushes target commands without solving, in-flight reads retain their boundary; only ordinary joints decode', async () => {
  const {w,body,fake} = await setup();
  const j = w.addWorldJoint(body,{anchorWorld:[0,0,0]});
  let jointReads = 0, decoded = 0, breaks = 0;
  w.onBreak(() => { breaks++; });
  w.solver.readJoints = async () => { jointReads++; return new Float32Array(w.solver.jointCount*JOINT_FLOATS); };
  const first = w.read([]);
  assert.ok(j.slot >= 0); assert.equal(jointReads,0);
  const from = fake.writes.length;
  j.setWorldAnchor([1,2,3]);
  const result = await first;
  assert.equal(result.step,0); assert.equal(w.stepCount,0); assert.equal(fake.writes.length,from);
  const second = await w.read([]);
  assert.equal(second.step,0);
  assert.deepEqual(targetWrites(w,fake,from).map(x => floats(x.bytes)),[[1,2,3]]);
  assert.equal(jointReads,0);
  const b = w.addSphere({radius:.5})!;
  const ordinary = w.addJoint(body,b);
  ordinary.update = () => { decoded++; };
  await w.readJoints();
  assert.equal(jointReads,1); assert.equal(decoded,1); assert.equal(breaks,0);
  assert.ok(ordinary.a instanceof Body); assert.ok(ordinary.b instanceof Body);
  assert.equal(j.holding,true); assert.equal(w.stepCount,0); w.destroy();
});

test('remove releases a placed slot exactly once and append failure cancels unplaced handles safely', async () => {
  const {w,body} = await setup();
  const j = w.addWorldJoint(body,{anchorWorld:[0,0,0]}); w.flushCommands();
  const release = w.solver.releaseJoints.bind(w.solver); let releases = 0;
  w.solver.releaseJoints = slots => { releases++; release(slots); };
  j.remove(); j.remove(); body.remove(); assert.equal(releases,1);
  const b = w.addSphere({radius:.5})!;
  const placed = w.addWorldJoint(b,{anchorWorld:[0,0,0]});
  const failed = w.addWorldJoint(b,{anchorWorld:[0,0,0]});
  const untried = w.addWorldJoint(b,{anchorWorld:[0,0,0]});
  const append = w.solver.appendWorldJoint.bind(w.solver); let calls = 0;
  w.solver.appendWorldJoint = (...args) => { if (++calls === 2) throw new Error('allocation failure'); return append(...args); };
  assert.throws(() => w.flushCommands(),/allocation failure/);
  assert.equal(placed.holding,true); assert.equal(failed.holding,false); assert.equal(untried.holding,false);
  assert.equal((w as Any).pendingWorldJoints.length,0);
  assert.throws(() => failed.setWorldAnchor([1,2,3]));
  w.flushCommands(); assert.equal(calls,2); w.destroy();
});

test('non-finite f32 derived torque arms refuse before public queue or solver slot mutation', async () => {
  const fake = fakeDevice();
  const w = await World.create({device:fake.device,maxBodies:1});
  const body = w.addBox({size:[1e20,1,1],fixed:true})!;
  const before = snapshot(w,fake);
  assert.throws(() => w.addWorldJoint(body,{anchorWorld:[0,0,0]}), /torque arm.*finite/i);
  assert.deepEqual(snapshot(w,fake),before);
  w.flushCommands();
  const uploaded = snapshot(w,fake);
  assert.throws(() => w.solver.appendWorldJoint(body.index,[0,0,0],[0,0,0]), /torque arm.*finite/i);
  assert.deepEqual(snapshot(w,fake),uploaded);
  w.destroy();
});


test('opt-in metadata and lazy private preparation order survive sensor activation; legacy trace stays unchanged', async () => {
  assert.equal(createHash('sha256').update(solveWGSL).digest('hex'), 'f2228d885f039af67798bd759ce25dbfa927d290c9d8d149ae3419cda2ff5df3');
  const {w,body,fake} = await setup();
  w.iterations = 0;
  w.addWorldJoint(body,{anchorWorld:[0,0,0]}); w.flushCommands();
  w.solver.step();
  const before = { ...fake.counts }, bufferCount = fake.buffers.length;
  assert.equal(fake.trace.includes('prepareWorldAnchors'),false);
  const j = w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands();
  assert.equal(j.policy,'inertial-hard'); assert.throws(() => { (j as Any).policy = 'legacy'; },TypeError);
  assert.equal(fake.counts.pipelines,before.pipelines+1);
  assert.equal(fake.counts.bindGroups,before.bindGroups);
  assert.equal(fake.buffers.length,bufferCount);
  assert.deepEqual([...w.solver.jointInfo().slice(j.slot*4,j.slot*4+4)],[T_JOINT,-1,body.index,1]);
  const ordered = () => {
    fake.trace.length=0; w.solver.step();
    const a=fake.trace.indexOf('warmStartJoints'), b=fake.trace.indexOf('prepareWorldAnchors'), c=fake.trace.indexOf('warmStartBodies');
    assert.ok(a>=0 && b===a+1 && c===b+1,JSON.stringify(fake.trace));
  };
  ordered(); body.setSensor(true); w.flushCommands(); ordered();
  body.setEnabled(false); w.flushCommands(); fake.trace.length=0; w.solver.step(); assert.equal(fake.trace.includes('prepareWorldAnchors'),false);
  body.setEnabled(true); body.reset({position:[1,0,0]}); w.flushCommands(); ordered();
  body.setFixed(true); w.flushCommands(); fake.trace.length=0; w.solver.step(); assert.equal(fake.trace.includes('prepareWorldAnchors'),false);
  body.setFixed(false); w.flushCommands(); ordered();
  j.remove(); fake.trace.length=0; w.solver.step(); assert.equal(fake.trace.includes('prepareWorldAnchors'),false);
  w.destroy(); const writes=fake.writes.length; assert.throws(()=>w.solver.step(),/destroyed/); assert.equal(fake.writes.length,writes);
});

test('policy numerical admissions and body/dt transitions reject before all intent, slots or writes', async () => {
  const {w,body,fake} = await setup();
  for (const options of [
    {anchorWorld:[0,0,0],policy:null}, {anchorWorld:[0,0,0],policy:'unknown'},
    {anchorWorld:[256,0,0],policy:'inertial-hard'}, {anchorWorld:[0,0,0],anchorBody:[0,256,0],policy:'inertial-hard'},
  ]) {
    const before=snapshot(w,fake); assert.throws(()=>w.addWorldJoint(body,options as Any)); assert.deepEqual(snapshot(w,fake),before);
  }
  const j=w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'});
  for (const change of [()=>{w.dt=1e-10;},()=>j.setWorldAnchor([256,0,0]),()=>body.set({position:[256,0,0]}),()=>body.reset({position:[256,0,0]})]) {
    const before=snapshot(w,fake), state=structuredClone(body.state), dt=w.dt;
    assert.throws(change); assert.deepEqual(snapshot(w,fake),before); assert.deepEqual(body.state,state); assert.equal(w.dt,dt);
  }
  body.setFixed(true); w.dt=1e-10;
  const before=snapshot(w,fake); assert.throws(()=>body.setFixed(false)); assert.equal(body.fixed,true); assert.deepEqual(snapshot(w,fake),before);
  w.dt=1/120; body.setFixed(false); w.flushCommands();
  assert.equal(worldAnchorFloor({mass:1,moments:[1,2,3]},1/120,[0,.5,0]), Math.fround(1/Math.fround(Math.fround(1/120)**2)));
  for (const material of [{mass:1e-40,moments:[1,1,1]},{mass:1,moments:[0,1,1]},{mass:1,moments:[1e-40,1,1]},{mass:1,moments:[1e30,1,1]}]) assert.throws(()=>worldAnchorFloor(material,1/120,[0,0,0]));
  assert.equal(worldAnchorFloor({mass:0,moments:[0,0,0]},1e-30,[0,0,0]),0);
  w.destroy();
});

for (const fixed of [false,true]) test(`policy slot lifetime and ordinary reuse (${fixed ? 'fixed' : 'adaptive'})`,async()=>{
  const {w,body,fake}=await setup(fixed), other=w.addSphere({radius:.5})!;
  const j=w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands(); const slot=j.slot;
  j.setWorldAnchor([1,2,3]); const p:Vec3=[2,3,4]; j.setWorldAnchor(p); p[0]=99; w.flushCommands();
  assert.deepEqual(floats(targetWrites(w,fake).at(-1)!.bytes),[2,3,4]);
  j.remove(); assert.equal(w.solver.jointInfo()[slot*4+3],0);
  const ordinary=w.addJoint(body,other); w.flushCommands(); assert.equal(ordinary.slot,slot); assert.equal(w.solver.jointInfo()[slot*4+3],0);
  assert.equal((w.solver as Any).worldAnchorRows.size,0);
  ordinary.remove();
  const again=w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands(); assert.equal(again.slot,slot);
  body.remove(); assert.equal(again.holding,false); assert.equal((w.solver as Any).worldAnchorRows.size,0);
  w.destroy();
});

test('failed lazy setup leaves solver slots and writes intact and a new handle can retry',async()=>{
  const {w,body,fake}=await setup(); w.flushCommands();
  fake.faults.policyPipeline=true;
  const before=snapshot(w,fake);
  assert.throws(()=>w.solver.appendWorldJoint(body.index,[0,0,0],[0,0,0],'inertial-hard'),/pipeline failure/);
  assert.deepEqual(snapshot(w,fake),before); assert.equal((w.solver as Any).worldAnchorPipeline,null);
  fake.faults.policyPipeline=false;
  const j=w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands(); assert.ok(j.holding); assert.equal(j.slot,0);
  w.destroy();
});


test('adaptive growth copies policy metadata and rebinds the existing solve layout without a new binding',async()=>{
  const {w,body,fake}=await setup();
  const j=w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands();
  const solver=w.solver as Any, old=solver.jointBuffer, initial=solver.jointCapacity;
  const other=w.addSphere({radius:.5})!; w.flushCommands();
  for(let i=1;i<=initial;i++) w.addJoint(body,other);
  w.flushCommands(); assert.notEqual(solver.jointBuffer,old); assert.ok(solver.jointCapacity>initial);
  assert.equal(w.solver.jointInfo()[j.slot*4+3],1);
  const pipeline=fake.pipelines.find(p=>p.label==='prepareWorldAnchors');
  assert.deepEqual(pipeline.layout.bindGroupLayouts,[solver.layouts.solve,solver.layouts.pass]);
  assert.equal(solver.layouts.solve.entries.filter((e:Any)=>e.buffer.type!=='uniform').length,8);
  for(const group of solver.groups.solve) assert.equal(group.entries.find((e:Any)=>e.binding===2).resource.buffer,solver.jointBuffer);
  fake.trace.length=0; w.solver.step(); assert.ok(fake.trace.includes('prepareWorldAnchors'));
  j.remove(); w.destroy();
});

test('opt-in pool lease destruction never revives a policy on the reused numeric body slot',async()=>{
  const {w,fake}=await setup(true);
  const result=await BodyPool.create(w,{capacity:1,template:{kind:'sphere',options:{radius:.5}}}); assert.ok(result.ok);
  const acquire=()=>{const a=result.pool.tryAcquire({position:[0,0,0],rotation:[0,0,0,1]}); assert.ok(a.ok);return a.body;};
  const b=acquire(), j=w.addWorldJoint(b,{anchorWorld:[0,0,0],policy:'inertial-hard'}); w.flushCommands();
  j.setWorldAnchor([1,0,0]); result.pool.release(b); const fresh=acquire();
  assert.equal(fresh.index,b.index);assert.notEqual(fresh.id,b.id);assert.equal(j.holding,false);
  w.flushCommands(); const from=fake.writes.length;
  assert.throws(()=>j.setWorldAnchor([2,0,0])); w.flushCommands();assert.equal(fake.writes.length,from);
  assert.equal((w.solver as Any).worldAnchorRows.size,0);
  const next=w.addWorldJoint(fresh,{anchorWorld:[0,0,0]}); w.flushCommands();assert.equal(w.solver.jointInfo()[next.slot*4+3],0);
  result.pool.dispose();w.destroy();
});

test('opt-in refuses unsupported backend admission and nonfinite inertial properties before mutation',async()=>{
  const {w,body,fake}=await setup();
  for(const key of ['customShaders','sensorProof','collisionBackend']) {
    const s=w.solver as Any, prior=s[key]; s[key]=key==='collisionBackend'?{}:true;
    if(key==='sensorProof') {
      w.flushCommands(); const before=snapshot(w,fake);
      assert.throws(()=>w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}),/standard/);
      assert.throws(()=>s.appendWorldJoint(body.index,[0,0,0],[0,0,0],'inertial-hard'),/standard/);
      assert.deepEqual(snapshot(w,fake),before);
    } else {
      const before=snapshot(w,fake);assert.throws(()=>w.addWorldJoint(body,{anchorWorld:[0,0,0],policy:'inertial-hard'}),/standard/);assert.deepEqual(snapshot(w,fake),before);
    }
    s[key]=prior;
  }
  const invalid=w.addSphere({radius:.5,massProperties:{mass:1e-40,moments:[1,1,1]}})!;
  const before=snapshot(w,fake);assert.throws(()=>w.addWorldJoint(invalid,{anchorWorld:[0,0,0],policy:'inertial-hard'}));assert.deepEqual(snapshot(w,fake),before);
  w.destroy();
});
