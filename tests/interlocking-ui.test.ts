import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PROGRESS_MIN_INTERVAL_MS, progressLine, shouldWriteProgress } from '../examples/interlocking-progress.ts';
import { INTERLOCKING } from '../src/comparison/interlocking-scene.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const base = { step: 0, dt: INTERLOCKING.dt, paused: true, pushes: 0, pushQueued: false };

test('the progress line gives step, simulated time and paused or live', () => {
  assert.equal(progressLine(base), 'step 0 · t = 0.00 s · paused');
  assert.equal(progressLine({ ...base, step: 120, paused: false }), 'step 120 · t = 1.00 s · live', 'the page steps at 1/120 s');
  assert.equal(INTERLOCKING.dt, 1 / 120);
});

test('a push while paused says it has not moved anything yet; a live push or a stepped one does not', () => {
  const queued = progressLine({ ...base, pushes: 1, pushQueued: true });
  assert.match(queued, /1 push · push queued: the lower ring moves when you press Play/);
  assert.match(progressLine({ ...base, pushes: 2, pushQueued: true }), /2 pushes/);
  assert.doesNotMatch(progressLine({ ...base, pushes: 1, pushQueued: true, paused: false }), /queued/, 'live: the next frame steps it');
  assert.doesNotMatch(progressLine({ ...base, step: 3, pushes: 1 }), /queued/, 'a step has run since');
});

test('live updates are throttled and identical text is never rewritten; a change of state is written at once', () => {
  const a = progressLine({ ...base, step: 1, paused: false }), b = progressLine({ ...base, step: 2, paused: false });
  assert.equal(shouldWriteProgress(a, a, 0, 10_000), false, 'same text');
  assert.equal(shouldWriteProgress(a, b, 1000, 1000 + PROGRESS_MIN_INTERVAL_MS - 1), false, 'a tick inside the interval');
  assert.equal(shouldWriteProgress(a, b, 1000, 1000 + PROGRESS_MIN_INTERVAL_MS), true, 'a tick after the interval');
  assert.equal(shouldWriteProgress(a, b, 1000, undefined), true, 'play, pause, push and reset are not throttled');
  // 60 frames a second for ten seconds, one step per frame: the readout is rewritten about four times a second
  let shown = '', at = -Infinity, writes = 0;
  for (let frame = 0; frame < 600; frame++) {
    const now = frame * (1000 / 60), text = progressLine({ ...base, step: frame * 2, paused: false });
    if (shouldWriteProgress(shown, text, at, now)) { shown = text; at = now; writes++; }
  }
  assert.ok(writes >= 38 && writes <= 41, `${writes} writes in 10 s`);
});

test('the pages carry the progress line, and only the Rapier page has the piece-count select', () => {
  for (const engine of ['rapier', 'avbd']) {
    const html = read(`examples/interlocking-${engine}.html`);
    assert.match(html, /<p id="progress" aria-live="off"><\/p>\s*<p id="status" role="status">/, `${engine}: a quiet progress line beside the live status`);
  }
  assert.match(read('examples/interlocking-rapier.html'), /<select id="pieces">/);
  const avbd = read('examples/interlocking-avbd.html');
  assert.doesNotMatch(avbd, /<select|id="pieces"|disabled><option/, 'no permanently disabled select');
  assert.match(avbd, /<p id="representation">[^<]*analytic torus fields[^<]*convex pieces/);
  // Both keep the production study-protocol link and the gallery link
  for (const engine of ['rapier', 'avbd']) {
    const html = read(`examples/interlocking-${engine}.html`);
    assert.match(html, /href="https:\/\/github\.com\/sbobyn\/three-avbd\/blob\/main\/docs\/PAIRED_STUDIES\.md">Study protocol</);
    assert.match(html, /<a href="\.\/index\.html">← Demo gallery<\/a>/);
  }
});

test('the shared view updates the line from the study\'s own step count and keeps the select optional', () => {
  const view = read('examples/interlocking-view.ts');
  assert.match(view, /physicsStep = result\.step;/, 'step comes from the pose readback, not from frames drawn');
  assert.match(view, /document\.getElementById\('pieces'\) as HTMLSelectElement \| null/);
  for (const use of view.matchAll(/(.{0,12})\bpieces\.(disabled|value|addEventListener)/g)) {
    assert.equal(use[1], 'if (pieces) ', `an unguarded use of the select: ${use[0]}`);
  }
});
