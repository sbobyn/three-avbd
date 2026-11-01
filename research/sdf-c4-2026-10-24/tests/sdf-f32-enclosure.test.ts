// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: d51374d9916b49332693c3f3ef74f34b178d7003ef18f152cc6f47e8b02f67b6. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { f32Op, f32Point, f32SearchDomain, type F32Interval } from '../scripts/sdf-f32-enclosure.ts';
import { boundProjectionCell, ProjectionField, certifyProjectionPair, type ProjectionBody, type Vec3 } from '../scripts/sdf-cell-projection.ts';
const f=Math.fround, p=f32Point;
const contains=(range:F32Interval|null,value:number)=>assert.ok(range&&value>=range[0]&&value<=range[1],`${value} outside ${range}`);

test('exact endpoint arithmetic encloses directed rounding that binary64 loses',()=>{
  assert.equal(1-2**-126,1);
  const result=f32Op('sub',p(1),p(2**-126));
  assert.deepEqual(result,[1-2**-24,1]);
  assert.deepEqual(f32Op('add',p(1),p(2**-126)),[1,1+2**-23]);
  assert.deepEqual(f32Op('sub',p(-1),p(2**-126)),[-1-2**-23,-1]);
});
test('primitive bounds include f32 rounding and input/output flush-to-zero',()=>{
  contains(f32Op('mul',p(2**-149),p(2**126)),0);
  contains(f32Op('mul',p(2**-149),p(2**126)),2**-23);
  contains(f32Op('mul',p(2**-126),p(.5)),0);
  for(let i=1;i<=300;i++){
    const a=f(Math.sin(i)*2**((i%60)-30)),b=f(Math.cos(i)*2**((i%50)-25));
    for(const op of ['add','sub','mul','div'] as const)contains(f32Op(op,p(a),p(b)),f(op==='add'?a+b:op==='sub'?a-b:op==='mul'?a*b:a/b));
  }
});
test('division encloses allowed error across power-of-two interior and rejects undefined/overflow cases',()=>{
  const range=f32Op('div',[2-2**-23,2+2**-22],p(1));
  contains(range,2-2*2**-23);contains(range,2+3*2**-23);
  assert.equal(f32Op('div',p(1),[-1,1]),null);
  assert.equal(f32Op('div',p(1),p(2**127)),null);
  assert.equal(f32Op('mul',p(f(3.4028234663852886e38)),p(2)),null);
  assert.equal(f32Op('add',null,p(1)),null);
  assert.throws(()=>p(.1));assert.throws(()=>f32Op('add',[2,1],p(1)));
});
test('search-domain enclosure includes shader rounding outside the old double domain',()=>{
  const margin=f(1e-7),lo=[1,1,1],hi=[2,2,2],box=f32SearchDomain(lo,hi,lo,hi,margin)!;
  const actual=f(1-f(.5*margin));assert.ok(actual<1-.5*margin);contains(box[0],actual);
  for(let i=0;i<3;i++)contains(box[i],f(2+f(.5*margin)));
  assert.equal(f32SearchDomain([0,0,0],[1,1,1],[0,0,0],[1,1,1],2**-126),null);
});
test('regression: exact plane projection bounds do not certify the shader float32 stencil',()=>{
  const values=new Float64Array(32);for(let i=0;i<8;i++)values.set([i&1,1,0,0],i*4);
  const t=[f(.7722772359848022),f(.1428571492433548),f(.04545454680919647)],value=[0,0,0,0];
  for(let i=0;i<8;i++){
    const w=t.map((v,k)=>(i&(1<<k))?v:f(1-v)),weight=f(f(w[0]*w[1])*w[2]);
    for(let k=0;k<4;k++)value[k]=f(value[k]+f(values[i*4+k]*weight));
  }
  const norm=f(f(f(value[1]*value[1])+f(value[2]*value[2]))+f(value[3]*value[3]));
  const actual=f(t[0]-f(value[1]*f(value[0]/Math.max(f(1e-8),norm))));
  const old=boundProjectionCell(values,[0,0,0],1).image[0];
  assert.equal(actual,2**-23);assert.ok(actual>old[1],'must not mistake a real-arithmetic enclosure for a shader certificate');
});
test('regression: sub-ULP body translation can create a false real-arithmetic rejection',()=>{
  const grid=new Float32Array(32);for(let i=0;i<8;i++)grid.set([100+(i&1),1,0,0],i*4);
  const field=new ProjectionField({dimensions:[2,2,2],origin:[100,0,0],cell:1,grid});
  const a:ProjectionBody={field,position:[0,0,0],rotation:[0,0,0,1],scale:1,com:[0,0,0]},b={...a,position:[f(2e-6),0,0] as Vec3};
  const point:Vec3=[f(100.3),f(.3),f(.4)],margin=f(1e-6),domain=point.map(v=>[v-margin*.5,v+margin*.5]) as [F32Interval,F32Interval,F32Interval];
  assert.equal(certifyProjectionPair(a,b,domain,{margin,maxNodes:31}).candidate,true);
  assert.equal(f(point[0]-b.position[0]),point[0]); // Identical local samples => identical offsets => zero unsigned gap.
  const localA=f32Op('sub',p(point[0]),p(0)),localB=f32Op('sub',p(point[0]),p(b.position[0]));
  contains(localA,point[0]);contains(localB,point[0]);
});

test('conditional projection perturbation enclosure covers regular, zero and floor-crossing gradients',async()=>{
  const { projectionPerturbationBound }=await import('../scripts/sdf-f32-enclosure.ts');
  const offset=(phi:number,g:number[])=>{const n=Math.max(f(1e-8),g.reduce((s,v)=>s+v*v,0));return g.map(v=>phi*v/n);};
  for(const lower of [0,f(.00005),f(.0001),f(.1),f(1)])for(const error of [0,f(.00001),f(.01),f(.5)]){
    const phi=f(.3),phiError=f(.005),radius=projectionPerturbationBound(phi,lower,phiError,error)!;
    for(let j=0;j<30;j++){
      const g=[lower,0,0],dg=[error*Math.cos(j)*.5,error*Math.sin(j)*.5,0],a=offset(phi,g),b=offset(phi+phiError*Math.sin(j),g.map((v,i)=>v+dg[i]));
      assert.ok(Math.hypot(...a.map((v,i)=>v-b[i]))<=radius);
    }
  }
  assert.equal(projectionPerturbationBound(1,1,0,0),0);
  assert.throws(()=>projectionPerturbationBound(1,-1,0,0));
});
