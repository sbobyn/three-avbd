import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allScenes2D, BACKENDS as BACKENDS_2D } from '../src/avbd2d/sim.ts';
import { allScenes3D } from '../src/avbd3d/sim.ts';
import { gpuParams3D } from '../src/avbd3d/gpu/solver.ts';
import { backendParams3D, shortcut, type ShortcutEvent, solverUnavailable } from '../src/ui/viewer-ui.ts';

/** A stand-in for an element: its tag, role, editability and whether it has keyboard focus. */
const element = (tagName: string, opts: { role?: string; editable?: boolean; focusVisible?: boolean | 'unsupported' } = {}) => ({
  tagName,
  isContentEditable: opts.editable ?? false,
  getAttribute: (name: string) => (name === 'role' ? (opts.role ?? null) : null),
  matches: (selector: string) => {
    if (selector !== ':focus-visible') throw new Error(`unexpected selector ${selector}`);
    if (opts.focusVisible === 'unsupported') throw new SyntaxError('unsupported');
    return opts.focusVisible ?? false;
  },
});
const BODY = element('BODY');
const key = (code: string, target: unknown = BODY, mods: Partial<Pick<ShortcutEvent, 'metaKey' | 'ctrlKey' | 'altKey'>> = {}): ShortcutEvent => ({
  code,
  key: code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase(),
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
  target: target as EventTarget,
});

test('the viewers’ shortcuts fire on the page', () => {
  for (const code of ['KeyP', 'KeyR', 'KeyB', 'Period', 'KeyW']) assert.equal(shortcut(key(code)), code);
  assert.equal(shortcut(key('Space')), 'Space');
  // A layout whose space bar reports only the key
  assert.equal(shortcut({ ...key('Space'), code: '' }), 'Space');
  assert.equal(shortcut(key('KeyP', null)), 'KeyP');
});

test('a held Cmd, Ctrl or Alt leaves the key to the browser (Cmd+R reloads, Ctrl+P prints)', () => {
  assert.equal(shortcut(key('KeyR', BODY, { metaKey: true })), null);
  assert.equal(shortcut(key('KeyP', BODY, { ctrlKey: true })), null);
  assert.equal(shortcut(key('KeyP', BODY, { altKey: true })), null);
  assert.equal(shortcut(key('Space', BODY, { ctrlKey: true })), null);
});

test('keys typed into a field, select or editable text are not shortcuts', () => {
  for (const tag of ['INPUT', 'SELECT', 'TEXTAREA']) {
    for (const code of ['KeyP', 'KeyR', 'Space', 'Period']) assert.equal(shortcut(key(code, element(tag))), null, `${code} in ${tag}`);
  }
  assert.equal(shortcut(key('KeyR', element('DIV', { editable: true }))), null);
});

test('Space operates a button or switch focused from the keyboard, not the page', () => {
  const focused = { focusVisible: true } as const;
  assert.equal(shortcut(key('Space', element('BUTTON', focused))), null);
  // Settings' toggles are buttons with role="switch"; a role on another element counts too
  assert.equal(shortcut(key('Space', element('BUTTON', { role: 'switch', ...focused }))), null);
  assert.equal(shortcut(key('Space', element('DIV', { role: 'switch', ...focused }))), null);
  assert.equal(shortcut(key('Space', element('SUMMARY', focused))), null);
  // Letters still work from a focused dock button (they don't operate it)
  assert.equal(shortcut(key('KeyP', element('BUTTON', focused))), 'KeyP');
  // A link isn't operated by Space
  assert.equal(shortcut(key('Space', element('A', focused))), 'Space');
});

test('a dock button focused by a click leaves Space to the page, as before', () => {
  assert.equal(shortcut(key('Space', element('BUTTON', { focusVisible: false }))), 'Space');
  // Without :focus-visible, the focus is taken as the keyboard's: the control keeps Space
  assert.equal(shortcut(key('Space', element('BUTTON', { focusVisible: 'unsupported' }))), null);
});

test('GPU-only scenes offer no CPU solver, and the WebGPU solver needs a device', () => {
  const gpuOnly3D = allScenes3D.filter((s) => s.gpuOnly);
  const cpu3D = allScenes3D.filter((s) => !s.gpuOnly);
  assert.ok(gpuOnly3D.length > 0 && cpu3D.length > 0);
  for (const s of gpuOnly3D) {
    assert.equal(solverUnavailable('ref', s, true), 'GPU-only scene', s.name);
    assert.equal(solverUnavailable('gpu', s, true), null, s.name);
  }
  for (const s of cpu3D) {
    assert.equal(solverUnavailable('ref', s, true), null, s.name);
    assert.equal(solverUnavailable('ref', s, false), null, s.name);
    assert.equal(solverUnavailable('gpu', s, false), 'needs WebGPU', s.name);
  }

  const gpuOnly2D = allScenes2D.filter((s) => s.gpuOnly);
  assert.ok(gpuOnly2D.length > 0);
  const cpuBackends = Object.keys(BACKENDS_2D).filter((b) => b !== 'gpu');
  assert.equal(cpuBackends.length, 3);
  for (const s of allScenes2D) {
    for (const b of cpuBackends) assert.equal(solverUnavailable(b, s, true), s.gpuOnly ? 'GPU-only scene' : null, `${s.name} on ${b}`);
    assert.equal(solverUnavailable('gpu', s, true), null);
    assert.equal(solverUnavailable('gpu', s, false), 'needs WebGPU');
  }
});

test('switching the 3D solver keeps edited settings and sets only its own heuristics', () => {
  // The audit's sequence (G-03): 17 iterations and -4 gravity, then Reference (CPU), then back
  const params = { ...gpuParams3D(), ...backendParams3D('gpu') };
  params.iterations = 17;
  params.gravity = -4;
  const edited = { ...params };
  Object.assign(params, backendParams3D('ref'));
  assert.equal(params.iterations, 17);
  assert.equal(params.gravity, -4);
  assert.equal(params.matchNearest, false);
  assert.equal(params.faceBias, false);
  Object.assign(params, backendParams3D('gpu'));
  assert.deepEqual(params, edited);
  // Only those two follow the solver: everything else a user can edit stays put
  assert.deepEqual(Object.keys(backendParams3D('ref')).sort(), ['faceBias', 'matchNearest']);
  assert.ok(Object.keys(backendParams3D('gpu')).every((k) => k in gpuParams3D()));
});
