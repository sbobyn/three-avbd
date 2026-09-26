// BodyMesh: a Three.js mesh drawing a world's bodies straight from the solver's body buffer
// (as the demo's ../app3d/gpu-bodies3d.ts): one instance per body, placed, turned and sized in
// the vertex shader from the buffer the solver writes. No copies, no readback.

import { cross, instanceIndex, materialColor, normalGeometry, normalize, positionGeometry, select, storage, transformNormalToView, varying } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { B_POS, B_ROT, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import type { Body, World } from './world.ts';

type Vec3 = THREE.Node<'vec3'>;
type Vec4 = THREE.Node<'vec4'>;

const VEC4_PER_BODY = BODY_FLOATS / 4;

/** v turned by the unit quaternion q = (u, w): v + 2w(u × v) + 2u × (u × v). */
function rotate(q: Vec4, v: Vec3): Vec3 {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

export interface BodyMeshOptions {
  /**
   * Which bodies to draw: a shape (every body of it, as they come and go), a list, or a test.
   * Default: every box.
   */
  bodies?: 'box' | 'sphere' | Body[] | ((body: Body) => boolean);
  /**
   * The shape drawn for each body, at unit size: scaled by the body's size (a unit box, or a
   * sphere of diameter 1, fits the body exactly). Default: a box, or a sphere for 'sphere'.
   */
  geometry?: THREE.BufferGeometry;
  /** A node material (its position and normal are set here). Default: MeshStandardNodeMaterial. */
  material?: THREE.NodeMaterial;
}

export class BodyMesh extends THREE.Mesh<THREE.InstancedBufferGeometry, THREE.NodeMaterial> {
  readonly world: World;
  private readonly ids: THREE.StorageInstancedBufferAttribute;
  private readonly colors: THREE.StorageInstancedBufferAttribute;
  private readonly which: BodyMeshOptions['bodies'];
  private drawnVersion = -1;

  constructor(world: World, options: BodyMeshOptions = {}) {
    if (!world.bodyAttribute) throw new Error('BodyMesh: the world has no body attribute (create it with a renderer)');
    const n = world.maxBodies;
    const which = options.bodies ?? 'box';
    const source = options.geometry ?? (which === 'sphere' ? new THREE.IcosahedronGeometry(0.5, 3) : new THREE.BoxGeometry(1, 1, 1));
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = source.index;
    geometry.setAttribute('position', source.getAttribute('position'));
    geometry.setAttribute('normal', source.getAttribute('normal'));
    if (source.getAttribute('uv')) geometry.setAttribute('uv', source.getAttribute('uv'));
    geometry.instanceCount = 0;
    const material = options.material ?? new THREE.MeshStandardNodeMaterial();
    super(geometry, material);
    this.world = world;
    this.which = which;

    // Each instance's body, then the body's record in the solver's buffer
    this.ids = new THREE.StorageInstancedBufferAttribute(new Uint32Array(n), 1);
    this.colors = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * 4), 4);
    const bodies = storage(world.bodyAttribute, 'vec4', n * VEC4_PER_BODY).toReadOnly();
    const body = storage(this.ids, 'uint', n).toReadOnly().element(instanceIndex);
    const base = body.mul(VEC4_PER_BODY);
    const pos = bodies.element(base.add(B_POS / 4));
    const rot = bodies.element(base.add(B_ROT / 4)) as unknown as Vec4;
    const size = bodies.element(base.add(B_SIZE / 4)).xyz as unknown as Vec3;
    material.positionNode = rotate(rot, positionGeometry.mul(size)).add(pos.xyz);
    // The normal turned with the body (worked out in the vertex stage, where the body's record
    // is at hand, and interpolated); divided by the size first, so a stretched shape's normals
    // stay square to its faces
    material.normalNode = transformNormalToView(normalize(varying(rotate(rot, normalGeometry.div(size)))));
    // Colour per body (setColor), else the material's own
    const paint = storage(this.colors, 'vec4', n).toReadOnly().element(body);
    material.colorNode = select(paint.w.greaterThan(0.5), paint.rgb, materialColor.rgb) as unknown as THREE.Node<'color'>;
    this.frustumCulled = false;
  }

  /** Paint one body (null: back to the material's colour). */
  setColor(body: Body, color: THREE.ColorRepresentation | null): void {
    const a = this.colors.array as Float32Array;
    if (color === null) a.fill(0, body.index * 4, body.index * 4 + 4);
    else {
      const c = new THREE.Color(color);
      a.set([c.r, c.g, c.b, 1], body.index * 4);
    }
    this.colors.needsUpdate = true;
  }

  /** Redraw the list of bodies (automatic as they come and go; call after changing a list). */
  refresh(): void {
    const w = this.which;
    const all = this.world.bodies;
    const list = Array.isArray(w) ? w.filter((b) => b.alive) : typeof w === 'function' ? all.filter(w) : all.filter((b) => b.shape === w);
    (this.ids.array as Uint32Array).set(list.map((b) => b.index));
    this.ids.needsUpdate = true;
    this.geometry.instanceCount = list.length;
    this.drawnVersion = this.world.version;
  }

  onBeforeRender = (): void => {
    if (this.drawnVersion !== this.world.version) this.refresh();
  };
}
