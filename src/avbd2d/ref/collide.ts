// Box-box contact generation, ported from avbd-demo2d collide.cpp, which is itself adapted
// from box2d-lite (MIT, Copyright (c) 2019 Erin Catto).
//
// Box vertex and edge numbering:
//
//        ^ y
//        |
//        e1
//   v2 ------ v1
//    |        |
// e2 |        | e4  --> x
//    |        |
//   v3 ------ v4
//        e3

import type { Rigid } from './body.ts';

/** Contact features, used to match contacts between frames. */
export interface FeaturePair {
  inEdge1: number;
  outEdge1: number;
  inEdge2: number;
  outEdge2: number;
}

/** Pack a feature pair the way the C++ union reads it as an int (little-endian chars). */
export const featureKey = (f: FeaturePair): number =>
  (f.inEdge1 & 0xff) | ((f.outEdge1 & 0xff) << 8) | ((f.inEdge2 & 0xff) << 16) | ((f.outEdge2 & 0xff) << 24);

export interface RawContact {
  feature: number;
  rA: [number, number];
  rB: [number, number];
  /** Contact normal, pointing from B to A. */
  normal: [number, number];
}

const FACE_A_X = 0;
const FACE_A_Y = 1;
const FACE_B_X = 2;
const FACE_B_Y = 3;

const NO_EDGE = 0;
const EDGE1 = 1;
const EDGE2 = 2;
const EDGE3 = 3;
const EDGE4 = 4;

type V2 = [number, number];
/** Row-major 2x2 matrix [[m0, m1], [m2, m3]]. */
type M2 = [number, number, number, number];

interface ClipVertex {
  v: V2;
  fp: FeaturePair;
}

const newFp = (): FeaturePair => ({ inEdge1: 0, outEdge1: 0, inEdge2: 0, outEdge2: 0 });
const cloneCv = (c: ClipVertex): ClipVertex => ({ v: [c.v[0], c.v[1]], fp: { ...c.fp } });
const newCv = (): ClipVertex => ({ v: [0, 0], fp: newFp() });

const dot = (a: V2, b: V2): number => a[0] * b[0] + a[1] * b[1];
const rotation = (angle: number): M2 => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, s, c];
};
const mulMV = (m: M2, v: V2): V2 => [m[0] * v[0] + m[1] * v[1], m[2] * v[0] + m[3] * v[1]];
const mulMM = (a: M2, b: M2): M2 => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
];
const transpose = (m: M2): M2 => [m[0], m[2], m[1], m[3]];
const absM = (m: M2): M2 => [Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3])];
const col = (m: M2, i: number): V2 => [m[i], m[2 + i]];
const neg = (v: V2): V2 => [-v[0], -v[1]];
const sign = (x: number): number => (x < 0 ? -1 : x > 0 ? 1 : 0);

function flip(fp: FeaturePair): void {
  let t = fp.inEdge1;
  fp.inEdge1 = fp.inEdge2;
  fp.inEdge2 = t;
  t = fp.outEdge1;
  fp.outEdge1 = fp.outEdge2;
  fp.outEdge2 = t;
}

function clipSegmentToLine(vOut: ClipVertex[], vIn: ClipVertex[], normal: V2, offset: number, clipEdge: number): number {
  let numOut = 0;

  // Distance of end points to the line
  const distance0 = dot(normal, vIn[0].v) - offset;
  const distance1 = dot(normal, vIn[1].v) - offset;

  // Points behind the plane
  if (distance0 <= 0) vOut[numOut++] = cloneCv(vIn[0]);
  if (distance1 <= 0) vOut[numOut++] = cloneCv(vIn[1]);

  // Points on different sides of the plane
  if (distance0 * distance1 < 0) {
    const interp = distance0 / (distance0 - distance1);
    const out = newCv();
    out.v = [vIn[0].v[0] + (vIn[1].v[0] - vIn[0].v[0]) * interp, vIn[0].v[1] + (vIn[1].v[1] - vIn[0].v[1]) * interp];
    if (distance0 > 0) {
      out.fp = { ...vIn[0].fp };
      out.fp.inEdge1 = clipEdge;
      out.fp.inEdge2 = NO_EDGE;
    } else {
      out.fp = { ...vIn[1].fp };
      out.fp.outEdge1 = clipEdge;
      out.fp.outEdge2 = NO_EDGE;
    }
    vOut[numOut++] = out;
  }

  return numOut;
}

function computeIncidentEdge(c: ClipVertex[], h: V2, pos: V2, Rot: M2, normal: V2): void {
  // The normal is from the reference box. Convert it to the incident box's frame and flip sign.
  const n = neg(mulMV(transpose(Rot), normal));
  const nAbs: V2 = [Math.abs(n[0]), Math.abs(n[1])];

  if (nAbs[0] > nAbs[1]) {
    if (sign(n[0]) > 0) {
      c[0].v = [h[0], -h[1]];
      c[0].fp.inEdge2 = EDGE3;
      c[0].fp.outEdge2 = EDGE4;
      c[1].v = [h[0], h[1]];
      c[1].fp.inEdge2 = EDGE4;
      c[1].fp.outEdge2 = EDGE1;
    } else {
      c[0].v = [-h[0], h[1]];
      c[0].fp.inEdge2 = EDGE1;
      c[0].fp.outEdge2 = EDGE2;
      c[1].v = [-h[0], -h[1]];
      c[1].fp.inEdge2 = EDGE2;
      c[1].fp.outEdge2 = EDGE3;
    }
  } else {
    if (sign(n[1]) > 0) {
      c[0].v = [h[0], h[1]];
      c[0].fp.inEdge2 = EDGE4;
      c[0].fp.outEdge2 = EDGE1;
      c[1].v = [-h[0], h[1]];
      c[1].fp.inEdge2 = EDGE1;
      c[1].fp.outEdge2 = EDGE2;
    } else {
      c[0].v = [-h[0], -h[1]];
      c[0].fp.inEdge2 = EDGE2;
      c[0].fp.outEdge2 = EDGE3;
      c[1].v = [h[0], -h[1]];
      c[1].fp.inEdge2 = EDGE3;
      c[1].fp.outEdge2 = EDGE4;
    }
  }

  for (const cv of c) {
    const w = mulMV(Rot, cv.v);
    cv.v = [pos[0] + w[0], pos[1] + w[1]];
  }
}

/** Compute up to two contacts between boxes A and B. The returned normal points from B to A. */
export function collide(bodyA: Rigid, bodyB: Rigid): RawContact[] {
  let normal: V2;

  const hA: V2 = [bodyA.size[0] * 0.5, bodyA.size[1] * 0.5];
  const hB: V2 = [bodyB.size[0] * 0.5, bodyB.size[1] * 0.5];
  const posA: V2 = [bodyA.position[0], bodyA.position[1]];
  const posB: V2 = [bodyB.position[0], bodyB.position[1]];
  const RotA = rotation(bodyA.position[2]);
  const RotB = rotation(bodyB.position[2]);
  const RotAT = transpose(RotA);
  const RotBT = transpose(RotB);

  const dp: V2 = [posB[0] - posA[0], posB[1] - posA[1]];
  const dA = mulMV(RotAT, dp);
  const dB = mulMV(RotBT, dp);

  const C = mulMM(RotAT, RotB);
  const absC = absM(C);
  const absCT = transpose(absC);

  // Box A faces
  const aC = mulMV(absC, hB);
  const faceA: V2 = [Math.abs(dA[0]) - hA[0] - aC[0], Math.abs(dA[1]) - hA[1] - aC[1]];
  if (faceA[0] > 0 || faceA[1] > 0) return [];

  // Box B faces
  const bC = mulMV(absCT, hA);
  const faceB: V2 = [Math.abs(dB[0]) - bC[0] - hB[0], Math.abs(dB[1]) - bC[1] - hB[1]];
  if (faceB[0] > 0 || faceB[1] > 0) return [];

  // Find best axis
  let axis = FACE_A_X;
  let separation = faceA[0];
  normal = dA[0] > 0 ? col(RotA, 0) : neg(col(RotA, 0));

  const relativeTol = 0.95;
  const absoluteTol = 0.01;

  if (faceA[1] > relativeTol * separation + absoluteTol * hA[1]) {
    axis = FACE_A_Y;
    separation = faceA[1];
    normal = dA[1] > 0 ? col(RotA, 1) : neg(col(RotA, 1));
  }

  if (faceB[0] > relativeTol * separation + absoluteTol * hB[0]) {
    axis = FACE_B_X;
    separation = faceB[0];
    normal = dB[0] > 0 ? col(RotB, 0) : neg(col(RotB, 0));
  }

  if (faceB[1] > relativeTol * separation + absoluteTol * hB[1]) {
    axis = FACE_B_Y;
    separation = faceB[1];
    normal = dB[1] > 0 ? col(RotB, 1) : neg(col(RotB, 1));
  }

  // Set up clipping plane data based on the separating axis
  let frontNormal: V2;
  let sideNormal: V2;
  let front: number;
  let negSide: number;
  let posSide: number;
  let negEdge: number;
  let posEdge: number;
  const incidentEdge: ClipVertex[] = [newCv(), newCv()];

  switch (axis) {
    case FACE_A_X: {
      frontNormal = normal;
      front = dot(posA, frontNormal) + hA[0];
      sideNormal = col(RotA, 1);
      const side = dot(posA, sideNormal);
      negSide = -side + hA[1];
      posSide = side + hA[1];
      negEdge = EDGE3;
      posEdge = EDGE1;
      computeIncidentEdge(incidentEdge, hB, posB, RotB, frontNormal);
      break;
    }
    case FACE_A_Y: {
      frontNormal = normal;
      front = dot(posA, frontNormal) + hA[1];
      sideNormal = col(RotA, 0);
      const side = dot(posA, sideNormal);
      negSide = -side + hA[0];
      posSide = side + hA[0];
      negEdge = EDGE2;
      posEdge = EDGE4;
      computeIncidentEdge(incidentEdge, hB, posB, RotB, frontNormal);
      break;
    }
    case FACE_B_X: {
      frontNormal = neg(normal);
      front = dot(posB, frontNormal) + hB[0];
      sideNormal = col(RotB, 1);
      const side = dot(posB, sideNormal);
      negSide = -side + hB[1];
      posSide = side + hB[1];
      negEdge = EDGE3;
      posEdge = EDGE1;
      computeIncidentEdge(incidentEdge, hA, posA, RotA, frontNormal);
      break;
    }
    default: {
      frontNormal = neg(normal);
      front = dot(posB, frontNormal) + hB[1];
      sideNormal = col(RotB, 0);
      const side = dot(posB, sideNormal);
      negSide = -side + hB[0];
      posSide = side + hB[0];
      negEdge = EDGE2;
      posEdge = EDGE4;
      computeIncidentEdge(incidentEdge, hA, posA, RotA, frontNormal);
      break;
    }
  }

  // Clip the incident edge against the reference face's side planes
  const clipPoints1: ClipVertex[] = [newCv(), newCv()];
  const clipPoints2: ClipVertex[] = [newCv(), newCv()];

  let np = clipSegmentToLine(clipPoints1, incidentEdge, neg(sideNormal), negSide, negEdge);
  if (np < 2) return [];

  np = clipSegmentToLine(clipPoints2, clipPoints1, sideNormal, posSide, posEdge);
  if (np < 2) return [];

  const contacts: RawContact[] = [];
  for (let i = 0; i < 2; i++) {
    const cp = clipPoints2[i];
    const sep = dot(frontNormal, cp.v) - front;
    if (sep > 0) continue;

    const fp = { ...cp.fp };
    // Slide the contact point onto the reference face (easy to cull)
    const onRef: V2 = [cp.v[0] - frontNormal[0] * sep, cp.v[1] - frontNormal[1] * sep];
    let rA: V2;
    let rB: V2;
    if (axis === FACE_B_X || axis === FACE_B_Y) {
      flip(fp);
      rA = mulMV(RotAT, [cp.v[0] - posA[0], cp.v[1] - posA[1]]);
      rB = mulMV(RotBT, [onRef[0] - posB[0], onRef[1] - posB[1]]);
    } else {
      rA = mulMV(RotAT, [onRef[0] - posA[0], onRef[1] - posA[1]]);
      rB = mulMV(RotBT, [cp.v[0] - posB[0], cp.v[1] - posB[1]]);
    }
    contacts.push({ feature: featureKey(fp), rA, rB, normal: neg(normal) });
  }
  return contacts;
}
