// Convex hulls for the GPU hull shape (../src/avbd3d/hull.ts): topology, planar faces merged,
// mass properties and the principal frame.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convexHull } from '../src/avbd3d/hull.ts';

const close = (a: number, b: number, eps = 1e-5) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

function box(w: number, h: number, d: number): number[] {
  const out: number[] = [];
  for (const x of [-w / 2, w / 2]) for (const y of [-h / 2, h / 2]) for (const z of [-d / 2, d / 2]) out.push(x, y, z);
  return out;
}

test('a box: six quad faces, twelve edges, its volume and moments', () => {
  const h = convexHull([...box(2, 1, 0.5), 0, 0, 0, 0.3, 0.1, 0.1])!;
  assert.equal(h.faces.length, 6);
  assert.ok(h.faces.every((f) => f.verts.length === 4));
  assert.equal(h.edges.length, 12);
  assert.equal(h.vertices.length, 8 * 3);
  close(h.volume, 1);
  const m = [...h.moments].sort((a, b) => a - b);
  // Per unit density: (b² + c²)/12 · V
  close(m[0], (1 + 0.25) / 12, 1e-6);
  close(m[1], (4 + 0.25) / 12, 1e-6);
  close(m[2], (4 + 1) / 12, 1e-6);
  close(h.radius, Math.hypot(1, 0.5, 0.25));
});

test('every face is a plane with all vertices behind it, and each edge joins two faces', () => {
  const points: number[] = [];
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < 200; i++) points.push(rnd() * 1.5 + 3, rnd() * 0.7 - 2, rnd());
  const h = convexHull(points)!;
  for (const f of h.faces) {
    close(Math.hypot(...f.normal), 1);
    for (let i = 0; i < h.vertices.length; i += 3) {
      assert.ok(f.normal[0] * h.vertices[i] + f.normal[1] * h.vertices[i + 1] + f.normal[2] * h.vertices[i + 2] <= f.d + 1e-5);
    }
  }
  // Euler: V - E + F = 2
  assert.equal(h.vertices.length / 3 - h.edges.length + h.faces.length, 2);
  for (const [a, b, f, g] of h.edges) {
    assert.ok(h.faces[f].verts.includes(a) && h.faces[f].verts.includes(b));
    assert.ok(h.faces[g].verts.includes(a) && h.faces[g].verts.includes(b));
  }
});

test('the principal frame maps back onto the input points', () => {
  // A box turned 30° about z and moved: the frame's rotation and centre undo that
  const angle = Math.PI / 6;
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const src = box(3, 1, 0.4);
  const turned: number[] = [];
  for (let i = 0; i < src.length; i += 3) turned.push(c * src[i] - s * src[i + 1] + 1, s * src[i] + c * src[i + 1] - 2, src[i + 2] + 0.5);
  const h = convexHull(turned)!;
  assert.deepEqual(h.center.map((v) => Math.round(v * 1e6) / 1e6), [1, -2, 0.5]);
  const sizes = [...h.size].sort((a, b) => a - b);
  close(sizes[0], 0.4, 1e-5);
  close(sizes[1], 1, 1e-5);
  close(sizes[2], 3, 1e-5);
  const [x, y, z, w] = h.rotation;
  const rotate = (v: number[]) => {
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
  };
  // Every local vertex, rotated and moved back, is one of the input corners
  for (let i = 0; i < h.vertices.length; i += 3) {
    const p = rotate([h.vertices[i], h.vertices[i + 1], h.vertices[i + 2]]).map((v, k) => v + h.center[k]);
    let nearest = Infinity;
    for (let j = 0; j < turned.length; j += 3) nearest = Math.min(nearest, Math.hypot(p[0] - turned[j], p[1] - turned[j + 1], p[2] - turned[j + 2]));
    assert.ok(nearest < 1e-5);
  }
});

test('flat and tiny point sets have no hull', () => {
  assert.equal(convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0]), null);
  assert.equal(convexHull([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0.5, 0.5, 0]), null);
});

test('points on a few planes (a fracture piece: many on each cut and face) make a closed hull', () => {
  // A cube corner cut by a slanted plane, with many points on every face
  const points: number[] = [];
  let s = 11;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const inside = (x: number, y: number, z: number) => x + y + z <= 1.6;
  for (let k = 0; k < 400; k++) {
    const face = k % 4;
    const [u, v] = [rnd(), rnd()];
    const p = face === 0 ? [0, u, v] : face === 1 ? [u, 0, v] : face === 2 ? [u, v, 0] : [u, v, 1.6 - u - v];
    if (face === 3 ? p[2] >= 0 && p[2] <= 1 : inside(p[0], p[1], p[2])) points.push(p[0], p[1], p[2]);
  }
  for (const c of [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0.6, 0], [0.6, 1, 0], [1, 0, 0.6], [0, 1, 0.6], [0.6, 0, 1], [0, 0.6, 1]]) points.push(...c);
  const h = convexHull(points)!;
  assert.equal(h.vertices.length / 3 - h.edges.length + h.faces.length, 2);
  assert.equal(h.faces.length, 7);        // three cube faces, three more, and the cut
  // The unit cube minus the corner x + y + z > 1.6: with a = 1 - x (…), the simplex a + b + c < 1.4
  // less the three bits of it beyond a face (a > 1): 1.4³/6 - 3 · 0.4³/6
  close(h.volume, 1 - (1.4 ** 3 - 3 * 0.4 ** 3) / 6, 1e-4);
});
