// Run: node --experimental-transform-types examples/static-projectile.ts
import { StaticQueryScene, boxMesh, type Vec3 } from '../src/lib/queries.ts';
const scene = new StaticQueryScene();
scene.addMesh({ ...boxMesh([.02, 4, 4]), position: [5, 1, 0] });
scene.addMesh({ ...boxMesh([.02, 4, 3]), position: [5, 1, 2], rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] });
let center: Vec3 = [0, 1, 0];
const translation: Vec3 = [120 / 60, 0, 0];
for (let tick = 0; tick < 60; tick++) {
  const result = scene.sweepSphere({ center, radius: .025, translation });
  if (result.status === 'hit') {
    console.log('First static hit', { tick, ...result.hit });
    break;
  }
  center = center.map((v, i) => v + translation[i]) as Vec3;
}
scene.destroy();
