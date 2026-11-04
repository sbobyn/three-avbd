import assert from 'node:assert/strict';
import { B_POS, B_ROT, BODY_FLOATS, BOX_DEPTH_WITNESS_FEATURE, CONTACT_WORDS, K_RA, STICK_BIT } from '../src/avbd3d/gpu/layout.ts';
import { GpuSolver3D, gpuParams3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { rotate, vec3 } from '../src/avbd3d/ref/math.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { boxDepth } from '../src/comparison/contact-quality.ts';
import { gpuTest } from './device.ts';

const sizes = [
  [1.1827850056812168, 0.9266371313948184, 0.6772531204856932],
  [0.77978714290075, 0.6459740664809942, 0.8364235038403421],
];
const initial = [
  { position: [0, 0, 0], rotation: [0.6727294290488031, -0.22197439743259842, 0.6193567545811737, -0.33846667890766186] },
  { position: [0.5282729966565967, -0.667605806607753, 0.7578285355120897], rotation: [0.6451294411920457, -0.01959805776679549, 0.7597260903942524, -0.07899485941042093] },
];
const moved = [
  { position: [0.0053864693222567435, -0.006164779064711183, 0.00003445392474532127], rotation: [0.698040438435547, -0.18567962226019352, 0.6043650529078143, -0.3361629173626328] },
  { position: [0.5351085968594999, -0.6549769994267263, 0.7482571554696187], rotation: [0.619168362903033, -0.06569240580689312, 0.7777628986745723, -0.08602278561292738] },
];

for (const deepestBoxWitness of [false, true]) {
  gpuTest(`deepest box witness ${deepestBoxWitness ? 'survives stale sticking anchors' : 'leaves default anchors unchanged'}`, async device => {
    const reference = new Solver();
    for (const [index, pose] of initial.entries()) {
      const body = new Rigid(reference, sizes[index], 1, 0.5, pose.position);
      body.positionAng.set(pose.rotation);
    }
    const solver = new GpuSolver3D(device, reference, { spatialSort: false });
    Object.assign(solver.params, { iterations: 0, gravity: 0, faceBias: false, reuseContacts: false, deepestBoxWitness });
    try {
      solver.step();
      const storage = solver.contactStorage;
      const contacts = await solver.readContactList();
      assert.ok(contacts.length > 0, 'the seed pair has actual contacts');
      for (const [index, contact] of contacts.entries()) {
        device.queue.writeBuffer(storage.contacts, (index * CONTACT_WORDS + K_RA + 3) * 4,
          new Uint32Array([(contact.feature | STICK_BIT) >>> 0]));
      }
      for (const [index, pose] of moved.entries()) {
        device.queue.writeBuffer(solver.bodyBuffer, (index * BODY_FLOATS + B_POS) * 4, new Float32Array(pose.position));
        device.queue.writeBuffer(solver.bodyBuffer, (index * BODY_FLOATS + B_ROT) * 4, new Float32Array(pose.rotation));
      }
      solver.step();
      const current = await solver.readContactList();
      const depths = current.map(contact => {
        const anchorA = rotate(vec3(), moved[contact.a].rotation, contact.rA);
        const anchorB = rotate(vec3(), moved[contact.b].rotation, contact.rB);
        return -contact.normal.reduce((sum, value, axis) => sum + value * (
          moved[contact.a].position[axis] + anchorA[axis] - moved[contact.b].position[axis] - anchorB[axis]), 0);
      });
      const expected = boxDepth(moved[0].position, moved[0].rotation, sizes[0], moved[1].position, moved[1].rotation, sizes[1]);
      assert.ok(expected > 0.13, 'the independent SAT evaluator sees a substantial overlap');
      if (deepestBoxWitness) {
        assert.ok(Math.max(...depths) >= expected - 1e-5,
          `deepest contact ${Math.max(...depths)} must retain the SAT overlap ${expected}`);
        assert.equal(current.filter(contact => (contact.feature & BOX_DEPTH_WITNESS_FEATURE) !== 0).length, 1);
      } else {
        assert.ok(Math.max(...depths) < expected / 2, 'the disabled control preserves the old shallow-anchor behavior');
        assert.ok(current.every(contact => (contact.feature & BOX_DEPTH_WITNESS_FEATURE) === 0));
      }
      assert.ok(current.length <= 8, 'the witness uses an existing manifold slot');
      assert.equal((await solver.readCounters()).overflow, 0);
    } finally {
      solver.destroy();
    }
  });
}

gpuTest('deepest box witness toggles invalidate both contact and manifold reuse', async device => {
  assert.equal(gpuParams3D().deepestBoxWitness, false);
  const reference = new Solver();
  new Rigid(reference, [2, 2, 2], 0, 0.5, [0, 0, 0]);
  new Rigid(reference, [2, 2, 2], 1, 0.5, [0, 0, 1.5]);
  const solver = new GpuSolver3D(device, reference, { spatialSort: false });
  Object.assign(solver.params, { iterations: 0, gravity: 0 });
  try {
    for (const enabled of [false, true, true, false]) {
      solver.params.deepestBoxWitness = enabled;
      solver.step({ reuseManifolds: true });
      const contacts = await solver.readContactList();
      assert.equal(contacts.length, 4);
      assert.equal(contacts.filter(contact => (contact.feature & BOX_DEPTH_WITNESS_FEATURE) !== 0).length, enabled ? 1 : 0);
      assert.equal((await solver.readCounters()).overflow, 0);
    }
  } finally {
    solver.destroy();
  }
});

gpuTest('deepest box witness does not create a contact for separated boxes', async device => {
  const reference = new Solver();
  new Rigid(reference, [1, 1, 1], 1, 0.5, [0, 0, 0]);
  new Rigid(reference, [1, 1, 1], 1, 0.5, [1.1, 0, 0]);
  const solver = new GpuSolver3D(device, reference, { spatialSort: false });
  Object.assign(solver.params, { iterations: 0, gravity: 0, deepestBoxWitness: true });
  try {
    solver.step();
    assert.equal((await solver.readContactList()).length, 0);
    assert.equal((await solver.readCounters()).overflow, 0);
  } finally {
    solver.destroy();
  }
});
