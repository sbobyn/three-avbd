// Instanced rendering straight from the 3D GPU solver's body buffer (as ../app2d's GpuBodies):
// the buffer belongs to a Three.js StorageInstancedBufferAttribute and the solver writes into
// that same GPUBuffer, so there are no copies and no readback. Each shape (box, sphere, floor,
// capsule, chain-mail ring) is an instanced mesh reading its bodies through an index list;
// spring coils and cloth sheets read the same buffer. Boxes use flat shading, so their
// lighting needs no per-vertex normal rotation. Colours and materials: ./look.ts.

import {
  abs,
  clamp,
  color,
  cos,
  cross,
  faceDirection,
  float,
  instanceIndex,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionLocal,
  select,
  sign,
  sin,
  smoothstep,
  storage,
  texture,
  time,
  transformNormalToView,
  uniform,
  uniformArray,
  uv,
  varying,
  vec3,
} from 'three/tsl';
import * as THREE from 'three/webgpu';
import { B_POS, B_ROT, B_SIZE, BODY_FLOATS } from '../avbd3d/gpu/layout.ts';
import { EYE, type RopeStyle, type Visual } from '../avbd3d/visuals.ts';
import { coilGeometry, coilMaterial } from './coils.ts';
import { blockColor, clothTexture, edgeShade, FLOOR_EXTENT, glossyFloor, LOOK, shadowLookup, sphereColor } from './look.ts';

const VEC4_PER_BODY = BODY_FLOATS / 4;

/** Which mesh draws a body. */
export const Shape = { Box: 0, Sphere: 1, Floor: 2, Capsule: 3, RingFlat: 4, RingX: 5, RingY: 6, Hidden: 7 } as const;
export type Shape = (typeof Shape)[keyof typeof Shape];
const DRAWN = 7;

/**
 * Chain-mail rings: the torus template lies in xy; each kind turns it into its own plane.
 * `toFlat` (rows of an orthonormal matrix) takes the body's frame to the template's, and its
 * centreline radius as a fraction of the link's width.
 */
const RINGS: Partial<Record<Shape, { toFlat: number[]; radius: number }>> = {
  [Shape.RingFlat]: { toFlat: [1, 0, 0, 0, 1, 0, 0, 0, 1], radius: LOOK.ringFlat },
  [Shape.RingX]: { toFlat: [1, 0, 0, 0, 0, 1, 0, -1, 0], radius: LOOK.ringLink },
  [Shape.RingY]: { toFlat: [0, 1, 0, 0, 0, 1, 1, 0, 0], radius: LOOK.ringLink },
};

type Vec3 = THREE.Node<'vec3'>;
type Vec4 = THREE.Node<'vec4'>;

/** v rotated by the unit quaternion q = (u, w): v + 2w(u × v) + 2u × (u × v). */
function rotate(q: Vec4, v: Vec3): Vec3 {
  const t = cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(cross(q.xyz, t));
}

/** A spring between two bodies, anchored at body-local points. */
export interface SpringView {
  a: number;
  b: number;
  rA: ArrayLike<number>;
  rB: ArrayLike<number>;
}

/** A unit capsule along x: radius 0.5, straight part from -0.5 to 0.5 (so x spans ±1). */
function unitCapsule(): THREE.BufferGeometry {
  const g = new THREE.CapsuleGeometry(0.5, 1, 6, 14);
  g.rotateZ(-Math.PI / 2);
  return g;
}

/** A unit torus (centreline radius 0.5) in the plane of chain-mail ring `shape`. */
function unitRing(shape: Shape): THREE.BufferGeometry {
  const { toFlat: m, radius } = RINGS[shape]!;
  const g = new THREE.TorusGeometry(0.5, 0.5 * (LOOK.ringWire / radius), 8, 32);
  // Back from the template's frame: the transpose
  g.applyMatrix4(new THREE.Matrix4().set(m[0], m[3], m[6], 0, m[1], m[4], m[7], 0, m[2], m[5], m[8], 0, 0, 0, 0, 1));
  return g;
}

/**
 * The template for a laid rope (GpuBodies3D.laidRope): x = s from s0 to s1 (`perUnit` rings
 * per unit), y = the strand (0, 1, 2), z = psi around it.
 */
function ropeTemplate(s0: number, s1: number, perUnit: number, around = 16): THREE.BufferGeometry {
  const positions: number[] = [];
  const index: number[] = [];
  const along = Math.max(1, Math.round((s1 - s0) * perUnit));
  for (let strand = 0; strand < 3; strand++) {
    const first = positions.length / 3;
    for (let i = 0; i <= along; i++) for (let a = 0; a <= around; a++) positions.push(s0 + ((s1 - s0) * i) / along, strand, (2 * Math.PI * a) / around);
    for (let i = 0; i < along; i++) {
      for (let a = 0; a < around; a++) {
        const v = first + i * (around + 1) + a;
        const w = v + around + 1;
        index.push(v, w, v + 1, w, w + 1, v + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

export class GpuBodies3D {
  readonly attribute: THREE.StorageInstancedBufferAttribute;
  readonly count: number;
  readonly group = new THREE.Group();
  /** Highlighted body index (0xffffffff = none): the one being dragged. */
  readonly selected = uniform(0xffffffff, 'uint');
  /** The body under the pointer, tinted so a grab is discoverable (0xffffffff = none). */
  readonly hovered = uniform(0xffffffff, 'uint');
  /** Per body: linear rgb and a mode (0 palette, 1 own colour, 3 polished metal). */
  private readonly paints: THREE.StorageInstancedBufferAttribute;
  private readonly bodies: THREE.StorageBufferNode<'vec4'>;
  private readonly shapes: { ids: THREE.StorageInstancedBufferAttribute; geometry: THREE.InstancedBufferGeometry; material: THREE.Material }[];
  private readonly extras = new THREE.Group();

  /** The floor's two materials: with the planar mirror, and without (setReflections). */
  private floor: { mesh: THREE.Mesh; mirror: THREE.Material | null; plain: THREE.Material } | null = null;

  /** `mirror`: a planar reflection (TSL reflector) for the floor to show, if any. */
  constructor(count: number, mirror?: THREE.TextureNode) {
    this.count = count;
    const n = Math.max(count, 1);
    this.attribute = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * BODY_FLOATS), 4);
    this.paints = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * 4), 4);
    const bodies = storage(this.attribute, 'vec4', n * VEC4_PER_BODY).toReadOnly();
    this.bodies = bodies;
    const paints = storage(this.paints, 'vec4', n).toReadOnly();

    const mesh = (source: THREE.BufferGeometry, shape: Shape) => {
      const ids = new THREE.StorageInstancedBufferAttribute(new Uint32Array(n), 1);
      const body = storage(ids, 'uint', n).toReadOnly().element(instanceIndex);
      const base = body.mul(VEC4_PER_BODY);
      const pos = bodies.element(base.add(B_POS / 4));
      const rot = bodies.element(base.add(B_ROT / 4)) as unknown as Vec4;
      const size = bodies.element(base.add(B_SIZE / 4)); // xyz, w: mass
      const paint = paints.element(body);

      // The shape's local vertex, in metres
      let local: Vec3;
      /** A capsule's straight half-length. */
      let capsuleHalf: THREE.Node<'float'> | null = null;
      if (shape === Shape.Capsule) {
        // Stretch only the straight part, so the caps stay round: length size.x, diameter the
        // thinner cross-section
        const r = min(size.y, size.z);
        const h = max(size.x.sub(r).mul(0.5), float(0));
        capsuleHalf = h;
        const x = positionGeometry.x;
        const ax = abs(x);
        const along = select(ax.lessThanEqual(0.5), x.mul(h.mul(2)), sign(x).mul(h.add(ax.sub(0.5).mul(r))));
        local = vec3(along, positionGeometry.y.mul(r), positionGeometry.z.mul(r));
      } else if (RINGS[shape]) {
        local = positionGeometry.mul(size.x.mul(RINGS[shape]!.radius * 2));
      } else {
        // Boxes and spheres (a sphere's size is its diameter); the floor runs on to the horizon
        const extent = shape === Shape.Floor ? vec3(FLOOR_EXTENT, FLOOR_EXTENT, size.z) : size.xyz;
        local = positionLocal.mul(extent);
      }
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.index = source.index;
      geometry.setAttribute('position', source.getAttribute('position'));
      geometry.setAttribute('normal', source.getAttribute('normal'));
      geometry.instanceCount = 0;

      const round = shape === Shape.Sphere || shape === Shape.Capsule || RINGS[shape] !== undefined;
      const roughness = shape === Shape.Sphere ? 0.38 : shape === Shape.Floor ? 0.85 : 0.72;
      const material = new THREE.MeshStandardNodeMaterial({ roughness, metalness: 0, flatShading: !round });
      material.positionNode = rotate(rot, local).add(pos.xyz);
      let worldNormal: Vec3 | null = null;
      if (round) {
        // Smooth normals from the shape itself, in the body's frame, turned by its rotation.
        // Built from varyings: evaluated in the vertex stage alongside positionNode, so they
        // see the moved vertex (Three builds a normalNode apart, where positions are the
        // template's), and interpolated
        const p = varying(local);
        const q = varying(rot) as unknown as Vec4;
        let n: Vec3 = p; // a sphere's: away from its centre
        if (shape === Shape.Capsule) {
          // From the nearest point of the axis segment
          const h = varying(capsuleHalf!);
          n = p.sub(vec3(clamp(p.x, h.negate(), h), 0, 0));
        } else if (shape !== Shape.Sphere) {
          // A ring's from the nearest point of its centreline circle, found in its own plane
          const { toFlat: m, radius } = RINGS[shape]!;
          const flat = vec3(vec3(m[0], m[1], m[2]).dot(p), vec3(m[3], m[4], m[5]).dot(p), vec3(m[6], m[7], m[8]).dot(p));
          const off = flat.sub(vec3(normalize(flat.xy).mul(varying(size.x).mul(radius)), 0));
          n = vec3(vec3(m[0], m[3], m[6]).dot(off), vec3(m[1], m[4], m[7]).dot(off), vec3(m[2], m[5], m[8]).dot(off));
        }
        const normal = normalize(rotate(q, n));
        worldNormal = normal;
        material.normalNode = transformNormalToView(normal);
        material.receivedShadowPositionNode = shadowLookup(normal) as unknown as THREE.Node<'float'>;
      }
      let mirrored: THREE.MeshStandardNodeMaterial | null = null;
      if (shape === Shape.Floor) {
        glossyFloor(material);
        if (mirror) {
          mirrored = new THREE.MeshStandardNodeMaterial({ metalness: 0, flatShading: true });
          mirrored.positionNode = material.positionNode;
          glossyFloor(mirrored, mirror.level(float(LOOK.mirrorBlur)).rgb as unknown as Vec3);
        }
      } else {
        const own = paint.w.greaterThan(0.5);
        let shade: THREE.Node<'float'> = float(1);
        if (shape === Shape.Box) shade = edgeShade(positionGeometry, size.xyz);
        const palette = shape === Shape.Sphere ? sphereColor(body) : blockColor(body);
        const still = color(LOOK.static) as unknown as Vec3;
        const base = select(own, paint.xyz, select(size.w.greaterThan(float(0)), palette, still)).mul(shade);
        material.colorNode = select(body.equal(this.selected), color(LOOK.selected), base) as unknown as THREE.Node<'color'>;
        // The hovered body glows, pulsing gently, whatever its colour
        const pulse = sin(time.mul(6)).mul(0.5).add(0.5);
        const glow = mix(base, color(LOOK.hoverTint) as unknown as Vec3, 0.5).mul(pulse.mul(0.25).add(0.3));
        let emission: Vec3 = select(body.equal(this.hovered).and(body.notEqual(this.selected)), glow, vec3(0)) as unknown as Vec3;
        if (worldNormal) {
          // Polished metal: all specular, tinted by its colour, mirroring the environment
          const metal = paint.w.greaterThan(2.5);
          material.metalnessNode = select(metal, float(1), float(0));
          material.roughnessNode = select(metal, float(LOOK.metalRoughness), float(roughness));
        }
        material.emissiveNode = emission as unknown as THREE.Node<'color'>;
      }
      const m = new THREE.Mesh(geometry, mirrored ?? material);
      m.frustumCulled = false;
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
      if (shape === Shape.Floor) this.floor = { mesh: m, mirror: mirrored, plain: material };
      return { ids, geometry, material };
    };
    // Unit shapes, scaled by size: the sphere's size is its diameter on every axis
    this.shapes = [
      mesh(new THREE.BoxGeometry(1, 1, 1), Shape.Box),
      mesh(new THREE.IcosahedronGeometry(0.5, 3), Shape.Sphere),
      mesh(new THREE.BoxGeometry(1, 1, 1), Shape.Floor),
      mesh(unitCapsule(), Shape.Capsule),
      mesh(unitRing(Shape.RingFlat), Shape.RingFlat),
      mesh(unitRing(Shape.RingX), Shape.RingX),
      mesh(unitRing(Shape.RingY), Shape.RingY),
    ];
    this.group.add(this.extras);
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

  /** Draw the first `n` bodies; `shapeOf(i)` picks each one's mesh, `visualOf(i)` its paint. */
  setBodies(n: number, shapeOf: (i: number) => Shape, visualOf: (i: number) => Visual | undefined): void {
    const lists: number[][] = Array.from({ length: DRAWN }, () => []);
    const paints = this.paints.array as Float32Array;
    const c = new THREE.Color();
    for (let i = 0; i < Math.min(n, this.count); i++) {
      const shape = shapeOf(i);
      if (shape !== Shape.Hidden) lists[shape].push(i);
      const v = visualOf(i);
      if (v?.color !== undefined) {
        c.setHex(v.color);
        paints.set([c.r, c.g, c.b, v.metal ? 3 : 1], i * 4);
      } else paints.fill(0, i * 4, i * 4 + 4);
    }
    this.paints.needsUpdate = true;
    this.shapes.forEach((shape, k) => {
      (shape.ids.array as Uint32Array).set(lists[k]);
      shape.ids.needsUpdate = true;
      shape.geometry.instanceCount = lists[k].length;
    });
  }

  /** Show the planar mirror in the floor (off, the floor's material never samples it, so the
   * mirror isn't rendered at all). */
  setReflections(on: boolean): void {
    if (this.floor) this.floor.mesh.material = (on && this.floor.mirror) || this.floor.plain;
  }

  /** Coil springs between bodies, drawn from the body buffer. */
  setSprings(springs: SpringView[]): void {
    if (!springs.length) return;
    const n = springs.length;
    const ends = new THREE.StorageInstancedBufferAttribute(new Uint32Array(n * 2), 2);
    const anchors = new THREE.StorageInstancedBufferAttribute(new Float32Array(n * 8), 4);
    springs.forEach((s, k) => {
      (ends.array as Uint32Array).set([s.a, s.b], k * 2);
      (anchors.array as Float32Array).set([s.rA[0], s.rA[1], s.rA[2], 0, s.rB[0], s.rB[1], s.rB[2], 0], k * 8);
    });
    const endNode = storage(ends, 'uvec2', n).toReadOnly().element(instanceIndex);
    const anchorNode = storage(anchors, 'vec4', n * 2).toReadOnly();
    const point = (body: THREE.Node<'uint'>, r: Vec3) => {
      const base = body.mul(VEC4_PER_BODY);
      return rotate(this.bodies.element(base.add(B_ROT / 4)) as unknown as Vec4, r).add(this.bodies.element(base.add(B_POS / 4)).xyz);
    };
    const p0 = point(endNode.x, anchorNode.element(instanceIndex.mul(2)).xyz);
    const p1 = point(endNode.y, anchorNode.element(instanceIndex.mul(2).add(1)).xyz);
    const geometry = new THREE.InstancedBufferGeometry().copy(coilGeometry() as THREE.InstancedBufferGeometry);
    geometry.instanceCount = n;
    const coil = new THREE.Mesh(geometry, coilMaterial(p0, p1));
    coil.frustumCulled = false;
    coil.castShadow = true;
    coil.receiveShadow = true;
    this.extras.add(coil);
  }

  /**
   * Laid ropes along chains of bodies: three strands twisted about a smooth curve through the
   * joints, one continuous mesh per rope. Per-link strands couldn't line up at the joints
   * (neighbouring links roll differently), so the whole rope is built in the vertex shader:
   * the centreline is a Catmull-Rom spline through the joint points (each link's ends along
   * its local x), and the strands' frame blends neighbouring links' rotations, so the rope
   * twists with them. Ends are tied (run on into a body), free (the strands close into a tip)
   * or an eye (visuals.ts EYE): an eye splice drawn in the first link's frame, so it swings
   * with the rope, its legs going into a seizing of cord round the rope's start.
   */
  setRopes(ropes: ({ links: number[]; color: number } & RopeStyle)[]): void {
    /** How far (in links) a tied end runs on into its body, or an eye's rope up into its seizing. */
    const TIED = 0.4;
    /** A seizing's reach down the rope, and up over the eye's legs (a dome), in rope radii. */
    const [SEIZING_DOWN, SEIZING_UP] = [1.8, 1.1];
    type F = THREE.Node<'float'>;
    for (const rope of ropes) {
      const n = rope.links.length;
      const ids = new THREE.StorageInstancedBufferAttribute(new Uint32Array(rope.links), 1);
      const link = storage(ids, 'uint', n).toReadOnly();
      const base = (k: F) => link.element(clamp(k, float(0), float(n - 1)).toUint()).mul(VEC4_PER_BODY);
      const posOf = (k: F) => this.bodies.element(base(k).add(B_POS / 4)).xyz;
      const rotOf = (k: F) => this.bodies.element(base(k).add(B_ROT / 4)) as unknown as Vec4;
      const sizeOf = (k: F) => this.bodies.element(base(k).add(B_SIZE / 4));
      // Joint m: the start of link m, or (m = n) the end of the last
      const joint = (m: F): Vec3 => {
        const k = min(m, float(n - 1));
        const half = select(m.greaterThan(n - 0.5), float(0.5), float(-0.5));
        return posOf(k).add(rotate(rotOf(k), vec3(1, 0, 0)).mul(sizeOf(k).x.mul(half)));
      };
      const eye = rope.start === 'eye';

      // The rope along the chain: s in links, 0 at the first joint, n at the last
      const s0 = -TIED;
      const s1 = rope.end === 'free' ? n : n + TIED;
      const s = positionGeometry.x;
      const k = clamp(s.floor(), float(0), float(n - 1));
      const t = s.sub(k);
      const p1 = joint(k);
      const p2 = joint(k.add(1));
      const p0 = select(k.lessThan(0.5), p1.mul(2).sub(p2), joint(k.sub(1)));
      const p3 = select(k.add(2).greaterThan(n + 0.5), p2.mul(2).sub(p1), joint(k.add(2)));
      const c1 = p2.sub(p0);
      const c2 = p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3);
      const c3 = p1.mul(3).sub(p0).sub(p2.mul(3)).add(p3);
      // Past the end joints, straight on along the end tangent
      const before = s.lessThan(0);
      const after = s.greaterThan(n);
      const endT = c1.add(c2.mul(2)).add(c3.mul(3)); // the derivative (×2) at t = 1
      const curve = p1.mul(2).add(c1.mul(t)).add(c2.mul(t.mul(t))).add(c3.mul(t.mul(t).mul(t))).mul(0.5);
      const centre = select(before, p1.add(c1.mul(s.mul(0.5))), select(after, p2.add(endT.mul(s.sub(n).mul(0.5))), curve));
      const tangent = normalize(select(before, c1, select(after, endT, c1.add(c2.mul(t.mul(2))).add(c3.mul(t.mul(t).mul(3))))));
      // Frame: the links' rotations blended between their centres
      const u = s.sub(0.5);
      const a = clamp(u.floor(), float(0), float(n - 1));
      const qa = rotOf(a);
      const qb = rotOf(min(a.add(1), float(n - 1)));
      const q = normalize(mix(qa, qb.mul(sign(qa.dot(qb)).add(0.5).sign()), clamp(u.sub(a), float(0), float(1)))) as unknown as Vec4;
      const size = sizeOf(a);
      const r0 = min(size.y, size.z).mul(0.5);
      const metres = s.mul(size.x);
      // A free end draws its strands together into a rounded tip over a radius
      let radius: F = rope.end === 'free' ? clamp(float(n).sub(s).mul(size.x).div(r0), float(0), float(1)).sqrt() : float(1);
      // An eye's seizing: from a dome over the eye's legs down the rope, the strands merge into
      // one round bulge bound with cord
      let seize: F = float(0);
      if (eye) {
        seize = float(1).sub(smoothstep(r0.mul(SEIZING_DOWN - 0.15), r0.mul(SEIZING_DOWN), metres));
        radius = radius.mul(clamp(metres.add(r0.mul(SEIZING_UP)).div(r0.mul(SEIZING_UP)), float(0), float(1)).sqrt());
      }
      this.extras.add(this.laidRope(ropeTemplate(s0, s1, 16), { centre, tangent, up: rotate(q, vec3(0, 1, 0)), radius: r0.mul(radius), lay: r0, along: metres.div(r0), seize }, rope.color));

      if (eye) {
        // The eye: Catmull-Rom through EYE.path (in rope radii) in the first link's xz plane
        const path = uniformArray(EYE.path.map(([pu, pw]) => new THREE.Vector2(pu, pw)), 'vec2');
        const last = EYE.path.length - 1;
        const at = (i: F) => path.element(clamp(i, float(0), float(last)).toUint()) as unknown as THREE.Node<'vec2'>;
        const e = positionGeometry.x;
        const ek = clamp(e.floor(), float(0), float(last - 1));
        const et = e.sub(ek);
        const [e0, e1, e2, e3] = [at(ek.sub(1)), at(ek), at(ek.add(1)), at(ek.add(2))];
        const d1 = e2.sub(e0);
        const d2 = e0.mul(2).sub(e1.mul(5)).add(e2.mul(4)).sub(e3);
        const d3 = e1.mul(3).sub(e0).sub(e2.mul(3)).add(e3);
        const local = e1.mul(2).add(d1.mul(et)).add(d2.mul(et.mul(et))).add(d3.mul(et.mul(et).mul(et))).mul(0.5);
        const slope = d1.add(d2.mul(et.mul(2))).add(d3.mul(et.mul(et).mul(3)));
        const zero = float(0);
        const q0 = rotOf(zero);
        const size0 = sizeOf(zero);
        const r = min(size0.y, size0.z).mul(0.5);
        const [x, z] = [rotate(q0, vec3(1, 0, 0)), rotate(q0, vec3(0, 0, 1))];
        const start = posOf(zero).sub(x.mul(size0.x.mul(0.5)));
        this.extras.add(
          this.laidRope(
            ropeTemplate(0, last, 12),
            {
              centre: start.add(x.mul(local.x.negate()).add(z.mul(local.y)).mul(r)),
              tangent: normalize(x.mul(slope.x.negate()).add(z.mul(slope.y))),
              up: rotate(q0, vec3(0, 1, 0)),
              radius: r.mul(EYE.tube),
              lay: r.mul(EYE.tube),
              along: e.mul(1.4 / EYE.tube),
              seize: float(0),
            },
            rope.color,
          ),
        );
      }
    }
  }

  /**
   * Three laid strands about a centreline (template: ropeTemplate), with the rope's material:
   * crevices darker between strands, fibres twisting against the lay bumped into the normal,
   * mottled with noise, a cloth-like sheen; where `seize` is 1 the strands merge into one
   * round bulge wrapped in cord.
   */
  private laidRope(
    geometry: THREE.BufferGeometry,
    rope: {
      centre: Vec3;
      tangent: Vec3;
      /** A vector across the rope (squared up to the tangent here): the strands' reference. */
      up: Vec3;
      radius: THREE.Node<'float'>;
      /** The strands' lay (one turn every 7 of this) and fibre scale: the full rope radius. */
      lay: THREE.Node<'float'>;
      /** Distance along the rope, in `lay` units. */
      along: THREE.Node<'float'>;
      seize: THREE.Node<'float'>;
    },
    paint: number,
  ): THREE.Mesh {
    const strand = positionGeometry.y;
    const psi = positionGeometry.z;
    const { tangent, radius, seize } = rope;
    const e1 = normalize(rope.up.sub(tangent.mul(rope.up.dot(tangent))));
    const e2 = cross(tangent, e1);
    // Three touching strands: centres 0.52 R out, radius 0.48 R; one lay every 3.5 diameters.
    // Seized, each becomes a circle round the axis, a little smaller than the last (no two
    // coincide)
    const theta = strand.mul((2 * Math.PI) / 3).add(rope.along.mul((2 * Math.PI) / 7));
    const out = e1.mul(cos(theta)).add(e2.mul(sin(theta)));
    const side = cross(tangent, out);
    const normal = out.mul(cos(psi)).add(side.mul(sin(psi)));
    const offset = radius.mul(mix(float(0.52), float(0), seize));
    const tube = radius.mul(mix(float(0.48), float(1.16).sub(strand.mul(0.012)), seize));

    const material = new THREE.MeshPhysicalNodeMaterial({ roughness: 0.93, metalness: 0, sheen: 1, sheenRoughness: 0.55 });
    material.sheenColor = new THREE.Color(paint).multiplyScalar(0.55);
    material.positionNode = rope.centre.add(out.mul(offset)).add(normal.mul(tube));
    // Fibres, per fragment: twisted against the lay (a bump across the strand), and noise at
    // two scales for clumps and fuzz
    const vNormal = normalize(varying(normal));
    const around = normalize(varying(side).mul(cos(psi)).sub(varying(out).mul(sin(psi))));
    const vTangent = normalize(varying(tangent));
    const vSeize = varying(seize);
    const along = varying(rope.along);
    const twist = psi.mul(16).sub(along.mul(9));
    const clumps = mx_noise_float(vec3(psi.mul(2.2), along.mul(3), strand.mul(3.1)));
    const fuzz = mx_noise_float(vec3(psi.mul(9), along.mul(26), strand.mul(5.7)));
    const bump = cos(twist).mul(0.3).add(fuzz.mul(0.18)).mul(float(1).sub(vSeize));
    // The seizing's cord: tight wraps across the rope
    const wraps = sin(along.mul(2 * Math.PI * 9));
    const fibred = normalize(vNormal.add(around.mul(bump)).add(vTangent.mul(fuzz.mul(0.08).add(wraps.mul(0.35).mul(vSeize)))));
    material.normalNode = transformNormalToView(fibred);
    material.receivedShadowPositionNode = shadowLookup(vNormal) as unknown as THREE.Node<'float'>;
    // Darker where a strand turns in towards the others and in the fibres' grooves
    const crevice = mix(mix(float(0.5), float(1), smoothstep(float(-0.75), float(0.55), cos(psi))), float(1), vSeize);
    const grain = cos(twist).mul(0.06).add(0.94).mul(clumps.mul(0.1).add(0.92)).mul(fuzz.mul(0.05).add(1));
    const hemp = color(paint).mul(float(1).sub(strand.mul(0.05)));
    const cord = color(0x7a6448).mul(smoothstep(float(-0.6), float(0.9), wraps).mul(0.35).add(0.65));
    material.colorNode = mix(hemp.mul(crevice).mul(grain), cord, vSeize) as unknown as THREE.Node<'color'>;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** Cloth sheets through the centres of grids of bodies (each a list of equal rows). */
  setCloths(grids: number[][][]): void {
    const print = grids.length ? clothTexture() : null;
    for (const grid of grids) {
      const [rows, cols] = [grid.length, grid[0].length];
      const cells = new THREE.StorageInstancedBufferAttribute(new Uint32Array(grid.flat()), 1);
      const cell = storage(cells, 'uint', rows * cols).toReadOnly();
      // The template: x, y = the grid cell (i, j), and uv corner to corner
      const positions: number[] = [];
      const uvs: number[] = [];
      const index: number[] = [];
      for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
          positions.push(i, j, 0);
          uvs.push(i / (rows - 1), j / (cols - 1));
          if (i > 0 && j > 0) {
            const [a, b, c, d] = [(i - 1) * cols + j - 1, (i - 1) * cols + j, i * cols + j - 1, i * cols + j];
            index.push(a, c, b, b, c, d);
          }
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(index);

      // The plates' centres zigzag a little (neighbours tilt opposite ways about their shared
      // joints), which drawn as is shows every plate. Smooth them: positions by a [1 2 1]
      // binomial filter and normals by Sobel differences, both of which cancel a pattern that
      // alternates from cell to cell
      const i = positionGeometry.x;
      const j = positionGeometry.y;
      const at = (di: number, dj: number) => {
        const ii = min(max(i.add(di), float(0)), float(rows - 1));
        const jj = min(max(j.add(dj), float(0)), float(cols - 1));
        return this.bodies.element(cell.element(ii.toUint().mul(cols).add(jj.toUint())).mul(VEC4_PER_BODY).add(B_POS / 4)).xyz;
      };
      const w = [1, 2, 1];
      let centre: Vec3 = vec3(0);
      let dx: Vec3 = vec3(0);
      let dy: Vec3 = vec3(0);
      for (let a = -1; a <= 1; a++) {
        for (let b = -1; b <= 1; b++) centre = centre.add(at(a, b).mul(w[a + 1] * w[b + 1]));
        dx = dx.add(at(1, a).sub(at(-1, a)).mul(w[a + 1]));
        dy = dy.add(at(a, 1).sub(at(a, -1)).mul(w[a + 1]));
      }
      // Per vertex, then interpolated: evaluated per fragment, the cell indices (the
      // template's interpolated x, y) would round down, and every cell would be shaded flat
      const normal = varying(normalize(cross(dx, dy)));
      const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0, side: THREE.DoubleSide });
      // On the plates' top faces, so what lands on the cloth sits on it
      // The sheet runs through the plates' centres; reach on half a cell at its borders, so
      // it covers the edge plates (and meets what is tied to them). At a border the Sobel
      // sums (weights 1 2 1) span one cell, a quarter of each
      const out = (k: THREE.Node<'float'>, last: number) => select(k.lessThan(0.5), float(-0.125), select(k.greaterThan(last - 0.5), float(0.125), float(0)));
      const edge = dx.mul(out(i, rows - 1)).add(dy.mul(out(j, cols - 1)));
      material.positionNode = centre.div(16).add(edge).add(normal.mul(0.05));
      const facing = normalize(normal).mul(faceDirection);
      material.normalNode = transformNormalToView(facing);
      material.receivedShadowPositionNode = shadowLookup(facing) as unknown as THREE.Node<'float'>;
      material.colorNode = texture(print!, uv());
      const sheet = new THREE.Mesh(geometry, material);
      sheet.frustumCulled = false;
      sheet.castShadow = true;
      sheet.receiveShadow = true;
      this.extras.add(sheet);
    }
  }

  dispose(): void {
    for (const shape of this.shapes) {
      shape.geometry.dispose();
      shape.material.dispose();
    }
    this.floor?.mirror?.dispose();
    this.extras.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.group.removeFromParent();
  }
}
