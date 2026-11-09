// Startup for the examples that draw with Three.js: say why one could not start, and release only
// what it had created by then. Examples-only; the library never destroys a renderer or device you pass.
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

/**
 * Wrap an example's setup in try / catch (error) { await startup.fail(error); } and register what it creates with
 * `own`. On failure the status line shows the error and the registered resources are released in reverse order
 * (register the renderer first, so a World is destroyed before it). A failing release is logged, never shown in
 * place of the original error.
 */
export function startExample(status: HTMLElement) {
  const scope = new DisposableScope(error => console.error('Cleanup after failed startup:', error));
  return {
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
  };
}
