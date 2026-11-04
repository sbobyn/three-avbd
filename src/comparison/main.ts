import { CASES } from './scenes.ts';
import { comparisonDevice, DEFAULTS, runComparison } from './run.ts';

const run = document.querySelector<HTMLButtonElement>('#run')!;
const download = document.querySelector<HTMLButtonElement>('#download')!;
const status = document.querySelector<HTMLElement>('#status')!;
const output = document.querySelector<HTMLElement>('#output')!;
const select = document.querySelector<HTMLSelectElement>('#case')!;
for (const name of CASES) select.add(new Option(name, name));
let json = '';
run.onclick = async () => {
  run.disabled = true;
  download.disabled = true;
  output.textContent = '';
  let device: GPUDevice | undefined;
  let hidden = document.hidden;
  const visibility = () => { if (document.hidden) hidden = true; };
  document.addEventListener('visibilitychange', visibility);
  try {
    device = await comparisonDevice();
    const errors: string[] = [];
    device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
    void device.lost.then((info) => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.message}`); });
    const report = await runComparison(device, [select.value], { ...DEFAULTS,
      lead: Number(document.querySelector<HTMLInputElement>('#lead')!.value),
      dt: Number(document.querySelector<HTMLInputElement>('#dt')!.value),
      batchSize: Number(document.querySelector<HTMLInputElement>('#batch')!.value),
      avbdIterations: Number(document.querySelector<HTMLInputElement>('#avbd')!.value),
      rapierIterations: Number(document.querySelector<HTMLInputElement>('#rapier')!.value),
      steps: Number(document.querySelector<HTMLInputElement>('#steps')!.value),
      repeats: Number(document.querySelector<HTMLInputElement>('#repeats')!.value),
      rapierCcd: document.querySelector<HTMLInputElement>('#ccd')!.checked,
      rapierSleeping: document.querySelector<HTMLInputElement>('#sleep')!.checked,
    }, (message) => { status.textContent = message; }, () => {
      if (hidden) throw new Error('Tab was hidden: rerun with it visible');
      if (errors.length) throw new Error(errors.join('; '));
    });
    json = JSON.stringify({ ...report, environment: { userAgent: navigator.userAgent, adapter: device.adapterInfo,
      machine: document.querySelector<HTMLInputElement>('#machine')!.value || 'unspecified',
      maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
      build: __COMPARISON_BUILD__, backend: 'browser WebGPU / WASM; no rendering' } }, null, 2);
    const table = document.createElement('table');
    const header = table.insertRow();
    for (const label of ['Engine', 'Repeat', 'Bodies', 'Status', 'Mean ms/step', 'Batch p95 ms/step', 'Worst floor depth m', 'Floor target', 'Worst pair depth m', 'Contact target', 'Resting target', 'Peak joint error m', 'Peak trajectory error m', 'Peak spin error rad']) {
      const th = document.createElement('th'); th.textContent = label; header.append(th);
    }
    for (const r of report.results) {
      const row = table.insertRow();
      for (const value of [r.engine, r.repeat + 1, r.bodies, r.error ?? r.status,
        r.meanMs?.toFixed(3) ?? '—', r.p95Ms?.toFixed(3) ?? '—', r.worstQuality?.maxFloorPenetration.toFixed(5) ?? '—', r.floorTargetMet ?? 'unverified', r.maxContactDepth?.toFixed(5) ?? 'unmeasured', r.contactTargetMet ?? 'unmeasured', r.restingTargetMet ?? 'unmeasured', r.physical?.maxJointError.toFixed(5) ?? '—',
        r.physical?.maxTrajectoryError?.toFixed(5) ?? '—', r.physical?.maxAngularError?.toFixed(5) ?? '—']) {
        row.insertCell().textContent = String(value);
      }
    }
    output.append(table);
    download.disabled = false;
    status.textContent = 'Finished. Batched throughput; floor target alone does not establish matched physical accuracy.';
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  finally { device?.destroy(); document.removeEventListener('visibilitychange', visibility); run.disabled = false; }
};
download.onclick = () => {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'rapier-comparison.json'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
declare const __COMPARISON_BUILD__:
  | { source: 'git'; head: string; dirty: boolean }
  | { source: 'unknown'; head: null; dirty: null; reason: string };
