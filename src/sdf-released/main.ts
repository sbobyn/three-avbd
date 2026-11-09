import * as THREE from 'three/webgpu';
import { inspectQualificationWorld, qualificationOptions } from '../sdf-showcase/qualification.ts';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BodyMesh, recommendedLimits } from '../lib/index.ts';
import { browserPerformance } from '../sdf-showcase/performance.ts';
import { instantiateReleased, loadReleasedScene, type ReleasedProfile, type ReleasedScene, type Sample } from './scenes.ts';
import { readBrowserAsset } from './assets.ts';
import { measuredFrame } from './metrics.ts';
import { FrameQueue } from './frame-queue.ts';
import { FramingPolicy } from './framing.ts';
import '../sdf-showcase/style.css';
import './style.css';

const status = document.querySelector<HTMLOutputElement>('#status')!;
const select = document.querySelector<HTMLSelectElement>('#scene')!;
const profile = document.querySelector<HTMLSelectElement>('#profile')!;
const comparison = document.querySelector<HTMLInputElement>('#comparison')!;
const run = document.querySelector<HTMLButtonElement>('#run')!;
const reset = document.querySelector<HTMLButtonElement>('#reset')!;
const measure = document.querySelector<HTMLButtonElement>('#measure')!;
const table = document.querySelector<HTMLTableSectionElement>('#metrics')!;
const format = (n: number) => n === 0 ? '0' : Math.abs(n) < .001 ? n.toExponential(2) : n.toLocaleString(undefined, { maximumFractionDigits: 4 });

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Open this demo in a WebGPU-enabled browser.');
  const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: await recommendedLimits() });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight); renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; document.body.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101a22); scene.fog = new THREE.Fog(0x101a22, 25, 90);
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, .1, 180);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.minDistance = 3; controls.maxDistance = 100; controls.maxPolarAngle = Math.PI * .49;
  scene.add(new THREE.HemisphereLight(0xc4e1ff, 0x34312b, 2));
  const sun = new THREE.DirectionalLight(0xffe3bd, 3); sun.position.set(4, 14, 8); sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024); sun.shadow.normalBias = .015;
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, far: 45 }); scene.add(sun);
  const frameQueue = new FrameQueue();
  const framing = new FramingPolicy();
  let prepared: ReleasedScene | null = null, simulation: Awaited<ReturnType<typeof instantiateReleased>> | null = null;
  const group = new THREE.Group(); scene.add(group);
  let paused = true, loading = false, inFlight = false, dirty = true, frame = 0, last = 0, lastMeasured = 0;
  controls.addEventListener('change', () => { dirty = true; });
  const disposeMeshes = () => {
    for (const object of [...group.children]) {
      group.remove(object); const mesh = object as BodyMesh;
      mesh.geometry.dispose(); mesh.material.dispose();
    }
  };
  function summary() {
    const seconds = frame * (prepared?.capture.solver.dt ?? 1 / 60);
    status.textContent = `${prepared?.capture.scene ?? ''} · ${seconds.toFixed(2)}${comparison.checked ? ' / 6.00' : ''} s · ${paused ? 'paused' : 'live'}`;
    run.textContent = comparison.checked && frame >= 360 ? 'Restart' : paused ? 'Play' : 'Pause';
  }
  function setPaused(value: boolean) { frameQueue.resetTime(); paused = value; last = performance.now(); summary(); }
  const perf = browserPerformance({ canvas: renderer.domElement,
    // This adapter exists across scene reloads; only the current world's queue is used at capture end.
    get device() { return simulation!.world.device; },
    context: () => ({ demo: 'released', scene: prepared!.capture.scene, sceneId: Number(select.value),
      profile: profile.value, comparison: comparison.checked, frameStart: frame,
      dynamicBodies: prepared!.bodies.filter(body => !body.original.static).length,
      iterations: prepared!.capture.solver.iterations, fixedDt: simulation!.world.dt,
      maxSubsteps: simulation!.world.maxSubsteps, maxPairs: simulation!.world.sdfCollisionCapacity, maxFramesInFlight: 2,
      pixelRatio: renderer.getPixelRatio(), shadows: renderer.shadowMap.enabled }),
    start: () => { if (loading || inFlight || !simulation || comparison.checked) return false; setPaused(false); return true; },
    inspect: () => inspectQualificationWorld(simulation!.world),
    pause: () => setPaused(true) });
  function metrics(actual: Sample) {
    const reference = prepared!.capture.samples[actual.frame - 1];
    const rows: [string, number, number][] = [['Contacts', actual.stats.contacts, reference.stats.contacts],
      ['Pairs', actual.stats.pairs, reference.stats.pairs], ['Paired queries', actual.stats.queries, reference.stats.queries],
      ['Search iterations', actual.stats.iterations, reference.stats.iterations], ['Kinetic energy', actual.kineticEnergy, reference.kineticEnergy],
      ['Contact depth', actual.maxContactPenetration, reference.maxContactPenetration], ['Lowest COM', actual.minCenterY, reference.minCenterY]];
    if (actual.maxVertexPenetration !== undefined) rows.push(['Sampled surface depth', actual.maxVertexPenetration, reference.maxVertexPenetration ?? 0]);
    table.replaceChildren(...rows.map(([name, a, b]) => {
      const row = document.createElement('tr');
      for (const text of [name, format(a), format(b)]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
      return row;
    }));
  }
  function viewOffset() {
    camera.aspect = innerWidth / innerHeight;
    camera.setViewOffset(innerWidth, innerHeight, innerWidth > 650 ? -160 : 0, innerWidth > 650 ? 0 : innerHeight * .16, innerWidth, innerHeight);
    camera.updateProjectionMatrix();
  }
  function frameView(current = false) {
    if (!prepared) return;
    const bounds = new THREE.Box3();
    for (const [i, body] of prepared.bodies.entries()) {
      if (body.original.static) continue;
      body.geometry.computeBoundingBox();
      const pose = current ? simulation!.bodies[i] : { position: body.original.position, rotation: body.rotation };
      const transform = new THREE.Matrix4().compose(new THREE.Vector3(...pose.position), new THREE.Quaternion(...pose.rotation), new THREE.Vector3(1, 1, 1));
      bounds.union(body.geometry.boundingBox!.clone().applyMatrix4(transform));
    }
    const sphere = bounds.getBoundingSphere(new THREE.Sphere());
    controls.target.copy(sphere.center);
    camera.position.copy(new THREE.Vector3(9, 5, 12).normalize().multiplyScalar(Math.max(7, sphere.radius * 2.9) * Math.max(1, .85 / camera.aspect)).add(controls.target));
    viewOffset(); controls.update(); dirty = true;
  }
  async function load() {
    if (loading) return;
    perf.reset('Press Play or measure this scene.');
    loading = true; paused = true; frameQueue.resetTime(); run.disabled = reset.disabled = select.disabled = profile.disabled = comparison.disabled = measure.disabled = true;
    while (inFlight) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    status.textContent = 'Loading verified reference assets…';
    try {
      if (simulation) await simulation.world.device.queue.onSubmittedWorkDone();
      simulation?.world.destroy(); simulation = null; disposeMeshes(); prepared?.dispose(); prepared = null; table.replaceChildren();
      const id = Number(select.value);
      prepared = await loadReleasedScene(id, readBrowserAsset);
      simulation = await instantiateReleased(prepared, { renderer }, profile.value as ReleasedProfile);
      const batches = new Map<THREE.BufferGeometry, number[]>();
      prepared.bodies.forEach((body, i) => { const list = batches.get(body.geometry) ?? []; list.push(i); batches.set(body.geometry, list); });
      for (const [geometry, ids] of batches) {
        const fixed = prepared.bodies[ids[0]].original.static;
        const color = fixed ? 0x243744 : ({ '1': 0xe3ad60, '3': 0xe07a5f, '4': 0xe07a5f, '5': 0xe07a5f, '6': 0x68c2bc,
          '7': 0xd9c27a, '8': 0xf2e8cf, '9': 0xc2a1d9, '10': 0x8ecae6 } as Record<string, number>)[select.value] ?? 0x8e9fe0;
        const mesh = new BodyMesh(simulation.world, { geometry, bodies: ids.map(i => simulation!.bodies[i]),
          material: new THREE.MeshStandardNodeMaterial({ color, roughness: .4, metalness: .12 }) });
        mesh.castShadow = !fixed; mesh.receiveShadow = true; group.add(mesh);
      }
      frame = 0; last = performance.now(); lastMeasured = 0;
      // Reset and a change of settings rebuild the same scene: keep the camera the viewer set (the Frame button re-fits it)
      if (framing.needsFraming(id)) { frameView(); framing.markFramed(id); }
      summary(); dirty = true;
      document.querySelector<HTMLElement>('#reference-note')!.textContent = comparison.checked
        ? 'Diagnostic playback · readbacks enabled · 30 reference frames/s maximum'
        : 'Smooth playback · reference readbacks off';
    } catch (error) { status.textContent = String(error); console.error(error); }
    finally {
      loading = false; select.disabled = profile.disabled = comparison.disabled = false;
      run.disabled = reset.disabled = !simulation; measure.disabled = !simulation || comparison.checked;
    }
  }
  profile.addEventListener('change', () => void load()); select.addEventListener('change', () => void load());
  comparison.addEventListener('change', () => void load()); reset.addEventListener('click', () => void load());
  document.querySelector('#view')!.addEventListener('click', () => {
    if (!simulation || loading || inFlight) return;
    perf.reset('Camera framed. Measure again when ready.');
    inFlight = true;
    void simulation.world.read().then(() => frameView(true)).catch(error => {
      status.textContent = String(error); console.error(error);
    }).finally(() => { inFlight = false; });
  });
  run.addEventListener('click', () => {
    perf.cancel('Capture cancelled by playback change.');
    if (comparison.checked && frame >= 360) { void load(); return; }
    setPaused(!paused);
  });
  if (qualificationOptions(new URLSearchParams(location.search))) {
    const query = new URLSearchParams(location.search);
    const id = query.get('scene'), requestedProfile = query.get('profile');
    if (id && [...select.options].some(option => option.value === id)) select.value = id;
    if (requestedProfile === 'reference' || requestedProfile === 'mesh-quality') profile.value = requestedProfile;
  }
  await load();
  renderer.setAnimationLoop((time: number) => {
    if (document.hidden) return;
    // Preserve last: the next submitted frame consumes the deferred wall time.
    if (!paused && !comparison.checked && !frameQueue.available) return;
    perf.beginFrame(time);
    const dt = Math.max(0, (time - last) / 1000); last = time; controls.update();
    let simulatedSeconds = 0;
    if (!paused && !loading && !inFlight && simulation && prepared) {
      if (comparison.checked) {
        if (time - lastMeasured >= 1000 / 30) {
          lastMeasured = time; inFlight = true;
          void measuredFrame(prepared, simulation.world, simulation.bodies, frame + 1, frame + 1 === 360).then(sample => {
            frame = sample.frame; if (frame >= 360) paused = true; metrics(sample); summary(); dirty = true;
          }).catch(error => { paused = true; status.textContent = String(error); console.error(error); }).finally(() => { inFlight = false; });
        }
      } else {
        try {
          simulatedSeconds = simulation.world.update(frameQueue.takeTime(dt, simulation.world.maxSubsteps * simulation.world.dt)) * simulation.world.dt;
          frame = Math.floor(simulation.world.stepCount / prepared.capture.solver.substeps);
          dirty = true;
          if (time - lastMeasured > 250) { lastMeasured = time; summary(); }
        } catch (error) { perf.cancel('Capture stopped by a simulation error.'); setPaused(true); status.textContent = String(error); console.error(error); }
      }
    }
    perf.afterPhysics(simulation ? Math.round(simulatedSeconds / simulation.world.dt) : 0);
    if (dirty && !loading) {
      renderer.render(scene, camera); perf.afterRender(); dirty = false;
      if (!paused && !comparison.checked && simulation) frameQueue.submitted(simulation.world.device.queue, error => {
        perf.cancel('Capture stopped by a GPU queue error.'); setPaused(true); status.textContent = String(error); console.error(error);
      });
      if (!paused && !comparison.checked) perf.frame(time, simulatedSeconds); else perf.idle();
    }
  });
  addEventListener('resize', () => { perf.reset('Viewport changed. Measure again when ready.'); viewOffset(); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5)); renderer.setSize(innerWidth, innerHeight); dirty = true; });
  document.addEventListener('visibilitychange', () => { last = performance.now(); perf.idle(); if (document.hidden) { perf.cancel('Capture cancelled: tab was hidden.'); setPaused(true); } });
}
void main().catch(error => { status.textContent = String(error); console.error(error); });
