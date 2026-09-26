// three-avbd's smallest example: a pyramid of boxes, spheres raining on it, and a chain of boxes
// on joints that break when pulled too hard. Everything is drawn straight from the GPU.

import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BodyMesh, World } from '../src/lib/index.ts';

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101216);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500);
camera.position.set(18, 12, 22);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 3, 0);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(10, 20, 8);
sun.castShadow = true;
sun.shadow.camera.left = sun.shadow.camera.bottom = -20;
sun.shadow.camera.right = sun.shadow.camera.top = 20;
scene.add(sun);

const world = await World.create({ renderer, maxBodies: 4000 });

// The ground, and a pyramid of boxes
world.addBox({ size: [40, 1, 40], position: [0, -0.5, 0], fixed: true });
for (let row = 0; row < 12; row++) {
  for (let i = 0; i < 12 - row; i++) world.addBox({ size: [1, 1, 1], position: [i - (11 - row) / 2, 0.5 + row, 0] });
}
// A chain of boxes hanging from a fixed block, its links breaking past 150 N
let link = world.addBox({ size: [1, 1, 1], position: [-8, 12, 0], fixed: true })!;
for (let k = 1; k <= 8; k++) {
  const next = world.addBox({ size: [0.6, 0.9, 0.6], position: [-8, 12 - k, 0] })!;
  world.addJoint(link, next, { anchorA: [0, -0.5, 0], anchorB: [0, 0.45, 0], breakForce: 150, breakOnPull: true });
  link = next;
}

const boxes = new BodyMesh(world, { bodies: 'box', material: new THREE.MeshStandardNodeMaterial({ color: 0xd9c9a8, roughness: 0.7 }) });
const spheres = new BodyMesh(world, { bodies: 'sphere', material: new THREE.MeshStandardNodeMaterial({ color: 0xc8553d, roughness: 0.4 }) });
boxes.castShadow = boxes.receiveShadow = spheres.castShadow = spheres.receiveShadow = true;
scene.add(boxes, spheres);

// Spheres raining down, the oldest taken out as new ones come
const rain: ReturnType<World['addSphere']>[] = [];
let wait = 0;
world.readbackEvery = 30;
world.onBreak((joint) => boxes.setColor(joint.b, 0xffb020));

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  wait -= dt;
  if (wait <= 0) {
    wait = 0.15;
    rain.push(world.addSphere({ radius: 0.35 + Math.random() * 0.3, position: [(Math.random() - 0.5) * 12, 18, (Math.random() - 0.5) * 6], density: 3 }));
    if (rain.length > 300) rain.shift()?.remove();
  }
  world.update(dt);
  controls.update();
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
Object.assign(window, { world });
