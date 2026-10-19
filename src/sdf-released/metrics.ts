import * as THREE from 'three';
import type { World, Body } from '../lib/world.ts';
import { SdfBody } from '../avbd3d/ref/sdf/body.ts';
import type { GpuSdfResult } from '../avbd3d/gpu/sdf-layout.ts';
import type { ReleasedScene, Sample } from './scenes.ts';
import type { Quat, Vec3 } from '../lib/world.ts';

/** Comparable conventions: final collision substep for pairs/contacts/depth,
 * sum all substeps for paired queries/optimizer iterations, then post-step energy. */
export async function measuredFrame(scene:ReleasedScene, world:World, bodies:Body[], frame:number, vertices=false):Promise<Sample> {
  let queries=0, iterations=0, results:GpuSdfResult[]=[];
  for(let s=0;s<Math.round(scene.capture.solver.dt/world.dt);s++) {
    world.step(); results=await world.readSdfResults();
    const counters=await world.solver.readCounters();if(counters.overflow)throw new Error(`Collision overflow ${counters.overflow} at substep ${s}`);
    for(const result of results){queries+=result.queries;iterations+=result.iterations;}
  }
  await world.read();
  const points=results.flatMap(result=>result.points.filter(p=>p.active));
  let kineticEnergy=0,minCenterY=Infinity;
  bodies.forEach((body,i)=>{
    const original=scene.bodies[i].original;if(original.static)return;
    if(![...body.position,...body.rotation,...body.velocity,...body.angularVelocity].every(Number.isFinite))throw new Error('Non-finite released scene state');
    const w=new THREE.Vector3(...body.angularVelocity).applyQuaternion(new THREE.Quaternion(...body.rotation).invert());
    const moments=scene.bodies[i].moments;
    kineticEnergy+=.5*(original.mass*body.velocity.reduce((sum,v)=>sum+v*v,0)+moments[0]*w.x*w.x+moments[1]*w.y*w.y+moments[2]*w.z*w.z);
    minCenterY=Math.min(minCenterY,body.position[1]);
  });
  const sample:Sample={frame,stats:{pairs:results.length,contacts:points.length,queries,iterations},kineticEnergy,minCenterY,
    maxContactPenetration:points.reduce((max,p)=>Math.max(max,-p.separation),0)};
  if(vertices) {
    const fields=bodies.map((b,i)=>new SdfBody(scene.bodies[i].field,b.position,
      new THREE.Quaternion(...b.rotation).multiply(new THREE.Quaternion(...scene.bodies[i].fieldRotation)).toArray() as Quat,scene.bodies[i].original.scale,b.fixed));
    const bounds=fields.map(f=>f.bounds);
    let maximum=0,probes=0;
    for(let a=0;a<bodies.length;a++)for(let b=0;b<bodies.length;b++){
      if(a===b||(bodies[a].fixed&&bodies[b].fixed)||bounds[a].min.some((v,k)=>v>bounds[b].max[k]||bounds[a].max[k]<bounds[b].min[k]))continue;
      const positions=scene.bodies[a].geometry.getAttribute('position');
      const rotation=new THREE.Quaternion(...bodies[a].rotation),origin=new THREE.Vector3(...bodies[a].position);
      for(let j=0;j<positions.count;j++){
        const vertex=new THREE.Vector3().fromBufferAttribute(positions,j).applyQuaternion(rotation).add(origin);
        const phi=fields[b].sample(vertex.toArray() as Vec3).phi;
        if(!Number.isFinite(phi))throw new Error('Non-finite geometry probe');
        if(-phi>maximum){
          maximum=-phi;
          const pair=results.find(r=>(r.a===a&&r.b===b)||(r.a===b&&r.b===a));
          sample.penetrationWitness={a,b,point:vertex.toArray() as Vec3,contacts:pair?.points.filter(p=>p.active).map(p=>({point:p.x,separation:p.separation,normal:p.normal,cached:p.cached}))??[]};
        }
        probes++;
      }
    }
    sample.maxVertexPenetration=maximum;sample.vertexQueries=probes;
  }
  return sample;
}
