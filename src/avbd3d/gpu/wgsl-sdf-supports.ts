import { SDF_MAX_POINTS } from './sdf-layout.ts';
/** Exact mesh vertex contacts: a support against a covering box top face (meshPlaneContacts) or a
 * witness between two dynamic meshes (meshMeshContacts). Other pairs use Algorithm 1 only. */
/** SDF_SUPPORTS_WGSL for a pass whose pair results hold `maxPoints` points. */
export const sdfSupportsSource = (maxPoints: number = SDF_MAX_POINTS) => /* wgsl */ `
fn meshPlaneContacts(pair: vec4u) -> bool {
  if(params.distances.w==0.0) { return false; }
  let fixedA=bodyA.velocity.w!=0.0 && atlas[bodyHeader(bodyA)].x==0u;
  let fixedB=bodyB.velocity.w!=0.0 && atlas[bodyHeader(bodyB)].x==0u;
  if(!fixedA && !fixedB) { return false; }
  var mesh=bodyA; var plane=bodyB;
  if(fixedA) { mesh=bodyB; plane=bodyA; }
  let h=bodyHeader(mesh); let header=atlas[h]; let count=atlas[h+3u].w;
  if(mesh.velocity.w!=0.0 || count==0u) { return false; }
  let half=bitcast<vec4f>(atlas[bodyHeader(plane)+5u]).xyz;
  // Restrict the plane shortcut to a top face covering the entire moving AABB.
  // Edge/side/underside contacts must continue through the general SDF search.
  for(var i=0u;i<8u;i++) {
    let corner=vec3f(select(mesh.lo.x,mesh.hi.x,(i&1u)!=0u),select(mesh.lo.y,mesh.hi.y,(i&2u)!=0u),select(mesh.lo.z,mesh.hi.z,(i&4u)!=0u));
    let p=localPoint(plane,corner);
    if(abs(p.x)>=half.x || abs(p.z)>=half.z || p.y<=-half.y) { return false; }
  }
  let up=rot(plane.rotation,vec3f(0,1,0));
  let normal=select(-up,up,fixedA);
  var lowest=1e30; var best=0u;
  for(var i=0u;i<count;i++) {
    let p=worldPoint(mesh,bitcast<vec4f>(atlas[header.z+header.w+i]).xyz);
    let separation=(localPoint(plane,p).y-half.y)*plane.position.w;
    if(separation<lowest) { lowest=separation; best=i; }
  }
  work.stats.x+=count;
  // Supplemental safeguard only: preserve ordinary contacts and their ranking.
  if(lowest>=min(params.distances.x,0.5*params.values.w)) { return false; }
  let p=worldPoint(mesh,bitcast<vec4f>(atlas[header.z+header.w+best]).xyz);
  let separation=lowest; let projected=p-up*separation;
  var a=p; var b=projected; if(fixedA) { a=projected; b=p; }
  let id=0x40000000u+best;
  var cached=0u;
  if(params.flags.y!=0u && pair.w!=0xffffffffu && pair.w<arrayLength(&previous)) {
    // Read individual history entries; avoid a per-invocation copy of the entire contact array.
    if(all(previous[pair.w].identity.xyz==pair.xyz)) {
      for(var j=0u;j<previous[pair.w].identity.w;j++) { if(previous[pair.w].points[j].flags.z==id) { cached=1u; } }
    }
  }
  let slot=min(work.identity.w,${maxPoints - 1}u);
  work.points[slot]=Point(vec4f(p,min(0.0,separation)),vec4f(normal,separation),
    vec4f(rot(bodyA.anchorRotation,invrot(bodyA.rotation,a-bodyA.position.xyz)),0),
    vec4f(rot(bodyB.anchorRotation,invrot(bodyB.rotation,b-bodyB.position.xyz)),0),vec4u(1,cached,id,0),vec4f(1,0,0,1),vec4f(0,1,0,0));
  work.identity.w=slot+1u;
  return true;
}
/** Deepest source vertex of 'mesh' (inside the pair volume) in 'other's field. */
fn meshVertexScan(mesh: Body, other: Body, side: u32, best: ptr<function,vec4f>, bestId: ptr<function,u32>) {
  let h=bodyHeader(mesh); let header=atlas[h]; let count=min(atlas[h+3u].w,0x08000000u);
  for(var i=0u;i<count;i++) {
    let p=worldPoint(mesh,bitcast<vec4f>(atlas[header.z+header.w+i]).xyz);
    if(!inside(p)) { continue; }
    let s=worldField(other,p); work.stats.x++;
    // A vanishing gradient gives no usable normal; leave that vertex to Algorithm 1.
    if(s.phi<(*best).w && dot(s.gradient,s.gradient)>=0.25) { *best=vec4f(p,s.phi); *bestId=0x40000000u|(side<<27u)|i; }
  }
}
/** Mesh-to-mesh analogue of the plane support: one exact vertex witness per pair. */
fn meshMeshContacts(pair: vec4u) -> bool {
  if(params.distances.w==0.0 || bodyA.velocity.w!=0.0 || bodyB.velocity.w!=0.0) { return false; }
  var best=vec4f(0,0,0,1e30); var id=0u;
  meshVertexScan(bodyA,bodyB,0u,&best,&id); meshVertexScan(bodyB,bodyA,1u,&best,&id);
  if(id==0u || best.w>=min(params.distances.x,0.5*params.values.w)) { return false; }
  let p=best.xyz; let separation=best.w; let fromB=((id>>27u)&1u)!=0u;
  var a=p; var b=p; var normal: vec3f;
  // Point normals follow addPoint: na=unit(gradA), nb=-unit(gradB).
  if(fromB) { let n=unit(worldField(bodyA,p).gradient); normal=n; a=p-n*separation; }
  else { let n=unit(worldField(bodyB,p).gradient); normal=-n; b=p-n*separation; }
  var cached=0u;
  if(params.flags.y!=0u && pair.w!=0xffffffffu && pair.w<arrayLength(&previous)) {
    // Read individual history entries; avoid a per-invocation copy of the entire contact array.
    if(all(previous[pair.w].identity.xyz==pair.xyz)) {
      for(var j=0u;j<previous[pair.w].identity.w;j++) { if(previous[pair.w].points[j].flags.z==id) { cached=1u; } }
    }
  }
  let slot=min(work.identity.w,${maxPoints - 1}u);
  work.points[slot]=Point(vec4f(p,min(0.0,separation)),vec4f(normal,separation),
    vec4f(rot(bodyA.anchorRotation,invrot(bodyA.rotation,a-bodyA.position.xyz)),0),
    vec4f(rot(bodyB.anchorRotation,invrot(bodyB.rotation,b-bodyB.position.xyz)),0),vec4u(1,cached,id,0),vec4f(1,0,0,1),vec4f(0,1,0,0));
  work.identity.w=slot+1u;
  return true;
}
`;
export const SDF_SUPPORTS_WGSL = sdfSupportsSource();
