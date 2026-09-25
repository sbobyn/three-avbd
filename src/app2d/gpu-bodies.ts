// Instanced box rendering straight from the GPU solver's body buffer. The buffer belongs to a
// Three.js StorageInstancedBufferAttribute (so Three can bind it in the vertex shader), and
// the solver writes into that same GPUBuffer: no copies, no readback.

import { color, cos, float, instanceIndex, max, positionLocal, select, sin, storage, uniform, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { BODY_FLOATS } from '../avbd2d/gpu/layout.ts';
import { blockColor } from '../app3d/look.ts';

const VEC4_PER_BODY = BODY_FLOATS / 4;

export class GpuBodies {
  readonly attribute: THREE.StorageInstancedBufferAttribute;
  readonly count: number;
  readonly group = new THREE.Group();
  readonly outline: THREE.Mesh;
  /** World-space inset of the fill (one pixel), so the outline shows around it. */
  readonly inset = uniform(0);
  /** Highlighted body index (0xffffffff = none). */
  readonly selected = uniform(0xffffffff, 'uint');
  private readonly geometry: THREE.InstancedBufferGeometry;

  /** Colours: static bodies, the selected one, and the outlines' shade of their fill. */
  constructor(count: number, colors: { static: number; selected: number; outlineShade: number }) {
    this.count = count;
    this.attribute = new THREE.StorageInstancedBufferAttribute(new Float32Array(Math.max(count, 1) * BODY_FLOATS), 4);

    const bodies = storage(this.attribute, 'vec4', Math.max(count, 1) * VEC4_PER_BODY).toReadOnly();
    const base = instanceIndex.mul(VEC4_PER_BODY);
    const pose = bodies.element(base); // x, y, angle
    const shape = bodies.element(base.add(5)); // width, height, mass, moment

    const place = (inset: Parameters<typeof float>[0]) => {
      const size = max(shape.xy.sub(float(inset).mul(2)), 0);
      const local = positionLocal.xy.mul(size);
      const c = cos(pose.z);
      const s = sin(pose.z);
      return vec3(c.mul(local.x).sub(s.mul(local.y)).add(pose.x), s.mul(local.x).add(c.mul(local.y)).add(pose.y), 0);
    };

    const plane = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = plane.index;
    this.geometry.setAttribute('position', plane.getAttribute('position'));
    this.geometry.instanceCount = count;

    // Each body in its own pastel (as the 3D viewer's blocks), static ones taupe
    const paint = select(
      instanceIndex.equal(this.selected),
      color(colors.selected),
      select(shape.z.greaterThan(0), blockColor(instanceIndex), color(colors.static)),
    ) as unknown as THREE.Node<'color'>;
    const outline = new THREE.MeshBasicNodeMaterial();
    outline.positionNode = place(float(0));
    outline.colorNode = paint.mul(colors.outlineShade);

    const fill = new THREE.MeshBasicNodeMaterial();
    fill.positionNode = place(this.inset);
    fill.colorNode = paint;

    const meshes = ([[outline, 0], [fill, 1]] as const).map(([material, z]) => {
      const mesh = new THREE.Mesh(this.geometry, material);
      mesh.frustumCulled = false;
      mesh.position.z = z;
      this.group.add(mesh);
      return mesh;
    });
    this.outline = meshes[0];
  }

  /**
   * The GPUBuffer behind the attribute, created now on the renderer's device so the solver
   * can own its contents. (Uses Three's backend API: the attribute's buffer is otherwise
   * created lazily on first draw.)
   */
  gpuBuffer(renderer: THREE.WebGPURenderer): GPUBuffer {
    const backend = renderer.backend as unknown as {
      createStorageAttribute(attribute: THREE.BufferAttribute): void;
      get(object: object): { buffer?: GPUBuffer };
    };
    backend.createStorageAttribute(this.attribute);
    const buffer = backend.get(this.attribute).buffer;
    if (!buffer) throw new Error('Three.js did not create a GPU buffer for the body attribute');
    return buffer;
  }

  /** Draw only the first `n` bodies (the buffer has room for spawned ones). */
  setCount(n: number): void {
    this.geometry.instanceCount = Math.min(n, this.count);
  }

  dispose(): void {
    this.geometry.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) (o.material as THREE.Material).dispose();
    });
    this.group.removeFromParent();
  }
}
