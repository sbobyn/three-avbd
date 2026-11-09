import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ENTRIES, isHeavyCase as galleryHeavy } from '../src/gallery/catalog.ts';
import { CASE_INFO, caseLabel, caseSummary, FAMILY_LABELS, familyLabel, HEAVY_BODIES, isHeavyCase } from '../src/comparison/labels.ts';
import { CASES, makeScene } from '../src/comparison/scenes.ts';
import { parseSettings, sceneFamilies } from '../src/comparison/side-model.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const count = (n: number) => n.toLocaleString('en-US');

test('every comparison case has one unique, non-ID label and a summary, and nothing else does', () => {
  assert.deepEqual(Object.keys(CASE_INFO).sort(), [...CASES].sort());
  const labels = CASES.map(caseLabel);
  assert.equal(new Set(labels).size, CASES.length, 'labels are unique');
  for (const name of CASES) {
    assert.notEqual(caseLabel(name), name, `${name} is shown by a label, not its ID`);
    assert.match(caseLabel(name), /^[A-Z]/, name);
    assert.ok(caseSummary(name).endsWith('.'), `${name} has a sentence`);
  }
});

test('the body counts and mass ratios the labels state are what the scenes build', () => {
  for (const name of CASES) {
    const scene = makeScene(name);
    const dynamic = scene.bodies.filter(b => b.mass > 0);
    assert.equal(CASE_INFO[name].bodies, dynamic.length, `${name}: dynamic bodies`);
    const nominal = /· (\d+)(k?)$/.exec(caseLabel(name));
    if (!nominal) continue;
    const n = Number(nominal[1]) * (nominal[2] ? 1000 : 1);
    if (name.startsWith('impact-')) {
      // "mass ratio N": the sphere weighs N times the brick it hits
      const [brick, ball] = dynamic;
      assert.ok(Math.abs(ball.mass / brick.mass - n) < 1e-9 * n, `${name}: ratio ${ball.mass / brick.mass}`);
    } else if (name.startsWith('ring-')) {
      assert.ok(Math.abs(dynamic.length - n) / n < 0.02, `${name}: ${dynamic.length} bricks and a ball are about ${n}`); // "9k" and "110k" are rounded
    } else {
      assert.equal(dynamic.length, n, `${name}: the label's count`);
      assert.ok(caseSummary(name).startsWith(count(n)), `${name}: the sentence leads with ${count(n)}`);
    }
  }
  // Counts in the other labels and sentences
  for (const [name, n] of [['stack-50', 50], ['chain-20', 20], ['sphere-pile-100', 100], ['sphere-pile-hcp-100', 100]] as const) {
    assert.equal(CASE_INFO[name].bodies, n, name);
    assert.match(caseSummary(name), new RegExp(`^${n}\\b`), name);
  }
  assert.match(caseSummary('ring-9k'), /9,130 bricks/);
  assert.match(caseSummary('ring-110k'), /110,440 bricks/);
  assert.equal(makeScene('ring-9k').bodies.length - 2, 9130, 'ring-9k: bricks, plus ground and ball');
  assert.equal(makeScene('ring-110k').bodies.length - 2, 110440, 'ring-110k: bricks, plus ground and ball');
});

test('scene families are named from the same words as their cases, and single cases by their case label', () => {
  for (const family of sceneFamilies()) {
    if (family.members.length === 1) {
      assert.equal(familyLabel(family.id), caseLabel(family.members[0].name), family.id);
    } else {
      const name = FAMILY_LABELS[family.id];
      assert.ok(name, `${family.id} has a family label`);
      for (const member of family.members) assert.ok(caseLabel(member.name).startsWith(name), `${member.name} starts with ${name}`);
    }
  }
  assert.deepEqual(Object.keys(FAMILY_LABELS).sort(), sceneFamilies().filter(f => f.members.length > 1).map(f => f.id).sort(), 'no unused family label');
});

test('an unknown ID is shown as typed, including names that exist on every object', () => {
  assert.equal(caseLabel('no-such-case'), 'no-such-case');
  assert.equal(caseLabel('toString'), 'toString');
  assert.equal(caseSummary('constructor'), '');
  assert.equal(familyLabel('nope-N'), 'nope-N');
});

test('labels change what is shown, not the case IDs that URLs, runs and reports use', () => {
  assert.equal(parseSettings('?scene=rest-grid-1k').scene, 'rest-grid-1k');
  assert.equal(parseSettings('?scene=Resting grid · 1k').scene, parseSettings('').scene, 'a label is not an ID');
  // compare.html keeps the ID as the option value; compare-frame.html's static options pair each value with its label
  assert.match(read('src/comparison/main.ts'), /new Option\(caseLabel\(name\), name\)/);
  const options = [...read('compare-frame.html').matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];
  assert.deepEqual(options.map(o => o[1]), ['rest-grid-1k', 'rest-grid-10k', 'pile-1k', 'sphere-pile-100']);
  for (const [, id, text] of options) assert.equal(text, caseLabel(id), id);
  // compare-side.html names families and shows the ID next to the label, as the URL carries it
  const side = read('src/comparison/side.ts');
  assert.match(side, /familyLabel\(f\.id\)/);
  assert.match(side, /caseLabel\(settings\.scene\)} \(\$\{settings\.scene\}\)/);
});

test('the demo gallery names each comparison chip the way the comparison pages do', () => {
  const chips = ENTRIES.find(e => e.id === 'side-by-side')!.items!;
  assert.equal(chips.length, CASES.length);
  for (const chip of chips) assert.equal(chip.label, caseLabel(chip.covers![0]), chip.href);
});

test('the comparison page marks as heavy exactly the cases the gallery marks, from the same body counts', () => {
  const heavy = CASES.filter(isHeavyCase);
  assert.deepEqual(heavy, CASES.filter(galleryHeavy));
  assert.deepEqual(heavy, ['rest-grid-10k', 'pile-10k', 'pile-10k-settled', 'ring-9k', 'ring-110k']);
  // The chips the gallery marks are the ones it opens paused
  const chips = ENTRIES.find(e => e.id === 'side-by-side')!.items!;
  assert.deepEqual(chips.filter(c => c.heavy).map(c => c.covers![0]), heavy);
  for (const name of CASES) assert.equal(isHeavyCase(name), CASE_INFO[name].bodies >= HEAVY_BODIES, name);
  assert.equal(isHeavyCase('no-such-case'), false);
  assert.equal(isHeavyCase('toString'), false);
  // The page shows the shared rule instead of its own, and sizes below the limit stay unmarked in its menu
  assert.match(read('src/comparison/side.ts'), /isHeavyCase\(m\.name\)/);
  assert.ok(!isHeavyCase('pile-1k-settled') && !isHeavyCase('rest-grid-1k'));
});
