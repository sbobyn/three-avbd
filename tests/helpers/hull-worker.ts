// convexHull off the test's thread, so a hull that never finishes fails the test (the parent
// terminates this worker at its deadline) instead of hanging the run.
import { parentPort } from 'node:worker_threads';
import { convexHull } from '../../src/avbd3d/hull.ts';

parentPort!.on('message', (sets: ArrayLike<number>[]) => {
  const results = sets.map((points) => {
    const start = performance.now();
    const hull = convexHull(points);
    return { hull, ms: performance.now() - start };
  });
  parentPort!.postMessage(results);
});
