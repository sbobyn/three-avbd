// Pure CPU checks: never import tests-gpu/device or instantiate a GPU pass.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticField } from '../src/avbd3d/ref/sdf/shapes.ts';
import { VoxelField } from '../src/avbd3d/ref/sdf/voxel.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { collisionParams } from '../src/avbd3d/ref/sdf/manifold.ts';
import { packSdfAtlas, packSdfBodies, packSdfPairs, packSdfParams, decodeSdfResults, sdfResultWords, SDF_RESULT_WORDS, SDF_NO_CACHE } from '../src/avbd3d/gpu/sdf-layout.ts';
import { sdfRayLipschitz } from '../src/avbd3d/gpu/sdf-raycast.ts';
import { SdfNarrowphasePass } from '../src/avbd3d/gpu/sdf-pass.ts';

test('SDF GPU atlas round-trips mixed metadata, grids, seeds and deduplicated fields on CPU', () => {
  const box = new AnalyticField({ kind: 'box', halfExtents: [1,2,3] }); box.seeds=[[1,2,3]];
  const grid = Float32Array.from({length:32},(_,i)=>i/8);
  const voxel = new VoxelField([2,2,2],[-1,-1,-1],.5,grid,{min:[-1,-1,-1],max:[-.5,-.5,-.5]});
  voxel.centerOfMass=[-.75,-.75,-.75];
  const atlas=packSdfAtlas([box,voxel,box]), u=atlas.data, f=new Float32Array(u.buffer);
  assert.equal(atlas.offsets.size,2); assert.equal(u[0],0); assert.equal(u[1],1);
  assert.deepEqual(Array.from(f.slice(20,23)),[1,2,3]); assert.deepEqual(Array.from(f.slice(u[2]*4,u[2]*4+3)),[1,2,3]);
  const h=atlas.offsets.get(voxel)!*4; assert.equal(u[h],7); assert.deepEqual(Array.from(u.slice(h+5,h+8)),[2,2,2]);
  assert.deepEqual(f.slice(u[h+4]*4,u[h+4]*4+32),grid);
  assert.deepEqual(Array.from(f.slice(h+16,h+19)),[-.75,-.75,-.75]);
  const body=new SdfBody(voxel,[3,4,5],[0,0,0,1],2); const packed=packSdfBodies([body],atlas), bf=new Float32Array(packed.buffer);
  assert.equal(packed[15],h/4); assert.deepEqual(Array.from(bf.slice(16,19)),body.bounds.min); assert.deepEqual(Array.from(bf.slice(20,23)),body.bounds.max);
});

test('SDF GPU host packing rejects unsafe atlas sizes, unsupported fields and stale pair slots', () => {
  const box=new AnalyticField({kind:'box',halfExtents:[1,1,1]});
  assert.throws(()=>packSdfAtlas([box],16),/limit/);
  const custom={...box,sample:box.sample.bind(box)}; assert.throws(()=>packSdfAtlas([custom]),/Unsupported/);
  box.seeds=[[Infinity,0,0]]; assert.throws(()=>packSdfAtlas([box]),/finite/); box.seeds=[];
  assert.throws(()=>packSdfBodies([new SdfBody(box)],packSdfAtlas([])),/absent/);
  assert.deepEqual(Array.from(packSdfPairs([{a:0,b:1,key:7}],2,0)),[0,1,7,SDF_NO_CACHE]);
  assert.throws(()=>packSdfPairs([{a:0,b:1,key:7,previous:0}],2,0),/previous/);
  assert.throws(()=>packSdfPairs([{a:0,b:1,key:7},{a:1,b:0,key:7}],2,0),/unique/);
  assert.throws(()=>packSdfPairs([{a:0,b:0,key:1}],2,0),/body/);
});

test('SDF GPU uniforms enforce bounded workloads and preserve dimensional settings', () => {
  const params=collisionParams(), words=packSdfParams(3,7,1/60,params), f=new Float32Array(words.buffer);
  assert.equal(words.byteLength,80); assert.deepEqual(Array.from(words.slice(0,4)),[3,7,4,1]);
  assert.equal(new Float32Array(packSdfParams(1,0,.01,{...params,epsilon:0}).buffer)[5],0);
  assert.equal(f[5],params.epsilon); assert.equal(f[8],params.margin);
  assert.equal(words[16],0); assert.equal(f[17],0);
  const sgd=packSdfParams(1,0,.01,{...params,optimizer:2,stepSize:.25}); assert.equal(sgd[16],2); assert.equal(new Float32Array(sgd.buffer)[17],.25); assert.equal(sgd[18],0);
  assert.equal(packSdfParams(1,0,.01,{...params,optimizer:2,sgdGradientStopOnly:true})[18],1);
  assert.equal(packSdfParams(1,0,.01,{...params,sgdGradientStopOnly:true})[18],0,'the SGD stop flag is only uploaded for SGD');
  for(const patch of [{cacheSize:5},{randomSamples:2},{maxIterations:513},{epsilon:-1},{epsilon:Infinity},{epsilon:NaN},{epsilon:1e-50},{tolerance:NaN}]) assert.throws(()=>packSdfParams(1,0,.01,{...params,...patch}));
  assert.throws(()=>packSdfParams(1,0,.01,{...params,optimizer:3 as unknown as 0}),/Unknown SDF optimizer/);
  for(const stepSize of [0,NaN,Infinity,1e-50]) {
    assert.throws(()=>packSdfParams(1,0,.01,{...params,optimizer:2,stepSize}),/stepSize/);
    for(const optimizer of [0,1] as const) assert.equal(new Float32Array(packSdfParams(1,0,.01,{...params,optimizer,stepSize}).buffer)[17],0,'stepSize is unused and not uploaded outside gradient descent');
  }
});

test('SDF GPU output decoder retains contact identity, independent normal and body anchors', () => {
  const buffer=new ArrayBuffer(SDF_RESULT_WORDS*4), u=new Uint32Array(buffer), f=new Float32Array(buffer);
  u.set([2,3,77,1,123,45,99,0]); f.set([1,2,3,-.1,0,1,0,-.2,4,5,6,.3,7,8,9,.4],8); u.set([1,1,99,0],24);
  const [result]=decodeSdfResults(buffer,1); assert.equal(result.queries,123); assert.equal(result.points[0].id,99);
  assert.deepEqual(result.points[0].normal,[0,1,0]); assert.deepEqual(result.points[0].anchorB,[7,8,9]); assert.equal(result.points[0].cached,true);
  u[3]=6; assert.throws(()=>decodeSdfResults(buffer,1),/count/);
  assert.throws(()=>decodeSdfResults(new ArrayBuffer(4),1),/short/);
});

test('SDF GPU creation rejects invalid capacities before touching the device', async () => {
  const device=new Proxy({}, {get(){throw new Error('Device must not be touched');}}) as GPUDevice;
  await assert.rejects(SdfNarrowphasePass.create(device,[],{maxBodies:0,maxPairs:1}),/capacities/);
});

test('SDF dispatch host lifecycle swaps distinct result buffers and bounds uploads using a CPU mock', async () => {
  // This is a JS protocol mock: no WebGPU binding, adapter, or shader compiler.
  Object.assign(globalThis,{GPUBufferUsage:{STORAGE:1,COPY_DST:2,COPY_SRC:4,UNIFORM:8},GPUMapMode:{READ:1}});
  const uploads: number[]=[], groups: unknown[][]=[], dispatched: number[]=[], buffers: {destroyed:boolean}[]=[];
  const device={
    limits:{maxBufferSize:1<<20,maxStorageBufferBindingSize:1<<20,maxComputeWorkgroupsPerDimension:65535,maxStorageBuffersPerShaderStage:8,maxComputeInvocationsPerWorkgroup:256},
    createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),
    createComputePipelineAsync:async()=>({getBindGroupLayout:()=>({})}),
    createBuffer:()=>{const buffer={destroyed:false,destroy(){this.destroyed=true;}};buffers.push(buffer);return buffer;},
    createBindGroup:(d:{entries:{resource:{buffer:unknown}}[]})=>{groups.push(d.entries.map(e=>e.resource.buffer));return {};},
    createCommandEncoder:()=>({beginComputePass:()=>({setPipeline(){},setBindGroup(){},dispatchWorkgroups(n:number){dispatched.push(n);},end(){}}),finish:()=>({})}),
    queue:{writeBuffer:(_b:unknown,_o:number,data:Uint32Array)=>{uploads.push(data.byteLength);},submit(){}},
  } as unknown as GPUDevice;
  const field=new AnalyticField({kind:'sphere',radius:.5});
  const pass=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1});
  assert.notEqual(groups[0][4],groups[0][5]);assert.equal(groups[0][4],groups[1][5]);
  const bodies=[new SdfBody(field),new SdfBody(field,[.8,0,0])];
  pass.step(bodies,[{a:0,b:1,key:7}],1/60);pass.step(bodies,[{a:0,b:1,key:7,previous:0}],1/60);
  assert.deepEqual(dispatched,[1,1]);assert.ok(uploads.includes(80));
  pass.step(bodies,[],1/60);assert.deepEqual(await pass.readResults(),[]);
  assert.throws(()=>pass.step(bodies,[{a:0,b:1,key:7,previous:0}],1/60),/previous/);
  pass.destroy();pass.destroy();assert.ok(buffers.every(b=>b.destroyed));
  assert.throws(()=>pass.step(bodies,[],1/60),/disposed/);
});

test('SDF body upload rejects mutable scales that become zero or infinity in float32', () => {
  const field=new AnalyticField({kind:'sphere',radius:.5}), atlas=packSdfAtlas([field]), body=new SdfBody(field);
  for(const scale of [1e-50,1e40,NaN,Infinity,0,-1]) {
    body.scale=scale;
    assert.throws(()=>packSdfBodies([body],atlas),/transform/);
  }
  body.scale=.125;
  assert.equal(new Float32Array(packSdfBodies([body],atlas).buffer)[3],.125);
});

test('SDF failed construction disposes every acquired buffer and preserves the error', async () => {
  Object.assign(globalThis,{GPUBufferUsage:{STORAGE:1,COPY_DST:2,COPY_SRC:4,UNIFORM:8}});
  const field=new AnalyticField({kind:'sphere',radius:.5});
  // Every allocation and bind-group boundary, plus failure uploading the atlas.
  for(const failAt of ['buffer1','buffer2','buffer3','buffer4','buffer5','buffer6','upload','group1','group2']) {
    let allocation=0, group=0;
    const buffers:{destroyCalls:number;destroy():void}[]=[], failure=new Error(failAt);
    const device={
      limits:{maxBufferSize:1<<20,maxStorageBufferBindingSize:1<<20,maxComputeWorkgroupsPerDimension:65535,maxStorageBuffersPerShaderStage:8,maxComputeInvocationsPerWorkgroup:256},
      createShaderModule:()=>({getCompilationInfo:async()=>({messages:[]})}),
      createComputePipelineAsync:async()=>({getBindGroupLayout:()=>({})}),
      createBuffer:()=>{
        if(failAt===`buffer${++allocation}`) throw failure;
        const buffer={destroyCalls:0,destroy(){this.destroyCalls++;}};buffers.push(buffer);return buffer;
      },
      createBindGroup:()=>{if(failAt===`group${++group}`) throw failure;return {};},
      queue:{writeBuffer:()=>{if(failAt==='upload') throw failure;}},
    } as unknown as GPUDevice;
    await assert.rejects(SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1}),error=>error===failure);
    assert.ok(buffers.every(b=>b.destroyCalls===1),`leak/double-disposal at ${failAt}`);
    assert.equal(buffers.length,failAt.startsWith('buffer')?Number(failAt.slice(6))-1:failAt==='upload'?1:6);
  }
});


test('SDF ray slope bounds cover warped gradients and use the immutable atlas snapshot',()=>{
  for(const type of [0,1,2] as const) {
    const field=new AnalyticField({kind:'warp',type,halfExtents:[1,2,1],k:2});
    const atlas=packSdfAtlas([field]), bound=sdfRayLipschitz(atlas,0);
    for(let x=-1;x<=1;x+=.25)for(let y=-2;y<=2;y+=.25)for(let z=-1;z<=1;z+=.25)
      assert.ok(Math.hypot(...field.sample([x,y,z]).gradient)<=bound);
    field.spec.kind==='warp'&&(field.spec.k=100);
    assert.equal(sdfRayLipschitz(atlas,0),bound,'user field mutation cannot alter packed bound');
  }
});

test('GPU SDF point capacity scales parameter bounds and result decoding',()=>{
  const params=collisionParams();
  // Default capacity: four cached plus one sample, unchanged.
  assert.throws(()=>packSdfParams(1,0,.01,{...params,cacheSize:5}));
  // The paper's widest sweep (16 cached + 4 samples) needs a 20-point pass.
  assert.doesNotThrow(()=>packSdfParams(1,0,.01,{...params,cacheSize:16,randomSamples:4},20));
  assert.throws(()=>packSdfParams(1,0,.01,{...params,cacheSize:17,randomSamples:4},20),/at most 19 cached\/20 total/);
  assert.throws(()=>packSdfParams(1,0,.01,{...params,cacheSize:20,randomSamples:0},20),/at most 19 cached/);
  for(const bad of [1,21,4.5])assert.throws(()=>packSdfParams(1,0,.01,params,bad),/point capacity/);
  assert.equal(sdfResultWords(),SDF_RESULT_WORDS);assert.equal(sdfResultWords(20),8+20*28);
  const words=sdfResultWords(20),buffer=new ArrayBuffer(2*words*4),u=new Uint32Array(buffer);
  u[3]=0;u[words+3]=12;for(let j=0;j<12;j++)u[words+8+j*28+18]=100+j;
  const [first,second]=decodeSdfResults(buffer,2,20);
  assert.equal(first.points.length,0);assert.deepEqual(second.points.map(p=>p.id),Array.from({length:12},(_,j)=>100+j));
  u[words+3]=21;assert.throws(()=>decodeSdfResults(buffer,2,20),/count/);
});
