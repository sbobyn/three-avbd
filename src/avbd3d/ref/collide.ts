// Box-box narrowphase, ported from avbd-demo3d collide.cpp: SAT over the 3 + 3 face axes and
// 9 edge-edge axes; a face axis clips the incident face against the reference face's side
// planes (up to 8 contacts), an edge axis gives one closest-points contact. Feature keys
// identify each contact across frames for warm starting.

import type { Rigid } from './body.ts';
import {
  add3,
  addScaled3,
  clamp,
  cross,
  dot,
  lengthSq,
  neg3,
  orthonormal,
  rotate,
  rotateInv,
  scale3,
  sub3,
  vec3,
  type M3,
  type V3,
} from './math.ts';

const MAX_CONTACTS = 8;
const MAX_POLY_VERTS = 16;
const SAT_AXIS_EPSILON = 1.0e-6;
const PLANE_EPSILON = 1.0e-5;
const CONTACT_MERGE_DIST_SQ = 1.0e-6;
const FLT_MAX = 3.4028234663852886e38;

const AXIS_FACE_A = 0;
const AXIS_FACE_B = 1;
const AXIS_EDGE = 2;

export interface RawContact {
  feature: number;
  /** Contact point on each body, in that body's local frame (relative to its centre). */
  rA: V3;
  rB: V3;
}

interface OBB {
  center: V3;
  half: V3;
  axis: [V3, V3, V3];
}

interface SatAxis {
  type: number;
  indexA: number;
  indexB: number;
  separation: number;
  normalAB: V3;
  valid: boolean;
}

interface FaceFrame {
  normal: V3;
  center: V3;
  u: V3;
  v: V3;
  extentU: number;
  extentV: number;
}

function makeOBB(body: Rigid): OBB {
  const q = body.positionAng;
  return {
    center: body.positionLin,
    half: scale3(vec3(), body.size, 0.5),
    axis: [rotate(vec3(), q, [1, 0, 0]), rotate(vec3(), q, [0, 1, 0]), rotate(vec3(), q, [0, 0, 1])],
  };
}

const absDot = (a: V3, b: V3): number => Math.abs(dot(a, b));

function supportPoint(box: OBB, dir: V3): V3 {
  const sx = dot(dir, box.axis[0]) >= 0 ? 1 : -1;
  const sy = dot(dir, box.axis[1]) >= 0 ? 1 : -1;
  const sz = dot(dir, box.axis[2]) >= 0 ? 1 : -1;
  const p = addScaled3(vec3(), box.center, box.axis[0], box.half[0] * sx);
  addScaled3(p, p, box.axis[1], box.half[1] * sy);
  return addScaled3(p, p, box.axis[2], box.half[2] * sz);
}

function faceAxes(box: OBB, axisIndex: number): { u: V3; v: V3; extentU: number; extentV: number } {
  if (axisIndex === 0) return { u: box.axis[1], v: box.axis[2], extentU: box.half[1], extentV: box.half[2] };
  if (axisIndex === 1) return { u: box.axis[0], v: box.axis[2], extentU: box.half[0], extentV: box.half[2] };
  return { u: box.axis[0], v: box.axis[1], extentU: box.half[0], extentV: box.half[1] };
}

function buildFaceFrame(box: OBB, axisIndex: number, outwardNormal: V3): FaceFrame {
  const sign = dot(outwardNormal, box.axis[axisIndex]) >= 0 ? 1 : -1;
  const normal = scale3(vec3(), box.axis[axisIndex], sign);
  const center = addScaled3(vec3(), box.center, normal, box.half[axisIndex]);
  return { normal, center, ...faceAxes(box, axisIndex) };
}

function chooseIncidentFaceAxis(box: OBB, referenceNormal: V3): number {
  let axis = 0;
  let best = -FLT_MAX;
  for (let i = 0; i < 3; i++) {
    const d = absDot(box.axis[i], referenceNormal);
    if (d > best) {
      best = d;
      axis = i;
    }
  }
  return axis;
}

function buildIncidentFace(box: OBB, axisIndex: number, referenceNormal: V3): V3[] {
  const sign = dot(box.axis[axisIndex], referenceNormal) > 0 ? -1 : 1;
  const faceNormal = scale3(vec3(), box.axis[axisIndex], sign);
  const faceCenter = addScaled3(vec3(), box.center, faceNormal, box.half[axisIndex]);
  const { u, v, extentU, extentV } = faceAxes(box, axisIndex);
  const vert = (su: number, sv: number): V3 => {
    const p = addScaled3(vec3(), faceCenter, u, su * extentU);
    return addScaled3(p, p, v, sv * extentV);
  };
  return [vert(1, 1), vert(-1, 1), vert(-1, -1), vert(1, -1)];
}

function clipPolygonAgainstPlane(inVerts: V3[], planeNormal: V3, planeOffset: number): V3[] {
  const out: V3[] = [];
  if (inVerts.length === 0) return out;
  let a = inVerts[inVerts.length - 1];
  let da = dot(planeNormal, a) - planeOffset;
  for (const b of inVerts) {
    const db = dot(planeNormal, b) - planeOffset;
    const aInside = da <= PLANE_EPSILON;
    const bInside = db <= PLANE_EPSILON;
    if (aInside !== bInside) {
      let t = 0;
      const denom = da - db;
      if (Math.abs(denom) > SAT_AXIS_EPSILON) t = clamp(da / denom, 0, 1);
      if (out.length < MAX_POLY_VERTS) out.push(addScaled3(vec3(), a, sub3(vec3(), b, a), t));
    }
    if (bInside && out.length < MAX_POLY_VERTS) out.push(b);
    a = b;
    da = db;
  }
  return out;
}

class ContactBuilder {
  readonly contacts: RawContact[] = [];
  private readonly midpoints: V3[] = [];
  private readonly bodyA: Rigid;
  private readonly bodyB: Rigid;

  constructor(bodyA: Rigid, bodyB: Rigid) {
    this.bodyA = bodyA;
    this.bodyB = bodyB;
  }

  add(xA: V3, xB: V3, feature: number): void {
    const midpoint = scale3(vec3(), add3(vec3(), xA, xB), 0.5);
    for (const m of this.midpoints) if (lengthSq(sub3(vec3(), midpoint, m)) < CONTACT_MERGE_DIST_SQ) return;
    if (this.contacts.length >= MAX_CONTACTS) return;
    const { bodyA, bodyB } = this;
    this.contacts.push({
      feature,
      rA: rotateInv(vec3(), bodyA.positionAng, sub3(vec3(), xA, bodyA.positionLin)),
      rB: rotateInv(vec3(), bodyB.positionAng, sub3(vec3(), xB, bodyB.positionLin)),
    });
    this.midpoints.push(midpoint);
  }
}

function testAxis(boxA: OBB, boxB: OBB, delta: V3, axis: V3, type: number, indexA: number, indexB: number, best: SatAxis): boolean {
  const lenSq = lengthSq(axis);
  if (lenSq < SAT_AXIS_EPSILON) return true;

  const invLen = 1 / Math.sqrt(lenSq);
  const n = scale3(vec3(), axis, invLen);
  if (dot(n, delta) < 0) neg3(n, n);

  const distance = Math.abs(dot(delta, n));
  const rA = boxA.half[0] * absDot(n, boxA.axis[0]) + boxA.half[1] * absDot(n, boxA.axis[1]) + boxA.half[2] * absDot(n, boxA.axis[2]);
  const rB = boxB.half[0] * absDot(n, boxB.axis[0]) + boxB.half[1] * absDot(n, boxB.axis[1]) + boxB.half[2] * absDot(n, boxB.axis[2]);

  const separation = distance - (rA + rB);
  if (separation > 0) return false;

  if (!best.valid || separation > best.separation) {
    best.valid = true;
    best.type = type;
    best.indexA = indexA;
    best.indexB = indexB;
    best.separation = separation;
    best.normalAB = n;
  }
  return true;
}

function supportEdge(box: OBB, axisIndex: number, dir: V3): [V3, V3] {
  const axis1 = (axisIndex + 1) % 3;
  const axis2 = (axisIndex + 2) % 3;
  const sign1 = dot(dir, box.axis[axis1]) >= 0 ? 1 : -1;
  const sign2 = dot(dir, box.axis[axis2]) >= 0 ? 1 : -1;
  const edgeCenter = addScaled3(vec3(), box.center, box.axis[axis1], box.half[axis1] * sign1);
  addScaled3(edgeCenter, edgeCenter, box.axis[axis2], box.half[axis2] * sign2);
  const e = scale3(vec3(), box.axis[axisIndex], box.half[axisIndex]);
  return [sub3(vec3(), edgeCenter, e), add3(vec3(), edgeCenter, e)];
}

function closestPointsOnSegments(p0: V3, p1: V3, q0: V3, q1: V3): [V3, V3] {
  const d1 = sub3(vec3(), p1, p0);
  const d2 = sub3(vec3(), q1, q0);
  const r = sub3(vec3(), p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);

  let s = 0;
  let t = 0;

  if (a <= SAT_AXIS_EPSILON && e <= SAT_AXIS_EPSILON) return [p0, q0];

  if (a <= SAT_AXIS_EPSILON) {
    t = clamp(f / e, 0, 1);
  } else {
    const c = dot(d1, r);
    if (e <= SAT_AXIS_EPSILON) {
      s = clamp(-c / a, 0, 1);
    } else {
      const b = dot(d1, d2);
      const denom = a * e - b * b;
      if (Math.abs(denom) > SAT_AXIS_EPSILON) s = clamp((b * f - c * e) / denom, 0, 1);
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = clamp((b - c) / a, 0, 1);
      }
    }
  }

  return [addScaled3(vec3(), p0, d1, s), addScaled3(vec3(), q0, d2, t)];
}

function buildFaceManifold(
  bodyA: Rigid,
  bodyB: Rigid,
  boxA: OBB,
  boxB: OBB,
  referenceIsA: boolean,
  referenceAxis: number,
  normalAB: V3,
): RawContact[] {
  const referenceBox = referenceIsA ? boxA : boxB;
  const incidentBox = referenceIsA ? boxB : boxA;
  const referenceOutward = referenceIsA ? normalAB : neg3(vec3(), normalAB);

  const ref = buildFaceFrame(referenceBox, referenceAxis, referenceOutward);
  const incidentAxis = chooseIncidentFaceAxis(incidentBox, ref.normal);

  // Clip the incident face against the four side planes of the reference face
  let poly = buildIncidentFace(incidentBox, incidentAxis, ref.normal);
  const planes: [V3, number][] = [
    [ref.u, ref.extentU],
    [neg3(vec3(), ref.u), ref.extentU],
    [ref.v, ref.extentV],
    [neg3(vec3(), ref.v), ref.extentV],
  ];
  for (const [n, extent] of planes) {
    poly = clipPolygonAgainstPlane(poly, n, dot(n, ref.center) + extent);
    if (!poly.length) return [];
  }

  const builder = new ContactBuilder(bodyA, bodyB);
  const featurePrefix = ((referenceIsA ? AXIS_FACE_A : AXIS_FACE_B) << 24) | ((referenceAxis & 0xff) << 16) | ((incidentAxis & 0xff) << 8);

  for (let i = 0; i < poly.length && builder.contacts.length < MAX_CONTACTS; i++) {
    const pIncident = poly[i];
    const distance = dot(sub3(vec3(), pIncident, ref.center), ref.normal);
    if (distance > PLANE_EPSILON) continue;
    const pReference = addScaled3(vec3(), pIncident, ref.normal, -distance);
    const xA = referenceIsA ? pReference : pIncident;
    const xB = referenceIsA ? pIncident : pReference;
    builder.add(xA, xB, featurePrefix | (i & 0xff));
  }

  if (!builder.contacts.length) {
    builder.add(supportPoint(boxA, normalAB), supportPoint(boxB, neg3(vec3(), normalAB)), featurePrefix);
  }
  return builder.contacts;
}

function buildEdgeContact(bodyA: Rigid, bodyB: Rigid, boxA: OBB, boxB: OBB, axisA: number, axisB: number, normalAB: V3): RawContact[] {
  const [a0, a1] = supportEdge(boxA, axisA, normalAB);
  const [b0, b1] = supportEdge(boxB, axisB, neg3(vec3(), normalAB));
  const [xA, xB] = closestPointsOnSegments(a0, a1, b0, b1);

  const builder = new ContactBuilder(bodyA, bodyB);
  const featureKey = (AXIS_EDGE << 24) | ((axisA & 0xff) << 8) | (axisB & 0xff);
  builder.add(xA, xB, featureKey);
  if (!builder.contacts.length) {
    builder.add(supportPoint(boxA, normalAB), supportPoint(boxB, neg3(vec3(), normalAB)), featureKey);
  }
  return builder.contacts;
}

/**
 * Collide two boxes. Writes the contact basis to `basisOut` (rows: normal pointing from B to
 * A, then two tangents) and returns up to 8 contacts; empty when separated.
 */
export function collide(bodyA: Rigid, bodyB: Rigid, basisOut: M3): RawContact[] {
  const boxA = makeOBB(bodyA);
  const boxB = makeOBB(bodyB);
  const delta = sub3(vec3(), boxB.center, boxA.center);

  const bestFace: SatAxis = { type: AXIS_FACE_A, indexA: 0, indexB: 0, separation: -FLT_MAX, normalAB: vec3(), valid: false };
  const bestEdge: SatAxis = { type: AXIS_EDGE, indexA: 0, indexB: 0, separation: -FLT_MAX, normalAB: vec3(), valid: false };

  for (let i = 0; i < 3; i++) if (!testAxis(boxA, boxB, delta, boxA.axis[i], AXIS_FACE_A, i, -1, bestFace)) return [];
  for (let i = 0; i < 3; i++) if (!testAxis(boxA, boxB, delta, boxB.axis[i], AXIS_FACE_B, -1, i, bestFace)) return [];
  const axis = vec3();
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      cross(axis, boxA.axis[i], boxB.axis[j]);
      if (!testAxis(boxA, boxB, delta, axis, AXIS_EDGE, i, j, bestEdge)) return [];
    }
  }

  if (!bestFace.valid) return [];

  // Prefer a face axis unless an edge axis is clearly better (stabler manifolds)
  let best = bestFace;
  if (bestEdge.valid) {
    const edgeRelTol = 0.95;
    const edgeAbsTol = 0.01;
    if (edgeRelTol * bestEdge.separation > bestFace.separation + edgeAbsTol) best = bestEdge;
  }

  orthonormal(basisOut, neg3(vec3(), best.normalAB));

  if (best.type === AXIS_EDGE) return buildEdgeContact(bodyA, bodyB, boxA, boxB, best.indexA, best.indexB, best.normalAB);
  if (best.type === AXIS_FACE_A) return buildFaceManifold(bodyA, bodyB, boxA, boxB, true, best.indexA, best.normalAB);
  return buildFaceManifold(bodyA, bodyB, boxA, boxB, false, best.indexB, best.normalAB);
}
