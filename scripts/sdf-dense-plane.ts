// Diagnostic-only plane oracle. Exhaustively tests every precomputed surface sample;
// no optimizer, cache ranking, point reduction, or mesh-witness fallback is used.
import * as THREE from 'three';
import { PRELUDE_3D } from '../src/avbd3d/gpu/layout.ts';
import type { GpuSolver3D, GpuCollisionBackend3D, GpuCollisionContext3D } from '../src/avbd3d/gpu/solver.ts';

/** Deterministic area-stratified triangle samples (not the paper's unpublished grid sample set). */
export function denseSurfacePoints(geometry:THREE.BufferGeometry,count=1000):THREE.Vector3[]{
  if(!Number.isInteger(count)||count<1||count>1000)throw new Error('Dense sample count must be 1..1000');
  const p=geometry.getAttribute('position'),idx=geometry.index,n=idx?.count??p.count;
  if(n%3)throw new Error('Expected triangle geometry');
  const triangles:THREE.Vector3[][]=[],areas:number[]=[];let total=0;
  for(let i=0;i<n;i+=3){
    const v=[0,1,2].map(k=>new THREE.Vector3().fromBufferAttribute(p,idx?idx.getX(i+k):i+k));
    const area=new THREE.Vector3().subVectors(v[1],v[0]).cross(new THREE.Vector3().subVectors(v[2],v[0])).length()/2;
    if(!Number.isFinite(area))throw new Error('Non-finite triangle');
    if(area>0){total+=area;areas.push(total);triangles.push(v);}
  }
  if(!total)throw new Error('Empty surface');
  const radical=(i:number,base:number)=>{let value=0,f=1/base;while(i){value+=(i%base)*f;i=Math.floor(i/base);f/=base;}return value;};
  let t=0;return Array.from({length:count},(_,i)=>{
    const target=(i+.5)*total/count;while(areas[t]<target)t++;
    const u=Math.sqrt(radical(i+1,2)),v=radical(i+1,3),a=triangles[t];
    return a[0].clone().multiplyScalar(1-u).addScaledVector(a[1],u*(1-v)).addScaledVector(a[2],u*v);
  });
}

const shader=/* wgsl */ `
${PRELUDE_3D}
struct Oracle { counts:vec4u, distances:vec4f }
@group(0) @binding(0) var<uniform> params:Params;
@group(0) @binding(1) var<uniform> oracle:Oracle;
@group(0) @binding(2) var<storage,read> bodies:array<Body>;
@group(0) @binding(3) var<storage,read> samples:array<vec4f>;
@group(0) @binding(4) var<storage,read> oldSlots:array<u32>;
@group(0) @binding(5) var<storage,read_write> slots:array<u32>;
@group(0) @binding(6) var<storage,read> prevContacts:array<Contact>;
@group(0) @binding(7) var<storage,read_write> contacts:array<Contact>;
@group(0) @binding(8) var<storage,read_write> manifolds:array<Manifold>;
@group(0) @binding(9) var<storage,read_write> counters:array<atomic<u32>>;
@compute @workgroup_size(64) fn dense(@builtin(global_invocation_id) gid:vec3u){
  let id=gid.x;if(id>=oracle.counts.x*oracle.counts.y){return;}
  slots[id]=0u;
  let a=id/oracle.counts.y+1u;let point=id%oracle.counts.y;
  var rA=samples[point].xyz;
  let p=bodies[a].pos.xyz+qrotate(bodies[a].rot,rA);
  let separation=p.y-oracle.distances.z;if(separation>=oracle.distances.x){return;}
  let n=vec3f(0,1,0);let basis=orthonormal(n);
  var rB=qrotate(qconj(bodies[0].rot),vec3f(p.x,oracle.distances.z,p.z)-bodies[0].pos.xyz);
  var lam=vec3f(0);var pen=vec3f(0);var stick=0u;
  let prior=oldSlots[id];
  if(prior>0u&&prior<=arrayLength(&prevContacts)){
    let old=prevContacts[prior-1u];lam=old.lam;pen=old.pen;stick=old.key&STICK_BIT;
    if(stick!=0u){rA=old.rA;rB=old.rB;}
  }
  let d=bodies[a].pos.xyz+qrotate(bodies[a].rot,rA)-bodies[0].pos.xyz-qrotate(bodies[0].rot,rB);
  let c0=vec3f(dot(n,d)-oracle.distances.x+oracle.distances.y,
    select(0.0,dot(basis[1],d),stick!=0u),select(0.0,dot(basis[2],d),stick!=0u));
  lam*=params.alpha*params.gamma;pen=clamp(pen*params.gamma,vec3f(PENALTY_MIN),vec3f(PENALTY_MAX));
  if((params.flags&FLAG_MASS_PENALTY)!=0u){pen.x=max(pen.x,clamp(bodies[a].size.w/(params.dt*params.dt),PENALTY_MIN,PENALTY_MAX));}
  let m=atomicAdd(&counters[C_MANIFOLDS],1u);
  if(m>=params.manifoldCapacity){atomicOr(&counters[C_OVERFLOW],4u);return;}
  let c=atomicAdd(&counters[C_CONTACTS],1u);
  if(c>=params.contactCapacity){atomicOr(&counters[C_OVERFLOW],2u);manifolds[m]=Manifold(vec4u(a,0u,0u,0u),vec4f(n,0));return;}
  contacts[c]=Contact(rA,point|stick,rB,c0.x,pen,c0.y,lam,c0.z);
  manifolds[m]=Manifold(vec4u(a,0u,c,1u|(params.step<<4u)),vec4f(n,sqrt(bodies[a].pos.w*bodies[0].pos.w)));
  slots[id]=c+1u;
}
`;

/** Limited to a fixed horizontal floor in slot 0 and contiguous dynamic drops in slots 1..N. */
export class DensePlaneOracle implements GpuCollisionBackend3D{
  private buffers:GPUBuffer[]=[];private current=0;
  private solver:GpuSolver3D;private pipeline:GPUComputePipeline;private count:number;private uniform:GPUBuffer;private samples:GPUBuffer;private slots:GPUBuffer[];
  private constructor(solver:GpuSolver3D,pipeline:GPUComputePipeline,count:number,uniform:GPUBuffer,samples:GPUBuffer,slots:GPUBuffer[]){
    this.solver=solver;this.pipeline=pipeline;this.count=count;this.uniform=uniform;this.samples=samples;this.slots=slots;
  }
  static async create(solver:GpuSolver3D,points:THREE.Vector3[],count:number,margin:number,allowed:number,top=0){
    if(!Number.isInteger(count)||count<1||count>100||points.length!==1000||!points.every(p=>p.toArray().every(Number.isFinite)))throw new Error('Dense oracle requires 1..100 drops and exactly 1000 finite points');
    if(![margin,allowed,top].every(Number.isFinite)||margin<0||allowed<0)throw new Error('Invalid oracle distances');
    const d=solver.device;solver.reserveCollisionCapacity(count*points.length);
    const module=d.createShaderModule({code:shader,label:'diagnostic dense plane oracle'});
    const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(errors.length)throw new Error(errors.map(m=>m.message).join('\n'));
    const pipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'dense'}});
    const buffers:GPUBuffer[]=[];
    try{
      const make=(size:number,usage:number)=>{const b=d.createBuffer({size,usage});buffers.push(b);return b;};
      const uniform=make(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),data=new Uint32Array(8);data.set([count,points.length]);new Float32Array(data.buffer).set([margin,allowed,top,0],4);d.queue.writeBuffer(uniform,0,data);
      const samples=make(points.length*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST),v=new Float32Array(points.length*4);points.forEach((p,i)=>v.set(p.toArray(),i*4));d.queue.writeBuffer(samples,0,v);
      const slots=[make(count*points.length*4,GPUBufferUsage.STORAGE),make(count*points.length*4,GPUBufferUsage.STORAGE)];
      const oracle=new DensePlaneOracle(solver,pipeline,count,uniform,samples,slots);oracle.buffers=buffers;return oracle;
    }catch(e){buffers.forEach(b=>b.destroy());throw e;}
  }
  prepare(solver:GpuSolver3D){if(solver!==this.solver||solver.bodyCount!==this.count+1||solver.contactCapacity<this.count*1000||solver.manifoldCapacity<this.count*1000)throw new Error('Dense oracle body/capacity mismatch');}
  encode(pass:GPUComputePassEncoder,c:GpuCollisionContext3D){
    const next=this.current^1;
    const buffers=[c.params,this.uniform,c.bodies,this.samples,this.slots[this.current],this.slots[next],c.previousContacts,c.contacts,c.manifolds,c.counters];
    const group=this.solver.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(this.count*1000/64));this.current=next;
  }
  destroy(){this.buffers.forEach(b=>b.destroy());this.buffers=[];}
}
