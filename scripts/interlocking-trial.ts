// Bounded interlocking-sculpture diagnostic trial, one engine per invocation (STE-3282).
//   node --experimental-transform-types --no-warnings scripts/interlocking-trial.ts --engine rapier [--pieces 16|32|64] [--steps 240] [--json out.json]
//   node --experimental-transform-types --no-warnings scripts/interlocking-trial.ts --engine avbd   [--steps 240] [--json out.json]
// Not a benchmark: no speed ratio, winner or FPS. AVBD needs a real hardware adapter (Node + Dawn, no
// browser, no rendering); fallback, software and unidentified adapters are refused, with no override.
// Exit codes: 0 completed · 1 trial failed (report emitted) · 2 usage/input refusal · 3 GPU refusal/unavailable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  assessAdapter, createAvbdTrialEngine, createRapierTrialEngine, parseTrialArgs, runInterlockingTrial, sanitizeMessage,
  TRIAL_SCHEMA, TrialRefusal, validateTrialConfig, type AdapterRecord, type TrialEngine,
} from '../src/comparison/interlocking-trial.ts';
import { gitProvenance } from './git-provenance.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// Dawn's native runner can keep Node alive after release
function exit(code: number): never { process.exit(code); }

let parsed: ReturnType<typeof parseTrialArgs>;
try { parsed = parseTrialArgs(process.argv.slice(2)); } catch (e) {
  console.error(sanitizeMessage(e)); exit(e instanceof TrialRefusal ? 2 : 1);
}
if (parsed.help) { console.log('Usage: interlocking-trial --engine rapier|avbd [--pieces 16|32|64 (rapier)] [--steps 121..720 (default 240)] [--json <new file>]'); exit(0); }
const { config: rawConfig, json } = parsed;
const config = validateTrialConfig(rawConfig); // validated again here: nothing is acquired before this succeeds
if (json && existsSync(json)) { console.error('Refused: --json target already exists; reports never overwrite files'); exit(2); }

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; devDependencies: Record<string, string> };
const source = { package: { name: pkg.name, version: pkg.version }, git: gitProvenance(root),
  declaredDependencies: Object.fromEntries(['three', '@dimforge/rapier3d-compat', 'typescript', 'webgpu'].map(k => [k, pkg.devDependencies[k] ?? null])) };
const environment: Record<string, unknown> = { runtime: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model ?? null,
  backend: config.engine === 'avbd' ? 'Node + Dawn (webgpu binding); no browser, no rendering' : 'Node, Rapier WASM only; no GPU device, no rendering' };

async function emit(report: object) {
  const text = JSON.stringify(report, null, 2) + '\n';
  if (json) { writeFileSync(json, text, { flag: 'wx' }); console.error('Saved report (new file; never overwritten)'); } else await new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); });
}

// Dawn instance/adapter/device stay reachable for the whole process (see tests-gpu/device.ts):
// a collected instance leaves pending native callbacks polling freed memory.
const keep: unknown[] = [];
(globalThis as { __interlockingTrialDawn?: unknown }).__interlockingTrialDawn = keep;
let device: GPUDevice | undefined, code = 0, reportEmitted = false;
const gpuErrors: string[] = [];
try {
  let acquire: (c: typeof config) => Promise<TrialEngine>;
  if (config.engine === 'rapier') acquire = c => createRapierTrialEngine(c.pieces!);
  else {
    const { create, globals } = await import('webgpu');
    Object.assign(globalThis, globals);
    const gpu = create([]); keep.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new TrialRefusal('gpu', 'No WebGPU adapter available: AVBD trial not run');
    keep.push(adapter);
    const assessment = assessAdapter((adapter as { info?: unknown }).info, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
    if (!assessment.ok) {
      await emit({ schema: TRIAL_SCHEMA, status: 'refused', diagnostic: true, benchmark: false, source, environment, config,
        refusal: { code: 'gpu', reason: assessment.reason, adapter: assessment.record }, workloadRun: false });
      console.error(`Refused: ${assessment.reason}`); exit(3);
    }
    const record: AdapterRecord = (assessment as { record: AdapterRecord }).record;
    // No optional feature is required; storage limits are raised to the adapter's own, as in tests-gpu/device.ts.
    device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize, maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } });
    keep.push(device);
    const d = device;
    d.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
    void d.lost.then(info => { if (info.reason !== 'destroyed') gpuErrors.push(`Device lost: ${info.message}`); });
    environment.adapter = record; environment.limits = { maxBufferSize: d.limits.maxBufferSize, maxStorageBufferBindingSize: d.limits.maxStorageBufferBindingSize,
      maxStorageBuffersPerShaderStage: d.limits.maxStorageBuffersPerShaderStage };
    acquire = () => createAvbdTrialEngine(d, { adapter: record, completeGpu: () => d.queue.onSubmittedWorkDone(),
      check: () => { if (gpuErrors.length) throw new Error(`GPU error: ${gpuErrors[0]}`); } });
  }
  const report = await runInterlockingTrial(rawConfig, acquire, { source, environment }); // raw input: the runner validates it itself
  await emit({ ...report, ...(gpuErrors.length ? { uncapturedGpuErrors: gpuErrors.map(m => sanitizeMessage(m)) } : {}) });
  reportEmitted = true;
  const bad = report.status !== 'completed' || gpuErrors.length > 0;
  if (report.error) console.error(`Trial failed in ${report.error.phase} after ${report.error.step} steps: ${report.error.message}`);
  else if (gpuErrors.length) console.error('Uncaptured GPU errors were recorded');
  code = bad ? 1 : 0;
} catch (e) {
  if (config.engine === 'avbd' && !reportEmitted) {
    try { await emit({ schema: TRIAL_SCHEMA, status: e instanceof TrialRefusal ? 'refused' : 'failed', diagnostic: true, benchmark: false,
      source, environment, config, error: { message: sanitizeMessage(e) }, workloadRun: false });
    } catch (outputError) { console.error(`Report output failed: ${sanitizeMessage(outputError)}`); }
  }
  console.error(sanitizeMessage(e));
  code = e instanceof TrialRefusal ? (e.code === 'gpu' ? 3 : 2) : 1;
} finally {
  // The script owns the device; the model/runner never destroys it.
  try { device?.destroy(); } catch (e) { console.error(`Device cleanup failed: ${sanitizeMessage(e)}`); code ||= 1; }
}
exit(code);
