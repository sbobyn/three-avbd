import assert from 'node:assert/strict';
import { test } from 'node:test';
import RAPIER from '@dimforge/rapier3d-compat';
import { createRapierInterlocking } from '../src/comparison/interlocking-rapier.ts';
import { INTERLOCKING, ringMassProperties, torusSectors } from '../src/comparison/interlocking-scene.ts';

test('Rapier compound ring preserves its opening and authored mass across detail settings', async () => {
  for (const pieces of [16, 32, 64] as const) {
    const study = await createRapierInterlocking(pieces);
    try {
      study.step();
      assert.equal(study.bodies[0].numColliders(), pieces);
      assert.ok(Math.abs(study.bodies[0].mass() - ringMassProperties().mass) < 1e-5);
      const hole = study.world.castRay(new RAPIER.Ray({ x: 0, y: 3, z: -3 }, { x: 0, y: 0, z: 1 }), 6, true);
      assert.equal(hole, null, 'neither ring nor peg fills the upper opening');
      const tube = study.world.castRay(new RAPIER.Ray({ x: INTERLOCKING.majorRadius, y: 3, z: -3 }, { x: 0, y: 0, z: 1 }), 6, true);
      assert.ok(tube, 'ray hits actual compound tube');
    } finally { study.dispose(); study.dispose(); }
    assert.throws(() => study.step(), /disposed/);
  }
  assert.throws(() => torusSectors(1 as 16), /16, 32 or 64/);
});

test('fresh reset reconstructs the same bounded Rapier sequence with finite poses', async () => {
  async function run() {
    const study = await createRapierInterlocking();
    try {
      for (let i = 0; i < 240; i++) {
        if (i === 120) {
          const hanging = study.poses();
          assert.ok(hanging[0].position.y > 2.5, 'upper ring supported by peg');
          assert.ok(hanging[1].position.y > 1, 'lower ring supported through interlocking contact, above floor');
          study.push();
        }
        study.step();
      }
      const poses = study.poses();
      for (const p of poses) {
        assert.ok([...Object.values(p.position), ...Object.values(p.rotation)].every(Number.isFinite));
        assert.ok(p.position.y > .1, 'ring has not fallen through the floor');
      }
      return poses;
    } finally { study.dispose(); }
  }
  assert.deepEqual(await run(), await run());
});
