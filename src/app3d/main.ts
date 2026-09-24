// 3D AVBD viewer: the site's landing page. A dock with the scene picker (the paper's showcase
// scenes first) and settings (../ui/controls.ts), orbit camera, mouse drag and box shooting as
// in the upstream avbd-demo3d, and a title card.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGpuSim3D, GpuSim3D } from '../avbd3d/gpu/sim.ts';
import { gpuParams3D, PHASES } from '../avbd3d/gpu/solver.ts';
import { DEFAULT_SCENE } from '../avbd3d/ref/scenes.ts';
import { allScenes3D, along, createSim3D, type Sim3D, sceneByName3D } from '../avbd3d/sim.ts';
import { Controls, ICONS } from '../ui/controls.ts';
import { otherDemoUrl, sceneMenu } from '../ui/scene-menu.ts';
import { Renderer3D } from './renderer3d.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const timing = document.querySelector<HTMLDivElement>('#timing')!;

// Title card, collapsed state remembered per viewer
const card = document.querySelector<HTMLDivElement>('#card')!;
const cardToggle = document.querySelector<HTMLButtonElement>('#card-toggle')!;
const CARD_KEY = 'avbd3d-card-collapsed';
const setCard = (collapsed: boolean) => {
  card.classList.toggle('collapsed', collapsed);
  cardToggle.textContent = collapsed ? '+' : '–';
  cardToggle.title = collapsed ? 'About this demo' : 'Hide';
};
const NARROW = 760;
try {
  setCard(localStorage.getItem(CARD_KEY) === '1' || window.innerWidth < NARROW);
} catch {
  setCard(window.innerWidth < NARROW);
}
cardToggle.onclick = () => {
  const collapsed = !card.classList.contains('collapsed');
  setCard(collapsed);
  try {
    localStorage.setItem(CARD_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage unavailable: the card just doesn't remember
  }
};

// Ask for the adapter's full storage-binding size, as the 2D app does, for large GPU scenes
const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null;
if (!adapter) document.querySelector<HTMLElement>('#no-webgpu')!.hidden = false;
const renderer = new Renderer3D(
  canvas,
  adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } : undefined,
);
await renderer.init();

type Backend3D = 'ref' | 'gpu';
const BACKENDS: Record<Backend3D, string> = { ref: 'Reference (CPU)', gpu: 'WebGPU' };
const url = new URL(location.href);
const gpuAvailable = renderer.device !== null;
// The paper's showcase scenes first (GPU only), then the upstream demo's scenes
const sceneNames = [...allScenes3D.filter((s) => s.gpuOnly && gpuAvailable), ...allScenes3D.filter((s) => !s.gpuOnly)].map((s) => s.name);
/** What a first visit shows: a quarter-size Fig. 1 smash, smooth on modest GPUs. */
const LANDING_SCENE = gpuAvailable ? 'Brick Ring (28k)' : DEFAULT_SCENE;
const backendParam = url.searchParams.get('backend');
const state = {
  scene: sceneNames.includes(url.searchParams.get('scene') ?? '') ? url.searchParams.get('scene')! : LANDING_SCENE,
  backend: ((backendParam ?? (gpuAvailable ? 'gpu' : 'ref')) === 'gpu' ? 'gpu' : 'ref') as Backend3D,
  paused: url.searchParams.has('paused'),
  boxFriction: 0.5,
  boxSize: { x: 1, y: 1, z: 1 },
  boxVelocity: 10,
  showContacts: false,
  showJoints: false,
  details: false,
  // Shadow maps redraw every body again each frame; off helps older GPUs with big scenes
  shadows: url.searchParams.get('shadows') !== '0',
};
/** Solver parameters owned by the app, copied into the solver before every step. */
const params = gpuParams3D();
/** The solver's defaults for the backend, with the scene's own settings (the paper's iterations). */
const defaults = () => ({
  ...gpuParams3D(),
  matchNearest: state.backend === 'gpu',
  faceBias: state.backend === 'gpu',
  ...sceneByName3D(state.scene).params,
});
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
  renderer.setViewScale(distance);
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
  if (reset) Object.assign(params, defaults());
  sim = buildSim();
  ui.setScene(state.scene);
  ui.refresh();
  if (reset) resetCamera();
  url.searchParams.set('scene', state.scene);
  url.searchParams.set('backend', state.backend);
  history.replaceState(null, '', url);
}

// --- Controls --------------------------------------------------------------------------

const toggle = (label: string, key: 'shadows' | 'showContacts' | 'showJoints' | 'details') =>
  ({ kind: 'toggle', label, get: () => state[key], set: (v: boolean) => (state[key] = v) }) as const;
const ui = new Controls({
  scenes: sceneMenu('3d', sceneNames),
  onScene: (value) => {
    const other = otherDemoUrl(value);
    if (other) {
      location.href = other;
      return;
    }
    state.scene = value;
    loadScene();
  },
  buttons: [
    { label: 'Play / pause (P)', icon: () => (state.paused ? ICONS.play : ICONS.pause), onClick: () => (state.paused = !state.paused) },
    { label: 'Restart the scene (R)', icon: ICONS.restart, onClick: () => loadScene(false) },
    { label: 'Shoot a box (B)', icon: ICONS.box, onClick: () => shootBox() },
    { label: 'Reset the camera', icon: ICONS.focus, onClick: () => resetCamera() },
  ],
  settings: [
    {
      kind: 'select',
      label: 'Solver',
      options: Object.entries(BACKENDS)
        .filter(([value]) => value !== 'gpu' || gpuAvailable)
        .map(([value, label]) => ({ label, value })),
      get: () => state.backend,
      set: (v) => {
        state.backend = v as Backend3D;
        Object.assign(params, defaults());
        loadScene(false);
      },
    },
    { kind: 'range', label: 'Iterations', min: 1, max: 30, step: 1, get: () => params.iterations, set: (v) => (params.iterations = Math.round(v)), format: (v) => String(Math.round(v)) },
    { kind: 'range', label: 'Gravity', min: -20, max: 0, step: 0.5, get: () => params.gravity, set: (v) => (params.gravity = v), format: (v) => `${v.toFixed(1)} m/s²` },
    toggle('Shadows', 'shadows'),
    toggle('Show contacts', 'showContacts'),
    toggle('Show joints and springs', 'showJoints'),
    toggle('Detailed stats', 'details'),
    {
      kind: 'section',
      label: 'Advanced',
      items: [
        { kind: 'action', label: 'Step once (.)', run: () => ((state.paused = true), stepOnce()) },
        { kind: 'range', label: 'Timestep', min: 1 / 240, max: 1 / 20, log: true, get: () => params.dt, set: (v) => (params.dt = v), format: (v) => `${(v * 1000).toFixed(1)} ms` },
        { kind: 'range', label: 'Alpha (stabilisation)', min: 0, max: 1, step: 0.01, get: () => params.alpha, set: (v) => (params.alpha = v) },
        { kind: 'range', label: 'Beta linear', min: 10, max: 1e6, log: true, get: () => params.betaLin, set: (v) => (params.betaLin = v) },
        { kind: 'range', label: 'Beta angular', min: 1, max: 1e4, log: true, get: () => params.betaAng, set: (v) => (params.betaAng = v) },
        { kind: 'range', label: 'Gamma (warm start)', min: 0, max: 1, step: 0.001, get: () => params.gamma, set: (v) => (params.gamma = v) },
        { kind: 'toggle', label: 'Nearest warm start (GPU)', get: () => params.matchNearest, set: (v) => (params.matchNearest = v) },
        { kind: 'toggle', label: 'Face-biased SAT (GPU)', get: () => params.faceBias, set: (v) => (params.faceBias = v) },
        {
          kind: 'range',
          label: 'Shot box size',
          min: 0.2,
          max: 4,
          step: 0.1,
          get: () => state.boxSize.x,
          set: (v) => Object.assign(state.boxSize, { x: v, y: v, z: v }),
          format: (v) => `${v.toFixed(1)} m`,
        },
        { kind: 'range', label: 'Shot box speed', min: 0, max: 40, step: 1, get: () => state.boxVelocity, set: (v) => (state.boxVelocity = v), format: (v) => `${v.toFixed(0)} m/s` },
      ],
    },
    { kind: 'action', label: 'Reset settings to defaults', run: () => Object.assign(params, defaults()) },
  ],
});

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
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'KeyP') state.paused = !state.paused;
  if (e.code === 'KeyR') loadScene(false);
  if (e.code === 'KeyB') shootBox();
  if (e.code === 'Period' && state.paused) stepOnce();
  ui.refresh();
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

let viewScale = 0;

function frame(now: number): void {
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  controls.update();
  // Fog, shadow range and far plane follow the zoom
  const distance = camera.position.distanceTo(controls.target);
  if (Math.abs(distance - viewScale) > viewScale * 0.05) renderer.setViewScale((viewScale = distance));

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
  ui.refresh();
  const st = sim.stats();
  const gpu = sim instanceof GpuSim3D ? sim : null;
  const gs = gpu?.stats();
  const profile = gpu?.profile;
  // The simulation's own cost per step: GPU timestamps when the device has them
  const simMs = gs?.gpuStepMs ?? (gpu ? undefined : stepMs);
  timing.innerHTML = simMs === undefined ? '' : `<b>${simMs.toFixed(1)} ms</b> <span>/ step</span>`;
  const summary = `${sim.bodyCount.toLocaleString('en')} bodies · ${fps.toFixed(0)} fps · ${gpu ? 'WebGPU solver' : 'CPU solver'}`;
  hud.textContent = state.details
    ? [
        `${sim.label} · ${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} render · ${fps.toFixed(0)} fps · ` +
          (gs?.gpuStepMs === undefined ? `step ${stepMs.toFixed(2)} ms` : `GPU step ~${gs.gpuStepMs.toFixed(2)} ms (encode ${stepMs.toFixed(2)} ms)`),
        `bodies ${sim.bodyCount} · joints ${st.joints} · contacts ${st.contacts}` + (gs ? ` · colours ${gs.colors} (clashes ${gs.clashes})` : ''),
        `KE ${st.kineticEnergy.toFixed(3)} · max joint error ${st.maxJointError.toExponential(2)} · iterations ${params.iterations}`,
        ...(profile ? [`GPU phases: ${PHASES.map((ph) => `${ph} ${profile[ph].toFixed(2)}`).join(' · ')} ms`] : []),
      ].join('\n')
    : summary;
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
