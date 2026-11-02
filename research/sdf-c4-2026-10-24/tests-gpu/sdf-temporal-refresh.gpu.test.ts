// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 68de40e7b6e8c72a25e7416a6f5e5df29faa2eb60ab8e0f13a9432e6b4042422. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import {gpuTest} from './device.ts';
import {AnalyticField} from '../src/avbd3d/ref/sdf/shapes.ts';
import {SdfBody} from '../src/avbd3d/ref/sdf/body.ts';
import {collisionParams} from '../src/avbd3d/ref/sdf/manifold.ts';
import {SdfNarrowphasePass} from '../src/avbd3d/gpu/sdf-pass.ts';
import {temporalRefreshDevice} from '../scripts/sdf-temporal-refresh.ts';

gpuTest('experimental cached refresh retains discovery, cached identities and finite contacts',async device=>{
  const field=new AnalyticField({kind:'box',halfExtents:[.5,.5,.5]});
  const a=new SdfBody(field,[0,0,0]),b=new SdfBody(field,[0,.9,0]);
  const control=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:2,maxPoints:20});
  const candidate=await SdfNarrowphasePass.create(temporalRefreshDevice(device,4,'all-cached'),[field],{maxBodies:2,maxPairs:2,maxPoints:20});
  const params={...collisionParams(),cacheSize:16,randomSamples:4,skipConvexSamples:false};
  let baselineQueries=0,candidateQueries=0,oldIds=new Set<number>();
  try{
    for(let frame=0;frame<8;frame++){
      const pairs=[{a:0,b:1,key:10,...(frame?{previous:0}:{})}];
      control.step([a,b],pairs,.004,params);candidate.step([a,b],pairs,.004,params);
      const [expected]=await control.readResults(),[actual]=await candidate.readResults();
      baselineQueries+=expected.queries;candidateQueries+=actual.queries;
      assert.ok(actual.points.length>0);
      for(const point of actual.points){
        assert.ok([...point.x,...point.normal,point.separation].every(Number.isFinite));
        if(point.cached)assert.ok(oldIds.has(point.id),'cached identity survives');
      }
      oldIds=new Set(actual.points.map(p=>p.id));
      assert.ok(actual.points.some(p=>!p.cached),'fresh discovery continues each step');
    }
    assert.ok(candidateQueries<baselineQueries,`${candidateQueries} < ${baselineQueries}`);
    // A new identity must not borrow the preceding pair cache.
    candidate.step([a,b],[{a:0,b:1,key:11,previous:0}],.004,params);
    assert.ok((await candidate.readResults())[0].points.every(p=>!p.cached));
  }finally{candidate.destroy();control.destroy();}
});

gpuTest('temporal prototype leaves other optimizers and disabled policy unchanged',async device=>{
  const field=new AnalyticField({kind:'sphere',radius:.5});
  for(const interval of [1,4])for(const optimizer of [1,2] as const){
    const control=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1});
    const candidate=await SdfNarrowphasePass.create(temporalRefreshDevice(device,interval),[field],{maxBodies:2,maxPairs:1});
    try{
      for(let frame=0;frame<3;frame++){
        const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,[.8,.03,0])];
        const pairs=[{a:0,b:1,key:1,...(frame?{previous:0}:{})}],params={...collisionParams(),optimizer,maxIterations:8};
        control.step(bodies,pairs,.004,params);candidate.step(bodies,pairs,.004,params);
        assert.deepEqual(await candidate.readResults(),await control.readResults());
      }
    }finally{candidate.destroy();control.destroy();}
  }
});

gpuTest('inactive-pair scope retains active-pair optimization and falls back for rapid motion',async device=>{
  const field=new AnalyticField({kind:'sphere',radius:.5});
  const params={...collisionParams(),cacheSize:16,randomSamples:4,skipConvexSamples:false};
  for(const position of [[.8,0,0],[.8,.8,0]] as [number,number,number][]){
    const control=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1,maxPoints:20});
    const candidate=await SdfNarrowphasePass.create(temporalRefreshDevice(device),[field],{maxBodies:2,maxPairs:1,maxPoints:20});
    try{
      for(let frame=0;frame<4;frame++){
        const a=new SdfBody(field,[0,0,0]),b=new SdfBody(field,position);
        // Exercise the guard fallback without changing the source geometry.
        b.velocity=[100,0,0];
        const pairs=[{a:0,b:1,key:1,...(frame?{previous:0}:{})}];
        control.step([a,b],pairs,.004,params);candidate.step([a,b],pairs,.004,params);
        assert.deepEqual(await candidate.readResults(),await control.readResults());
      }
    }finally{candidate.destroy();control.destroy();}
  }
});

gpuTest('inactive-only refresh is effective for separated overlapping bounds and leaves stationary active pairs alone',async device=>{
  const field=new AnalyticField({kind:'sphere',radius:.5});
  const params={...collisionParams(),cacheSize:16,randomSamples:4,skipConvexSamples:false};
  for(const active of [true,false]){
    const control=await SdfNarrowphasePass.create(device,[field],{maxBodies:2,maxPairs:1,maxPoints:20});
    const candidate=await SdfNarrowphasePass.create(temporalRefreshDevice(device),[field],{maxBodies:2,maxPairs:1,maxPoints:20});
    let controlQueries=0,refreshQueries=0;
    try{
      for(let frame=0;frame<8;frame++){
        const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,active?[.8,0,0]:[.8,.8,0])];
        const pairs=[{a:0,b:1,key:1,...(frame?{previous:0}:{})}];
        control.step(bodies,pairs,.004,params);candidate.step(bodies,pairs,.004,params);
        const expected=await control.readResults(),actual=await candidate.readResults();
        if(active)assert.deepEqual(actual,expected);
        else assert.ok(actual[0].points.every(p=>!p.active));
        controlQueries+=expected[0].queries;refreshQueries+=actual[0].queries;
      }
      if(!active)assert.ok(refreshQueries<controlQueries,`${refreshQueries} < ${controlQueries}`);
    }finally{candidate.destroy();control.destroy();}
  }
});
