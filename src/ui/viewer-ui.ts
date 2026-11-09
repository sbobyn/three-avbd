// Small DOM-free rules the two viewers share (app3d/main.ts, app2d/main.ts): which key events
// are the page's shortcuts, which solver a scene can't use, and the 3D settings that depend on
// the solver. Kept free of the DOM and CSS so tests can run them in Node.

/** What a shortcut needs of a key event (a KeyboardEvent has all of it). */
export interface ShortcutEvent {
  code: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

/** What is read of the event's target (an Element has all of it). */
interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?(name: string): string | null;
  matches?(selector: string): boolean;
}

/** Where typed keys belong to the control: none of them are shortcuts. */
const TEXT_ENTRY = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
/** Controls that Space operates. */
const SPACE_TAGS = new Set(['BUTTON', 'SUMMARY']);
const SPACE_ROLES = new Set(['button', 'switch', 'checkbox', 'radio', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'tab']);

/**
 * The shortcut a key event is, as its `code` ('Space' for the space bar), or null when it
 * isn't one: a modifier is held (Cmd+R, Ctrl+P belong to the browser), the focus is in a text
 * field, select or editable text, or Space would operate the control focused from the keyboard.
 * A button focused by a click (not :focus-visible) leaves Space to the page, as before.
 */
export function shortcut(e: ShortcutEvent): string | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const t = e.target as TargetLike | null;
  if (t && ((t.tagName !== undefined && TEXT_ENTRY.has(t.tagName)) || t.isContentEditable === true)) return null;
  const space = e.code === 'Space' || e.key === ' ';
  if (space && t && operatedBySpace(t) && keyboardFocused(t)) return null;
  return space ? 'Space' : e.code;
}

function operatedBySpace(t: TargetLike): boolean {
  if (t.tagName !== undefined && SPACE_TAGS.has(t.tagName)) return true;
  const role = t.getAttribute?.('role');
  return role !== null && role !== undefined && SPACE_ROLES.has(role);
}

function keyboardFocused(t: TargetLike): boolean {
  try {
    return t.matches?.(':focus-visible') ?? true;
  } catch {
    // No :focus-visible: treat the focus as the keyboard's, so Space keeps working the control
    return true;
  }
}

/**
 * Why `solver` can't run `scene`, or null when it can: a GPU-only scene has no CPU solver,
 * and the WebGPU solver needs a device.
 */
export function solverUnavailable(solver: string, scene: { gpuOnly?: boolean }, gpuAvailable: boolean): string | null {
  if (solver === 'gpu') return gpuAvailable ? null : 'needs WebGPU';
  return scene.gpuOnly ? 'GPU-only scene' : null;
}

export type Backend3D = 'ref' | 'gpu';

/**
 * The 3D solver settings whose defaults differ by solver on purpose (GPU heuristics the
 * reference doesn't have). Switching solver sets only these, keeping every other setting.
 */
export const backendParams3D = (backend: Backend3D): { matchNearest: boolean; faceBias: boolean } => ({
  matchNearest: backend === 'gpu',
  faceBias: backend === 'gpu',
});
