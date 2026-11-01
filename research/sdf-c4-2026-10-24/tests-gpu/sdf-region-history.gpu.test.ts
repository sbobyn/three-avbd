// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 9ca714275ee97e5e2419ed0bbbce17c080de4b071803323970813ee079c58656. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import {gpuTest} from './device.ts';
import {Solver} from '../src/avbd3d/ref/solver.ts';
import {Rigid} from '../src/avbd3d/ref/body.ts';
import {AnalyticField} from '../src/avbd3d/ref/sdf/shapes.ts';
import {SdfBody} from '../src/avbd3d/ref/sdf/body.ts';
import {collisionParams} from '../src/avbd3d/ref/sdf/manifold.ts';
import {GpuSolver3D,type GpuCollisionBackend3D,type GpuCollisionContext3D} from '../src/avbd3d/gpu/solver.ts';
import {SdfNarrowphasePass} from '../src/avbd3d/gpu/sdf-pass.ts';
import {packSdfBodies,sdfResultWords} from '../src/avbd3d/gpu/sdf-layout.ts';
import {sdfExportSource} from '../src/avbd3d/gpu/wgsl-sdf-bridge.ts';
import {CONTACT_WORDS,K_LAM,K_PEN} from '../src/avbd3d/gpu/layout.ts';
import {prepareNativeRegionHistory,type NativeContactEpoch,type NativeRegionHistory} from '../scripts/sdf-region-history.ts';
import type {RegionScope,RegionField} from '../scripts/sdf-region-contacts.ts';

// Four static-pose bodies, two pairs, three full-search frames. Exercise the exact native
// detector/exporter; do not substitute region proposals or claim their settling is qualified.
gpuTest('complete native history survives actual GPU search/export, pair reorder and stale epoch invalidation',async device=>{
  const ref=new Solver();ref.gravity=0;ref.iterations=0;
  const sphere=new AnalyticField({kind:'sphere',radius:.4}),ring=new AnalyticField({kind:'torus',majorRadius:.4,minorRadius:.2});
  ring.seeds=[[.6,0,0],[-.6,0,0],[0,0,.6],[0,0,-.6]];
  const bodies=[new SdfBody(sphere,[.3,0,0]),new SdfBody(ring),new SdfBody(sphere,[3.3,0,0]),new SdfBody(ring,[3,0,0])];
  for(const b of bodies)new Rigid(ref,[1,1,1],1,.6,b.position);
  const solver=new GpuSolver3D(device,ref,{spatialSort:false});solver.params.massPenalty=false;
  const narrow=await SdfNarrowphasePass.create(device,[sphere,ring],{maxBodies:4,maxPairs:2,maxPoints:5});
  const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:sdfExportSource(5)}),entryPoint:'exportContacts'}});
  const uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  const config=new Uint32Array(8),cf=new Float32Array(config.buffer),params=collisionParams();config[0]=2;cf[4]=params.margin;cf[5]=params.allowedPenetration;
  device.queue.writeBuffer(uniform,0,config);device.queue.writeBuffer(narrow.storage.bodies,0,packSdfBodies(bodies,narrow.atlas));
  const fieldA={} as RegionField,fieldB={} as RegionField;
  let scopes:RegionScope[]=[{pairKey:11,bodyA:1,bodyB:0,generationA:0,generationB:0,fieldA,fieldB},{pairKey:22,bodyA:3,bodyB:2,generationA:0,generationB:0,fieldA,fieldB}];
  let step=0,history:NativeRegionHistory|null=null;
  let input:Parameters<Parameters<ReturnType<typeof prepareNativeRegionHistory>['completeWithLegacy']>[0]>[0];
  const epoch=(contacts=solver.contactStorage.contacts):NativeContactEpoch=>({owner:solver,contacts,generation:0,step});
  const backend:GpuCollisionBackend3D={prepare(){},encode(pass:GPUComputePassEncoder,c:GpuCollisionContext3D){
    input.assertPreviousEpoch(epoch(c.previousContacts));
    narrow.encodeFromGpu(pass,4,input.pairs,solver.params.dt,params);
    const buffers=[c.params,uniform,c.bodies,narrow.storage.current,narrow.storage.previous,narrow.storage.pairs,c.previousContacts,c.contacts,c.manifolds,c.counters];
    pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))}));pass.dispatchWorkgroups(1);step++;
  },destroy(){narrow.destroy();uniform.destroy();}};
  solver.setCollisionBackend(backend);
  const read=async(buffer:GPUBuffer,size:number)=>{
    const staging=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
    try{const e=device.createCommandEncoder();e.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([e.finish()]);await staging.mapAsync(GPUMapMode.READ);return new Uint32Array(staging.getMappedRange().slice(0));}finally{staging.destroy();}
  };
  const frame=async()=>{
    const tx=prepareNativeRegionHistory(scopes,history,5,epoch());
    const out=await tx.completeWithLegacy(async next=>{
      input=next;if(input.previous.length)device.queue.writeBuffer(narrow.storage.current,0,input.previous.slice());
      solver.step();return {words:await read(narrow.storage.current,2*sdfResultWords(5)*4),epoch:epoch()};
    });history=out.history;return out;
  };
  try{
    const first=await frame(),contacts=await solver.readContactList();assert.ok(contacts.length>2);
    assert.ok(contacts.some(c=>contacts.some(p=>c.normal.reduce((n,v,i)=>n+v*p.normal[i],0)<.99)),'distinct contact normals');
    const oldHistory=history,forces=new Map<string,{lam:number[];pen:number[];normal:number[]}>();
    for(let pair=0;pair<2;pair++)for(let j=0;j<first.words[pair*sdfResultWords(5)+3];j++){
      const at=pair*sdfResultWords(5)+8+j*28,exportSlot=first.words[at+19];if(!exportSlot)continue;
      const id=first.words[at+18],a=scopes[pair].bodyA,c=contacts.find(c=>c.a===a&&c.feature===id)!;assert.ok(c);
      const lam=[-1-id*.1-a,.15*id,-.2*a],pen=[12+id,21+id,32+id];forces.set(`${a}:${id}`,{lam,pen,normal:c.normal});
      device.queue.writeBuffer(solver.contactStorage.contacts,(exportSlot-1)*CONTACT_WORDS*4+K_LAM*4,new Float32Array(lam));
      device.queue.writeBuffer(solver.contactStorage.contacts,(exportSlot-1)*CONTACT_WORDS*4+K_PEN*4,new Float32Array(pen));
    }
    scopes=[scopes[1],scopes[0]];const second=await frame(),next=await solver.readContactList();let matched=0;
    const basis=(n:number[])=>{const t=Math.abs(n[0])>Math.abs(n[2])?[-n[1],n[0],0]:[0,-n[2],n[1]],len=Math.hypot(...t),u=t.map(v=>v/len);return[n,u,[n[1]*u[2]-n[2]*u[1],n[2]*u[0]-n[0]*u[2],n[0]*u[1]-n[1]*u[0]]];};
    for(let pair=0;pair<2;pair++)for(let j=0;j<second.words[pair*sdfResultWords(5)+3];j++){
      const at=pair*sdfResultWords(5)+8+j*28,id=second.words[at+18],a=scopes[pair].bodyA;if(!second.words[at+16]||!second.words[at+17])continue;
      const old=forces.get(`${a}:${id}`),c=next.find(c=>c.a===a&&c.feature===id)!;if(!old)continue;matched++;
      const ob=basis(old.normal),nb=basis(c.normal),world=[0,1,2].map(j=>ob.reduce((n,r,k)=>n+r[j]*old.lam[k],0));
      const expected=nb.map(r=>r.reduce((n,v,j)=>n+v*world[j],0)*solver.params.alpha*solver.params.gamma);
      c.lam.forEach((v,j)=>assert.ok(Math.abs(v-expected[j])<1e-4));
      c.pen.forEach((v,j)=>assert.ok(Math.abs(v-old.pen[j]*solver.params.gamma)<1e-4));
    }
    assert.ok(matched>=2,'warm force survives on both pairs');
    assert.ok(second.transitions.some(t=>t.disposition==='retained'));
    // Two ping-pong swaps can restore the same buffer object. Step identity must still reject it.
    history=oldHistory;const cold=await frame(),reset=await solver.readContactList();assert.ok(reset.length>0);
    assert.ok(cold.transitions.every(t=>t.disposition==='invalidated'));
    reset.forEach(c=>assert.deepEqual(c.lam,[0,0,0]));assert.equal((await solver.readCounters()).overflow,0);
  }finally{solver.destroy();}
});
