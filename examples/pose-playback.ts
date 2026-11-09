// Physics-free playback of a pose track written by examples/pose-capture.ts: plain Three.js InstancedMesh, no World,
// no solver, no Rapier. You choose the JSON file; it is read in the browser, validated (examples/pose-track.ts) and drawn.
// Transforms only: there is nothing to simulate or restore here.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { advancePlayhead, checkTrackBytes, describeCapture, parsePoseTrack, POSE_FLOATS, samplePoses, trackDuration, type PoseTrack } from './pose-track.ts';
import { releaseRenderer, requireWebGpu, startExample } from './startup.ts';

const status = document.getElementById('status')!;
const trackStatus = document.getElementById('track-status')!;
const clock = document.getElementById('clock')!;
const fileInput = document.getElementById('file') as HTMLInputElement;
const playButton = document.getElementById('play') as HTMLButtonElement;
const scrub = document.getElementById('scrub') as HTMLInputElement;
const startup = startExample(status);

/** One InstancedMesh and the track bodies (by index) it draws. */
interface Group { mesh: THREE.InstancedMesh; bodies: number[] }
interface Loaded { track: PoseTrack; groups: Group[]; poses: Float64Array; duration: number }

/** File names and file content reach the page as text only, clipped and ASCII, never as markup. */
const printable = (value: string, n = 60) => value.replace(/[^\x20-\x7e]/g, '?').slice(0, n);

try {
  requireWebGpu();
  const renderer = startup.own(new THREE.WebGPURenderer({ antialias: true }), releaseRenderer);
  renderer.setPixelRatio(Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 2) : 1);
  renderer.setSize(innerWidth, innerHeight);
  await renderer.init();
  // Three.js falls back to WebGL2 when WebGPU is missing; this player says so instead of drawing on the fallback
  if ((renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend !== true) throw new Error('Three.js WebGL2 fallback refused: this player requires WebGPU rendering.');
  document.body.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(8, 6, 10);
  const controls = startup.own(new OrbitControls(camera, renderer.domElement), c => c.dispose());
  controls.target.set(0, 1, 0);
  scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 1.5));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(10, 20, 8);
  scene.add(sun);

  // Geometry and materials are made once and shared by every track you load; only the instanced meshes come and go
  const geometries = { box: startup.own(new THREE.BoxGeometry(1, 1, 1), g => g.dispose()), sphere: startup.own(new THREE.SphereGeometry(0.5, 24, 16), g => g.dispose()) };
  const materials = { fixed: 0x59636e, box: 0xd9c9a8, sphere: 0xc8553d };
  const material = Object.fromEntries(Object.entries(materials).map(([name, color]) =>
    [name, startup.own(new THREE.MeshStandardNodeMaterial({ color, roughness: name === 'sphere' ? 0.4 : 0.7 }), m => m.dispose())])) as Record<keyof typeof materials, THREE.MeshStandardNodeMaterial>;

  let loaded: Loaded | null = null, time = 0, playing = true, token = 0;
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();

  const unload = () => {
    if (!loaded) return;
    for (const { mesh } of loaded.groups) { scene.remove(mesh); mesh.dispose(); }
    loaded = null;
    time = 0;
    clock.textContent = '';
    playButton.disabled = scrub.disabled = true;
    scrub.value = '0';
  };
  startup.own(unload, release => release());

  const pose = (l: Loaded) => {
    samplePoses(l.track, time, l.poses);
    for (const { mesh, bodies } of l.groups) {
      bodies.forEach((body, k) => {
        const o = body * POSE_FLOATS, p = l.poses, size = l.track.bodies[body].size;
        position.set(p[o], p[o + 1], p[o + 2]);
        rotation.set(p[o + 3], p[o + 4], p[o + 5], p[o + 6]);
        scale.set(size[0], size[1], size[2]);
        mesh.setMatrixAt(k, matrix.compose(position, rotation, scale));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    const step = l.track.steps[0] + Math.round(time / l.track.dt);
    clock.textContent = `t = ${time.toFixed(2)} s of ${l.duration.toFixed(2)} s · step ${step}`;
    scrub.value = String(l.duration > 0 ? Math.round((time / l.duration) * 1000) : 0);
  };

  const show = (track: PoseTrack, name: string) => {
    const groups: Group[] = [];
    try {
      const wanted: Record<string, number[]> = {};
      track.bodies.forEach((b, i) => (wanted[`${b.fixed ? 'fixed' : b.shape}:${b.shape}`] ??= []).push(i));
      for (const [key, bodies] of Object.entries(wanted)) {
        const [kind, shape] = key.split(':') as [keyof typeof materials, 'box' | 'sphere'];
        const mesh = new THREE.InstancedMesh(geometries[shape], material[kind], bodies.length);
        mesh.frustumCulled = false; // the bodies move: a bounding sphere computed once would go stale
        scene.add(mesh);
        groups.push({ mesh, bodies });
      }
    } catch (error) { for (const { mesh } of groups) { scene.remove(mesh); mesh.dispose(); } throw error; }
    const duration = trackDuration(track);
    loaded = { track, groups, poses: new Float64Array(track.bodies.length * POSE_FLOATS), duration };
    time = 0;
    playing = duration > 0;
    playButton.disabled = scrub.disabled = duration <= 0;
    playButton.textContent = playing ? 'Pause' : 'Play';

    // Frame the moving bodies (or everything, when none move) over the whole track
    const box = new THREE.Box3(), moving = track.bodies.some(b => !b.fixed);
    for (let f = 0; f < track.steps.length; f++) track.bodies.forEach((b, i) => {
      if (moving && b.fixed) return;
      const o = (f * track.bodies.length + i) * POSE_FLOATS;
      box.expandByPoint(position.set(track.poses[o], track.poses[o + 1], track.poses[o + 2]));
    });
    const center = box.getCenter(new THREE.Vector3()), radius = Math.max(1, box.getSize(new THREE.Vector3()).length() / 2);
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(0.9, 0.55, 1.1).multiplyScalar(radius * 2.2));
    camera.near = Math.max(0.01, radius / 500);
    camera.far = Math.max(500, radius * 60);
    camera.updateProjectionMatrix();
    controls.minDistance = radius * 0.2;
    controls.maxDistance = radius * 30;
    controls.update();
    pose(loaded);

    const c = describeCapture(track.capture);
    const origin = !c ? 'No capture metadata in this file.'
      : `File reports capture on ${c.vendor || 'an unnamed vendor'}${c.architecture ? ` ${c.architecture}` : ''}${c.steps !== null ? `, ${c.steps} steps` : ''}${c.iterations !== null ? `, ${c.iterations} iterations` : ''}`
        + `${c.captureWallMs !== null ? `; capture took ${c.captureWallMs} ms wall in one run (not GPU time, not a benchmark)` : ''}.`;
    trackStatus.textContent = `Loaded ${printable(name)}: ${track.bodies.length} bodies, ${track.steps.length} frames, ${duration.toFixed(2)} s at dt ${track.dt.toFixed(4)} s. ${origin} Looping; transforms only.`;
  };

  const load = async (file: File) => {
    const mine = ++token;
    const previous = loaded;
    trackStatus.textContent = `Reading ${printable(file.name)}…`;
    try {
      checkTrackBytes(file.size); // before the file is read
      const text = await file.text();
      if (mine !== token || startup.stopped) return;
      const track = parsePoseTrack(text);
      unload(); // keep the previous track until the replacement has passed validation
      show(track, file.name);
    } catch (error) {
      if (mine !== token || startup.stopped) return;
      if (loaded !== previous) unload();
      trackStatus.textContent = `Could not load ${printable(file.name)}: ${error instanceof Error ? printable(error.message, 200) : 'unknown error'}. ${loaded ? 'Previous track remains loaded.' : 'Choose a file written by pose-capture.ts.'}`;
    }
  };

  const listen = <K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, handler: (event: HTMLElementEventMap[K]) => void) => {
    target.addEventListener(type, handler);
    startup.own(handler, h => target.removeEventListener(type, h as EventListener));
  };
  listen(fileInput, 'change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = ''; // choosing the same path again, after regenerating it, must load again
    if (file) void load(file);
  });
  listen(playButton, 'click', () => {
    if (!loaded) return;
    playing = !playing;
    playButton.textContent = playing ? 'Pause' : 'Play';
  });
  listen(scrub, 'input', () => {
    if (!loaded) return;
    time = (Number(scrub.value) / 1000) * loaded.duration;
    pose(loaded);
  });

  let previous: number | null = null;
  await startup.animate(renderer, (now) => {
    const delta = previous === null || !Number.isFinite(now) ? 0 : Math.min(Math.max((now - previous) / 1000, 0), 0.1);
    previous = Number.isFinite(now) ? now : null;
    if (loaded && playing) { time = advancePlayhead(time, delta, loaded.duration, true); pose(loaded); }
    controls.update();
    renderer.render(scene, camera);
  });

  const resize = () => {
    if (startup.stopped) return;
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  };
  addEventListener('resize', resize);
  startup.own(resize, callback => removeEventListener('resize', callback));

  fileInput.disabled = false;
  startup.own(fileInput, input => { input.disabled = true; });
  trackStatus.textContent = 'No pose track loaded. Choose a JSON file written by examples/pose-capture.ts.';
  status.textContent = 'Running. Drag to orbit, scroll to zoom.';
} catch (error) {
  trackStatus.textContent = 'Playback did not start.';
  await startup.fail(error);
}
