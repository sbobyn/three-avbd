// Internal bridge: preserve the production contact ABI with one manifold per SDF point.
import { PRELUDE_3D } from './layout.ts';
import { IGNORE_PAIRS_WGSL } from './wgsl-collision.ts';
import { SDF_MAX_POINTS } from './sdf-layout.ts';

export const sdfPrepareWGSL = /* wgsl */ `
${PRELUDE_3D}
struct SdfBody { position: vec4f, rotation: vec4f, velocity: vec4f, omega: vec4f, lo: vec4f, hi: vec4f, anchorRotation: vec4f }
@group(0) @binding(0) var<storage,read> bodies: array<Body>;
struct Config { info: vec4u, rotation: vec4f }
@group(0) @binding(1) var<storage,read> configs: array<Config>;
@group(0) @binding(2) var<storage,read> atlas: array<vec4u>;
@group(0) @binding(3) var<storage,read_write> output: array<SdfBody>;
@compute @workgroup_size(64) fn prepare(@builtin(global_invocation_id) gid: vec3u) {
  let i=gid.x; if(i>=arrayLength(&configs)) { return; }
  let body=bodies[i]; let config=configs[i].info; let rotation=qmul(body.rot,configs[i].rotation); let h=config.x; let scale=bitcast<f32>(config.y);
  let localLo=bitcast<vec4f>(atlas[h+2u]).xyz; let localHi=bitcast<vec4f>(atlas[h+3u]).xyz;
  let com=bitcast<vec4f>(atlas[h+4u]).xyz;
  var lo=vec3f(3.4e38); var hi=vec3f(-3.4e38);
  for(var c=0u;c<8u;c++) {
    let p=vec3f(select(localLo.x,localHi.x,(c&1u)!=0u),select(localLo.y,localHi.y,(c&2u)!=0u),select(localLo.z,localHi.z,(c&4u)!=0u));
    let world=body.pos.xyz+qrotate(rotation,(p-com)*scale); lo=min(lo,world); hi=max(hi,world);
  }
  output[i]=SdfBody(vec4f(body.pos.xyz,scale),rotation,vec4f(body.vel.xyz,f32(body.size.w<=0.0)),
    vec4f(body.angVel.xyz,bitcast<f32>(h)),vec4f(lo,bitcast<f32>(config.z)),vec4f(hi,0),configs[i].rotation);
}`;

/** sdfExportWGSL for a pass whose pair results hold `maxPoints` points. */
export const sdfExportSource = (maxPoints: number = SDF_MAX_POINTS) => /* wgsl */ `
${PRELUDE_3D}
struct Point { x: vec4f, normal: vec4f, anchorA: vec4f, anchorB: vec4f, flags: vec4u, ellipsoidA: vec4f, ellipsoidB: vec4f }
struct Result { identity: vec4u, stats: vec4u, points: array<Point,${maxPoints}> }
struct BridgeParams { counts: vec4u, distances: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> bridge: BridgeParams;
@group(0) @binding(2) var<storage,read> bodies: array<Body>;
@group(0) @binding(3) var<storage,read_write> results: array<Result>;
@group(0) @binding(4) var<storage,read> previous: array<Result>;
@group(0) @binding(5) var<storage,read> pairs: array<vec4u>;
@group(0) @binding(6) var<storage,read> prevContacts: array<Contact>;
@group(0) @binding(7) var<storage,read_write> contacts: array<Contact>;
@group(0) @binding(8) var<storage,read_write> manifolds: array<Manifold>;
@group(0) @binding(9) var<storage,read_write> counters: array<atomic<u32>>;
@compute @workgroup_size(64) fn exportContacts(@builtin(global_invocation_id) gid: vec3u) {
  let slot=gid.x; if(slot>=bridge.counts.x) { return; }
  let pair=pairs[slot]; if(pair.x==0xffffffffu) { return; }
  let result=results[slot]; let a=pair.x; let b=pair.y;
  atomicAdd(&counters[C_PAIRS],1u);
  for(var i=0u;i<result.identity.w;i++) {
    let point=result.points[i]; results[slot].points[i].flags.w=0u;
    if(point.flags.x==0u) { continue; }
    let n=-point.normal.xyz; let basis=orthonormal(n);
    var rA=point.anchorA.xyz; var rB=point.anchorB.xyz;
    var lam=vec3f(0); var pen=vec3f(0); var stick=0u;
    // Only the previous SDF result can identify the solved production point.
    // Its export slot is separate from pair keys and from rank/sort position.
    if(point.flags.y!=0u && pair.w!=0xffffffffu && pair.w<arrayLength(&previous)) {
      // Read individual history entries; avoid a per-invocation copy of the entire contact array.
      if(all(previous[pair.w].identity.xyz==pair.xyz)) {
        for(var j=0u;j<previous[pair.w].identity.w;j++) {
          let prior=previous[pair.w].points[j];
          if(prior.flags.z==point.flags.z && prior.flags.w>0u && prior.flags.w<=arrayLength(&prevContacts)) {
            let k=prevContacts[prior.flags.w-1u];
            let oldBasis=orthonormal(-prior.normal.xyz);
            lam=transpose(basis)*(oldBasis*k.lam); pen=k.pen;
            stick=select(k.key&STICK_BIT,0u,result.stats.w!=0u);
            if(stick!=0u && bridge.distances.z>0.0) {
              let retained=bodies[a].pos.xyz+qrotate(bodies[a].rot,k.rA)-bodies[b].pos.xyz-qrotate(bodies[b].rot,k.rB);
              let moved=max(length(rA-k.rA),length(rB-k.rB));
              // A relocated optimizer point cannot keep an unrelated material constraint.
              if(moved>3.0*bridge.distances.z && point.normal.w<dot(n,retained)-bridge.distances.z) { stick=0u; }
            }
            if(stick!=0u) { rA=k.rA; rB=k.rB; }
            break;
          }
        }
      }
    }
    let d=bodies[a].pos.xyz+qrotate(bodies[a].rot,rA)-bodies[b].pos.xyz-qrotate(bodies[b].rot,rB);
    // A sticking constraint retains its material anchors. Its normal error must
    // use those same anchors, not the optimizer's newly relocated contact.
    let separation=select(point.normal.w,dot(n,d),stick!=0u);
    let c0=vec3f(separation-bridge.distances.x+bridge.distances.y,
      select(0.0,dot(basis[1],d),stick!=0u),select(0.0,dot(basis[2],d),stick!=0u));
    lam *= params.alpha*params.gamma;
    pen=clamp(pen*params.gamma,vec3f(PENALTY_MIN),vec3f(PENALTY_MAX));
    if((params.flags&FLAG_MASS_PENALTY)!=0u) {
      let mA=select(bodies[a].size.w,3.4e38,bodies[a].size.w<=0.0);
      let mB=select(bodies[b].size.w,3.4e38,bodies[b].size.w<=0.0);
      pen.x=max(pen.x,clamp(min(mA,mB)/(params.dt*params.dt),PENALTY_MIN,PENALTY_MAX));
    }
    let m=atomicAdd(&counters[C_MANIFOLDS],1u);
    if(m>=params.manifoldCapacity) { atomicOr(&counters[C_OVERFLOW],4u); continue; }
    let c=atomicAdd(&counters[C_CONTACTS],1u);
    if(c>=params.contactCapacity) {
      atomicOr(&counters[C_OVERFLOW],2u); manifolds[m]=Manifold(vec4u(a,b,0u,0u),vec4f(n,0)); continue;
    }
    let rolling=select(0u,SDF_ROLLING_BIT,result.stats.w!=0u);
    contacts[c]=Contact(rA,(point.flags.z&~STICK_BIT)|stick|rolling,rB,c0.x,pen,c0.y,lam,c0.z);
    manifolds[m]=Manifold(vec4u(a,b,c,1u|(params.step<<4u)),vec4f(n,sqrt(bodies[a].pos.w*bodies[b].pos.w)));
    results[slot].points[i].flags.w=c+1u;
  }
}`;
export const sdfExportWGSL = sdfExportSource();


/** Conservative SDF bounds and the exact production mask/joint exclusion policy. */
export const sdfFilterWGSL = /* wgsl */ `
${PRELUDE_3D}
struct SdfBody { position: vec4f, rotation: vec4f, velocity: vec4f, omega: vec4f, lo: vec4f, hi: vec4f, anchorRotation: vec4f }
struct BridgeParams { counts: vec4u, distances: vec4f }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> bridge: BridgeParams;
@group(0) @binding(2) var<storage,read> sdfBodies: array<SdfBody>;
@group(0) @binding(3) var<storage,read_write> pairs: array<vec4u>;
@group(0) @binding(4) var<storage,read> statics: array<u32>;
@group(0) @binding(5) var<storage,read> joints: array<Joint>;
@group(0) @binding(6) var<storage,read> filters: array<vec2u>;
${IGNORE_PAIRS_WGSL}
@compute @workgroup_size(64) fn filterPairs(@builtin(global_invocation_id) gid: vec3u) {
  let slot=gid.x; if(slot>=bridge.counts.x) { return; }
  let pair=pairs[slot]; let a=sdfBodies[pair.x]; let b=sdfBodies[pair.y];
  let fa=filters[pair.x]; let fb=filters[pair.y];
  let margin=vec3f(bridge.distances.x);
  if((a.velocity.w!=0.0&&b.velocity.w!=0.0) || (fa.x&fb.y)==0u || (fb.x&fa.y)==0u ||
    any(a.lo.xyz>b.hi.xyz+margin) || any(b.lo.xyz>a.hi.xyz+margin) || ignored(pair.x,pair.y)) {
    pairs[slot].x=0xffffffffu;
  }
}`;

/** One reporting manifold per physical pair. Solver manifolds/forces stay untouched. */
/** sdfEventsWGSL for a pass whose pair results hold `maxPoints` points. */
export const sdfEventsSource = (maxPoints: number = SDF_MAX_POINTS) => /* wgsl */ `
${PRELUDE_3D}
struct Point { x: vec4f, normal: vec4f, anchorA: vec4f, anchorB: vec4f, flags: vec4u, ellipsoidA: vec4f, ellipsoidB: vec4f }
struct Result { identity: vec4u, stats: vec4u, points: array<Point,${maxPoints}> }
struct BridgeParams { counts: vec4u, distances: vec4f }
@group(0) @binding(0) var<uniform> bridge: BridgeParams;
@group(0) @binding(1) var<storage,read> results: array<Result>;
@group(0) @binding(2) var<storage,read> solved: array<Contact>;
@group(0) @binding(3) var<storage,read_write> manifolds: array<Manifold>;
@group(0) @binding(4) var<storage,read_write> contacts: array<Contact>;
@group(0) @binding(5) var<storage,read_write> counters: array<u32>;
@compute @workgroup_size(64) fn reportPairs(@builtin(global_invocation_id) id: vec3u) {
  let i=id.x;
  if(i==0u) { counters[C_MANIFOLDS]=bridge.counts.x; }
  if(i>=bridge.counts.x) { return; }
  let r=results[i]; var count=0u; var anchor=vec3f(0); var normal=vec3f(0); var fallback=vec3f(0,1,0); var force=0.0;
  for(var j=0u;j<r.identity.w;j++) {
    let p=r.points[j];
    if(p.flags.x==0u || p.flags.w==0u || p.flags.w>arrayLength(&solved)) { continue; }
    let k=solved[p.flags.w-1u]; count++; anchor+=k.rA;
    let strength=abs(k.lam.x); force+=strength;
    fallback=-p.normal.xyz; normal+=fallback*strength;
  }
  if(length(normal)>1e-12) { normal=normalize(normal); } else { normal=fallback; }
  manifolds[i]=Manifold(vec4u(r.identity.xy,i,select(0u,1u,count>0u)),vec4f(normal,0));
  contacts[i]=Contact(anchor/f32(max(count,1u)),0u,vec3f(0),0,vec3f(0),0,vec3f(force,0,0),0);
}`;
export const sdfEventsWGSL = sdfEventsSource();
