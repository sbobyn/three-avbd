// A standalone consumer: imports only the installed package and Three.js.
import * as THREE from 'three/webgpu';
import { BodyMesh, World } from 'three-avbd';

let renderer;
let world;
try {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a hardware WebGPU browser on localhost or HTTPS.');
  renderer = new THREE.WebGPURenderer({ antialias: true });
  const pixelRatio = () => Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? Math.min(devicePixelRatio, 2) : 1;
  renderer.setPixelRatio(pixelRatio());
  renderer.setSize(innerWidth, innerHeight);
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17202b);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(7, 5, 9);
  camera.lookAt(0, 1, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 3));

  world = await World.create({ renderer, maxBodies: 64, iterations: 10 });
  world.addBox({ size: [12, 1, 12], position: [0, -0.5, 0], fixed: true, friction: 0.6 });
  const crate = world.addBox({ size: [1, 1, 1], position: [0, 3, 0], friction: 0.6 });
  const ball = world.addSphere({ radius: 0.5, position: [1.5, 5, 0], density: 3 });
  if (!crate || !ball) throw new Error('Body capacity exhausted');
  scene.add(new BodyMesh(world, { bodies: 'box', material: new THREE.MeshStandardNodeMaterial({ color: 0xd9b57a }) }));
  scene.add(new BodyMesh(world, { bodies: 'sphere', material: new THREE.MeshStandardNodeMaterial({ color: 0x68b8ed }) }));
  const button = document.createElement('button');
  button.textContent = 'Kick the crate';
  button.style.cssText = 'position:fixed;top:16px;left:16px;padding:12px';
  button.onclick = () => crate.applyImpulse([0, 5, 0]);
  document.body.append(button);
  let previous = null;
  document.addEventListener('visibilitychange', () => { previous = null; });
  renderer.setAnimationLoop((now) => {
    if (document.hidden || !Number.isFinite(now)) { previous = null; return; }
    const dt = previous === null ? 0 : Math.max(0, Math.min((now - previous) / 1000, 0.1));
    previous = now;
    world.update(dt);
    renderer.render(scene, camera);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(innerWidth, innerHeight);
  });
  // Useful for inspecting async state in DevTools; never read back every frame just to draw.
  Object.assign(window, { world, crate, ball });
} catch (error) {
  // Only resources created by this example are retired; never reload user state to recover.
  try { world?.destroy(); } catch (cleanupError) { console.error(cleanupError); }
  try { renderer?.dispose(); } catch (cleanupError) { console.error(cleanupError); }
  renderer?.domElement.remove();
  const message = document.createElement('pre');
  message.textContent = `AVBD could not start: ${error instanceof Error ? error.message : String(error)}`;
  document.body.append(message);
  console.error(error);
}
