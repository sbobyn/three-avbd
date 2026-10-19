import assert from 'node:assert/strict';
import { gpuTest } from './device.ts';
import { AnalyticField } from '../src/avbd3d/ref/sdf/shapes.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { collisionParams } from '../src/avbd3d/ref/sdf/manifold.ts';
import { SdfNarrowphasePass } from '../src/avbd3d/gpu/sdf-pass.ts';

gpuTest('SDF per-body seed cache matches direct sampling through pose, mode and history changes',async device=>{
  const field=new AnalyticField({kind:'torus',majorRadius:.8,minorRadius:.25});
  field.seeds=Array.from({length:128},(_,i)=>{const u=i*Math.PI*2/128,v=i*Math.PI*2/17,r=.8+.25*Math.cos(v);return [r*Math.cos(u),.25*Math.sin(v),r*Math.sin(u)];});
  const direct=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:2,maxPoints:20});
  let cached=await SdfNarrowphasePass.create(device,[field],{maxBodies:256,maxPairs:2,maxPoints:20});
  try{
    for(let frame=0;frame<12;frame++){
      if(frame===6){const grown=cached.resized(4);grown.inheritHistory(cached,Array.from({length:256},(_,i)=>i<2));cached.destroy();cached=grown;}
      const a=new SdfBody(field,[0,0,0],[0,0,0,1],1,false);
      const angle=frame*.03,b=new SdfBody(field,[.9,frame*.01,0],[0,Math.sin(angle),0,Math.cos(angle)],.9,false);
      const params={...collisionParams(),cacheSize:16,randomSamples:4,curvatureSampling:frame%3!==1};
      const pairs=[{a:0,b:1,key:frame<8?1:2,...(frame&&frame!==8?{previous:0}:{})}];
      direct.step([a,b],pairs,.004,params);cached.step([a,b],pairs,.004,params);
      assert.deepEqual(await cached.readResults(),await direct.readResults(),`frame ${frame}`);
    }
  }finally{direct.destroy();cached.destroy();}
});
