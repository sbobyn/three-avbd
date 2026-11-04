// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 437c1212ebd83d24adced2a35a2fce877b6317ccac9e9474b80804f29b0aef7f. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FieldRanges, certifyFieldPair, sampleBodyInterval, type CertificateBody, type Interval3, type Vec3 } from '../scripts/sdf-field-certificate.ts';
import { VoxelField } from '../src/avbd3d/ref/sdf/voxel.ts';

function constant(phi: number, gradient:Vec3): CertificateBody {
  const grid=new Float32Array(32);for(let i=0;i<8;i++)grid.set([phi,...gradient],i*4);
  return {field:new FieldRanges({dimensions:[2,2,2],origin:[-3,-3,-3],cell:6,grid}),position:[0,0,0],rotation:[0,0,0,1],scale:1,com:[0,0,0]};
}
const domain:Interval3=[[-.1,.1],[-.1,.1],[-.1,.1]], options={margin:.02,maxNodes:31};
test('interval screen accepts a separated projected-offset model',()=>{
  const result=certifyFieldPair(constant(1,[0,0,1]),constant(1,[0,0,-1]),domain,options);
  assert.equal(result.candidate,true);assert.equal(result.nodes,1);
});
test('equal gradients, zero gradients and both-inside fields cannot be certified',()=>{
  for(const pair of [[constant(1,[0,0,1]),constant(1,[0,0,1])],[constant(1,[0,0,0]),constant(1,[0,0,0])],[constant(-1,[0,0,1]),constant(-1,[0,0,-1])]])assert.equal(certifyFieldPair(pair[0],pair[1],domain,options).candidate,false);
});
test('active history and unsupported contact modes fail open',()=>{
  for(const reason of ['activeHistory','signedSeparation','meshContacts'] as const){
    const result=certifyFieldPair(constant(1,[0,0,1]),constant(1,[0,0,-1]),domain,{...options,[reason]:true});
    assert.equal(result.candidate,false);assert.equal(result.nodes,0);
  }
});
test('invalid domains and numerical range fail open without throwing',()=>{
  for(const box of [[[1,0],[0,0],[0,0]],[[NaN,1],[0,0],[0,0]],[[1e31,1e31],[0,0],[0,0]]] as Interval3[])
    assert.equal(certifyFieldPair(constant(1,[0,0,1]),constant(1,[0,0,-1]),box,options).candidate,false);
  for(const maxNodes of [0,128,NaN])assert.equal(certifyFieldPair(constant(1,[0,0,1]),constant(1,[0,0,-1]),domain,{...options,maxNodes}).candidate,false);
});
test('field range pyramid is a snapshot, including odd dimensions',()=>{
  const grid=new Float32Array(3*5*7*4);for(let i=0;i<grid.length/4;i++)grid.set([i,1,-2,3],i*4);
  const field=new FieldRanges({dimensions:[3,5,7],origin:[0,0,0],cell:1,grid});grid.fill(999);
  const result=field.sample([[0,2],[0,4],[0,6]]);
  assert.ok(result.phi[0]<=0&&result.phi[1]>=104&&result.phi[1]<105);
});
test('sampled f32 voxel values fit the interval screen inside, outside and across grid edges',()=>{
  const dimensions:Vec3=[5,4,3],origin:Vec3=[-.3,-.2,-.1],cell=Math.fround(.1),grid=new Float32Array(5*4*3*4);
  for(let i=0;i<grid.length;i++)grid[i]=Math.sin(i*12.345)*.8;
  const field=new FieldRanges({dimensions,origin,cell,grid}),oracle=new VoxelField(dimensions,origin,cell,grid,{min:origin,max:[.1,.1,.1]});
  const boxes:Interval3[]=[[[0,.01],[0,.01],[0,.01]],[[-.6,-.4],[-.1,0],[-.1,0]],[[-.31,-.29],[-.21,-.19],[-.11,-.09]],[[.09,.11],[.09,.11],[.09,.11]]];
  for(const box of boxes){const bound=field.sample(box);for(let j=0;j<50;j++){
    const p=box.map((v,i)=>v[0]+(v[1]-v[0])*((j*(i*2+3))%49)/49) as Vec3,actual=oracle.sample(p);
    assert.ok(actual.phi>=bound.phi[0]&&actual.phi<=bound.phi[1],`phi ${actual.phi} in ${bound.phi}`);
    actual.gradient.forEach((value,i)=>assert.ok(value>=bound.gradient[i][0]&&value<=bound.gradient[i][1]));
  }}
});
test('transformed constant fields retain projected scale and quaternion rotation',()=>{
  const body=constant(1,[1,0,0]);body.position=[1,2,3];body.scale=2;body.rotation=[0,0,Math.SQRT1_2,Math.SQRT1_2];body.com=[.1,.2,.3];
  const sample=sampleBodyInterval(body,[[1,1],[2,2],[3,3]]);
  assert.ok(sample.phi[0]<2&&sample.phi[1]>2);
  assert.ok(sample.gradient[1][0]<1&&sample.gradient[1][1]>1);
  assert.ok(sample.gradient[0][0]<0&&sample.gradient[0][1]>0);
});

test('disjoint rotated geometric bounds still fail the equal-projection counterexample',()=>{
  const a=constant(1,[0,0,1]),b=constant(1,[0,0,1]);
  a.rotation=b.rotation=[0,0,Math.sin(Math.PI/8),Math.cos(Math.PI/8)];
  b.position=[-.5/Math.sqrt(2),.5/Math.sqrt(2),0];
  assert.equal(certifyFieldPair(a,b,domain,options).candidate,false);
});
