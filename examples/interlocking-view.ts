// Common rendering/interaction shell. Engine-specific construction stays in the two public-API models.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { INTERLOCKING, ringMassProperties, type RingPieces } from '../src/comparison/interlocking-scene.ts';
import type { AvbdPose } from '../src/comparison/interlocking-avbd.ts';
import { DisposableScope, createStudySlot, runFixedSteps } from './interlocking-rapier-lifecycle.ts';

declare const __COMPARISON_BUILD__: object;
const isAvbd = document.body.dataset.engine === 'avbd';
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'), view = element('view');
const play = element<HTMLButtonElement>('play'), push = element<HTMLButtonElement>('push');
const resetButton = element<HTMLButtonElement>('reset'), save = element<HTMLButtonElement>('export');
const pieces = element<HTMLSelectElement>('pieces');
const buttons = (enabled: boolean) => {
  play.disabled = push.disabled = resetButton.disabled = save.disabled = !enabled;
  pieces.disabled = !enabled || isAvbd;
};
interface Study {
  label: string; engine: object; step(): void; push(): void; dispose(): void;
  readPoses(): Promise<{ step: number; poses: AvbdPose[] }>;
}
let device: GPUDevice;
const slot = createStudySlot<Study>(async () => {
  if (isAvbd) {
    const { createAvbdInterlocking } = await import('../src/comparison/interlocking-avbd.ts');
    const model = await createAvbdInterlocking({ device });
    return { ...model, label: 'three-avbd source · analytic torus SDFs', engine: model.metadata };
  }
  const { createRapierInterlocking } = await import('../src/comparison/interlocking-rapier.ts');
  const model = await createRapierInterlocking(Number(pieces.value) as RingPieces);
  let step = 0;
  return { ...model, label: `Rapier ${model.version} · ${model.pieces * 2 + 2} colliders`,
    engine: { name: 'rapier', version: model.version, piecesPerRing: model.pieces, sleeping: false, ccd: false },
    step() { model.step(); step++; }, async readPoses() { return { step, poses: model.poses() }; } };
});
const listeners = new AbortController();
const scope = new DisposableScope(error => console.error('Late teardown step failed', error));
let releasedByPageHide = false, paused = true, accumulator = 0, previous: number | null = null;
let steps = 0, pushes = 0, droppedSeconds = 0, frameBusy = false;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function dispose() {
  if (scope.disposed) return;
  listeners.abort(); slot.close(); buttons(false);
  void scope.dispose().then(errors => errors.forEach(error => console.error('Teardown step failed', error)));
}
addEventListener('pagehide', () => { releasedByPageHide = true; dispose(); }, { signal: listeners.signal });
addEventListener('pageshow', event => {
  if (event.persisted && releasedByPageHide) status.textContent = 'Resources were released when the page was hidden. Reload to reconstruct the study.';
});

try {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter. Use a hardware WebGPU browser on localhost or HTTPS.');
  const info = adapter.info;
  if (info.isFallbackAdapter || /swiftshader|llvmpipe|softpipe/i.test([info.vendor, info.architecture, info.device, info.description].join(' '))) {
    throw new Error('Software graphics adapter refused for this comparison study.');
  }
  device = await adapter.requestDevice({ requiredLimits: { maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } });
  scope.add(() => device.destroy());
  void device.lost.then(reason => {
    if (scope.disposed) return;
    status.textContent = `Graphics device lost: ${reason.message}. Authored inputs remain; reload explicitly to reconstruct, not restore live state.`;
    dispose();
  });
  if (scope.disposed) throw new Error('Page closed during device initialization');
  const renderer = new THREE.WebGPURenderer({ antialias: true, device });
  scope.add(() => renderer.domElement.remove());
  scope.add(() => renderer.init().then(() => renderer.dispose(), () => undefined));
  await renderer.init();
  if (scope.disposed) throw new Error('Page closed during renderer initialization');
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) throw new Error('Three.js WebGL2 fallback refused: this study requires WebGPU rendering.');
  view.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100); camera.position.set(5, 4, 7);
  const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 2, 0); controls.update();
  scope.add(() => controls.dispose());
  scene.add(new THREE.HemisphereLight(0xffffff, 0x34435e, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(4, 8, 5); scene.add(light);
  const material = (color: number) => { const value = new THREE.MeshStandardNodeMaterial({ color, roughness: .45 }); scope.add(() => value.dispose()); return value; };
  const geometry = <T extends THREE.BufferGeometry>(value: T) => { scope.add(() => value.dispose()); return value; };
  const floor = new THREE.Mesh(geometry(new THREE.BoxGeometry(...INTERLOCKING.floor.halfExtents.map(v => v * 2))), material(0x283746)); floor.position.set(...INTERLOCKING.floor.position);
  const peg = new THREE.Mesh(geometry(new THREE.CylinderGeometry(INTERLOCKING.peg.radius, INTERLOCKING.peg.radius, INTERLOCKING.peg.halfLength * 2, 24)), material(0x99aabb));
  peg.position.set(...INTERLOCKING.peg.position); peg.rotation.x = Math.PI / 2;
  const shape = geometry(new THREE.TorusGeometry(INTERLOCKING.majorRadius, INTERLOCKING.minorRadius, 16, 96));
  const rings = [new THREE.Mesh(shape, material(0xe0b15b)), new THREE.Mesh(shape, material(0x67bdd5))]; scene.add(floor, peg, ...rings);
  const resize = () => {
    if (scope.disposed) return;
    const width = Math.max(1, view.clientWidth), height = Math.max(1, view.clientHeight);
    renderer.setPixelRatio(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 2) : 1);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
  };
  const sync = async (study: Study) => {
    const result = await study.readPoses();
    if (scope.disposed || slot.current !== study) return;
    result.poses.forEach((pose, i) => { rings[i].position.copy(pose.position); rings[i].quaternion.copy(pose.rotation); });
  };
  async function reset() {
    if (slot.busy || scope.disposed) return;
    buttons(false); paused = true; play.textContent = 'Play';
    previous = null; accumulator = 0; steps = pushes = droppedSeconds = 0;
    if (await slot.reset() !== 'ready') return;
    const study = slot.current!; await sync(study);
    if (scope.disposed || slot.current !== study) return;
    status.textContent = `${study.label} · ${ringMassProperties().mass.toFixed(3)} kg/ring\nGraphics: ${info.vendor || 'unknown vendor'} ${info.architecture || ''} · use Play/Pause. No benchmark measured.`;
    buttons(true);
  }
  play.addEventListener('click', () => { paused = !paused; previous = null; accumulator = 0; play.textContent = paused ? 'Play' : 'Pause'; }, { signal: listeners.signal });
  push.addEventListener('click', () => { if (slot.current) { slot.current.push(); pushes++; } }, { signal: listeners.signal });
  const resetFromUi = () => { void reset().catch(error => {
    if (scope.disposed) return;
    status.textContent = `Reset failed: ${message(error)}. State is unreliable; press Reset to reconstruct.`;
    buttons(false); resetButton.disabled = false; pieces.disabled = isAvbd;
  }); };
  resetButton.addEventListener('click', resetFromUi, { signal: listeners.signal });
  pieces.addEventListener('change', resetFromUi, { signal: listeners.signal });
  document.addEventListener('visibilitychange', () => { paused = true; play.textContent = 'Play'; previous = null; accumulator = 0; }, { signal: listeners.signal });
  addEventListener('resize', resize, { signal: listeners.signal });
  save.addEventListener('click', () => { void (async () => {
    const study = slot.current; if (!study) return;
    paused = true; play.textContent = 'Play'; previous = null; accumulator = 0;
    const result = await study.readPoses();
    if (scope.disposed || slot.current !== study) return;
    const record = { schema: 1, observedAt: new Date().toISOString(), source: __COMPARISON_BUILD__, engine: study.engine,
      authored: INTERLOCKING, massProperties: ringMassProperties(), steps, pushes, droppedSeconds, physicsStep: result.step, poses: result.poses,
      graphics: { vendor: info.vendor, architecture: info.architecture, device: info.device, fallback: info.isFallbackAdapter,
        width: view.clientWidth, height: view.clientHeight, pixelRatio: renderer.getPixelRatio(), userAgent: navigator.userAgent },
      limits: ['Observation only, no performance or physical-quality acceptance', 'Shared CPU pose-sync rendering; AVBD GPU-resident BodyMesh path not measured', 'Not a restorable GPU/physics snapshot'] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `interlocking-${isAvbd ? 'avbd' : 'rapier'}-observation.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  })().catch(error => { if (!scope.disposed) status.textContent = `Observation failed: ${message(error)}`; }); }, { signal: listeners.signal });
  await reset();
  if (!scope.disposed) {
    resize(); scope.add(() => renderer.setAnimationLoop(null));
    await renderer.setAnimationLoop(now => {
      if (frameBusy || scope.disposed || document.hidden || !Number.isFinite(now)) { if (document.hidden) previous = null; return; }
      frameBusy = true;
      const study = slot.current;
      let rendering = false;
      void (async () => {
        const delta = previous === null ? 0 : Math.max(0, (now - previous) / 1000); previous = now;
        if (study && !paused) {
          const frame = runFixedSteps(accumulator, delta, INTERLOCKING.dt, 4, () => study.step());
          accumulator = frame.accumulator; steps += frame.steps; droppedSeconds += frame.droppedSeconds;
          if ('error' in frame) throw frame.error;
          await sync(study);
        }
        if (!scope.disposed) { rendering = true; renderer.render(scene, camera); }
      })().catch(error => {
        if (scope.disposed || slot.current !== study) return;
        if (rendering) {
          status.textContent = `Renderer failed: ${message(error)}. Resources released; reload explicitly to reconstruct.`;
          dispose(); return;
        }
        paused = true; play.textContent = 'Play'; play.disabled = push.disabled = save.disabled = true;
        status.textContent = `Simulation/render failed: ${message(error)}. State is unreliable; press Reset to reconstruct.`;
      }).finally(() => { frameBusy = false; });
    });
  }
} catch (error) {
  if (!scope.disposed) status.textContent = `Study could not start: ${message(error)}`;
  dispose();
}
