// Diagnostic-only timestamp splitting of the collision solver dispatches.
// Extra pass boundaries affect timing; do not compare directly with unsplit totals.
export function collisionDispatchProfiler(device:GPUDevice){
  let names=['beginFrame','prepareBodies','clearGrid','buildGrid','cachePairs','findPairs','narrowphase','exportContacts','argsContacts'];

  const queries=device.createQuerySet({type:'timestamp',count:20});
  const resolve=device.createBuffer({size:512,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
  const read=device.createBuffer({size:160,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  const original=device.createCommandEncoder.bind(device);let armed=false;
  device.createCommandEncoder=(descriptor)=>{
    const encoder=original(descriptor);if(!armed||descriptor?.label!=='avbd3d step')return encoder;armed=false;
    let index=0;
    return new Proxy(encoder,{get(target,key){
      if(key==='beginComputePass')return ()=>{
        let pass:GPUComputePassEncoder|undefined,pipeline:GPUComputePipeline;const groups=new Map<number,{group:GPUBindGroup;offsets:number[]}>();
        const start=(timed:boolean)=>{pass=encoder.beginComputePass(timed?{timestampWrites:{querySet:queries,beginningOfPassWriteIndex:index*2,endOfPassWriteIndex:index*2+1}}:{});pass.setPipeline(pipeline);for(const [i,g]of groups)pass.setBindGroup(i,g.group,g.offsets);};
        return {setPipeline(p:GPUComputePipeline){if(p.label==='sdf transform seeds'&&!names.includes('transformSeeds'))names.splice(6,0,'transformSeeds');pipeline=p;pass?.setPipeline(p);},setBindGroup(i:number,g:GPUBindGroup,offsets:Iterable<number>=[],start=0,length?:number){const values=Array.from(offsets).slice(start,length===undefined?undefined:start+length);groups.set(i,{group:g,offsets:values});pass?.setBindGroup(i,g,values);},
          dispatchWorkgroups(...args:[number,number?,number?]){if(index<names.length){pass?.end();start(true);pass!.dispatchWorkgroups(...args);pass!.end();pass=undefined;index++;}else{if(!pass)start(false);pass!.dispatchWorkgroups(...args);}},
          dispatchWorkgroupsIndirect(buffer:GPUBuffer,offset:number){if(index<names.length)throw new Error('Unexpected indirect collision dispatch');if(!pass)start(false);pass!.dispatchWorkgroupsIndirect(buffer,offset);},
          end(){pass?.end();}};
      };
      if(key==='finish')return ()=>{if(index!==names.length)throw new Error(`Unexpected collision dispatch count, got ${index}`);encoder.resolveQuerySet(queries,0,names.length*2,resolve,0);encoder.copyBufferToBuffer(resolve,0,read,0,names.length*16);return encoder.finish();};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
  };
  return {arm(){names=names.filter(n=>n!=='transformSeeds');armed=true;},async collect(){await read.mapAsync(GPUMapMode.READ);try{const t=new BigUint64Array(read.getMappedRange());return Object.fromEntries(names.map((name,i)=>[name,Number(t[i*2+1]-t[i*2])/1e6]));}finally{read.unmap();}},destroy(){device.createCommandEncoder=original;queries.destroy();resolve.destroy();read.destroy();}};
}
