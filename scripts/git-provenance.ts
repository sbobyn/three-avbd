// Git provenance for comparison reports (vite.config.ts and scripts/compare-rapier.ts).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** Where a report's source came from. Without usable Git metadata it says so, never a guessed revision. */
export type GitProvenance =
  | { source: 'git'; head: string; dirty: boolean }
  | { source: 'unknown'; head: null; dirty: null; reason: string };

/** Provenance of the checkout at `root`. A source archive has no `.git`; one unpacked inside
 * another repository would report that repository's HEAD, so the top level must be `root`. */
export function gitProvenance(root: string): GitProvenance {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel')) !== realpathSync(root)) throw new Error('not the root of a Git checkout');
    return { source: 'git', head: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain').length > 0 };
  } catch (e) {
    // Git's own first line, not Node's failed command line (which embeds this machine's path)
    const err = e as { stderr?: string; code?: string; message?: string };
    const reason = err.stderr?.trim().split('\n')[0] || (err.code === 'ENOENT' ? 'git not found' : err.message?.split('\n')[0]) || 'unknown';
    return { source: 'unknown', head: null, dirty: null, reason };
  }
}
