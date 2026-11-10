// Opt-in same-device determinism probe through the public World (STE-3003, roadmap F1, first slice). Node + Dawn, no browser,
// no rendering. Two Worlds one after the other on one device this process owns, fixed storage, no readback between steps,
// one final World.read() each, compared bit for bit on the public fields docs/WORLD_DETERMINISM.md lists.
//
//   node --experimental-transform-types --no-warnings tools/world-determinism.ts [--steps 240] [--bodies 16] [--pacing sync|yield] [--json <new file>.json]
//
// Needs a real hardware adapter: fallback, software and unidentified adapters are refused, with no override. The report
// goes to stdout, or to the --json file (a new file only, never overwritten). It holds no local path and no shader text.
// A mismatch is evidence: nothing here loosens the comparison or changes a solver setting.
// Exit codes: 0 matched · 1 failed (report emitted when possible) · 2 usage/input refusal (before any GPU module is requested)
//             3 GPU refusal/unavailable (report emitted) · 4 completed with a mismatch (report emitted).
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessAdapter, sanitizeMessage, type AdapterRecord } from '../src/comparison/interlocking-trial.ts';
import { gitProvenance } from '../scripts/git-provenance.ts';
import { finalizeProbeReport, parseProbeArgs, ProbeRefusal, refusedReport, runWorldDeterminism, USAGE, type ProbeConfig, type ProbeHost, type ProbeReport, type ProbeWorld, type WorldSetup } from './world-determinism-core.ts';

export { USAGE };

/** The output target must be a new file in an existing directory. Nothing is created here; the write itself uses `wx` as well. */
export function checkOutputTarget(out: string): void {
  let existing = false;
  try { lstatSync(out); existing = true; } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw new ProbeRefusal('input', '--json cannot be inspected'); }
  if (existing) throw new ProbeRefusal('input', '--json target already exists; reports never overwrite files');
  try { if (!statSync(dirname(out)).isDirectory()) throw new Error('not a directory'); } catch { throw new ProbeRefusal('input', "--json's directory does not exist"); }
}

/** Makes real Worlds on the caller's device. Returning them as ProbeWorld is the compile-time check that the public World satisfies the probe's structural view of it. */
export async function worldFactory(device: GPUDevice): Promise<(setup: WorldSetup) => Promise<ProbeWorld>> {
  const { World } = await import('../src/lib/index.ts');
  return async (setup) => World.create({ device, maxBodies: setup.maxBodies, dt: setup.dt, iterations: setup.iterations, gravity: [...setup.gravity], storage: setup.storage });
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Dawn's native runner can keep Node alive after release
  const exit = (code: number): never => process.exit(code);
  let parsed: ReturnType<typeof parseProbeArgs>;
  try { parsed = parseProbeArgs(process.argv.slice(2)); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof ProbeRefusal ? 2 : 1); }
  if (parsed.help) { console.log(USAGE); return exit(0); }
  const { config, json } = parsed;
  if (json !== undefined) {
    try { checkOutputTarget(json); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof ProbeRefusal ? 2 : 1); }
  }
  // Everything above refuses before the GPU module is requested.

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; devDependencies: Record<string, string> };
  let installedWebgpu: string | null = null;
  try { installedWebgpu = (JSON.parse(readFileSync(new URL('../node_modules/webgpu/package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null; } catch { /* not installed */ }
  const source = { package: { name: pkg.name, version: pkg.version }, git: gitProvenance(root),
    declaredDependencies: Object.fromEntries(['three', 'typescript', 'webgpu'].map(k => [k, pkg.devDependencies[k] ?? null])) };
  const environment: Record<string, unknown> = { runtime: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model ?? null,
    backend: 'Node + Dawn (webgpu binding); no browser, no rendering', webgpu: installedWebgpu };

  const emit = async (report: ProbeReport) => {
    const text = JSON.stringify(report, null, 2) + '\n';
    if (json !== undefined) { writeFileSync(json, text, { flag: 'wx' }); console.error('Saved report (new file; never overwritten)'); }
    else await new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); });
  };

  // Dawn instance/adapter/device stay reachable through cleanup (see tests-gpu/device.ts): a collected instance leaves pending native callbacks polling freed memory.
  const keep: unknown[] = [];
  (globalThis as { __worldDeterminismDawn?: unknown }).__worldDeterminismDawn = keep;
  const gpuErrors: string[] = [];
  let device: GPUDevice | undefined, code = 0, report: ProbeReport | undefined;
  const teardownErrors: string[] = [];
  try {
    const refuse = async (reason: string, record: AdapterRecord | null) => {
      await emit(refusedReport(reason, { source, environment: { ...environment, adapter: record }, config, now: new Date() }));
      console.error(`Refused: ${reason}`); return exit(3);
    };
    let create: (typeof import('webgpu'))['create'], globals: (typeof import('webgpu'))['globals'];
    try { ({ create, globals } = await import('webgpu')); } catch { return await refuse('The webgpu (Dawn) package could not be loaded: nothing ran', null); }
    Object.assign(globalThis, globals);
    const gpu = create([]); keep.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) return await refuse('No WebGPU adapter available: nothing ran', null);
    keep.push(adapter);
    // assessAdapter reads vendor/architecture/device/description by name: GPUAdapterInfo accessors are not enumerable
    const assessment = assessAdapter((adapter as { info?: unknown }).info, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
    if (!assessment.ok) return await refuse(`${assessment.reason}: nothing ran`, assessment.record);
    // No optional feature is required; storage limits are raised to the adapter's own, as in tests-gpu/device.ts.
    const requiredLimits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage };
    device = await adapter.requestDevice({ requiredLimits });
    keep.push(device);
    const d = device;
    d.addEventListener('uncapturederror', e => gpuErrors.push(e.error.message));
    void d.lost.then(info => { if (info.reason !== 'destroyed') gpuErrors.push(`Device lost: ${info.message}`); });
    environment.adapter = assessment.record;
    environment.requiredFeatures = [];
    environment.requiredLimits = requiredLimits;

    const make = await worldFactory(d);
    const host: ProbeHost = {
      createWorld: setup => make(setup),
      settle: () => d.queue.onSubmittedWorkDone(),
      check: () => { if (gpuErrors.length) throw new Error(`GPU error: ${gpuErrors[0]}`); },
      yieldTurn: () => new Promise<void>(resolve => setImmediate(resolve)),
      now: () => new Date(),
    };
    report = await runWorldDeterminism(config satisfies ProbeConfig, host, { source, environment });
  } catch (e) {
    console.error(sanitizeMessage(e));
    code = e instanceof ProbeRefusal ? (e.code === 'gpu' ? 3 : 2) : 1;
  } finally {
    // The runner destroyed every World it made; finish the owned device before publishing a result.
    if (device) {
      try { await device.queue.onSubmittedWorkDone(); } catch (e) { teardownErrors.push(`Device drain failed: ${sanitizeMessage(e)}`); }
      try { device.destroy(); await device.lost; } catch (e) { teardownErrors.push(`Device cleanup failed: ${sanitizeMessage(e)}`); }
    }
  }
  if (report) {
    report = finalizeProbeReport(report, gpuErrors, teardownErrors);
    try { await emit(report); } catch (e) { console.error(`Report output failed: ${sanitizeMessage(e)}`); return exit(1); }
    if (report.error) console.error(`Probe failed in ${report.error.phase}${report.error.run === null ? '' : ` (run ${report.error.run})`}: ${report.error.message}`);
    else console.error(report.verdict);
    code = report.status === 'failed' ? 1 : report.status === 'mismatch' ? 4 : 0;
  } else if (teardownErrors.length) {
    teardownErrors.forEach(e => console.error(e));
    code ||= 1;
  }
  return exit(code);
}

// Importable for tests; runs only when this file is the entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
