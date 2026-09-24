// 2D AVBD demo app: scene and backend picker, solver parameters, mouse interaction and
// diagnostics, mirroring the controls of the upstream avbd-demo2d web demo.

import GUI from 'lil-gui';
import { DEFAULT_SCENE } from '../avbd2d/ref/scenes.ts';
import { createGpuSim } from '../avbd2d/gpu/sim.ts';
import { defaultParams, parallelParams } from '../avbd2d/ref/solver.ts';
import { allScenes2D, type Backend2D, BACKENDS, createSim, type Sim2D, sceneByName } from '../avbd2d/sim.ts';
import { type Camera2D, Renderer2D } from './renderer2d.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;

if (!('gpu' in navigator)) {
  hud.textContent = 'WebGPU is not available in this browser; rendering falls back to WebGL2.';
}

const renderer = new Renderer2D(canvas);
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
  'Box Rain 300x300 (90k)': { x: 0, y: 180, zoom: 1.4 },
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
  if (resetCamera) Object.assign(camera, sceneCameras[state.scene] ?? { x: 0, y: 5, zoom: 25 });
  url.searchParams.set('scene', state.scene);
  url.searchParams.set('backend', state.backend);
  history.replaceState(null, '', url);
}

// --- GUI -------------------------------------------------------------------------------

const gui = new GUI({ title: 'AVBD 2D' });
gui.add(state, 'scene', sceneNames).name('Scene').listen().onChange(() => loadScene());
gui
  .add(state, 'backend', Object.fromEntries(Object.entries(BACKENDS).map(([k, v]) => [v, k])))
  .name('Solver')
  .listen()
  .onChange(() => {
    Object.assign(params, backendDefaults(state.backend));
    gui.controllersRecursive().forEach((c) => c.updateDisplay());
    loadScene(false);
  });
gui.add({ reset: () => loadScene(false) }, 'reset').name('Reset scene');
gui
  .add({ defaults: () => { Object.assign(params, backendDefaults(state.backend)); gui.controllersRecursive().forEach((c) => c.updateDisplay()); } }, 'defaults')
  .name('Default params');
gui.add(state, 'paused').name('Pause').listen();
gui.add({ step: () => stepOnce() }, 'step').name('Step once');

const spawn = gui.addFolder('Right-click box');
spawn.add(state, 'boxFriction', 0, 2).name('Friction');
spawn.add(state, 'boxWidth', 0.1, 10).name('Width');
spawn.add(state, 'boxHeight', 0.1, 10).name('Height');
spawn.add(state, 'boxVelocityX', -20, 20).name('Velocity x');
spawn.add(state, 'boxVelocityY', -20, 20).name('Velocity y');
spawn.close();

const solverFolder = gui.addFolder('Solver');
solverFolder.add(params, 'gravity', -20, 20).name('Gravity');
solverFolder.add(params, 'dt', 0.001, 0.1).name('Dt');
solverFolder.add(params, 'iterations', 1, 50, 1).name('Iterations');
solverFolder.add(params, 'postStabilize').name('Post stabilize').onChange(() => alphaCtl.show(!params.postStabilize));
const alphaCtl = solverFolder.add(params, 'alpha', 0, 1).name('Alpha').show(!params.postStabilize);
solverFolder.add(params, 'beta', 0, 1000000).name('Beta');
solverFolder.add(params, 'gamma', 0, 1).name('Gamma');

const extras = gui.addFolder('Paper extras (not in demo)');
extras.add(params, 'stiffnessRescale').name('Stiffness rescale (Eq 14)');
extras.add(params, 'vbd').name('Plain VBD (no dual)');
extras.add(params, 'vbdStiffness', 1000, 1e9).name('VBD hard stiffness');
extras.close();

const view = gui.addFolder('View');
view.add(state, 'showContacts').name('Contacts');
view.add(state, 'showJoints').name('Joints / springs');

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
  if (e.target instanceof HTMLInputElement) return;
  keys.add(e.code);
  if (e.code === 'Space') {
    spaceDown = true;
    e.preventDefault();
  }
  if (e.code === 'KeyP') state.paused = !state.paused;
  if (e.code === 'KeyR') loadScene(false);
  if (e.code === 'Period' && state.paused) stepOnce();
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
  const st = sim.stats();
  const coloring = st.colors === undefined ? '' : ` · colours ${st.colors} (rounds ${st.colorRounds}, clashes ${st.colorConflicts})`;
  hud.textContent = [
    `${sim.label} · ${renderer.isWebGPU ? 'WebGPU' : 'WebGL2'} render · ${fps.toFixed(0)} fps · ` +
      (st.gpuStepMs === undefined ? `step ${stepMs.toFixed(2)} ms` : `GPU step ~${st.gpuStepMs.toFixed(2)} ms (encode ${stepMs.toFixed(2)} ms)`),
    `bodies ${sim.bodyCount} · joints ${st.joints} · contacts ${st.contacts}${coloring}`,
    `KE ${st.kineticEnergy.toFixed(3)} · max joint error ${st.maxJointError.toExponential(2)}`,
    'drag: left · box: right-click · pan: space/shift+drag · zoom: wheel · P pause · R reset',
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
