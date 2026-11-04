import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { DEFAULTS, validateOptions } from '../src/comparison/run.ts';

test('comparison startAtRest remains explicit, boolean, and default on', () => {
  assert.equal(DEFAULTS.avbdStartAtRest, true);
  for (const avbdStartAtRest of [false, true]) validateOptions({ ...DEFAULTS, avbdStartAtRest });
  for (const value of ['off', 0, null, undefined]) {
    assert.throws(() => validateOptions({ ...DEFAULTS, avbdStartAtRest: value as unknown as boolean }), /Invalid avbdStartAtRest/);
  }
});

test('comparison CLI rejects invalid or missing startAtRest before opening a device', () => {
  for (const value of ['false', 'maybe', '']) {
    const result = spawnSync(process.execPath, ['--experimental-transform-types', 'scripts/compare-rapier.ts',
      '--avbd-start-at-rest', ...(value ? [value] : [])], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, value ? /Invalid --avbd-start-at-rest/ : /Missing value for --avbd-start-at-rest/);
    assert.doesNotMatch(result.stderr, /No GPU adapter/);
  }
});
