// Robust GPU step timing for A/B comparisons. GPU clocks ramp and throttle, so single timings
// swing by ±50%: warm up, run many short batches with the queue drained, take the median per
// round, interleave the variants over several rounds, and report the best round per variant.

export interface Variant {
  name: string;
  /** Called before each batch of this variant (switch settings here). */
  apply(): void;
}

export async function compare(
  device: GPUDevice,
  step: () => void,
  variants: Variant[],
  { rounds = 5, batches = 7, perBatch = 15, warmup = 60 } = {},
): Promise<Record<string, number>> {
  for (let i = 0; i < warmup; i++) step();
  await device.queue.onSubmittedWorkDone();
  const best: Record<string, number> = {};
  for (let r = 0; r < rounds; r++) {
    for (const v of variants) {
      v.apply();
      for (let i = 0; i < 3; i++) step();
      await device.queue.onSubmittedWorkDone();
      const samples: number[] = [];
      for (let b = 0; b < batches; b++) {
        const t = performance.now();
        for (let i = 0; i < perBatch; i++) step();
        await device.queue.onSubmittedWorkDone();
        samples.push((performance.now() - t) / perBatch);
      }
      samples.sort((x, y) => x - y);
      const median = samples[samples.length >> 1];
      best[v.name] = Math.min(best[v.name] ?? Infinity, median);
    }
  }
  return best;
}
