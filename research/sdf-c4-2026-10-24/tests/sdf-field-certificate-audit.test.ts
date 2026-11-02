// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: bb48cfc769987e42d3e9973efe74081a01a2bb6b9f98aebc9552122e011a6314. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { auditCertificate } from '../scripts/sdf-field-certificate-audit.ts';
import { createCapture } from '../scripts/sdf-replay-format.ts';
import { VoxelField } from '../src/avbd3d/ref/sdf/voxel.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { collisionParams } from '../src/avbd3d/ref/sdf/manifold.ts';
import { packSdfAtlas, packSdfBodies, packSdfPairs, packSdfParams } from '../src/avbd3d/gpu/sdf-layout.ts';
function fixture(previousActive:boolean, matching=true, expectedActive=false) {
  const fields=[1,-1].map(sign=>{
    const grid=new Float32Array(32);for(let i=0;i<8;i++)grid.set([1,0,0,sign],i*4);
    return new VoxelField([2,2,2],[-3,-3,-3],6,grid,{min:[-.1,-.1,-.1],max:[.1,.1,.1]});
  });
  const atlas=packSdfAtlas(fields),bytes=(v:Uint32Array)=>new Uint8Array(v.buffer),result=()=>new Uint8Array((8+5*28)*4);
  const previous=result(),expected=result();
  new Uint32Array(previous.buffer).set([0,1,matching?17:18,1,0,0,4,0]);new Uint32Array(previous.buffer)[24]=Number(previousActive);
  new Uint32Array(expected.buffer).set([0,1,17,1,99,0,4,0]);new Uint32Array(expected.buffer)[24]=Number(expectedActive);
  return createCapture({schemaVersion:1,resultAbiVersion:1,kind:'sdf-narrowphase',source:{commit:'a'.repeat(40),files:{'fixture.ts':'a'.repeat(64)},shaderSha256:'b'.repeat(64)},metadata:{label:'certificate audit fixture',frame:1,substep:0,profile:'reference',energy:null,activeContacts:null},capacities:{maxBodies:2,maxPairs:1,maxPoints:5,seedStride:0,pairCount:1},dispatch:{x:1,y:1,z:1,workgroupSize:64}},
    {atlas:bytes(atlas.data),bodies:bytes(packSdfBodies(fields.map(f=>new SdfBody(f)),atlas)),pairs:bytes(packSdfPairs([{a:0,b:1,key:17,previous:0}],2,1)),params:bytes(packSdfParams(1,1,1/240,{...collisionParams(),warmStart:false},5)),previous,target:result(),expected});
}
const hashes=(capture:ReturnType<typeof fixture>)=>Object.values(capture.sections).map(b=>createHash('sha256').update(b!).digest('hex'));
test('audit preserves all input bytes and vetoes active history even with warm starts disabled',()=>{
  const capture=fixture(true),before=hashes(capture),report=auditCertificate(capture);
  assert.equal(report.reasons['active-history'],1);assert.equal(report.tested,0);assert.equal(report.candidates,0);assert.deepEqual(hashes(capture),before);
});
test('audit ignores stale identities, counts work and detects a candidate contradicting captured contact',()=>{
  for(const active of [false,true]){
    const capture=fixture(true,false,active),before=hashes(capture),report=auditCertificate(capture);
    assert.equal(report.candidates,1);assert.equal(report.candidateQueries,99);assert.equal(report.totalQueries,99);
    assert.equal(report.contradictions,Number(active));assert.deepEqual(hashes(capture),before);
  }
});
