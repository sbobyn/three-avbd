import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gpuTest } from './device.ts';
import { World } from '../src/lib/world.ts';
import { loadReleasedScene, type ReadAsset } from '../src/sdf-released/scenes.ts';
import { DensePileOracle } from '../scripts/sdf-dense-pile.ts';
const read:ReadAsset=async path=>{const b=await readFile(new URL(`../tests/fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};

gpuTest('dense pile surface contacts support a released bunny with finite independent normals',async device=>{
  const original=await loadReleasedScene(9,read),scene={...original,bodies:original.bodies.slice(0,2)};
  const world=await World.create({device,maxBodies:2,dt:.004,iterations:20});
  try{
    const bodies=scene.bodies.map(b=>world.addBox({size:[1,1,1],position:b.original.position,rotation:b.rotation,fixed:b.original.static,friction:b.original.friction,...(!b.original.static?{massProperties:{mass:b.original.mass,moments:b.moments}}:{})})!);
    await world.read();world.solver.setCollisionBackend(await DensePileOracle.create(world.solver,scene,.02,.01));
    let active=0;
    for(let i=0;i<200;i++){
      world.step();const counters=await world.solver.readCounters();assert.equal(counters.overflow,0);active=Math.max(active,counters.contacts);
      if(i%10===0)await new Promise(r=>setTimeout(r,5));
    }
    await world.read();assert.ok(active>10);assert.ok(bodies[1].position[1]>0);
    const contacts=await world.solver.readContactList();assert.ok(contacts.length>0);
    assert.equal(new Set(contacts.map(c=>c.feature)).size,contacts.length);
    for(const c of contacts){assert.ok([...c.normal,...c.rA,...c.rB,...c.lam].every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...c.normal)-1)<1e-5);}
  }finally{world.destroy();original.dispose();}
});

gpuTest('dense pile finds both directed mesh contact sets with persistent warm starts',async device=>{
  const original=await loadReleasedScene(9,read),scene={...original,bodies:original.bodies.slice(0,3)};
  const world=await World.create({device,maxBodies:3,dt:.004,iterations:1,gravity:[0,0,0]});
  try{
    scene.bodies.forEach((b,i)=>world.addBox({size:[1,1,1],position:i===0?b.original.position:[(i-1)*.25,2,0],rotation:i===0?b.rotation:scene.bodies[1].rotation,fixed:b.original.static,friction:b.original.friction,...(!b.original.static?{massProperties:{mass:b.original.mass,moments:b.moments}}:{})}));
    await world.read();world.solver.setCollisionBackend(await DensePileOracle.create(world.solver,scene,.02,.01));
    world.step();assert.equal((await world.solver.readCounters()).overflow,0);
    const previous=await world.solver.readContactList();
    assert.ok(previous.some(c=>c.a===1&&c.b===2));assert.ok(previous.some(c=>c.a===2&&c.b===1));
    world.iterations=0;world.step();assert.equal((await world.solver.readCounters()).overflow,0);
    const next=await world.solver.readContactList(),prior=new Map(previous.map(c=>[c.feature,c]));
    const retained=next.filter(c=>prior.has(c.feature)&&Math.abs(prior.get(c.feature)!.lam[0])>1e-5);
    assert.ok(retained.length>0);
    for(const c of retained){
      const old=prior.get(c.feature)!;
      assert.equal(c.a,old.a);assert.equal(c.b,old.b);
      // Basis transport preserves multiplier-vector length before decay, including changing normals.
      const expected=Math.hypot(...old.lam)*world.solver.params.alpha*world.solver.params.gamma;
      assert.ok(Math.abs(Math.hypot(...c.lam)-expected)<1e-5+expected*1e-5);
    }
  }finally{world.destroy();original.dispose();}
});
