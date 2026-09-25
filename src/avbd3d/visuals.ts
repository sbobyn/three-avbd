// How the viewer draws a body, tagged by the scene that builds it. Purely cosmetic: the solvers
// never read these (a capsule or a chain-mail ring still collides as its box). Tags live in
// weak maps beside the reference bodies, as ./shapes.ts marks spheres, and the GPU adapter
// maps them to its own body order.

import type { Rigid } from './ref/body.ts';
import type { Solver } from './ref/solver.ts';

export interface Visual {
  /**
   * capsule: a rounded rod along the body's local x, as thick as its thinner cross-section;
   * ringFlat / ringX / ringY: a chain-mail ring lying in the body's xy plane, or standing in
   * its xz or yz plane (connecting the flat rings along x or y: Japanese 4-in-1);
   * hidden: not drawn (e.g. the plates under a cloth surface).
   */
  shape?: 'capsule' | 'ringFlat' | 'ringX' | 'ringY' | 'hidden';
  /** Paint (0xRRGGBB) instead of the palette. */
  color?: number;
  /** Polished metal (capsules and spheres): `color` is its reflectance. */
  metal?: boolean;
}

/**
 * Chain-mail ring proportions, as fractions of the body's width (size.x): the centreline
 * radius of flat rings and of standing (ringX / ringY) rings, and the wire's radius.
 */
export const RING = { flat: 0.84, link: 0.66, wire: 0.1 };

/**
 * An eye splice, in rope radii R, in the plane of the first link's local x (u, back up the
 * rope from its start) and z (w): a teardrop of thinner rope (radius `tube`) from inside the
 * seizing, round the top, and back in. The ring (centreline radius `ring`, standing across the
 * eye) passes through its top; the rope's first joint is `reach` up, at the ring wire's centre,
 * the eye's inside top resting on the wire.
 */
export const EYE = {
  path: [
    [-0.8, 0],
    [0.6, 0.35],
    [2.0, 1.25],
    [3.6, 1.45],
    [4.8, 0.9],
    [5.2, 0],
    [4.8, -0.9],
    [3.6, -1.45],
    [2.0, -1.25],
    [0.6, -0.35],
    [-0.8, 0],
  ] as [number, number][],
  tube: 0.8,
  ring: 1.44,
  /** 5.2 (the top) − 0.8 (the eye's tube) − the ring's wire (RING.wire · ring / RING.link). */
  reach: 5.2 - 0.8 - (0.1 * 1.44) / 0.66,
};

const visuals = new WeakMap<Rigid, Visual>();

export function setVisual(body: Rigid, visual: Visual): Rigid {
  visuals.set(body, { ...visuals.get(body), ...visual });
  return body;
}

export const visualOf = (body: Rigid): Visual | undefined => visuals.get(body);

/**
 * A cloth drawn as one smooth sheet through the centres of a grid of bodies (rows of equal
 * length), textured corner (0, 0) to corner (1, 1).
 */
const cloths = new WeakMap<Solver, Rigid[][][]>();

export function addCloth(solver: Solver, grid: Rigid[][]): void {
  // Drop sheets left from a previous build into this solver
  const live = (cloths.get(solver) ?? []).filter((g) => solver.bodies.includes(g[0][0]));
  cloths.set(solver, [...live, grid]);
  for (const row of grid) for (const b of row) setVisual(b, { shape: 'hidden' });
}

export const clothsOf = (solver: Solver): Rigid[][][] => (cloths.get(solver) ?? []).filter((g) => solver.bodies.includes(g[0][0]));

/**
 * A rope drawn as one continuous laid rope (three strands) along a smooth curve through the
 * joints of a chain of links, each link's local x along the chain.
 */
/**
 * How a rope's ends look: tied into a body (the rope is drawn on into it, hidden), free (the
 * strands close into a tip), or (the start only) an eye: an eye splice hanging on a ring, drawn
 * in the first link's frame so it swings with the rope, its legs bound into the rope by a
 * seizing of cord. The first link then hangs from the ring EYE.reach rope radii above its
 * start (the eye's inside top, resting on the ring's wire).
 */
export interface RopeStyle {
  start?: 'tied' | 'eye';
  end?: 'tied' | 'free';
  /** A closed loop (the eye through a ring): the last link's end meets the first's start. */
  closed?: boolean;
}

export interface Rope extends RopeStyle {
  links: Rigid[];
  color: number;
}

const ropes = new WeakMap<Solver, Rope[]>();

export function addRope(solver: Solver, links: Rigid[], color: number, style: RopeStyle = {}): void {
  const live = (ropes.get(solver) ?? []).filter((r) => solver.bodies.includes(r.links[0]));
  ropes.set(solver, [...live, { ...style, links, color }]);
  for (const b of links) setVisual(b, { shape: 'hidden' });
}

export const ropesOf = (solver: Solver): Rope[] => (ropes.get(solver) ?? []).filter((r) => solver.bodies.includes(r.links[0]));

/**
 * A caption floating over a body, or over the midpoint of two (a spring, say): what a number
 * in the scene is (a friction coefficient, a mass ratio).
 */
export interface Label {
  bodies: Rigid[];
  text: string;
}

const labels = new WeakMap<Solver, Label[]>();

export function addLabel(solver: Solver, bodies: Rigid[], text: string): void {
  const live = (labels.get(solver) ?? []).filter((l) => solver.bodies.includes(l.bodies[0]));
  labels.set(solver, [...live, { bodies, text }]);
}

export const labelsOf = (solver: Solver): Label[] => (labels.get(solver) ?? []).filter((l) => l.bodies.every((b) => solver.bodies.includes(b)));

/** An HSL colour (h, s, l in [0, 1]) as 0xRRGGBB. */
export function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}
