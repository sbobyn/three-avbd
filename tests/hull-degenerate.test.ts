// Convex hulls of degenerate point sets (../src/avbd3d/hull.ts): fracture pieces whose points are
// mostly on the piece's faces and edges, with clusters of nearly coincident corners, f32-rounded.
// Each hull runs in a worker with a deadline, so one that never finishes fails instead of hanging.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { convexHull, MAX_HULL_VERTICES, type HullShape } from '../src/avbd3d/hull.ts';

type V3 = [number, number, number];

async function hullsInWorker(sets: Float32Array[], deadlineMs: number): Promise<Array<{ hull: HullShape | null; ms: number }>> {
  const worker = new Worker(new URL('./helpers/hull-worker.ts', import.meta.url));
  try {
    const done = new Promise<Array<{ hull: HullShape | null; ms: number }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`convexHull did not finish within ${deadlineMs} ms`)), deadlineMs);
      worker.once('message', (r) => { clearTimeout(timer); resolve(r); });
      worker.once('error', (e) => { clearTimeout(timer); reject(e); });
    });
    worker.postMessage(sets);
    return await done;
  } finally {
    await worker.terminate();
  }
}

/** A point of the input frame in the hull's principal frame: Rᵀ(x - centre). */
function toLocal(h: HullShape, v: V3): V3 {
  const [x, y, z, w] = h.rotation;
  const d: V3 = [v[0] - h.center[0], v[1] - h.center[1], v[2] - h.center[2]];
  // Rotate by the conjugate (-x, -y, -z, w)
  const t: V3 = [2 * (-y * d[2] + z * d[1]), 2 * (-z * d[0] + x * d[2]), 2 * (-x * d[1] + y * d[0])];
  return [d[0] + w * t[0] + (-y * t[2] + z * t[1]), d[1] + w * t[1] + (-z * t[0] + x * t[2]), d[2] + w * t[2] + (-x * t[1] + y * t[0])];
}

/** A point of the principal frame in the input frame. */
function toInput(h: HullShape, v: V3): V3 {
  const [x, y, z, w] = h.rotation;
  const t: V3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]) + h.center[0], v[1] + w * t[1] + (z * t[0] - x * t[2]) + h.center[1], v[2] + w * t[2] + (x * t[1] - y * t[0]) + h.center[2]];
}

/** Greatest extent of the points' bounds, and greatest coordinate. */
function scaleOf(points: ArrayLike<number>): { extent: number; magnitude: number; box: number } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let magnitude = 0;
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], points[i + k]);
      hi[k] = Math.max(hi[k], points[i + k]);
      magnitude = Math.max(magnitude, Math.abs(points[i + k]));
    }
  }
  const e = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  return { extent: Math.max(...e), magnitude, box: e[0] * e[1] * e[2] };
}

/**
 * A closed convex polyhedron: unit normals, every vertex behind every face and those of the face on
 * it (to `eps`), V - E + F = 2, paired edges.
 */
function assertConvex(h: HullShape, eps: number, label: string): void {
  const n = h.vertices.length / 3;
  assert.ok(n >= 4 && n <= MAX_HULL_VERTICES, `${label}: ${n} vertices`);
  assert.ok(h.faces.length <= 255 && h.edges.length <= 255, label);
  assert.equal(n - h.edges.length + h.faces.length, 2, `${label}: Euler`);
  for (const f of h.faces) {
    assert.ok(Math.abs(Math.hypot(...f.normal) - 1) < 1e-6, label);
    for (let i = 0; i < h.vertices.length; i += 3) {
      const s = f.normal[0] * h.vertices[i] + f.normal[1] * h.vertices[i + 1] + f.normal[2] * h.vertices[i + 2] - f.d;
      assert.ok(s <= eps, `${label}: vertex ${i / 3} in front of a face by ${s}`);
      if (f.verts.includes(i / 3)) assert.ok(s >= -eps, `${label}: face not planar (${s})`);
    }
  }
  for (const [a, b, f, g] of h.edges) assert.ok(f !== g && h.faces[f].verts.includes(a) && h.faces[g].verts.includes(b), label);
  assert.ok(h.volume > 0 && h.moments.every((m) => m > 0), label);
}

/** Most any input point is in front of any face of the hull (input units). */
function outside(h: HullShape, points: ArrayLike<number>): number {
  let worst = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    const l = toLocal(h, [points[i], points[i + 1], points[i + 2]]);
    let s = -Infinity;
    for (const f of h.faces) s = Math.max(s, f.normal[0] * l[0] + f.normal[1] * l[1] + f.normal[2] * l[2] - f.d);
    worst = Math.max(worst, s);
  }
  return worst;
}

test('a Voronoi glass fragment (238 points, 4.8 × 3.8 × 3.9 cm) gives a hull, fast', async () => {
  // three-destruction's fracture piece that made the incremental hull grow past 131,000 triangles
  const points = new Float32Array(JSON.parse(readFileSync(new URL('./fixtures/hull-fracture-glass.json', import.meta.url), 'utf8')));
  assert.equal(points.length, 238 * 3);
  const [{ hull: h, ms }] = await hullsInWorker([points], 10_000);
  assert.ok(ms < 500, `${ms} ms`);
  assert.ok(h);
  const { extent, box } = scaleOf(points);
  assertConvex(h, 1e-6 * extent, 'fragment');
  // Every input point inside, to f32 rounding (no vertex was dropped by the 32-vertex limit)
  assert.ok(h.vertices.length / 3 < MAX_HULL_VERTICES);
  assert.ok(outside(h, points) <= 1e-6 * extent, `${outside(h, points)}`);
  // Its volume: inside its bounds, and most of a fragment this chunky
  assert.ok(h.volume < box && h.volume > 0.3 * box, `${h.volume} of ${box}`);
  assert.ok(h.size.every((s) => s <= 2 * extent));
});

/** Seeded uniform [0, 1). */
function random(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/**
 * A fracture-like piece: the hull of a few corners, its points mostly on its faces and edges, some
 * inside, exact duplicates and clusters of nearly coincident corners; any size, possibly flat and
 * far from the origin, f32-rounded. Also the clean hull it was made from, and how far the clusters
 * reach beyond it.
 */
function fractureCloud(rnd: () => number): { points: Float32Array; clean: HullShape; reach: number } {
  const scale = 10 ** (rnd() * 7 - 6); // 1 µm to 10 m
  const axes: V3 = [scale * (0.2 + 0.8 * rnd()), scale * (0.2 + 0.8 * rnd()), scale * (0.2 + 0.8 * rnd())];
  if (rnd() < 0.25) axes[Math.floor(rnd() * 3)] *= 10 ** (-1 - 2 * rnd()); // a plate, down to 1/1000 thick
  const offset: V3 = [0, 1, 2].map(() => (rnd() - 0.5) * 8 * scale) as V3;
  const corners: number[] = [];
  const count = 4 + Math.floor(rnd() * 9);
  for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) corners.push(offset[k] + (rnd() - 0.5) * axes[k]);
  const clean = convexHull(new Float32Array(corners))!;
  const verts: V3[] = [];
  for (let i = 0; i < clean.vertices.length; i += 3) verts.push(toInput(clean, [clean.vertices[i], clean.vertices[i + 1], clean.vertices[i + 2]]));
  const mix = (ws: number[], vs: V3[]): V3 => {
    const t = ws.reduce((a, b) => a + b, 0);
    return [0, 1, 2].map((k) => vs.reduce((a, v, j) => a + (ws[j] / t) * v[k], 0)) as V3;
  };
  const out: V3[] = [...verts];
  // On the faces (a fracture piece's triangulated cut faces)
  const onFaces = 20 + Math.floor(rnd() * 150);
  for (let i = 0; i < onFaces; i++) {
    const f = clean.faces[Math.floor(rnd() * clean.faces.length)];
    out.push(mix(f.verts.map(() => rnd() ** 3), f.verts.map((v) => verts[v])));
  }
  // On the edges, in line with the corners
  for (let i = 0, n = Math.floor(rnd() * 40); i < n; i++) {
    const [a, b] = clean.edges[Math.floor(rnd() * clean.edges.length)];
    const t = rnd();
    out.push(mix([t, 1 - t], [verts[a], verts[b]]));
  }
  // Inside
  for (let i = 0, n = Math.floor(rnd() * 30); i < n; i++) out.push(mix(verts.map(() => rnd() ** 4), verts));
  // Nearly coincident corners, 1e-9 to 1e-4 of the size apart
  let reach = 0;
  for (let i = 0, n = Math.floor(rnd() * 4); i < n; i++) {
    const v = verts[Math.floor(rnd() * verts.length)];
    for (let j = 0, m = 1 + Math.floor(rnd() * 3); j < m; j++) {
      const r = 10 ** (-9 + 5 * rnd()) * scale;
      reach = Math.max(reach, r);
      out.push([v[0] + (rnd() - 0.5) * r, v[1] + (rnd() - 0.5) * r, v[2] + (rnd() - 0.5) * r]);
    }
  }
  // Exact duplicates (split vertices)
  for (let i = 0, n = Math.floor(rnd() * 30); i < n; i++) out.push([...out[Math.floor(rnd() * out.length)]]);
  // Shuffled
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return { points: new Float32Array(out.flat()), clean, reach };
}

test('fracture-like point sets all finish, convex and containing their points', async () => {
  const rnd = random(20261102);
  const cases = Array.from({ length: 400 }, () => fractureCloud(rnd));
  const results = await hullsInWorker(cases.map((c) => c.points), 60_000);
  let contained = 0;
  results.forEach(({ hull: h, ms }, k) => {
    const { points, clean, reach } = cases[k];
    const label = `case ${k}`;
    assert.ok(ms < 1000, `${label}: ${ms} ms`);
    assert.ok(h, `${label}: no hull`);
    const { extent, magnitude, box } = scaleOf(points);
    // Triangles within 1e-5 of the distance from the origin of a plane merge into one face
    assertConvex(h, 2e-5 * Math.max(extent, magnitude), label);
    // Inside to the welding distance (1e-5 of the size, or of the distance from the origin)
    if (h.vertices.length / 3 < MAX_HULL_VERTICES) {
      contained++;
      const s = outside(h, points);
      assert.ok(s <= 2e-5 * Math.max(extent, magnitude), `${label}: a point ${s} outside (size ${extent})`);
    }
    // The piece's volume: at least that of its corners (to f32 rounding), at most that grown by
    // how far the clusters reach (a thin plate's can be a good part of its thickness)
    let area = 0;
    for (const f of clean.faces) {
      const v = f.verts.map((i) => [clean.vertices[3 * i], clean.vertices[3 * i + 1], clean.vertices[3 * i + 2]]);
      for (let j = 1; j + 1 < v.length; j++) {
        const a = [v[j][0] - v[0][0], v[j][1] - v[0][1], v[j][2] - v[0][2]];
        const b = [v[j + 1][0] - v[0][0], v[j + 1][1] - v[0][1], v[j + 1][2] - v[0][2]];
        area += Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]) / 2;
      }
    }
    assert.ok(h.volume <= box * (1 + 1e-3), `${label}: volume ${h.volume} beyond bounds ${box}`);
    assert.ok(h.volume >= clean.volume * 0.98, `${label}: volume ${h.volume} vs ${clean.volume}`);
    assert.ok(h.volume <= clean.volume * 1.02 + area * (reach + 2e-5 * Math.max(extent, magnitude)), `${label}: volume ${h.volume} vs ${clean.volume}`);
  });
  // The containment check above ran for nearly all (the rest were simplified to 32 vertices)
  assert.ok(contained > 0.9 * cases.length, `${contained} of ${cases.length}`);
});

test('point sets flat or in one place to within rounding finish: no hull, or a valid one', async () => {
  const rnd = random(77);
  const sets: Float32Array[] = [];
  for (let k = 0; k < 120; k++) {
    const scale = 10 ** (rnd() * 6 - 5);
    const out: number[] = [];
    const kind = k % 3;
    for (let i = 0; i < 50 + Math.floor(rnd() * 200); i++) {
      const u = rnd() - 0.5;
      const v = rnd() - 0.5;
      // A plane (tilted), a line, or a cluster, each off by up to 1e-8 of the size
      const off = (rnd() - 0.5) * 1e-8;
      const p: V3 = kind === 0 ? [u, v, 0.3 * u - 0.7 * v + off] : kind === 1 ? [u, 0.5 * u + off, -u + off] : [off, off * rnd(), off * rnd()];
      out.push(...p.map((x) => x * scale + 0.25 * scale));
      if (rnd() < 0.2) out.push(...out.slice(-3));
    }
    sets.push(new Float32Array(out));
  }
  const results = await hullsInWorker(sets, 60_000);
  results.forEach(({ hull: h, ms }, k) => {
    assert.ok(ms < 1000, `set ${k}: ${ms} ms`);
    if (h) {
      const { extent, magnitude } = scaleOf(sets[k]);
      assertConvex(h, 2e-5 * Math.max(extent, magnitude), `set ${k}`);
      assert.ok(outside(h, sets[k]) <= 2e-5 * Math.max(extent, magnitude), `set ${k}`);
    }
  });
});
