// Large 3D scenes for the GPU solver: benchmarks and the viewer's GPU-only showcase scenes
// (after the paper's figures). Built with the reference's Rigid/Joint so mass properties and
// joint conventions match the demo's; spheres come from ./shapes.ts.

import { Rigid } from './ref/body.ts';
import { IgnoreCollision, Joint } from './ref/forces.ts';
import { cross, length, qmul, qnormalize, quat, rotate, rotateInv, sub3, vec3 } from './ref/math.ts';
import type { GpuParams3D, GpuSolverOptions } from './gpu/solver.ts';
import type { Solver } from './ref/solver.ts';
import { sail, sphere } from './shapes.ts';
import { addCloth, addLabel, addRope, EYE, hsl, RING, setVisual } from './visuals.ts';

/**
 * A ground slab sized to hold `extent` metres of content with room for debris to scatter (the
 * viewer draws the floor on to the horizon, so bodies must not slide off an unseen edge), top
 * face at z = 0.5.
 */
function ground(solver: Solver, extent: number): Rigid {
  const size = Math.max(200, 4 * extent);
  return new Rigid(solver, [size, size, 1], 0, 0.5, [0, 0, 0]);
}

/** Deterministic pseudo-random numbers in [0, 1). */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 2 ** 32);
}

/** n × n columns of h unit boxes, each resting on the one below (settled stacks). */
export function boxColumns(solver: Solver, n: number, h: number): void {
  solver.clear();
  ground(solver, n * 1.5);
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      for (let z = 0; z < h; z++) new Rigid(solver, [1, 1, 1], 1, 0.5, [(x - n / 2) * 1.5, (y - n / 2) * 1.5, 1 + z]);
    }
  }
}

/** An n × n × h block of randomly sized and turned boxes dropped into a pile. */
export function boxPile(solver: Solver, n: number, h: number): void {
  solver.clear();
  ground(solver, n * 1.6);
  const rand = random(12345);
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const size = [0.5 + rand() * 0.7, 0.5 + rand() * 0.7, 0.5 + rand() * 0.7];
        const b = new Rigid(solver, size, 1, 0.5, [(x - n / 2) * 1.6, (y - n / 2) * 1.6, 2 + z * 1.6]);
        const q = [rand() - 0.5, rand() - 0.5, rand() - 0.5, rand() - 0.5];
        const l = Math.hypot(...q);
        b.positionAng.set(q.map((c) => c / l));
      }
    }
  }
}

/** A brick (1 × 0.5 × 0.5, as in the demo's pyramid) turned `angle` about z. */
function brick(solver: Solver, x: number, y: number, z: number, angle = 0): Rigid {
  const b = new Rigid(solver, [1, 0.5, 0.5], 1, 0.5, [x, y, z]);
  b.positionAng.set([0, 0, Math.sin(angle / 2), Math.cos(angle / 2)]);
  return b;
}

/** A sphere resting on the ground (top face z = 0.5) at (x, y), rolling along +y at `speed`. */
function rollingBall(solver: Solver, r: number, density: number, x: number, y: number, speed: number): Rigid {
  const ball = sphere(solver, r, density, 0.5, [x, y, 0.5 + r], [0, speed, 0]);
  ball.velocityAng.set([-speed / r, 0, 0]);
  return ball;
}

/**
 * Paper Fig. 1: a ring wall of bricks smashed by a sphere rolling in from outside, through the
 * near wall, across the arena and out through the far wall. `courses` courses of bricks laid
 * tangentially in running bond on rings from `radius` outwards, `rows` bricks deep at the
 * bottom and one fewer every `tier` courses, so the outside is stepped and the inside sheer.
 * Bricks rest exactly on each other, so it stands from the first frame and a benchmark can time
 * the smash without a settle. The ball is 0.8 of the wall's height across, as in the paper's
 * renders. Defaults: 110,332 bricks, 20 m high, 160 m across.
 */
export function brickRing(solver: Solver, radius = 80, courses = 40, tier = 4, rows = 10): void {
  solver.clear();
  ground(solver, radius + rows);
  for (let c = 0; c < courses; c++) {
    const depth = Math.max(1, rows - Math.floor(c / tier));
    for (let j = 0; j < depth; j++) {
      // Rings 2 cm apart: a straight brick's corners reach past its ring's outer radius
      const r = radius + 0.25 + 0.52 * j;
      // As many bricks as fit on the ring's inner edge with 2% gaps; odd courses offset by half
      const n = Math.floor((2 * Math.PI * (r - 0.25)) / 1.02);
      for (let i = 0; i < n; i++) {
        const a = ((i + (c % 2) * 0.5) / n) * 2 * Math.PI;
        brick(solver, r * Math.cos(a), r * Math.sin(a), 0.75 + 0.5 * c, a + Math.PI / 2);
      }
    }
  }
  // Just outside the stepped face, on its way in
  const r = courses / 5;
  rollingBall(solver, r, 10, 0, -(radius + 0.52 * rows + r + 2), 30);
}

/**
 * Paper Fig. 3: a field of triangular brick walls, one brick thick, smashed by two heavy spheres
 * rolling through it. Each wall is a brick pyramid `base` bricks wide (course k: base − k
 * bricks, offset by half a brick), facing ±y; `columns` × `rows` of them stand on a grid.
 * Defaults: 1,088 walls of 465 bricks, 505,920 bricks.
 */
export function brickGables(solver: Solver, columns = 16, rows = 68, base = 30, ballColumns = [columns / 2 - 2, columns / 2 + 1]): void {
  solver.clear();
  const [pitchX, pitchY] = [base + 2, 5];
  ground(solver, Math.max(columns * pitchX, rows * pitchY) / 2);
  for (let cx = 0; cx < columns; cx++) {
    for (let cy = 0; cy < rows; cy++) {
      const x0 = (cx - (columns - 1) / 2) * pitchX;
      const y = (cy - (rows - 1) / 2) * pitchY;
      for (let k = 0; k < base; k++) {
        const m = base - k;
        for (let i = 0; i < m; i++) brick(solver, x0 + (i - (m - 1) / 2) * 1.01, y, 0.75 + 0.5 * k);
      }
    }
  }
  // Down two columns (by default either side of the middle) after a 12 m run-up, dense enough
  // to carry on through the rubble they push ahead of them
  const r = base / 7;
  for (const cx of ballColumns) {
    rollingBall(solver, r, 50, (cx - (columns - 1) / 2) * pitchX, -((rows - 1) / 2) * pitchY - r - 12, 30);
  }
}

/**
 * A stand-in for paper Fig. 14 (35,000 bodies joined by 72,000 joints falling onto a cloth; no
 * cloth here). Plates of 5 × 5 × 2 small cubes ball-jointed at their shared face centres (50
 * bodies, 105 joints each), `grid` × `grid` per layer, drop in `layers` staggered layers onto a
 * chain-mail net of `net` × `net` links pinned along its border. Defaults: 34,096 bodies and
 * 71,064 joints.
 */
export function jointedDrop(solver: Solver, grid = 10, layers = 6, net = 64): void {
  solver.clear();
  ground(solver, net * 0.5);
  const s = 0.5;
  const zNet = 4;
  const links: Rigid[][] = [];
  for (let x = 0; x < net; x++) {
    links.push([]);
    for (let y = 0; y < net; y++) {
      const edge = x === 0 || y === 0 || x === net - 1 || y === net - 1;
      links[x].push(new Rigid(solver, [s * 0.9, s * 0.9, 0.1], edge ? 0 : 1, 0.5, [(x - (net - 1) / 2) * s, (y - (net - 1) / 2) * s, zNet]));
    }
  }
  for (let x = 0; x < net; x++) {
    for (let y = 0; y < net; y++) {
      if (x > 0) new Joint(solver, links[x - 1][y], links[x][y], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (y > 0) new Joint(solver, links[x][y - 1], links[x][y], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  addCloth(solver, links);
  const c = 0.4;
  const [nx, ny, nz] = [5, 5, 2];
  const pitch = 3;
  for (let layer = 0; layer < layers; layer++) {
    const offset = layer % 2 === 0 ? 0 : pitch / 2;
    for (let gx = 0; gx < grid; gx++) {
      for (let gy = 0; gy < grid; gy++) {
        const origin = [(gx - (grid - 1) / 2) * pitch + offset - 0.75, (gy - (grid - 1) / 2) * pitch + offset - 0.75, zNet + 3 + layer * 2.5];
        const cells: Rigid[] = [];
        const at = (x: number, y: number, z: number) => cells[(x * ny + y) * nz + z];
        for (let x = 0; x < nx; x++) {
          for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
              cells.push(new Rigid(solver, [c, c, c], 1, 0.5, [origin[0] + (x - (nx - 1) / 2) * c, origin[1] + (y - (ny - 1) / 2) * c, origin[2] + z * c]));
            }
          }
        }
        for (let x = 0; x < nx; x++) {
          for (let y = 0; y < ny; y++) {
            for (let z = 0; z < nz; z++) {
              if (x > 0) new Joint(solver, at(x - 1, y, z), at(x, y, z), [c / 2, 0, 0], [-c / 2, 0, 0]);
              if (y > 0) new Joint(solver, at(x, y - 1, z), at(x, y, z), [0, c / 2, 0], [0, -c / 2, 0]);
              if (z > 0) new Joint(solver, at(x, y, z - 1), at(x, y, z), [0, 0, c / 2], [0, 0, -c / 2]);
            }
          }
        }
      }
    }
  }
}

/** Hemp, as the viewer's ropes are drawn. */
export const ROPE_COLOR = 0xdcc393;
const STEEL = 0xd6dade;

/** A static rod from `a` to `b`, drawn as a polished steel capsule. */
function steelRod(solver: Solver, a: ArrayLike<number>, b: ArrayLike<number>, diameter: number): Rigid {
  const d = sub3(vec3(), b, a);
  const len = length(d);
  const rod = new Rigid(solver, [len, diameter, diameter], 0, 0.5, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  rod.positionAng.set(alignX([d[0] / len, d[1] / len, d[2] / len]));
  return setVisual(rod, { shape: 'capsule', color: STEEL, metal: true });
}

/**
 * Where a rope of radius `r` hangs from: a grey block overhead with a steel eyebolt out of its
 * underside and a ring on the bolt, standing in the yz plane, its wire's lowest point at
 * `pivot` (where the rope's eye rests; the eye itself is drawn with the rope, see visuals.ts).
 * Everything is static; returns every part, for the rope not to collide with.
 */
export function ropeMount(solver: Solver, pivot: ArrayLike<number>, r: number): Rigid[] {
  const [px, py, pz] = [pivot[0], pivot[1], pivot[2]];
  const ringRadius = EYE.ring * r;
  const w = ringRadius / RING.link;
  const ringZ = pz + ringRadius;
  const ring = setVisual(new Rigid(solver, [w, w, 0.2 * w], 0, 0.5, [px, py, ringZ]), { shape: 'ringY', color: STEEL, metal: true });
  // The eyebolt's shank up into the block
  const underside = ringZ + ringRadius + 0.8 * r;
  const shank = steelRod(solver, [px, py, ringZ + ringRadius - 0.1 * r], [px, py, underside + 0.2], 0.56 * r);
  const block = new Rigid(solver, [1.2, 1.2, 1], 0, 0.5, [px, py, underside + 0.5]);
  return [block, shank, ring];
}

/**
 * The demo's Rope and Heavy Rope scenes, adjustable (the viewer's rope panel): a rope `length`
 * m long in `links` links, started horizontal and falling, hung by an eye splice from
 * ropeMount's ring, optionally with a block (`blockSize` wide, `weight` times a link's mass)
 * on its end. The first link hangs from the ring EYE.reach rope radii above its start (see
 * visuals.ts); otherwise, at the demo's numbers, the rope is the demo's.
 */
export function hangingRope(solver: Solver, length = 19, links = 19, weight = 0, blockSize = 0): void {
  solver.clear();
  const seg = length / links;
  const t = Math.min(0.5, 0.6 * seg);
  const reach = (EYE.reach * t) / 2;
  new Rigid(solver, [100, 100, 1], 0, 0.5, [0, 0, Math.min(-20, 10 - length - reach - 4)]);
  // The demo's pin (static, hidden); the rope's first joint at its +x end, the ring's wire
  const pin = setVisual(new Rigid(solver, [1, 0.5, 0.5], 0, 0.5, [0, 0, 10]), { shape: 'hidden' });
  const chain: Rigid[] = [];
  let prev = pin;
  let anchor = vec3(0.5, 0, 0);
  for (let i = 0; i < links; i++) {
    const link = new Rigid(solver, [seg, t, t], 1, 0.5, [0.5 + reach + seg * (i + 0.5), 0, 10]);
    new Joint(solver, prev, link, anchor, [-seg / 2 - (i === 0 ? reach : 0), 0, 0]);
    chain.push(link);
    prev = link;
    anchor = vec3(seg / 2, 0, 0);
  }
  if (weight > 0) {
    const size = blockSize || Math.max(1, 2 * t);
    const block = new Rigid(solver, [size, size, size], (weight * seg * t * t) / size ** 3, 0.5, [0.5 + reach + length + size / 2, 0, 10]);
    new Joint(solver, prev, block, anchor, [-size / 2, 0, 0]);
    addLabel(solver, [block], `${weight.toLocaleString('en')}× a link`);
  }
  addRope(solver, chain, ROPE_COLOR, { start: 'eye', end: weight > 0 ? 'tied' : 'free' });
  const parts = ropeMount(solver, [0.5, 0, 10], t / 2);
  for (const link of chain) for (const part of [pin, ...parts]) new IgnoreCollision(solver, part, link);
}

/** The rotation taking the x axis onto the unit vector `d`. */
function alignX(d: ArrayLike<number>): Float64Array {
  const w = 1 + d[0];
  if (w < 1e-9) return quat(0, 0, 1, 0);
  const c = cross(vec3(), [1, 0, 0], d);
  return qnormalize(quat(), quat(c[0], c[1], c[2], w));
}

/** A ragdoll standing on z = 0, in its own frame: rods from joint to joint (width), a head. */
const RAGDOLL = {
  rods: [
    { from: [0, 0, 0.5], to: [0, 0, 0.93], width: 0.24 }, // torso
    { from: [0, 0.19, 0.9], to: [0, 0.19, 0.66], width: 0.09 }, // upper arms
    { from: [0, -0.19, 0.9], to: [0, -0.19, 0.66], width: 0.09 },
    { from: [0, 0.19, 0.66], to: [0, 0.19, 0.42], width: 0.085 }, // forearms
    { from: [0, -0.19, 0.66], to: [0, -0.19, 0.42], width: 0.085 },
    { from: [0, 0.08, 0.5], to: [0, 0.08, 0.27], width: 0.11 }, // thighs
    { from: [0, -0.08, 0.5], to: [0, -0.08, 0.27], width: 0.11 },
    { from: [0, 0.08, 0.27], to: [0, 0.08, 0.03], width: 0.1 }, // shins
    { from: [0, -0.08, 0.27], to: [0, -0.08, 0.03], width: 0.1 },
  ],
  head: { centre: [0, 0, 1.1], radius: 0.12 },
  /** Ball joints: [part, part, point], parts indexing rods then the head (9). */
  joints: [
    [0, 9, [0, 0, 1.0]],
    [0, 1, [0, 0.19, 0.9]],
    [0, 2, [0, -0.19, 0.9]],
    [1, 3, [0, 0.19, 0.66]],
    [2, 4, [0, -0.19, 0.66]],
    [0, 5, [0, 0.08, 0.5]],
    [0, 6, [0, -0.08, 0.5]],
    [5, 7, [0, 0.08, 0.27]],
    [6, 8, [0, -0.08, 0.27]],
  ] as [number, number, number[]][],
  /** Its middle (the frame is turned about this). */
  centre: [0, 0, 0.6],
};

/** A floppy ragdoll (ball joints) at `origin`, turned by `q`, in one colour. */
function ragdoll(solver: Solver, origin: ArrayLike<number>, q: Float64Array, paint: number): void {
  const parts: { body: Rigid; centre: Float64Array; rot: Float64Array }[] = [];
  const place = (centre: ArrayLike<number>) => {
    const c = sub3(vec3(), centre, RAGDOLL.centre);
    const p = rotate(vec3(), q, c);
    return [origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]];
  };
  for (const rod of RAGDOLL.rods) {
    const d = sub3(vec3(), rod.to, rod.from);
    const len = length(d);
    const centre = vec3((rod.from[0] + rod.to[0]) / 2, (rod.from[1] + rod.to[1]) / 2, (rod.from[2] + rod.to[2]) / 2);
    const rot = alignX([d[0] / len, d[1] / len, d[2] / len]);
    const body = new Rigid(solver, [len + rod.width, rod.width, rod.width], 1, 0.6, place(centre));
    body.positionAng.set(qmul(quat(), q, rot));
    parts.push({ body: setVisual(body, { shape: 'capsule', color: paint }), centre, rot });
  }
  const head = sphere(solver, RAGDOLL.head.radius, 1, 0.6, place(RAGDOLL.head.centre));
  head.positionAng.set(q);
  parts.push({ body: setVisual(head, { color: paint }), centre: vec3(RAGDOLL.head.centre[0], RAGDOLL.head.centre[1], RAGDOLL.head.centre[2]), rot: quat() });
  // Anchors in each part's own frame, the same in the ragdoll's frame as in the world's
  const local = (k: number, point: ArrayLike<number>) => rotateInv(vec3(), parts[k].rot, sub3(vec3(), point, parts[k].centre));
  for (const [a, b, point] of RAGDOLL.joints) new Joint(solver, parts[a].body, parts[b].body, local(a, point), local(b, point));
}

/**
 * After paper Fig. 14: a block of ragdolls (`side` × `side` × `layers`, ten bodies and nine
 * ball joints each, coloured in a rainbow across the block) dropped onto a cloth: a
 * `cloth` × `cloth` grid of thin plates ball-jointed at their edges, pinned at its four
 * corners and drawn as one printed sheet. Defaults: 1,440 ragdolls, a 96 × 96 cloth, 23,616
 * bodies and 31,200 joints.
 */
export function ragdollCloth(solver: Solver, side = 12, layers = 10, cloth = 96): void {
  solver.clear();
  const s = 0.3;
  ground(solver, cloth * s * 0.5);
  const zCloth = 8;
  const plates: Rigid[][] = [];
  for (let x = 0; x < cloth; x++) {
    plates.push([]);
    for (let y = 0; y < cloth; y++) {
      const corner = (x === 0 || x === cloth - 1) && (y === 0 || y === cloth - 1);
      plates[x].push(new Rigid(solver, [s * 0.9, s * 0.9, 0.1], corner ? 0 : 1, 0.6, [(x - (cloth - 1) / 2) * s, (y - (cloth - 1) / 2) * s, zCloth]));
    }
  }
  for (let x = 0; x < cloth; x++) {
    for (let y = 0; y < cloth; y++) {
      if (x > 0) new Joint(solver, plates[x - 1][y], plates[x][y], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (y > 0) new Joint(solver, plates[x][y - 1], plates[x][y], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  addCloth(solver, plates);

  const rand = random(1414);
  const pitch = 1.4;
  for (let layer = 0; layer < layers; layer++) {
    for (let gx = 0; gx < side; gx++) {
      for (let gy = 0; gy < side; gy++) {
        // A random orientation (uniform over rotations)
        const [u1, u2, u3] = [rand(), rand(), rand()];
        const q = quat(Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3));
        const origin = [(gx - (side - 1) / 2) * pitch, (gy - (side - 1) / 2) * pitch, zCloth + 1.5 + layer * pitch];
        ragdoll(solver, origin, q, hsl((0.82 * gx) / Math.max(side - 1, 1), 0.72, 0.6));
      }
    }
  }
}

/**
 * A flag on a pole in the wind: a `cols` × `rows` cloth of thin plates (as ragdollCloth's)
 * standing in the xz plane, every plate a sail (../shapes.ts) for the GPU solver's wind along
 * +x, tied near the top of the pole at its two inner corners by short ropes. Defaults: a
 * 9.6 × 6.4 m flag of 1,536 plates on a 24 m silver pole (about 2.5 flag lengths, as large
 * flagpoles go) with a gold ball on top, standing on a plinth.
 */
export function flag(solver: Solver, cols = 48, rows = 32, s = 0.2): void {
  solver.clear();
  ground(solver, 20);
  const height = 24;
  const radius = 0.16;
  const plinth = 0.6;
  const base = 0.5 + plinth;
  // A plinth, the pole (a static rod, its x axis turned upright, drawn as a capsule) and a
  // gold ball on top
  setVisual(new Rigid(solver, [1.4, 1.4, plinth], 0, 0.5, [0, 0, 0.5 + plinth / 2]), { color: 0xd3cec6 });
  const upright = quat(0, -Math.SQRT1_2, 0, Math.SQRT1_2);
  const pole = new Rigid(solver, [height, 2 * radius, 2 * radius], 0, 0.5, [0, 0, base + height / 2]);
  pole.positionAng.set(upright);
  setVisual(pole, { shape: 'capsule', color: 0xeef0f2, metal: true });
  setVisual(sphere(solver, 0.4, 0, 0.5, [0, 0, base + height + 0.3]), { color: 0xf5c863, metal: true });

  // The flag, in the xz plane: plates turned so their z (the sail's face) is along y
  const face = quat(Math.SQRT1_2, 0, 0, Math.SQRT1_2);
  const rope = 0.6;
  // The top edge just under the ball
  const [x0, zBottom] = [radius + rope + s / 2, base + height - 0.5 - (rows - 1) * s];
  const plates: Rigid[][] = [];
  for (let i = 0; i < cols; i++) {
    plates.push([]);
    for (let j = 0; j < rows; j++) {
      // Rows from the bottom up, so the print reads upright from the -y side
      const plate = new Rigid(solver, [s * 0.9, s * 0.9, 0.06], 2, 0.5, [x0 + i * s, 0, zBottom + j * s]);
      plate.positionAng.set(face);
      plates[i].push(sail(plate));
    }
  }
  // Plate-local y is world z
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      if (i > 0) new Joint(solver, plates[i - 1][j], plates[i][j], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (j > 0) new Joint(solver, plates[i][j - 1], plates[i][j], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  addCloth(solver, plates);

  // Two short ropes from the pole to the flag's inner corners
  const links = 3;
  const len = rope / links;
  for (const corner of [plates[0][0], plates[0][rows - 1]]) {
    const z = corner.positionLin[2];
    let prev = pole;
    let anchor = rotateInv(vec3(), upright, [radius, 0, z - pole.positionLin[2]]);
    const tie: Rigid[] = [];
    for (let k = 0; k < links; k++) {
      const link = new Rigid(solver, [len, 0.06, 0.06], 1, 0.5, [radius + len * (k + 0.5), 0, z]);
      tie.push(link);
      new Joint(solver, prev, link, anchor, [-len / 2, 0, 0]);
      prev = link;
      anchor = vec3(len / 2, 0, 0);
    }
    new Joint(solver, prev, corner, anchor, [-s / 2, 0, 0]);
    addRope(solver, tie, 0xeee6d2);
  }
}

/**
 * Paper Fig. 1/3: a wall of bricks (w wide, h high, two deep) smashed by a heavy ball.
 * Bricks rest exactly on each other; the ball is launched along +y.
 */
export function wallSmash(solver: Solver, w = 40, h = 25): void {
  solver.clear();
  ground(solver, 4 * w);
  for (let z = 0; z < h; z++) {
    // Running bond: every other course is offset by half a brick
    const offset = z % 2 === 0 ? 0 : 0.5;
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < 2; y++) new Rigid(solver, [1, 0.5, 0.5], 1, 0.6, [(x - w / 2) * 1.0 + offset, y * 0.5, 0.75 + z * 0.5]);
    }
  }
  sphere(solver, 2, 20, 0.5, [0, -25, 5], [0, 30, 4]);
}

/**
 * Paper Fig. 13: a breakable wall. Bricks are welded to their neighbours with hard joints
 * (position and angle) that fracture when the angular force exceeds `strength`, and a ball
 * is thrown through it.
 */
export function breakableWall(solver: Solver, w = 30, h = 20, strength = 50): void {
  solver.clear();
  ground(solver, 4 * w);
  const bricks: Rigid[][] = [];
  for (let z = 0; z < h; z++) {
    bricks.push([]);
    for (let x = 0; x < w; x++) bricks[z].push(new Rigid(solver, [1, 0.5, 0.5], 1, 0.6, [x - w / 2 + 0.5, 0, 0.75 + z * 0.5]));
  }
  for (let z = 0; z < h; z++) {
    for (let x = 0; x < w; x++) {
      if (x > 0) new Joint(solver, bricks[z][x - 1], bricks[z][x], [0.5, 0, 0], [-0.5, 0, 0], Infinity, Infinity, strength);
      if (z > 0) new Joint(solver, bricks[z - 1][x], bricks[z][x], [0, 0, 0.25], [0, 0, -0.25], Infinity, Infinity, strength);
    }
  }
  sphere(solver, 1.5, 20, 0.5, [0, -20, 4], [0, 25, 3]);
}

/**
 * Paper Fig. 12: chain mail. An n × n net of thin links, each joined to its neighbours by a
 * ball joint at the shared edge, hung from its four corners, catches a heavy ball.
 */
export function chainMail(solver: Solver, n = 40, ballDensity = 10): void {
  solver.clear();
  ground(solver, n * 0.5);
  const s = 0.5;
  const links: Rigid[][] = [];
  const z = 12;
  for (let x = 0; x < n; x++) {
    links.push([]);
    for (let y = 0; y < n; y++) {
      const corner = (x === 0 || x === n - 1) && (y === 0 || y === n - 1);
      const link = new Rigid(solver, [s * 0.9, s * 0.9, 0.1], corner ? 0 : 1, 0.5, [(x - (n - 1) / 2) * s, (y - (n - 1) / 2) * s, z]);
      // Drawn as Japanese 4-in-1: flat rings on even nodes, joined along x and y by rings
      // standing between them (through both), and no ring where both indices are odd
      const [ox, oy] = [x % 2 === 1, y % 2 === 1];
      links[x].push(setVisual(link, { shape: ox ? (oy ? 'hidden' : 'ringX') : oy ? 'ringY' : 'ringFlat' }));
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (x > 0) new Joint(solver, links[x - 1][y], links[x][y], [s / 2, 0, 0], [-s / 2, 0, 0]);
      if (y > 0) new Joint(solver, links[x][y - 1], links[x][y], [0, s / 2, 0], [0, -s / 2, 0]);
    }
  }
  setVisual(sphere(solver, 2, ballDensity, 0.5, [0, 0, z + 6]), { color: 0xa9c77e });
}

/**
 * Paper Fig. 7: a pendulum of `links` light links carrying a block `ratio` times heavier
 * than one link, released horizontally from a fixed anchor.
 */
export function heavyPendulum(solver: Solver, links = 50, ratio = 50000): void {
  solver.clear();
  ground(solver, links * 0.5);
  const len = 0.5;
  const top = links * len + 5;
  const anchor = new Rigid(solver, [0.5, 0.5, 0.5], 0, 0.5, [0, 0, top]);
  let prev = anchor;
  let prevOffset = 0.25;
  const chain: Rigid[] = [];
  for (let i = 0; i < links; i++) {
    const link = new Rigid(solver, [len, 0.1, 0.1], 1, 0.5, [0.25 + len * (i + 0.5), 0, top]);
    chain.push(link);
    new Joint(solver, prev, link, [prevOffset, 0, 0], [-len / 2, 0, 0]);
    prev = link;
    prevOffset = len / 2;
  }
  addRope(solver, chain, 0xdcc393);
  // Block of mass ratio × link mass (link mass = len · 0.1 · 0.1)
  const block = 1.5;
  const density = (ratio * len * 0.01) / block ** 3;
  const weight = new Rigid(solver, [block, block, block], density, 0.5, [0.25 + len * links + block / 2, 0, top]);
  new Joint(solver, prev, weight, [len / 2, 0, 0], [-block / 2, 0, 0]);
  addLabel(solver, [weight], `${ratio.toLocaleString('en')}× a link`);
}

/** Orbit camera framing for a scene (z up; azimuth in degrees, 90 = looking along -y). */
export interface CameraView {
  distance: number;
  target: [number, number, number];
  azimuth?: number;
  elevation?: number;
  /** A width and height (m, square to the view) to keep in frame: on a narrow screen the
   * camera backs off past `distance` until the width fits. */
  fit?: [number, number];
}

/** A scene's adjustable settings (the viewer's scene panel), by name. */
export type SceneOptions = Record<string, number>;

export interface Scene3D {
  name: string;
  /** Build into `solver`, with `options` over the scene's defaults. */
  build: (solver: Solver, options?: SceneOptions) => void;
  /** Defaults of the settings `build` takes. */
  options?: SceneOptions;
  /** Uses GPU-only features (spheres) or is too large for the CPU reference. */
  gpuOnly?: boolean;
  /** Where the camera starts (given the scene's options, for scenes whose size varies). */
  camera?: CameraView | ((options: SceneOptions) => CameraView);
  /** Solver settings the scene is shown with (the paper's iteration counts, wind). */
  params?: Partial<GpuParams3D> | ((options: SceneOptions) => Partial<GpuParams3D>);
  /** Show the wind panel (scenes with sails). */
  windControl?: boolean;
  /** Bodies the scene adds as it runs (see Emitter3D). */
  emitter?: (options: SceneOptions) => Emitter3D;
  /**
   * Contact storage and colours sized up front. Set, the scene runs deterministically: the same
   * bits every run on a device, since nothing overflows and nothing is resized mid-run.
   */
  capacity?: (options: SceneOptions) => GpuSolverOptions['capacity'];
  /** The picture the scene's emitted bodies come to rest in (see painting.ts). */
  picture?: Picture3D;
}

/**
 * Bodies a scene adds as it runs: `spawn(step, solver)` builds into `solver` those to add before
 * step `step`, a function of the step number alone so every run adds the same; `bodies` at most.
 */
export interface Emitter3D {
  bodies: number;
  spawn(step: number, solver: Solver): void;
}

/**
 * A picture a deterministic scene forms: run it `steps` steps off screen, find each emitted
 * body's place in the image (`coords`: u, v per body from its final x and z), colour it from
 * `url` there, and run it again for real.
 */
export interface Picture3D {
  url: string;
  steps(options: SceneOptions): number;
  coords(options: SceneOptions, x: ArrayLike<number>, z: ArrayLike<number>): Float32Array;
}

/** The viewer's GPU showcase scenes, after the paper's figures, plus scale tests. */
export const gpuScenes3D: Scene3D[] = [
  {
    // Paper Fig. 1 at a quarter of the bricks (same proportions): smooth on modest GPUs
    name: 'Brick Ring (28k)',
    build: (s) => brickRing(s, 40, 20, 2, 10),
    gpuOnly: true,
    params: { iterations: 4 },
    camera: { distance: 110, target: [0, -8, 0], azimuth: -100, elevation: 0.3 },
  },
  {
    name: 'Brick Ring (110k)',
    build: (s) => brickRing(s),
    gpuOnly: true,
    params: { iterations: 4 },
    camera: { distance: 215, target: [0, -15, 0], azimuth: -100, elevation: 0.3 },
  },
  {
    // Paper Fig. 3 at a twentieth of the bricks
    name: 'Brick Walls (27k)',
    build: (s) => brickGables(s, 8, 16, 20, [2, 5]),
    gpuOnly: true,
    params: { iterations: 3 },
    camera: { distance: 86, target: [15, 0, 2], azimuth: -69, elevation: 0.12 },
  },
  {
    // Paper Fig. 14 (35k bodies, 72k joints on a 10k-vertex cloth) at two-thirds the bodies
    name: 'Ragdolls on Cloth (24k)',
    build: (s) => ragdollCloth(s),
    gpuOnly: true,
    params: { iterations: 10 },
    camera: { distance: 52, target: [0, 0, 6], azimuth: -115, elevation: 0.3 },
  },
  {
    name: 'Flag in the Wind (1.5k)',
    build: (s) => flag(s),
    gpuOnly: true,
    params: { iterations: 10, windSpeed: 12 },
    windControl: true,
    camera: { distance: 42, target: [4, 0, 13], azimuth: -65, elevation: 0.08 },
  },
  { name: 'Wall Smash (2k)', build: (s) => wallSmash(s), gpuOnly: true, camera: { distance: 55, target: [0, 0, 5], azimuth: -120, elevation: 0.3 } },
  {
    name: 'Breakable Wall (600)',
    build: (s, o) => breakableWall(s, 30, 20, o?.strength),
    options: { strength: 50 },
    gpuOnly: true,
    camera: { distance: 45, target: [0, 0, 5], azimuth: -120, elevation: 0.3 },
  },
  {
    name: 'Chain Mail (1.6k)',
    build: (s, o) => chainMail(s, 40, o?.ballDensity),
    options: { ballDensity: 10 },
    gpuOnly: true,
    camera: { distance: 35, target: [0, 0, 9], azimuth: -120, elevation: 0.45 },
  },
  {
    name: 'Heavy Pendulum',
    build: (s, o) => heavyPendulum(s, 50, o?.ratio),
    options: { ratio: 50000 },
    gpuOnly: true,
    camera: { distance: 70, target: [0, 0, 16], azimuth: 90, elevation: 0.15 },
  },
  { name: 'Box Pile (4k)', build: (s) => boxPile(s, 20, 10), gpuOnly: true, camera: { distance: 55, target: [0, 0, 4], elevation: 0.45 } },
  { name: 'Box Pile (32k)', build: (s) => boxPile(s, 40, 20), gpuOnly: true, camera: { distance: 110, target: [0, 0, 6], elevation: 0.45 } },
  { name: 'Jointed Drop (34k)', build: (s) => jointedDrop(s), gpuOnly: true, camera: { distance: 55, target: [0, 0, 4], azimuth: -120, elevation: 0.5 } },
  { name: 'Box Columns (100k)', build: (s) => boxColumns(s, 100, 10), gpuOnly: true, camera: { distance: 190, target: [0, 0, 5], elevation: 0.5 } },
];
