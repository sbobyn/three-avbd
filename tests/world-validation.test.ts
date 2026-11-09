import test from 'node:test';
import assert from 'node:assert/strict';
import { copyBodyPatch } from '../src/lib/body-commands.ts';
import { checkBodyMaterial, checkBodySize, checkDelta, checkDt, checkGravity, checkIterations, checkMaxSubsteps, checkRadius } from '../src/lib/world-validation.ts';

const F32_MAX = 3.4028234663852886e38;

test('body sizes and radii are positive and finite as f32, and copied', () => {
  const input = [1, 2, 3];
  const size = checkBodySize(input, 'addBox');
  input[0] = 99;
  assert.deepEqual(size, [1, 2, 3]);
  assert.deepEqual(checkBodySize(new Float32Array([0.5, 0.5, 0.5]), 'addBox'), [0.5, 0.5, 0.5]);
  for (const bad of [[1, 1], [1, 1, 1, 1], null, undefined, 5, 'abc', [0, 1, 1], [-1, 1, 1], [1, NaN, 1], [1, Infinity, 1], [1, 1e39, 1], [1, 1e-50, 1], [1, '1', 1]]) {
    assert.throws(() => checkBodySize(bad, 'addBox'), /addBox: size/, String(bad));
  }
  assert.equal(checkRadius(0.5, 'addSphere'), 1);
  for (const bad of [0, -1, NaN, Infinity, 1e-50, F32_MAX, undefined, null, '1']) {
    assert.throws(() => checkRadius(bad, 'addSphere'), /addSphere: radius/, String(bad));
  }
});

test('density and friction are finite and at least 0; collision groups are 32-bit masks', () => {
  checkBodyMaterial({}, 'addBox');
  // A fixed ground of density 0 stays valid, as does frictionless
  checkBodyMaterial({ density: 0, friction: 0, group: 0, collidesWith: 0xffffffff }, 'addBox');
  // JS bitwise operators produce signed int32 values; these masks already work in World.
  checkBodyMaterial({ group: 1 << 31, collidesWith: ~2 }, 'addBox');
  checkBodyMaterial({ collidesWith: -1 }, 'addBox');
  for (const bad of [{ density: -1 }, { density: NaN }, { density: Infinity }, { density: 1e39 }, { density: '1' }, { friction: -0.1 }, { friction: NaN }, { friction: null }]) {
    assert.throws(() => checkBodyMaterial(bad, 'addBox'), RangeError, JSON.stringify(bad));
  }
  for (const bad of [{ group: -0x80000001 }, { group: 1.5 }, { group: 2 ** 32 }, { collidesWith: NaN }, { collidesWith: '1' }]) {
    assert.throws(() => checkBodyMaterial(bad, 'addBox'), /32-bit mask/, JSON.stringify(bad));
  }
});

test('initial body state is checked and normalised as Body.set does, null and malformed arrays included', () => {
  const patch = copyBodyPatch({ position: [1, 2, 3], rotation: [0, 0, 0, 2] });
  assert.deepEqual(patch, { position: [1, 2, 3], rotation: [0, 0, 0, 1] });
  assert.deepEqual(copyBodyPatch({ position: undefined }), {});
  for (const bad of [{ position: null }, { velocity: 0 }, { rotation: [0, 0, 1] }, { position: [0, NaN, 0] }, { angularVelocity: [0, 0, -Infinity] }, { position: [1e39, 0, 0] }, { rotation: [0, 0, 0, 0] }]) {
    assert.throws(() => copyBodyPatch(bad as never), /Invalid body/, JSON.stringify(bad));
  }
});

test('step parameters: positive finite dt, integer iterations and substeps, finite gravity', () => {
  assert.equal(checkDt(1 / 60), 1 / 60);
  for (const bad of [0, -1 / 60, NaN, Infinity, 1e-50, 1e39, undefined, '0.016']) assert.throws(() => checkDt(bad), /World\.dt/, String(bad));
  // 0 iterations is an existing valid setting (bodies integrate without solving)
  assert.equal(checkIterations(0), 0);
  assert.equal(checkIterations(10), 10);
  for (const bad of [-1, 1.5, NaN, Infinity, undefined, '10']) assert.throws(() => checkIterations(bad), /World\.iterations/, String(bad));
  assert.equal(checkMaxSubsteps(1), 1);
  for (const bad of [0, -1, 2.5, NaN, Infinity, undefined]) assert.throws(() => checkMaxSubsteps(bad), /World\.maxSubsteps/, String(bad));
  const g = [0, -9.81, 0];
  const copy = checkGravity(g);
  g[1] = 0;
  assert.deepEqual(copy, [0, -9.81, 0]);
  assert.deepEqual(checkGravity([0, 0, 0]), [0, 0, 0]);
  for (const bad of [[0, NaN, 0], [0, -Infinity, 0], [0, 1e39, 0], [F32_MAX, F32_MAX, 0], [0, -9.81], null]) assert.throws(() => checkGravity(bad), /World\.gravity/, String(bad));
  assert.throws(() => checkDt(0, 'World.create: dt'), /World\.create: dt/);
});

test('update deltas: finite only, negative still counts as no time', () => {
  assert.equal(checkDelta(1 / 60), 1 / 60);
  assert.equal(checkDelta(0), 0);
  assert.equal(checkDelta(-0.5), 0);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.016']) assert.throws(() => checkDelta(bad), /World\.update/, String(bad));
});

test('World.create refuses invalid dt, iterations and gravity before touching the renderer', async () => {
  const { World } = await import('../src/lib/world.ts');
  let touched = false;
  const renderer = { init: async () => { touched = true; } } as never;
  for (const options of [{ dt: 0 }, { dt: Infinity }, { iterations: -1 }, { iterations: 0.5 }, { gravity: [0, NaN, 0] }, { gravity: [0, -9.81] }]) {
    await assert.rejects(World.create({ renderer, maxBodies: 4, ...options } as never), /World\.create: (dt|iterations|gravity)/, JSON.stringify(options));
  }
  assert.equal(touched, false);
});
