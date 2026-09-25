// The collapsing tower: a round brick tower too tall to hold itself up, and the rubble, seen
// from above, is the Mona Lisa. The same trick as the painting (painting.ts): the scene is
// deterministic, so a first run off screen finds where every brick comes to rest, each brick
// takes the colour of the picture at its spot as seen from overhead, and the run shown next
// brings the same tower down into the picture.

import { brick, type CameraView, type Scene3D } from './bench-scenes.ts';
import { Rigid } from './ref/body.ts';
import type { Solver } from './ref/solver.ts';

/** Picture shape (width / height): the Mona Lisa's. */
const ASPECT = 0.671;
const BRICK_PITCH = 1.02;
/** Width of the gilded band around the picture, as a share of its height. */
const FRAME = 0.06;
/** Rings of bricks in the tower's wall. */
const RINGS = 2;
/** Steps for the tower to come down and the rubble to settle. */
const STEPS = 960;

export interface TowerLayout {
  radius: number;
  courses: number;
  bricks: number;
  steps: number;
}

/** A tower of about `bricks` bricks, about two and a half times as tall as it is wide. */
export function towerLayout(bricks: number): TowerLayout {
  // Bricks per course ~ 2π r / pitch per ring; height 0.5 m a course; height ~ 2.5 x diameter
  const perCourse = (r: number) => {
    let n = 0;
    for (let j = 0; j < RINGS; j++) n += Math.floor((2 * Math.PI * (r + 0.25 + 0.52 * j - 0.25)) / BRICK_PITCH);
    return n;
  };
  let radius = 4;
  while (perCourse(radius) * Math.round((2.5 * 2 * radius) / 0.5) < bricks) radius += 0.25;
  const courses = Math.max(4, Math.round(bricks / perCourse(radius)));
  return { radius, courses, bricks: courses * perCourse(radius), steps: STEPS };
}

/** Ground thick enough that a brick falling the tower's height can't pass through it in a step. */
export function buildTower(solver: Solver, layout: TowerLayout): void {
  solver.clear();
  const { radius, courses } = layout;
  const extent = Math.max(300, 12 * radius);
  new Rigid(solver, [extent, extent, 40], 0, 0.5, [0, 0, -19.5]);
  for (let c = 0; c < courses; c++) {
    for (let j = 0; j < RINGS; j++) {
      const r = radius + 0.25 + 0.52 * j;
      const n = Math.floor((2 * Math.PI * (r - 0.25)) / BRICK_PITCH);
      for (let i = 0; i < n; i++) {
        const a = ((i + (c % 2) * 0.5) / n) * 2 * Math.PI;
        brick(solver, r * Math.cos(a), r * Math.sin(a), 0.75 + 0.5 * c, a + Math.PI / 2);
      }
    }
  }
}

/**
 * Where in the picture each brick at its final position (x y z in `p`) sits, seen from above
 * (u along +x, v down the picture along -y). The picture is the largest Mona Lisa-shaped
 * rectangle, centred on the rubble, that the rubble covers almost everywhere with its frame; bricks outside
 * it get coordinates past 0..1 (see rubbleSurround).
 */
export function rubbleCoords(p: Float32Array): Float32Array {
  const n = p.length / 3;
  const { cx, cy, h } = rubblePicture(p);
  const w = ASPECT * h;
  const uv = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    uv[2 * i] = (p[3 * i] - (cx - w / 2)) / w;
    uv[2 * i + 1] = (cy + h / 2 - p[3 * i + 1]) / h;
  }
  return uv;
}

/** The picture's centre and height on the ground (rubbleCoords). */
export function rubblePicture(p: Float32Array): { cx: number; cy: number; h: number } {
  const n = p.length / 3;
  // Centre: the median brick
  const xs = Array.from({ length: n }, (_, i) => p[3 * i]).sort((a, b) => a - b);
  const ys = Array.from({ length: n }, (_, i) => p[3 * i + 1]).sort((a, b) => a - b);
  const [cx, cy] = [xs[n >> 1], ys[n >> 1]];
  // Covered 1 m cells
  const cells = new Set<number>();
  const key = (x: number, y: number) => (Math.floor(x) + 4096) * 8192 + (Math.floor(y) + 4096);
  for (let i = 0; i < n; i++) cells.add(key(p[3 * i], p[3 * i + 1]));
  // The picture with its frame round it
  const coverage = (h: number) => {
    const w = ASPECT * h + 2 * FRAME * h;
    h += 2 * FRAME * h;
    let covered = 0;
    let total = 0;
    for (let x = cx - w / 2; x < cx + w / 2; x += 1) {
      for (let y = cy - h / 2; y < cy + h / 2; y += 1) {
        total++;
        if (cells.has(key(x, y))) covered++;
      }
    }
    return covered / Math.max(total, 1);
  };
  let h = 8;
  while (h < 1000 && coverage(h + 1) >= 0.95) h += 1;
  return { cx, cy, h };
}

const FRAME_COLOR = 0xb8923c;
/** Bricks thrown past the frame: the floor's cream, so the picture stands out. */
const STRAY_COLOR = 0xe4d9c4;

/** Colour of a brick off the picture at (u, v): the frame round it, then the floor's. */
export function rubbleSurround(u: number, v: number): number {
  const out = Math.max(ASPECT * Math.max(-u, u - 1), -v, v - 1);
  return out < FRAME ? FRAME_COLOR : STRAY_COLOR;
}

/** The tower from the side. */
export function towerView(bricks: number): CameraView {
  const height = 0.5 * towerLayout(bricks).courses;
  return { distance: 1.5 * height, target: [0, 0, 0.4 * height], azimuth: -35, elevation: 0.3, fit: [0.9 * height, 1.1 * height] };
}

/** Straight down on the rubble: the picture is about 0.87 of the tower's height tall, centred. */
export function towerTopView(bricks: number): CameraView {
  const height = 0.5 * towerLayout(bricks).courses;
  return { distance: height, target: [0, 0, 0], azimuth: -90, elevation: 1.5, fit: [0.8 * height, 1.05 * height] };
}

/** The viewer's scene: about `bricks` bricks fall into the Mona Lisa. */
export const monaLisaTower: Scene3D = {
  name: 'Mona Lisa Tower (50k)',
  build: (solver, o) => buildTower(solver, towerLayout(o?.bricks ?? 50_000)),
  options: { bricks: 50_000 },
  gpuOnly: true,
  params: { iterations: 4 },
  camera: (o) => towerView(o.bricks),
  // Twice the most a brick used, measured (tools/tower-preview.ts): about 3 pairs and 12 contact points
  capacity: (o) => ({ pairs: 8 * o.bricks, manifolds: 6 * o.bricks, contacts: 24 * o.bricks, colors: 16 }),
  picture: {
    url: '/paintings/mona-lisa.jpg',
    bodies: 'dynamic',
    steps: (o) => towerLayout(o.bricks).steps,
    coords: (_, p) => rubbleCoords(p),
    surround: (_, u, v) => rubbleSurround(u, v),
    frame: () => [],
  },
};
