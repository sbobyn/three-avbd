// A non-convex container from an analytic SDF: a fixed torus lying on the floor, with balls dropped
// into its hole. Installed projects import 'three-avbd' and 'three-avbd/sdf'.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BodyMesh, World, recommendedLimits, type Body, type Vec3 } from '../src/lib/index.ts';
import { AnalyticField, curvatureSeeds } from '../src/lib/sdf.ts';
import { releaseRenderer, requireWebGpu, startExample } from './startup.ts';

const status = document.getElementById('status')!;
const MAJOR = 1.4, MINOR = .35, BALL = .16, COUNT = 40;
const HOLE = MAJOR - MINOR; // radius of the empty middle at floor level

const startup = startExample(status);
try {
  requireWebGpu();
  const renderer = startup.own(new THREE.WebGPURenderer({ antialias: true, requiredLimits: await recommendedLimits() }), releaseRenderer);
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  document.body.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101216);
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, .1, 100);
  camera.position.set(3.5, 4.5, 5);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, .5, 0);
  scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.5);
  sun.position.set(3, 8, 4);
  sun.castShadow = true;
  scene.add(sun);

  const world = startup.own(await World.create({ renderer, maxBodies: COUNT + 4, iterations: 12 }), w => w.destroy());
  world.maxSubsteps = 2;
  const floor = world.addBox({ size: [10, 1, 10], position: [0, -.5, 0], fixed: true })!;

  // The torus field's axis is y, so the ring lies flat. Its body is a unit proxy box: with SDF
  // collisions on, the bound field replaces the box shape for collisions (not for mass; it is fixed).
  const torusField = new AnalyticField({ kind: 'torus', majorRadius: MAJOR, minorRadius: MINOR });
  torusField.seeds = curvatureSeeds(torusField, { candidateCount: 500 }); // contact search starting points
  const ring = world.addBox({ size: [1, 1, 1], position: [0, MINOR, 0], fixed: true })!;

  // Balls in 3 x 3 layers above the hole (no initial overlaps), every column inside the hole.
  const start = (i: number): Vec3 => {
    const layer = Math.floor(i / 9), shift = layer % 2 ? .1 : -.1;
    return [(i % 3 - 1) * .4 + shift, 1.2 + layer * .4, (Math.floor(i / 3) % 3 - 1) * .4 + shift];
  };
  const balls: Body[] = [];
  for (let i = 0; i < COUNT; i++) balls.push(world.addSphere({ radius: BALL, position: start(i), friction: .4 })!);

  // Bind the torus explicitly; the floor box and the spheres get analytic fields automatically.
  await world.enableSdfCollisions([{ body: ring, field: torusField }]);

  const ringGeometry = new THREE.TorusGeometry(MAJOR, MINOR, 24, 64);
  ringGeometry.rotateX(Math.PI / 2); // three.js tori lie in xy; the field's lies in xz
  const ringMesh = new BodyMesh(world, { bodies: [ring], geometry: ringGeometry,
    material: new THREE.MeshStandardNodeMaterial({ color: 0x68c2bc, roughness: .35, metalness: .2 }) });
  const floorMesh = new BodyMesh(world, { bodies: [floor], material: new THREE.MeshStandardNodeMaterial({ color: 0x2b3640, roughness: .9 }) });
  const ballMesh = new BodyMesh(world, { bodies: 'sphere', material: new THREE.MeshStandardNodeMaterial({ color: 0xe3ad60, roughness: .4 }) });
  ringMesh.castShadow = ballMesh.castShadow = true;
  floorMesh.receiveShadow = ringMesh.receiveShadow = true;
  scene.add(ringMesh, floorMesh, ballMesh);

  document.getElementById('again')!.addEventListener('click', () => {
    // set() moves bodies in place: no topology change, so no SDF refresh. (Body.reset() and
    // setEnabled() are unavailable while SDF collisions are on; see world.capabilities.)
    balls.forEach((ball, i) => ball.set({ position: start(i), velocity: [0, 0, 0], angularVelocity: [0, 0, 0] }));
  });

  let reading = false;
  await renderer.setAnimationLoop(() => {
    world.update(1 / 60);
    if (!reading) {
      reading = true;
      void world.read(balls).then(() => {
        // "Inside" means the ball's centre is within the hole, below the top of the ring.
        const inside = balls.filter(b => Math.hypot(b.position[0], b.position[2]) < HOLE && b.position[1] < 2 * MINOR).length;
        const above = balls.filter(b => b.position[1] >= 2 * MINOR).length;
        status.textContent = `${inside} inside the ring · ${above} above the rim · ${COUNT - inside - above} escaped`;
        setTimeout(() => { reading = false; }, 250);
      });
    }
    controls.update();
    renderer.render(scene, camera);
  });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  Object.assign(window, { world });
} catch (error) {
  await startup.fail(error);
}
