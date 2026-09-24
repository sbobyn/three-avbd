// Three.js (WebGPU) renderer for the 3D solvers: instanced lit boxes with shadow mapping under
// a hazy sky, joint/spring lines, contact points and the mouse-drag line. Z is up, as in
// avbd-demo3d. Instances are rewritten from solver state each frame, fine for the CPU
// reference; the GPU solver's bodies are drawn straight from its buffer (gpu-bodies3d.ts).

import { color, mix, normalize, positionGeometry, positionLocal, smoothstep, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import type { Sim3D } from '../avbd3d/sim.ts';
import { GpuBodies3D, Shape } from './gpu-bodies3d.ts';
import { BLOCK_PALETTE, edgeShade, FLOOR_EXTENT, floorChecker, isFloorSize, LOOK, SPHERE_PALETTE } from './look.ts';

/** Integer hash (lowbias32) for picking a body's palette colour on the CPU path. */
function hashIndex(i: number): number {
  let x = i >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Instanced mesh that grows (by replacement) when more instances are needed. */
class Instances {
  mesh: THREE.InstancedMesh;
  private capacity = 0;
  private readonly scene: THREE.Scene;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly shadows: boolean;

  constructor(scene: THREE.Scene, geometry: THREE.BufferGeometry, material: THREE.Material, shadows: boolean) {
    this.scene = scene;
    this.geometry = geometry;
    this.material = material;
    this.shadows = shadows;
    this.mesh = this.allocate(256);
  }

  private allocate(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false;
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.count = 0;
    this.capacity = capacity;
    this.scene.add(mesh);
    return mesh;
  }

  reserve(n: number): void {
    if (n <= this.capacity) return;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.allocate(Math.max(n, this.capacity * 2));
  }
}

export class Renderer3D {
  readonly renderer: THREE.WebGPURenderer;
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  readonly scene = new THREE.Scene();
  showContacts = true;
  showJoints = true;
  /** Cast shadows (the shadow pass draws every body a second time). */
  shadows = true;
  selected = -1;
  /** World-space drag line (anchor on the body, then the target), or null. */
  dragLine: [ArrayLike<number>, ArrayLike<number>] | null = null;

  private gpuBodies: GpuBodies3D | null = null;
  /** Body count the GPU meshes' index lists were built for. */
  private gpuBodiesShown = -1;
  private readonly boxes: Instances;
  private readonly floors: Instances;
  private readonly contacts: Instances;
  private readonly sky: THREE.Mesh;
  private readonly fog: THREE.Fog;
  /** Camera distance the fog, shadows and far plane are set for (setViewScale). */
  private viewScale = 50;
  private readonly lines: THREE.LineSegments;
  private linePositions = new Float32Array(0);
  private readonly light = new THREE.DirectionalLight(LOOK.sun, LOOK.sunIntensity);
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly color = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, requiredLimits?: Record<string, number>) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, requiredLimits });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.background = new THREE.Color(LOOK.skyHorizon);
    this.camera.up.set(0, 0, 1);

    // Sky: a dome following the camera, pale blue overhead fading to a warm white haze at the
    // horizon, which the fog matches so the floor dissolves into it
    const skyMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    skyMaterial.colorNode = mix(color(LOOK.skyHorizon), color(LOOK.skyZenith), smoothstep(0.02, 0.6, normalize(positionLocal).z));
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), skyMaterial);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    this.fog = new THREE.Fog(LOOK.skyHorizon, 60, 300);
    this.scene.fog = this.fog;

    this.scene.add(new THREE.HemisphereLight(LOOK.skyLight, LOOK.groundLight, LOOK.hemisphereIntensity));
    const light = this.light;
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    this.scene.add(light, light.target);
    this.setViewScale(50);

    // CPU path: instance colours carry the palette; the edge shading multiplies them
    const blockMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.72, metalness: 0 });
    blockMaterial.colorNode = vec3(edgeShade(positionGeometry, vec3(1)));
    this.boxes = new Instances(this.scene, new THREE.BoxGeometry(1, 1, 1), blockMaterial, true);
    const floorMaterial = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
    floorMaterial.colorNode = floorChecker();
    this.floors = new Instances(this.scene, new THREE.BoxGeometry(1, 1, 1), floorMaterial, true);
    this.contacts = new Instances(this.scene, new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshBasicNodeMaterial({ color: LOOK.contact, depthTest: false }), false);
    this.contacts.mesh.renderOrder = 2;

    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicNodeMaterial({ vertexColors: true, depthTest: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.scene.add(this.lines);
  }

  async init(): Promise<void> {
    await this.renderer.init();
  }

  get isWebGPU(): boolean {
    return (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  }

  /** The renderer's GPUDevice (WebGPU backend only), shared with the GPU solver. */
  get device(): GPUDevice | null {
    return this.isWebGPU ? (this.renderer.backend as unknown as { device: GPUDevice }).device : null;
  }

  /**
   * Switch to drawing `count` bodies straight from a GPU body buffer; returns that buffer for
   * the solver to write into.
   */
  attachGpuBodies(count: number): GPUBuffer {
    this.detachGpuBodies();
    this.gpuBodies = new GpuBodies3D(count);
    this.gpuBodiesShown = -1;
    this.scene.add(this.gpuBodies.group);
    return this.gpuBodies.gpuBuffer(this.renderer);
  }

  detachGpuBodies(): void {
    this.gpuBodies?.dispose();
    this.gpuBodies = null;
  }

  /**
   * Size the fog, shadow frustum and far plane for a view at `distance` from its target, so a
   * 40 m wall and a 160 m ring both fade into the haze and keep crisp shadows up close.
   */
  setViewScale(distance: number): void {
    this.viewScale = distance;
    this.fog.near = distance * 0.9;
    this.fog.far = distance * 4.5;
    this.camera.far = distance * 12;
    this.camera.updateProjectionMatrix();
    const cam = this.light.shadow.camera;
    const extent = Math.max(20, distance * 0.9);
    cam.left = cam.bottom = -extent;
    cam.right = cam.top = extent;
    cam.near = 1;
    cam.far = distance * 6;
    cam.updateProjectionMatrix();
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Keep the shadow frustum centred under the camera target, with the key light high and
   * over the camera's left shoulder, so the faces in view are lit and shadows fall away.
   */
  private placeLight(target: THREE.Vector3): void {
    const view = Math.atan2(this.camera.position.y - target.y, this.camera.position.x - target.x);
    const a = view + 0.9;
    // A warm, fairly low sun (about 40° up) for long soft shadows, as in the project's renders
    const d = this.viewScale * 1.5;
    this.light.target.position.set(target.x, target.y, 0);
    this.light.position.set(target.x + d * Math.cos(a), target.y + d * Math.sin(a), d * 0.85);
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.9);
  }

  render(sim: Sim3D, target: THREE.Vector3): void {
    this.placeLight(target);
    this.light.castShadow = this.shadows;
    if (this.gpuBodies) {
      if (sim.bodyCount !== this.gpuBodiesShown) {
        this.gpuBodies.setBodies(sim.bodyCount, (i) => this.shapeOf(sim, i));
        this.gpuBodiesShown = sim.bodyCount;
      }
      this.gpuBodies.selected.value = this.selected >= 0 ? this.selected : 0xffffffff;
      this.boxes.mesh.count = 0;
      this.floors.mesh.count = 0;
    } else {
      this.drawBodies(sim);
    }
    this.drawForces(sim);
    this.renderer.render(this.scene, this.camera);
  }

  private shapeOf(sim: Sim3D, i: number): Shape {
    if (sim.isSphere?.(i)) return Shape.Sphere;
    return !sim.isDynamic(i) && isFloorSize(sim.size(i)) ? Shape.Floor : Shape.Box;
  }

  private drawBodies(sim: Sim3D): void {
    const n = sim.bodyCount;
    this.boxes.reserve(n);
    this.floors.reserve(n);
    const [boxes, floors] = [this.boxes.mesh, this.floors.mesh];
    let [b, f] = [0, 0];
    for (let i = 0; i < n; i++) {
      const p = sim.position(i);
      const q = sim.orientation(i);
      const s = sim.size(i);
      this.position.set(p[0], p[1], p[2]);
      this.quaternion.set(q[0], q[1], q[2], q[3]);
      this.scale.set(s[0], s[1], s[2]);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      if (this.shapeOf(sim, i) === Shape.Floor) {
        // Drawn on to the horizon, as the GPU path does
        this.scale.set(FLOOR_EXTENT, FLOOR_EXTENT, s[2]);
        floors.setMatrixAt(f++, this.matrix.compose(this.position, this.quaternion, this.scale));
        continue;
      }
      const h = hashIndex(i);
      const paint = sim.isSphere?.(i) ? SPHERE_PALETTE[h % SPHERE_PALETTE.length] : BLOCK_PALETTE[h % BLOCK_PALETTE.length];
      this.color.setHex(i === this.selected ? LOOK.selected : sim.isDynamic(i) ? paint : LOOK.static);
      if (i !== this.selected && sim.isDynamic(i)) this.color.multiplyScalar(0.92 + 0.16 * ((hashIndex(i + 7919) & 0xffff) / 0xffff));
      boxes.setMatrixAt(b, this.matrix);
      boxes.setColorAt(b++, this.color);
    }
    boxes.count = b;
    floors.count = f;
    boxes.instanceMatrix.needsUpdate = true;
    boxes.instanceColor!.needsUpdate = true;
    floors.instanceMatrix.needsUpdate = true;
  }

  private readonly segments: number[] = [];
  private readonly points: number[] = [];

  private drawForces(sim: Sim3D): void {
    const segments = this.segments;
    const points = this.points;
    segments.length = 0;
    points.length = 0;
    if (this.showJoints || this.showContacts) sim.debugGeometry(segments, points);
    if (!this.showJoints) segments.length = 0;
    if (!this.showContacts) points.length = 0;
    const jointVerts = segments.length / 3;
    if (this.dragLine) segments.push(...Array.from(this.dragLine[0]), ...Array.from(this.dragLine[1]));

    // Lines: positions then colours, interleaved into two attributes
    const verts = segments.length / 3;
    if (this.linePositions.length < segments.length) {
      const size = Math.max(segments.length, this.linePositions.length * 2, 96);
      this.linePositions = new Float32Array(size);
      this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
      this.lines.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(size), 3));
    }
    this.linePositions.set(segments);
    const colors = this.lines.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (colors) {
      const joint = this.color.setHex(LOOK.joint).toArray();
      const drag = new THREE.Color(LOOK.drag).toArray();
      for (let v = 0; v < verts; v++) (colors.array as Float32Array).set(v < jointVerts ? joint : drag, v * 3);
      colors.needsUpdate = true;
    }
    this.lines.geometry.setDrawRange(0, verts);
    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    this.lines.visible = verts > 0;

    const count = points.length / 3;
    this.contacts.reserve(count);
    const mesh = this.contacts.mesh;
    for (let i = 0; i < count; i++) {
      this.matrix.makeTranslation(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
