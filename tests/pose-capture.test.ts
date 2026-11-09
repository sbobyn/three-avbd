import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { authoredScene, CAPTURE_DEFAULTS, CaptureRefusal, checkOutputTarget, parseCaptureArgs } from '../examples/pose-capture.ts';
import { TRACK_LIMITS } from '../examples/pose-track.ts';

// CPU only. Nothing here starts a GPU: the CLI cases run with the `webgpu` module made unloadable, so a refusal that
// got as far as acquiring a GPU would show up as a different message and exit code.
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'three-avbd-pose-capture-')));
after(() => rmSync(dir, { recursive: true, force: true }));

const refusal = (argv: string[]) => { try { parseCaptureArgs(argv); } catch (e) { return e instanceof CaptureRefusal ? e.message : `other: ${e}`; } return null; };

test('arguments: defaults, ceilings, and every malformed form is a refusal', () => {
  const ok = parseCaptureArgs(['--out', 'a.json']);
  assert.deepEqual(ok, { help: false, config: { out: 'a.json', bodies: CAPTURE_DEFAULTS.bodies, steps: CAPTURE_DEFAULTS.steps } });
  assert.ok(CAPTURE_DEFAULTS.bodies + 1 <= 16 && CAPTURE_DEFAULTS.steps <= 120, 'default scene stays small');
  assert.deepEqual(parseCaptureArgs(['--out', 'a.json', '--bodies', String(TRACK_LIMITS.maxBodies - 1), '--steps', '300']), { help: false, config: { out: 'a.json', bodies: 63, steps: 300 } });
  assert.deepEqual(parseCaptureArgs(['--help']), { help: true });
  for (const argv of [
    [], ['--out'], ['--out', ''], ['--out', 'a.txt'], ['--out', 'a'], ['--out', 'a.json', '--bodies'], ['--out', 'a.json', '--steps', '--bodies'],
    ['--out', 'a.json', '--bodies', '0'], ['--out', 'a.json', '--bodies', '64'], ['--out', 'a.json', '--steps', '0'], ['--out', 'a.json', '--steps', '301'],
    ['--out', 'a.json', '--steps', '12.5'], ['--out', 'a.json', '--steps', '1e2'], ['--out', 'a.json', '--steps', '-3'], ['--out', 'a.json', '--steps', ' 5'],
    ['--out', 'a.json', '--steps', '0x10'], ['--out', 'a.json', '--steps', '99999999'],
    ['--out', 'a.json', '--out', 'b.json'], ['--out', 'a.json', '--software'], ['--out', 'a.json', 'extra'], ['--out', 'a.json', '--gpu', 'swiftshader'],
  ]) assert.ok(refusal(argv), `refused: ${JSON.stringify(argv)}`);
  assert.ok(refusal(['--out', 'a.json', '--software'])!.includes('Unknown option'), 'there is no software override');
});

test('output target: a new file in an existing directory; an existing file or folder, or a missing directory, is refused', () => {
  checkOutputTarget(join(dir, 'new.json'));
  const taken = join(dir, 'taken.json');
  writeFileSync(taken, '{}');
  assert.throws(() => checkOutputTarget(taken), CaptureRefusal);
  assert.equal(existsSync(taken), true);
  assert.throws(() => checkOutputTarget(join(dir, 'missing', 'new.json')), /directory does not exist/);
  mkdirSync(join(dir, 'folder.json'));
  assert.throws(() => checkOutputTarget(join(dir, 'folder.json')), /already exists/);
});

test('authored scene: deterministic, bounded, a fixed floor first, valid shapes and unit rotations', () => {
  for (const n of [1, 12, TRACK_LIMITS.maxBodies - 1]) {
    const scene = authoredScene(n);
    assert.equal(scene.length, n + 1);
    assert.ok(scene.length <= TRACK_LIMITS.maxBodies);
    assert.deepEqual(scene.map(b => b.fixed), [true, ...Array(n).fill(false)]);
    for (const b of scene) {
      assert.ok(b.size.every(v => v > 0 && v <= TRACK_LIMITS.maxSize));
      assert.ok(Math.abs(Math.hypot(...b.rotation) - 1) < 1e-12);
      assert.ok([...b.position].every(v => Number.isFinite(v) && Math.abs(v) < 100));
      if (b.shape === 'sphere') assert.ok(b.size[0] === b.size[1] && b.size[1] === b.size[2]);
    }
  }
  assert.deepEqual(authoredScene(12), authoredScene(12));
});

const cli = (args: string[], blockGpu = true) => {
  const hooks = encodeURIComponent('export async function resolve(s,c,n){if(s==="webgpu")throw new Error("GPU-MODULE-REQUESTED");return n(s,c)}');
  const block = encodeURIComponent(`import{register}from"node:module";register("data:text/javascript,${hooks}")`);
  return spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', ...(blockGpu ? ['--import', `data:text/javascript,${block}`] : []), 'examples/pose-capture.ts', ...args],
    { encoding: 'utf8', timeout: 60_000, cwd: new URL('..', import.meta.url) });
};

test('CLI: --help and every refusal exit before any GPU module is requested, print nothing to stdout but help, and write nothing', () => {
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^Usage: pose-capture --out/);
  const existing = join(dir, 'existing.json');
  writeFileSync(existing, 'keep');
  for (const args of [[], ['--out', join(dir, 'a.txt')], ['--out', join(dir, 'b.json'), '--steps', '301'], ['--out', join(dir, 'c.json'), '--bodies', '64'],
    ['--out', existing], ['--out', join(dir, 'nodir', 'd.json')], ['--out', join(dir, 'e.json'), '--software']]) {
    const r = cli(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.doesNotMatch(r.stderr, /GPU-MODULE-REQUESTED/, 'refused before the GPU module was requested');
    assert.ok(!r.stderr.includes(dir) && !/\/Users\//.test(r.stderr), 'no local path in the message');
  }
  assert.equal(existsSync(join(dir, 'a.txt')) || existsSync(join(dir, 'b.json')) || existsSync(join(dir, 'e.json')), false);
  assert.equal(readFileSync(existing, 'utf8'), 'keep', 'the existing file is untouched');
});

test('CLI: a valid configuration reaches GPU acquisition only after validation, and a missing GPU module is a GPU refusal that writes nothing', () => {
  const out = join(dir, 'gpu.json');
  const r = cli(['--out', out, '--steps', '3']);
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /webgpu \(Dawn\) package could not be loaded: nothing captured/);
  assert.equal(r.stdout, '');
  assert.equal(existsSync(out), false);
});
