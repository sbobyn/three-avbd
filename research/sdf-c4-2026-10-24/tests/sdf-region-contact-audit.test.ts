// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 8d0440b6ada0a3946fa9243bee81644d0bca3532f240b76ae68dd8be2aeadc01. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {auditRegionContacts} from '../scripts/sdf-region-contact-audit.ts';
import {createCapture} from '../scripts/sdf-replay-format.ts';
import {VoxelField} from '../src/avbd3d/ref/sdf/voxel.ts';
import {SdfBody} from '../src/avbd3d/ref/sdf/body.ts';
import {collisionParams} from '../src/avbd3d/ref/sdf/manifold.ts';
import {packSdfAtlas,packSdfBodies,packSdfPairs,packSdfParams} from '../src/avbd3d/gpu/sdf-layout.ts';

function fixture(active:boolean,boundary=true){
  const grid=new Float32Array(9**3*4);
  for(let z=0;z<9;z++)for(let y=0;y<9;y++)for(let x=0;x<9;x++){
    const p=[x*.5-2,y*.5-2,z*.5-2],length=Math.hypot(...p);
    grid.set([length-.9,...p.map(v=>length?v/length:0)],4*(x+9*(y+9*z)));
  }
  if(!boundary)grid[0]=-1;
  const field=new VoxelField([9,9,9],[-2,-2,-2],.5,grid,{min:[-2,-2,-2],max:[2,2,2]}),atlas=packSdfAtlas([field]);
  const bodies=[new SdfBody(field,[0,0,0]),new SdfBody(field,[1.4,0,0])],count=6,stride=8+5*28,bytes=(v:Uint32Array)=>new Uint8Array(v.buffer),result=()=>new Uint8Array(count*stride*4),expected=result();
  const now=new Uint32Array(expected.buffer);
  for(let i=0;i<count;i++){now.set([0,1,17+i,1,i===0?0:99,0,4,0],i*stride);now[i*stride+24]=+active;}
  return createCapture({schemaVersion:1,resultAbiVersion:1,kind:'sdf-narrowphase',source:{commit:'a'.repeat(40),files:{'fixture.ts':'a'.repeat(64)},shaderSha256:'b'.repeat(64)},metadata:{label:'synthetic region audit fixture',frame:1,substep:0,profile:'reference',energy:null,activeContacts:null},capacities:{maxBodies:2,maxPairs:count,maxPoints:5,seedStride:0,pairCount:count},dispatch:{x:1,y:1,z:1,workgroupSize:64}},
    {atlas:bytes(atlas.data),bodies:bytes(packSdfBodies(bodies,atlas)),pairs:bytes(packSdfPairs(Array.from({length:count},(_,i)=>({a:0,b:1,key:17+i})),2,count)),params:bytes(packSdfParams(count,1,1/240,{...collisionParams(),warmStart:false},5)),previous:result(),target:result(),expected});
}
const hashes=(c:ReturnType<typeof fixture>)=>Object.values(c.sections).map(b=>createHash('sha256').update(b!).digest('hex'));
test('contact audit selects on geometry, preserves bytes and retains all selected rows',()=>{
  const outputs=[false,true].map(active=>{
    const c=fixture(active),before=hashes(c),r=auditRegionContacts(c,3,5);
    assert.deepEqual(r.rows.map(x=>x.slot),[1,2,3]);assert.equal(r.queryPairs,3);assert.equal(r.scannedSlots,4);
    assert.equal(r.fields.length,1);assert.equal(r.fields[0].constructed,true);assert.equal(r.gridBytes,9**3*16);
    assert.ok(r.rows.every(x=>x.candidates.length>0&&x.unresolved>0&&x.originalActive===+active));
    assert.ok(r.rows.every(x=>x.work.probes<=128&&x.work.regionTests<=8192));
    assert.deepEqual(hashes(c),before);assert.equal(r.productionEnabled,false);assert.equal(r.legacySearchRequired,true);
    return r.rows.map(x=>({slot:x.slot,candidates:x.candidates,work:x.work,unresolved:x.unresolved}));
  });
  assert.deepEqual(outputs[0],outputs[1]);
});
test('contact audit bounds query windows and reports unsupported fields explicitly',()=>{
  const c=fixture(false);assert.equal(auditRegionContacts(c,32,2).rows.length,2);
  const r=auditRegionContacts(fixture(false,false),32,3);assert.equal(r.rows.length,0);assert.equal(r.unsupported,3);assert.equal(r.queryPairs,3);
  for(const args of [[0,1024],[33,1024],[32,1025],[32,1.5]])assert.throws(()=>auditRegionContacts(c,...args as [number,number]));
});
test('native hints do not depend on expected activity and callbacks cannot change scalar proposals',()=>{
  const hints:unknown[][]=[];
  for(const active of [false,true]){
    const c=fixture(active),before=hashes(c),collected:unknown[]=[],plain=auditRegionContacts(c,3,5);
    const withHints=auditRegionContacts(c,3,5,(slot,a,b,h)=>{collected.push(structuredClone({slot,a,b,h}));h.point.fill(1e6);h.localA.fill(1e6);h.localB.fill(1e6);});
    assert.deepEqual(withHints.rows.map(r=>r.candidates),plain.rows.map(r=>r.candidates));
    assert.deepEqual(withHints.rows.map(r=>r.unresolved),plain.rows.map(r=>r.unresolved));
    for(const row of withHints.rows){assert.ok(row.work.hints<=3*row.work.probes);assert.ok(row.work.hintTransforms<=7*row.work.probes);}
    assert.equal(collected.length,withHints.rows.reduce((n,r)=>n+r.work.hints,0));assert.ok(collected.length);assert.deepEqual(hashes(c),before);hints.push(collected);
  }
  assert.deepEqual(hints[0],hints[1]);
});
