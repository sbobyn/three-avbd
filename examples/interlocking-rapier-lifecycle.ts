// Device-free lifecycle helpers for the interlocking study pages. No DOM, Three.js or Rapier imports.

/**
 * Releases resources in reverse acquisition order. Every step runs even when an earlier one throws or rejects,
 * and a promise-returning step finishes before the next starts (the renderer must be gone before its device is
 * destroyed). Disposal is idempotent; a resource acquired after disposal began is released once the running disposal finishes.
 */
export class DisposableScope {
  readonly #steps: (() => unknown)[] = [];
  readonly #lateError: (error: unknown) => void;
  #done: Promise<unknown[]> | undefined;
  constructor(lateError: (error: unknown) => void = () => {}) { this.#lateError = lateError; }
  get disposed() { return this.#done !== undefined; }

  add(step: () => unknown): void {
    if (this.#done === undefined) { this.#steps.push(step); return; }
    void this.#done.then(() => settle(step)).then(errors => errors.forEach(this.#lateError));
  }

  /** Starts synchronously: steps run back to back until one returns a promise, so a pagehide handler is not deferred. */
  dispose(): Promise<unknown[]> {
    return this.#done ??= (async () => {
      const errors: unknown[] = [];
      while (this.#steps.length) {
        try {
          const result = this.#steps.pop()!();
          if (isThenable(result)) await result;
        } catch (error) { errors.push(error); }
      }
      return errors;
    })();
  }
}
const isThenable = (value: unknown): value is PromiseLike<unknown> => typeof (value as PromiseLike<unknown> | null)?.then === 'function';
async function settle(step: () => unknown): Promise<unknown[]> {
  try { await step(); return []; } catch (error) { return [error]; }
}

/**
 * Owns the single live study. A reset disposes the old study first and never overlaps another reset;
 * a study that finishes constructing after close() is disposed instead of adopted.
 */
export function createStudySlot<S extends { dispose(): void }>(create: () => Promise<S>) {
  let current: S | undefined, busy = false, closed = false;
  return {
    get current() { return current; },
    get busy() { return busy; },
    get closed() { return closed; },
    async reset(): Promise<'ready' | 'busy' | 'closed'> {
      if (busy) return 'busy';
      if (closed) return 'closed';
      busy = true;
      const previous = current;
      current = undefined;
      try {
        previous?.dispose();
        const next = await create();
        if (closed) { next.dispose(); return 'closed'; }
        current = next;
        return 'ready';
      } finally { busy = false; }
    },
    close() {
      closed = true;
      const study = current;
      current = undefined;
      study?.dispose();
    },
  };
}

export interface FixedStepResult { accumulator: number; steps: number; droppedSeconds: number; error?: unknown }

/**
 * Advances a fixed-step simulation by `delta` seconds, running at most `maxSteps` steps. Debt beyond the cap is
 * reported as dropped time rather than carried. A throwing step stops the frame: its error is returned with the
 * steps that did complete, and the accumulator is cleared so a retry cannot replay stale time.
 */
export function runFixedSteps(accumulator: number, delta: number, dt: number, maxSteps: number, step: () => void): FixedStepResult {
  accumulator += delta;
  let steps = 0;
  while (accumulator >= dt && steps < maxSteps) {
    try { step(); } catch (error) { return { accumulator: 0, steps, droppedSeconds: 0, error }; }
    accumulator -= dt; steps++;
  }
  if (accumulator >= dt) return { accumulator: 0, steps, droppedSeconds: accumulator };
  return { accumulator, steps, droppedSeconds: 0 };
}
