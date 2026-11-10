// Opt-in S1 qualification harness v0 (STE-3354): rows Q1-Q3 of docs/QUALIFICATION_MATRIX.md through the existing comparison
// `runOne`, judged pass / fail / unknown per criterion. Node + Dawn for AVBD, plain CPU for Rapier. No browser, no rendering.
//
//   node --experimental-transform-types --no-warnings tools/qualification.ts [--rows Q1,Q2,Q3] [--engines avbd|rapier|avbd,rapier] [--configs A,B] [--json <new file>.json]
//
// No flag changes a scene, step count, iteration, capacity or threshold. AVBD needs a real hardware adapter: fallback, software
// and unidentified adapters are refused before any device is requested, with no override. The report goes to stdout or to the
// --json file (a new file only, never overwritten) and holds no local path. Verdicts are evidence: nothing here retunes anything.
// Exit codes: 0 completed (verdicts, in any mix, are in the report) · 1 execution failure (report emitted when possible)
//             2 usage/input refusal (before any GPU module is requested) · 3 GPU refusal/unavailable (report emitted).
import { lstatSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeMessage } from '../src/comparison/interlocking-trial.ts';
import { createAdapter } from '../src/comparison/adapters.ts';
import { makeScene } from '../src/comparison/scenes.ts';
import { gitProvenance } from '../scripts/git-provenance.ts';
import { assessGpuAdapter, buildSource, parseQualificationArgs, QualificationRefusal, runQualification, toJsonSafe, USAGE,
  type GpuSession, type QualificationHost, type QualificationReport } from './qualification-core.ts';

export { USAGE };

/** The output target must be a new file in an existing directory. `lstat` does not follow links, so a dangling symlink counts as existing.
 * Nothing is created here; the write itself uses `wx`, which also refuses an existing link. */
export function checkOutputTarget(out: string): void {
  let existing = false;
  try { lstatSync(out); existing = true; } catch (e) { if ((e as { code?: string }).code !== 'ENOENT') throw new QualificationRefusal('input', '--json cannot be inspected'); }
  if (existing) throw new QualificationRefusal('input', '--json target already exists; reports never overwrite files');
  try { if (!statSync(dirname(out)).isDirectory()) throw new Error('not a directory'); } catch { throw new QualificationRefusal('input', "--json's directory does not exist"); }
}

const LOST_WAIT_MS = 10_000;

/** Acquire the one device this process owns. The `webgpu` module is imported here and nowhere else, so a Rapier-only run never loads it.
 * Instance, adapter and device stay reachable through cleanup (see tests-gpu/device.ts): a collected instance leaves pending native callbacks polling freed memory. */
async function acquireOwnedGpu(keep: unknown[]): Promise<GpuSession> {
  let create: (typeof import('webgpu'))['create'], globals: (typeof import('webgpu'))['globals'];
  try { ({ create, globals } = await import('webgpu')); } catch { throw new QualificationRefusal('gpu', 'The webgpu (Dawn) package could not be loaded: nothing ran'); }
  try {
    Object.assign(globalThis, globals);
    const gpu = create([]); keep.push(gpu);
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new QualificationRefusal('gpu', 'No WebGPU adapter available: nothing ran');
    keep.push(adapter);
    // assessAdapter reads vendor/architecture/device/description by name: GPUAdapterInfo accessors are not enumerable
    const record = assessGpuAdapter((adapter as { info?: unknown }).info, (adapter as { isFallbackAdapter?: unknown }).isFallbackAdapter);
    const requiredLimits = { maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize, maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBuffersPerShaderStage: adapter.limits.maxStorageBuffersPerShaderStage };
    const device = await adapter.requestDevice({ requiredLimits });
    keep.push(device);
    const errors: string[] = [];
    device.addEventListener('uncapturederror', e => errors.push(e.error.message));
    void device.lost.then(info => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.message}`); });
    return {
      device, adapter: record, requiredLimits,
      guard: () => { if (errors.length) throw new Error(`GPU error: ${errors[0]}`); },
      gpuErrors: () => errors,
      settle: () => device.queue.onSubmittedWorkDone(),
      close: async () => {
        const failures: string[] = [];
        try { await device.queue.onSubmittedWorkDone(); } catch (e) { failures.push(`Device drain failed: ${sanitizeMessage(e)}`); }
        try {
          device.destroy();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), LOST_WAIT_MS); });
          if (await Promise.race([device.lost.then(() => 'lost' as const), timeout]) === 'timeout') failures.push('Device cleanup failed: device.lost did not settle');
          clearTimeout(timer);
        } catch (e) { failures.push(`Device cleanup failed: ${sanitizeMessage(e)}`); }
        return failures;
      },
    };
  } catch (e) {
    if (e instanceof QualificationRefusal) throw e;
    throw new QualificationRefusal('gpu', `GPU acquisition failed: ${sanitizeMessage(e)}: nothing ran`);
  }
}

async function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  // Dawn's native runner can keep Node alive after release
  const exit = (code: number): never => process.exit(code);
  let parsed: ReturnType<typeof parseQualificationArgs>;
  try { parsed = parseQualificationArgs(process.argv.slice(2)); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof QualificationRefusal ? 2 : 1); }
  if (parsed.help) { console.log(USAGE); return exit(0); }
  const { config, json } = parsed;
  if (json !== undefined) {
    try { checkOutputTarget(json); } catch (e) { console.error(sanitizeMessage(e)); return exit(e instanceof QualificationRefusal ? 2 : 1); }
  }
  // Everything above refuses before the GPU module is requested.

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Parameters<typeof buildSource>[0];
  let installedWebgpu: string | null = null;
  try { installedWebgpu = (JSON.parse(readFileSync(new URL('../node_modules/webgpu/package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? null; } catch { /* not installed */ }
  const source = buildSource(pkg, gitProvenance(root));
  const environment: Record<string, unknown> = { runtime: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model ?? null,
    backend: config.engines.includes('avbd') ? 'Node + Dawn (webgpu binding) for AVBD; no browser, no rendering' : 'Node, CPU only (Rapier); no GPU module loaded', webgpu: installedWebgpu };

  const emit = async (report: QualificationReport) => {
    const text = JSON.stringify(toJsonSafe(report), null, 2) + '\n';
    if (json !== undefined) { writeFileSync(json, text, { flag: 'wx' }); console.error('Saved report (new file; never overwritten)'); }
    else await new Promise<void>((resolve, reject) => { process.stdout.write(text, error => error ? reject(error) : resolve()); });
  };

  const keep: unknown[] = [];
  (globalThis as { __qualificationDawn?: unknown }).__qualificationDawn = keep;
  const host: QualificationHost = { now: () => new Date(), clock: () => performance.now(), makeScene: name => makeScene(name), createAdapter, acquireGpu: () => acquireOwnedGpu(keep) };
  let report: QualificationReport;
  try { report = await runQualification(config, host, { source, environment }); } catch (e) {
    console.error(sanitizeMessage(e));
    return exit(e instanceof QualificationRefusal ? (e.code === 'gpu' ? 3 : 2) : 1);
  }
  try { await emit(report); } catch (e) { console.error(`Report output failed: ${sanitizeMessage(e)}`); return exit(1); }
  for (const row of report.rows) {
    const failed = row.criteria.filter(c => c.required && c.verdict !== 'pass').map(c => `${c.id} ${c.verdict ?? c.state}`).join(', ');
    console.error(`${row.runId}: ${row.rowVerdict}${row.execution.status === 'completed' ? '' : ` (${row.execution.status}: ${row.execution.failure?.kind ?? row.execution.notRunReason})`}${failed ? ` [${failed}]` : ''}`);
  }
  console.error(report.status === 'refused' ? `Refused: ${report.error?.message}` : report.verdict);
  return exit(report.status === 'completed' ? 0 : report.status === 'refused' ? 3 : 1);
}

// Importable for tests; runs only when this file is the entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
