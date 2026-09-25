// Convex hulls for the GPU solver's hull shape (GPU-only, like spheres: ../shapes.ts). A hull is
// built once on the CPU from a point set: the convex hull (incremental, triangles merged into
// planar polygon faces), its edges with the two faces each separates (the narrowphase's Gauss-map
// test), and its mass properties. Vertices are stored in the hull's principal frame, centred on
// its centre of mass, since the solver keeps a body's inertia as three principal moments.

export interface HullFace {
  /** Outward unit normal and plane offset (n·x = d), principal frame. */
  normal: [number, number, number];
  d: number;
  /** Vertex indices, counter-clockwise seen from outside. */
  verts: number[];
}

export interface HullShape {
  /** Vertices, principal frame (x, y, z per vertex). */
  vertices: Float32Array;
  faces: HullFace[];
  /** Edges: vertex a, vertex b, the face on each side (face with a→b, face with b→a). */
  edges: Array<[number, number, number, number]>;
  /** Volume, and principal moments of inertia per unit density. */
  volume: number;
  moments: [number, number, number];
  /** Full widths of the vertices' bounds along the principal axes (symmetric about the centre of mass). */
  size: [number, number, number];
  /** Distance of the farthest vertex from the centre of mass. */
  radius: number;
  /** Where the principal frame sits in the input points' frame: centre of mass and rotation (x, y, z, w). */
  center: [number, number, number];
  rotation: [number, number, number, number];
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.sqrt(dot(a, a));

interface Tri {
  v: V3;
  n: V3;
  d: number;
}

/**
 * The convex hull of xyz points and its mass properties, or null when the points span no volume
 * (fewer than four, or all on a plane or line).
 */
/**
 * Most vertices a hull keeps (bigger ones are simplified: see \`convexHull\`). The GPU narrowphase
 * costs faces × vertices and edges × edges per touching pair, in one thread, and its contact feature
 * keys hold face and point indices in 8 bits; 32 vertices means at most 60 faces and 90 edges (a
 * fracture piece has 10-30 vertices).
 */
export const MAX_HULL_VERTICES = 32;

/**
 * The convex hull of xyz points and its mass properties, or null when the points span no volume
 * (fewer than four, or all on a plane or line). A hull of more than MAX_HULL_VERTICES vertices is
 * replaced by the hull of that many of them, spread out (farthest-point sampling): slightly smaller,
 * much cheaper to collide.
 */
export function convexHull(points: ArrayLike<number>): HullShape | null {
  const full = buildHull(points);
  if (!full || full.vertices.length / 3 <= MAX_HULL_VERTICES) return full;
  return buildHull(spreadVertices(full, MAX_HULL_VERTICES));
}

/** \`count\` of a hull's vertices, spread out, in the input points' frame. */
function spreadVertices(h: HullShape, count: number): number[] {
  const [x, y, z, w] = h.rotation;
  const back = (v: V3): V3 => {
    const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0] + (y * t[2] - z * t[1]) + h.center[0], v[1] + w * t[1] + (z * t[0] - x * t[2]) + h.center[1], v[2] + w * t[2] + (x * t[1] - y * t[0]) + h.center[2]];
  };
  const verts: V3[] = [];
  for (let i = 0; i < h.vertices.length; i += 3) verts.push(back([h.vertices[i], h.vertices[i + 1], h.vertices[i + 2]]));
  // Farthest-point sampling from the vertex farthest from the centre of mass
  let first = 0;
  verts.forEach((v, i) => { if (len(sub(v, h.center)) > len(sub(verts[first], h.center))) first = i; });
  const chosen = [first];
  const dist = verts.map((v) => len(sub(v, verts[first])));
  while (chosen.length < count) {
    let far = 0;
    dist.forEach((d, i) => { if (d > dist[far]) far = i; });
    chosen.push(far);
    verts.forEach((v, i) => { dist[i] = Math.min(dist[i], len(sub(v, verts[far]))); });
  }
  return chosen.flatMap((i) => verts[i]);
}

function buildHull(points: ArrayLike<number>): HullShape | null {
  // Unique points (split vertices repeat positions exactly)
  let scale = 0;
  for (let i = 0; i < points.length; i++) scale = Math.max(scale, Math.abs(points[i]));
  const eps = Math.max(scale, 1e-9) * 1e-6;
  const seen = new Set<string>();
  const p: V3[] = [];
  for (let i = 0; i + 2 < points.length; i += 3) {
    const v: V3 = [points[i], points[i + 1], points[i + 2]];
    const key = v.map((x) => Math.round(x / eps)).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    p.push(v);
  }
  if (p.length < 4) return null;
  const tol = Math.max(scale, 1e-9) * 1e-10;

  // Initial tetrahedron from extreme points
  let i0 = 0;
  for (let i = 1; i < p.length; i++) if (p[i][0] < p[i0][0]) i0 = i;
  let i1 = -1;
  let best = 0;
  for (let i = 0; i < p.length; i++) {
    const d = len(sub(p[i], p[i0]));
    if (d > best) { best = d; i1 = i; }
  }
  if (i1 < 0 || best < tol) return null;
  let i2 = -1;
  best = 0;
  const e01 = sub(p[i1], p[i0]);
  for (let i = 0; i < p.length; i++) {
    const d = len(cross(e01, sub(p[i], p[i0])));
    if (d > best) { best = d; i2 = i; }
  }
  if (i2 < 0 || best < tol * len(e01)) return null;
  const n012 = cross(e01, sub(p[i2], p[i0]));
  let i3 = -1;
  best = 0;
  for (let i = 0; i < p.length; i++) {
    const d = Math.abs(dot(n012, sub(p[i], p[i0])));
    if (d > best) { best = d; i3 = i; }
  }
  if (i3 < 0 || best < tol * len(n012)) return null;

  const tris: Tri[] = [];
  const make = (a: number, b: number, c: number): Tri => {
    const n = cross(sub(p[b], p[a]), sub(p[c], p[a]));
    const l = len(n) || 1;
    const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
    return { v: [a, b, c], n: u, d: dot(u, p[a]) };
  };
  // Orient the tetrahedron's faces outward
  const flip = dot(n012, sub(p[i3], p[i0])) > 0;
  const base = flip ? [i0, i2, i1] : [i0, i1, i2];
  tris.push(make(base[0], base[1], base[2]));
  tris.push(make(base[0], i3, base[1]));
  tris.push(make(base[1], i3, base[2]));
  tris.push(make(base[2], i3, base[0]));

  const used = new Set([i0, i1, i2, i3]);
  // Farthest points first: the hull grows in big steps and fewer points meet nearly flat faces
  const order = p.map((_, i) => i).filter((i) => !used.has(i));
  const centre = [i0, i1, i2, i3].reduce<V3>((c, i) => [c[0] + p[i][0] / 4, c[1] + p[i][1] / 4, c[2] + p[i][2] / 4], [0, 0, 0]);
  order.sort((a, b) => len(sub(p[b], centre)) - len(sub(p[a], centre)));
  for (const i of order) {
    // Faces the point is clearly in front of; none: it is inside (or on) the hull
    const seeds = tris.filter((t) => dot(t.n, p[i]) - t.d > tol);
    if (!seeds.length) continue;
    // The visible region grows from those across neighbours the point is level with or in front
    // of: coplanar triangles of one face are then removed together (with a strict test alone, one
    // of two coplanar triangles could stay and the new fan would overlap it)
    const byEdge = new Map<string, Tri>();
    for (const t of tris) for (let k = 0; k < 3; k++) byEdge.set(`${t.v[k]},${t.v[(k + 1) % 3]}`, t);
    const region = new Set<Tri>(seeds);
    const queue = [...seeds];
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const u = byEdge.get(`${t.v[(k + 1) % 3]},${t.v[k]}`);
        if (u && !region.has(u) && dot(u.n, p[i]) - u.d > -tol) { region.add(u); queue.push(u); }
      }
    }
    const visible = [...region];
    // Horizon: directed edges of visible faces whose reverse is on a face that stays
    const onVisible = new Set<string>();
    for (const t of visible) for (let k = 0; k < 3; k++) onVisible.add(`${t.v[k]},${t.v[(k + 1) % 3]}`);
    const horizon: Array<[number, number]> = [];
    for (const t of visible) {
      for (let k = 0; k < 3; k++) {
        const a = t.v[k];
        const b = t.v[(k + 1) % 3];
        if (!onVisible.has(`${b},${a}`)) horizon.push([a, b]);
      }
    }
    for (const t of visible) tris.splice(tris.indexOf(t), 1);
    for (const [a, b] of horizon) tris.push(make(a, b, i));
  }

  return mergeTriangles(p.flat(), tris.flatMap((t) => t.v));
}

/**
 * A hull from a closed, outward-wound triangulation of a convex point set (e.g. three.js's
 * ConvexHull, or `convexHull` above): coplanar neighbouring triangles merged into polygon faces,
 * the edges with their two faces, and the mass properties. Null when the triangles don't close up
 * (every edge on exactly two faces) or enclose no volume.
 */
export function hullFromTriangles(positions: ArrayLike<number>, indices: ArrayLike<number>): HullShape | null {
  const h = mergeTriangles(positions, indices);
  // Too many vertices for the GPU: simplify as convexHull does
  return h && h.vertices.length / 3 > MAX_HULL_VERTICES ? buildHull(spreadVertices(h, MAX_HULL_VERTICES)) : h;
}

function mergeTriangles(positions: ArrayLike<number>, indices: ArrayLike<number>): HullShape | null {
  const p: V3[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) p.push([positions[i], positions[i + 1], positions[i + 2]]);
  let scale = 0;
  for (const v of p) scale = Math.max(scale, Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  const planeTol = Math.max(scale, 1e-9) * 1e-5;
  const tris: Array<{ v: V3; n: V3; d: number }> = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const v: V3 = [indices[i], indices[i + 1], indices[i + 2]];
    const c = cross(sub(p[v[1]], p[v[0]]), sub(p[v[2]], p[v[0]]));
    const l = len(c);
    if (!(l > 0)) continue;
    const n: V3 = [c[0] / l, c[1] / l, c[2] / l];
    tris.push({ v, n, d: dot(n, p[v[0]]) });
  }

  // Faces: regions grown from a seed triangle over neighbours on the seed's plane (a region grown
  // pair by pair could bend along a curved surface into a face that isn't flat)
  const edgeTri = new Map<string, number>();
  tris.forEach((t, k) => {
    for (let j = 0; j < 3; j++) edgeTri.set(`${t.v[j]},${t.v[(j + 1) % 3]}`, k);
  });
  const groupOf = new Array<number>(tris.length).fill(-1);
  const groups: number[][] = [];
  tris.forEach((seed, k) => {
    if (groupOf[k] >= 0) return;
    const members = [k];
    groupOf[k] = groups.length;
    for (let m = 0; m < members.length; m++) {
      const t = tris[members[m]];
      for (let j = 0; j < 3; j++) {
        const other = edgeTri.get(`${t.v[(j + 1) % 3]},${t.v[j]}`);
        if (other === undefined || groupOf[other] >= 0) continue;
        const u = tris[other];
        if (dot(seed.n, u.n) > 1 - 1e-5 && u.v.every((v) => Math.abs(dot(seed.n, p[v]) - seed.d) <= planeTol)) {
          groupOf[other] = groups.length;
          members.push(other);
        }
      }
    }
    groups.push(members);
  });

  const polys: Array<{ n: V3; verts: number[] }> = [];
  for (const members of groups) {
    const inGroup = new Set<string>();
    for (const k of members) for (let j = 0; j < 3; j++) inGroup.add(`${tris[k].v[j]},${tris[k].v[(j + 1) % 3]}`);
    const next = new Map<number, number>();
    for (const k of members) {
      for (let j = 0; j < 3; j++) {
        const a = tris[k].v[j];
        const b = tris[k].v[(j + 1) % 3];
        if (!inGroup.has(`${b},${a}`)) {
          if (next.has(a)) return null; // the region's boundary isn't one loop
          next.set(a, b);
        }
      }
    }
    // Area-weighted normal of the group
    const n: V3 = [0, 0, 0];
    for (const k of members) {
      const t = tris[k];
      const c = cross(sub(p[t.v[1]], p[t.v[0]]), sub(p[t.v[2]], p[t.v[0]]));
      n[0] += c[0]; n[1] += c[1]; n[2] += c[2];
    }
    const l = len(n) || 1;
    const start = next.keys().next().value!;
    const loop = [start];
    for (let v = next.get(start)!; v !== start && loop.length <= next.size; v = next.get(v)!) loop.push(v);
    if (loop.length !== next.size) return null;
    // Vertices where the boundary runs straight on stay: a neighbouring face may have a corner
    // there, and the two faces' edges must match (the edge list pairs them)
    polys.push({ n: [n[0] / l, n[1] / l, n[2] / l], verts: loop });
  }

  // Keep the vertices the faces use
  const index = new Map<number, number>();
  const verts: V3[] = [];
  for (const poly of polys) for (const v of poly.verts) if (!index.has(v)) { index.set(v, verts.length); verts.push(p[v]); }
  for (const poly of polys) poly.verts = poly.verts.map((v) => index.get(v)!);

  // A closed surface: every edge on exactly two faces, in opposite directions (V - E + F = 2)
  const directed = new Set<string>();
  let sides = 0;
  for (const poly of polys) poly.verts.forEach((v, k) => { directed.add(`${v},${poly.verts[(k + 1) % poly.verts.length]}`); sides++; });
  if (directed.size !== sides || ![...directed].every((e) => { const [a, b] = e.split(','); return directed.has(`${b},${a}`); })) return null;
  if (verts.length - directed.size / 2 + polys.length !== 2) return null;

  // Mass properties: signed tetrahedra from the origin over fan-triangulated faces (Blow & Binstock)
  let volume = 0;
  const com: V3 = [0, 0, 0];
  const C = [0, 0, 0, 0, 0, 0]; // covariance xx yy zz xy xz yz
  for (const poly of polys) {
    const a = verts[poly.verts[0]];
    for (let k = 1; k + 1 < poly.verts.length; k++) {
      const b = verts[poly.verts[k]];
      const c = verts[poly.verts[k + 1]];
      const det = dot(a, cross(b, c));
      volume += det / 6;
      for (let j = 0; j < 3; j++) com[j] += (det / 24) * (a[j] + b[j] + c[j]);
      const s = (i: number, j: number) => (det / 120) * (a[i] * a[j] + b[i] * b[j] + c[i] * c[j] + (a[i] + b[i] + c[i]) * (a[j] + b[j] + c[j]));
      C[0] += s(0, 0); C[1] += s(1, 1); C[2] += s(2, 2); C[3] += s(0, 1); C[4] += s(0, 2); C[5] += s(1, 2);
    }
  }
  if (!(volume > 0)) return null;
  for (let j = 0; j < 3; j++) com[j] /= volume;
  // Covariance about the centre of mass, then the inertia tensor (per unit density)
  C[0] -= volume * com[0] * com[0]; C[1] -= volume * com[1] * com[1]; C[2] -= volume * com[2] * com[2];
  C[3] -= volume * com[0] * com[1]; C[4] -= volume * com[0] * com[2]; C[5] -= volume * com[1] * com[2];
  const tr = C[0] + C[1] + C[2];
  const I = [[tr - C[0], -C[3], -C[4]], [-C[3], tr - C[1], -C[5]], [-C[4], -C[5], tr - C[2]]];
  const { values, vectors } = eigenSymmetric(I);

  // Principal frame: columns of `vectors` (right-handed); local = Rᵀ(x - com)
  const R = vectors;
  const toLocal = (v: V3): V3 => {
    const d = sub(v, com);
    return [R[0][0] * d[0] + R[1][0] * d[1] + R[2][0] * d[2], R[0][1] * d[0] + R[1][1] * d[1] + R[2][1] * d[2], R[0][2] * d[0] + R[1][2] * d[1] + R[2][2] * d[2]];
  };
  const local = verts.map(toLocal);
  const vertices = new Float32Array(local.flat());
  const faces: HullFace[] = polys.map((poly) => {
    const n = poly.n;
    const nl: V3 = [R[0][0] * n[0] + R[1][0] * n[1] + R[2][0] * n[2], R[0][1] * n[0] + R[1][1] * n[1] + R[2][1] * n[2], R[0][2] * n[0] + R[1][2] * n[1] + R[2][2] * n[2]];
    let d = -Infinity;
    for (const v of poly.verts) d = Math.max(d, dot(nl, local[v]));
    return { normal: nl, d, verts: poly.verts };
  });
  const faceOf = new Map<string, number>();
  faces.forEach((f, k) => f.verts.forEach((v, j) => faceOf.set(`${v},${f.verts[(j + 1) % f.verts.length]}`, k)));
  const edges: Array<[number, number, number, number]> = [];
  faces.forEach((f, k) =>
    f.verts.forEach((a, j) => {
      const b = f.verts[(j + 1) % f.verts.length];
      const other = faceOf.get(`${b},${a}`);
      if (a < b && other !== undefined) edges.push([a, b, k, other]);
    }),
  );
  const size: V3 = [0, 0, 0];
  let radius = 0;
  for (const v of local) {
    for (let j = 0; j < 3; j++) size[j] = Math.max(size[j], 2 * Math.abs(v[j]));
    radius = Math.max(radius, len(v));
  }
  return { vertices, faces, edges, volume, moments: [values[0], values[1], values[2]], size, radius, center: com, rotation: quatFromBasis(R) };
}

/** Eigenvalues and eigenvectors (columns, right-handed) of a symmetric 3×3 matrix, by Jacobi rotations. */
function eigenSymmetric(m: number[][]): { values: V3; vectors: number[][] } {
  const a = m.map((r) => [...r]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30 * (a[0][0] ** 2 + a[1][1] ** 2 + a[2][2] ** 2 + 1e-300)) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  // Right-handed: third column = first × second
  const x: V3 = [v[0][0], v[1][0], v[2][0]];
  const y: V3 = [v[0][1], v[1][1], v[2][1]];
  const z = cross(x, y);
  const vectors = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
  return { values: [a[0][0], a[1][1], a[2][2]], vectors };
}

/** Quaternion (x, y, z, w) of a rotation matrix given as rows. */
function quatFromBasis(m: number[][]): [number, number, number, number] {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    w = 0.25 / s; x = (m[2][1] - m[1][2]) * s; y = (m[0][2] - m[2][0]) * s; z = (m[1][0] - m[0][1]) * s;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
    w = (m[2][1] - m[1][2]) / s; x = 0.25 * s; y = (m[0][1] + m[1][0]) / s; z = (m[0][2] + m[2][0]) / s;
  } else if (m[1][1] > m[2][2]) {
    const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
    w = (m[0][2] - m[2][0]) / s; x = (m[0][1] + m[1][0]) / s; y = 0.25 * s; z = (m[1][2] + m[2][1]) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
    w = (m[1][0] - m[0][1]) / s; x = (m[0][2] + m[2][0]) / s; y = (m[1][2] + m[2][1]) / s; z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w);
  return [x / l, y / l, z / l, w / l];
}
