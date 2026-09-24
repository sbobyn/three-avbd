// In-browser GPU benchmark for the 3D solver: the suite in ../avbd3d/bench-cases.ts, timed on
// this machine's GPU, with results to copy back. Meant for measuring the target hardware (M1,
// GTX 1080) directly instead of extrapolating from the development machine.

import { BENCH_CASES, type BenchReport, type BenchResult, measureCase, type Tier } from '../avbd3d/bench-cases.ts';
import { PHASES } from '../avbd3d/gpu/solver.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const log = (text: string) => ($('#status').textContent = text);
const results: BenchResult[] = [];

interface Gpu {
  adapter: GPUAdapter;
  info: string;
}

async function getAdapter(): Promise<Gpu> {
  if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  const i = adapter.info;
  return { adapter, info: [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' · ') || 'unknown adapter' };
}

/**
 * A fresh adapter and device per case (an adapter makes one device), so a case that runs out of
 * memory and loses its device cannot sink the rest.
 */
async function device(): Promise<GPUDevice> {
  const { adapter } = await getAdapter();
  const requiredFeatures = (['timestamp-query'] as GPUFeatureName[]).filter((f) => adapter.features.has(f));
  const requiredLimits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize };
  return adapter.requestDevice({ requiredFeatures, requiredLimits });
}

const ms = (v: number | undefined) => (v === undefined || Number.isNaN(v) ? '—' : v.toFixed(2));

function render(info: string): void {
  const rows = results
    .map((r) => {
      const phases = PHASES.map((p) => ms(r.gpu?.[p])).join('</td><td>');
      const row = `<tr><td>${r.scene}</td><td>${r.iterations}</td><td>${r.bodies}</td><td>${r.joints}</td><td>${r.contacts}</td><td>${r.colors}</td><td><b>${ms(r.wallMs)}</b></td><td>${ms(r.gpu?.total)}</td><td>${phases}</td><td>${(r.gpuBytes / 2 ** 20).toFixed(0)}</td><td>${r.paper ?? ''}</td></tr>`;
      return r.error ? `${row}<tr><td class="error" colspan="${11 + PHASES.length}">${r.error}</td></tr>` : row;
    })
    .join('');
  $('#results').innerHTML =
    `<p class="adapter">${info}</p><table><thead><tr><th>scene</th><th>iters</th><th>bodies</th><th>joints</th><th>contacts</th><th>colours</th>` +
    `<th>wall ms/step</th><th>GPU ms</th>${PHASES.map((p) => `<th>${p}</th>`).join('')}<th>GPU MB</th><th>paper, RTX 4090</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function run(): Promise<void> {
  $<HTMLButtonElement>('#run').disabled = true;
  results.length = 0;
  let gpu: Gpu | null = null;
  let timestamps = false;
  try {
    gpu = await getAdapter();
    timestamps = gpu.adapter.features.has('timestamp-query');
    const tiers = [...document.querySelectorAll<HTMLInputElement>('input[name=tier]:checked')].map((e) => e.value as Tier);
    for (const c of BENCH_CASES.filter((c) => tiers.includes(c.tier))) {
      const dev = await device();
      results.push(await measureCase(dev, c, log));
      dev.destroy();
      render(gpu.info);
    }
    log(`Done.${timestamps ? '' : ' No timestamp-query on this device: GPU phase times unavailable (wall times are still valid).'}`);
  } catch (e) {
    log(`Failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  $<HTMLButtonElement>('#run').disabled = false;
  $<HTMLButtonElement>('#copy').disabled = $<HTMLButtonElement>('#download').disabled = results.length === 0;
  const report = (): BenchReport => ({
    machine: $<HTMLInputElement>('#machine').value.trim() || gpu?.info || 'unknown machine',
    adapter: gpu?.info ?? 'unknown adapter',
    source: navigator.userAgent,
    date: new Date().toISOString().slice(0, 10),
    timestamps,
    results,
  });
  $<HTMLButtonElement>('#copy').onclick = () => {
    void navigator.clipboard.writeText(JSON.stringify(report(), null, 1)).then(() => log('Results copied to the clipboard.'));
  };
  $<HTMLButtonElement>('#download').onclick = () => {
    const r = report();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${JSON.stringify(r, null, 1)}\n`], { type: 'application/json' }));
    a.download = `${r.machine.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'results'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    log(`Saved ${a.download}: put it in docs/data/bench3d/ and it shows up on results.html.`);
  };
}

$<HTMLButtonElement>('#run').onclick = () => void run();
