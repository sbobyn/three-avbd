// A standalone consumer: imports only the installed package and Three.js.
import * as THREE from 'three/webgpu';
import { BodyMesh, World } from 'three-avbd';

try {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable. Use a hardware WebGPU browser on localhost or HTTPS.');
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x17202b);
  const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(7, 5, 9);
  camera.lookAt(0, 1, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 3));

  const world = await World.create({ renderer, maxBodies: 64, iterations: 10 });
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
  let previous = performance.now();
  renderer.setAnimationLoop((now) => {
    const dt = Math.min((now - previous) / 1000, 0.1);
    previous = now;
    if (document.hidden) return;
    world.update(dt);
    renderer.render(scene, camera);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  // Useful for inspecting async state in DevTools; never read back every frame just to draw.
  Object.assign(window, { world, crate, ball });
} catch (error) {
  const message = document.createElement('pre');
  message.textContent = `AVBD could not start: ${error.message}`;
  document.body.append(message);
  console.error(error);
}
