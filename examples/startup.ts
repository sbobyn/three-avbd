// Startup and failure handling for the examples that draw with Three.js: say why one could not start, or why
// it stopped later, and release only what it had created by then. Examples-only; the library never destroys a
// renderer or device you pass.
import { DisposableScope } from './interlocking-rapier-lifecycle.ts';

/** The parts of a renderer that cleanup needs (a THREE.WebGPURenderer satisfies it). */
interface RendererLike { readonly initialized: boolean; readonly domElement: { remove(): void }; dispose(): unknown }

export function requireWebGpu() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a hardware WebGPU browser on localhost or HTTPS.');
}

/**
 * Removes the canvas and, if init() finished, disposes the renderer. Disposing a renderer whose init() failed would retry initialization.
 * Partial backend initialization is managed by Three.js; this helper does not certify its internal cleanup.
 */
export function releaseRenderer(renderer: RendererLike) {
  renderer.domElement.remove();
  return renderer.initialized ? renderer.dispose() : undefined;
}

/** The part of a renderer that animate() drives (a THREE.WebGPURenderer satisfies it). */
interface LoopHost { setAnimationLoop(callback: ((time: number) => void) | null): unknown }

/**
 * Wrap an example's setup in try / catch (error) { await startup.fail(error); } and register what it creates with
 * `own`. On failure the status line shows the error and the registered resources are released in reverse order
 * (register the renderer first, so a World is destroyed before it). A failing release is logged, never shown in
 * place of the original error.
 */
export function startExample(status: HTMLElement) {
  const scope = new DisposableScope(error => console.error('Cleanup after failed startup:', error));
  /**
   * A failure after startup: say so once and release what the example owns. Disposing the scope is the once-only
   * gate, so later frame or read failures are only logged. The status line is written first, so a cleanup that
   * throws or hangs cannot hide the original error.
   */
  const stop = async (error: unknown) => {
    if (scope.disposed) { console.error('Ignored after the example stopped:', error); return; }
    console.error(error);
    status.setAttribute('role', 'alert');
    status.textContent = `Stopped: ${error instanceof Error ? error.message : String(error)}. The simulation is no longer running; reload the page to restart.`;
    for (const cleanup of await scope.dispose()) console.error('Cleanup after runtime failure:', cleanup);
  };
  return {
    get stopped() { return scope.disposed; },
    own<T>(resource: T, release: (resource: T) => unknown): T {
      scope.add(() => release(resource));
      return resource;
    },
    async fail(error: unknown) {
      console.error(error);
      status.setAttribute('role', 'alert'); // the status line is not live while running: it updates several times a second
      status.textContent = `Could not start: ${error instanceof Error ? error.message : String(error)}`;
      for (const cleanup of await scope.dispose()) console.error('Cleanup after failed startup:', cleanup);
    },
    /**
     * Runs `frame` as the renderer's animation loop. If a frame throws, the loop is stopped first, then the owned
     * resources are released (register the renderer, then the World, before calling this), and the status line says the
     * simulation stopped. Frames that were already queued do nothing. A rejected setup propagates to startup.fail().
     */
    async animate(renderer: LoopHost, frame: (time: number) => void) {
      await renderer.setAnimationLoop(time => {
        if (scope.disposed) return;
        try { frame(time); } catch (error) { void stop(error); }
      });
      scope.add(() => renderer.setAnimationLoop(null));
    },
    /** Watches an asynchronous step (a readback and what follows it) so its rejection stops the example instead of going unhandled. */
    guard(pending: PromiseLike<unknown>) {
      pending.then(undefined, error => { void stop(error); });
    },
  };
}
