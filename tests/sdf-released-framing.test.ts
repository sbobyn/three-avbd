import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FramingPolicy } from '../src/sdf-released/framing.ts';

// The page loads through one function (load) for the first load, a scene change, Reset, a change of contact settings
// and the comparison toggle. It asks the policy before fitting the camera, and marks the scene only after it fit.
test('the camera is fitted on first load and on a different scene, and kept for Reset, settings and comparison reloads', () => {
  const framing = new FramingPolicy();
  const load = (scene: number) => { const fit = framing.needsFraming(scene); if (fit) framing.markFramed(scene); return fit; };
  assert.equal(load(0), true, 'first load');
  assert.equal(load(0), false, 'Reset');
  assert.equal(load(0), false, 'Contact settings');
  assert.equal(load(0), false, 'Reference comparison toggle');
  assert.equal(load(6), true, 'another scene');
  assert.equal(load(6), false, 'Reset in the new scene');
  assert.equal(load(0), true, 'back to the first scene: the camera frames Pile of Chairs, not Box Stack');
});

test('a load that fails before the camera is fitted fits nothing, so the camera still frames the last fitted scene', () => {
  const framing = new FramingPolicy();
  framing.markFramed(0);
  assert.equal(framing.needsFraming(3), true);
  // scene 3 fails to load: markFramed(3) never happens
  assert.equal(framing.needsFraming(3), true, 'the retry of the failed scene fits it');
  assert.equal(framing.needsFraming(0), false, 'returning to the scene the camera still frames keeps the viewer\'s view');
  // a first load that fails leaves nothing fitted
  const first = new FramingPolicy();
  assert.equal(first.needsFraming(0), true);
  assert.equal(first.needsFraming(0), true, 'still unfitted after a failed first load');
});

test('the released page fits the camera only through the policy; the Frame button still re-fits on demand', () => {
  const source = readFileSync(new URL('../src/sdf-released/main.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(framing\.needsFraming\(id\)\) \{ frameView\(\); framing\.markFramed\(id\); \}/);
  assert.equal([...source.matchAll(/frameView\(\)/g)].length, 1, 'only the guarded call in load fits without being asked');
  assert.match(source, /frameView\(true\)/, 'the Frame button fits the current poses');
  assert.match(source, /const id = Number\(select\.value\);\s+prepared = await loadReleasedScene\(id, /, 'the scene fitted is the scene loaded');
});
