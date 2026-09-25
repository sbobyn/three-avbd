// Convex hull contacts (GPU-only shape, ../hull.ts), included in the contacts module when the
// device can bind the hull buffer (GpuSolver3D: hulls). Pairs with a hull on either side (the other
// a hull, a box or a sphere) come here; box-box and sphere pairs keep their own paths.
//
// - SAT after Gregorius ("The Separating Axis Test between Convex Polyhedra", GDC 2013): face
//   normals of both shapes by support points, then only the edge pairs whose Gauss-map arcs cross
//   (they build a face of the Minkowski difference), so edges cost a few dot products each.
// - Face contact: the incident face (the other shape's most anti-parallel) clipped by the reference
//   face's side planes, points below the reference plane kept, at most 8 (deepest, then spread).
// - Edge contact: closest points of the two edges.
// - Sphere against hull: the closest point of the hull's surface, or the shallowest face when the
//   centre is inside.
//
// Hull buffer (array<vec4f>, offsets in vec4s; u32 fields bitcast): at a hull's header h,
//   h:   vertex start, vertex count, face start, face count
//   h+1: edge start, edge count, index start, 0
// vertices (xyz), faces (2 vec4: normal + plane offset, then first index + count), vertex indices
// (4 per vec4) and edges (vertex a, vertex b, face on each side), all in the body's frame. A body
// is a hull when angVel.w >= SHAPE_HULL, its header at angVel.w - SHAPE_HULL.

export const HULL_WGSL = /* wgsl */ `
const MAX_CLIP = 32u;
const NO_HULL = 0xffffffffu;

/** A convex shape as the hull code sees it: a box (hull = NO_HULL, extents h) or a hull. */
struct Poly {
  c: vec3f,
  q: vec4f,
  h: vec3f,
  hull: u32,
  vs: u32, nv: u32, fs: u32, nf: u32, es: u32, ne: u32, is: u32,
}

// Box topology: vertex v has signs (bit 0: x, 1: y, 2: z); faces +x -x +y -y +z -z as vertex
// loops; edges as vertex a, vertex b, the two faces they separate.
var<private> BOX_FACE_VERTS: array<u32, 24> = array<u32, 24>(1u, 3u, 7u, 5u, 0u, 2u, 6u, 4u, 2u, 3u, 7u, 6u, 0u, 1u, 5u, 4u, 4u, 5u, 7u, 6u, 0u, 1u, 3u, 2u);
var<private> BOX_EDGES: array<vec4u, 12> = array<vec4u, 12>(
  vec4u(0u, 1u, 3u, 5u), vec4u(2u, 3u, 2u, 5u), vec4u(4u, 5u, 3u, 4u), vec4u(6u, 7u, 2u, 4u),
  vec4u(0u, 2u, 1u, 5u), vec4u(1u, 3u, 0u, 5u), vec4u(4u, 6u, 1u, 4u), vec4u(5u, 7u, 0u, 4u),
  vec4u(0u, 4u, 1u, 3u), vec4u(1u, 5u, 0u, 3u), vec4u(2u, 6u, 1u, 2u), vec4u(3u, 7u, 0u, 2u));

fn isHull(i: u32) -> bool {
  return bodies[i].angVel.w >= SHAPE_HULL;
}

fn polyOf(i: u32) -> Poly {
  var P: Poly;
  P.c = bodies[i].pos.xyz;
  P.q = bodies[i].rot;
  P.h = bodies[i].size.xyz * 0.5;
  P.hull = NO_HULL;
  P.nv = 8u; P.nf = 6u; P.ne = 12u;
  if (isHull(i)) {
    let h = u32(bodies[i].angVel.w - SHAPE_HULL + 0.5);
    let h0 = bitcast<vec4u>(hulls[h]);
    let h1 = bitcast<vec4u>(hulls[h + 1u]);
    P.hull = h;
    P.vs = h0.x; P.nv = h0.y; P.fs = h0.z; P.nf = h0.w;
    P.es = h1.x; P.ne = h1.y; P.is = h1.z;
  }
  return P;
}

fn vertLocal(P: Poly, v: u32) -> vec3f {
  if (P.hull == NO_HULL) {
    return vec3f(select(-P.h.x, P.h.x, (v & 1u) != 0u), select(-P.h.y, P.h.y, (v & 2u) != 0u), select(-P.h.z, P.h.z, (v & 4u) != 0u));
  }
  return hulls[P.vs + v].xyz;
}

fn vert(P: Poly, v: u32) -> vec3f {
  return P.c + qrotate(P.q, vertLocal(P, v));
}

/** Face f's world plane: outward normal (xyz) and offset (w). */
fn facePlane(P: Poly, f: u32) -> vec4f {
  var nl: vec3f;
  var d: f32;
  if (P.hull == NO_HULL) {
    let k = f / 2u;
    let s = select(1.0, -1.0, (f & 1u) != 0u);
    nl = vec3f(0.0);
    nl[k] = s;
    d = P.h[k];
  } else {
    let p = hulls[P.fs + 2u * f];
    nl = p.xyz;
    d = p.w;
  }
  let n = qrotate(P.q, nl);
  return vec4f(n, d + dot(n, P.c));
}

fn faceVertCount(P: Poly, f: u32) -> u32 {
  if (P.hull == NO_HULL) { return 4u; }
  return bitcast<u32>(hulls[P.fs + 2u * f + 1u].y);
}

fn faceVert(P: Poly, f: u32, j: u32) -> u32 {
  if (P.hull == NO_HULL) { return BOX_FACE_VERTS[f * 4u + j]; }
  let k = bitcast<u32>(hulls[P.fs + 2u * f + 1u].x) + j;
  return bitcast<u32>(hulls[P.is + k / 4u][k % 4u]);
}

fn edgeOf(P: Poly, e: u32) -> vec4u {
  if (P.hull == NO_HULL) { return BOX_EDGES[e]; }
  return bitcast<vec4u>(hulls[P.es + e]);
}

fn polySupport(P: Poly, dir: vec3f) -> vec3f {
  let l = qrotate(qconj(P.q), dir);
  if (P.hull == NO_HULL) { return P.c + qrotate(P.q, select(-P.h, P.h, l >= vec3f(0.0))); }
  var best = -3.4e38;
  var at = vec3f(0.0);
  for (var v = 0u; v < P.nv; v++) {
    let p = hulls[P.vs + v].xyz;
    let s = dot(p, l);
    if (s > best) { best = s; at = p; }
  }
  return P.c + qrotate(P.q, at);
}

struct FaceQuery { sep: f32, face: u32 }

/** The face of A whose plane B sticks out of least (largest separation). */
fn queryFaces(A: Poly, B: Poly) -> FaceQuery {
  var out = FaceQuery(-3.4e38, 0u);
  for (var f = 0u; f < A.nf; f++) {
    let p = facePlane(A, f);
    let s = dot(p.xyz, polySupport(B, -p.xyz)) - p.w;
    if (s > out.sep) { out = FaceQuery(s, f); }
  }
  return out;
}

/** The edges' Gauss-map arcs (a-b on A's, c-d on B's negated) cross: their cross product is a candidate axis. */
fn minkowskiFace(a: vec3f, b: vec3f, c: vec3f, d: vec3f) -> bool {
  let bxa = cross(b, a);
  let dxc = cross(d, c);
  let cba = dot(c, bxa);
  let dba = dot(d, bxa);
  let adc = dot(a, dxc);
  let bdc = dot(b, dxc);
  return cba * dba < 0.0 && adc * bdc < 0.0 && cba * bdc > 0.0;
}

struct EdgeQuery { sep: f32, ea: u32, eb: u32, n: vec3f, valid: bool }

fn queryEdges(A: Poly, B: Poly) -> EdgeQuery {
  var out: EdgeQuery;
  out.sep = -3.4e38;
  for (var i = 0u; i < A.ne; i++) {
    let ea = edgeOf(A, i);
    let pa = vert(A, ea.x);
    let qa = vert(A, ea.y);
    let a = facePlane(A, ea.z).xyz;
    let b = facePlane(A, ea.w).xyz;
    for (var j = 0u; j < B.ne; j++) {
      let eb = edgeOf(B, j);
      let c = facePlane(B, eb.z).xyz;
      let d = facePlane(B, eb.w).xyz;
      if (!minkowskiFace(a, b, -c, -d)) { continue; }
      let pb = vert(B, eb.x);
      let qb = vert(B, eb.y);
      var n = cross(qa - pa, qb - pb);
      let l = length(n);
      // Parallel edges: their faces' normals already cover the axis
      if (l < 1e-5 * length(qa - pa) * length(qb - pb)) { continue; }
      n /= l;
      if (dot(n, pa - A.c) < 0.0) { n = -n; }
      let s = dot(n, pb - pa);
      if (s > out.sep) { out = EdgeQuery(s, i, j, n, true); }
    }
  }
  return out;
}

/** Clip poly (n points) to dot(pn, x) <= offset. */
fn clipHull(src: ptr<function, array<vec3f, 32>>, n: u32, dst: ptr<function, array<vec3f, 32>>, pn: vec3f, offset: f32) -> u32 {
  if (n == 0u) { return 0u; }
  var count = 0u;
  var a = (*src)[n - 1u];
  var da = dot(pn, a) - offset;
  for (var i = 0u; i < n; i++) {
    let b = (*src)[i];
    let db = dot(pn, b) - offset;
    if ((da <= PLANE_EPSILON) != (db <= PLANE_EPSILON)) {
      var t = 0.0;
      if (abs(da - db) > SAT_AXIS_EPSILON) { t = clamp(da / (da - db), 0.0, 1.0); }
      if (count < MAX_CLIP) { (*dst)[count] = a + (b - a) * t; count++; }
    }
    if (db <= PLANE_EPSILON && count < MAX_CLIP) { (*dst)[count] = b; count++; }
    a = b;
    da = db;
  }
  return count;
}

/** Face contact: A's (refIsA) or B's face refFace is the reference face; the other shape's is clipped to it. */
fn hullFaceContact(A: Poly, B: Poly, refIsA: bool, refFace: u32) -> Found {
  var found: Found;
  var R = B;
  var I = A;
  if (refIsA) { R = A; I = B; }
  let plane = facePlane(R, refFace);
  let rn = plane.xyz;
  // Incident face: the other shape's most anti-parallel
  var inc = 0u;
  var least = 3.4e38;
  for (var f = 0u; f < I.nf; f++) {
    let d = dot(facePlane(I, f).xyz, rn);
    if (d < least) { least = d; inc = f; }
  }
  var poly: array<vec3f, 32>;
  var tmp: array<vec3f, 32>;
  var n = min(faceVertCount(I, inc), MAX_CLIP);
  for (var j = 0u; j < n; j++) { poly[j] = vert(I, faceVert(I, inc, j)); }
  // Side planes of the reference face, outward from its centre
  let k = faceVertCount(R, refFace);
  var centre = vec3f(0.0);
  for (var j = 0u; j < k; j++) { centre += vert(R, faceVert(R, refFace, j)); }
  centre /= f32(k);
  for (var j = 0u; j < k && n > 0u; j++) {
    let v0 = vert(R, faceVert(R, refFace, j));
    let v1 = vert(R, faceVert(R, refFace, (j + 1u) % k));
    var s = cross(v1 - v0, rn);
    let l = length(s);
    if (l < SAT_AXIS_EPSILON) { continue; }
    s /= l;
    if (dot(s, centre - v0) > 0.0) { s = -s; }
    n = clipHull(&poly, n, &tmp, s, dot(s, v0));
    for (var m = 0u; m < n; m++) { poly[m] = tmp[m]; }
  }
  // Points on or below the reference plane; at most MAX_CONTACTS, the deepest first then the
  // farthest from those chosen (the patch's extent is what keeps a resting shape upright)
  // (feature keys use the point's index in the clipped polygon, as faceManifold does: stable from
  // step to step, so warm starts and static-friction anchors stay with their point)
  var depth: array<f32, 32>;
  var index: array<u32, 32>;
  var keep = 0u;
  for (var m = 0u; m < n; m++) {
    let dist = dot(rn, poly[m]) - plane.w;
    if (dist <= PLANE_EPSILON) { tmp[keep] = poly[m]; depth[keep] = dist; index[keep] = m; keep++; }
  }
  let prefix = (select(AXIS_FACE_B, AXIS_FACE_A, refIsA) << 24u) | (min(refFace, 255u) << 16u) | (min(inc, 255u) << 8u);
  var chosen: array<bool, 32>;
  for (var c = 0u; c < min(keep, MAX_CONTACTS); c++) {
    var pick = 0u;
    var bestScore = -3.4e38;
    for (var m = 0u; m < keep; m++) {
      if (chosen[m]) { continue; }
      var score = -depth[m];
      if (c > 0u) {
        score = 3.4e38;
        for (var o = 0u; o < keep; o++) { if (chosen[o]) { score = min(score, dot(tmp[m] - tmp[o], tmp[m] - tmp[o])); } }
      }
      if (score > bestScore) { bestScore = score; pick = m; }
    }
    chosen[pick] = true;
    let p = tmp[pick];
    let onRef = p - rn * depth[pick];
    addFound(&found, select(p, onRef, refIsA), select(onRef, p, refIsA), prefix | min(index[pick], 255u));
  }
  if (found.count == 0u) {
    let nAB = select(-rn, rn, refIsA);
    addFound(&found, polySupport(A, nAB), polySupport(B, -nAB), prefix);
  }
  return found;
}

fn hullEdgeContact(A: Poly, B: Poly, q: EdgeQuery) -> Found {
  var found: Found;
  let ea = edgeOf(A, q.ea);
  let eb = edgeOf(B, q.eb);
  let p0 = vert(A, ea.x);
  let q0 = vert(B, eb.x);
  let d1 = vert(A, ea.y) - p0;
  let d2 = vert(B, eb.y) - q0;
  let r = p0 - q0;
  let a = dot(d1, d1);
  let e = dot(d2, d2);
  let f = dot(d2, r);
  let c = dot(d1, r);
  let b = dot(d1, d2);
  let denom = a * e - b * b;
  var s = 0.0;
  if (abs(denom) > SAT_AXIS_EPSILON * a * e) { s = clamp((b * f - c * e) / denom, 0.0, 1.0); }
  var t = (b * s + f) / max(e, SAT_AXIS_EPSILON);
  if (t < 0.0) { t = 0.0; s = clamp(-c / max(a, SAT_AXIS_EPSILON), 0.0, 1.0); }
  else if (t > 1.0) { t = 1.0; s = clamp((b - c) / max(a, SAT_AXIS_EPSILON), 0.0, 1.0); }
  addFound(&found, p0 + d1 * s, q0 + d2 * t, (AXIS_EDGE << 24u) | (min(q.ea, 255u) << 8u) | min(q.eb, 255u));
  return found;
}

/** Collide two convex shapes (at least one a hull); sat.n from A towards B. */
fn collidePoly(A: Poly, B: Poly, sat: ptr<function, Sat>) -> Found {
  var none: Found;
  let fa = queryFaces(A, B);
  if (fa.sep > 0.0) { return none; }
  let fb = queryFaces(B, A);
  if (fb.sep > 0.0) { return none; }
  let eq = queryEdges(A, B);
  if (eq.valid && eq.sep > 0.0) { return none; }
  // Faces are preferred (stabler manifolds) unless an edge axis is clearly better, as in collide
  let faceSep = max(fa.sep, fb.sep);
  var edgeWins = eq.valid && eq.sep > 0.95 * faceSep + 0.01;
  if ((params.flags & FLAG_FACE_BIAS) == 0u) { edgeWins = eq.valid && 0.95 * eq.sep > faceSep + 0.01; }
  if (edgeWins) {
    *sat = Sat(AXIS_EDGE, eq.ea, eq.eb, eq.sep, eq.n, true);
    return hullEdgeContact(A, B, eq);
  }
  // A's face unless B's separates more, as collide does
  if (fb.sep > fa.sep) {
    *sat = Sat(AXIS_FACE_B, 0u, fb.face, fb.sep, -facePlane(B, fb.face).xyz, true);
    return hullFaceContact(A, B, false, fb.face);
  }
  *sat = Sat(AXIS_FACE_A, fa.face, 0u, fa.sep, facePlane(A, fa.face).xyz, true);
  return hullFaceContact(A, B, true, fa.face);
}

/** Closest point of segment ab to p. */
fn segmentPoint(a: vec3f, b: vec3f, p: vec3f) -> vec3f {
  let d = b - a;
  return a + d * clamp(dot(p - a, d) / max(dot(d, d), 1e-20), 0.0, 1.0);
}

/** Sphere S (centre c, radius r) against hull X: as sphereBox (n from the sphere towards X). */
fn sphereHull(c: vec3f, r: f32, X: Poly) -> SphereBoxHit {
  var out: SphereBoxHit;
  var deepest = -3.4e38;
  var deepFace = 0u;
  for (var f = 0u; f < X.nf; f++) {
    let s = dot(facePlane(X, f).xyz, c) - facePlane(X, f).w;
    if (s > deepest) { deepest = s; deepFace = f; }
  }
  if (deepest > r) { return out; }
  if (deepest <= 0.0) {
    // Centre inside: out through the face it is least deep behind
    let n = facePlane(X, deepFace).xyz;
    out.hit = true;
    out.n = -n;
    out.onBox = c - n * deepest;
    out.onSphere = c - n * r;
    return out;
  }
  // Outside: the closest point is on a face the centre is in front of
  var best = vec3f(0.0);
  var bestDist = 3.4e38;
  for (var f = 0u; f < X.nf; f++) {
    let plane = facePlane(X, f);
    let s = dot(plane.xyz, c) - plane.w;
    if (s <= 0.0) { continue; }
    var p = c - plane.xyz * s;
    let k = faceVertCount(X, f);
    var centre = vec3f(0.0);
    for (var j = 0u; j < k; j++) { centre += vert(X, faceVert(X, f, j)); }
    centre /= f32(k);
    var inside = true;
    var edgeBest = vec3f(0.0);
    var edgeDist = 3.4e38;
    for (var j = 0u; j < k; j++) {
      let v0 = vert(X, faceVert(X, f, j));
      let v1 = vert(X, faceVert(X, f, (j + 1u) % k));
      var side = cross(v1 - v0, plane.xyz);
      if (dot(side, centre - v0) > 0.0) { side = -side; }
      if (dot(side, p - v0) > 0.0) { inside = false; }
      let q = segmentPoint(v0, v1, c);
      let dq = dot(q - c, q - c);
      if (dq < edgeDist) { edgeDist = dq; edgeBest = q; }
    }
    if (!inside) { p = edgeBest; }
    let dist = length(p - c);
    if (dist < bestDist) { bestDist = dist; best = p; }
  }
  if (bestDist > r) { return out; }
  var n = vec3f(0.0, 0.0, 1.0);
  if (bestDist > 0.0) { n = (c - best) / bestDist; }  // from the hull towards the sphere
  out.hit = true;
  out.n = -n;
  out.onBox = best;
  out.onSphere = c - n * r;
  return out;
}
`;
