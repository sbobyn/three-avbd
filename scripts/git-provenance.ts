// Git provenance for comparison reports (vite.config.ts, scripts/compare-rapier.ts, scripts/interlocking-trial.ts).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

/** Counts of `git status` entries, one per path (a rename is one entry, not two). Only numbers: no path,
 * basename or content is recorded, so a public report never exposes private file names. Ignored files are
 * not listed by Git's default status and are not counted; untracked directories are one entry each. */
export interface GitChangeCounts {
  /** Every status entry; `dirty` is exactly `entries > 0`. */
  entries: number;
  /** Entries Git already tracks: modified, deleted, added, renamed or conflicted, staged or not. */
  tracked: number;
  /** Entries Git does not track (and has not ignored). */
  untracked: number;
  /** Tracked entries with an index (staged) change. */
  staged: number;
  /** Tracked entries with a working-tree change not yet staged. */
  unstaged: number;
  /** Rename or copy entries (a subset of `tracked`, counted once per pair). */
  renamed: number;
  /** Unmerged entries (a subset of `tracked`; not counted as staged or unstaged). */
  conflicted: number;
}

/** Where a report's source came from. Without usable Git metadata it says so, never a guessed revision.
 * `changes` is additive: `source`, `head` and `dirty` mean what they always did. */
export type GitProvenance =
  | { source: 'git'; head: string; dirty: boolean; changes: GitChangeCounts }
  | { source: 'unknown'; head: null; dirty: null; reason: string };

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Counts the entries of `git status --porcelain=v1 -z`: `XY <path>\0`, and for a rename or copy
 * `XY <new>\0<orig>\0`. NUL separation makes spaces, newlines and quotes in names harmless; the original
 * path of a rename is skipped so the pair is one entry. Paths are read only to be skipped. */
export function countStatusEntries(porcelainZ: string): GitChangeCounts {
  const c: GitChangeCounts = { entries: 0, tracked: 0, untracked: 0, staged: 0, unstaged: 0, renamed: 0, conflicted: 0 };
  const tokens = porcelainZ.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 0) continue;
    const xy = token.slice(0, 2), x = xy[0], y = xy[1];
    if (xy === '!!') continue;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') { i++; c.renamed++; }
    c.entries++;
    if (xy === '??') { c.untracked++; continue; }
    c.tracked++;
    if (UNMERGED.has(xy)) { c.conflicted++; continue; }
    if (x !== ' ') c.staged++;
    if (y !== ' ') c.unstaged++;
  }
  return c;
}

/** A fixed vocabulary: Git's own stderr and Node's failed command line embed this machine's paths. */
function unavailableReason(e: unknown): string {
  const err = e as { stderr?: string; code?: string; message?: string };
  if (err.code === 'ENOENT') return 'git not found';
  if (err.code === 'ENOBUFS') return 'git status output too large';
  if (err.message === NOT_ROOT) return NOT_ROOT;
  if (/not a git repository/i.test(err.stderr ?? '')) return 'not a Git checkout';
  return 'git metadata unreadable';
}
const NOT_ROOT = 'not the root of a Git checkout';

/** Provenance of the checkout at `root`. A source archive has no `.git`; one unpacked inside
 * another repository would report that repository's HEAD, so the top level must be `root`. */
export function gitProvenance(root: string): GitProvenance {
  // LC_ALL=C: error classification must not depend on the user's language
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' },
  });
  try {
    if (realpathSync(git('rev-parse', '--show-toplevel').trim()) !== realpathSync(root)) throw new Error(NOT_ROOT);
    const head = git('rev-parse', 'HEAD').trim();
    // Untracked files are requested explicitly: a user's status.showUntrackedFiles=no must not read as clean
    const changes = countStatusEntries(git('status', '--porcelain=v1', '-z', '--untracked-files=normal'));
    return { source: 'git', head, dirty: changes.entries > 0, changes };
  } catch (e) {
    return { source: 'unknown', head: null, dirty: null, reason: unavailableReason(e) };
  }
}
