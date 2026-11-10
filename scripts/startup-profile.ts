// Startup / same-device recreate diagnostic probe, Node + Dawn (STE-3003, docs/STARTUP_PROFILING.md).
//   node --experimental-transform-types --no-warnings scripts/startup-profile.ts [--cycles 1..4 (default 4)] [--label node1] [--no-instrument] [--json <new file>]
// Not a benchmark. Needs a real hardware adapter; fallback, software and unidentified adapters are refused
// with no override. No rendering in Node: render phases are unavailable.
// Exit codes: 0 completed · 1 probe failed (report emitted) · 2 usage/input refusal · 3 GPU refusal/unavailable.
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assessAdapter, sanitizeMessage, type AdapterRecord } from '../src/comparison/interlocking-trial.ts';
import {
  instrumentDevice, parseStartupArgs, probeSettings, profileSequence, STARTUP_LIMITS, STARTUP_SCHEMA, StartupRefusal,
  statusOf, unavailable, validateStartupReport, type Instrumentation, type ProbeModel, type StartupReport,
} from '../src/comparison/startup-profile.ts';
import { gitProvenance } from './git-provenance.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
// Dawn's native runner can keep Node alive after release
function exit(code: number): never { process.exit(code); }

let args: ReturnType<typeof parseStartupArgs>;
try { args = parseStartupArgs(process.argv.slice(2)); } catch (e) {
  console.error(sanitizeMessage(e)); exit(e instanceof StartupRefusal ? 2 : 1);
}
if (args.help) { console.log('Usage: startup-profile [--cycles 1..4 (default 4)] [--label <name>] [--no-instrument] [--json <new file>]'); exit(0); }
if (args.json) {
  try {
    let exists = false;
    try { lstatSync(args.json); exists = true; } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw e; }
    if (exists) throw new Error('target exists');
    if (!statSync(dirname(args.json)).isDirectory()) throw new Error('missing directory');
  } catch { console.error('Refused: --json must be a new file in an existing directory'); exit(2); }
}

const now = () => performance.now();
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; devDependencies: Record<string, string> };
const source = { package: { name: pkg.name, version: pkg.version }, git: gitProvenance(root),
  declaredDependencies: Object.fromEntries(['three', 'webgpu', 'typescript', 'vite'].map(k => [k, pkg.devDependencies[k] ?? null])) };
const environment: Record<string, unknown> = {
  host: 'node-dawn', userAgent: null, userAgentData: unavailable('Node host'), runtime: process.version, platform: platform(),
  osRelease: release(), arch: arch(), cpu: cpus()[0]?.model ?? null,
  adapter: unavailable('not acquired'), backend: unavailable('Dawn binding does not report its native backend through WebGPU'),
  limits: unavailable('no device'), viewport: unavailable('Node host: no rendering'), visibility: unavailable('Node host'),
  crossOriginIsolated: null, observedTimerStepMs: null, serving: 'node',
};
const run = { label: args.label, navigationType: null, loadIndexInTab: null, orderInSequence: null, operatorNote: null, cacheState: 'unknown' as const };
const gpuErrors: string[] = [];
let deviceLost: string | null = null;

function report(status: StartupReport['status'], extra: Partial<StartupReport> = {}): StartupReport {
  return { schema: STARTUP_SCHEMA, status, diagnostic: true, benchmark: false, observedAt: new Date().toISOString(), source, environment,
    settings: probeSettings(null, args.cycles, args.instrument), run, cycles: [], uncapturedGpuErrors: gpuErrors.map(m => sanitizeMessage(m)),
    deviceLost, instrumentation: { requested: args.instrument, available: false, reason: args.instrument ? 'not installed' : 'disabled' },
    limits: STARTUP_LIMITS, ...extra };
}
async function emit(value: StartupReport) {
  const problems = validateStartupReport(value);
  const out = problems.length ? { ...value, status: 'failed' as const, validationProblems: problems } : value;
  const text = JSON.stringify(out, null, 2) + '\n';
  if (args.json) { writeFileSync(args.json, text, { flag: 'wx' }); console.error('Saved report (new file; never overwritten)'); }
  else await new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); });
  return problems.length === 0;
}

// Dawn instance/adapter/device stay reachable for the whole process (see tests-gpu/device.ts).
const keep: unknown[] = [];
(globalThis as { __startupProfileDawn?: unknown }).__startupProfileDawn = keep;
let device: GPUDevice | undefined, instrumentation: Instrumentation | null = null, code = 0;
let pendingReport: StartupReport | undefined;
const teardownErrors: string[] = [];
try {
  const { create, globals } = await import('webgpu').catch(() => { throw new StartupRefusal('webgpu (Dawn) unavailable: probe not run'); });
  Object.assign(globalThis, globals);
  const gpu = create([]); keep.push(gpu);
  let t = now();
  const adapter = await gpu.requestAdapter();
  const adapterMs = now() - t;
  if (!adapter) {
    environment.adapter = unavailable('no WebGPU adapter');
    throw new StartupRefusal('No WebGPU adapter available: probe not run');
  }
  keep.push(adapter);
  const info = (adapter as { info?: GPUAdapterInfo }).info;
  // Accessors read by name: GPUAdapterInfo fields are prototype getters, not own properties
  const infoRecord = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description,
    isFallbackAdapter: (info as { isFallbackAdapter?: boolean }).isFallbackAdapter } : undefined;
  const assessment = assessAdapter(infoRecord, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
  environment.adapter = assessment.record ?? unavailable('adapter info unavailable');
  if (!assessment.ok) {
    throw new StartupRefusal(assessment.reason);
  }
  const record: AdapterRecord = (assessment as { record: AdapterRecord }).record;
  environment.adapter = record;
  t = now();
  // No optional feature is required; storage limits raised to the adapter's own, as in tests-gpu/device.ts.
  device = await adapter.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize, maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage } });
  const deviceMs = now() - t;
  keep.push(device);
  const d = device;
  d.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
  void d.lost.then(info => { if (info.reason !== 'destroyed') deviceLost = sanitizeMessage(info.message); });
  environment.limits = { maxBufferSize: d.limits.maxBufferSize, maxStorageBufferBindingSize: d.limits.maxStorageBufferBindingSize,
    maxStorageBuffersPerShaderStage: d.limits.maxStorageBuffersPerShaderStage };
  instrumentation = args.instrument ? instrumentDevice(d, now) : null;
  let metadata: Record<string, unknown> | null = null;
  const cycles = await profileSequence(args.cycles, {
    now, drain: () => d.queue.onSubmittedWorkDone(),
    check: () => { if (gpuErrors.length) throw new Error(`GPU error: ${gpuErrors[0]}`); if (deviceLost) throw new Error(`Device lost: ${deviceLost}`); },
    instrumentation,
    importModel: async () => {
      const { createAvbdInterlocking } = await import('../src/comparison/interlocking-avbd.ts');
      return async (): Promise<ProbeModel> => { const m = await createAvbdInterlocking({ device: d }); metadata ??= { ...m.metadata }; return m; };
    },
  });
  const status = statusOf(cycles, args.cycles, gpuErrors, deviceLost);
  const firstError = cycles.find(c => c.error)?.error;
  pendingReport = report(status, {
    settings: probeSettings(metadata, args.cycles, args.instrument), cycles,
    environment: { ...environment, acquisitionMs: { adapter: { value: adapterMs }, device: { value: deviceMs } } },
    ...(firstError ? { error: firstError } : {}),
    instrumentation: { requested: args.instrument, available: instrumentation?.available ?? false,
      reason: !args.instrument ? 'disabled (--no-instrument)' : instrumentation && !instrumentation.available ? instrumentation.reason : null },
  });
  if (firstError) console.error(`Probe failed in ${firstError.phase}: ${firstError.message}`);
  code = status === 'completed' ? 0 : 1;
} catch (e) {
  pendingReport = report(e instanceof StartupRefusal ? 'refused' : 'failed', { error: { phase: 'acquire', message: sanitizeMessage(e) } });
  console.error(sanitizeMessage(e));
  code = e instanceof StartupRefusal ? 3 : 1;
} finally {
  // Models were disposed per cycle (World before device); the script owns and releases the device last.
  try { instrumentation?.restore(); } catch (e) { teardownErrors.push(`Instrumentation restore failed: ${sanitizeMessage(e)}`); }
  try { if (device) { device.destroy(); await device.lost; } } catch (e) { teardownErrors.push(`Device cleanup failed: ${sanitizeMessage(e)}`); }
}
pendingReport ??= report('failed', { error: { phase: 'acquire', message: 'Probe produced no result' } });
pendingReport.uncapturedGpuErrors = gpuErrors.map(m => sanitizeMessage(m));
pendingReport.deviceLost = deviceLost;
pendingReport.teardownErrors = teardownErrors;
if (gpuErrors.length || deviceLost || teardownErrors.length) { pendingReport.status = 'failed'; code = 1; }
try { if (!await emit(pendingReport)) code = 1; }
catch (e) { console.error(`Report output failed: ${sanitizeMessage(e)}`); code = 1; }
exit(code);
