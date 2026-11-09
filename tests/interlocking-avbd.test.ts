import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { avbdInterlockingPlan, createAvbdInterlocking, FIELD_Y_TO_BODY_Z } from '../src/comparison/interlocking-avbd.ts';
import { INTERLOCKING, ringMassProperties, torusSectors } from '../src/comparison/interlocking-scene.ts';

type V = [number, number, number];
const q = (r: readonly number[]) => new THREE.Quaternion(r[0], r[1], r[2], r[3]);
// World = bodyRotation * bindingRotation * field point (World/SDF bridge convention).
const toField = (world: V, position: readonly number[], body: readonly number[], binding: readonly number[] = [0, 0, 0, 1]) =>
  new THREE.Vector3(...world).sub(new THREE.Vector3(...position)).applyQuaternion(q(body).multiply(q(binding)).invert()).toArray() as V;
const toWorld = (local: V, position: readonly number[], body: readonly number[]) =>
  new THREE.Vector3(...local).applyQuaternion(q(body)).add(new THREE.Vector3(...position)).toArray() as V;

test('AVBD plan reuses the authored scene, exact shared mass and principal moments', () => {
  const plan = avbdInterlockingPlan(), props = ringMassProperties();
  assert.deepEqual(plan.floor.size, INTERLOCKING.floor.halfExtents.map(v => v * 2));
  assert.deepEqual(plan.floor.position, INTERLOCKING.floor.position);
  assert.deepEqual(plan.peg.position, INTERLOCKING.peg.position);
  assert.deepEqual(plan.rings.map(r => r.position), INTERLOCKING.positions);
  for (const ring of plan.rings) {
    assert.equal(ring.massProperties.mass, props.mass);
    assert.deepEqual(ring.massProperties.moments, [props.inertia.x, props.inertia.y, props.inertia.z]);
    assert.equal(ring.friction, INTERLOCKING.friction);
  }
  assert.equal(plan.peg.friction, INTERLOCKING.friction);
  assert.equal(plan.floor.friction, INTERLOCKING.friction);
});

test('binding rotation puts the analytic torus on the visible and Rapier z-axis tori', () => {
  const { ringField } = avbdInterlockingPlan();
  const visible = new THREE.TorusGeometry(INTERLOCKING.majorRadius, INTERLOCKING.minorRadius, 16, 96).getAttribute('position');
  for (let i = 0; i < visible.count; i += 7) {
    const p = toField([visible.getX(i), visible.getY(i), visible.getZ(i)], [0, 0, 0], [0, 0, 0, 1], FIELD_Y_TO_BODY_Z);
    assert.ok(Math.abs(ringField.sample(p).phi) < 1e-5, 'visible torus vertex on field surface');
  }
  const sector = torusSectors(16)[3];
  for (let i = 0; i < sector.length; i += 3) {
    const p = toField([sector[i], sector[i + 1], sector[i + 2]], [0, 0, 0], [0, 0, 0, 1], FIELD_Y_TO_BODY_Z);
    assert.ok(Math.abs(ringField.sample(p).phi) < 1e-5, 'Rapier hull sample point on field surface');
  }
  // Without the binding rotation the field would lie in xz, not the body's xy plane.
  const top: V = [0, INTERLOCKING.majorRadius + INTERLOCKING.minorRadius, 0];
  assert.ok(ringField.sample(top).phi > 1, 'unrotated field misses the body-frame rim');
  assert.ok(Math.abs(ringField.sample(toField(top, [0, 0, 0], [0, 0, 0, 1], FIELD_Y_TO_BODY_Z)).phi) < 1e-6);
  assert.ok(ringField.sample([0, 0, 0]).phi > .7, 'central opening is empty');
});

test('initial poses: peg through the upper opening, rings linked without overlap, peg along z', () => {
  const plan = avbdInterlockingPlan(), [upper, lower] = plan.rings, { peg } = INTERLOCKING;
  const ringPhi = (ring: typeof upper, p: V) => plan.ringField.sample(toField(p, ring.position, ring.rotation, plan.ringBindingRotation)).phi;
  const pegPhi = (p: V) => plan.peg.field.sample(toField(p, plan.peg.position, plan.peg.rotation)).phi;
  let pegClearance = Infinity;
  for (let z = -peg.halfLength; z <= peg.halfLength; z += .05) {
    const depth = Math.min(peg.radius, peg.halfLength - Math.abs(z));
    assert.ok(Math.abs(pegPhi([0, peg.position[1], peg.position[2] + z]) + depth) < 1e-5, 'peg axis is world z');
    for (let k = 0; k < 32; k++) {
      const a = k * Math.PI / 16, p: V = [peg.radius * Math.cos(a), peg.position[1] + peg.radius * Math.sin(a), peg.position[2] + z];
      assert.ok(Math.abs(pegPhi(p)) < 1e-5, 'sample on peg surface');
      pegClearance = Math.min(pegClearance, ringPhi(upper, p));
    }
  }
  assert.ok(pegClearance > 0, `peg passes through the upper opening without overlap (clearance ${pegClearance})`);
  assert.ok(Math.abs(pegPhi([0, peg.position[1], peg.position[2] + peg.halfLength])) < 1e-6, 'peg end cap at halfLength');
  // Lower ring centreline crosses the upper ring's plane once inside its hole and once outside it.
  const R = INTERLOCKING.majorRadius, crossings: number[] = [];
  let previous: V | undefined;
  for (let k = 0; k <= 720; k++) {
    const a = k * Math.PI / 360, p = toWorld([R * Math.cos(a), R * Math.sin(a), 0], lower.position, lower.rotation);
    if (previous && Math.sign(previous[2]) !== Math.sign(p[2])) crossings.push(Math.hypot(p[0] - upper.position[0], p[1] - upper.position[1]));
    previous = p;
  }
  assert.equal(crossings.length, 2);
  assert.equal(crossings.filter(d => d < R - INTERLOCKING.minorRadius).length, 1, 'rings are topologically linked');
  const surface = new THREE.TorusGeometry(R, INTERLOCKING.minorRadius, 16, 96).getAttribute('position');
  let clearance = Infinity;
  for (let i = 0; i < surface.count; i++) {
    const p = toWorld([surface.getX(i), surface.getY(i), surface.getZ(i)], lower.position, lower.rotation);
    clearance = Math.min(clearance, ringPhi(upper, p));
    assert.ok(p[1] > 0, 'lower ring above floor');
  }
  assert.ok(clearance > 0, `rings start separated (clearance ${clearance})`);
});

test('model creation needs a caller-owned device or renderer', async () => {
  await assert.rejects(createAvbdInterlocking({}), /caller-owned device or renderer/);
});
