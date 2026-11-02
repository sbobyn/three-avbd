// pnpm compare:rapier [pile-100,pile-1k,ring-9k] [--steps 120 --lead 60 --repeats 3]
//   [--avbd-iterations 4 --rapier-iterations 4 --sleep --json report.json --machine name]
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, platform, release, totalmem } from 'node:os';
import { create, globals } from 'webgpu';
import { DEFAULTS, runComparison } from '../src/comparison/run.ts';
import { CASES } from '../src/comparison/scenes.ts';
import { gitProvenance, type GitProvenance } from './git-provenance.ts';

// Unknown provenance (a source archive) is null, never a guessed revision
const provenanceFields = (git: GitProvenance) =>
  ({ gitHead: git.head, dirty: git.dirty, gitProvenance: git.source === 'git' ? 'git' : `unknown: ${git.reason}` });

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args.splice(i, 2)[1];
};
const json = option('--json');
const machine = option('--machine') ?? 'unspecified';
const engines = (option('--engines') ?? 'rapier,avbd').split(',') as import('../src/comparison/adapters.ts').Engine[];
const config = { ...DEFAULTS };
for (const [flag, key] of [['--steps', 'steps'], ['--lead', 'lead'], ['--repeats', 'repeats'],
  ['--avbd-iterations', 'avbdIterations'], ['--rapier-iterations', 'rapierIterations'],
  ['--ccd-substeps', 'rapierCcdSubsteps'], ['--impact-phase', 'impactPhase'], ['--batch-size', 'batchSize'], ['--dt', 'dt'], ['--rapier-pgs-iterations', 'rapierPgsIterations'], ['--timeout-ms', 'timeoutMs']] as const) {
  const value = option(flag);
  if (value !== undefined) config[key] = Number(value);
}
const ccd = args.indexOf('--ccd');
if (ccd >= 0) { args.splice(ccd, 1); config.rapierCcd = true; }
const sleep = args.indexOf('--sleep');
if (sleep >= 0) { args.splice(sleep, 1); config.rapierSleeping = true; }
if (args.length > 1 || args.some((s) => s.startsWith('--'))) throw new Error('Unknown arguments');
const cases = (args[0] ?? 'pile-100,pile-1k').split(',');
if (cases.some((c) => !CASES.includes(c as typeof CASES[number]))) throw new Error(`Cases: ${CASES.join(', ')}`);
Object.assign(globalThis, globals);
const gpu = create([]);
const adapter = await gpu.requestAdapter();
if (!adapter) throw new Error('No GPU adapter: comparison was not run');
const device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize,
  maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
const errors: string[] = [];
device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
void device.lost.then((info) => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.message}`); });
try {
  const report = await runComparison(device, cases, config, console.log, () => {
    if (errors.length) throw new Error(errors.join('; '));
  }, engines);
  const output = { ...report, environment: { machine, runtime: process.version, backend: 'Node + Dawn; no browser/rendering',
    processMemory: { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
      scope: 'Process high-water RSS and final JS/external memory; includes harness and all selected engines, not GPU allocation or per-engine peak' },
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, ramBytes: totalmem(), adapter: device.adapterInfo,
    maxBufferSize: device.limits.maxBufferSize, maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
    ...provenanceFields(gitProvenance(fileURLToPath(new URL('..', import.meta.url)))) } };
  for (const r of report.results) console.log(`${r.scene} ${r.engine} #${r.repeat + 1}: ${r.status}; ` +
    `mean ${r.meanMs?.toFixed(3) ?? '—'} ms/step, batch p95 ${r.p95Ms?.toFixed(3) ?? '—'} ms; ` +
    `worst floor penetration ${r.worstQuality?.maxFloorPenetration.toFixed(5) ?? '—'} m; pair penetration ${r.maxContactDepth?.toFixed(5) ?? 'unmeasured'} m; contact target ${r.contactTargetMet ?? 'unmeasured'} ${r.error ?? ''}`);
  if (json) { writeFileSync(json, JSON.stringify(output, null, 2) + '\n'); console.log(`Saved ${json}`); }
  process.exitCode = report.results.some((r) => r.status !== 'completed') ? 1 : 0;
} finally { device.destroy(); }
// Dawn's native event runner can keep Node alive after resources are released.
process.exit(process.exitCode ?? 0);
