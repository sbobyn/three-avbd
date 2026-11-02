import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CASES, SCENE_VALIDITY } from '../src/comparison/scenes.ts';
import { familyOf, formatSettings, parseSettings, RollingStats, sceneFamilies, SIDE_DEFAULTS, validity } from '../src/comparison/side-model.ts';

test('side-by-side scene families cover every case once and group scaled cases', () => {
  const families = sceneFamilies();
  assert.deepEqual(families.flatMap(f => f.members.map(m => m.name)).sort(), [...CASES].sort());
  assert.deepEqual(familyOf('rest-grid-1k', families).members.map(m => m.scale), ['100', '1k', '10k']);
  assert.deepEqual(familyOf('pile-10k-settled', families).members.map(m => m.name), ['pile-1k-settled', 'pile-10k-settled']);
  assert.deepEqual(familyOf('pile-1k', families).members.map(m => m.name), ['pile-100', 'pile-1k', 'pile-10k']);
  assert.equal(familyOf('sphere-pile-100', families).members.length, 1);
  assert.equal(familyOf('sphere-pile-hcp-100', families).members.length, 1);
  assert.equal(familyOf('impact-100', families).scaleLabel, 'Mass ratio');
});

test('side-by-side validity follows SCENE_VALIDITY and the default scene is valid', () => {
  assert.equal(validity(SIDE_DEFAULTS.scene).kind, 'valid');
  for (const name of CASES) {
    const v = SCENE_VALIDITY[name];
    assert.equal(validity(name).kind, !v ? 'unclassified' : v.status === 'valid' ? 'valid' : 'invalid');
  }
});

test('side-by-side URL settings round-trip and reject bad values', () => {
  assert.deepEqual(parseSettings(''), SIDE_DEFAULTS);
  assert.equal(formatSettings(SIDE_DEFAULTS), '');
  const changed = { ...SIDE_DEFAULTS, scene: 'rest-grid-10k' as const, avbdIterations: 8, rapierIterations: 2,
    avbdMargin: 0.001, rapierSleeping: true, linkCameras: false, paused: true };
  assert.deepEqual(parseSettings(formatSettings(changed)), changed);
  assert.deepEqual(parseSettings('?scene=typo&avbdIterations=0&rapierIterations=x&margin=0.5&dt=-1'), SIDE_DEFAULTS);
});

test('rolling stats keep a bounded window', () => {
  const s = new RollingStats(20);
  assert.ok(Number.isNaN(s.mean));
  for (let i = 1; i <= 40; i++) s.push(i);
  assert.equal(s.count, 20);
  assert.equal(s.mean, 30.5);
  assert.equal(s.p95, 39);
});
