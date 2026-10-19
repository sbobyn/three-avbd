import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { gpuTest } from './device.ts';
import { World } from '../src/lib/world.ts';
import { DensePlaneOracle, denseSurfacePoints } from '../scripts/sdf-dense-plane.ts';

gpuTest('dense plane oracle supports a falling box with persistent contact identities',async device=>{
  const world=await World.create({device,maxBodies:2,dt:1/120,iterations:10});
  const geometry=new BoxGeometry(1,1,1);
  try{
    world.addBox({size:[20,1,20],position:[0,-.5,0],fixed:true,friction:.8,rotation:[0,Math.sin(.3),0,Math.cos(.3)]});
    const box=world.addBox({size:[1,1,1],position:[0,.55,0],friction:.8,density:1})!;
    await world.read();
    const oracle=await DensePlaneOracle.create(world.solver,denseSurfacePoints(geometry),1,.02,.01);
    world.solver.setCollisionBackend(oracle);
    let active=0;
    for(let i=0;i<120;i++){
      world.step();const counters=await world.solver.readCounters();assert.equal(counters.overflow,0);active=Math.max(active,counters.contacts);
      if(i%10===0)await new Promise(r=>setTimeout(r,5));
    }
    await world.read();
    assert.ok(active>100,'many independent surface contacts, not reduced to optimizer budget');
    assert.ok(box.position[1]>.49&&box.position[1]<.54,`height ${box.position[1]}`);
    assert.ok(Math.hypot(...box.velocity)<.05,`velocity ${box.velocity}`);
    box.set({position:[0,.48,0],velocity:[0,0,0],angularVelocity:[0,0,0]});
    world.step();await world.solver.readCounters();
    const contacts=await world.solver.readContactList();
    assert.ok(contacts.length>0);
    world.iterations=0;
    world.step();await world.solver.readCounters();
    const next=await world.solver.readContactList(),prior=new Map(contacts.map(c=>[c.feature,c]));
    assert.equal(new Set(next.map(c=>c.feature)).size,next.length);
    const retained=next.filter(c=>prior.has(c.feature));assert.ok(retained.length>100);
    for(const c of retained){assert.deepEqual(c.rA,prior.get(c.feature)!.rA);assert.deepEqual(c.normal,[0,1,0]);}
    const loaded=retained.filter(c=>Math.abs(prior.get(c.feature)!.lam[0])>1e-5);
    assert.ok(loaded.length>0,'penetrating contacts carry nonzero multipliers');
    for(const c of loaded){
      const old=prior.get(c.feature)!;
      for(let axis=0;axis<3;axis++){
        const expected=old.lam[axis]*world.solver.params.alpha*world.solver.params.gamma;
        assert.ok(Math.abs(c.lam[axis]-expected)<1e-5+Math.abs(expected)*1e-5,`feature ${c.feature}: warm multiplier ${c.lam[axis]} != ${expected}`);
      }
    }
  }finally{world.destroy();geometry.dispose();}
});
