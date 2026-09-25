// Three.js (WebGPU) renderer for the 2D solvers, in the 3D viewer's look (../app3d/look.ts):
// instanced boxes, each in its own pastel with a constant 1px outline a shade darker, a warm
// taupe for static bodies, joint/spring lines and contact points. Everything is rebuilt from
// solver state each frame, which is fine for the CPU backends (thousands of bodies at most).

import * as THREE from 'three/webgpu';
import type { Sim2D } from '../avbd2d/sim.ts';
import { BLOCK_PALETTE, LOOK } from '../app3d/look.ts';
import { GpuBodies } from './gpu-bodies.ts';

export const COLORS = {
  background: LOOK.skyHorizon,
  static: 0xc4b8a4,
  selected: LOOK.selected,
  joint: 0xb8503f,
  contact: 0xd6336c,
  /** Outlines: the fill's colour, this much darker. */
  outlineShade: 0.62,
};

/** Integer hash (lowbias32) for picking a body's palette colour. */
function hashIndex(i: number): number {
  let x = i >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

export interface Camera2D {
  x: number;
  y: number;
  /** Pixels per world unit. */
  zoom: number;
}

class InstancedQuads {
  mesh: THREE.InstancedMesh;
  private capacity = 0;
  private readonly geometry = new THREE.PlaneGeometry(1, 1);
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly scene: THREE.Scene;
  private readonly z: number;

  constructor(scene: THREE.Scene, z: number, color?: number) {
    this.scene = scene;
    this.z = z;
    this.material = new THREE.MeshBasicNodeMaterial({ color: color ?? 0xffffff });
    this.mesh = this.allocate(256, color === undefined);
  }

  private allocate(capacity: number, perInstanceColor: boolean): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false;
    mesh.position.z = this.z;
    if (perInstanceColor) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.capacity = capacity;
    this.scene.add(mesh);
    return mesh;
  }

  /** Make room for n instances, growing (and replacing the mesh) when needed. */
  reserve(n: number): void {
    if (n <= this.capacity) return;
    const perInstanceColor = this.mesh.instanceColor !== null;
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = this.allocate(Math.max(n, this.capacity * 2), perInstanceColor);
  }
}

export class Renderer2D {
  readonly renderer: THREE.WebGPURenderer;
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
  readonly scene = new THREE.Scene();
  showContacts = true;
  showJoints = true;
  selected = -1;

  private gpuBodies: GpuBodies | null = null;
  private readonly outlines: InstancedQuads;
  private readonly fills: InstancedQuads;
  private readonly contacts: InstancedQuads;
  private readonly lines: THREE.LineSegments;
  private linePositions = new Float32Array(0);
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, requiredLimits?: Record<string, number>) {
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, requiredLimits });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.scene.background = new THREE.Color(COLORS.background);

    this.outlines = new InstancedQuads(this.scene, 0);
    this.fills = new InstancedQuads(this.scene, 1);
    this.contacts = new InstancedQuads(this.scene, 3, COLORS.contact);

    const lineGeometry = new THREE.BufferGeometry();
    this.lines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicNodeMaterial({ color: COLORS.joint }));
    this.lines.frustumCulled = false;
    this.lines.position.z = 2;
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
    this.gpuBodies = new GpuBodies(count, COLORS);
    this.scene.add(this.gpuBodies.group);
    return this.gpuBodies.gpuBuffer(this.renderer);
  }

  detachGpuBodies(): void {
    this.gpuBodies?.dispose();
    this.gpuBodies = null;
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
  }

  /** Convert a canvas-relative pixel position to world coordinates. */
  toWorld(cam: Camera2D, px: number, py: number, width: number, height: number): [number, number] {
    return [cam.x + (px - width / 2) / cam.zoom, cam.y - (py - height / 2) / cam.zoom];
  }

  render(sim: Sim2D, cam: Camera2D, width: number, height: number): void {
    const halfW = width / 2 / cam.zoom;
    const halfH = height / 2 / cam.zoom;
    this.camera.left = cam.x - halfW;
    this.camera.right = cam.x + halfW;
    this.camera.top = cam.y + halfH;
    this.camera.bottom = cam.y - halfH;
    this.camera.updateProjectionMatrix();

    if (this.gpuBodies) {
      this.gpuBodies.setCount(sim.bodyCount);
      // Below ~4 px per unit the 1 px outline would swamp the boxes; draw fills only
      const outlined = cam.zoom >= 4;
      this.gpuBodies.outline.visible = outlined;
      this.gpuBodies.inset.value = outlined ? 1 / cam.zoom : 0;
      this.gpuBodies.selected.value = this.selected >= 0 ? this.selected : 0xffffffff;
      this.outlines.mesh.count = 0;
      this.fills.mesh.count = 0;
    } else {
      this.drawBodies(sim, 1 / cam.zoom);
    }
    this.drawForces(sim, 4 / cam.zoom);
    this.renderer.render(this.scene, this.camera);
  }

  private drawBodies(sim: Sim2D, px: number): void {
    const n = sim.bodyCount;
    this.outlines.reserve(n);
    this.fills.reserve(n);
    const outline = this.outlines.mesh;
    const fill = this.fills.mesh;
    const m = this.matrix;

    for (let i = 0; i < n; i++) {
      const [x, y, angle] = sim.pose(i);
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      const [w, h] = sim.size(i);
      // Rotation * scale in the plane; outline at full size, fill inset by one pixel
      m.set(c * w, -s * h, 0, x, s * w, c * h, 0, y, 0, 0, 1, 0, 0, 0, 0, 1);
      outline.setMatrixAt(i, m);
      const fw = Math.max(w - 2 * px, 0);
      const fh = Math.max(h - 2 * px, 0);
      m.set(c * fw, -s * fh, 0, x, s * fw, c * fh, 0, y, 0, 0, 1, 0, 0, 0, 0, 1);
      fill.setMatrixAt(i, m);
      const hex = i === this.selected ? COLORS.selected : sim.isDynamic(i) ? BLOCK_PALETTE[hashIndex(i) % BLOCK_PALETTE.length] : COLORS.static;
      fill.setColorAt(i, this.color.setHex(hex));
      outline.setColorAt(i, this.color.multiplyScalar(COLORS.outlineShade));
    }
    outline.count = n;
    fill.count = n;
    outline.instanceMatrix.needsUpdate = true;
    fill.instanceMatrix.needsUpdate = true;
    if (fill.instanceColor) fill.instanceColor.needsUpdate = true;
    if (outline.instanceColor) outline.instanceColor.needsUpdate = true;
  }

  private readonly lines2d: number[] = [];
  private readonly points2d: number[] = [];

  private drawForces(sim: Sim2D, pointSize: number): void {
    const lines = this.lines2d;
    const contactPoints = this.points2d;
    lines.length = 0;
    contactPoints.length = 0;
    if (this.showJoints || this.showContacts) sim.debugGeometry(lines, contactPoints);
    if (!this.showJoints) lines.length = 0;
    if (!this.showContacts) contactPoints.length = 0;
    const contactCount = contactPoints.length / 2;
    const segments: number[] = [];
    for (let i = 0; i < lines.length; i += 2) segments.push(lines[i], lines[i + 1], 0);

    // Joint/spring lines
    if (this.linePositions.length < segments.length) {
      this.linePositions = new Float32Array(Math.max(segments.length, this.linePositions.length * 2, 64));
      this.lines.geometry.setAttribute('position', new THREE.BufferAttribute(this.linePositions, 3));
    }
    this.linePositions.set(segments);
    this.lines.geometry.setDrawRange(0, segments.length / 3);
    const attr = this.lines.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (attr) attr.needsUpdate = true;
    this.lines.visible = segments.length > 0;

    // Contact points as small screen-sized squares
    this.contacts.reserve(contactCount);
    const mesh = this.contacts.mesh;
    for (let i = 0; i < contactCount; i++) {
      this.matrix.makeScale(pointSize, pointSize, 1).setPosition(contactPoints[i * 2], contactPoints[i * 2 + 1], 0);
      mesh.setMatrixAt(i, this.matrix);
    }
    mesh.count = contactCount;
    mesh.instanceMatrix.needsUpdate = true;
  }
}
