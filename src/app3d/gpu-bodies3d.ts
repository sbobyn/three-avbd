// Instanced rendering straight from the 3D GPU solver's body buffer (as ../app2d's GpuBodies):
// the buffer belongs to a Three.js StorageInstancedBufferAttribute and the solver writes into
// that same GPUBuffer, so there are no copies and no readback. Boxes and spheres are two
// instanced meshes, each reading its bodies through an index list. Flat shading means
// lighting needs no per-vertex normal rotation.

import { color, cross, float, instanceIndex, positionLocal, select, storage, uniform } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { B_POS, B_ROT, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';

const VEC4_PER_BODY = BODY_FLOATS / 4;

export interface BodyColors {
  dynamic: number;
  static: number;
  selected: number;
}

export class GpuBodies3D {
  readonly attribute: THREE.StorageInstancedBufferAttribute;
  readonly count: number;
  readonly group = new THREE.Group();
  /** Highlighted body index (0xffffffff = none). */
  readonly selected = uniform(0xffffffff, 'uint');
  private readonly shapes: { ids: THREE.StorageInstancedBufferAttribute; geometry: THREE.InstancedBufferGeometry; material: THREE.Material }[];

  constructor(count: number, colors: BodyColors) {
    this.count = count;
    const n = Math.max(count, 1);
    this.attribute = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * BODY_FLOATS), 4);
    const bodies = storage(this.attribute, 'vec4', n * VEC4_PER_BODY).toReadOnly();

    const mesh = (source: THREE.BufferGeometry) => {
      const ids = new THREE.StorageInstancedBufferAttribute(new Uint32Array(n), 1);
      const body = storage(ids, 'uint', n).toReadOnly().element(instanceIndex);
      const base = body.mul(VEC4_PER_BODY);
      const pos = bodies.element(base.add(B_POS / 4));
      const rot = bodies.element(base.add(B_ROT / 4));
      const size = bodies.element(base.add(B_SIZE / 4)); // xyz, w: mass

      // v + 2w(u × v) + 2u × (u × v), with q = (u, w)
      const local = positionLocal.mul(size.xyz);
      const t = cross(rot.xyz, local).mul(2);
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = source.index;
      geometry.setAttribute('position', source.getAttribute('position'));
      geometry.setAttribute('normal', source.getAttribute('normal'));
      geometry.instanceCount = 0;

      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0, flatShading: true });
      material.positionNode = local.add(t.mul(rot.w)).add(cross(rot.xyz, t)).add(pos.xyz);
      material.colorNode = select(
        body.equal(this.selected),
        color(colors.selected),
        select(size.w.greaterThan(float(0)), color(colors.dynamic), color(colors.static)),
      );
      const m = new THREE.Mesh(geometry, material);
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      return { ids, geometry, material };
    };
    // Unit shapes, scaled by size: the sphere's size is its diameter on every axis
    this.shapes = [mesh(new THREE.BoxGeometry(1, 1, 1)), mesh(new THREE.IcosahedronGeometry(0.5, 3))];
  }

  /**
   * The GPUBuffer behind the attribute, created now on the renderer's device so the solver
   * can own its contents (Three's backend API: the buffer is otherwise created on first draw).
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

  /** Draw the first `n` bodies; `isSphere(i)` picks each one's mesh. */
  setBodies(n: number, isSphere: (i: number) => boolean): void {
    const lists: number[][] = [[], []];
    for (let i = 0; i < Math.min(n, this.count); i++) lists[isSphere(i) ? 1 : 0].push(i);
    this.shapes.forEach((shape, k) => {
      (shape.ids.array as Uint32Array).set(lists[k]);
      shape.ids.needsUpdate = true;
      shape.geometry.instanceCount = lists[k].length;
    });
  }

  dispose(): void {
    for (const shape of this.shapes) {
      shape.geometry.dispose();
      shape.material.dispose();
    }
    this.group.removeFromParent();
  }
}
