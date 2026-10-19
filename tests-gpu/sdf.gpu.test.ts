import { collisionParams } from '../src/avbd3d/ref/sdf/manifold.ts';
// Small standalone SDF GPU validation; production solver integration is separate.
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { gpuTest } from './device.ts';
import { AnalyticField, type Field } from '../src/avbd3d/ref/sdf/shapes.ts';
import { VoxelField } from '../src/avbd3d/ref/sdf/voxel.ts';
import { bakeVoxelSdf } from '../src/avbd3d/ref/sdf/bake.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { packSdfAtlas, packSdfBodies } from '../src/avbd3d/gpu/sdf-layout.ts';
import { SDF_FIELDS_WGSL } from '../src/avbd3d/gpu/wgsl-sdf-fields.ts';
import { SdfNarrowphasePass } from '../src/avbd3d/gpu/sdf-pass.ts';

const probeWGSL = `
struct Body { position: vec4f, rotation: vec4f, velocity: vec4f, omega: vec4f, lo: vec4f, hi: vec4f, anchorRotation: vec4f }
@group(0) @binding(0) var<storage,read> atlas: array<vec4u>;
@group(0) @binding(1) var<storage,read> bodies: array<Body>;
@group(0) @binding(2) var<storage,read> queries: array<vec4f>;
@group(0) @binding(3) var<storage,read_write> samples: array<vec4f>;
${SDF_FIELDS_WGSL}
@compute @workgroup_size(64) fn probe(@builtin(global_invocation_id) id: vec3u) {
 if(id.x>=arrayLength(&queries)) { return; }
 let q=queries[id.x]; let s=worldField(bodies[u32(q.w)],q.xyz); samples[id.x]=vec4f(s.phi,s.gradient);
}`;

gpuTest('SDF WGSL primitive/warp/voxel samples match CPU under COM rotation and scale', async device => {
  const fields: Field[]=[
    new AnalyticField({kind:'box',halfExtents:[.5,.3,.4]}),new AnalyticField({kind:'sphere',radius:.5}),
    new AnalyticField({kind:'capsule',radius:.3,halfLength:.4}),new AnalyticField({kind:'cylinder',radius:.4,halfHeight:.3}),
    new AnalyticField({kind:'cone',radius:.5,halfHeight:.4}),new AnalyticField({kind:'torus',majorRadius:.5,minorRadius:.2}),
    ...([0,1,2] as const).map(type=>new AnalyticField({kind:'warp',type,halfExtents:[.8,.3,.4],k:.2})),
    new AnalyticField({kind:'spike-plate',halfExtents:[.7,.08,.7],count:10,spikeRadius:.045,minHeight:.12,maxHeight:.26}),
    new AnalyticField({kind:'spiky-wheel',hubRadius:.35,hubHalfWidth:.48,spikeRadius:.08,spikeHalfHeight:.7,spikes:16}),
    bakeVoxelSdf(new BoxGeometry(),{resolution:8}).field,
  ];
  fields.forEach(field=>{field.centerOfMass=[.03,-.02,.01];});
  const bodies=fields.map(field=>new SdfBody(field,[2,3,4],[0,Math.sin(.3),0,Math.cos(.3)],1.5));
  const atlas=packSdfAtlas(fields); const queries: number[]=[], expected: number[]=[];
  bodies.forEach((body,b)=>{
    for(const p of [[.13,.17,.21],[.63,.27,-.43],[-.31,.73,.19],[1.3,-.9,.6]] as [number,number,number][]) {
      const world=body.toWorld(p), sample=body.sample(world); queries.push(...world,b); expected.push(sample.phi,...sample.gradient);
    }
  });
  const buffers: GPUBuffer[]=[];
  const upload=(data:Uint32Array<ArrayBuffer>|Float32Array<ArrayBuffer>)=>{const b=device.createBuffer({size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data);buffers.push(b);return b;};
  try {
    const inputs=[upload(atlas.data),upload(packSdfBodies(bodies,atlas)),upload(new Float32Array(queries))];
    const out=device.createBuffer({size:expected.length*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});buffers.push(out);
    const read=device.createBuffer({size:expected.length*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});buffers.push(read);
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:probeWGSL}),entryPoint:'probe'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[...inputs,out].map((buffer,binding)=>({binding,resource:{buffer}}))});
    const encoder=device.createCommandEncoder(), pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(queries.length/4/64));pass.end();
    encoder.copyBufferToBuffer(out,0,read,0,expected.length*4);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const actual=new Float32Array(read.getMappedRange());actual.forEach((v,i)=>assert.ok(Math.abs(v-expected[i])<2e-4,`field word ${i}: ${v} vs ${expected[i]}`));
  } finally { buffers.forEach(b=>b.destroy()); }
});

gpuTest('SDF pass compiles, emits sphere contacts, remaps cache and rejects stale pair keys', async device => {
  const sphere=new AnalyticField({kind:'sphere',radius:.5});
  const bodies=[new SdfBody(sphere),new SdfBody(sphere,[.8,0,0]),new SdfBody(sphere,[-.8,0,0])];
  const pass=await SdfNarrowphasePass.create(device,[sphere],{maxBodies:3,maxPairs:2});
  try {
    pass.step(bodies,[{a:0,b:1,key:10},{a:0,b:2,key:20}],1/60);const first=await pass.readResults();
    first.forEach((r,i)=>{assert.ok(r.points.some(p=>p.active));assert.ok(r.points.every(p=>Math.abs(Math.hypot(...p.normal)-1)<1e-4));assert.equal(r.key,i?20:10);assert.ok(r.queries>0);});
    pass.step(bodies,[{a:0,b:2,key:20,previous:1},{a:0,b:1,key:10,previous:0}],1/60);const second=await pass.readResults();
    second.forEach((r,i)=>{const old=first[1-i];assert.ok(r.points.some(p=>p.cached&&old.points.some(q=>q.id===p.id)));});
    pass.step(bodies,[{a:0,b:1,key:30,previous:0}],1/60);assert.ok((await pass.readResults())[0].points.every(p=>!p.cached));
    bodies[1].position=[10,0,0];pass.step(bodies,[{a:0,b:1,key:30,previous:0}],1/60);assert.equal((await pass.readResults())[0].points.length,0);
    pass.step(bodies,[],1/60);assert.deepEqual(await pass.readResults(),[]);
  } finally {pass.destroy();}
});

gpuTest('SDF optimized contact positions agree with CPU using the GPU per-pair seed policy', async device => {
  const { SdfManifold, collisionParams } = await import('../src/avbd3d/ref/sdf/manifold.ts');
  const { counters } = await import('../src/avbd3d/ref/sdf/optimize.ts');
  const { Random } = await import('../src/avbd3d/ref/sdf/math.ts');
  const hash=(input:number)=>{let x=input>>>0;x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return (x^(x>>>16))>>>0;};
  class PairRandom extends Random {
    value=hash(42^hash(0)^hash(0)^hash((1+0x9e3779b9)>>>0));
    override next():number {this.value=hash((this.value+0x9e3779b9)>>>0);return this.value;}
  }
  const floor=new AnalyticField({kind:'box',halfExtents:[1,.2,1]});
  const shapes:Field[]=[new AnalyticField({kind:'sphere',radius:.4}),new AnalyticField({kind:'torus',majorRadius:.4,minorRadius:.15}),bakeVoxelSdf(new BoxGeometry(),{resolution:8}).field];
  for(const shape of shapes) {
    const a=new SdfBody(floor,[0,0,0],[0,0,0,1],1,true),b=new SdfBody(shape,[.07,.3,.03]);
    const params={...collisionParams(),cacheSize:1,randomSamples:0,alpha:0};
    const cpu=new SdfManifold(a,b);cpu.update(params,1/60,new PairRandom(),counters());
    const pass=await SdfNarrowphasePass.create(device,[floor,shape],{maxBodies:2,maxPairs:1});
    try {
      pass.step([a,b],[{a:0,b:1,key:42}],1/60,params);const [actual]=await pass.readResults();
      assert.equal(actual.points.length,cpu.points.length);
      actual.points.forEach((p,i)=>{
        assert.ok(Math.hypot(...p.x.map((v,j)=>v-cpu.points[i].x[j]))<=2*params.tolerance);
        assert.equal(p.active,cpu.points[i].active);
        assert.ok(Math.abs(p.separation-cpu.points[i].separation)<=2*params.tolerance);
      });
    } finally {pass.destroy();}
  }
});

gpuTest('SDF temporal CPU parity includes velocity advection, scaled anchors and cache resets', async device => {
  const { SdfManifold, collisionParams } = await import('../src/avbd3d/ref/sdf/manifold.ts');
  const { counters } = await import('../src/avbd3d/ref/sdf/optimize.ts');
  const { Random, rotate, plus } = await import('../src/avbd3d/ref/sdf/math.ts');
  const hash=(input:number)=>{let x=input>>>0;x=Math.imul(x^(x>>>16),0x7feb352d);x=Math.imul(x^(x>>>15),0x846ca68b);return (x^(x>>>16))>>>0;};
  class PairRandom extends Random {
    value: number;
    constructor(step:number) { super(); this.value=hash(42^hash(step)^hash(0)^hash((1+0x9e3779b9)>>>0)); }
    override next():number {this.value=hash((this.value+0x9e3779b9)>>>0);return this.value;}
  }
  const floor=new AnalyticField({kind:'box',halfExtents:[1,.2,1]});
  const voxel=bakeVoxelSdf(new BoxGeometry(),{resolution:8}).field;
  voxel.centerOfMass=[.03,-.02,.01];
  const shapes:Field[]=[new AnalyticField({kind:'sphere',radius:.4}),voxel];
  const dt=1/60;
  for(const shape of shapes) for(const staticSide of [-1,0,1]) {
    const a=new SdfBody(floor,[0,0,0],[0,0,0,1],1,staticSide===0);
    const b=new SdfBody(shape,[.07,.3,.03],[0,Math.sin(.15),0,Math.cos(.15)],.8,staticSide===1);
    a.velocity=[.03,0,.02]; a.angularVelocity=[0,.04,0];
    b.velocity=[-.04,0,.03]; b.angularVelocity=[0,-.06,0];
    const cpu=new SdfManifold(a,b), params={...collisionParams(),cacheSize:1,randomSamples:0,alpha:0};
    const pass=await SdfNarrowphasePass.create(device,[floor,shape],{maxBodies:2,maxPairs:1});
    let previousIds:number[]=[];
    try {
      for(let frame=0;frame<12;frame++) {
        for(const body of [a,b]) if(!body.isStatic) {
          body.position=body.position.map((v,i)=>Math.fround(v+dt*body.velocity[i])) as [number,number,number];
          const angle=(body===a?0:.3)+(frame+1)*dt*body.angularVelocity[1];
          body.orientation=[0,Math.fround(Math.sin(angle/2)),0,Math.fround(Math.cos(angle/2))];
        }
        // Drop contact for one frame, then re-enter. Disable warm starting later.
        const original=b.position;
        if(frame===5) b.position=[10,0,0];
        params.warmStart=frame!==9;
        cpu.update(params,dt,new PairRandom(frame),counters());
        pass.step([a,b],[{a:0,b:1,key:42,...(frame?{previous:0}:{})}],dt,params);
        const [result]=await pass.readResults();
        assert.equal(result.points.length,cpu.points.length,`count frame ${frame}, static ${staticSide}`);
        result.points.forEach((point,i)=>{
          const expected=cpu.points[i], label=`frame ${frame}, static ${staticSide}, point ${i}`;
          assert.ok(Math.hypot(...point.x.map((v,j)=>v-expected.x[j]))<=2*params.tolerance,label);
          assert.ok(Math.abs(point.separation-expected.separation)<=2*params.tolerance,label);
          assert.equal(point.active,expected.active,label); assert.equal(point.cached,expected.cached,label);
          assert.ok([...point.x,...point.normal,...point.anchorA,...point.anchorB,point.rank].every(Number.isFinite),label);
          assert.ok(Math.abs(Math.hypot(...point.normal)-1)<1e-4,label);
          if(point.cached) assert.ok(previousIds.includes(point.id),`persistent ID ${label}`);
          // Reconstruct each projected surface point from the COM-relative anchor.
          [a,b].forEach((body,index)=>{
            const anchor=(index?point.anchorB:point.anchorA) as [number,number,number];
            const world=plus(body.position,rotate(body.orientation,anchor));
            const sample=body.sample(point.x as [number,number,number]);
            const norm2=sample.gradient.reduce((sum,v)=>sum+v*v,0);
            const projected=point.x.map((v,j)=>v-sample.gradient[j]*sample.phi/Math.max(norm2,1e-8));
            assert.ok(Math.hypot(...world.map((v,j)=>v-projected[j]))<2e-4,`anchor ${index}, ${label}`);
          });
        });
        previousIds=result.points.map(p=>p.id); b.position=original;
      }
    } finally {pass.destroy();}
  }
});

gpuTest('SDF default manifolds preserve pair-scoped caches across workgroups and reorder', async device => {
  const { collisionParams } = await import('../src/avbd3d/ref/sdf/manifold.ts');
  const floor=new AnalyticField({kind:'box',halfExtents:[1,.2,1]});
  const ring=new AnalyticField({kind:'torus',majorRadius:.4,minorRadius:.15});
  // Explicit surface seeds exercise the GPU curvature reservoir, not only uniform draws.
  ring.seeds=[[.55,0,0],[-.55,0,0],[0,0,.55],[0,0,-.55]];
  const bodies=[new SdfBody(floor,[0,0,0],[0,0,0,1],1,true),new SdfBody(ring,[0,.2,0])];
  const params=collisionParams(), count=65;
  const pass=await SdfNarrowphasePass.create(device,[floor,ring],{maxBodies:2,maxPairs:count});
  try {
    pass.step(bodies,Array.from({length:count},(_,i)=>({a:0,b:1,key:i+100})),1/60,params);
    const first=await pass.readResults();
    assert.equal(first.length,count);
    assert.ok(first.some(r=>r.points.length>1),'exercise multiple surviving candidates');
    pass.step(bodies,Array.from({length:count},(_,i)=>({a:0,b:1,key:count-1-i+100,previous:count-1-i})),1/60,params);
    const second=await pass.readResults();
    second.forEach((result,i)=>{
      const old=first[count-1-i];
      assert.equal(result.key,old.key); assert.ok(result.points.length>0&&result.points.length<=5);
      assert.ok(result.points.some(p=>p.cached),'warm cache survives reorder');
      assert.equal(new Set(result.points.map(p=>p.id)).size,result.points.length);
      result.points.forEach((p,j)=>{
        assert.ok([...p.x,...p.normal,...p.anchorA,...p.anchorB,p.rank,p.separation].every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...p.normal)-1)<1e-4);
        assert.equal(p.active,p.separation<params.margin);
        if(p.cached) assert.ok(old.points.slice(0,params.cacheSize).some(q=>q.id===p.id));
        if(j) assert.ok(result.points[j-1].rank<=p.rank,'rank sorted');
        for(const q of result.points.slice(0,j)) assert.ok(Math.hypot(...p.x.map((v,k)=>v-q.x[k]))>=params.tolerance*.9999,'no duplicate points');
      });
    });
    // Static-static pairs emit no contacts, including a previously populated cache.
    bodies[1].isStatic=true;
    pass.step(bodies,[{a:0,b:1,key:second[0].key,previous:0}],1/60,params);
    assert.equal((await pass.readResults())[0].points.length,0);
  } finally {pass.destroy();}
});

gpuTest('signed SDF static-box separation keeps mixed-sample penetration negative', async device=>{
  const sphere=new AnalyticField({kind:'sphere',radius:.5}); sphere.seeds=[];
  const floor=new AnalyticField({kind:'box',halfExtents:[4,.2,4]}); floor.seeds=[];
  const bodies=[new SdfBody(sphere,[0,.4,0]),new SdfBody(floor,[0,-.2,0],[0,0,0,1],1,true)];
  const pass=await SdfNarrowphasePass.create(device,[sphere,floor],{maxBodies:2,maxPairs:1});
  try {
    let mixed=0,negative=0;
    for(let step=0;step<16;step++){
      pass.step(bodies,[{a:0,b:1,key:1}],0,{...collisionParams(),signedSeparation:true,maxIterations:1,cacheSize:0,randomSamples:1});
      const [result]=await pass.readResults();
      for(const p of result.points){
        const a=bodies[0].sample(p.x as [number,number,number]),b=bodies[1].sample(p.x as [number,number,number]);
        if(a.phi<=0 || b.phi>=0)continue;
        mixed++;
        const scale=a.phi/a.gradient.reduce((s,v)=>s+v*v,0);
        const projectedY=p.x[1]-a.gradient[1]*scale;
        assert.ok(Math.abs(p.separation-projectedY)<1e-5,`${p.separation} vs surface height ${projectedY}`);
        if(projectedY<0){negative++;assert.ok(p.active);}
      }
    }
    assert.ok(mixed>0 && negative>0,'exercise mixed samples with embedded surfaces');
  }finally{pass.destroy();}
});

gpuTest('signed SDF static-box separation stays bounded where the moving gradient vanishes', async device=>{
  // Constant phi with a tiny downward gradient: real overlap is at most 35 mm, the unguarded projection ~-25 cm.
  const grid=new Float32Array(3*3*3*4);
  for(let i=0;i<27;i++)grid.set([-.005,0,-.02,0],i*4);
  const degenerate=new VoxelField([3,3,3],[-.05,-.05,-.05],.05,grid,{min:[-.05,-.05,-.05],max:[.05,.05,.05]}); degenerate.seeds=[];
  const floor=new AnalyticField({kind:'box',halfExtents:[4,.2,4]}); floor.seeds=[];
  const bodies=[new SdfBody(degenerate,[0,.02,0]),new SdfBody(floor,[0,-.2,0],[0,0,0,1],1,true)];
  const pass=await SdfNarrowphasePass.create(device,[degenerate,floor],{maxBodies:2,maxPairs:1});
  try {
    let mixed=0;
    for(let step=0;step<16;step++){
      pass.step(bodies,[{a:0,b:1,key:1}],0,{...collisionParams(),signedSeparation:true,maxIterations:1,cacheSize:0,randomSamples:1});
      const [result]=await pass.readResults();
      for(const p of result.points){
        if(bodies[0].sample(p.x as [number,number,number]).phi<=0&&bodies[1].sample(p.x as [number,number,number]).phi>0)mixed++;
        assert.ok(Number.isFinite(p.separation)&&p.separation>-.05,`bounded separation ${p.separation}`);
      }
    }
    assert.ok(mixed>0,'exercise mixed samples');
  }finally{pass.destroy();}
});

gpuTest('SDF point ids skip the built-in SPHERE_FEATURE key', async device=>{
  const {SPHERE_FEATURE}=await import('../src/avbd3d/gpu/layout.ts');
  const a=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]}),b=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]});a.seeds=[];b.seeds=[];
  const bodies=[new SdfBody(a,[0,0,0]),new SdfBody(b,[0,.95,0])];
  const pass=await SdfNarrowphasePass.create(device,[a,b],{maxBodies:2,maxPairs:1});
  const params={...collisionParams(),cacheSize:0,randomSamples:1,maxIterations:1};
  try {
    pass.step(bodies,[{a:0,b:1,key:1}],0,params);await pass.readResults();
    // Result slot 0, stats.z (word 6) is the per-pair id counter the next step continues from.
    device.queue.writeBuffer(pass.storage.current,6*4,new Uint32Array([SPHERE_FEATURE-1]));
    pass.step(bodies,[{a:0,b:1,key:1,previous:0}],0,params);
    const [result]=await pass.readResults();
    assert.equal(result.points.length,1);
    assert.equal(result.points[0].id,SPHERE_FEATURE+1,'the next new id steps over SPHERE_FEATURE');
  }finally{pass.destroy();}
});

gpuTest('GPU SDF ellipsoid and gradient-descent optimizers match the verified CPU reference', async device=>{
  const {objectiveGradient,ellipsoidMethod,diagonal}=await import('../src/avbd3d/ref/sdf/optimize.ts');
  const {counters}=await import('../src/avbd3d/ref/sdf/optimize.ts');
  const {intersection,size,plus,scale,minus,length}=await import('../src/avbd3d/ref/sdf/math.ts');
  const a=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]}),b=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]});
  const bodies=[new SdfBody(a,[0,0,0]),new SdfBody(b,[.35,.1,0],[0,0,.258819045,.965925826])];
  const domain=intersection(bodies[0].bounds,bodies[1].bounds),seed=scale(plus(domain.min,domain.max),.5);
  // One curvature seed inside V makes the GPU's stochastic sample deterministic.
  a.seeds=[seed];b.seeds=[];
  const params={...collisionParams(),margin:0,cacheSize:0,randomSamples:1};
  const pass=await SdfNarrowphasePass.create(device,[a,b],{maxBodies:2,maxPairs:1});
  try {
    // CPU reference (pinned to upstream fixtures) from the same seed and domain.
    const g=objectiveGradient(bodies[0],bodies[1],[],params.epsilon,params.alpha,counters());
    const extent=plus(scale(size(domain),.5),minus(seed,scale(plus(domain.min,domain.max),.5)).map(Math.abs) as [number,number,number]);
    const cpu=ellipsoidMethod(g,seed,domain,diagonal(extent.map(e=>e*e*3) as [number,number,number]),params.tolerance,params.maxIterations);
    pass.step(bodies,[{a:0,b:1,key:1}],0,{...params,optimizer:1});
    const [ellipsoid]=await pass.readResults();
    assert.equal(ellipsoid.points.length,1);
    assert.ok(length(minus(ellipsoid.points[0].x as [number,number,number],cpu.x))<=params.tolerance,`GPU ${ellipsoid.points[0].x} vs CPU ${cpu.x}`);
    assert.ok(Math.abs(ellipsoid.iterations-cpu.iterations)<=2,`iterations GPU ${ellipsoid.iterations} vs CPU ${cpu.iterations}`);
    // Gradient descent: its noise uses the GPU stream (seeded by pair key and step index), so check
    // improvement, and repeatability on fresh passes at the same step.
    const run=async()=>{const fresh=await SdfNarrowphasePass.create(device,[a,b],{maxBodies:2,maxPairs:1});
      try{fresh.step(bodies,[{a:0,b:1,key:2}],0,{...params,optimizer:2});return (await fresh.readResults())[0];}finally{fresh.destroy();}};
    const first=await run(),second=await run();
    assert.ok(first.iterations>0);
    assert.ok(g(first.points[0].x as [number,number,number]).value<g(seed).value,'descent improves on the seed');
    assert.deepEqual(second.points[0].x,first.points[0].x,'repeatable for the same pair key and step');
  } finally {pass.destroy();}
});

gpuTest('GPU SDF ellipsoid warm start matches the CPU blend for a cached point', async device=>{
  const {objectiveGradient,ellipsoidMethod,diagonal,blendEllipsoids,counters}=await import('../src/avbd3d/ref/sdf/optimize.ts');
  const {intersection,size,plus,scale,minus,length}=await import('../src/avbd3d/ref/sdf/math.ts');
  type V3=[number,number,number];
  const a=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]}),b=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]});
  const bodies=[new SdfBody(a,[0,0,0]),new SdfBody(b,[.35,.1,0],[0,0,.258819045,.965925826])];
  const domain=intersection(bodies[0].bounds,bodies[1].bounds),center=scale(plus(domain.min,domain.max),.5);
  a.seeds=[plus(center,[.05,-.03,.02])];b.seeds=[];
  const base={...collisionParams(),optimizer:1 as const,margin:0,cacheSize:1};
  const pass=await SdfNarrowphasePass.create(device,[a,b],{maxBodies:2,maxPairs:1});
  // Raw first point of the current result: position (words 8-10) and stored ellipsoid (28-33).
  const raw=async()=>{const bytes=(8+28)*4,read=device.createBuffer({size:bytes,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(pass.storage.current,0,read,0,bytes);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const f=new Float32Array(read.getMappedRange().slice(0));read.destroy();
    const e=f.slice(28,34);return {x:Array.from(f.slice(8,11)) as V3,E:[[e[0],e[1],e[2]],[e[1],e[3],e[4]],[e[2],e[4],e[5]]] as [V3,V3,V3]};};
  try {
    pass.step(bodies,[{a:0,b:1,key:1}],0,{...base,randomSamples:1});
    const [first]=await pass.readResults();assert.equal(first.points.length,1);
    const stored=await raw(),id=first.points[0].id;
    // Static bodies: the cached seed is the stored position. No new samples, so no repulsion.
    pass.step(bodies,[{a:0,b:1,key:1,previous:0}],0,{...base,randomSamples:0});
    const [second]=await pass.readResults();
    const point=second.points.find(p=>p.cached&&p.id===id);assert.ok(point,'the step-1 point is re-optimized as cached');
    const g=objectiveGradient(bodies[0],bodies[1],[],base.epsilon,base.alpha,counters());
    const extent=plus(scale(size(domain),.5),minus(stored.x,center).map(Math.abs) as V3);
    const fresh=diagonal(extent.map(e=>e*e*3) as V3),cold=ellipsoidMethod(g,stored.x,domain,fresh,base.tolerance,base.maxIterations);
    const cpu=ellipsoidMethod(g,stored.x,domain,blendEllipsoids(stored.E,fresh),base.tolerance,base.maxIterations);
    assert.ok(length(minus(point.x as V3,cpu.x))<=base.tolerance,`GPU ${point.x} vs CPU ${cpu.x}`);
    assert.ok(Math.abs(second.iterations-cpu.iterations)<=2,`iterations GPU ${second.iterations} vs CPU warm ${cpu.iterations} (cold ${cold.iterations})`);
    // The warm start must matter here, so a dropped or wrong blend cannot pass by coincidence.
    assert.notDeepEqual(blendEllipsoids(stored.E,fresh),fresh);
    const next=await raw(),scaleE=Math.max(...cpu.ellipsoid.flat().map(Math.abs));
    for(let r=0;r<3;r++)for(let c=0;c<3;c++)assert.ok(Math.abs(next.E[r][c]-cpu.ellipsoid[r][c])<=1e-3*scaleE,`E[${r}][${c}] GPU ${next.E[r][c]} vs CPU ${cpu.ellipsoid[r][c]}`);
  } finally {pass.destroy();}
});

gpuTest('GPU SDF opt-in gradient-descent stop never stops sooner and extends released stops', async device=>{
  const {intersection,plus,scale}=await import('../src/avbd3d/ref/sdf/math.ts');
  const a=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]}),b=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]});
  const bodies=[new SdfBody(a,[0,0,0]),new SdfBody(b,[.35,.1,0],[0,0,.258819045,.965925826])];
  const domain=intersection(bodies[0].bounds,bodies[1].bounds);a.seeds=[scale(plus(domain.min,domain.max),.5)];b.seeds=[];
  // On the CPU stream this overlap stops after 2-8 released iterations and runs to the limit with
  // the opt-in. The GPU stream differs, so per key only require the opt-in never to stop sooner.
  const params={...collisionParams(),margin:0,optimizer:2 as const,cacheSize:0,randomSamples:1};
  const run=async(key:number,sgdGradientStopOnly?:boolean)=>{const pass=await SdfNarrowphasePass.create(device,[a,b],{maxBodies:2,maxPairs:1});
    try{pass.step(bodies,[{a:0,b:1,key}],0,{...params,sgdGradientStopOnly});const [r]=await pass.readResults();assert.equal(r.points.length,1);return r.iterations;}finally{pass.destroy();}};
  let extended=0;
  for(const key of [1,2,3,4,5,6,7,8]) {
    const released=await run(key),explicit=await run(key,false),optIn=await run(key,true);
    assert.equal(explicit,released,`key ${key}: absent and false are the released behaviour`);
    assert.ok(optIn>=released && optIn<=params.maxIterations,`key ${key}: opt-in ${optIn} vs released ${released}`);
    if(optIn>released)extended++;
  }
  assert.ok(extended>0,'the opt-in runs past the released stop on some key');
});


gpuTest('hardmax ablation stays finite for equal-field ties with all optimizers', async device => {
  const field=new AnalyticField({kind:'sphere',radius:1});
  const bodies=[new SdfBody(field,[-.5,0,0]),new SdfBody(field,[.5,0,0])];
  const pass=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1});
  try{
    for(const optimizer of [0,1,2] as const)for(let step=0;step<8;step++){
      pass.step(bodies,[{a:0,b:1,key:42,...(step?{previous:0}:{})}],0,{...collisionParams(),optimizer,epsilon:0});
      const [r]=await pass.readResults();
      assert.ok(r.points.length>0);
      for(const p of r.points)assert.ok([...p.x,...p.normal,p.separation].every(Number.isFinite));
      assert.ok(r.points.some(p=>p.active),'overlapping spheres retain an active contact');
    }
  }finally{pass.destroy();}
});
