// Coil springs drawn between two moving points, built entirely in the vertex shader: a tube
// template (u along the spring, psi around the wire) is wound into a helix about the line from
// p0 to p1, so a spring stretches and turns with its bodies without any CPU work. The ends
// taper onto the axis so the wire meets its anchors.

import { abs, cos, cross, float, length, max, normalize, positionGeometry, select, sin, smoothstep, transformNormalToView, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { LOOK } from './look.ts';

type Vec3 = THREE.Node<'vec3'>;

const TURNS = 10;

/** The tube template: x = u in [0, 1] along the spring, y = psi around the wire. */
export function coilGeometry(turns = TURNS, perTurn = 20, around = 8): THREE.BufferGeometry {
  const along = turns * perTurn;
  const positions: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= along; i++) for (let j = 0; j <= around; j++) positions.push(i / along, (2 * Math.PI * j) / around, 0);
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const a = i * (around + 1) + j;
      const b = a + around + 1;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return geometry;
}

/** A steel material winding the template between `p0` and `p1` (world space, per instance). */
export function coilMaterial(p0: Vec3, p1: Vec3, radius = 0.28, wire = 0.045, turns = TURNS): THREE.MeshStandardNodeMaterial {
  const u = positionGeometry.x;
  const psi = positionGeometry.y;
  const d = p1.sub(p0);
  const dir = d.div(max(length(d), float(1e-4)));
  const up = select(abs(dir.z).lessThan(0.9), vec3(0, 0, 1), vec3(1, 0, 0));
  const e1 = normalize(cross(dir, up));
  const e2 = cross(dir, e1);
  const phi = u.mul(2 * Math.PI * turns);
  const radial = e1.mul(cos(phi)).add(e2.mul(sin(phi)));
  const taper = smoothstep(float(0), float(0.05), u).mul(smoothstep(float(0), float(0.05), float(1).sub(u)));
  const centre = p0.add(d.mul(u)).add(radial.mul(taper.mul(radius)));
  const normal = radial.mul(cos(psi)).add(dir.mul(sin(psi)));

  const material = new THREE.MeshStandardNodeMaterial({ color: LOOK.spring, roughness: 0.32, metalness: 0.35 });
  material.positionNode = centre.add(normal.mul(wire));
  material.normalNode = transformNormalToView(normal);
  return material;
}
