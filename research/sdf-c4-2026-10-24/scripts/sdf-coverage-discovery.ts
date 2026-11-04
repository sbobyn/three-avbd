// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: a280ccc0c248ac9ef12af80aa09d21653d846815c43551e551efae78585a3eeb. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
// CPU geometry oracle only. Never use a clear scalar-solid cover as a projected-contact skip mask.
export type CoverVec3=[number,number,number];
export type CoverBox=[CoverVec3,CoverVec3];
type Range=[number,number];
type Matrix=Range[][];
const NIL=0xffffffff;
const bits=new DataView(new ArrayBuffer(8));
function up(v:number){if(!Number.isFinite(v))return v;if(v===0)return Number.MIN_VALUE;bits.setFloat64(0,v);let n=bits.getBigUint64(0);bits.setBigUint64(0,v>0?n+1n:n-1n);return bits.getFloat64(0);}
const down=(v:number)=>-up(-v);
const exact=(v:number):Range=>[v,v];
const add=(a:Range,b:Range):Range=>[down(a[0]+b[0]),up(a[1]+b[1])];
const neg=(a:Range):Range=>[-a[1],-a[0]];
const sub=(a:Range,b:Range)=>add(a,neg(b));
const mul=(a:Range,b:Range):Range=>{const v=[a[0]*b[0],a[0]*b[1],a[1]*b[0],a[1]*b[1]];return [down(Math.min(...v)),up(Math.max(...v))];};
const div=(a:Range,b:Range):Range=>{if(b[0]<=0&&b[1]>=0)throw Error('singular transform');return mul(a,[down(1/b[1]),up(1/b[0])]);};
const finite=(r:Range)=>r.every(Number.isFinite)&&r[0]<=r[1];
const vec=(v:readonly number[])=>v.length===3&&[0,1,2].every(i=>Number.isFinite(v[i]));
// Shared binary64 interval primitives for the CPU geometry research; not WGSL bounds.
export const coverArithmetic={up,down,exact,add,sub,mul,div};
export type CoverRange=Range;

/** Packed immutable cover of the real trilinear phi<=0 region inside a positive boundary. */
export class ScalarSolidCover {
  readonly dimensions:Readonly<CoverVec3>;
  readonly origin:Readonly<CoverVec3>;
  readonly cell:number;
  readonly occupiedCells:number;
  readonly totalCells:number;
  readonly boundaryPositive:boolean;
  readonly bytes:number;
  readonly buildPeakArrayBytes:number;
  readonly nodeCount:number;
  readonly root:number;
  #nodes:Uint32Array;
  constructor(field:{dimensions:CoverVec3;origin:CoverVec3;cell:number;grid:Float32Array},maxBytes=32*1024*1024){
    const {dimensions:d,origin,cell,grid}=field,vertices=d.reduce((a,b)=>a*b,1);
    if(d.length!==3||![0,1,2].every(i=>Number.isSafeInteger(d[i])&&d[i]>=2&&d[i]<=257)||!Number.isSafeInteger(vertices)||vertices>2**21||!(grid instanceof Float32Array)||grid.length!==vertices*4||!grid.every(Number.isFinite)||!vec(origin)||!Number.isFinite(cell)||cell<=0||!Number.isSafeInteger(maxBytes)||maxBytes<32||maxBytes>64*1024*1024)throw Error('Invalid or oversized scalar cover');
    if(origin.some((v,i)=>!Number.isFinite(v+(d[i]-1)*cell)))throw Error('Scalar cover coordinate overflow');
    this.dimensions=Object.freeze([...d] as CoverVec3);this.origin=Object.freeze([...origin] as CoverVec3);this.cell=cell;
    const c=d.map(n=>n-1) as CoverVec3,index=(x:number,y:number,z:number)=>x+d[0]*(y+d[1]*z);
    const sum=new Uint32Array(vertices);let positive=true,occupied=0;
    for(let z=0;z<d[2];z++)for(let y=0;y<d[1];y++)for(let x=0;x<d[0];x++)if(x===0||y===0||z===0||x===c[0]||y===c[1]||z===c[2])positive&&=grid[index(x,y,z)*4]>0;
    for(let z=0;z<c[2];z++)for(let y=0;y<c[1];y++)for(let x=0;x<c[0];x++){
      let hit=0;for(let v=0;v<8;v++)if(grid[index(x+(v&1),y+((v>>1)&1),z+((v>>2)&1))*4]<=0){hit=1;break;}
      sum[index(x+1,y+1,z+1)]=hit;occupied+=hit;
    }
    // Integral counts are exact integers (at most 2^21); no floating membership decision.
    for(let z=1;z<d[2];z++)for(let y=1;y<d[1];y++)for(let x=1;x<d[0];x++)sum[index(x,y,z)]+=sum[index(x-1,y,z)];
    for(let z=1;z<d[2];z++)for(let y=1;y<d[1];y++)for(let x=1;x<d[0];x++)sum[index(x,y,z)]+=sum[index(x,y-1,z)];
    for(let z=1;z<d[2];z++)for(let y=1;y<d[1];y++)for(let x=1;x<d[0];x++)sum[index(x,y,z)]+=sum[index(x,y,z-1)];
    const count=(lo:CoverVec3,hi:CoverVec3)=>{
      let n=0;for(let v=0;v<8;v++){const x=v&1?hi[0]:lo[0],y=v&2?hi[1]:lo[1],z=v&4?hi[2]:lo[2];n+=((Number(!!(v&1))+Number(!!(v&2))+Number(!!(v&4)))%2?1:-1)*sum[index(x,y,z)];}return n;
    };
    const maxNodes=Math.min(Math.floor(maxBytes/32),Math.max(1,2*occupied-1));
    let storage=new Uint32Array(Math.min(maxNodes,1024)*8),used=0,peak=sum.byteLength+storage.byteLength;
    const allocate=()=>{if(used>=maxNodes)throw Error('Scalar cover node budget exceeded');if(used*8===storage.length){const next=new Uint32Array(Math.min(maxNodes,storage.length/4)*8);peak=Math.max(peak,sum.byteLength+storage.byteLength+next.byteLength);next.set(storage);storage=next;}return used++;};
    const build=(lo:CoverVec3,hi:CoverVec3,n:number):number=>{
      if(!n)return NIL;
      const ext=hi.map((v,i)=>v-lo[i]),volume=ext.reduce((a,b)=>a*b,1);
      if(n===volume){const id=allocate();storage.set([...lo,...hi,NIL,NIL],id*8);return id;}
      let axis=0;if(ext[1]>ext[axis])axis=1;if(ext[2]>ext[axis])axis=2;
      const mid=Math.floor((lo[axis]+hi[axis])/2),leftHi=[...hi] as CoverVec3,rightLo=[...lo] as CoverVec3;leftHi[axis]=mid;rightLo[axis]=mid;
      const leftCount=count(lo,leftHi);
      if(!leftCount)return build(rightLo,hi,n);
      if(leftCount===n)return build(lo,leftHi,n);
      const id=allocate(),at=id*8;storage.set([...lo,...hi,NIL,NIL],at);
      const left=build(lo,leftHi,leftCount),right=build(rightLo,hi,n-leftCount);
      // Allocation may have grown storage while children were built.
      storage[at+6]=left;storage[at+7]=right;return id;
    };
    this.root=build([0,0,0],c,occupied);this.occupiedCells=occupied;this.totalCells=c.reduce((a,b)=>a*b,1);this.boundaryPositive=positive;this.nodeCount=used;
    this.#nodes=storage.slice(0,used*8);this.bytes=this.#nodes.byteLength;this.buildPeakArrayBytes=Math.max(peak,sum.byteLength+storage.byteLength+this.bytes);
  }
  node(id:number){if(!Number.isInteger(id)||id<0||id>=this.nodeCount)throw Error('Invalid cover node');const a=id*8;return {lo:Array.from(this.#nodes.subarray(a,a+3)) as CoverVec3,hi:Array.from(this.#nodes.subarray(a+3,a+6)) as CoverVec3,left:this.#nodes[a+6],right:this.#nodes[a+7]};}
  get leaves(){const result:number[]=[];for(let i=0;i<this.nodeCount;i++)if(this.#nodes[i*8+6]===NIL&&this.#nodes[i*8+7]===NIL)result.push(i);return result;}
}
export interface CoverPose {position:CoverVec3;rotation:[number,number,number,number];scale:number;com:CoverVec3}
/** Invert the real conjugate-quaternion map instead of assuming a unit quaternion. */
export class TransformedCover {
  readonly cover:ScalarSolidCover;
  readonly supported:boolean;
  #matrix:Matrix=[];#position:Range[]=[];#com:Range[]=[];#scale:Range=exact(1);
  constructor(cover:ScalarSolidCover,pose:CoverPose){
    this.cover=cover;let supported=cover.boundaryPositive;
    try{
      if(!vec(pose.position)||!vec(pose.com)||pose.rotation.length!==4||![0,1,2,3].every(i=>Number.isFinite(pose.rotation[i]))||!Number.isFinite(pose.scale)||pose.scale<=0)throw Error('Invalid cover pose');
      const [x,y,z,w]=pose.rotation.map(exact),twice=(v:Range)=>mul(exact(2),v),one=exact(1);
      const r:Matrix=[
        [sub(one,twice(add(mul(y,y),mul(z,z)))),twice(sub(mul(x,y),mul(w,z))),twice(add(mul(x,z),mul(w,y)))],
        [twice(add(mul(x,y),mul(w,z))),sub(one,twice(add(mul(x,x),mul(z,z)))),twice(sub(mul(y,z),mul(w,x)))],
        [twice(sub(mul(x,z),mul(w,y))),twice(add(mul(y,z),mul(w,x))),sub(one,twice(add(mul(x,x),mul(y,y))))]
      ];
      const cofactor:Matrix=r.map((row,i)=>row.map((_v,j)=>{const rows=[0,1,2].filter(n=>n!==i),cols=[0,1,2].filter(n=>n!==j);const c=sub(mul(r[rows[0]][cols[0]],r[rows[1]][cols[1]]),mul(r[rows[0]][cols[1]],r[rows[1]][cols[0]]));return (i+j)%2?neg(c):c;}));
      const determinant=r[0].map((v,i)=>mul(v,cofactor[0][i])).reduce(add,exact(0));
      // inverse(transpose(R)) = cofactor(R) / determinant(R).
      this.#matrix=cofactor.map(row=>row.map(v=>div(v,determinant)));
      this.#position=pose.position.map(exact);this.#com=pose.com.map(exact);this.#scale=exact(pose.scale);
      if(!this.#matrix.flat().every(finite))throw Error('Unbounded transform');
    }catch{supported=false;}
    this.supported=supported;
  }
  box(id:number):CoverBox|null{
    if(!this.supported)return null;
    const n=this.cover.node(id);
    return this.#worldBox(n.lo.map((v,i)=>add(exact(this.cover.origin[i]),mul([v,n.hi[i]],exact(this.cover.cell)))));
  }
  encloseLocalBox(lo:CoverVec3,hi:CoverVec3):CoverBox|null{
    if(!this.supported||!vec(lo)||!vec(hi)||lo.some((v,i)=>v>hi[i]))return null;
    return this.#worldBox(lo.map((v,i)=>[v,hi[i]]));
  }
  #worldBox(ranges:Range[]):CoverBox|null{
    const local=ranges.map((r,i)=>mul(sub(r,this.#com[i]),this.#scale));
    const world=this.#matrix.map((row,i)=>add(row.map((v,j)=>mul(v,local[j])).reduce(add,exact(0)),this.#position[i]));
    if(!world.every(finite))return null;
    return [world.map(v=>v[0]) as CoverVec3,world.map(v=>v[1]) as CoverVec3];
  }
}
export interface CoverRegion {a:number;b:number}
export interface CoverDiscovery {status:'separated'|'frontier'|'unsupported';visits:number;bounds:number;frontier:CoverRegion[];budgetExhausted:boolean;legacySearchRequired:true}
/** Frontier is an exhaustive over-cover, NOT contact samples or a legacy search mask. */
export function discoverCoverRegions(a:TransformedCover,b:TransformedCover,margin:number,maxVisits=127):CoverDiscovery{
  if(!Number.isFinite(margin)||margin<0||!Number.isInteger(maxVisits)||maxVisits<1||maxVisits>4095)throw Error('Invalid coverage query budget/margin');
  const stack:CoverRegion[]=a.cover.root===NIL||b.cover.root===NIL?[]:[{a:a.cover.root,b:b.cover.root}],frontier:CoverRegion[]=[];
  const result:CoverDiscovery={status:'frontier',visits:0,bounds:0,frontier,budgetExhausted:false,legacySearchRequired:true};
  if(!a.supported||!b.supported)return {...result,status:'unsupported',frontier:stack};
  const cachedA=new Map<number,CoverBox>(),cachedB=new Map<number,CoverBox>();
  const box=(body:TransformedCover,id:number,cache:Map<number,CoverBox>)=>{let v=cache.get(id);if(!v){result.bounds++;const found=body.box(id);if(!found)return null;v=found;cache.set(id,v);}return v;};
  const margin2=up(margin*margin);
  while(stack.length&&result.visits<maxVisits){
    const pair=stack.pop()!;result.visits++;const aa=box(a,pair.a,cachedA),bb=box(b,pair.b,cachedB);
    if(!aa||!bb)return {...result,status:'unsupported',frontier:[...frontier,pair,...stack]};
    let lower=0;
    for(let i=0;i<3;i++){const gap=Math.max(0,down(aa[0][i]-bb[1][i]),down(bb[0][i]-aa[1][i]));lower=Math.max(0,down(lower+Math.max(0,down(gap*gap))));}
    if(lower>margin2)continue;
    const na=a.cover.node(pair.a),nb=b.cover.node(pair.b),leafA=na.left===NIL&&na.right===NIL,leafB=nb.left===NIL&&nb.right===NIL;
    if(leafA&&leafB){frontier.push(pair);continue;}
    const volume=(n:ReturnType<ScalarSolidCover['node']>)=>n.hi.reduce((v,x,i)=>v*(x-n.lo[i]),1);
    if(!leafA&&(leafB||volume(na)>=volume(nb))){if(na.right!==NIL)stack.push({a:na.right,b:pair.b});if(na.left!==NIL)stack.push({a:na.left,b:pair.b});}
    else {if(nb.right!==NIL)stack.push({a:pair.a,b:nb.right});if(nb.left!==NIL)stack.push({a:pair.a,b:nb.left});}
  }
  result.budgetExhausted=stack.length>0;frontier.push(...stack);result.status=frontier.length?'frontier':'separated';return result;
}
