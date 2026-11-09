// Authored shared inputs and explicit Rapier approximation preparation; no engine/runtime imports.
export const INTERLOCKING = {
  dt: 1 / 120, iterations: 10, majorRadius: .9, minorRadius: .16, density: 1,
  friction: .5, gravity: [0, -9.81, 0], push: [1.5, 0, 0],
  floor: { position: [0, -.5, 0], halfExtents: [4, .5, 4] },
  peg: { position: [0, 3.5, 0], radius: .15, halfLength: 1.25 },
  positions: [[0, 3, 0], [0, 1.6, 0]],
} as const;
export type RingPieces = 16 | 32 | 64;
export function ringMassProperties() {
  const { majorRadius: R, minorRadius: r, density } = INTERLOCKING;
  const mass = 2 * Math.PI ** 2 * R * r ** 2 * density;
  return { mass, inertia: { x: mass * (.5 * R ** 2 + .625 * r ** 2),
    y: mass * (.5 * R ** 2 + .625 * r ** 2), z: mass * (R ** 2 + .75 * r ** 2) } };
}

/** Each convex sector approximates a torus tube; the central opening is never filled. */
export function torusSectors(pieces: RingPieces): Float32Array[] {
  if (![16, 32, 64].includes(pieces)) throw new Error('Ring pieces must be 16, 32 or 64');
  const { majorRadius: R, minorRadius: r } = INTERLOCKING;
  return Array.from({ length: pieces }, (_, sector) => {
    const points: number[] = [];
    for (let k = 0; k < 3; k++) {
      const a = (sector + k / 2) * Math.PI * 2 / pieces;
      for (let j = 0; j < 8; j++) {
        const b = j * Math.PI / 4, radius = R + r * Math.cos(b);
        points.push(radius * Math.cos(a), radius * Math.sin(a), r * Math.sin(b));
      }
    }
    return new Float32Array(points);
  });
}

