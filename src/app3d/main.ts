// 3D AVBD viewer: the site's landing page. A dock with the scene picker (the paper's showcase
// scenes first) and settings (../ui/controls.ts), orbit camera, mouse drag as in the upstream
// avbd-demo3d (the body under the pointer is tinted), cannonballs, and a title card.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildScene3D, createGpuSim3D, GpuSim3D, NO_PAINT } from '../avbd3d/gpu/sim.ts';
import { B_POS, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import { gpuParams3D, PHASES } from '../avbd3d/gpu/solver.ts';
import { DEFAULT_SCENE } from '../avbd3d/ref/scenes.ts';
import { allScenes3D, along, createSim3D, type Sim3D, sceneByName3D } from '../avbd3d/sim.ts';
import { CUSTOM_3D } from '../avbd3d/custom.ts';
import { BuildProgress } from '../ui/build-progress.ts';
import { Controls, ICONS, openRepo } from '../ui/controls.ts';
import { adapterName, bodiesInName, confirmHeavy, deviceBudget, forgetBudget, heaviness, timeSteps, watchDeviceLoss } from '../ui/device-budget.ts';
import { titleCard } from '../ui/title-card.ts';
import { otherDemoUrl, sceneMenu } from '../ui/scene-menu.ts';
import { ScenePanel } from '../ui/scene-panel.ts';
import { WindPanel } from '../ui/wind-panel.ts';
import type { CameraView, Picture3D, SceneOptions } from '../avbd3d/bench-scenes.ts';
import { type ExtrasContext, kilograms, panelFor } from './scene-extras.ts';
import { Renderer3D } from './renderer3d.ts';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const hud = document.querySelector<HTMLDivElement>('#hud')!;
const timing = document.querySelector<HTMLDivElement>('#timing')!;

titleCard('avbd3d-card-collapsed');
const keysHint = document.querySelector<HTMLDivElement>('#keys')!;

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

/** ms per step of a Custom brick ring of about `bodies` bodies, off screen (no readbacks). */
async function probe(bodies: number): Promise<number> {
  const device = renderer.device!;
  const kind = CUSTOM_3D.findIndex((k) => k.name === 'Brick Ring');
  const sim = createGpuSim3D(device, 'Custom', { ...gpuParams3D(), ...CUSTOM_3D[kind].params }, undefined, { kind, bodies });
  sim.readbackEvery = Number.MAX_SAFE_INTEGER;
  const ms = await timeSteps(device, () => sim.step());
  sim.destroy();
  return ms;
}
/** What this device can run (measured on its first visit): see device-budget.ts. */
const budget = gpuAvailable ? await deviceBudget('3d', adapterName(adapter), probe, [4_000, 24_000, 64_000]) : null;
/** Too slow for the 28k landing scene in real time: lighter defaults (no AO, no reflections). */
const weak = budget !== null && budget.realtime < 28_000;
if (renderer.device) watchDeviceLoss('3d', renderer.device, () => state.scene);
/** A scene's size, for the budget checks (Custom: the size it will be built at). */
const sizeOf = (name: string): number =>
  name === 'Custom' ? ({ ...sceneByName3D(name).options, ...state.sceneOptions[name] }.bodies ?? 0) : bodiesInName(name);

/** What a first visit shows: a quarter-size Fig. 1 smash, or a smaller smash on a weaker GPU. */
const LANDING_SCENE = !budget ? DEFAULT_SCENE : budget.realtime >= 28_000 ? 'Brick Ring (28k)' : budget.realtime >= 2_000 ? 'Wall Smash (2k)' : DEFAULT_SCENE;
const backendParam = url.searchParams.get('backend');
const state = {
  scene: sceneNames.includes(url.searchParams.get('scene') ?? '') ? url.searchParams.get('scene')! : LANDING_SCENE,
  backend: ((backendParam ?? (gpuAvailable ? 'gpu' : 'ref')) === 'gpu' ? 'gpu' : 'ref') as Backend3D,
  paused: url.searchParams.has('paused'),
  ballRadius: 0.7,
  /** kg: 30 times a brick's density at the default radius, heavy enough to knock walls down. */
  ballMass: 43,
  ballSpeed: 45,
  /** Simulated seconds per real second (slow motion below 1). */
  speed: 1,
  /** Settings changed in scene panels, per scene (over Scene3D.options). */
  sceneOptions: {} as Record<string, SceneOptions>,
  showContacts: false,
  showJoints: false,
  details: false,
  // Shadow maps redraw every body again each frame; off helps older GPUs with big scenes
  shadows: url.searchParams.get('shadows') !== '0',
  /** Ambient occlusion (a post pass at half resolution); off by default on a weak GPU. */
  ambientOcclusion: url.searchParams.has('ao') ? url.searchParams.get('ao') !== '0' : !weak,
  /** Floor reflections (the scene drawn twice): on by default in scenes up to REFLECT_UP_TO. */
  reflections: true,
};
// A heavy scene from a link (or the other demo's menu) asks first too
if (!confirmHeavy(budget, state.scene, sizeOf(state.scene))) state.scene = LANDING_SCENE;
/** Solver parameters owned by the app, copied into the solver before every step. */
const params = gpuParams3D();
/** The solver's defaults for the backend, with the scene's own settings (the paper's iterations). */
const defaults = () => ({
  ...gpuParams3D(),
  matchNearest: state.backend === 'gpu',
  faceBias: state.backend === 'gpu',
  ...resolve(sceneByName3D(state.scene).params),
});
Object.assign(params, defaults());

// The demo's orbit camera: distance 50, azimuth 90°, elevation 0.35 rad, looking at (0, 0, 5)
const camera = renderer.camera;
const controls = new OrbitControls(camera); // connected below, after our pointer handlers
controls.mouseButtons.MIDDLE = null; // middle click shoots a box, as in the demo
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.addEventListener('start', () => (flight = null)); // a drag takes the camera back

function resetCamera(): void {
  flight = null;
  const { target, position, distance } = cameraPose(resolve(sceneByName3D(state.scene).camera));
  controls.target.copy(target);
  renderer.setViewScale(distance);
  camera.position.copy(position);
  controls.update();
}

/** Where `view` puts the camera, and what it looks at. */
function cameraPose(view: CameraView | undefined): { target: THREE.Vector3; position: THREE.Vector3; distance: number } {
  let distance = view?.distance ?? 50;
  if (view?.fit) {
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    distance = Math.max(distance, (0.54 * view.fit[0]) / (tan * camera.aspect), (0.54 * view.fit[1]) / tan);
  }
  const azimuth = ((view?.azimuth ?? 90) * Math.PI) / 180;
  const elevation = view?.elevation ?? 0.35;
  const target = new THREE.Vector3(...(view?.target ?? [0, 0, 5]));
  const offset = new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation));
  return { target, position: target.clone().addScaledVector(offset, distance), distance };
}

/** A camera move under way (flyTo): from and to as target, distance, azimuth, elevation. */
let flight: { from: number[]; to: number[]; start: number; seconds: number } | null = null;

/** The camera's orbit about its target: [tx, ty, tz, log distance, azimuth, elevation]. */
function orbitOf(target: THREE.Vector3, position: THREE.Vector3): number[] {
  const d = position.clone().sub(target);
  const distance = d.length();
  return [target.x, target.y, target.z, Math.log(distance), Math.atan2(d.y, d.x), Math.asin(d.z / distance)];
}

/** Glide the camera to `view` (a touch on the canvas stops it). */
function flyTo(view: CameraView, seconds = 3): void {
  const to = cameraPose(view);
  const from = orbitOf(controls.target, camera.position);
  const end = orbitOf(to.target, to.position);
  // The short way round
  end[4] = from[4] + ((((end[4] - from[4]) % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  flight = { from, to: end, start: performance.now(), seconds };
}

/** Move the camera along its flight, if it's on one. */
function fly(now: number): void {
  if (!flight) return;
  const t = Math.min(1, (now - flight.start) / (1000 * flight.seconds));
  const e = t * t * (3 - 2 * t);
  const [tx, ty, tz, logD, azimuth, elevation] = flight.from.map((a, i) => a + (flight!.to[i] - a) * e);
  const distance = Math.exp(logD);
  controls.target.set(tx, ty, tz);
  camera.position.set(tx + distance * Math.cos(elevation) * Math.cos(azimuth), ty + distance * Math.cos(elevation) * Math.sin(azimuth), tz + distance * Math.sin(elevation));
  if (t >= 1) flight = null;
}

/**
 * Build the current scene's sim, in stages the progress bar follows: the scene on the CPU, then
 * the GPU solver (the old sim is freed just before, in the same task). `replace` swaps the new
 * sim in; null means a newer load took over while this one waited.
 */
async function buildSim(stillWanted: () => boolean): Promise<Sim3D | null> {
  if (state.backend !== 'gpu' && sceneByName3D(state.scene).gpuOnly) {
    state.backend = 'gpu';
    Object.assign(params, defaults());
  }
  const device = state.backend === 'gpu' ? renderer.device : null;
  if (state.backend === 'gpu' && !device) {
    hud.textContent = 'The WebGPU solver needs a WebGPU device; falling back to the CPU solver.';
    state.backend = 'ref';
    if (sceneByName3D(state.scene).gpuOnly) state.scene = DEFAULT_SCENE;
  }
  const expected = sizeOf(state.scene) || 2000;
  renderer.setDecor([]);
  await progress.stage('build', `Building ${expected.toLocaleString('en')} bodies…`, device ? 0.1 : 0.85, expected);
  if (!stillWanted()) return null;
  if (!device) {
    freeSim();
    renderer.detachGpuBodies();
    return createSim3D(state.scene, params, sceneOptions());
  }
  // A picture scene runs once off screen first, to colour its bodies (painting.ts)
  const picture = sceneByName3D(state.scene).picture;
  let composed: Composed | null = null;
  if (picture) {
    const key = JSON.stringify([state.scene, sceneOptions(), params]);
    composed = pictures.get(key) ?? (await composePicture(device, picture, stillWanted));
    if (!composed || !stillWanted()) return null;
    pictures.set(key, composed);
  }
  const ref = buildScene3D(state.scene, sceneOptions());
  await progress.stage('solver', `Setting up the GPU solver for ${ref.bodies.length.toLocaleString('en')} bodies…`, 0.9, ref.bodies.length);
  if (!stillWanted()) return null;
  freeSim();
  const next = createGpuSim3D(device, state.scene, params, (n) => renderer.attachGpuBodies(n), sceneOptions(), ref);
  if (picture && composed) {
    next.setPaint(composed.paint, composed.from);
    renderer.setDecor(picture.frame(sceneOptions()));
  }
  return next;
}

/** A picture scene's first run: its bodies' colours, from body `from` on. */
interface Composed {
  paint: Uint32Array;
  from: number;
}
/** Composed pictures by scene, options and parameters: a replay skips the off-screen run. */
const pictures = new Map<string, Composed>();

/**
 * A picture scene's first run: step it off screen as far as its picture takes (a chunk at a
 * time, so the page and the bar stay live), then colour each emitted body from the image at
 * the spot it came to rest. The scene is deterministic, so the run shown next ends the same.
 */
async function composePicture(device: GPUDevice, picture: Picture3D, stillWanted: () => boolean): Promise<Composed | null> {
  const options = sceneOptions();
  const image = loadPixels(picture.url);
  const off = createGpuSim3D(device, state.scene, params, undefined, options);
  off.readbackEvery = Number.MAX_SAFE_INTEGER;
  const total = picture.steps(options);
  try {
    for (let s = 0; s < total; ) {
      for (const end = Math.min(total, s + 60); s < end; s++) {
        Object.assign(off.params, params);
        off.step();
      }
      await device.queue.onSubmittedWorkDone();
      if (!stillWanted()) return null;
      progress.set(0.1 + 0.75 * (s / total), `Working out where everything lands… ${Math.round((100 * s) / total)}%`);
    }
    const bodies = await off.solver.readBodies();
    // The bodies taking part: the emitted ones, or every dynamic body the scene is built with
    // (static ones, and what's emitted, such as a wrecking ball, keep their look)
    const emitted = picture.bodies === 'emitted';
    const from = emitted ? off.firstEmitted : 0;
    const index: number[] = [];
    for (let i = from; i < (emitted ? off.bodyCount : off.firstEmitted); i++) if (emitted || bodies[i * BODY_FLOATS + B_SIZE + 3] > 0) index.push(i);
    const p = new Float32Array(3 * index.length);
    index.forEach((i, k) => p.set(bodies.subarray(i * BODY_FLOATS + B_POS, i * BODY_FLOATS + B_POS + 3), 3 * k));
    const uv = picture.coords(options, p);
    const { data, width, height } = await image;
    // Each body covers a few of the image's pixels: average a 3 x 3 patch
    const paint = new Uint32Array(off.bodyCount - from).fill(NO_PAINT);
    for (let k = 0; k < index.length; k++) {
      const [u, v] = [uv[2 * k], uv[2 * k + 1]];
      if (picture.surround && (u < 0 || u > 1 || v < 0 || v > 1)) {
        paint[index[k] - from] = picture.surround(options, u, v);
        continue;
      }
      const cx = Math.round(Math.min(1, Math.max(0, u)) * (width - 1));
      const cy = Math.round(Math.min(1, Math.max(0, v)) * (height - 1));
      let [r, g, b, count] = [0, 0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = Math.min(width - 1, Math.max(0, cx + dx));
          const py = Math.min(height - 1, Math.max(0, cy + dy));
          const o = (py * width + px) * 4;
          [r, g, b, count] = [r + data[o], g + data[o + 1], b + data[o + 2], count + 1];
        }
      }
      paint[index[k] - from] = (Math.round(r / count) << 16) | (Math.round(g / count) << 8) | Math.round(b / count);
    }
    return { paint, from };
  } finally {
    off.destroy();
  }
}

/** An image's pixels (RGBA). */
async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d')!;
  context.drawImage(bitmap, 0, 0);
  return { data: context.getImageData(0, 0, bitmap.width, bitmap.height).data, width: bitmap.width, height: bitmap.height };
}

/** Free the current sim's GPU buffers (a new one replaces it at once). */
function freeSim(): void {
  endDrag();
  if (sim instanceof GpuSim3D) sim.destroy();
}

function sceneOptions(): SceneOptions {
  return { ...sceneByName3D(state.scene).options, ...state.sceneOptions[state.scene] };
}

/** A scene setting that may depend on the scene's options (Scene3D.camera, .params). */
function resolve<T>(setting: T | ((options: SceneOptions) => T)): T {
  return typeof setting === 'function' ? (setting as (options: SceneOptions) => T)(sceneOptions()) : setting;
}

/** Bodies up to which a scene starts with floor reflections on. */
const REFLECT_UP_TO = 30_000;

/** Built by the first loadScene() at the bottom. */
let sim!: Sim3D;

let pendingLoad = 0;
const progress = new BuildProgress('3d');

/**
 * (Re)build the current scene. Big scenes take seconds to build, so a progress bar follows the
 * stages, and the old scene keeps running until the new one replaces it.
 */
async function loadScene(reset = true): Promise<void> {
  const token = ++pendingLoad;
  const stillWanted = () => token === pendingLoad;
  progress.begin();
  if (reset) Object.assign(params, defaults());
  const next = await buildSim(stillWanted);
  if (!next) return;
  sim = next;
  {
    ui.setScene(state.scene);
    ui.refresh();
    if (reset) resetCamera();
    url.searchParams.set('scene', state.scene);
    url.searchParams.set('backend', state.backend);
    history.replaceState(null, '', url);
    wind.show(sceneByName3D(state.scene).windControl === true);
    restless = 3;
    if (reset) {
      state.speed = 1;
      // Reflections draw the scene twice: on for scenes small enough to afford it
      state.reflections = !weak && sim.bodyCount <= REFLECT_UP_TO;
    }
    panel.show(panelFor(state.scene, extras));
    setLabels(sim.labels());
    // Captions follow their bodies: read poses back more often (label scenes are small)
    if (sim instanceof GpuSim3D && sim.labels().length) sim.readbackEvery = 2;
  }
  // The first step and frame compile the pipelines (seconds, the first time in a browser)
  await progress.stage('warm', 'Compiling shaders…', 1, sim.bodyCount);
  if (!stillWanted()) return;
  if (!state.paused) stepOnce();
  renderer.render(sim, controls.target);
  await renderer.device?.queue.onSubmittedWorkDone();
  if (stillWanted()) progress.done();
}

// --- Controls --------------------------------------------------------------------------

const toggle = (label: string, key: 'shadows' | 'ambientOcclusion' | 'reflections' | 'showContacts' | 'showJoints' | 'details') =>
  ({ kind: 'toggle', label, get: () => state[key], set: (v: boolean) => (state[key] = v) }) as const;
const ui = new Controls({
  scenes: sceneMenu('3d', sceneNames, (name) => heaviness(budget, bodiesInName(name))),
  onScene: (value) => {
    const other = otherDemoUrl(value);
    if (other) {
      location.href = other;
      return;
    }
    if (!confirmHeavy(budget, value, sizeOf(value))) return;
    state.scene = value;
    loadScene();
  },
  buttons: [
    { label: 'Play / pause (P)', icon: () => (state.paused ? ICONS.play : ICONS.pause), onClick: () => (state.paused = !state.paused) },
    { label: 'Restart the scene (R)', icon: ICONS.restart, onClick: () => loadScene(false) },
    { label: 'Fire a cannonball (Space)', icon: ICONS.ball, onClick: () => shootBall() },
    { label: 'Reset the camera', icon: ICONS.focus, onClick: () => resetCamera() },
    { label: 'Source on GitHub', icon: ICONS.github, onClick: openRepo },
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
    toggle('Ambient occlusion', 'ambientOcclusion'),
    toggle('Floor reflections', 'reflections'),
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
        { kind: 'toggle', label: 'Slow bodies start at rest (GPU)', get: () => params.startAtRest, set: (v) => (params.startAtRest = v) },
        { kind: 'toggle', label: 'Contacts as stiff as the mass (GPU)', get: () => params.massPenalty, set: (v) => (params.massPenalty = v) },
        { kind: 'range', label: 'Cannonball radius', min: 0.2, max: 2, step: 0.05, get: () => state.ballRadius, set: (v) => (state.ballRadius = v), format: (v) => `${v.toFixed(2)} m` },
        { kind: 'range', label: 'Cannonball mass', min: 1, max: 10_000, log: true, get: () => state.ballMass, set: (v) => (state.ballMass = v), format: kilograms },
        { kind: 'range', label: 'Cannonball speed', min: 5, max: 80, step: 1, get: () => state.ballSpeed, set: (v) => (state.ballSpeed = v), format: (v) => `${v.toFixed(0)} m/s` },
      ],
    },
    { kind: 'action', label: 'Reset settings to defaults', run: () => Object.assign(params, defaults()) },
    { kind: 'action', label: 'Measure this GPU again (reloads)', run: () => (forgetBudget('3d'), location.reload()) },
  ],
});

// The wind panel, for scenes with wind: its dial is the ground as the camera sees it
const heading = new THREE.Vector3();
const wind = new WindPanel({
  get: () => ({ speed: params.windSpeed, angle: params.windAngle }),
  set: (speed, angle) => Object.assign(params, { windSpeed: speed, windAngle: angle }),
  basis: () => {
    camera.getWorldDirection(heading);
    const l = Math.hypot(heading.x, heading.y) || 1;
    const [fx, fy] = [heading.x / l, heading.y / l];
    return { forward: [fx, fy], right: [fy, -fx] };
  },
  max: 30,
});

// The scene's own panel, and captions over bodies
const panel = new ScenePanel();
const extras: ExtrasContext = {
  restart: () => loadScene(false),
  speed: () => state.speed,
  setSpeed: (v) => (state.speed = v),
  option: (key) => sceneOptions()[key],
  setOption: (key, value) => {
    state.sceneOptions[state.scene] = { ...state.sceneOptions[state.scene], [key]: value };
    loadScene(false);
  },
  apply: (options) => {
    state.sceneOptions[state.scene] = { ...state.sceneOptions[state.scene], ...options };
    loadScene();
  },
  bodyCount: () => sim.bodyCount,
  budget: () => budget,
  look: (view) => flyTo(view),
  stats: () => sim.stats(),
  ball: {
    radius: () => state.ballRadius,
    setRadius: (v) => (state.ballRadius = v),
    mass: () => state.ballMass,
    setMass: (v) => (state.ballMass = v),
    speed: () => state.ballSpeed,
    setSpeed: (v) => (state.ballSpeed = v),
    fire: () => shootBall(),
  },
};

let labels: { el: HTMLDivElement; bodies: number[] }[] = [];
function setLabels(list: { bodies: number[]; text: string }[]): void {
  for (const l of labels) l.el.remove();
  labels = list.map(({ bodies, text }) => {
    const el = document.createElement('div');
    el.className = 'avbd-label';
    el.textContent = text;
    document.body.append(el);
    return { el, bodies };
  });
}
const labelPoint = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
/**
 * Beside its body (to the right as the camera sees it, clear of it), or above the midpoint of
 * two; hidden behind the camera.
 */
function placeLabels(): void {
  const rect = canvas.getBoundingClientRect();
  cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
  for (const { el, bodies } of labels) {
    const p = sim.position(bodies[0]);
    if (p.length < 3) continue;
    labelPoint.set(p[0], p[1], p[2]);
    const pair = bodies.length > 1;
    if (pair) {
      const q = sim.position(bodies[1]);
      labelPoint.set((p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2 + 0.5);
    } else labelPoint.addScaledVector(cameraRight, 0.5 * Math.max(...Array.from(sim.size(bodies[0]))) + 0.25);
    labelPoint.project(camera);
    el.hidden = labelPoint.z > 1;
    const [x, y] = [rect.left + ((labelPoint.x + 1) / 2) * rect.width, rect.top + ((1 - labelPoint.y) / 2) * rect.height];
    el.style.transform = `translate(${x}px, ${y}px) ${pair ? 'translate(-50%, -100%)' : 'translate(0, -50%)'}`;
  }
}

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
  canvas.style.cursor = '';
}

/** The mouse ray while hovering; the body it hits is tinted and shows a grab cursor. */
let hoverRay: THREE.Ray | null = null;
let hoverPicked = 0;

function updateHover(now: number): void {
  if (drag) return;
  // Picking walks every body on the CPU: less often in big scenes
  if (hoverRay && now - hoverPicked < (sim.bodyCount > 50_000 ? 150 : 50)) return;
  hoverPicked = now;
  const hit = hoverRay ? sim.pick(arr(hoverRay.origin), arr(hoverRay.direction)) : null;
  renderer.hovered = hit ? hit.body : -1;
  canvas.style.cursor = hit ? 'grab' : '';
}

let lastShot = 0;

/**
 * Fire a cannonball from just in front of the eye along `dir` (default: at the orbit target),
 * as the demo's shootBox does with boxes. Held keys fire at most ~8 a second.
 */
function shootBall(dir?: THREE.Vector3): void {
  const now = performance.now();
  if (now - lastShot < 120) return;
  lastShot = now;
  const forward = dir ?? controls.target.clone().sub(camera.position).normalize();
  const position = camera.position.clone().addScaledVector(forward, 2 + state.ballRadius);
  sim.addBall(state.ballRadius, state.ballMass, 0.5, arr(position), arr(forward.clone().multiplyScalar(state.ballSpeed)));
}

// Registered before OrbitControls sees the event: grabbing a body disables orbiting
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) {
    e.preventDefault();
    shootBall(mouseRay(e).direction.clone());
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
  hoverRay = null;
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    // Hovering with the mouse (not orbiting): the frame loop picks along this ray
    hoverRay = e.pointerType === 'mouse' && e.buttons === 0 ? mouseRay(e).clone() : null;
    return;
  }
  const ray = mouseRay(e);
  drag.target = along(arr(ray.origin), arr(ray.direction), drag.distance);
  sim.moveDrag(drag.target);
});
canvas.addEventListener('pointerleave', () => {
  hoverRay = null;
  pointerInside = false;
});
canvas.addEventListener('pointerenter', () => (pointerInside = true));
// Touch has no hover: poses must always be at hand for a tap to grab
canvas.addEventListener('pointerdown', (e) => e.pointerType !== 'mouse' && (touched = true), { capture: true });
// Any input may change what's on screen: render a few frames even when paused (below)
for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'resize'] as const) window.addEventListener(type, () => (restless = 3), { passive: true });
canvas.addEventListener('pointerup', () => drag && endDrag());
canvas.addEventListener('pointercancel', () => drag && endDrag());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('keyup', (e) => (e.code === 'Space' || e.key === ' ') && e.preventDefault());
window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  // Space fires, even with a dock button focused (which would otherwise be clicked)
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    shootBall();
  }
  if (e.code === 'KeyP') state.paused = !state.paused;
  if (e.code === 'KeyR') loadScene(false);
  if (e.code === 'KeyB') shootBall();
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

/** The pointer is over the canvas; a touch screen has been used. */
let pointerInside = false;
let touched = matchMedia('(hover: none)').matches;
/** Frames still to render after the last input while paused. */
let restless = 3;

function frame(now: number): void {
  const elapsed = Math.min((now - last) / 1000, 0.25);
  last = now;
  fly(now);
  const orbiting = controls.update();
  // Fog, shadow range and far plane follow the zoom
  const distance = camera.position.distanceTo(controls.target);
  if (Math.abs(distance - viewScale) > viewScale * 0.05) renderer.setViewScale((viewScale = distance));

  // Fixed-timestep stepping in real time; cap the catch-up so slow scenes degrade to slow
  // motion instead of a spiral of death.
  // A step costing over half a timestep (a huge scene) gets one step a frame: slow motion at
  // a steady frame rate, rather than catch-up steps stalling every frame
  if (!state.paused) {
    accumulator += elapsed * state.speed;
    const cost = sim instanceof GpuSim3D ? (sim.profile?.total ?? 0) : stepMs;
    const most = cost > (params.dt * 1000) / 2 ? 1 : 4;
    let steps = 0;
    while (accumulator >= params.dt && steps < most) {
      stepOnce();
      accumulator -= params.dt;
      steps++;
    }
    if (steps === most) accumulator = 0;
  }

  renderer.showContacts = state.showContacts;
  renderer.showJoints = state.showJoints;
  renderer.shadows = state.shadows;
  renderer.ambientOcclusion = state.ambientOcclusion;
  renderer.reflections = state.reflections;
  updateHover(now);
  wind.update();
  placeLabels();
  renderer.selected = sim.dragBody;
  renderer.dragLine = null;
  if (drag && sim.dragBody >= 0) {
    const i = sim.dragBody;
    const o = sim.orientation(i);
    const p = sim.position(i);
    anchor.set(...drag.local).applyQuaternion(q.set(o[0], o[1], o[2], o[3])).add(new THREE.Vector3(p[0], p[1], p[2]));
    renderer.dragLine = [arr(anchor), drag.target];
  }
  // The GPU sim reads back only what's in use (the whole body buffer is megabytes)
  if (sim instanceof GpuSim3D) {
    sim.needJoints = state.details || panel.hasReadouts;
    sim.needPoses = sim.needJoints || pointerInside || touched || drag !== null || labels.length > 0;
  }
  // Paused and still, the frame wouldn't change: skip it (a hovered body's glow animates)
  if (!state.paused || orbiting || drag || renderer.hovered >= 0 || restless > 0) renderer.render(sim, controls.target);
  restless = Math.max(0, restless - 1);

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
  keysHint.hidden = state.details;
  panel.refresh();
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

void loadScene().then(() => requestAnimationFrame(frame));

// Exposed for debugging and automated checks
function setScene(name: string, backend: Backend3D = state.backend): void {
  if (backend !== state.backend) {
    state.backend = backend;
    Object.assign(params, defaults());
  }
  state.scene = name;
  void loadScene();
}
Object.assign(window, { sim: () => sim, camera, controls, renderer, state, params, setScene, stepOnce, shootBall });
