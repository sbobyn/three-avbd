// Three.js (WebGPU) renderer for the 3D solvers: instanced lit boxes with shadow mapping,
// joint/spring lines, contact points and the mouse-drag line. Z is up, as in avbd-demo3d.
// Instances are rewritten from solver state each frame, fine for the CPU reference.

import * as THREE from 'three/webgpu';
import type { Sim3D } from '../avbd3d/sim.ts';
import { GpuBodies3D } from './gpu-bodies3d.ts';

const COLORS = {
  background: 0xe9ecef,
  dynamic: 0xccd6e6, // the demo's (0.80, 0.84, 0.90)
  static: 0x8f959c,
  selected: 0xe0a33a,
  joint: 0xbf0000,
  contact: 0xbf0000,
  drag: 0xe0a33a,
};

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
  private readonly contacts: Instances;
  private readonly lines: THREE.LineSegments;
  private linePositions = new Float32Array(0);
  private readonly light = new THREE.DirectionalLight(0xffffff, 2.2);
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
    this.scene.background = new THREE.Color(COLORS.background);
    this.camera.up.set(0, 0, 1);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6d737a, 1.2));
    const light = this.light;
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    light.shadow.bias = -0.0005;
    light.shadow.normalBias = 0.02;
    const cam = light.shadow.camera;
    cam.left = cam.bottom = -35;
    cam.right = cam.top = 35;
    cam.near = 1;
    cam.far = 200;
    this.scene.add(light, light.target);

    this.boxes = new Instances(this.scene, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 }), true);
    this.contacts = new Instances(this.scene, new THREE.BoxGeometry(0.08, 0.08, 0.08), new THREE.MeshBasicNodeMaterial({ color: COLORS.contact, depthTest: false }), false);
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
    this.gpuBodies = new GpuBodies3D(count, COLORS);
    this.gpuBodiesShown = -1;
    this.scene.add(this.gpuBodies.group);
    return this.gpuBodies.gpuBuffer(this.renderer);
  }

  detachGpuBodies(): void {
    this.gpuBodies?.dispose();
    this.gpuBodies = null;
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
    const a = view + 0.7;
    this.light.target.position.set(target.x, target.y, 0);
    this.light.position.set(target.x + 25 * Math.cos(a), target.y + 25 * Math.sin(a), 40);
  }

  render(sim: Sim3D, target: THREE.Vector3): void {
    this.placeLight(target);
    this.light.castShadow = this.shadows;
    if (this.gpuBodies) {
      if (sim.bodyCount !== this.gpuBodiesShown) {
        this.gpuBodies.setBodies(sim.bodyCount, (i) => sim.isSphere?.(i) ?? false);
        this.gpuBodiesShown = sim.bodyCount;
      }
      this.gpuBodies.selected.value = this.selected >= 0 ? this.selected : 0xffffffff;
      this.boxes.mesh.count = 0;
    } else {
      this.drawBodies(sim);
    }
    this.drawForces(sim);
    this.renderer.render(this.scene, this.camera);
  }

  private drawBodies(sim: Sim3D): void {
    const n = sim.bodyCount;
    this.boxes.reserve(n);
    const mesh = this.boxes.mesh;
    for (let i = 0; i < n; i++) {
      const p = sim.position(i);
      const q = sim.orientation(i);
      const s = sim.size(i);
      this.position.set(p[0], p[1], p[2]);
      this.quaternion.set(q[0], q[1], q[2], q[3]);
      this.scale.set(s[0], s[1], s[2]);
      mesh.setMatrixAt(i, this.matrix.compose(this.position, this.quaternion, this.scale));
      mesh.setColorAt(i, this.color.setHex(i === this.selected ? COLORS.selected : sim.isDynamic(i) ? COLORS.dynamic : COLORS.static));
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor!.needsUpdate = true;
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
      const joint = this.color.setHex(COLORS.joint).toArray();
      const drag = new THREE.Color(COLORS.drag).toArray();
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
