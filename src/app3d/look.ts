// The viewer's look, after the renders on the AVBD project page: a hazy sky, warm low sun, a
// cream-and-taupe checkered floor, and blocks each in their own muted pastel with darkened
// edges, so a wall reads as a mosaic of bricks even from far away. Shared by the GPU-driven
// meshes (gpu-bodies3d.ts) and the CPU reference path (renderer3d.ts).

import { abs, cameraPosition, color, float, fract, fwidth, hash, max, min, mix, normalize, positionLocal, positionWorld, pow, smoothstep, uniform, uniformArray, vec2 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { RING } from '../avbd3d/visuals.ts';

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
  hemisphereIntensity: 0.35,
  /** The studio environment's strength (studioEnvironment). */
  environmentIntensity: 0.5,
  /** Ambient occlusion: its reach (m), how thick surfaces are assumed to be, its strength. */
  aoRadius: 2,
  aoThickness: 2,
  aoStrength: 1.8,
  /** The floor mirror's blur: the mip level it's sampled at (it renders at half resolution). */
  mirrorBlur: 2.2,
  floorLight: 0xf0e9dc,
  floorDark: 0xd8c8ad,
  /** Floor tile edge (m): about a brick's length. */
  floorTile: 1,
  /** The lacquer: reflectance head-on, the sky's reflection strength, the sun's highlight. */
  floorF0: 0.06,
  floorGloss: 0.9,
  floorRoughness: 0.28,
  static: 0x9aa0a6,
  selected: 0xffb020,
  joint: 0xbf0000,
  contact: 0xbf0000,
  drag: 0xe0a33a,
  /** Hovered body: blended this far towards `hoverTint`, so what a click grabs is clear. */
  hoverTint: 0xfff4dc,
  hoverAmount: 0.45,
  spring: 0xa9b2bb,
  metalRoughness: 0.22,
  rope: 0xc9a46e,
  cannonball: 0x3a3d42,
  /**
   * Chain-mail rings, as fractions of the link's width: the centreline radius of the flat
   * rings and of the standing rings joining them (each passes through its two flat
   * neighbours without touching the rest), and the wire's radius.
   */
  ringFlat: RING.flat,
  ringLink: RING.link,
  ringWire: RING.wire,
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

/** The sky's colour in a direction whose height (z of the unit vector) is `z`. */
export const skyColor = (z: Float): Vec3 => mix(color(LOOK.skyHorizon), color(LOOK.skyZenith), smoothstep(0.02, 0.6, z)) as unknown as Vec3;

/**
 * The floor as a glossy, lacquered checker, as in the paper's renders: the checker lit as usual
 * and, on top, the sky reflected with Schlick's Fresnel, so the floor takes on the sky's sheen
 * towards the horizon. The sky is a gradient in height alone, so its mirror image needs no
 * environment map: a ray reflected off a level floor rises as steeply as the view ray falls.
 * (Bodies are not reflected.)
 */
export function glossyFloor(material: THREE.MeshStandardNodeMaterial, mirror?: Vec3): void {
  const view = normalize(cameraPosition.sub(positionWorld));
  const cos = max(view.z, float(0));
  const fresnel = float(LOOK.floorF0).add(float(1 - LOOK.floorF0).mul(pow(float(1).sub(cos), 5)));
  material.roughness = LOOK.floorRoughness;
  // Its reflections are all its own (not the environment map's): the sky, or with `mirror`
  // (a planar reflection of the scene) everything above it
  material.envMapIntensity = 0;
  material.colorNode = floorChecker().mul(float(1).sub(fresnel)) as unknown as THREE.Node<'color'>;
  material.emissiveNode = (mirror ?? skyColor(cos)).mul(fresnel.mul(LOOK.floorGloss)) as unknown as THREE.Node<'color'>;
}

/**
 * The environment every material reflects and is lit by (scene.environment, never drawn): the
 * sky's gradient overhead, the floor's tones below, and three soft studio panels up high for
 * broad highlights. Prefiltered once (PMREM) for rough and smooth surfaces alike.
 */
export function studioEnvironment(renderer: THREE.WebGPURenderer): THREE.Texture {
  const env = new THREE.Scene();
  const dome = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide });
  const z = normalize(positionLocal).z;
  const ground = mix(color(LOOK.floorLight), color(LOOK.floorDark), 0.5).mul(0.55);
  dome.colorNode = mix(ground, skyColor(max(z, float(0))), smoothstep(-0.12, 0.02, z)) as unknown as THREE.Node<'color'>;
  env.add(new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), dome));
  for (const [azimuth, elevation, width, height, strength] of [
    [0.6, 0.9, 6, 4, 3.2],
    [2.6, 0.7, 5, 3, 2],
    [4.4, 0.35, 8, 2, 1.4],
  ]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff6ea).multiplyScalar(strength), side: THREE.DoubleSide }));
    panel.position.set(8 * Math.cos(elevation) * Math.cos(azimuth), 8 * Math.cos(elevation) * Math.sin(azimuth), 8 * Math.sin(elevation));
    panel.up.set(0, 0, 1);
    panel.lookAt(0, 0, 0);
    env.add(panel);
  }
  const target = new THREE.PMREMGenerator(renderer).fromScene(env, 0.02);
  return target.texture;
}

/** The shadow map's texel size in metres (the renderer sets it as the view zooms). */
export const shadowTexel = uniform(0.02);

/**
 * Where a smooth surface looks up its shadow: nudged off it along its (world) normal by a
 * texel and a half, so curved and sloping surfaces don't shadow themselves in fine stripes.
 * Three's own normalBias would push along the template's vertex normals, which for bodies
 * placed in the vertex shader point the wrong way.
 */
export const shadowLookup = (normalWorld: Vec3): Vec3 => positionWorld.add(normalWorld.mul(shadowTexel.mul(1.5))) as unknown as Vec3;

/** Static slabs wide enough to be the ground get the checkered floor. */
export const isFloorSize = (size: ArrayLike<number>): boolean => size[0] >= 20 && size[1] >= 20;

/** The floor is drawn this wide (m) whatever the slab's size, so it runs on into the haze. */
export const FLOOR_EXTENT = 8000;

/**
 * The cloth's print: plain linen with an emblem of our own (a brick pyramid in a roundel). Drawn
 * once on a canvas; the cloth maps it corner to corner.
 */
export function clothTexture(size = 1024): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const c = size / 2;
  g.fillStyle = '#f4efe6';
  g.fillRect(0, 0, size, size);

  const r = size * 0.3;
  g.fillStyle = '#2e5a78';
  g.beginPath();
  g.arc(c, c, r, 0, 2 * Math.PI);
  g.fill();
  g.strokeStyle = '#e1795b';
  g.lineWidth = size * 0.014;
  g.beginPath();
  g.arc(c, c, r * 0.9, 0, 2 * Math.PI);
  g.stroke();

  // Four courses of bricks, running bond, in the palette
  const brick = r * 0.2;
  const palette = BLOCK_PALETTE.map((p) => `#${p.toString(16).padStart(6, '0')}`);
  for (let row = 0; row < 4; row++) {
    const n = 4 - row;
    for (let i = 0; i < n; i++) {
      const x = c + (i - (n - 1) / 2) * brick * 1.08 - brick / 2;
      const y = c + r * 0.1 - row * brick * 0.56;
      g.fillStyle = palette[(row * 3 + i * 5) % palette.length];
      g.beginPath();
      g.roundRect(x, y, brick, brick * 0.5, brick * 0.08);
      g.fill();
    }
  }
  g.fillStyle = '#f4efe6';
  g.font = `700 ${Math.round(r * 0.3)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('AVBD', c, c + r * 0.5);

  // The name around the roundel
  const text = 'AUGMENTED VERTEX BLOCK DESCENT · ';
  g.fillStyle = '#2e5a78';
  g.font = `600 ${Math.round(size * 0.034)}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
  const ring = r * 1.14;
  for (let i = 0; i < text.length; i++) {
    const a = (i / text.length) * 2 * Math.PI - Math.PI / 2;
    g.save();
    g.translate(c + ring * Math.cos(a), c + ring * Math.sin(a));
    g.rotate(a + Math.PI / 2);
    g.fillText(text[i], 0, 0);
    g.restore();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}
