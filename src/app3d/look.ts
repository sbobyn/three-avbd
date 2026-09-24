// The viewer's look, after the renders on the AVBD project page: a hazy sky, warm low sun, a
// cream-and-taupe checkered floor, and blocks each in their own muted pastel with darkened
// edges, so a wall reads as a mosaic of bricks even from far away. Shared by the GPU-driven
// meshes (gpu-bodies3d.ts) and the CPU reference path (renderer3d.ts).

import { abs, color, float, fract, fwidth, hash, max, min, mix, positionWorld, smoothstep, uniformArray, vec2 } from 'three/tsl';
import * as THREE from 'three/webgpu';

type Vec3 = THREE.Node<'vec3'>;
type Uint = THREE.Node<'uint'>;
type Float = THREE.Node<'float'>;

export const LOOK = {
  skyZenith: 0xb9d3ea,
  skyHorizon: 0xf6f3ec,
  sun: 0xfff0d8,
  sunIntensity: 3.2,
  skyLight: 0xdde9f5,
  groundLight: 0xb7a58a,
  hemisphereIntensity: 1.4,
  floorLight: 0xf0e9dc,
  floorDark: 0xd8c8ad,
  /** Floor tile edge (m): about a brick's length. */
  floorTile: 1,
  static: 0x9aa0a6,
  selected: 0xffb020,
  joint: 0xbf0000,
  contact: 0xbf0000,
  drag: 0xe0a33a,
} as const;

/** Muted pastels for blocks (rose, peach, butter, sage, mint, sky, lilac, pink). */
export const BLOCK_PALETTE = [0xe79aa3, 0xf2bf8c, 0xece08c, 0xb8d68e, 0x9ccfbd, 0xa3c1e8, 0xc4a5df, 0xe9b3cf];
/** Spheres: the salmon pink of the project page's balls. */
export const SPHERE_PALETTE = [0xe8828f];

const blockColors = uniformArray(BLOCK_PALETTE.map((c) => new THREE.Color(c)), 'color');
const sphereColors = uniformArray(SPHERE_PALETTE.map((c) => new THREE.Color(c)), 'color');

/** A block's colour, picked by hashing its index, with a little brightness jitter. */
export function blockColor(index: Uint): Vec3 {
  const h = hash(index);
  const base = blockColors.element(h.mul(BLOCK_PALETTE.length).floor().toUint()) as unknown as Vec3;
  return base.mul(hash(index.add(7919)).mul(0.16).add(0.92));
}

export function sphereColor(index: Uint): Vec3 {
  return sphereColors.element(hash(index).mul(SPHERE_PALETTE.length).floor().toUint()) as unknown as Vec3;
}

/**
 * Darkening towards a box's edges: 1 inside a face, down to 0.55 at an edge. `local` is the
 * point on the unit box ([-0.5, 0.5]^3) and `size` the box's full widths, so the band is
 * `width` metres wide on every face whatever the box's proportions.
 */
export function edgeShade(local: Vec3, size: Vec3, width = 0.035): Float {
  const inset = size.mul(0.5).sub(abs(local.mul(size)));
  // On a face one component is ~0; the distance to the nearest edge is the middle one
  const sum = inset.x.add(inset.y).add(inset.z);
  const mid = sum.sub(max(inset.x, max(inset.y, inset.z))).sub(min(inset.x, min(inset.y, inset.z)));
  return smoothstep(float(0), float(width), mid).mul(0.45).add(0.55);
}

/**
 * Two-tone checker in world XY, box-filtered by the pixel footprint (fwidth) so distant tiles
 * blend to their average instead of shimmering.
 */
export function floorChecker(): Vec3 {
  const p = positionWorld.xy.div(LOOK.floorTile);
  const w = max(fwidth(p), vec2(1e-4));
  const tri = (x: THREE.Node<'vec2'>) => abs(fract(x.mul(0.5)).sub(0.5));
  const i = tri(p.sub(w.mul(0.5))).sub(tri(p.add(w.mul(0.5)))).mul(2).div(w);
  const t = float(0.5).sub(i.x.mul(i.y).mul(0.5));
  return mix(color(LOOK.floorLight), color(LOOK.floorDark), t);
}

/** Static slabs wide enough to be the ground get the checkered floor. */
export const isFloorSize = (size: ArrayLike<number>): boolean => size[0] >= 20 && size[1] >= 20;

/** The floor is drawn this wide (m) whatever the slab's size, so it runs on into the haze. */
export const FLOOR_EXTENT = 8000;
