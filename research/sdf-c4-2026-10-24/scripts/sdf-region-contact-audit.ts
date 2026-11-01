// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 7c3d1c9e1a61f312afc671050c05108e7dddd484f61478ee51e7b3a04196352d. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// Offline feasibility only. Proposals never replace capture contacts or discharge coverage.
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {readCapture,validateCapture,type SdfReplayCapture} from './sdf-replay-format.ts';
import {discoverCoverRegions,type CoverVec3 as Vec} from './sdf-coverage-discovery.ts';
import {RegionField,RegionBody,generateRegionContacts,regionOptions,type RegionHint} from './sdf-region-contacts.ts';

export function auditRegionContacts(capture:SdfReplayCapture,maxPairs=32,maxQueryPairs=1024,hintSink?:(slot:number,a:number,b:number,hint:RegionHint)=>void){
  validateCapture(capture);
  if(!Number.isInteger(maxPairs)||maxPairs<1||maxPairs>32||!Number.isInteger(maxQueryPairs)||maxQueryPairs<1||maxQueryPairs>1024)throw Error('Invalid bounded region audit');
  const started=performance.now(),{sections:s,manifest:m}=capture;
  const view=(v:Uint8Array)=>new DataView(v.buffer,v.byteOffset,v.byteLength),atlas=view(s.atlas),poses=view(s.bodies),pairs=view(s.pairs),expected=view(s.expected),params=view(s.params);
  const u=(v:DataView,w:number)=>v.getUint32(w*4,true),f=(v:DataView,w:number)=>v.getFloat32(w*4,true),v3=(v:DataView,w:number):Vec=>[f(v,w),f(v,w+1),f(v,w+2)];
  const fields=new Map<number,RegionField|null>(),bodies=new Map<number,RegionBody|null>(),rejectedFields:Record<string,number>={};
  let gridBytes=0,buildMs=0;
  const body=(id:number):RegionBody|null=>{
    if(bodies.has(id))return bodies.get(id)!;
    const at=id*28,h=u(poses,at+15)*4;
    if(u(atlas,h)!==7){bodies.set(id,null);return null;}
    if(!fields.has(h)){
      const begin=performance.now();let field:RegionField|null=null;
      try{
        const d=[u(atlas,h+5),u(atlas,h+6),u(atlas,h+7)] as Vec,words=d.reduce((a,b)=>a*b,1)*4;
        if(fields.size>=4||gridBytes+words*4>64*1024*1024)throw Error('Aggregate field budget');
        field=new RegionField({dimensions:d,origin:v3(atlas,h+28),cell:f(atlas,h+11),grid:new Float32Array(s.atlas.buffer,s.atlas.byteOffset+u(atlas,h+4)*16,words)});
        gridBytes+=words*4;
      }catch(error){const reason=error instanceof Error?error.message:'unknown';rejectedFields[reason]=(rejectedFields[reason]??0)+1;}
      fields.set(h,field);buildMs+=performance.now()-begin;
    }
    const field=fields.get(h)!;let result:RegionBody|null=null;
    if(field)try{result=new RegionBody(field,{position:v3(poses,at),rotation:[4,5,6,7].map(i=>f(poses,at+i)) as [number,number,number,number],scale:f(poses,at+3),com:v3(atlas,h+16)});}catch{/* Unsupported transforms stay on original search. */}
    bodies.set(id,result);return result;
  };
  const options={...regionOptions(),margin:f(params,8)},stride=8+28*m.capacities.maxPoints;
  const rows:Array<{slot:number;a:number;b:number;key:number;queries:number;originalActive:number;candidates:ReturnType<typeof generateRegionContacts>['candidates'];work:ReturnType<typeof generateRegionContacts>['work'];failures:Record<string,number>;coverageVisits:number;coverageBounds:number;unresolved:number;budgetExhausted:boolean;generationMs:number}>=[];
  let scannedSlots=0,queryPairs=0,separated=0,unsupported=0,selectionVisits=0,selectionBounds=0;
  for(let slot=0;slot<m.capacities.pairCount&&queryPairs<maxQueryPairs&&rows.length<maxPairs;slot++){
    scannedSlots++;const aId=u(pairs,slot*4),bId=u(pairs,slot*4+1),key=u(pairs,slot*4+2),queries=u(expected,slot*stride+4);
    if(aId===0xffffffff||!queries)continue;queryPairs++;
    const a=body(aId),b=body(bId);if(!a||!b){unsupported++;continue;}
    const selection=discoverCoverRegions(a.cover,b.cover,options.margin,options.coverageVisits);selectionVisits+=selection.visits;selectionBounds+=selection.bounds;
    if(selection.status==='unsupported'){unsupported++;continue;}
    if(!selection.frontier.length){separated++;continue;}
    const begin=performance.now(),r=generateRegionContacts(a,b,options,hintSink?h=>hintSink(slot,aId,bId,h):undefined),generationMs=performance.now()-begin;
    if(JSON.stringify(r.unresolved)!==JSON.stringify(selection.frontier))throw Error('Lost or changed retained frontier');
    let originalActive=0;for(let i=0;i<u(expected,slot*stride+3);i++)originalActive+=u(expected,slot*stride+8+28*i+16);
    rows.push({slot,a:aId,b:bId,key,queries,originalActive,candidates:r.candidates,work:r.work,failures:r.failures,coverageVisits:r.coverage.visits,coverageBounds:r.coverage.bounds,unresolved:r.unresolved.length,budgetExhausted:r.budgetExhausted,generationMs});
  }
  return {kind:'bounded retained-region contact CPU feasibility',legacySearchRequired:true,productionEnabled:false,maxPairs,maxQueryPairs,options,scannedSlots,queryPairs,separated,unsupported,selectionVisits,selectionBounds,rows,gridBytes,buildMs,totalMs:performance.now()-started,rejectedFields,
    fields:[...fields].map(([header,field])=>({header,constructed:!!field,...(field?{edges:field.edgeCount,coverBytes:field.cover.bytes,coverBuildPeakArrayBytes:field.cover.buildPeakArrayBytes}:{})})),captureSource:m.source,captureSections:m.sections,captureMetadata:m.metadata};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [directory,output]=process.argv.slice(2);if(!directory||!output)throw Error('Usage: sdf-region-contact-audit.ts CAPTURE OUT');
  const hashes=async()=>Object.fromEntries(await Promise.all(['scripts/sdf-region-contacts.ts','scripts/sdf-region-contact-audit.ts','scripts/sdf-coverage-discovery.ts','scripts/sdf-replay-format.ts','src/avbd3d/gpu/sdf-layout.ts','src/avbd3d/gpu/sdf-supports.ts',...['shapes','voxel','body','manifold','optimize','math'].map(n=>'src/avbd3d/ref/sdf/'+n+'.ts'),'package.json','pnpm-lock.yaml'].map(async p=>[p,createHash('sha256').update(await readFile(new URL('../'+p,import.meta.url))).digest('hex')])));
  const sources=await hashes(),report=auditRegionContacts(await readCapture(directory));
  if(JSON.stringify(sources)!==JSON.stringify(await hashes()))throw Error('Audit source changed');
  await writeFile(output,JSON.stringify({...report,sources},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({selected:report.rows.length,withProposals:report.rows.filter(r=>r.candidates.length).length,proposals:report.rows.reduce((s,r)=>s+r.candidates.length,0),totalMs:report.totalMs}));
}
