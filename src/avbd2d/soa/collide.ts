// Box-box contact generation in flat scalar form (no allocations, no objects), so it maps
// line for line onto WGSL. Same algorithm and feature numbering as ../ref/collide.ts
// (box2d-lite, MIT, Copyright (c) 2019 Erin Catto).

/** Floats per contact written by `collideBoxes`. */
export const CONTACT_OUT_STRIDE = 7;
/** Offsets within one contact: feature key, anchors in body-local space, normal (B to A). */
export const OUT_FEATURE = 0;
export const OUT_RA = 1;
export const OUT_RB = 3;
export const OUT_N = 5;

// Clip scratch: two vertices, each (x, y, inEdge1, outEdge1, inEdge2, outEdge2)
const VS = 6;
const incident = new Float64Array(2 * VS);
const clip1 = new Float64Array(2 * VS);
const clip2 = new Float64Array(2 * VS);

function setVertex(buf: Float64Array, i: number, x: number, y: number, in1: number, out1: number, in2: number, out2: number): void {
  const o = i * VS;
  buf[o] = x;
  buf[o + 1] = y;
  buf[o + 2] = in1;
  buf[o + 3] = out1;
  buf[o + 4] = in2;
  buf[o + 5] = out2;
}

/** Clip segment `src` against the half-plane n·v <= offset; returns the vertex count in `dst`. */
function clipSegment(dst: Float64Array, src: Float64Array, nx: number, ny: number, offset: number, clipEdge: number): number {
  let count = 0;
  const d0 = nx * src[0] + ny * src[1] - offset;
  const d1 = nx * src[VS] + ny * src[VS + 1] - offset;

  if (d0 <= 0) {
    for (let k = 0; k < VS; k++) dst[count * VS + k] = src[k];
    count++;
  }
  if (d1 <= 0) {
    for (let k = 0; k < VS; k++) dst[count * VS + k] = src[VS + k];
    count++;
  }
  if (d0 * d1 < 0) {
    const t = d0 / (d0 - d1);
    const x = src[0] + (src[VS] - src[0]) * t;
    const y = src[1] + (src[VS + 1] - src[1]) * t;
    if (d0 > 0) setVertex(dst, count, x, y, clipEdge, src[3], 0, src[5]);
    else setVertex(dst, count, x, y, src[VS + 2], clipEdge, src[VS + 4], 0);
    count++;
  }
  return count;
}

/** Incident edge of box (h, pos, rotation c/s) against reference face normal (fnx, fny). */
function incidentEdge(hx: number, hy: number, px: number, py: number, c: number, s: number, fnx: number, fny: number): void {
  // Normal in the incident box's frame, flipped
  const nx = -(c * fnx + s * fny);
  const ny = -(-s * fnx + c * fny);
  if (Math.abs(nx) > Math.abs(ny)) {
    if (nx > 0) {
      setVertex(incident, 0, hx, -hy, 0, 0, 3, 4);
      setVertex(incident, 1, hx, hy, 0, 0, 4, 1);
    } else {
      setVertex(incident, 0, -hx, hy, 0, 0, 1, 2);
      setVertex(incident, 1, -hx, -hy, 0, 0, 2, 3);
    }
  } else if (ny > 0) {
    setVertex(incident, 0, hx, hy, 0, 0, 4, 1);
    setVertex(incident, 1, -hx, hy, 0, 0, 1, 2);
  } else {
    setVertex(incident, 0, -hx, -hy, 0, 0, 2, 3);
    setVertex(incident, 1, hx, -hy, 0, 0, 3, 4);
  }
  for (let i = 0; i < 2; i++) {
    const o = i * VS;
    const vx = incident[o];
    const vy = incident[o + 1];
    incident[o] = px + c * vx - s * vy;
    incident[o + 1] = py + s * vx + c * vy;
  }
}

/**
 * Contacts between box A (pose ax, ay, aa; half extents ahx, ahy) and box B. Writes up to two
 * contacts of CONTACT_OUT_STRIDE floats into `out` and returns the count.
 */
export function collideBoxes(
  ax: number, ay: number, aa: number, ahx: number, ahy: number,
  bx: number, by: number, ba: number, bhx: number, bhy: number,
  out: Float64Array,
): number {
  const cA = Math.cos(aa);
  const sA = Math.sin(aa);
  const cB = Math.cos(ba);
  const sB = Math.sin(ba);

  const dpx = bx - ax;
  const dpy = by - ay;
  const dAx = cA * dpx + sA * dpy;
  const dAy = -sA * dpx + cA * dpy;
  const dBx = cB * dpx + sB * dpy;
  const dBy = -sB * dpx + cB * dpy;

  // |RotAᵀ RotB|
  const a00 = Math.abs(cA * cB + sA * sB);
  const a01 = Math.abs(cA * -sB + sA * cB);
  const a10 = Math.abs(-sA * cB + cA * sB);
  const a11 = Math.abs(-sA * -sB + cA * cB);

  const faceAx = Math.abs(dAx) - ahx - (a00 * bhx + a01 * bhy);
  const faceAy = Math.abs(dAy) - ahy - (a10 * bhx + a11 * bhy);
  if (faceAx > 0 || faceAy > 0) return 0;

  const faceBx = Math.abs(dBx) - (a00 * ahx + a10 * ahy) - bhx;
  const faceBy = Math.abs(dBy) - (a01 * ahx + a11 * ahy) - bhy;
  if (faceBx > 0 || faceBy > 0) return 0;

  // Best separating axis, with a bias towards A's faces for coherence
  let axis = 0;
  let separation = faceAx;
  let nx = dAx > 0 ? cA : -cA;
  let ny = dAx > 0 ? sA : -sA;
  if (faceAy > 0.95 * separation + 0.01 * ahy) {
    axis = 1;
    separation = faceAy;
    nx = dAy > 0 ? -sA : sA;
    ny = dAy > 0 ? cA : -cA;
  }
  if (faceBx > 0.95 * separation + 0.01 * bhx) {
    axis = 2;
    separation = faceBx;
    nx = dBx > 0 ? cB : -cB;
    ny = dBx > 0 ? sB : -sB;
  }
  if (faceBy > 0.95 * separation + 0.01 * bhy) {
    axis = 3;
    separation = faceBy;
    nx = dBy > 0 ? -sB : sB;
    ny = dBy > 0 ? cB : -cB;
  }

  // Reference face, side planes, and the incident edge on the other box
  let fnx: number, fny: number, front: number, snx: number, sny: number;
  let negSide: number, posSide: number, negEdge: number, posEdge: number;
  if (axis === 0) {
    fnx = nx; fny = ny;
    front = ax * fnx + ay * fny + ahx;
    snx = -sA; sny = cA;
    const side = ax * snx + ay * sny;
    negSide = -side + ahy; posSide = side + ahy;
    negEdge = 3; posEdge = 1;
    incidentEdge(bhx, bhy, bx, by, cB, sB, fnx, fny);
  } else if (axis === 1) {
    fnx = nx; fny = ny;
    front = ax * fnx + ay * fny + ahy;
    snx = cA; sny = sA;
    const side = ax * snx + ay * sny;
    negSide = -side + ahx; posSide = side + ahx;
    negEdge = 2; posEdge = 4;
    incidentEdge(bhx, bhy, bx, by, cB, sB, fnx, fny);
  } else if (axis === 2) {
    fnx = -nx; fny = -ny;
    front = bx * fnx + by * fny + bhx;
    snx = -sB; sny = cB;
    const side = bx * snx + by * sny;
    negSide = -side + bhy; posSide = side + bhy;
    negEdge = 3; posEdge = 1;
    incidentEdge(ahx, ahy, ax, ay, cA, sA, fnx, fny);
  } else {
    fnx = -nx; fny = -ny;
    front = bx * fnx + by * fny + bhy;
    snx = cB; sny = sB;
    const side = bx * snx + by * sny;
    negSide = -side + bhx; posSide = side + bhx;
    negEdge = 2; posEdge = 4;
    incidentEdge(ahx, ahy, ax, ay, cA, sA, fnx, fny);
  }

  if (clipSegment(clip1, incident, -snx, -sny, negSide, negEdge) < 2) return 0;
  if (clipSegment(clip2, clip1, snx, sny, posSide, posEdge) < 2) return 0;

  let count = 0;
  for (let i = 0; i < 2; i++) {
    const o = i * VS;
    const vx = clip2[o];
    const vy = clip2[o + 1];
    const sep = fnx * vx + fny * vy - front;
    if (sep > 0) continue;

    // Slide the point onto the reference face; flip features when B is the reference
    const px = vx - fnx * sep;
    const py = vy - fny * sep;
    let in1 = clip2[o + 2], out1 = clip2[o + 3], in2 = clip2[o + 4], out2 = clip2[o + 5];
    let wax: number, way: number, wbx: number, wby: number;
    if (axis >= 2) {
      [in1, out1, in2, out2] = [in2, out2, in1, out1];
      wax = vx - ax; way = vy - ay;
      wbx = px - bx; wby = py - by;
    } else {
      wax = px - ax; way = py - ay;
      wbx = vx - bx; wby = vy - by;
    }

    const w = count * CONTACT_OUT_STRIDE;
    out[w + OUT_FEATURE] = (in1 & 0xff) | ((out1 & 0xff) << 8) | ((in2 & 0xff) << 16) | ((out2 & 0xff) << 24);
    out[w + OUT_RA] = cA * wax + sA * way;
    out[w + OUT_RA + 1] = -sA * wax + cA * way;
    out[w + OUT_RB] = cB * wbx + sB * wby;
    out[w + OUT_RB + 1] = -sB * wbx + cB * wby;
    out[w + OUT_N] = -nx;
    out[w + OUT_N + 1] = -ny;
    count++;
  }
  return count;
}
