import assert from 'node:assert/strict';
import { NO_COLOR } from '../src/avbd2d/gpu/layout.ts';
import { GpuSolver3D } from '../src/avbd3d/gpu/solver.ts';
import { Rigid } from '../src/avbd3d/ref/body.ts';
import { Solver } from '../src/avbd3d/ref/solver.ts';
import { gpuTest } from './device.ts';

// The fused tail against the per-colour dispatches, with contacts in the tail colours (the other
// fusion tests' bodies only have joints). Boxes land on the ground apart from each other, so any
// colours are a proper colouring. `colorOf` puts them in the tail one per colour (single chunks),
// all in one tail colour (several chunks), or below the tail (the control: a colour cap of 16 leaves
// fusion inactive, so both sides run `primal`).
for (const [name, colorOf] of [
  ['control below the tail', (i: number) => i % 16],
  ['one body per tail colour', (i: number) => 16 + i % 48],
  ['one tail colour, several chunks', () => 20],
] as const) {
  gpuTest(`sparse color fusion preserves contact states: ${name}`, async device => {
    const count = 40;
    const make = (fuse: boolean) => {
      const ref = new Solver();
      new Rigid(ref, [200, 20, 1], 0, 0.5, [0, 0, -0.5]);
      for (let i = 0; i < count; i++) {
        new Rigid(ref, [0.3 + 0.01 * (i % 7), 0.2 + 0.013 * (i % 5), 0.25 + 0.017 * (i % 3)], 1, 0.5,
          [i * 2 - count, (i % 4) * 0.7 - 1, 0.3 + 0.05 * (i % 6)], [0.4 * ((i % 5) - 2), 0.3 * ((i % 3) - 1), -1 - 0.2 * (i % 4)]);
      }
      const gpu = new GpuSolver3D(device, ref, { spatialSort: false });
      gpu.fuseSparseColors = fuse;
      gpu.fixedColors = Uint32Array.from({ length: count + 1 }, (_, i) => i === 0 ? NO_COLOR : colorOf(i - 1));
      return gpu;
    };
    const normal = make(false), fused = make(true);
    try {
      let contacts = 0;
      for (let step = 0; step < 90; step++) {
        normal.step(); fused.step();
        const a = await normal.readBodies(), b = await fused.readBodies();
        const fa = new Float32Array(a.buffer, a.byteOffset, a.byteLength / 4), fb = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
        let differing = 0, worst = 0, first = -1;
        for (let k = 0; k < fa.length; k++) if (!Object.is(fa[k], fb[k])) { differing++; worst = Math.max(worst, Math.abs(fa[k] - fb[k])); if (first < 0) first = k; }
        contacts = Math.max(contacts, (await normal.readCounters()).contacts);
        assert.equal(differing, 0, `step ${step}: ${differing} of ${fa.length} floats differ, first at float ${first}, largest difference ${worst}`);
      }
      assert.ok(contacts >= count, `fixture needs contacts (most at once: ${contacts})`);
    } finally { normal.destroy(); fused.destroy(); }
  });
}
