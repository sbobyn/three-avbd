import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BodyMesh, World, recommendedLimits } from '../lib/index.ts';
import { prepareGears, createGearTrain, CENTERS, COLORS, TEETH, MODULE, DEPTH, angleZ, angleDelta, GearDrive } from './model.ts';
import './style.css';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
const auto = $<HTMLButtonElement>('auto'), pause = $<HTMLButtonElement>('pause');
const speed = $<HTMLInputElement>('speed'), contacts = $<HTMLInputElement>('contacts'), coupling = $<HTMLInputElement>('coupling');
const wheel = $('wheel'), viewport = $('viewport');
const controlsUI = [...document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')];
const clamp = THREE.MathUtils.clamp;
const rpm = (radians: number) => radians * 60 / (2 * Math.PI);

async function main() {
  document.body.classList.add('loading'); controlsUI.forEach(e => e.disabled = true);
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Try a current WebGPU-enabled browser.');
  const gears = await prepareGears(text => { status.textContent = text; });
  const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: await recommendedLimits() });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = true; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  viewport.append(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x111c23);
  const camera = new THREE.PerspectiveCamera(34, 1, .1, 70);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enableDamping = true; orbit.enablePan = false; orbit.minDistance = 6; orbit.maxDistance = 32;
  orbit.mouseButtons.LEFT = null!; orbit.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
  orbit.touches.ONE = null!; orbit.touches.TWO = THREE.TOUCH.DOLLY_ROTATE;
  orbit.minPolarAngle = .4; orbit.maxPolarAngle = 2.7;
  scene.add(new THREE.HemisphereLight(0xdceaff, 0x3d4e55, 2.3));
  const key = new THREE.DirectionalLight(0xffeed2, 4); key.position.set(-3, 6, 9); key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 7, bottom: -6, far: 25 });
  key.shadow.mapSize.set(1024, 1024); key.shadow.normalBias = .015; scene.add(key);
  const fill = new THREE.DirectionalLight(0x7cc9e8, 2); fill.position.set(5, -4, 3); scene.add(fill);
  const board = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshStandardNodeMaterial({ color: 0x15232d, roughness: .9 }));
  board.position.z = -.5; board.receiveShadow = true; scene.add(board);
  const metal = new THREE.MeshStandardNodeMaterial({ color: 0x465864, metalness: .75, roughness: .3 });
  for (const [x, y] of CENTERS) {
    const bearing = new THREE.Mesh(new THREE.CylinderGeometry(.22, .27, .8, 32), metal);
    bearing.rotation.x = Math.PI / 2; bearing.position.set(x, y, -.1); bearing.castShadow = true; scene.add(bearing);
  }
  // Decorative hubs, index marks and fasteners share the simulated body transform.
  const hardware = gears.map(gear => {
    const pieces: THREE.BufferGeometry[] = [];
    const hub = new THREE.CylinderGeometry(.25, .29, .15, 32); hub.rotateX(Math.PI / 2); hub.translate(0, 0, .23); pieces.push(hub);
    const r = MODULE * gear.teeth / 2;
    for (let i = 0; i < 6; i++) {
      const bolt = new THREE.CylinderGeometry(.045, .045, .025, 6); bolt.rotateX(Math.PI / 2);
      bolt.translate(.48 * r * Math.cos(i * Math.PI / 3), .48 * r * Math.sin(i * Math.PI / 3), DEPTH / 2 + .015); pieces.push(bolt);
    }
    const mark = new THREE.BoxGeometry(.16, .05, .012); mark.translate(.75 * r, 0, DEPTH / 2 + .008); pieces.push(mark);
    const merged = mergeGeometries(pieces); pieces.forEach(g => g.dispose()); return merged;
  });
  const meshes: BodyMesh[] = [];
  const markers = new THREE.Group(); scene.add(markers);
  const dotGeometry = new THREE.SphereGeometry(.055, 10, 6);
  const dots = Array.from({ length: 16 }, () => {
    const dot = new THREE.Mesh(dotGeometry, new THREE.MeshBasicNodeMaterial({ color: 0xffd174, depthTest: false }));
    dot.renderOrder = 10; dot.visible = false; markers.add(dot); return dot;
  });
  let world: World | undefined;
  let bodies: Awaited<ReturnType<typeof createGearTrain>>['bodies'] = [];
  let busy = false, inspecting = false, disposed = false, failed = false;
  let paused = matchMedia('(prefers-reduced-motion: reduce)').matches, automatic = true, direction = 1;
  let manualTarget = 0, inputAngle = 0, rendered = false, owed = 0;
  let drive: GearDrive;
  let lastTime = 0, lastRead = 0, fpsStart = 0, frames = 0, simulatedSeconds = 0, frameRate = 0, simulationRate = 1;
  let dirty = true, readNeeded = true, count = 0;
  const pose = new THREE.Vector3(), quat = new THREE.Quaternion();
  function syncControls() {
    auto.setAttribute('aria-pressed', String(automatic));
    pause.textContent = paused ? 'Play' : 'Pause';
    $('speed-value').textContent = `${Number(speed.value).toFixed(1)} rpm`;
    wheel.setAttribute('aria-disabled', String(busy));
    const message = `${paused ? 'Paused' : automatic ? 'Automatic drive' : 'Manual control'}. ${coupling.checked ? 'Tooth collisions enabled' : 'Tooth collisions disabled'}. ${direction > 0 ? 'Counterclockwise' : 'Clockwise'} input.`;
    if ($('announcement').textContent !== message) $('announcement').textContent = message;
  }
  function release() { drag = null; orbit.enabled = true; }
  function setPaused(value: boolean) { paused = value; status.textContent = value ? 'Paused' : 'Running…'; release(); lastTime = 0; dirty = readNeeded = true; syncControls(); }
  async function reset() {
    if (busy || disposed) return;
    busy = true; release(); controlsUI.forEach(e => e.disabled = true); syncControls();
    while (inspecting) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    for (const mesh of meshes.splice(0)) { scene.remove(mesh); mesh.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); }
    world?.destroy(); world = undefined;
    try {
      world = await World.create({ renderer, maxBodies: 4, gravity: [0, 0, 0], iterations: 20, dt: 1 / 120 });
      world.maxSubsteps = 4; world.readbackEvery = 0;
      ({ bodies } = await createGearTrain(world, gears, coupling.checked));
      gears.forEach((gear, i) => {
        for (const [geometry, material] of [
          [gear.geometry, new THREE.MeshStandardNodeMaterial({ color: COLORS[i], metalness: .4, roughness: .32 })],
          [hardware[i], metal.clone()],
        ] as const) {
          const mesh = new BodyMesh(world!, { bodies: [bodies[i]], geometry, material });
          mesh.castShadow = mesh.receiveShadow = true; meshes.push(mesh); scene.add(mesh);
        }
      });
      drive = new GearDrive(bodies[0]); inputAngle = manualTarget = owed = 0;
      dots.forEach(dot => dot.visible = false); count = 0; lastTime = lastRead = fpsStart = frames = simulatedSeconds = 0;
      dirty = readNeeded = true; rendered = false;
    } finally { busy = false; controlsUI.forEach(e => e.disabled = false); syncControls(); }
  }
  function fit() {
    const width = viewport.clientWidth, height = viewport.clientHeight;
    camera.aspect = width / height;
    const distance = Math.max(12, 5.8 / (Math.tan(THREE.MathUtils.degToRad(17)) * camera.aspect));
    orbit.target.set(.2, .9, 0); camera.position.set(.2, .9 - distance * .12, distance);
    if (width > 1000) camera.setViewOffset(width, height, -width * .09, 0, width, height);
    else camera.clearViewOffset();
    camera.updateProjectionMatrix(); renderer.setSize(width, height); orbit.update(); dirty = true;
  }
  orbit.addEventListener('change', () => { dirty = true; });
  function labels() {
    const rect = viewport.getBoundingClientRect();
    CENTERS.forEach(([x, y], i) => {
      pose.set(x, y - MODULE * TEETH[i] / 2 - .38, 0).project(camera);
      const el = $(`label-${i}`);
      el.style.left = `${rect.left + (.5 + pose.x / 2) * rect.width}px`;
      el.style.top = `${rect.top + (.5 - pose.y / 2) * rect.height}px`;
      el.style.visibility = pose.z > 1 || Math.abs(pose.x) > 1 || Math.abs(pose.y) > 1 ? 'hidden' : 'visible';
    });
  }
  let drag: { id: number; angle: number; element: HTMLElement; screen: boolean } | null = null;
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  function eventAngle(event: PointerEvent, screen: boolean): number | null {
    if (screen) {
      const r = wheel.getBoundingClientRect(), x = event.clientX - r.left - r.width / 2, y = r.top + r.height / 2 - event.clientY;
      return Math.hypot(x, y) < 8 ? null : Math.atan2(y, x);
    }
    const r = renderer.domElement.getBoundingClientRect();
    pointer.set((event.clientX - r.left) / r.width * 2 - 1, 1 - (event.clientY - r.top) / r.height * 2);
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(plane, pose)) return null;
    pose.sub(new THREE.Vector3(...CENTERS[0]));
    if (!drag && (pose.length() > MODULE * TEETH[0] / 2 + MODULE || pose.length() < .25)) return null;
    return Math.atan2(pose.y, pose.x);
  }
  function manual() { automatic = false; manualTarget = inputAngle; setPaused(false); syncControls(); }
  for (const [element, screen] of [[wheel, true], [renderer.domElement, false]] as [HTMLElement, boolean][]) {
    element.addEventListener('pointerdown', event => {
      if (event.button !== 0 || busy || inspecting || failed) return;
      const angle = eventAngle(event, screen); if (angle === null) return;
      manual(); orbit.enabled = false; drag = { id: event.pointerId, angle, element, screen }; element.setPointerCapture(event.pointerId);
    });
    element.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId || drag.element !== element) return;
      const angle = eventAngle(event, drag.screen); if (angle === null) return;
      manualTarget += angleDelta(angle, drag.angle); drag.angle = angle;
      // Avoid an enormous queued turn after a fast mouse gesture.
      manualTarget = clamp(manualTarget, inputAngle - Math.PI, inputAngle + Math.PI);
    });
    element.addEventListener('pointerup', release); element.addEventListener('pointercancel', release); element.addEventListener('lostpointercapture', release);
  }
  wheel.addEventListener('keydown', event => {
    if (busy || failed || !['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault(); if (automatic) manual(); else setPaused(false);
    if (event.key === 'Home') manualTarget = inputAngle;
    else manualTarget += event.key === 'ArrowLeft' ? Math.PI / 12 : -Math.PI / 12;
  });
  auto.addEventListener('click', () => { if (automatic) { automatic = false; manualTarget = inputAngle; } else automatic = true; setPaused(false); });
  pause.addEventListener('click', () => setPaused(!paused));
  $('reverse').addEventListener('click', () => { direction *= -1; automatic = true; setPaused(false); });
  speed.addEventListener('input', syncControls);
  $('reset').addEventListener('click', () => void reset().catch(fail));
  coupling.addEventListener('change', () => void reset().catch(fail));
  contacts.addEventListener('change', () => { markers.visible = contacts.checked; dirty = readNeeded = true; });
  addEventListener('resize', fit); addEventListener('blur', release);
  document.addEventListener('visibilitychange', () => { release(); lastTime = 0; fpsStart = frames = simulatedSeconds = 0; });
  function fail(error: unknown) {
    failed = true; paused = true; release(); controlsUI.forEach(e => e.disabled = true);
    status.textContent = String(error); $('announcement').textContent = `Simulation stopped. ${String(error)}`; document.body.classList.add('error'); console.error(error);
  }
  async function inspect() {
    if (!world) return;
    inspecting = true;
    try {
      await world.read(); inputAngle += angleDelta(angleZ(bodies[0]), inputAngle);
      $('wheel-spokes').setAttribute('transform', `rotate(${-inputAngle * 180 / Math.PI} 50 50)`);
      wheel.setAttribute('aria-valuenow', String(Math.round(angleDelta(inputAngle, 0) * 180 / Math.PI)));
      wheel.setAttribute('aria-valuetext', `${rpm(drive.velocity).toFixed(1)} rpm. ${automatic ? 'Auto drive' : 'Manual control'}`);
      bodies.forEach((body, i) => {
        $(`label-${i}`).querySelector('.rate')!.textContent = `${rpm(i === 0 ? drive.velocity : body.angularVelocity[2]).toFixed(1)} rpm`;
      });
      if (contacts.checked && rendered) {
        const list = await world.solver.readContactList(); count = list.length;
        dots.forEach((dot, i) => {
          const contact = list[i]; dot.visible = !!contact;
          if (!contact) return;
          const body = bodies.find(b => b.index === contact.a)!;
          quat.fromArray(body.rotation); dot.position.fromArray(contact.rA).applyQuaternion(quat).add(new THREE.Vector3(...body.position));
          const load = clamp(Math.log1p(Math.abs(contact.lam[0])) / Math.log(51), 0, 1);
          dot.material.color.set(0x7fe5db).lerp(new THREE.Color(0xff704d), load);
          dot.scale.setScalar(.65 + load * 1.1);
        });
      }
      status.textContent = `${paused ? 'Paused' : automatic ? 'Auto drive' : 'Manual drive'} · ${coupling.checked ? 'SDF contacts on' : 'Contacts off — followers free'}${contacts.checked ? ` · ${count} points` : ''}${frameRate ? ` · ${frameRate.toFixed(0)} fps · ${simulationRate.toFixed(2)}× sim` : ''}`;
      dirty = true;
    } catch (error) { fail(error); }
    finally { inspecting = false; readNeeded = false; }
  }
  function frame(time: number) {
    if (disposed || failed) return;
    requestAnimationFrame(frame);
    try {
      if (document.hidden || busy || inspecting || !world) { lastTime = time; return; }
      const dt = lastTime ? Math.min((time - lastTime) / 1000, .05) : 0; lastTime = time;
      orbit.update();
      if (!paused && dt > 0) {
        drive.automatic = automatic; drive.target = manualTarget;
        drive.speed = direction * Number(speed.value) * 2 * Math.PI / 60;
        owed = Math.min(owed + dt, 4 * world.dt);
        while (owed >= world.dt) { drive.step(world.dt); world.step(); owed -= world.dt; simulatedSeconds += world.dt; }
        inputAngle = drive.angle; dirty = true; rendered = true;
      }
      if (dirty) { labels(); renderer.render(scene, camera); dirty = false; }
      if (!fpsStart) fpsStart = time;
      frames++;
      if (time - fpsStart > 1500) {
        frameRate = frames * 1000 / (time - fpsStart); simulationRate = simulatedSeconds * 1000 / (time - fpsStart);
        fpsStart = time; frames = simulatedSeconds = 0;
      }
      if (time - lastRead > 100 && (!paused || readNeeded)) { lastRead = time; void inspect(); }
    } catch (error) { fail(error); }
  }
  await reset(); fit(); syncControls(); document.body.classList.remove('loading');
  requestAnimationFrame(frame);
  const dispose = () => {
    disposed = true; orbit.dispose(); world?.destroy();
    meshes.forEach(m => m.dispose()); gears.forEach(g => g.geometry.dispose()); hardware.forEach(g => g.dispose());
    dotGeometry.dispose(); dots.forEach(d => d.material.dispose()); board.geometry.dispose(); board.material.dispose(); metal.dispose(); renderer.dispose();
  };
  addEventListener('pagehide', dispose, { once: true });
  if (import.meta.hot) import.meta.hot.dispose(dispose);
}
main().catch(error => { status.textContent = String(error); $('announcement').textContent = `Simulation stopped. ${String(error)}`; document.body.classList.add('error'); console.error(error); });
