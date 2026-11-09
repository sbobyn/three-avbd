import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createRapierInterlocking } from '../src/comparison/interlocking-rapier.ts';
import { INTERLOCKING, ringMassProperties, type RingPieces } from '../src/comparison/interlocking-scene.ts';

declare const __COMPARISON_BUILD__: object;
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element('status'), view = element('view');
const play = element<HTMLButtonElement>('play'), push = element<HTMLButtonElement>('push');
const resetButton = element<HTMLButtonElement>('reset'), save = element<HTMLButtonElement>('export');
const pieces = element<HTMLSelectElement>('pieces');
const listeners = new AbortController();
let renderer: THREE.WebGPURenderer | undefined, device: GPUDevice | undefined, controls: OrbitControls | undefined;
let study: Awaited<ReturnType<typeof createRapierInterlocking>> | undefined;
let disposed = false, resetting = false, paused = true, accumulator = 0, previous: number | null = null;
let steps = 0, pushes = 0, droppedSeconds = 0;
const owned: { dispose(): void }[] = [];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function dispose() {
  if (disposed) return;
  disposed = true;
  listeners.abort();
  renderer?.setAnimationLoop(null);
  controls?.dispose(); study?.dispose();
  for (const resource of owned) resource.dispose();
  renderer?.dispose(); renderer?.domElement.remove(); device?.destroy();
}
addEventListener('pagehide', dispose, { signal: listeners.signal });

try {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error('No WebGPU adapter. Use a hardware WebGPU browser on localhost or HTTPS.');
  const info = adapter.info;
  if (info.isFallbackAdapter || /swiftshader|llvmpipe|softpipe/i.test([info.vendor, info.architecture, info.device, info.description].join(' '))) {
    throw new Error('Software graphics adapter refused for this comparison study.');
  }
  device = await adapter.requestDevice();
  if (disposed) { device.destroy(); throw new Error('Page closed during device initialization'); }
  renderer = new THREE.WebGPURenderer({ antialias: true, device });
  await renderer.init();
  if (disposed) { renderer.dispose(); throw new Error('Page closed during renderer initialization'); }
  view.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
  camera.position.set(5, 4, 7);
  controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 2, 0); controls.update();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x34435e, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(4, 8, 5); scene.add(light);
  const material = (color: number) => { const value = new THREE.MeshStandardNodeMaterial({ color, roughness: .45 }); owned.push(value); return value; };
  const geometry = <T extends THREE.BufferGeometry>(value: T) => { owned.push(value); return value; };
  const floor = new THREE.Mesh(geometry(new THREE.BoxGeometry(...INTERLOCKING.floor.halfExtents.map(value => value * 2))), material(0x283746)); floor.position.set(...INTERLOCKING.floor.position);
  const peg = new THREE.Mesh(geometry(new THREE.CylinderGeometry(INTERLOCKING.peg.radius, INTERLOCKING.peg.radius, INTERLOCKING.peg.halfLength * 2, 24)), material(0x99aabb));
  peg.position.set(...INTERLOCKING.peg.position); peg.rotation.x = Math.PI / 2;
  const shape = geometry(new THREE.TorusGeometry(INTERLOCKING.majorRadius, INTERLOCKING.minorRadius, 16, 96));
  const rings = [new THREE.Mesh(shape, material(0xe0b15b)), new THREE.Mesh(shape, material(0x67bdd5))];
  scene.add(floor, peg, ...rings);
  const buttons = (enabled: boolean) => { play.disabled = push.disabled = resetButton.disabled = save.disabled = !enabled; pieces.disabled = !enabled; };
  const resize = () => {
    if (!renderer) return;
    const width = Math.max(1, view.clientWidth), height = Math.max(1, view.clientHeight);
    renderer.setPixelRatio(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 2) : 1);
    renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix();
  };
  const sync = () => study?.poses().forEach((pose, i) => {
    rings[i].position.copy(pose.position); rings[i].quaternion.copy(pose.rotation);
  });
  async function reset() {
    if (resetting || disposed) return;
    resetting = true; buttons(false); paused = true; play.textContent = 'Play';
    study?.dispose(); study = undefined;
    previous = null; accumulator = 0; steps = pushes = droppedSeconds = 0;
    try {
      const next = await createRapierInterlocking(Number(pieces.value) as RingPieces);
      if (disposed) { next.dispose(); return; }
      study = next; sync();
      status.textContent = `Rapier ${study.version} · ${study.pieces * 2 + 2} colliders · ${ringMassProperties().mass.toFixed(3)} kg/ring\nGraphics: ${info.vendor || 'unknown vendor'} ${info.architecture || ''} · use Play/Pause. No benchmark measured.`;
      buttons(true);
    } finally { resetting = false; }
  }
  play.addEventListener('click', () => { paused = !paused; previous = null; accumulator = 0; play.textContent = paused ? 'Play' : 'Pause'; }, { signal: listeners.signal });
  push.addEventListener('click', () => { study?.push(); pushes++; }, { signal: listeners.signal });
  const resetFromUi = () => { void reset().catch(error => { status.textContent = `Reset failed: ${message(error)}`; }); };
  resetButton.addEventListener('click', resetFromUi, { signal: listeners.signal });
  pieces.addEventListener('change', resetFromUi, { signal: listeners.signal });
  document.addEventListener('visibilitychange', () => { paused = true; play.textContent = 'Play'; previous = null; accumulator = 0; }, { signal: listeners.signal });
  addEventListener('resize', resize, { signal: listeners.signal });
  save.addEventListener('click', () => {
    if (!study) return;
    const record = { schema: 1, observedAt: new Date().toISOString(), source: __COMPARISON_BUILD__,
      engine: { name: 'rapier', version: study.version, piecesPerRing: study.pieces, sleeping: false, ccd: false },
      authored: INTERLOCKING, massProperties: ringMassProperties(), steps, pushes, droppedSeconds, poses: study.poses(),
      graphics: { vendor: info.vendor, architecture: info.architecture, device: info.device, fallback: info.isFallbackAdapter,
        width: view.clientWidth, height: view.clientHeight, pixelRatio: renderer!.getPixelRatio(), userAgent: navigator.userAgent },
      limits: ['Observation only, no performance or physical-quality acceptance', 'Convex sector approximation, not exact torus collision', 'Not a restorable GPU/physics snapshot'] };
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'interlocking-rapier-observation.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, { signal: listeners.signal });
  device.lost.then(reason => { if (!disposed) { status.textContent = `Graphics device lost: ${reason.message}. Authored inputs remain; reload explicitly to reconstruct, not restore live state.`; dispose(); } });
  await reset(); resize();
  if (!disposed) renderer.setAnimationLoop(now => {
    if (disposed || !study || document.hidden || !Number.isFinite(now)) { previous = null; return; }
    const delta = previous === null ? 0 : Math.max(0, (now - previous) / 1000); previous = now;
    if (!paused) {
      accumulator += delta;
      let count = 0;
      while (accumulator >= INTERLOCKING.dt && count < 4) { study.step(); accumulator -= INTERLOCKING.dt; count++; steps++; }
      if (accumulator >= INTERLOCKING.dt) { droppedSeconds += accumulator; accumulator = 0; }
      sync();
    }
    renderer!.render(scene, camera);
  });
} catch (error) {
  status.textContent = `Study could not start: ${message(error)}`;
  dispose();
}
