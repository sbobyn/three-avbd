import test from 'node:test';
import assert from 'node:assert/strict';
import { BufferGeometry, Float32BufferAttribute } from 'three';
import { denseSurfacePoints } from '../scripts/sdf-dense-plane.ts';

test('dense diagnostic samples triangle area deterministically without leaving the surface',()=>{
  const geometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute([
    0,0,0, 2,0,0, 0,0,2,
    10,0,0, 14,0,0, 10,0,4,
  ],3));
  const a=denseSurfacePoints(geometry),b=denseSurfacePoints(geometry);
  assert.equal(a.length,1000);assert.deepEqual(a,b);
  assert.equal(a.filter(p=>p.x<5).length,200);
  assert.equal(new Set(a.map(p=>p.toArray().join(','))).size,1000);
  for(const p of a){assert.equal(p.y,0);const x=p.x<5?p.x:p.x-10;assert.ok(x>=0&&p.z>=0&&x+p.z<=(p.x<5?2:4)+1e-6);}
  geometry.dispose();
});
test('dense diagnostic rejects degenerate surfaces and invalid sample budgets',()=>{
  const geometry=new BufferGeometry().setAttribute('position',new Float32BufferAttribute([0,0,0,0,0,0,0,0,0],3));
  assert.throws(()=>denseSurfacePoints(geometry),/Empty surface/);
  assert.throws(()=>denseSurfacePoints(geometry,1001),/sample count/);
  geometry.dispose();
});
