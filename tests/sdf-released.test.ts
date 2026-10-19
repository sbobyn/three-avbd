import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { principalInertia } from '../src/lib/inertia.ts';
import { loadReleasedScene, releasedSettings, releasedScenes, warpVariants, type ReadAsset } from '../src/sdf-released/scenes.ts';
const read:ReadAsset=async path=>{const b=await readFile(new URL(`./fixtures/${path}`,import.meta.url));return b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength) as ArrayBuffer;};
const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-6*Math.max(1,Math.abs(b)),`${a} != ${b}`);

test('principal inertia rejects invalid tensors and reconstructs off-diagonal inertia',()=>{
  for(const tensor of [[0,0,0,0,0,0,0,0,0],[1,2,0,0,1,0,0,0,1],[1,0,0,0,-1,0,0,0,1]])assert.throws(()=>principalInertia(tensor));
  const tensor=[2,.3,.2,.3,3,.4,.2,.4,4],p=principalInertia(tensor);
  const m=new Matrix4().makeRotationFromQuaternion(new Quaternion(...p.rotation)).elements;
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)near(p.moments.reduce((sum,v,k)=>sum+v*m[k*4+i]*m[k*4+j],0),tensor[i*3+j]);
});

for(const entry of releasedScenes)test(`released ${entry.name} preserves full inertia, source poses and collision/render alignment`,async()=>{
  const scene=await loadReleasedScene(entry.id,read);
  try{
    assert.deepEqual(releasedSettings(scene,'reference').collision,scene.capture.params);
    const quality=releasedSettings(scene).collision,mesh=scene.bodies.some(b=>b.original.shape.kind==='voxel'),nonConvex=scene.bodies.some(b=>!b.original.shape.convex);
    assert.equal(quality.meshVertexContacts,mesh?true:undefined,'mesh vertex contacts are enabled for mesh scenes only');
    assert.equal(releasedSettings(scene,'reference').collision.meshVertexContacts,undefined);
    near(quality.margin-quality.allowedPenetration,scene.capture.params.margin-scene.capture.params.allowedPenetration);
    assert.equal(quality.margin,nonConvex?.04:scene.capture.params.margin,'quality settings for every non-convex scene');
    assert.equal(quality.signedSeparation,nonConvex?true:undefined);
    assert.equal(releasedSettings(scene,'reference').collision.signedSeparation,undefined);
    assert.equal(scene.capture.params.cacheSize,4,'quality never mutates the captured parameters');
    assert.equal(scene.bodies.length,{0:29,1:11,2:13,3:13,4:13,5:13,6:28,7:12,8:20,9:28,10:49}[entry.id]);
    for(const body of scene.bodies){
      const b=body.original;
      if(b.static&&b.shape.kind==='box')assert.equal(body.field.seeds.length,0,'released Ground is not finalized');
      else assert.ok(body.field.seeds.length>0,'every other library shape is finalized');
      const fieldQ=new Quaternion(...body.fieldRotation),bodyQ=new Quaternion(...body.rotation),sourceQ=new Quaternion(...b.orientation).normalize();
      near(Math.abs(bodyQ.clone().multiply(fieldQ).dot(sourceQ)),1);
      if(!b.static){
        const matrix=new Matrix4().makeRotationFromQuaternion(fieldQ.clone().invert()).elements;
        for(let i=0;i<3;i++)for(let j=0;j<3;j++)near(body.moments.reduce((sum,v,k)=>sum+v*matrix[k*4+i]*matrix[k*4+j],0),b.inertia[i][j]);
      }
      // A render vertex transformed back to the original source frame must lie on its field.
      const p=body.geometry.getAttribute('position');
      for(let i=0;i<p.count;i+=Math.max(1,Math.floor(p.count/30))){
        const source=new Vector3().fromBufferAttribute(p,i).applyQuaternion(fieldQ.clone().invert()).multiplyScalar(1/b.scale).add(new Vector3(...body.field.centerOfMass));
        assert.ok(Math.abs(body.field.sample(source.toArray()).phi)<.025,'source surface within voxel interpolation tolerance');
      }
    }
  } finally {scene.dispose();}
});


test('released assets also accept HTTP-decoded gzip and still verify content hashes',async()=>{
  const decoded:ReadAsset=async path=>{
    const data=await read(path);if(!path.endsWith('.gz'))return data;
    const raw=gunzipSync(new Uint8Array(data));return raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength) as ArrayBuffer;
  };
  const scene=await loadReleasedScene(1,decoded);assert.equal(scene.bodies.length,11);scene.dispose();
  await assert.rejects(loadReleasedScene(1,async path=>path.endsWith('.gz')?new ArrayBuffer(4):read(path)),/checksum mismatch/);
});

test('analytic render surfaces lie on their field and face outward',async()=>{
  const {AnalyticField}=await import('../src/lib/sdf.ts');type Spec=ConstructorParameters<typeof AnalyticField>[0];
  const {fieldSurface}=await import('../src/sdf-released/mesher.ts');
  const specs:Spec[]=[{kind:'torus',majorRadius:.5,minorRadius:.2},{kind:'cone',radius:.5,halfHeight:.5},
    {kind:'warp',type:0,halfExtents:[1.15,.28,.55],k:.95},{kind:'warp',type:2,halfExtents:[1.15,.28,.55],k:.1},
    {kind:'spiky-wheel',hubRadius:.35,hubHalfWidth:.48,spikeRadius:.08,spikeHalfHeight:.7,spikes:16},
    {kind:'spike-plate',halfExtents:[.7,.08,.7],count:10,spikeRadius:.045,minHeight:.12,maxHeight:.26},
    {kind:'warp',type:1,halfExtents:[1.15,.55,.28],k:1.25},{kind:'sphere',radius:.5},
    {kind:'capsule',radius:.3,halfLength:.4},{kind:'cylinder',radius:.4,halfHeight:.4}] as Spec[];
  // Shipped resolutions: 72 cells for spikes and warps, 48 for smooth primitives (checked at both).
  const smooth=new Set(['sphere','capsule','cylinder','cone','torus']);
  for(const [spec,cells] of specs.flatMap(spec=>smooth.has(spec.kind)?[[spec,72],[spec,48]] as const:[[spec,72]] as const)){
    const field=new AnalyticField(spec),geometry=fieldSurface(field,cells);
    const {min,max}=field.bounds,h=Math.max(...max.map((v,k)=>v-min[k]))/cells;
    const p=geometry.getAttribute('position'),index=geometry.index!;
    assert.ok(index.count>=3*100,`${spec.kind}: surface has triangles`);
    for(let i=0;i<p.count;i++)assert.ok(Math.abs(field.sample([p.getX(i),p.getY(i),p.getZ(i)]).phi)<h,`${spec.kind}: vertex ${i} off the surface`);
    // Area-weighted: sub-cell spike tips leave tiny slivers with arbitrary normals.
    let outward=0,total=0;const a=new Vector3(),b=new Vector3(),c=new Vector3();
    for(let t=0;t<index.count;t+=3){
      a.fromBufferAttribute(p,index.getX(t));b.fromBufferAttribute(p,index.getX(t+1));c.fromBufferAttribute(p,index.getX(t+2));
      const normal=b.clone().sub(a).cross(c.clone().sub(a)),area=normal.length()/2,centre=a.clone().add(b).add(c).divideScalar(3);
      // Outward means phi rises along the normal (gradients are ill-defined at spike tips and kinks).
      const step=normal.normalize().multiplyScalar(h/4);total+=area;
      if(field.sample(centre.clone().add(step).toArray()).phi>field.sample(centre.clone().sub(step).toArray()).phi)outward+=area;
    }
    assert.ok(outward>=.99*total,`${spec.kind}: ${(100*outward/total).toFixed(2)}% of surface area faces outward`);
    geometry.dispose();
  }
});

test('released warp scenes load every captured Table 5 strength',async()=>{
  for(const [id,strengths] of Object.entries(warpVariants)){
    for(const k of strengths){
      const scene=await loadReleasedScene(Number(id),read,k);
      try{
        const warps=scene.bodies.filter(b=>b.original.shape.kind==='warp');
        assert.equal(warps.length,12,`scene ${id} k ${k}`);
        for(const b of warps)near(b.original.shape.k as number,Number(k));
      }finally{scene.dispose();}
    }
  }
  await assert.rejects(loadReleasedScene(2,read,'0.15'),/No captured warp strength/);
});

test('released measurements reject overflow in an early substep before counters reset',async()=>{
  const {measuredFrame}=await import('../src/sdf-released/metrics.ts');
  type Scene=Parameters<typeof measuredFrame>[0];
  type World=Parameters<typeof measuredFrame>[1];
  let steps=0;
  const scene={capture:{solver:{dt:4}}} as Scene;
  const world={dt:1,step(){steps++;},async readSdfResults(){return [];},solver:{async readCounters(){return {overflow:steps===1?1:0};}}} as unknown as World;
  await assert.rejects(measuredFrame(scene,world,[],1),/Collision overflow 1 at substep 0/);
  assert.equal(steps,1,'the invalid measurement stops before a later substep clears the evidence');
});
