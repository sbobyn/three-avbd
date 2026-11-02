// Mesh -> worker bake -> mass properties -> World SDF collisions.
// Installed projects import these same public entries from 'three-avbd' and 'three-avbd/sdf'.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { BodyMesh, World, recommendedLimits, type Quat } from '../src/lib/index.ts';
import { bakeVoxelSdfInWorker, finalizeSdf, principalInertia } from '../src/lib/sdf.ts';

const status = document.getElementById('status')!;
const log = (line: string) => { status.textContent += `\n${line}`; };

// 1. Any closed, consistently wound triangle mesh. A glTF works the same way (take its
//    geometry's position/index arrays). Procedural meshes repeat seam vertices, so weld them.
let knot: THREE.BufferGeometry = new THREE.TorusKnotGeometry(.45, .14, 128, 16);
knot.deleteAttribute('normal'); knot.deleteAttribute('uv');
knot = mergeVertices(knot, 1e-4);

// 2. Bake in a module worker so the page stays responsive. The caller owns the worker.
const worker = new Worker(new URL('./sdf-worker.ts', import.meta.url), { type: 'module' });
const started = performance.now();
const baked = await bakeVoxelSdfInWorker(worker, {
  positions: knot.getAttribute('position').array, indices: knot.getIndex()!.array,
}, { resolution: 48, onProgress: f => { status.textContent = `Baking in a worker… ${Math.round(f * 100)}%`; } })
  .finally(() => worker.terminate()); // terminate only after the job settles
status.textContent = `Baked 48³ in ${((performance.now() - started) / 1000).toFixed(2)} s`;
if (!baked.watertight) log('mesh is not watertight: expect a poor field');
if (baked.warnings.length) log(`warnings: ${baked.warnings.join(', ')}`);

// 3. Unit-density volume, centre of mass and full inertia tensor, plus curvature seeds.
const field = baked.field;
const props = finalizeSdf(field, { candidateCount: 1000 });
// Diagonalise the tensor. rotation maps principal axes into the mesh's axes.
const principal = principalInertia(props.inertia);
const density = 1; // the library default (kg/m³)
const massProperties = { mass: props.volume * density, moments: principal.moments.map(m => m * density) as [number, number, number] };
log(`volume ${props.volume.toFixed(3)} m³ · mass ${massProperties.mass.toFixed(2)} kg`);
log(`principal moments ${massProperties.moments.map(m => m.toFixed(3)).join(', ')} kg·m²`);

// 4. Put the field and the render geometry in the body's principal frame:
//    centred on the COM, then rotated by the inverse of the principal rotation.
const toPrincipal = new THREE.Quaternion(...principal.rotation).invert();
const fieldRotation = toPrincipal.toArray() as Quat;
const com = props.centerOfMass;
knot.translate(-com[0], -com[1], -com[2]);
knot.applyQuaternion(toPrincipal);
knot.computeVertexNormals();

const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: await recommendedLimits() });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101216);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, .1, 100);
camera.position.set(4, 4, 6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 1.8));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(3, 8, 4);
sun.castShadow = true;
scene.add(sun);

const world = await World.create({ renderer, maxBodies: 16, iterations: 12 });
world.maxSubsteps = 2;
const floor = world.addBox({ size: [10, 1, 10], position: [0, -.5, 0], fixed: true })!;
const knots = [];
for (let i = 0; i < 8; i++) {
  // The body's rotation is the pose you want for the mesh, times the principal rotation.
  const pose = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * .7, i * 1.3, i * .4));
  knots.push(world.addBox({
    size: [1, 1, 1], // proxy box; BodyMesh scales the geometry by it, so keep it 1
    position: [(i % 2 - .5) * .6, 1.2 + i * 1.7, (Math.floor(i / 2) % 2 - .5) * .6],
    rotation: pose.multiply(new THREE.Quaternion(...principal.rotation)).toArray() as Quat,
    massProperties, // without this, mass and inertia would come from the 1 m proxy box
    friction: .5,
  })!);
}
// 5. Bind the baked field to every knot (the floor gets an analytic box field automatically).
await world.enableSdfCollisions(knots.map(body => ({ body, field, rotation: fieldRotation })));
log(`${knots.length} knots · SDF collisions on`);

const knotMesh = new BodyMesh(world, { bodies: knots, geometry: knot,
  material: new THREE.MeshStandardNodeMaterial({ color: 0x8e9fe0, roughness: .35, metalness: .2 }) });
const floorMesh = new BodyMesh(world, { bodies: [floor], material: new THREE.MeshStandardNodeMaterial({ color: 0x2b3640, roughness: .9 }) });
knotMesh.castShadow = true;
floorMesh.receiveShadow = knotMesh.receiveShadow = true;
scene.add(knotMesh, floorMesh);

renderer.setAnimationLoop(() => {
  world.update(1 / 60);
  controls.update();
  renderer.render(scene, camera);
});
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
Object.assign(window, { world });
