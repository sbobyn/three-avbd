// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 9a53d027ec02e6cc829793f4c76576920050331daba9d3d13cba18f4afcc0d19. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// CPU-only audit. A clear geometry cover is not permission to skip legacy projected contacts.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readCapture,validateCapture,type SdfReplayCapture} from './sdf-replay-format.ts';
import {ScalarSolidCover,TransformedCover,discoverCoverRegions,type CoverVec3} from './sdf-coverage-discovery.ts';
export function auditCoverage(capture:SdfReplayCapture,maxVisits=127,slotStart=0,slotCount=1024){
  validateCapture(capture);
  if(!Number.isInteger(maxVisits)||maxVisits<1||maxVisits>4095||!Number.isInteger(slotStart)||slotStart<0||!Number.isInteger(slotCount)||slotCount<1||slotCount>8192)throw Error('Invalid bounded coverage audit');
  const started=performance.now(),{sections:s,manifest:m}=capture;
  const view=(v:Uint8Array)=>new DataView(v.buffer,v.byteOffset,v.byteLength),atlas=view(s.atlas),poses=view(s.bodies),pairs=view(s.pairs),old=view(s.previous),expected=view(s.expected),params=view(s.params);
  const u=(v:DataView,w:number)=>v.getUint32(w*4,true),f=(v:DataView,w:number)=>v.getFloat32(w*4,true),v3=(v:DataView,w:number):CoverVec3=>[f(v,w),f(v,w+1),f(v,w+2)];
  const fields=new Map<number,ScalarSolidCover|null>(),bodies=new Map<number,TransformedCover|null>();
  let coverBytes=0,buildPeakAdditionalArrayBytes=0,buildMs=0;
  const rejectedFields:Record<string,number>={};
  const body=(id:number):TransformedCover|null=>{
    if(bodies.has(id))return bodies.get(id)!;
    const at=id*28,h=u(poses,at+15)*4;
    if(u(atlas,h)!==7){bodies.set(id,null);return null;}
    if(!fields.has(h)){
      const begin=performance.now();let cover:ScalarSolidCover|null=null;
      try{
        const d=[u(atlas,h+5),u(atlas,h+6),u(atlas,h+7)] as CoverVec3,words=d.reduce((a,b)=>a*b,1)*4;
        const remaining=64*1024*1024-coverBytes;if(remaining<32)throw Error('Aggregate cover budget');
        cover=new ScalarSolidCover({dimensions:d,origin:v3(atlas,h+28),cell:f(atlas,h+11),grid:new Float32Array(s.atlas.buffer,s.atlas.byteOffset+u(atlas,h+4)*16,words)},Math.min(32*1024*1024,remaining));
        buildPeakAdditionalArrayBytes=Math.max(buildPeakAdditionalArrayBytes,coverBytes+cover.buildPeakArrayBytes);coverBytes+=cover.bytes;
        if(!cover.boundaryPositive)rejectedFields['boundary-not-positive']=(rejectedFields['boundary-not-positive']??0)+1;
      }catch(error){const reason=error instanceof Error?error.message:'unknown';rejectedFields[reason]=(rejectedFields[reason]??0)+1;}
      fields.set(h,cover);buildMs+=performance.now()-begin;
    }
    const cover=fields.get(h)!,result=cover?new TransformedCover(cover,{position:v3(poses,at),rotation:[4,5,6,7].map(i=>f(poses,at+i)) as [number,number,number,number],scale:f(poses,at+3),com:v3(atlas,h+16)}):null;
    bodies.set(id,result);return result;
  };
  const stride=8+28*m.capacities.maxPoints,active=(v:DataView,at:number)=>{for(let i=0;i<u(v,at+3);i++)if(u(v,at+8+28*i+16))return true;return false;};
  const margin=f(params,8),end=Math.min(m.capacities.pairCount,slotStart+slotCount),reasons:Record<string,number>={},examples:unknown[]=[];
  let queryPairs=0,totalQueries=0,tested=0,testedQueries=0,clear=0,clearQueries=0,clearWithoutActiveHistory=0,clearQueriesWithoutActiveHistory=0,legacyActiveDisagreements=0,disagreementsWithoutActiveHistory=0,visits=0,bounds=0,frontierTotal=0,frontierMax=0,budgetExhausted=0;
  for(let slot=slotStart;slot<end;slot++){
    const aId=u(pairs,slot*4),bId=u(pairs,slot*4+1),key=u(pairs,slot*4+2),previous=u(pairs,slot*4+3),queries=u(expected,slot*stride+4);
    if(aId===0xffffffff||!queries)continue;queryPairs++;totalQueries+=queries;
    const a=body(aId),b=body(bId);let reason='unsupported-field';
    if(a&&b){
      const r=discoverCoverRegions(a,b,margin,maxVisits);reason=r.status;
      if(r.status!=='unsupported'){tested++;testedQueries+=queries;visits+=r.visits;bounds+=r.bounds;frontierTotal+=r.frontier.length;frontierMax=Math.max(frontierMax,r.frontier.length);budgetExhausted+=+r.budgetExhausted;}
      if(r.status==='separated'){
        clear++;clearQueries+=queries;
        const history=previous!==0xffffffff&&previous<m.capacities.maxPairs&&u(old,previous*stride)===aId&&u(old,previous*stride+1)===bId&&u(old,previous*stride+2)===key&&active(old,previous*stride);
        if(!history){clearWithoutActiveHistory++;clearQueriesWithoutActiveHistory+=queries;}
        if(active(expected,slot*stride)){
          legacyActiveDisagreements++;if(!history)disagreementsWithoutActiveHistory++;
          examples.push({slot,a:aId,b:bId,key,queries,activeHistory:history,activePoints:Array.from({length:u(expected,slot*stride+3)},(_,i)=>({id:u(expected,slot*stride+8+28*i+18),active:u(expected,slot*stride+8+28*i+16),separation:f(expected,slot*stride+8+28*i+7)})).filter(p=>p.active)});
        }
      }
    }
    reasons[reason]=(reasons[reason]??0)+1;
  }
  return {kind:'scalar-solid coverage CPU audit',legacySearchRequired:true,productionEnabled:false,maxVisits,slotStart,slotEnd:end,queryPairs,totalQueries,tested,testedQueries,clear,clearQueries,clearQueryFraction:totalQueries?clearQueries/totalQueries:0,clearWithoutActiveHistory,clearQueriesWithoutActiveHistory,legacyActiveDisagreements,disagreementsWithoutActiveHistory,visits,bounds,frontierTotal,frontierMax,budgetExhausted,reasons,examples,coverBytes,buildPeakAdditionalArrayBytes,buildMs,totalMs:performance.now()-started,rejectedFields,fields:[...fields].map(([header,c])=>({header,constructed:!!c,supported:!!c&&c.boundaryPositive,...(c?{nodes:c.nodeCount,occupied:c.occupiedCells,totalCells:c.totalCells,bytes:c.bytes,boundaryPositive:c.boundaryPositive}:{})})),captureSource:m.source,captureSections:m.sections,captureMetadata:m.metadata,scope:'Geometry model for the real trilinear scalar solid, not legacy projected-gap or portable WGSL proof. Queries are original recorded counts, not runtime savings. Unsupported/budget frontier retains work. No GPU state mutated.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [directory,output,budget='127',start='0',count='1024']=process.argv.slice(2);if(!directory||!output)throw Error('Usage: sdf-coverage-audit.ts CAPTURE OUT [MAX_VISITS] [START] [COUNT<=8192]');
  const hashes=async()=>Object.fromEntries(await Promise.all(['scripts/sdf-coverage-discovery.ts','scripts/sdf-coverage-audit.ts','scripts/sdf-replay-format.ts','src/avbd3d/gpu/sdf-layout.ts','src/avbd3d/gpu/sdf-supports.ts',...['shapes','voxel','body','manifold','optimize','math'].map(n=>'src/avbd3d/ref/sdf/'+n+'.ts'),'package.json','pnpm-lock.yaml'].map(async p=>[p,createHash('sha256').update(await readFile(new URL('../'+p,import.meta.url))).digest('hex')])));
  const sources=await hashes(),report=auditCoverage(await readCapture(directory),Number(budget),Number(start),Number(count));
  if(JSON.stringify(sources)!==JSON.stringify(await hashes()))throw Error('Audit source changed');
  await writeFile(output,JSON.stringify({...report,sources},null,2)+'\n',{flag:'wx'});
  const {captureSections:_,captureSource:__,examples:___,...summary}=report;console.log(JSON.stringify(summary));
}
