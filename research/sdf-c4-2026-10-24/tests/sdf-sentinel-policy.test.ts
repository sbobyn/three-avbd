// RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: db0fb8b60151ba90852f5d79ace22536a9afcc70520aff0ca0b501d79a174d53. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sdfNarrowphaseSource} from '../src/avbd3d/gpu/wgsl-sdf.ts';
import {sdfSentinelSource,sdfSentinelProbeSource} from '../scripts/sdf-sentinel-policy.ts';
test('sentinel experiment validates inputs and leaves the disabled shader identical',()=>{
  const source=sdfNarrowphaseSource(20,206);
  assert.equal(sdfSentinelSource(source,1),source);
  for(const interval of [0,5,NaN,1.5])assert.throws(()=>sdfSentinelSource(source,interval));
  assert.throws(()=>sdfSentinelSource(source.replace('p=optimize(seed,step);','p=seed;')));
  assert.throws(()=>sdfSentinelSource(source.replace('array<Point,20>','array<Point,21>')));
});
test('sentinel retains the original full-search and contact-reduction source',()=>{
  for(const points of [5,20]){
    const source=sdfNarrowphaseSource(points),candidate=sdfSentinelSource(source);
    const start='  var cached=0u; var activeCount=0u;',end='  // First-wins duplicate rejection, then stable ranking (Algorithm 1).';
    assert.ok(candidate.includes(source.slice(source.indexOf(start),source.indexOf(end))));
    assert.equal(candidate.slice(candidate.indexOf(end)),source.slice(source.indexOf(end)));
    assert.ok(candidate.includes('work.identity.w=0u; work.stats.z=0u; rng=originalRng;'));
  }
});
