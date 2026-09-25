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
export function convexHull(points: ArrayLike<number>): HullShape | null {
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
  const tol = Math.max(scale, 1e-9) * 1e-7;

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
  for (let i = 0; i < p.length; i++) {
    if (used.has(i)) continue;
    const visible = tris.filter((t) => dot(t.n, p[i]) - t.d > tol);
    if (!visible.length) continue;
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

  // Merge coplanar neighbours into polygon faces: a box's face is one quad, not two triangles
  const edgeTri = new Map<string, number>();
  tris.forEach((t, k) => {
    for (let j = 0; j < 3; j++) edgeTri.set(`${t.v[j]},${t.v[(j + 1) % 3]}`, k);
  });
  const group = tris.map((_, k) => k);
  const find = (k: number): number => (group[k] === k ? k : (group[k] = find(group[k])));
  const planeTol = Math.max(scale, 1e-9) * 1e-5;
  tris.forEach((t, k) => {
    for (let j = 0; j < 3; j++) {
      const other = edgeTri.get(`${t.v[(j + 1) % 3]},${t.v[j]}`);
      if (other === undefined) continue;
      const u = tris[other];
      if (dot(t.n, u.n) > 1 - 1e-6 && Math.abs(t.d - u.d) < planeTol) group[find(k)] = find(other);
    }
  });
  const groups = new Map<number, number[]>();
  tris.forEach((_, k) => {
    const g = find(k);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(k);
  });

  const polys: Array<{ n: V3; verts: number[] }> = [];
  for (const members of groups.values()) {
    const inGroup = new Set<string>();
    for (const k of members) for (let j = 0; j < 3; j++) inGroup.add(`${tris[k].v[j]},${tris[k].v[(j + 1) % 3]}`);
    const next = new Map<number, number>();
    for (const k of members) {
      for (let j = 0; j < 3; j++) {
        const a = tris[k].v[j];
        const b = tris[k].v[(j + 1) % 3];
        if (!inGroup.has(`${b},${a}`)) next.set(a, b);
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
    // Drop vertices where the boundary runs straight on (they are no corner of the polygon)
    const corners = loop.filter((v, k) => {
      const a = p[loop[(k + loop.length - 1) % loop.length]];
      const b = p[loop[(k + 1) % loop.length]];
      return len(cross(sub(p[v], a), sub(b, p[v]))) > tol * Math.max(len(sub(b, a)), tol);
    });
    polys.push({ n: [n[0] / l, n[1] / l, n[2] / l], verts: corners.length >= 3 ? corners : loop });
  }

  // Keep the vertices the faces use
  const index = new Map<number, number>();
  const verts: V3[] = [];
  for (const poly of polys) for (const v of poly.verts) if (!index.has(v)) { index.set(v, verts.length); verts.push(p[v]); }
  for (const poly of polys) poly.verts = poly.verts.map((v) => index.get(v)!);

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
