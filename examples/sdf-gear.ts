// Two meshing gears with baked SDF collisions. The input gear is kinematic (a fixed body moved
// with moveTo each step); the follower turns only because the teeth push it.
// Installed projects import these same public entries from 'three-avbd' and 'three-avbd/sdf'.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { BodyMesh, World, recommendedLimits, type Vec3 } from '../src/lib/index.ts';
import { bakeVoxelSdfAsync, finalizeSdf } from '../src/lib/sdf.ts';

const status = document.getElementById('status')!;
const MODULE = .15, DEPTH = .32, INPUT_TEETH = 24, OUTPUT_TEETH = 16;
const DISTANCE = MODULE * (INPUT_TEETH + OUTPUT_TEETH) / 2; // sum of the pitch radii
const CENTERS: Vec3[] = [[-DISTANCE / 2, 0, 0], [DISTANCE / 2, 0, 0]];
const rotationZ = (a: number): [number, number, number, number] => [0, 0, Math.sin(a / 2), Math.cos(a / 2)];

/** A closed involute gear outline (a little backlash leaves room for voxel interpolation). */
function gearShape(teeth: number) {
  const pitch = MODULE * teeth / 2, base = pitch * Math.cos(25 * Math.PI / 180);
  const root = Math.max(base, pitch - 1.25 * MODULE), tip = pitch + MODULE;
  const inv = (r: number) => { const t = Math.sqrt(Math.max(0, (r / base) ** 2 - 1)); return t - Math.atan(t); };
  const flank = (r: number) => Math.PI / (2 * teeth) - .012 / pitch + inv(pitch) - inv(r);
  const points: [number, number][] = [];
  const point = (r: number, a: number) => points.push([r * Math.cos(a), r * Math.sin(a)]);
  for (let k = 0; k < teeth; k++) {
    const a = k * 2 * Math.PI / teeth; // tooth k is centred on this angle
    point(pitch - 1.25 * MODULE, a - Math.PI / teeth); // the gap between teeth
    for (let j = 0; j <= 8; j++) { const r = root + (tip - root) * j / 8; point(r, a - flank(r)); }
    for (let j = 8; j >= 0; j--) { const r = root + (tip - root) * j / 8; point(r, a + flank(r)); }
  }
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: DEPTH, bevelEnabled: false });
  geometry.translate(0, 0, -DEPTH / 2); // centred on the body origin
  return geometry;
}

async function prepare(teeth: number) {
  const geometry = gearShape(teeth);
  // 1. Bake the closed mesh into a voxel SDF (async: yields between slices, still on this thread).
  const baked = await bakeVoxelSdfAsync(geometry, { resolution: 80 });
  if (!baked.watertight) throw new Error(`Gear bake: ${baked.warnings.join(', ')}`);
  // 2. Integrate volume, centre of mass and inertia, and choose curvature seeds for contacts.
  const props = finalizeSdf(baked.field, { candidateCount: 1200 });
  const com = props.centerOfMass;
  geometry.translate(-com[0], -com[1], -com[2]); // render geometry must share the field's COM frame
  // A symmetric gear's principal axes are x/y/z, so the tensor's diagonal is the principal moments.
  // (For a general mesh use principalInertia(); see sdf-from-mesh.ts.)
  const density = 1; // the library default (kg/m³), as in the sdf-gears demo
  const massProperties = { mass: props.volume * density, moments: [0, 4, 8].map(i => props.inertia[i] * density) as Vec3 };
  return { geometry, field: baked.field, massProperties };
}

const renderer = new THREE.WebGPURenderer({ antialias: true, requiredLimits: await recommendedLimits() });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x101216);
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, .1, 100);
camera.position.set(0, -2, 7);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xdde8ff, 0x302820, 2));
const sun = new THREE.DirectionalLight(0xffffff, 2.5);
sun.position.set(-3, 5, 8);
scene.add(sun);

const gears = [await prepare(INPUT_TEETH), await prepare(OUTPUT_TEETH)];
status.textContent = 'Starting…';
const world = await World.create({ renderer, maxBodies: 4, gravity: [0, 0, 0], iterations: 20, dt: 1 / 120 });

// The follower starts half a tooth turned so the teeth interleave instead of overlapping.
const angles = [0, Math.PI - Math.PI / OUTPUT_TEETH];
const support = world.addBox({ size: [1, 1, 1], fixed: true, collidesWith: 0, group: 0 })!;
const [input, output] = gears.map((gear, i) => world.addBox({
  size: [1, 1, 1], // a unit proxy box: BodyMesh scales the gear geometry by this size
  position: CENTERS[i], rotation: rotationZ(angles[i]), fixed: i === 0,
  massProperties: gear.massProperties, friction: .05,
})!);
// Two ball joints along z make an axle: the follower can only spin about z.
for (const z of [-.65, .65]) world.addJoint(support, output, { type: 'ball', anchorA: [CENTERS[1][0], 0, z], anchorB: [0, 0, z] });

// 3. Switch the world to SDF collisions, binding each gear body to its baked field.
//    These contact settings follow the sdf-gears demo; library defaults also work but are looser.
await world.enableSdfCollisions([{ body: input, field: gears[0].field }, { body: output, field: gears[1].field }], {
  cacheSize: 4, randomSamples: 1, maxIterations: 60, tolerance: .001, epsilon: .0004,
  margin: .008, allowedPenetration: .001, alpha: .001, meshVertexContacts: true, refreshDeeperContacts: true,
});

const colors = [0xeac46a, 0x74bed0];
gears.forEach((gear, i) => scene.add(new BodyMesh(world, { bodies: [[input, output][i]], geometry: gear.geometry,
  material: new THREE.MeshStandardNodeMaterial({ color: colors[i], metalness: .4, roughness: .35 }) })));

const SPEED = 2 * Math.PI / 10; // input: one turn every ten seconds
let angle = 0, owed = 0, reading = false, last = performance.now();
renderer.setAnimationLoop((time: number) => {
  owed = Math.min(owed + (time - last) / 1000, 4 * world.dt);
  last = time;
  while (owed >= world.dt) {
    angle += SPEED * world.dt;
    input.moveTo(CENTERS[0], rotationZ(angles[0] + angle)); // kinematic drive, keeps contacts warm
    world.step();
    owed -= world.dt;
  }
  if (!reading) {
    reading = true;
    // Read back only the follower, a few times a second, for the ratio readout.
    void world.read([output]).then(() => {
      const ratio = output.angularVelocity[2] / SPEED;
      status.textContent = `input ${(SPEED * 60 / (2 * Math.PI)).toFixed(1)} rpm · output ${(output.angularVelocity[2] * 60 / (2 * Math.PI)).toFixed(1)} rpm · ratio ${ratio.toFixed(2)}`;
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
