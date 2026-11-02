// Rendering shared by the comparison pages (compare-frame.html, compare-side.html): both engines
// draw through the same GpuBodies3D layout. AVBD's solver writes the body buffer directly;
// Rapier poses are copied into it from a snapshot.
import * as THREE from 'three/webgpu';
import { GpuBodies3D, Shape } from '../app3d/gpu-bodies3d.ts';
import { B_POS, B_ROT, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import type { Adapter } from './adapters.ts';
import type { Scene } from './scenes.ts';
import { STATE_SIZE } from './quality.ts';

/** Initialize a WebGPU renderer and return its device; rejects after 15 s instead of hanging. */
export async function initRenderer(renderer: THREE.WebGPURenderer): Promise<GPUDevice> {
  let initTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([renderer.init(), new Promise<never>((_, reject) => {
      initTimer = setTimeout(() => reject(new Error('WebGPU initialization timed out; reopen this page in a fresh tab')), 15000);
    })]);
  } finally { clearTimeout(initTimer); }
  return (renderer.backend as unknown as { device: GPUDevice }).device;
}

/** One engine's drawable: a three.js scene over a GpuBodies3D sized to the manifest. */
export class BodyView {
  readonly drawing: GpuBodies3D;
  readonly buffer: GPUBuffer;
  readonly scene = new THREE.Scene();
  private readonly upload: Float32Array<ArrayBuffer>;
  private readonly manifest: Scene;

  constructor(renderer: THREE.WebGPURenderer, manifest: Scene) {
    this.manifest = manifest;
    this.drawing = new GpuBodies3D(manifest.bodies.length);
    this.buffer = this.drawing.gpuBuffer(renderer);
    this.scene.background = new THREE.Color(0x222831);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x667788, 3));
    this.scene.add(this.drawing.group);
    this.upload = new Float32Array(manifest.bodies.length * BODY_FLOATS);
  }

  /** Pick each slot's mesh; AVBD may reorder bodies on the GPU (`gpuIndices`). Body 0 is the ground. */
  bind(simulation: Adapter): void {
    const inverse = new Map(simulation.gpuIndices?.map((slot, i) => [slot, i]));
    this.drawing.setBodies(this.manifest.bodies.length, slot => {
      const i = inverse.get(slot) ?? slot;
      return i === 0 ? Shape.Floor : this.manifest.bodies[i].shape === 'sphere' ? Shape.Sphere : Shape.Box;
    }, () => undefined);
  }

  /** Copy a common-layout snapshot (see quality.ts) into the render buffer, in manifest order. */
  writePoses(device: GPUDevice, state: Float64Array): void {
    this.manifest.bodies.forEach((b, i) => {
      this.upload.set(state.subarray(i * STATE_SIZE, i * STATE_SIZE + 3), i * BODY_FLOATS + B_POS);
      this.upload.set(state.subarray(i * STATE_SIZE + 3, i * STATE_SIZE + 7), i * BODY_FLOATS + B_ROT);
      this.upload.set(b.size, i * BODY_FLOATS + B_SIZE);
    });
    device.queue.writeBuffer(this.buffer, 0, this.upload);
  }

  dispose(): void { this.drawing.dispose(); this.buffer.destroy(); }
}
