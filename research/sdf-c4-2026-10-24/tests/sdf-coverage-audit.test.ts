// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 1bea15850d624ccbfcef25751c2c08bc792a2b5e3e1603767c80781c409bf10d. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {auditCoverage} from '../scripts/sdf-coverage-audit.ts';
import {createCapture} from '../scripts/sdf-replay-format.ts';
import {VoxelField} from '../src/avbd3d/ref/sdf/voxel.ts';
import {SdfBody} from '../src/avbd3d/ref/sdf/body.ts';
import {collisionParams} from '../src/avbd3d/ref/sdf/manifold.ts';
import {packSdfAtlas,packSdfBodies,packSdfPairs,packSdfParams} from '../src/avbd3d/gpu/sdf-layout.ts';

function fixture({count=12,expectedActive=true,previousActive=true,matching=true,boundary=true}={}){
  const grid=new Float32Array(5**3*4);for(let z=0;z<5;z++)for(let y=0;y<5;y++)for(let x=0;x<5;x++)grid.set([x===2&&y===2&&z===2?-1:1,0,0,1],4*(x+5*(y+5*z)));
  if(!boundary)grid[0]=-1;
  const field=new VoxelField([5,5,5],[0,0,0],1,grid,{min:[0,0,0],max:[4,4,4]}),atlas=packSdfAtlas([field]);
  const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,[3,0,0])],bytes=(v:Uint32Array)=>new Uint8Array(v.buffer),stride=8+5*28,result=()=>new Uint8Array(count*stride*4);
  const previous=result(),expected=result();
  for(let i=0;i<count;i++){
    const old=new Uint32Array(previous.buffer),now=new Uint32Array(expected.buffer),at=i*stride;
    old.set([0,1,matching?17+i:100+i,1,0,0,4,0],at);old[at+24]=+previousActive;
    now.set([0,1,17+i,1,99,0,4,0],at);now[at+24]=+expectedActive;
  }
  return createCapture({schemaVersion:1,resultAbiVersion:1,kind:'sdf-narrowphase',source:{commit:'a'.repeat(40),files:{'fixture.ts':'a'.repeat(64)},shaderSha256:'b'.repeat(64)},metadata:{label:'coverage accounting fixture, synthetic contact flags',frame:1,substep:0,profile:'reference',energy:null,activeContacts:null},capacities:{maxBodies:2,maxPairs:count,maxPoints:5,seedStride:0,pairCount:count},dispatch:{x:1,y:1,z:1,workgroupSize:64}},
    {atlas:bytes(atlas.data),bodies:bytes(packSdfBodies(bodies,atlas)),pairs:bytes(packSdfPairs(Array.from({length:count},(_,i)=>({a:0,b:1,key:17+i,previous:i})),2,count)),params:bytes(packSdfParams(count,1,1/240,{...collisionParams(),warmStart:false},5)),previous,target:result(),expected});
}
const hashes=(c:ReturnType<typeof fixture>)=>Object.values(c.sections).map(b=>createHash('sha256').update(b!).digest('hex'));
test('coverage accounting retains every discrepancy, honors history identity and preserves input bytes',()=>{
  for(const matching of [true,false]){
    const capture=fixture({matching}),before=hashes(capture),r=auditCoverage(capture);
    assert.equal(r.clear,12);assert.equal(r.totalQueries,1188);assert.equal(r.clearQueries,1188);
    assert.equal(r.legacyActiveDisagreements,12);assert.equal(r.examples.length,12);
    assert.equal(r.disagreementsWithoutActiveHistory,matching?0:12);
    assert.equal(r.clearWithoutActiveHistory,matching?0:12);assert.equal(r.legacySearchRequired,true);assert.equal(r.productionEnabled,false);
    assert.deepEqual(hashes(capture),before);
  }
});
test('unsupported boundary is explicit in field and query reporting',()=>{
  const r=auditCoverage(fixture({boundary:false}));
  assert.equal(r.clear,0);assert.equal(r.tested,0);assert.equal(r.fields.length,1);
  assert.equal(r.fields[0].constructed,true);assert.equal(r.fields[0].supported,false);
  assert.equal(r.rejectedFields['boundary-not-positive'],1);assert.equal(r.reasons.unsupported,12);
});
test('bounded windows account for exactly the requested slot range',()=>{
  const c=fixture({expectedActive:false,previousActive:false}),all=auditCoverage(c),a=auditCoverage(c,127,0,5),b=auditCoverage(c,127,5,8192);
  assert.equal(a.queryPairs+b.queryPairs,all.queryPairs);assert.equal(a.totalQueries+b.totalQueries,all.totalQueries);
  assert.equal(a.clearQueries+b.clearQueries,all.clearQueries);assert.equal(all.legacyActiveDisagreements,0);
  for(const count of [0,8193,1.5])assert.throws(()=>auditCoverage(c,127,0,count));
});
