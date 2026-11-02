// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 4e57864fceff06bc469a92670f8a522947fb3c3ab1a97d313cc8be5a01913ce1. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// Experimental bridge only. Share the native contact expression verbatim; do not turn
// scalar-root proposals into purported native contacts or alter the production optimizer.
import {sdfNarrowphaseSource} from '../src/avbd3d/gpu/wgsl-sdf.ts';
import {SDF_FIELDS_WGSL} from '../src/avbd3d/gpu/wgsl-sdf-fields.ts';

export const REGION_ID_BASE=0x50000000,REGION_ID_LIMIT=0x60000000;
export const REGION_HINT_LIMIT=384,REGION_POINT_LIMIT=4;
export const regionPointTypes=/* wgsl */`
struct Params { counts: vec4u, values: vec4f, distances: vec4f, flags: vec4u, opt: vec4u }
struct Body { position: vec4f, rotation: vec4f, velocity: vec4f, omega: vec4f, lo: vec4f, hi: vec4f, anchorRotation: vec4f }
struct Point { x: vec4f, normal: vec4f, anchorA: vec4f, anchorB: vec4f, flags: vec4u, ellipsoidA: vec4f, ellipsoidB: vec4f }
struct Hint { localA: vec4f, localB: vec4f, info: vec4u }
`;
/** Research-only source reuse, fail closed if the upstream extraction boundary changes.
 * A promoted implementation should factor this into a shared production function after
 * bit-exact replay qualification. For now the original shader remains byte-identical. */
export function nativeRegionEvaluation(){
  const source=sdfNarrowphaseSource();
  const slice=(start:string,end:string)=>{
    if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Native contact source changed');
    const a=source.indexOf(start),b=source.indexOf(end,a);if(b<a)throw Error('Native contact source changed');
    return source.slice(a,b);
  };
  const evaluation=slice('  let a=worldField(bodyA,p); let b=worldField(bodyB,p); work.stats.x++;','  // New ids stay below').replace(' work.stats.x++;','');
  const construction=slice('  let point=Point(vec4f(p,min(a.phi,b.phi))','  work.points[work.identity.w]=point; work.identity.w++;');
  return `${SDF_FIELDS_WGSL}
fn smoothMax(a: f32,b: f32) -> f32 { return 0.5*(a+b+sqrt((a-b)*(a-b)+params.values.y)); }
fn evaluateRegion(bodyA: Body,bodyB: Body,p: vec3f,old: Point,cached: bool,id: u32) -> Point {
  let ellipsoidA=vec4f(1,0,0,1); let ellipsoidB=vec4f(0,1,0,0);
${evaluation}${construction}  return point;
}
`;
}
export const regionHintAuditSource=()=>/* wgsl */`
${regionPointTypes}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage,read> atlas: array<vec4u>;
@group(0) @binding(2) var<storage,read> bodies: array<Body>;
@group(0) @binding(3) var<storage,read> hints: array<Hint>;
@group(0) @binding(4) var<storage,read_write> results: array<Point>;
${nativeRegionEvaluation()}
@compute @workgroup_size(64) fn evaluateHints(@builtin(global_invocation_id) gid: vec3u) {
  let i=gid.x; if(i>=arrayLength(&hints)) { return; }
  let hint=hints[i];let a=bodies[hint.info.x];let b=bodies[hint.info.y];
  let p=(worldPoint(a,hint.localA.xyz)+worldPoint(b,hint.localB.xyz))*0.5;
  var old: Point;results[i]=evaluateRegion(a,b,p,old,false,hint.info.z);
}
`;

export async function readRegionBuffer(device:GPUDevice,buffer:GPUBuffer,size=buffer.size){
  const staging=device.createBuffer({size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});
  try{const e=device.createCommandEncoder();e.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([e.finish()]);await staging.mapAsync(GPUMapMode.READ);return new Uint32Array(staging.getMappedRange().slice(0));}finally{staging.destroy();}
}
export async function regionPipeline(device:GPUDevice,code:string,entryPoint:string){
  const module=device.createShaderModule({code}),info=await module.getCompilationInfo(),errors=info.messages.filter(m=>m.type==='error');
  if(errors.length)throw Error(errors.map(e=>e.message).join('\n'));
  return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
}
export function regionGroup(device:GPUDevice,pipeline:GPUComputePipeline,buffers:GPUBuffer[]){
  return device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:{buffer}}))});
}
