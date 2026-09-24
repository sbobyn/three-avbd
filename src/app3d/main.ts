// 3D AVBD demo app: scene picker, solver parameters, orbit camera, mouse drag and box
// shooting, mirroring the controls of the upstream avbd-demo3d.

import GUI from 'lil-gui';
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGpuSim3D, GpuSim3D } from '../avbd3d/gpu/sim.ts';
import { gpuParams3D, PHASES } from '../avbd3d/gpu/solver.ts';
import { DEFAULT_SCENE } from '../avbd3d/ref/scenes.ts';
import { allScenes3D, along, createSim3D, type Sim3D, sceneByName3D } from '../avbd3d/sim.ts';
import { Renderer3D } from './renderer3d.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

if (!('gpu' in navigator)) {
  hud.textContent = 'WebGPU is not available in this browser; rendering falls back to WebGL2.';
}

// Ask for the adapter's full storage-binding size, as the 2D app does, for large GPU scenes
const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
const renderer = new Renderer3D(
  canvas,
  adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } : undefined,
);
await renderer.init();

type Backend3D = 'ref' | 'gpu';
const BACKENDS: Record<Backend3D, string> = { ref: 'Reference (CPU)', gpu: 'WebGPU' };
const url = new URL(location.href);
const sceneNames = allScenes3D.map((s) => s.name);
const backendParam = url.searchParams.get('backend');
const state = {
  scene: sceneNames.includes(url.searchParams.get('scene') ?? '') ? url.searchParams.get('scene')! : DEFAULT_SCENE,
  backend: (backendParam === 'gpu' ? 'gpu' : 'ref') as Backend3D,
  paused: url.searchParams.has('paused'),
  boxFriction: 0.5,
  boxSize: { x: 1, y: 1, z: 1 },
  boxVelocity: 10,
  showContacts: true,
  showJoints: true,
  // Shadow maps redraw every body again each frame; off helps older GPUs with big scenes
  shadows: url.searchParams.get('shadows') !== '0',
};
/** Solver parameters owned by the app, copied into the solver before every step. */
const params = gpuParams3D();
const defaults = () => ({ ...gpuParams3D(), matchNearest: state.backend === 'gpu', faceBias: state.backend === 'gpu' });
Object.assign(params, defaults());

// The demo's orbit camera: distance 50, azimuth 90°, elevation 0.35 rad, looking at (0, 0, 5)
const camera = renderer.camera;
const controls = new OrbitControls(camera); // connected below, after our pointer handlers
controls.mouseButtons.MIDDLE = null; // middle click shoots a box, as in the demo
controls.enableDamping = true;
controls.dampingFactor = 0.15;

function resetCamera(): void {
  const view = sceneByName3D(state.scene).camera;
  const distance = view?.distance ?? 50;
  const azimuth = ((view?.azimuth ?? 90) * Math.PI) / 180;
  const elevation = view?.elevation ?? 0.35;
  const [tx, ty, tz] = view?.target ?? [0, 0, 5];
  controls.target.set(tx, ty, tz);
  camera.position.set(
    tx + distance * Math.cos(elevation) * Math.cos(azimuth),
    ty + distance * Math.cos(elevation) * Math.sin(azimuth),
    tz + distance * Math.sin(elevation),
  );
  controls.update();
}

function buildSim(): Sim3D {
  if (state.backend !== 'gpu' && sceneByName3D(state.scene).gpuOnly) {
    state.backend = 'gpu';
    Object.assign(params, defaults());
  }
  if (state.backend === 'gpu') {
    const device = renderer.device;
    if (device) return createGpuSim3D(device, state.scene, params, (n) => renderer.attachGpuBodies(n));
    hud.textContent = 'The WebGPU solver needs a WebGPU device; falling back to the CPU solver.';
    state.backend = 'ref';
    if (sceneByName3D(state.scene).gpuOnly) state.scene = DEFAULT_SCENE;
  }
  renderer.detachGpuBodies();
  return createSim3D(state.scene, params);
}

/** Built by the first loadScene() at the bottom. */
let sim!: Sim3D;

function loadScene(reset = true): void {
  endDrag();
  if (sim instanceof GpuSim3D) sim.destroy();
  sim = buildSim();
  if (reset) resetCamera();
  url.searchParams.set('scene', state.scene);
  url.searchParams.set('backend', state.backend);
  history.replaceState(null, '', url);
}

// --- GUI -------------------------------------------------------------------------------

const refreshGui = () => gui.controllersRecursive().forEach((c) => c.updateDisplay());
const gui = new GUI({ title: 'AVBD 3D' });
gui.add(state, 'scene', sceneNames).name('Scene').listen().onChange(() => loadScene());
gui
  .add(state, 'backend', Object.fromEntries(Object.entries(BACKENDS).map(([k, v]) => [v, k])))
  .name('Solver')
  .listen()
  .onChange(() => {
    Object.assign(params, defaults());
    refreshGui();
    loadScene(false);
  });
gui.add({ reset: () => loadScene(false) }, 'reset').name('Reset scene');
gui.add({ defaults: () => (Object.assign(params, defaults()), refreshGui()) }, 'defaults').name('Default params');
gui.add(state, 'paused').name('Pause').listen();
gui.add({ step: () => stepOnce() }, 'step').name('Step once');
gui.add({ shoot: () => shootBox() }, 'shoot').name('Shoot box (B)');
gui.add({ view: () => resetCamera() }, 'view').name('Reset camera');
gui.add({ open2d: () => (location.href = '/') }, 'open2d').name('Open 2D demo');

const box = gui.addFolder('Shot box');
box.add(state, 'boxFriction', 0, 2).name('Friction');
box.add(state.boxSize, 'x', 0.1, 5).name('Size x');
box.add(state.boxSize, 'y', 0.1, 5).name('Size y');
box.add(state.boxSize, 'z', 0.1, 5).name('Size z');
box.add(state, 'boxVelocity', 0, 40).name('Velocity');
box.close();

const solverFolder = gui.addFolder('Solver');
solverFolder.add(params, 'gravity', -20, 20).name('Gravity');
solverFolder.add(params, 'dt', 0.001, 0.1).name('Dt');
solverFolder.add(params, 'iterations', 1, 50, 1).name('Iterations');
solverFolder.add(params, 'alpha', 0, 1).name('Alpha');
solverFolder.add(params, 'betaLin', 0, 100000).name('Beta linear');
solverFolder.add(params, 'betaAng', 0, 1000).name('Beta angular');
solverFolder.add(params, 'gamma', 0, 1).name('Gamma');
solverFolder.add(params, 'matchNearest').name('Nearest warm start (GPU)');
solverFolder.add(params, 'faceBias').name('Face-biased SAT (GPU)');

const view = gui.addFolder('View');
view.add(state, 'showContacts').name('Contacts');
view.add(state, 'showJoints').name('Joints / springs');
view.add(state, 'shadows').name('Shadows');

// --- Input -----------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let drag: { local: [number, number, number]; distance: number; target: Float64Array } | null = null;

function mouseRay(e: PointerEvent): THREE.Ray {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray;
}
const arr = (v: THREE.Vector3): [number, number, number] => [v.x, v.y, v.z];

function endDrag(): void {
  if (sim) sim.endDrag();
  drag = null;
  controls.enabled = true;
}

/** Spawn a box in front of the eye along `dir`, moving along it (the demo's shootBox). */
function shootBox(dir?: THREE.Vector3): void {
  const forward = dir ?? controls.target.clone().sub(camera.position).normalize();
  const size = [state.boxSize.x, state.boxSize.y, state.boxSize.z];
  const offset = 2 + 0.5 * Math.hypot(size[0], size[1], size[2]);
  const position = camera.position.clone().addScaledVector(forward, offset);
  sim.addBox(size, 1, state.boxFriction, arr(position), arr(forward.clone().multiplyScalar(state.boxVelocity)));
}

// Registered before OrbitControls sees the event: grabbing a body disables orbiting
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    shootBox(mouseRay(e).direction.clone());
    return;
  }
  if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey) return;
  const ray = mouseRay(e);
  const origin = arr(ray.origin);
  const dir = arr(ray.direction);
  const hit = sim.pick(origin, dir);
  if (!hit) return;
  controls.enabled = false;
  const target = along(origin, dir, Math.max(hit.t, 0.1));
  drag = { local: hit.local, distance: Math.max(hit.t, 0.1), target };
  sim.startDrag(hit.body, hit.local, target);
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const ray = mouseRay(e);
  drag.target = along(arr(ray.origin), arr(ray.direction), drag.distance);
  sim.moveDrag(drag.target);
});
canvas.addEventListener('pointerup', () => drag && endDrag());
canvas.addEventListener('pointercancel', () => drag && endDrag());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'KeyP') state.paused = !state.paused;
  if (e.code === 'KeyR') loadScene(false);
  if (e.code === 'KeyB') shootBox();
  if (e.code === 'Period' && state.paused) stepOnce();
});

// OrbitControls listens after us, so a grab can disable it before it starts orbiting
controls.connect(canvas);

// --- Loop ------------------------------------------------------------------------------

function resize(): void {
  renderer.resize(canvas.clientWidth, canvas.clientHeight);
}
window.addEventListener('resize', resize);
resize();

let accumulator = 0;
let last = performance.now();
let stepMs = 0;
let frames = 0;
let fpsTime = last;
let fps = 0;

function stepOnce(): void {
  Object.assign(sim.params, params);
  const t0 = performance.now();
  sim.step();
  stepMs = stepMs * 0.9 + (performance.now() - t0) * 0.1;
}

const anchor = new THREE.Vector3();
const q = new THREE.Quaternion();

function frame(now: number): void {
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  controls.update();

  // Fixed-timestep stepping in real time; cap the catch-up so slow scenes degrade to slow
  // motion instead of a spiral of death.
  if (!state.paused) {
    accumulator += elapsed;
    let steps = 0;
    while (accumulator >= params.dt && steps < 4) {
      stepOnce();
      accumulator -= params.dt;
      steps++;
    }
    if (steps === 4) accumulator = 0;
  }

  renderer.showContacts = state.showContacts;
  renderer.showJoints = state.showJoints;
  renderer.shadows = state.shadows;
  renderer.selected = sim.dragBody;
  renderer.dragLine = null;
  if (drag && sim.dragBody >= 0) {
    const i = sim.dragBody;
    const o = sim.orientation(i);
    const p = sim.position(i);
    anchor.set(...drag.local).applyQuaternion(q.set(o[0], o[1], o[2], o[3])).add(new THREE.Vector3(p[0], p[1], p[2]));
    renderer.dragLine = [arr(anchor), drag.target];
  }
  renderer.render(sim, controls.target);

  frames++;
  if (now - fpsTime > 500) {
    fps = (frames * 1000) / (now - fpsTime);
    frames = 0;
    fpsTime = now;
    updateHud();
  }
  requestAnimationFrame(frame);
}

function updateHud(): void {
  const st = sim.stats();
  const gpu = sim instanceof GpuSim3D ? sim : null;
  const gs = gpu?.stats();
  const profile = gpu?.profile;
  hud.textContent = [
    `${sim.label} · ${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} render · ${fps.toFixed(0)} fps · ` +
      (gs?.gpuStepMs === undefined ? `step ${stepMs.toFixed(2)} ms` : `GPU step ~${gs.gpuStepMs.toFixed(2)} ms (encode ${stepMs.toFixed(2)} ms)`),
    `bodies ${sim.bodyCount} · joints ${st.joints} · contacts ${st.contacts}` + (gs ? ` · colours ${gs.colors} (clashes ${gs.clashes})` : ''),
    `KE ${st.kineticEnergy.toFixed(3)} · max joint error ${st.maxJointError.toExponential(2)}`,
    ...(profile ? [`GPU phases: ${PHASES.map((ph) => `${ph} ${profile[ph].toFixed(2)}`).join(' · ')} ms`] : []),
    'drag body: left · orbit: left drag · pan: right drag · zoom: wheel · shoot: middle click / B · P pause · R reset',
  ].join('\n');
}

loadScene();
requestAnimationFrame(frame);

// Exposed for debugging and automated checks
function setScene(name: string, backend: Backend3D = state.backend): void {
  if (backend !== state.backend) {
    state.backend = backend;
    Object.assign(params, defaults());
  }
  state.scene = name;
  loadScene();
}
Object.assign(window, { sim: () => sim, camera, controls, state, params, setScene, stepOnce, shootBox });
