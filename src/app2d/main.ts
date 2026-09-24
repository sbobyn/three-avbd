// 2D AVBD demo app: a dock with the scene picker and settings (../ui/controls.ts), mouse
// interaction and diagnostics, mirroring the controls of the upstream avbd-demo2d web demo.

import { DEFAULT_SCENE } from '../avbd2d/ref/scenes.ts';
import { createGpuSim, GpuSim } from '../avbd2d/gpu/sim.ts';
import { PHASES } from '../avbd2d/gpu/solver.ts';
import { defaultParams, parallelParams } from '../avbd2d/ref/solver.ts';
import { Controls, ICONS } from '../ui/controls.ts';
import { otherDemoUrl, sceneMenu } from '../ui/scene-menu.ts';
import { allScenes2D, type Backend2D, BACKENDS, createSim, type Sim2D, sceneByName } from '../avbd2d/sim.ts';
import { type Camera2D, Renderer2D } from './renderer2d.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

if (!('gpu' in navigator)) {
  hud.textContent = 'WebGPU is not available in this browser; rendering falls back to WebGL2.';
}

// Ask for the adapter's full storage-binding size: the large GPU scenes exceed the 128 MB default
const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }) : null;
const renderer = new Renderer2D(
  canvas,
  adapter ? { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize } : undefined,
);
await renderer.init();

const url = new URL(location.href);
const sceneNames = allScenes2D.map((s) => s.name);
const backendParam = url.searchParams.get('backend') as Backend2D | null;
const state = {
  scene: sceneNames.includes(url.searchParams.get('scene') ?? '') ? url.searchParams.get('scene')! : DEFAULT_SCENE,
  backend: backendParam && backendParam in BACKENDS ? backendParam : ('ref' as Backend2D),
  paused: url.searchParams.has('paused'),
  boxFriction: 0.5,
  boxWidth: 1,
  boxHeight: 1,
  boxVelocityX: 0,
  boxVelocityY: 0,
  showContacts: true,
  showJoints: true,
  details: false,
};
/** The demo's defaults for the demo-order backends, measured parallel defaults otherwise. */
const backendDefaults = (backend: Backend2D) => (backend === 'ref' || backend === 'soa-seq' ? defaultParams() : parallelParams());
/** Solver parameters owned by the app, copied into whichever backend is running. */
const params = backendDefaults(state.backend);
const camera: Camera2D = { x: 0, y: 5, zoom: 25 };

// The upstream demo uses one fixed camera (0, 5) at 25 px/unit; these scenes need other framing.
const sceneCameras: Record<string, Camera2D> = {
  Cards: { x: 0.7, y: 0.9, zoom: 260 },
  'Heavy Rope': { x: 15, y: 0, zoom: 12 },
  'Hanging Rope': { x: 0, y: -20, zoom: 9 },
  'Spring Ratio': { x: 14, y: 8, zoom: 25 },
  'Joint Grid': { x: 12, y: 8, zoom: 16 },
  Motor: { x: 0, y: -3, zoom: 25 },
  'Pyramid 50 (1.3k)': { x: 0, y: 10, zoom: 12 },
  'Pyramid 100 (5k)': { x: 0, y: 22, zoom: 6 },
  'Box Rain 40x25 (1k)': { x: 0, y: 15, zoom: 12 },
  'Box Rain 100x50 (5k)': { x: 0, y: 30, zoom: 5.5 },
  'Joint Lattice 64x64 (4k)': { x: 32, y: 20, zoom: 7 },
  'Wrecking Ball 100x40 (4k)': { x: -10, y: 10, zoom: 8 },
  'Pyramid 200 (20k)': { x: 0, y: 45, zoom: 2.8 },
  'Box Rain 900x100 (90k)': { x: 0, y: 60, zoom: 0.7 },
  'Wrecking Ball 400x100 (40k)': { x: -80, y: 25, zoom: 2.2 },
  'Joint Lattice 320x320 (100k)': { x: 160, y: 120, zoom: 1.6 },
  'Joint Lattice 512x512 (262k)': { x: 256, y: 180, zoom: 1 },
};

function buildSim(): Sim2D {
  if (state.backend !== 'gpu' && sceneByName(state.scene).gpuOnly) state.backend = 'gpu';
  if (state.backend === 'gpu') {
    const device = renderer.device;
    if (device) return createGpuSim(device, state.scene, params, (n) => renderer.attachGpuBodies(n));
    hud.textContent = 'The WebGPU solver needs a WebGPU device; falling back to the CPU solver.';
    state.backend = 'soa-colored';
  }
  renderer.detachGpuBodies();
  return createSim(state.backend, state.scene, params);
}

let sim: Sim2D = buildSim();

function loadScene(resetCamera = true): void {
  sim.endDrag();
  sim = buildSim();
  ui.setScene(state.scene);
  ui.refresh();
  if (resetCamera) Object.assign(camera, sceneCameras[state.scene] ?? { x: 0, y: 5, zoom: 25 });
  url.searchParams.set('scene', state.scene);
  url.searchParams.set('backend', state.backend);
  history.replaceState(null, '', url);
}

// --- Controls --------------------------------------------------------------------------

const resetParams = () => Object.assign(params, backendDefaults(state.backend));
const ui = new Controls({
  scenes: sceneMenu('2d', sceneNames),
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
  ],
  settings: [
    {
      kind: 'select',
      label: 'Solver',
      options: Object.entries(BACKENDS).map(([value, label]) => ({ label, value })),
      get: () => state.backend,
      set: (v) => {
        state.backend = v as Backend2D;
        resetParams();
        loadScene(false);
      },
    },
    { kind: 'range', label: 'Iterations', min: 1, max: 50, step: 1, get: () => params.iterations, set: (v) => (params.iterations = Math.round(v)), format: (v) => String(Math.round(v)) },
    { kind: 'range', label: 'Gravity', min: -20, max: 0, step: 0.5, get: () => params.gravity, set: (v) => (params.gravity = v), format: (v) => `${v.toFixed(1)} m/s²` },
    { kind: 'toggle', label: 'Show contacts', get: () => state.showContacts, set: (v) => (state.showContacts = v) },
    { kind: 'toggle', label: 'Show joints and springs', get: () => state.showJoints, set: (v) => (state.showJoints = v) },
    { kind: 'toggle', label: 'Detailed stats', get: () => state.details, set: (v) => (state.details = v) },
    {
      kind: 'section',
      label: 'Advanced',
      items: [
        { kind: 'action', label: 'Step once (.)', run: () => ((state.paused = true), stepOnce()) },
        { kind: 'range', label: 'Timestep', min: 1 / 240, max: 1 / 20, log: true, get: () => params.dt, set: (v) => (params.dt = v), format: (v) => `${(v * 1000).toFixed(1)} ms` },
        { kind: 'toggle', label: 'Post-stabilise (instead of alpha)', get: () => params.postStabilize, set: (v) => (params.postStabilize = v) },
        { kind: 'range', label: 'Alpha (stabilisation)', min: 0, max: 1, step: 0.01, get: () => params.alpha, set: (v) => (params.alpha = v) },
        { kind: 'range', label: 'Beta', min: 1, max: 1e6, log: true, get: () => params.beta, set: (v) => (params.beta = v) },
        { kind: 'range', label: 'Gamma (warm start)', min: 0, max: 1, step: 0.001, get: () => params.gamma, set: (v) => (params.gamma = v) },
        { kind: 'toggle', label: 'Stiffness rescale (paper Eq. 14)', get: () => params.stiffnessRescale, set: (v) => (params.stiffnessRescale = v) },
        { kind: 'toggle', label: 'Plain VBD (no dual)', get: () => params.vbd, set: (v) => (params.vbd = v) },
        { kind: 'range', label: 'VBD hard stiffness', min: 1e3, max: 1e9, log: true, get: () => params.vbdStiffness, set: (v) => (params.vbdStiffness = v) },
        { kind: 'range', label: 'Right-click box width', min: 0.1, max: 10, step: 0.1, get: () => state.boxWidth, set: (v) => (state.boxWidth = v) },
        { kind: 'range', label: 'Right-click box height', min: 0.1, max: 10, step: 0.1, get: () => state.boxHeight, set: (v) => (state.boxHeight = v) },
        { kind: 'range', label: 'Right-click box friction', min: 0, max: 2, step: 0.05, get: () => state.boxFriction, set: (v) => (state.boxFriction = v) },
        { kind: 'range', label: 'Right-click box velocity x', min: -20, max: 20, step: 0.5, get: () => state.boxVelocityX, set: (v) => (state.boxVelocityX = v) },
        { kind: 'range', label: 'Right-click box velocity y', min: -20, max: 20, step: 0.5, get: () => state.boxVelocityY, set: (v) => (state.boxVelocityY = v) },
      ],
    },
    { kind: 'action', label: 'Reset settings to defaults', run: resetParams },
  ],
});

// --- Input -----------------------------------------------------------------------------

let panning: { x: number; y: number } | null = null;
let spaceDown = false;
const keys = new Set<string>();

const worldPoint = (e: PointerEvent | WheelEvent): [number, number] => {
  const rect = canvas.getBoundingClientRect();
  return renderer.toWorld(camera, e.clientX - rect.left, e.clientY - rect.top, canvas.clientWidth, canvas.clientHeight);
};

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const mouse = worldPoint(e);
  if (e.button === 1 || (e.button === 0 && (spaceDown || e.shiftKey))) {
    panning = { x: e.clientX, y: e.clientY };
  } else if (e.button === 0) {
    const hit = sim.pick(mouse[0], mouse[1]);
    if (hit) sim.startDrag(hit.body, hit.local, mouse);
  } else if (e.button === 2) {
    sim.addBox([state.boxWidth, state.boxHeight], 1, state.boxFriction, [mouse[0], mouse[1], 0], [state.boxVelocityX, state.boxVelocityY, 0]);
  }
});
canvas.addEventListener('pointermove', (e) => {
  const mouse = worldPoint(e);
  if (panning) {
    camera.x -= (e.clientX - panning.x) / camera.zoom;
    camera.y += (e.clientY - panning.y) / camera.zoom;
    panning = { x: e.clientX, y: e.clientY };
  }
  sim.moveDrag(mouse[0], mouse[1]);
});
const endPointer = () => {
  panning = null;
  sim.endDrag();
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    // Zoom about the cursor
    const before = worldPoint(e);
    camera.zoom = Math.min(Math.max(camera.zoom * Math.pow(1.1, -e.deltaY / 100), 0.5), 5000);
    const after = worldPoint(e);
    camera.x += before[0] - after[0];
    camera.y += before[1] - after[1];
  },
  { passive: false },
);
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  keys.add(e.code);
  if (e.code === 'Space') {
    spaceDown = true;
    e.preventDefault();
  }
  if (e.code === 'KeyP') state.paused = !state.paused;
  if (e.code === 'KeyR') loadScene(false);
  if (e.code === 'Period' && state.paused) stepOnce();
  ui.refresh();
});
window.addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space') spaceDown = false;
});

function keyboardCamera(): void {
  const pan = 10 / camera.zoom;
  if (keys.has('KeyD')) camera.x += pan;
  if (keys.has('KeyA')) camera.x -= pan;
  if (keys.has('KeyW')) camera.y += pan;
  if (keys.has('KeyS')) camera.y -= pan;
  if (keys.has('KeyE')) camera.zoom *= 1.025;
  if (keys.has('KeyQ')) camera.zoom /= 1.025;
}

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

function frame(now: number): void {
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  keyboardCamera();

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
  renderer.selected = sim.dragBody;
  renderer.render(sim, camera, canvas.clientWidth, canvas.clientHeight);

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
  const profile = sim instanceof GpuSim ? sim.profile : null;
  const coloring = st.colors === undefined ? '' : ` · colours ${st.colors} (rounds ${st.colorRounds}, clashes ${st.colorConflicts})`;
  const hint = 'drag: left · box: right-click · pan: space/shift + drag · zoom: wheel · P pause · R restart';
  if (!state.details) {
    const ms = st.gpuStepMs ?? stepMs;
    hud.textContent = `${sim.bodyCount.toLocaleString('en')} bodies · ${fps.toFixed(0)} fps · ${ms.toFixed(2)} ms/step · ${sim.label}\n${hint}`;
    return;
  }
  hud.textContent = [
    `${sim.label} · ${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} render · ${fps.toFixed(0)} fps · ` +
      (st.gpuStepMs === undefined ? `step ${stepMs.toFixed(2)} ms` : `GPU step ~${st.gpuStepMs.toFixed(2)} ms (encode ${stepMs.toFixed(2)} ms)`),
    `bodies ${sim.bodyCount} · joints ${st.joints} · contacts ${st.contacts}${coloring}`,
    `KE ${st.kineticEnergy.toFixed(3)} · max joint error ${st.maxJointError.toExponential(2)}`,
    ...(profile ? [`GPU phases: ${PHASES.map((ph) => `${ph} ${profile[ph].toFixed(2)}`).join(' · ')} ms`] : []),
    hint,
  ].join('\n');
}

loadScene();
requestAnimationFrame(frame);

// Exposed for debugging and automated checks
function setScene(name: string, backend: Backend2D = state.backend): void {
  if (backend !== state.backend) Object.assign(params, backendDefaults(backend));
  state.scene = name;
  state.backend = backend;
  loadScene();
}
Object.assign(window, { sim: () => sim, camera, state, params, setScene, stepOnce });
