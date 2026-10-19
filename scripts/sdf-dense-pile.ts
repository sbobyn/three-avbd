// Diagnostic dense surface-to-SDF backend for small released piles. No optimizer/manifold reduction.
import * as THREE from 'three';
import { PRELUDE_3D } from '../src/avbd3d/gpu/layout.ts';
import { SDF_FIELDS_WGSL } from '../src/avbd3d/gpu/wgsl-sdf-fields.ts';
import { packSdfAtlas } from '../src/avbd3d/gpu/sdf-layout.ts';
import type { GpuSolver3D, GpuCollisionBackend3D, GpuCollisionContext3D } from '../src/avbd3d/gpu/solver.ts';
import type { ReleasedScene } from '../src/sdf-released/scenes.ts';
import { denseSurfacePoints } from './sdf-dense-plane.ts';
const shader=/* wgsl */ `
${PRELUDE_3D}
struct FieldBody {position:vec4f,rotation:vec4f,velocity:vec4f,omega:vec4f}
${SDF_FIELDS_WGSL.replaceAll(/\bBody\b/g,'FieldBody')}
struct Oracle { counts:vec4u, distances:vec4f }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<uniform> oracle:Oracle;
@group(0) @binding(2) var<storage,read> bodies:array<Body>;
struct Config { info:vec4u, rotation:vec4f, scale:vec4f }
@group(0) @binding(3) var<storage,read> atlas:array<vec4u>;
@group(0) @binding(4) var<storage,read> configs:array<Config>;
@group(0) @binding(5) var<storage,read> samples:array<vec4f>;
@group(0) @binding(6) var<storage,read> oldSlots:array<vec4u>;
@group(0) @binding(7) var<storage,read_write> slots:array<vec4u>;
@group(0) @binding(8) var<storage,read> prevContacts:array<Contact>;
@group(0) @binding(9) var<storage,read_write> contacts:array<Contact>;
@group(0) @binding(10) var<storage,read_write> manifolds:array<Manifold>;
@group(0) @binding(11) var<storage,read_write> counters:array<atomic<u32>>;
@compute @workgroup_size(64) fn dense(@builtin(global_invocation_id) gid:vec3u){
  let id=gid.x;if(id>=oracle.counts.x*oracle.counts.x*1000u){return;}
  slots[id]=vec4u(0);
  let pair=id/1000u;let a=pair/oracle.counts.x;let b=pair%oracle.counts.x;let point=id%1000u;
  if(a==b||configs[a].info.z==0u){return;}
  var rA=samples[configs[a].info.y+point].xyz;
  let p=bodies[a].pos.xyz+qrotate(bodies[a].rot,rA);
  var fieldBody:FieldBody;fieldBody.position=vec4f(bodies[b].pos.xyz,configs[b].scale.x);
  fieldBody.rotation=qmul(bodies[b].rot,configs[b].rotation);fieldBody.omega.w=bitcast<f32>(configs[b].info.x);
  let local=localPoint(fieldBody,p);let h=configs[b].info.x;let margin=oracle.distances.x/configs[b].scale.x;
  if(any(local<bitcast<vec4f>(atlas[h+2u]).xyz-vec3f(margin))||any(local>bitcast<vec4f>(atlas[h+3u]).xyz+vec3f(margin))){return;}
  let value=worldField(fieldBody,p);let separation=value.phi;
  if(separation>=oracle.distances.x||dot(value.gradient,value.gradient)<1e-12){return;}
  let n=normalize(value.gradient);let basis=orthonormal(n);
  var rB=qrotate(qconj(bodies[b].rot),p-n*separation-bodies[b].pos.xyz);
  var lam=vec3f(0);var pen=vec3f(0);var stick=0u;
  let history=oldSlots[id];let prior=history.x;
  if(prior>0u&&prior<=arrayLength(&prevContacts)){
    let old=prevContacts[prior-1u];let oldBasis=orthonormal(bitcast<vec3f>(history.yzw));lam=transpose(basis)*(oldBasis*old.lam);pen=old.pen;stick=old.key&STICK_BIT;
    if(stick!=0u){rA=old.rA;rB=old.rB;}
  }
  let d=bodies[a].pos.xyz+qrotate(bodies[a].rot,rA)-bodies[b].pos.xyz-qrotate(bodies[b].rot,rB);
  let c0=vec3f(dot(n,d)-oracle.distances.x+oracle.distances.y,
    select(0.0,dot(basis[1],d),stick!=0u),select(0.0,dot(basis[2],d),stick!=0u));
  lam*=params.alpha*params.gamma;pen=clamp(pen*params.gamma,vec3f(PENALTY_MIN),vec3f(PENALTY_MAX));
  if((params.flags&FLAG_MASS_PENALTY)!=0u){pen.x=max(pen.x,clamp(min(bodies[a].size.w,select(bodies[b].size.w,3.4e38,bodies[b].size.w<=0.0))/(params.dt*params.dt),PENALTY_MIN,PENALTY_MAX));}
  let m=atomicAdd(&counters[C_MANIFOLDS],1u);
  if(m>=params.manifoldCapacity){atomicOr(&counters[C_OVERFLOW],4u);return;}
  let c=atomicAdd(&counters[C_CONTACTS],1u);
  if(c>=params.contactCapacity){atomicOr(&counters[C_OVERFLOW],2u);manifolds[m]=Manifold(vec4u(a,b,0u,0u),vec4f(n,0));return;}
  contacts[c]=Contact(rA,id|stick,rB,c0.x,pen,c0.y,lam,c0.z);
  manifolds[m]=Manifold(vec4u(a,b,c,1u|(params.step<<4u)),vec4f(n,sqrt(bodies[a].pos.w*bodies[b].pos.w)));
  slots[id]=vec4u(c+1u,bitcast<vec3u>(n));
}
`;

export class DensePileOracle implements GpuCollisionBackend3D{
  private buffers:GPUBuffer[]=[];private current=0;
  private solver:GpuSolver3D;private pipeline:GPUComputePipeline;private count:number;
  private uniform:GPUBuffer;private atlas:GPUBuffer;private config:GPUBuffer;private samples:GPUBuffer;private slots:GPUBuffer[];
  readonly pointSets:THREE.Vector3[][];
  private constructor(solver:GpuSolver3D,pipeline:GPUComputePipeline,count:number,buffers:GPUBuffer[],pointSets:THREE.Vector3[][]){
    this.solver=solver;this.pipeline=pipeline;this.count=count;this.buffers=buffers;
    [this.uniform,this.atlas,this.config,this.samples]=buffers;this.slots=buffers.slice(4);this.pointSets=pointSets;
  }
  static async create(solver:GpuSolver3D,scene:ReleasedScene,margin:number,allowed:number){
    const count=scene.bodies.length;
    if(count<2||count>32||solver.bodyCount!==count)throw new Error('Dense pile oracle supports 2..32 preloaded bodies');
    if(![margin,allowed].every(Number.isFinite)||margin<0||allowed<0)throw new Error('Invalid oracle distances');
    if(scene.bodies.some(b=>!b.original.static&&b.original.shape.kind!=='voxel'))throw new Error('Dense pile samples require dynamic voxel meshes');
    const total=count*count*1000,d=solver.device;solver.reserveCollisionCapacity(total);
    const fields=scene.bodies.map(b=>b.field),packed=packSdfAtlas(fields);
    const pointSets=scene.bodies.map(b=>b.original.static?[]:denseSurfacePoints(b.geometry));
    const module=d.createShaderModule({code:shader,label:'diagnostic dense pile oracle'});
    const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    const pipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'dense'}}),buffers:GPUBuffer[]=[];
    try{
      const make=(size:number,usage:number)=>{const b=d.createBuffer({size,usage});buffers.push(b);return b;};
      const uniform=make(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),data=new Uint32Array(8);data[0]=count;new Float32Array(data.buffer).set([margin,allowed],4);d.queue.writeBuffer(uniform,0,data);
      const atlas=make(packed.data.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);d.queue.writeBuffer(atlas,0,packed.data);
      const configs=new Uint32Array(count*12),f=new Float32Array(configs.buffer);let offset=0;
      scene.bodies.forEach((b,i)=>{configs.set([packed.offsets.get(b.field)!,offset,pointSets[i].length,+b.original.static],i*12);f.set(b.fieldRotation,i*12+4);f[i*12+8]=b.original.scale;offset+=pointSets[i].length;});
      const config=make(configs.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);d.queue.writeBuffer(config,0,configs);
      const points=new Float32Array(offset*4);let at=0;pointSets.flat().forEach(p=>{points.set(p.toArray(),at);at+=4;});
      const samples=make(points.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST);d.queue.writeBuffer(samples,0,points);
      make(total*16,GPUBufferUsage.STORAGE);make(total*16,GPUBufferUsage.STORAGE);
      return new DensePileOracle(solver,pipeline,count,buffers,pointSets);
    }catch(e){buffers.forEach(b=>b.destroy());throw e;}
  }
  prepare(solver:GpuSolver3D){if(solver!==this.solver||solver.bodyCount!==this.count)throw new Error('Dense pile oracle topology changed');}
  encode(pass:GPUComputePassEncoder,c:GpuCollisionContext3D){
    const next=this.current^1,buffers=[c.params,this.uniform,c.bodies,this.atlas,this.config,this.samples,this.slots[this.current],this.slots[next],c.previousContacts,c.contacts,c.manifolds,c.counters];
    const group=this.solver.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.count*this.count*1000/64));this.current=next;
  }
  destroy(){this.buffers.forEach(b=>b.destroy());this.buffers=[];}
}
