// The painting scene: a pour head sweeps along the top of a glass-fronted box one sphere deep,
// raining spheres that come to rest forming a picture. The trick is two runs of the same deterministic simulation
// (see GpuSolverOptions.capacity): the first, off screen, finds where each sphere ends up; each
// sphere then takes the picture's colour at that spot, and the second run, shown live, pours
// the already-coloured spheres into place.
//
// Everything is sized from the sphere count so no sphere moves more than about 0.8 of its
// radius in a step (faster, spheres can pass through each other between steps): a finer
// timestep and gentle gravity. That caps how fast a single stream can deliver spheres (a jet
// thick enough for 20k in 20 s is a fifth of the picture tall), so the head drops wide rows,
// and sweeping it keeps the pile's top level.

import type { Emitter3D, Scene3D } from './bench-scenes.ts';
import { sphere } from './shapes.ts';
import { Rigid } from './ref/body.ts';
import type { Solver } from './ref/solver.ts';
import { setVisual } from './visuals.ts';

/** Picture shape (width / height): The Starry Night's. */
export const PAINTING_ASPECT = 1.262;
const RADIUS = 0.12;
/** Step length: a 120 Hz step lets the jet deliver spheres twice as fast for the same safety. */
export const PAINTING_DT = 1 / 120;
/** Most a sphere may move in a step, in radii. */
const STEP_RADII = 0.8;
/** Area a sphere takes in the settled pile (discs pack at about 0.84 when poured). */
const PACKING = 0.84;
/** Seconds the pour lasts. */
const POUR_SECONDS = 20;
/** Seconds after the pour for the last spheres to land and the pile to settle. */
const SETTLE_SECONDS = 6;
/** Seconds for the head to sweep across and back. */
const SWEEP_SECONDS = 5;
/** Rows leave the head at this share of the safe speed (gravity does the rest). */
const DROP_SPEED = 0.5;

export interface PaintingLayout {
  bodies: number;
  radius: number;
  /** Inner size of the box: the picture's width and the pile's expected height. */
  width: number;
  height: number;
  /** Inner height with room above the pile for the jet. */
  boxHeight: number;
  depth: number;
  gravity: number;
  /** Pour head: a row of `perRow` spheres every `period` steps, dropping at `speed` m/s. */
  perRow: number;
  period: number;
  speed: number;
  sweepSteps: number;
  /** Steps to run before the picture is complete (pour plus settling). */
  steps: number;
}

export function paintingLayout(bodies: number): PaintingLayout {
  const r = RADIUS;
  const area = (bodies * Math.PI * r * r) / PACKING;
  const height = Math.sqrt(area / PAINTING_ASPECT);
  const width = PAINTING_ASPECT * height;
  const boxHeight = height * 1.3;
  const maxSpeed = (STEP_RADII * r) / PAINTING_DT;
  // Fastest at the bottom of the full fall: v² = 2 g h
  const gravity = (maxSpeed * maxSpeed) / (2 * boxHeight);
  // Rows far enough apart not to overlap, wide enough to pour them all in POUR_SECONDS
  const speed = DROP_SPEED * maxSpeed;
  const spacing = 2.1 * r;
  const period = Math.ceil(spacing / (speed * PAINTING_DT));
  const pourSteps = Math.round(POUR_SECONDS / PAINTING_DT);
  const perRow = Math.min(Math.floor(width / spacing) - 2, Math.ceil((bodies * period) / pourSteps));
  const steps = Math.ceil((bodies / perRow) * period + SETTLE_SECONDS / PAINTING_DT);
  const sweepSteps = Math.round(SWEEP_SECONDS / PAINTING_DT);
  return { bodies, radius: r, width, height, boxHeight, depth: 2 * r * 1.15, gravity, perRow, period, speed, sweepSteps, steps };
}

const WALL = 2;
const BACK_COLOR = 0x14161c;
const FRAME_COLOR = 0x2a2522;

/** The box: floor, sides and lid (the frame), a dark back, and an invisible glass front. */
export function buildPainting(solver: Solver, layout: PaintingLayout): void {
  solver.clear();
  const { width: w, boxHeight: h, depth: d } = layout;
  const box = (size: [number, number, number], at: [number, number, number], look: Parameters<typeof setVisual>[1]) =>
    setVisual(new Rigid(solver, size, 0, 0.4, at), look);
  // The ground the box stands on (the viewer's floor)
  new Rigid(solver, [Math.max(200, 4 * w), Math.max(200, 4 * w), 1], 0, 0.5, [0, 0, -0.5 - WALL]);
  const span = w + 2 * WALL;
  box([span, d + 2 * WALL, WALL], [0, 0, -WALL / 2], { color: FRAME_COLOR });
  box([span, d + 2 * WALL, WALL], [0, 0, h + WALL / 2], { color: FRAME_COLOR });
  box([WALL, d + 2 * WALL, h], [-(w + WALL) / 2, 0, h / 2], { color: FRAME_COLOR });
  box([WALL, d + 2 * WALL, h], [(w + WALL) / 2, 0, h / 2], { color: FRAME_COLOR });
  box([w, WALL, h], [0, (d + WALL) / 2, h / 2], { color: BACK_COLOR });
  box([w, WALL, h], [0, -(d + WALL) / 2, h / 2], { shape: 'hidden' });
}

/**
 * The pour head: before every `period`-th step, a row of spheres just under the lid, dropping.
 * The head sweeps left and right along the box so the pile rises level. A function of the step
 * number alone, so every run pours identically.
 */
export function paintingEmitter(layout: PaintingLayout): Emitter3D {
  const { radius: r, width: w, boxHeight: h, perRow, period, speed, sweepSteps, bodies } = layout;
  const spacing = 2.1 * r;
  const half = ((perRow - 1) * spacing) / 2;
  const reach = w / 2 - 1.5 * r - half;
  const z = h - 1.5 * r;
  return {
    bodies,
    spawn(step, solver) {
      if (step % period !== 0) return;
      const n = Math.min(perRow, bodies - (step / period) * perRow);
      if (n <= 0) return;
      // Triangle wave: left to right and back once per sweep
      const t = (step % sweepSteps) / sweepSteps;
      const x = -reach + 2 * reach * (t < 0.5 ? 2 * t : 2 - 2 * t);
      for (let k = 0; k < n; k++) sphere(solver, r, 1, 0.4, [x - half + k * spacing, 0, z], [0, 0, -speed]);
    },
  };
}

/**
 * Where in the picture (u, v in 0..1, v down) each body at final position (x[i], z[i]) sits.
 * The pile's top isn't quite level, so each column of it is stretched to the picture's top
 * edge: v runs from the floor to that column's own surface (smoothed across neighbours), and
 * no strip of the picture is lost above a dip, nor any sphere left without a colour.
 */
export function pictureCoords(layout: PaintingLayout, x: ArrayLike<number>, z: ArrayLike<number>): Float32Array {
  const { width: w, radius: r } = layout;
  const n = x.length;
  const bins = Math.max(4, Math.round(w / (8 * r)));
  const binOf = (xi: number) => Math.min(bins - 1, Math.max(0, Math.floor(((xi + w / 2) / w) * bins)));
  // Each column's surface: its 98th-percentile height (ignores a few spheres resting on top)
  const heights: number[][] = Array.from({ length: bins }, () => []);
  for (let i = 0; i < n; i++) heights[binOf(x[i])].push(z[i]);
  const surface = heights.map((hs) => {
    if (!hs.length) return 0;
    hs.sort((a, b) => a - b);
    return hs[Math.floor(0.98 * (hs.length - 1))] + r;
  });
  const smooth = surface.map((_, b) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, b - 2); k <= Math.min(bins - 1, b + 2); k++) {
      if (surface[k] > 0) {
        sum += surface[k];
        count++;
      }
    }
    return count ? sum / count : layout.height;
  });
  const uv = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    const u = (x[i] + w / 2) / w;
    // Between bin centres, the surface is interpolated
    const f = Math.min(bins - 1, Math.max(0, u * bins - 0.5));
    const b = Math.floor(f);
    const top = smooth[b] + (smooth[Math.min(bins - 1, b + 1)] - smooth[b]) * (f - b);
    uv[2 * i] = Math.min(1, Math.max(0, u));
    uv[2 * i + 1] = Math.min(1, Math.max(0, 1 - z[i] / top));
  }
  return uv;
}

/** The viewer's scene: `bodies` spheres paint The Starry Night. */
export const starryNight: Scene3D = {
  name: 'Starry Night (20k)',
  build: (solver, o) => buildPainting(solver, paintingLayout(o?.bodies ?? 20_000)),
  options: { bodies: 20_000 },
  gpuOnly: true,
  params: (o) => ({ dt: PAINTING_DT, gravity: -paintingLayout(o.bodies).gravity, iterations: 4 }),
  camera: (o) => {
    // Straight on, the whole frame in view
    const { boxHeight, width } = paintingLayout(o.bodies);
    const [w, h] = [width + 2 * WALL, boxHeight + 2 * WALL];
    return { distance: (0.54 * h) / Math.tan((22.5 * Math.PI) / 180), fit: [w, h], target: [0, 0, boxHeight / 2 - WALL / 2], azimuth: -90, elevation: 0.04 };
  },
  emitter: (o) => paintingEmitter(paintingLayout(o.bodies)),
  // A sphere in a single layer touches about six others and the glass and back
  capacity: (o) => ({ pairs: 16 * o.bodies, manifolds: 8 * o.bodies, contacts: 8 * o.bodies, colors: 10 }),
  picture: {
    url: '/paintings/starry-night.jpg',
    steps: (o) => paintingLayout(o.bodies).steps,
    coords: (o, x, z) => pictureCoords(paintingLayout(o.bodies), x, z),
  },
};
