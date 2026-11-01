// Serial execution prevents competing GPU workloads from contaminating results.
// node --experimental-transform-types scripts/compare-suite.ts <output-directory>
import { mkdirSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const directory = process.argv[2];
if (!directory) throw new Error('Provide one output directory');
const output = resolve(directory);
mkdirSync(output, { recursive: true });
const jobs: { name: string; args: string[] }[] = [
  { name: 'analytic-60', args: ['free-fall,slide,spin', '--steps', '120'] },
  { name: 'analytic-240', args: ['free-fall,slide,spin', '--dt', String(1 / 240), '--steps', '480'] },
  { name: 'strength-4', args: ['stack-50,stack-heavy,chain-20,chain-heavy', '--steps', '600', '--avbd-iterations', '4'] },
  { name: 'strength-16', args: ['stack-50,stack-heavy,chain-20,chain-heavy', '--steps', '600'] },
  { name: 'scaling-4', args: ['rest-grid-100,rest-grid-1k,rest-grid-10k', '--lead', '120', '--steps', '600', '--avbd-iterations', '4'] },
  { name: 'scaling-16', args: ['rest-grid-100,rest-grid-1k,rest-grid-10k', '--lead', '120', '--steps', '600'] },
  { name: 'soak', args: ['rest-stack,chain-heavy,spin', '--lead', '120', '--steps', '7200'] },
  { name: 'sphere-discrete', args: ['sphere-pile-100', '--steps', '600'] },
  { name: 'rapier-strength-16', args: ['stack-heavy,chain-heavy', '--engines', 'rapier', '--rapier-iterations', '16', '--steps', '600'] },
  { name: 'rapier-strength-64', args: ['stack-heavy,chain-heavy', '--engines', 'rapier', '--rapier-iterations', '64', '--steps', '600'] },
  { name: 'projectile-train', args: ['impact-train', '--steps', '600'] },
  { name: 'head-on-ccd', args: ['impact-1,impact-100,impact-1000', '--steps', '15'] },
  { name: 'head-on-shifted-ccd', args: ['impact-1,impact-100,impact-1000', '--impact-phase', '0.5', '--steps', '15'] },
  { name: 'sleeping-scaling', args: ['rest-grid-10k', '--engines', 'rapier', '--sleep', '--lead', '120', '--steps', '600'] },
  { name: 'memory-rapier', args: ['rest-grid-1k', '--engines', 'rapier', '--steps', '120'] },
  { name: 'memory-avbd', args: ['rest-grid-1k', '--engines', 'avbd', '--steps', '120'] },
  { name: 'angular-ccd8', args: ['impact-rotate', '--engines', 'rapier', '--ccd-substeps', '8', '--steps', '1'] },
  { name: 'angular-60', args: ['impact-rotate', '--steps', '1'] },
  { name: 'angular-240', args: ['impact-rotate', '--dt', String(1 / 240), '--steps', '4'] },
  { name: 'angular-960', args: ['impact-rotate', '--dt', String(1 / 960), '--steps', '16'] },
];
const selected = process.argv.slice(3);
if (selected.some(name => !jobs.some(job => job.name === name))) throw new Error('Unknown suite job');
const statuses: { name: string; exit: number | null; error?: string }[] = [];
for (const job of jobs.filter(job => !selected.length || selected.includes(job.name))) {
  console.log(`Starting ${job.name}`);
  // Specific job flags override these defaults by replacing the corresponding pair.
  const defaults = ['--ccd', '--avbd-iterations', '16', '--avbd-margin', '0.001', '--lead', '0', '--repeats', '2', '--timeout-ms', '900000'];
  for (let i = 0; i < defaults.length; i++) {
    if (defaults[i].startsWith('--') && job.args.includes(defaults[i])) { defaults.splice(i, defaults[i] === '--ccd' ? 1 : 2); i--; }
  }
  const log = openSync(join(output, `${job.name}.log`), 'w');
  const run = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings',
    'scripts/compare-rapier.ts', ...defaults, ...job.args, '--json', join(output, `${job.name}.json`)],
    { stdio: ['ignore', log, log] });
  closeSync(log);
  statuses.push({ name: job.name, exit: run.status, ...(run.error ? { error: String(run.error) } : {}) });
  writeFileSync(join(output, 'suite-status.json'), JSON.stringify(statuses, null, 2) + '\n');
  console.log(`${job.name}: ${run.status === 0 ? 'completed (inspect quality separately)' : 'execution failed'}`);
}
process.exitCode = statuses.some(s => s.exit !== 0) ? 1 : 0;
