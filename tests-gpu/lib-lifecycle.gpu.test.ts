import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { create } from 'webgpu';
import { BodyMesh, World } from '../src/lib/index.ts';
import type { SdfCollisionBridge } from '../src/avbd3d/gpu/sdf-bridge.ts';
import { gpuTest } from './device.ts';

// Exercise Three's actual buffer backend, cache and accounting on Dawn. Canvas drawing is
// deliberately outside this headless fixture; update(STORAGE) is the render binding path.
const load = (path: string) => import(`three/src/renderers/${path}.js`);
const [{ default: Backend }, { default: Attributes }, { default: Info }] = await Promise.all([
  load('webgpu/WebGPUBackend'), load('common/Attributes'), load('common/Info'),
]);
function rendererFor(device: GPUDevice) {
  const backend = new Backend();
  backend.device = device;
  const info = new Info();
  const attributes = new Attributes(backend, info);
  const renderer = { init: async () => {}, backend, _attributes: attributes, info };
  return { backend, attributes, info, renderer: renderer as unknown as THREE.WebGPURenderer };
}

gpuTest('renderer storage: 20 resets return to sibling baseline, either disposal order', async device => {
  const { renderer, backend, attributes, info } = rendererFor(device);
  const sibling = await World.create({ renderer, maxBodies: 8 });
  sibling.addBox({ size: [1, 1, 1] });
  sibling.step();
  attributes.update(sibling.bodyAttribute, 3);
  const baseline = info.memory.storageAttributesSize;
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardNodeMaterial();
  let geometryDisposals = 0, materialDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  for (let k = 0; k < 20; k++) {
    const world = await World.create({ renderer, maxBodies: 8 });
    world.addBox({ size: [1, 1, 1] });
    const meshes = ['box', 'sphere'].map(bodies => new BodyMesh(world, { bodies: bodies as 'box' | 'sphere', geometry, material }));
    attributes.update(world.bodyAttribute, 3);
    const storage = [world.bodyAttribute!, ...meshes.flatMap(mesh => {
      const { ids, colors } = mesh as unknown as { ids: THREE.StorageInstancedBufferAttribute; colors: THREE.StorageInstancedBufferAttribute };
      attributes.update(ids, 3);
      attributes.update(colors, 3);
      return [ids, colors];
    })];
    assert.equal(info.memory.storageAttributes, 6);
    if (k % 2) world.destroy();
    meshes.forEach(mesh => { mesh.geometry.dispose(); mesh.geometry.dispose(); });
    meshes.forEach(mesh => assert.throws(() => mesh.onBeforeRender(), /World destroyed|geometry was disposed/));
    world.destroy();
    world.destroy();
    assert.equal(info.memory.storageAttributes, 1);
    assert.equal(info.memory.storageAttributesSize, baseline);
    assert.ok(storage.every(attribute => !backend.has(attribute)), 'backend cache released');
  }
  assert.equal(geometryDisposals, 0, 'caller geometry stays owned by caller');
  assert.equal(materialDisposals, 0, 'caller material stays owned by caller');
  sibling.step();
  await sibling.read();
  sibling.destroy();
  assert.equal(info.memory.storageAttributes, 0);
  geometry.dispose();
  material.dispose();
});

gpuTest('renderer storage: never rendered and failed eager allocation release their buffers', async device => {
  const { renderer, backend, info } = rendererFor(device);
  const destroyed: object[] = [];
  const originalDestroy = backend.destroyAttribute.bind(backend);
  backend.destroyAttribute = (attribute: object) => { destroyed.push(attribute); originalDestroy(attribute); };
  const world = await World.create({ renderer, maxBodies: 8 });
  const mesh = new BodyMesh(world);
  world.destroy();
  mesh.geometry.dispose();
  assert.deepEqual(destroyed, [world.bodyAttribute], 'unbound mesh storage allocated no GPU buffers');
  assert.equal(info.memory.storageAttributes, 0);
  assert.throws(() => new BodyMesh(world), /World destroyed/);
  const createStorage = backend.createStorageAttribute.bind(backend);
  backend.createStorageAttribute = (attribute: object) => { createStorage(attribute); throw new Error('injected allocation failure'); };
  await assert.rejects(World.create({ renderer, maxBodies: 8 }), /injected allocation failure/);
  assert.equal(destroyed.length, 2, 'partial allocation released');
  assert.equal(info.memory.storageAttributes, 0);
  mesh.material.dispose();
});

gpuTest('automatic reads retain failures and ignore teardown rejection', async device => {
  const counterWorld = await World.create({ device, maxBodies: 8 });
  counterWorld.addBox({ size: [1, 1, 1] });
  counterWorld.solver.readCounters = async () => { throw new Error('counter map failed'); };
  for (let i = 0; i < 10; i++) counterWorld.step();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(counterWorld.error!.message, /counter map failed/);
  assert.throws(() => counterWorld.step(), /counter map failed/);
  await assert.rejects(counterWorld.read(), /counter map failed/);
  counterWorld.destroy();

  for (const destroy of [false, true]) {
    const world = await World.create({ device, maxBodies: 8 });
    world.addBox({ size: [1, 1, 1] });
    world.readbackEvery = 1;
    world.solver.readBodies = async () => { throw new Error('automatic body map failed'); };
    world.step();
    if (destroy) world.destroy();
    await new Promise(resolve => setImmediate(resolve));
    if (destroy) assert.equal(world.error, null);
    else assert.match(world.error!.message, /automatic body map failed/);
    world.destroy();
  }
});

gpuTest('device loss rejects in-flight reads and future work, fresh device recreation succeeds', async () => {
  const gpu = create([]);
  const adapter = await gpu.requestAdapter();
  assert.ok(adapter);
  const device = await adapter.requestDevice();
  const world = await World.create({ device, maxBodies: 8 });
  const body = world.addBox({ size: [1, 1, 1] })!;
  world.readbackEvery = 1;
  for (let i = 0; i < 10; i++) world.step();
  const pending = Promise.allSettled([world.read([body]), world.raycast([0, 5, 0], [0, -1, 0])]);
  device.destroy();
  await device.lost;
  const results = await pending;
  assert.ok(results.every(result => result.status === 'rejected'), 'pending read and ray reject on induced loss');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(world.error);
  assert.throws(() => world.step(), /lost|map|destroy|abort/i);
  await assert.rejects(world.read(), /lost|map|destroy|abort/i);
  await assert.rejects(world.raycast([0, 5, 0], [0, -1, 0]), /lost|map|destroy|abort/i);
  world.destroy();
  const replacementAdapter = await gpu.requestAdapter();
  assert.ok(replacementAdapter);
  const fresh = await replacementAdapter.requestDevice();
  const replacement = await World.create({ device: fresh, maxBodies: 8 });
  replacement.addBox({ size: [1, 1, 1] });
  replacement.step();
  await replacement.read();
  replacement.destroy();
  fresh.destroy();
});

// Paired qualification G0: losing the device while only the periodic counter map (every tenth
// step) is pending left an unhandled AbortError and a step that did not fail fast.
gpuTest('device loss during the periodic counter read is handled and fails fast', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => { rejections.push(reason); };
  process.on('unhandledRejection', onRejection);
  const adapter = await create([]).requestAdapter();
  assert.ok(adapter);
  const device = await adapter.requestDevice();
  try {
    const world = await World.create({ device, maxBodies: 8 });
    world.addBox({ size: [1, 1, 1] });
    assert.equal(world.readbackEvery, 0, 'no automatic body read: the counter map is the only one');
    const counterReads: Promise<unknown>[] = [];
    const readCounters = world.solver.readCounters.bind(world.solver);
    world.solver.readCounters = () => { const read = readCounters(); counterReads.push(read); return read; };
    for (let i = 0; i < 10; i++) world.step();
    assert.equal(counterReads.length, 1, 'tenth step submitted the counter read');
    device.destroy();
    await device.lost;
    await Promise.allSettled(counterReads);
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(rejections.map(String), [], 'no unhandled rejection');
    assert.ok(world.error, 'loss recorded on the world');
    assert.throws(() => world.step(), /lost|map|destroy|abort/i);
    await assert.rejects(world.read(), /lost|map|destroy|abort/i);
    world.destroy();
    world.destroy();
  } finally {
    process.off('unhandledRejection', onRejection);
  }
});

gpuTest('SDF automatic growth failure remains recoverable', async device => {
  const world = await World.create({ device, maxBodies: 4, gravity: [0, 0, 0], iterations: 0 });
  try {
    for (const x of [0, .2, .4, .6]) world.addSphere({ radius: .4, position: [x, 0, 0] });
    await world.enableSdfCollisions([], { cacheSize: 1, randomSamples: 0, alpha: 0 }, { maxPairs: 1 });
    const bridge = world.solver.activeCollisionBackend as SdfCollisionBridge;
    const grown = bridge.grown.bind(bridge);
    bridge.grown = () => { throw new Error('injected capacity limit'); };
    const read = world.solver.readCounters.bind(world.solver);
    let pending: ReturnType<typeof read> | undefined;
    world.solver.readCounters = () => pending = read();
    for (let i = 0; i < 10; i++) world.step();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.match(world.sdfCollisionError!.message, /capacity limit/);
    assert.equal(world.error, null);
    world.step();
    bridge.grown = grown;
    assert.equal(await world.adaptSdfCollisions(), true);
    assert.equal(world.sdfCollisionError, null);
    assert.equal(world.error, null);
    world.step();
  } finally { world.destroy(); }
});

gpuTest('SDF automatic counter read failure is fatal and handled', async device => {
  const world = await World.create({ device, maxBodies: 2, iterations: 0 });
  try {
    world.addSphere({ radius: .4 });
    await world.enableSdfCollisions([], { cacheSize: 1, randomSamples: 0, alpha: 0 });
    world.solver.readCounters = async () => { throw new Error('SDF counter map failed'); };
    for (let i = 0; i < 10; i++) world.step();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(world.error!.message, /SDF counter map failed/);
    assert.throws(() => world.step(), /SDF counter map failed/);
  } finally { world.destroy(); }
});

gpuTest('BodyMesh flushes staged bodies, hides disabled lives and clears replacement paint', async device => {
  const { renderer } = rendererFor(device);
  const world = await World.create({ renderer, maxBodies: 2 });
  const other = await World.create({ device, maxBodies: 1 });
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardNodeMaterial();
  const visible = new BodyMesh(world, { geometry, material });
  const debug = new BodyMesh(world, { geometry, includeDisabled: true });
  try {
    const a = world.addBox({ size: [1, 1, 1], position: [2, 3, 4] })!;
    const b = world.addBox({ size: [1, 1, 1], enabled: false })!;
    visible.setColor(a, 'red');
    visible.onBeforeRender(); debug.onBeforeRender();
    assert.equal(world.solver.bodyCount, 2, 'render flush uploads without a step/read');
    assert.equal(world.stepCount, 0);
    assert.equal((await world.solver.readBodies())[0], 2);
    assert.equal(visible.geometry.instanceCount, 1); assert.equal(debug.geometry.instanceCount, 2);
    b.setEnabled(true); visible.onBeforeRender(); assert.equal(visible.geometry.instanceCount, 2);
    a.setEnabled(false); a.reset(); a.setEnabled(true); visible.onBeforeRender();
    const colors = (visible as unknown as { colors: THREE.StorageInstancedBufferAttribute }).colors.array;
    assert.equal(colors[3], 1, 'same-life paint retained');
    a.remove(); const replacement = world.addBox({ size: [1, 1, 1] })!;
    assert.throws(() => visible.setColor(a, 'blue'), /removed/);
    visible.onBeforeRender(); assert.equal(colors[3], 0, 'replacement gets default paint');
    const foreign = other.addBox({ size: [1, 1, 1] })!;
    assert.throws(() => visible.setColor(foreign, 'blue'), /another world/);
    const explicit = new BodyMesh(world, { geometry, bodies: [a, foreign, replacement] });
    explicit.onBeforeRender(); assert.equal(explicit.geometry.instanceCount, 1);
    explicit.geometry.dispose(); explicit.material.dispose();
  } finally {
    visible.geometry.dispose(); debug.geometry.dispose(); world.destroy(); other.destroy();
    geometry.dispose(); material.dispose(); debug.material.dispose();
  }
});
