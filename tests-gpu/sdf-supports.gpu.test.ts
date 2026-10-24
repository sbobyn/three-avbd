import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Quaternion, Euler } from 'three';
import { gpuTest } from './device.ts';
import { loadReleasedScene, instantiateReleased, type ReadAsset, type ReleasedScene } from '../src/sdf-released/scenes.ts';
import { measuredFrame } from '../src/sdf-released/metrics.ts';
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
for(const id of [6,9])gpuTest(`mesh plane supports: isolated tilted ${id===6?'chair':'bunny'} impact and settling`,async device=>{
  const source=await loadReleasedScene(id,read),body=source.bodies[1];
  const rotation=new Quaternion().setFromEuler(new Euler(.25,.2,.15)).multiply(new Quaternion(...body.rotation)).toArray() as [number,number,number,number];
  const scene:ReleasedScene={...source,capture:{...source.capture,params:{...source.capture.params,meshVertexContacts:true}},bodies:[source.bodies[0],{...body,rotation,original:{...body.original,position:[0,1,0],velocity:[0,0,0],angularVelocity:[0,0,0]}}]};
  const {world,bodies}=await instantiateReleased(scene,{device});
  try{
    let peak=0,last;
    for(let frame=1;frame<=240;frame++){
      last=await measuredFrame(scene,world,bodies,frame,true);peak=Math.max(peak,last.maxVertexPenetration??0);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    console.log({scene:id,peak,final:last!.maxVertexPenetration,energy:last!.kineticEnergy});
    assert.ok(peak<.005,`impact penetration ${peak}`);
    assert.ok(last!.maxVertexPenetration!<.001,`final overlap ${last!.maxVertexPenetration}`);
    assert.ok(last!.kineticEnergy<.001,`settling ${last!.kineticEnergy}`);
  }finally{world.destroy();source.dispose();}
});

gpuTest('mesh plane contacts retain vertex IDs and fall back at box edges',async device=>{
  const {BoxGeometry}=await import('three');
  const {bakeVoxelSdf}=await import('../src/avbd3d/ref/sdf/bake.ts');
  const {AnalyticField}=await import('../src/avbd3d/ref/sdf/shapes.ts');
  const {SdfBody}=await import('../src/avbd3d/ref/sdf/body.ts');
  const {collisionParams}=await import('../src/avbd3d/ref/sdf/manifold.ts');
  const {SdfNarrowphasePass}=await import('../src/avbd3d/gpu/sdf-pass.ts');
  const geometry=new BoxGeometry(),field=bakeVoxelSdf(geometry,{resolution:8}).field;
  const floor=new AnalyticField({kind:'box',halfExtents:[3,.5,3]});
  const bodies=[new SdfBody(floor,[0,-.5,0],[0,0,0,1],1,true),new SdfBody(field,[0,.49,0])];
  const pass=await SdfNarrowphasePass.create(device,[floor,field],{maxBodies:2,maxPairs:1,meshVertexContacts:true});
  const params={...collisionParams(),meshVertexContacts:true};
  try{
    pass.step(bodies,[{a:1,b:0,key:1}],0,params);let result=(await pass.readResults())[0];
    const supports=result.points.filter(p=>p.id>=0x40000000);
    assert.equal(supports.length,1);assert.ok(result.points.length<=5);
    const ids=supports.map(p=>p.id);
    for(const p of supports){assert.ok(Math.abs(p.separation+.01)<1e-6);assert.ok(Math.abs(p.normal[0])+Math.abs(p.normal[2])<1e-6);assert.equal(p.normal[1],-1);}
    bodies[1].position[0]=.001;
    pass.step(bodies,[{a:1,b:0,key:1,previous:0}],0,params);result=(await pass.readResults())[0];
    const retained=result.points.filter(p=>p.id>=0x40000000);
    assert.deepEqual(retained.map(p=>p.id),ids);assert.ok(retained.every(p=>p.cached));
    pass.step(bodies,[{a:1,b:0,key:1,previous:0}],0,{...params,meshVertexContacts:false});result=(await pass.readResults())[0];
    assert.ok(result.points.every(p=>p.id<0x40000000),'disabling the option drops supplemental history');
    bodies[1].position[0]=2.8;
    pass.step(bodies,[{a:1,b:0,key:2}],0,params);result=(await pass.readResults())[0];
    assert.ok(result.points.length>0);assert.ok(result.points.every(p=>p.id!<0x40000000),'partial face coverage uses general SDF contacts');
    bodies[1].position[0]=0;
    pass.step(bodies,[{a:1,b:0,key:3}],0,{...params,meshVertexContacts:false});result=(await pass.readResults())[0];
    assert.ok(result.points.every(p=>p.id<0x40000000),'default policy never adds plane supports');
  }finally{pass.destroy();geometry.dispose();}
});

gpuTest('mesh plane supplemental vertex retains production normal warm force',async device=>{
  const {BoxGeometry}=await import('three');
  const {bakeVoxelSdf}=await import('../src/avbd3d/ref/sdf/bake.ts');
  const {AnalyticField}=await import('../src/avbd3d/ref/sdf/shapes.ts');
  const {Solver}=await import('../src/avbd3d/ref/solver.ts');
  const {Rigid}=await import('../src/avbd3d/ref/body.ts');
  const {GpuSolver3D}=await import('../src/avbd3d/gpu/solver.ts');
  const {SdfCollisionBridge}=await import('../src/avbd3d/gpu/sdf-bridge.ts');
  const {CONTACT_WORDS,K_LAM}=await import('../src/avbd3d/gpu/layout.ts');
  const geometry=new BoxGeometry(),field=bakeVoxelSdf(geometry,{resolution:8}).field;
  const ref=new Solver();ref.gravity=0;ref.iterations=0;
  new Rigid(ref,[8,.4,8],0,.6,[0,-.2,0]);new Rigid(ref,[1,1,1],1,.6,[0,.49,0]);
  const solver=new GpuSolver3D(device,ref,{spatialSort:false});
  const bridge=await SdfCollisionBridge.create(solver,[{field:new AnalyticField({kind:'box',halfExtents:[4,.2,4]})},{field}],[{a:1,b:0,key:1}],{meshVertexContacts:true});
  try{
    solver.setCollisionBackend(bridge);solver.step();
    const initial=await solver.readContactList(),support=initial.find(c=>c.feature>=0x40000000)!;
    assert.ok(support);
    const result=(await bridge.readResults())[0],slot=result.points.filter(p=>p.active).findIndex(p=>p.id===support.feature);
    // This single-pair export emits active contacts in point order.
    assert.ok(slot>=0);
    device.queue.writeBuffer(solver.contactStorage.contacts,(slot*CONTACT_WORDS+K_LAM)*4,new Float32Array([-2,0,0]));
    solver.step();const next=(await solver.readContactList()).find(c=>c.feature===support.feature)!;
    assert.ok(next);assert.deepEqual(next.normal,support.normal);
    assert.ok(Math.abs(next.lam[0]+2*solver.params.alpha*solver.params.gamma)<1e-5,'force follows the vertex ID through the production bridge');
  }finally{solver.destroy();geometry.dispose();}
});

gpuTest('mesh-to-mesh vertex witness: exact depth, SDF normal, stable identity, default off',async device=>{
  const {BoxGeometry,Vector3}=await import('three');
  const {bakeVoxelSdf}=await import('../src/avbd3d/ref/sdf/bake.ts');
  const {SdfBody}=await import('../src/avbd3d/ref/sdf/body.ts');
  const {collisionParams}=await import('../src/avbd3d/ref/sdf/manifold.ts');
  const {SdfNarrowphasePass}=await import('../src/avbd3d/gpu/sdf-pass.ts');
  const {snapshotSdfField}=await import('../src/avbd3d/gpu/sdf-snapshot.ts');
  const geometry=new BoxGeometry(),field=snapshotSdfField(bakeVoxelSdf(geometry,{resolution:8}).field,true);
  // B stands on one corner, 3 mm into A's top face; Algorithm 1 alone has no vertex guarantee.
  const corner=new Quaternion().setFromUnitVectors(new Vector3(-1,-1,-1).normalize(),new Vector3(0,-1,0)).toArray() as [number,number,number,number];
  const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,[0,.5+Math.sqrt(3)/2-.003,0],corner)];
  const pass=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1,meshVertexContacts:true});
  const params={...collisionParams(),meshVertexContacts:true};
  try{
    pass.step(bodies,[{a:0,b:1,key:1}],0,params);let result=(await pass.readResults())[0];
    const witnesses=result.points.filter(p=>p.id>=0x40000000);
    assert.equal(witnesses.length,1);assert.ok(result.points.length<=5);
    const [w]=witnesses;assert.ok((w.id&0x08000000)!==0,'vertex belongs to body B');
    const phi=bodies[0].sample(w.x as [number,number,number]);
    assert.ok(w.separation<0 && Math.abs(w.separation-phi.phi)<1e-4,`${w.separation} vs field ${phi.phi}`);
    assert.ok(w.normal[1]>.9,'A face normal');
    pass.step(bodies,[{a:0,b:1,key:1,previous:0}],0,params);result=(await pass.readResults())[0];
    const retained=result.points.filter(p=>p.id>=0x40000000);
    assert.deepEqual(retained.map(p=>p.id),[w.id]);assert.ok(retained[0].cached);
    pass.step(bodies,[{a:0,b:1,key:2}],0,{...params,meshVertexContacts:false});result=(await pass.readResults())[0];
    assert.ok(result.points.every(p=>p.id<0x40000000),'default policy never adds vertex witnesses');
  }finally{pass.destroy();geometry.dispose();}
});

gpuTest('vertex witnesses drop opposed ambiguous optimizer contacts in their pair only',async device=>{
  const {BoxGeometry}=await import('three');
  const {bakeVoxelSdf}=await import('../src/avbd3d/ref/sdf/bake.ts');
  const {SdfBody}=await import('../src/avbd3d/ref/sdf/body.ts');
  const {collisionParams}=await import('../src/avbd3d/ref/sdf/manifold.ts');
  const {SdfNarrowphasePass}=await import('../src/avbd3d/gpu/sdf-pass.ts');
  const {snapshotSdfField}=await import('../src/avbd3d/gpu/sdf-snapshot.ts');
  const geometry=new BoxGeometry(),field=snapshotSdfField(bakeVoxelSdf(geometry,{resolution:8}).field,true);
  const pass=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1,meshVertexContacts:true});
  const params={...collisionParams(),meshVertexContacts:true};
  // Deep, tilted overlaps: some optimizer points land inside both boxes with aligned gradients.
  let state=7;const random=()=>{state=Math.imul(state^state>>>15,0x2c1b3c6d)+0x6d2b79f5>>>0;return state/2**32;};
  let dropped=0,witnessed=0;
  try{
    for(let k=0;k<48;k++){
      const q=new Quaternion().setFromEuler(new Euler(random()*6.3,random()*6.3,random()*6.3)).toArray() as [number,number,number,number];
      const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,[(random()-.5)*.6,.55+random()*.35,(random()-.5)*.6],q)];
      for(const on of [true,false]){
        pass.step(bodies,[{a:0,b:1,key:k+1}],0,{...params,meshVertexContacts:on});const [r]=await pass.readResults();
        const w=r.points.find(p=>p.id>=0x40000000);
        const gone=r.points.filter(p=>p.id<0x40000000&&!p.active&&p.separation<params.margin);
        if(!on){assert.equal(gone.length,0,'without witnesses activity is separation < margin');continue;}
        if(!w){assert.equal(gone.length,0,'no witness, no drop');continue;}
        witnessed++;dropped+=gone.length;
        for(const p of r.points){
          if(p.id>=0x40000000||!p.active)continue;
          const n=p.normal,opposed=n[0]*w.normal[0]+n[1]*w.normal[1]+n[2]*w.normal[2]<0;
          const a=bodies[0].sample(p.x as [number,number,number]),b=bodies[1].sample(p.x as [number,number,number]);
          const aligned=a.gradient[0]*b.gradient[0]+a.gradient[1]*b.gradient[1]+a.gradient[2]*b.gradient[2]>0;
          // 1e-5 slack: CPU and GPU sample the same snapshot in different float orders.
          const ambiguous=(a.phi<-1e-5&&b.phi<-1e-5&&aligned)||(a.phi>1e-5&&b.phi>1e-5);
          assert.ok(!(opposed&&ambiguous),`pose ${k}: active point opposes the witness with an ambiguous normal`);
        }
        for(const p of gone)assert.ok(p.normal[0]*w.normal[0]+p.normal[1]*w.normal[1]+p.normal[2]*w.normal[2]<0,'only opposed points are dropped');
      }
    }
    assert.ok(witnessed>10,`witness poses ${witnessed}`);assert.ok(dropped>0,'the sweep exercises the drop');
  }finally{pass.destroy();geometry.dispose();}
});
