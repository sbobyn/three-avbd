// pnpm compare:rapier [pile-100,pile-1k,ring-9k] [--steps 120 --lead 60 --repeats 3]
//   [--avbd-iterations 4 --rapier-iterations 4 --avbd-margin 0.01 --sleep --json report.json --machine name]
//   [--jitter 0.001 --jitter-seed 1 --final-window 60 --dump-movers 10]   (--engines rapier opens no GPU device)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cpus, platform, release, totalmem } from 'node:os';
import { DEFAULTS, runComparison } from '../src/comparison/run.ts';
import { CASES } from '../src/comparison/scenes.ts';
import type { FinalWindow } from '../src/comparison/final-window.ts';
import type { MoverBody, MoverDump } from '../src/comparison/movers.ts';
import { gitProvenance, type GitProvenance } from './git-provenance.ts';

// Unknown provenance (a source archive) is null, never a guessed revision
const provenanceFields = (git: GitProvenance) =>
  ({ gitHead: git.head, dirty: git.dirty, gitProvenance: git.source === 'git' ? 'git' : `unknown: ${git.reason}` });

const finalSummary = (f: FinalWindow | undefined) => !f ? 'final window —' :
  `final ${f.steps} steps: floor max/p95 ${f.maxFloorPenetration.toFixed(5)}/${f.p95FloorPenetration.toFixed(5)} m, ` +
  `pair max/p95 ${f.maxContactDepth?.toFixed(5) ?? 'unmeasured'}/${f.p95ContactDepth?.toFixed(5) ?? 'unmeasured'} m, ` +
  `max speed ${f.maxSpeed.toFixed(4)} m/s, KE ${f.maxKineticEnergy.toExponential(3)} J, ` +
  `${(100 * f.restFraction).toFixed(1)}% < ${f.restSpeed} m/s, settled ${f.settled ?? 'unmeasured'}`;

const where = (b: MoverBody) => `#${b.id} at (${b.position.map(v => v.toFixed(2)).join(', ')}) ` +
  `${b.contacts} contacts (${b.above} above, ${b.below} below)${b.onFloor ? ', on floor' : ''}, ` +
  `edge ${b.pileEdgeDistance.toFixed(1)} m, height ${(100 * b.heightFraction).toFixed(0)}%, tilt ${b.tilt.toFixed(0)}°`;
const moverSummary = (d: MoverDump) => [`  fastest bodies, steps ≤ ${d.step} (max speed, step, steps > ${d.settledMaxSpeed} m/s, window displacement):`,
  ...d.movers.map(b => `    ${b.maxSpeed.toFixed(3)} m/s @${b.maxSpeedStep}, ${b.stepsAboveSettled} steps, ${b.displacement.toFixed(3)} m; ${where(b)}`),
  '  deepest pairs on the last step (depth, at window start, least face / edge overlap):',
  ...d.deepestPairs.map(p => `    ${(1000 * p.depth).toFixed(1)} mm (${(1000 * p.firstDepth).toFixed(1)} mm), ` +
    `face ${p.faceOverlap === null ? '—' : (1000 * p.faceOverlap).toFixed(1)} / edge ${p.edgeOverlap === null ? '—' : (1000 * p.edgeOverlap).toFixed(1)} mm; ` +
    `${where(p.bodies[0])} | ${where(p.bodies[1])}`)].join('\n');

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
  ['--ccd-substeps', 'rapierCcdSubsteps'], ['--impact-phase', 'impactPhase'], ['--batch-size', 'batchSize'], ['--dt', 'dt'], ['--rapier-pgs-iterations', 'rapierPgsIterations'], ['--timeout-ms', 'timeoutMs'],
  ['--avbd-margin', 'avbdMargin'], ['--jitter', 'jitter'], ['--jitter-seed', 'jitterSeed'], ['--final-window', 'finalWindow'], ['--dump-movers', 'dumpMovers']] as const) {
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
// Rapier is WASM on the CPU: a Rapier-only run never opens a GPU device.
let device: GPUDevice | undefined;
// Keep Dawn's GPU instance reachable for the whole run: if it is collected while the device is in
// use, Dawn aborts ("mutex lock failed") or segfaults.
let gpu: GPU | undefined;
const errors: string[] = [];
if (engines.includes('avbd')) {
  const { create, globals } = await import('webgpu');
  Object.assign(globalThis, globals);
  gpu = create([]);
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new Error('No GPU adapter: comparison was not run');
  device = await adapter.requestDevice({ requiredLimits: { maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize } });
  device.addEventListener('uncapturederror', (e) => errors.push(e.error.message));
  void device.lost.then((info) => { if (info.reason !== 'destroyed') errors.push(`Device lost: ${info.message}`); });
}
try {
  const report = await runComparison(device as GPUDevice, cases, config, console.log, () => {
    if (errors.length) throw new Error(errors.join('; '));
  }, engines);
  const output = { ...report, environment: { machine, runtime: process.version, backend: device ? 'Node + Dawn; no browser/rendering' : 'Node, Rapier WASM only (no GPU device); no rendering',
    processMemory: { ...process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS,
      scope: 'Process high-water RSS and final JS/external memory; includes harness and all selected engines, not GPU allocation or per-engine peak' },
    os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, ramBytes: totalmem(), adapter: device?.adapterInfo ?? null,
    maxBufferSize: device?.limits.maxBufferSize ?? null, maxStorageBufferBindingSize: device?.limits.maxStorageBufferBindingSize ?? null,
    ...provenanceFields(gitProvenance(fileURLToPath(new URL('..', import.meta.url)))) } };
  for (const r of report.results) console.log(`${r.scene} ${r.engine} #${r.repeat + 1}: ${r.status}; ` +
    `mean ${r.meanMs?.toFixed(3) ?? '—'} ms/step, batch p95 ${r.p95Ms?.toFixed(3) ?? '—'} ms; ` +
    `worst floor penetration ${r.worstQuality?.maxFloorPenetration.toFixed(5) ?? '—'} m; pair penetration ${r.maxContactDepth?.toFixed(5) ?? 'unmeasured'} m; contact target ${r.contactTargetMet ?? 'unmeasured'}; ${finalSummary(r.finalWindow)} ${r.error ?? ''}` +
    (r.movers ? `\n${moverSummary(r.movers)}` : ''));
  if (json) { writeFileSync(json, JSON.stringify(output, null, 2) + '\n'); console.log(`Saved ${json}`); }
  process.exitCode = report.results.some((r) => r.status !== 'completed') ? 1 : 0;
} finally { device?.destroy(); }
// Dawn's native event runner can keep Node alive after resources are released.
process.exit(process.exitCode ?? 0);
