import assert from 'node:assert/strict';
import { BoxGeometry, Euler, Quaternion } from 'three';
import { bakeVoxelSdf } from '../src/avbd3d/ref/sdf/bake.ts';
import { SdfBody } from '../src/avbd3d/ref/sdf/body.ts';
import { collisionParams } from '../src/avbd3d/ref/sdf/manifold.ts';
import { SdfNarrowphasePass } from '../src/avbd3d/gpu/sdf-pass.ts';
import { snapshotSdfField } from '../src/avbd3d/gpu/sdf-snapshot.ts';
import { gpuTest } from './device.ts';

for (const parallelMeshWitnesses of [false, true]) {
  gpuTest(`SDF witnesses reject opposed ambiguous points (${parallelMeshWitnesses ? 'parallel' : 'serial'})`, async device => {
    const geometry = new BoxGeometry();
    const field = snapshotSdfField(bakeVoxelSdf(geometry, { resolution: 8 }).field, true);
    const pass = await SdfNarrowphasePass.create(device, [field], {
      maxBodies: 2, maxPairs: 1, meshVertexContacts: true, parallelMeshWitnesses,
    });
    const params = collisionParams();
    let state = 7;
    const random = () => {
      state = (Math.imul(state ^ state >>> 15, 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return state / 2 ** 32;
    };
    let witnessed = 0;
    let dropped = 0;
    try {
      for (let pose = 0; pose < 48; pose++) {
        const rotation = new Quaternion().setFromEuler(new Euler(random() * 6.3, random() * 6.3, random() * 6.3)).toArray() as [number, number, number, number];
        const bodies = [
          new SdfBody(field, [0, 0, 0]),
          new SdfBody(field, [(random() - 0.5) * 0.6, 0.55 + random() * 0.35, (random() - 0.5) * 0.6], rotation),
        ];
        for (const meshVertexContacts of [true, false]) {
          pass.step(bodies, [{ a: 0, b: 1, key: pose + 1 }], 0, { ...params, meshVertexContacts });
          const [result] = await pass.readResults();
          const witness = result.points.find(point => point.id >= 0x40000000);
          const rejected = result.points.filter(point => point.id < 0x40000000 && !point.active && point.separation < params.margin);
          if (!meshVertexContacts || !witness) {
            assert.equal(rejected.length, 0, `pose ${pose}: no witness means no filter`);
            continue;
          }
          witnessed++;
          dropped += rejected.length;
          for (const point of result.points) {
            if (point.id >= 0x40000000 || !point.active) continue;
            const opposed = point.normal.reduce((sum, value, axis) => sum + value * witness.normal[axis], 0) < 0;
            const sampleA = bodies[0].sample(point.x as [number, number, number]);
            const sampleB = bodies[1].sample(point.x as [number, number, number]);
            const aligned = sampleA.gradient.reduce((sum, value, axis) => sum + value * sampleB.gradient[axis], 0) > 0;
            const ambiguous = (sampleA.phi < -1e-5 && sampleB.phi < -1e-5 && aligned)
              || (sampleA.phi > 1e-5 && sampleB.phi > 1e-5);
            assert.ok(!(opposed && ambiguous), `pose ${pose}: active optimizer contact opposes its witness with an ambiguous normal`);
          }
          for (const point of rejected) {
            assert.ok(point.normal.reduce((sum, value, axis) => sum + value * witness.normal[axis], 0) < 0,
              `pose ${pose}: only opposed points are filtered`);
          }
        }
      }
      assert.ok(witnessed > 10, 'the regression exercises witnessed pairs');
      assert.ok(dropped > 0, 'the regression exercises filtering');
    } finally {
      pass.destroy();
      geometry.dispose();
    }
  });
}
