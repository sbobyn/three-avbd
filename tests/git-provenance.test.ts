import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { countStatusEntries, gitProvenance, type GitProvenance } from '../scripts/git-provenance.ts';

// Disposable fixtures only: no remotes, no user or system Git configuration, identity per command.
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'three-avbd-git-provenance-')));
process.env.GIT_CEILING_DIRECTORIES = base; // fixtures never discover a repository above the prefix, nor the reverse
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const dir = (name: string) => { const d = join(base, `${name}-${counter++}`); mkdirSync(d); return d; };
const git = (cwd: string, ...args: string[]) => execFileSync('git',
  ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const file = (d: string, name: string, text = 'x\n') => writeFileSync(join(d, name), text);
/** A repository with one commit holding `a.txt`, `b.txt` and `keep me.txt`. */
function repo(name = 'repo') {
  const d = dir(name);
  git(d, 'init', '-q', '-b', 'main');
  for (const f of ['a.txt', 'b.txt', 'keep me.txt']) file(d, f, `${f}\n`);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'base');
  return d;
}
const zero = { entries: 0, tracked: 0, untracked: 0, staged: 0, unstaged: 0, renamed: 0, conflicted: 0 };
const known = (p: GitProvenance) => { assert.equal(p.source, 'git'); return p as Extract<GitProvenance, { source: 'git' }>; };
const unknown = (p: GitProvenance) => {
  assert.equal(p.source, 'unknown'); assert.equal(p.head, null); assert.equal(p.dirty, null);
  return (p as Extract<GitProvenance, { source: 'unknown' }>).reason;
};

test('a clean commit reports its head, dirty:false and zero counts', () => {
  const d = repo();
  const p = known(gitProvenance(d));
  assert.equal(p.head, git(d, 'rev-parse', 'HEAD'));
  assert.equal(p.dirty, false);
  assert.deepEqual(p.changes, zero);
});

test('tracked changes: unstaged, staged, both on one path, and a staged delete are one entry each', () => {
  const d = repo();
  file(d, 'a.txt', 'changed\n');                                            // unstaged
  file(d, 'b.txt', 'changed\n'); git(d, 'add', 'b.txt');                    // staged
  file(d, 'keep me.txt', 'staged\n'); git(d, 'add', 'keep me.txt'); file(d, 'keep me.txt', 'and again\n'); // both
  file(d, 'new.txt'); git(d, 'add', 'new.txt');                             // staged add
  git(d, 'rm', '-q', '--cached', 'new.txt'); file(d, 'new.txt');            // back to untracked
  const p = known(gitProvenance(d));
  assert.equal(p.dirty, true);
  assert.deepEqual(p.changes, { entries: 4, tracked: 3, untracked: 1, staged: 2, unstaged: 2, renamed: 0, conflicted: 0 });
  git(d, 'checkout', '-q', '--', '.'); git(d, 'reset', '-q', '--hard'); git(d, 'clean', '-fdq');
  git(d, 'rm', '-q', 'a.txt');
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, tracked: 1, staged: 1 });
});

test('untracked files with spaces, newlines, quotes and non-ASCII names are counted, never named', () => {
  const d = repo();
  const names = ['with space.txt', 'line\nbreak.txt', 'quote"d.txt', 'ünï-cödé.txt', '-dash.txt', 'private-secret-name.env'];
  for (const n of names) file(d, n);
  const p = known(gitProvenance(d));
  assert.equal(p.dirty, true);
  assert.deepEqual(p.changes, { ...zero, entries: names.length, untracked: names.length });
  const json = JSON.stringify(p);
  for (const n of ['space', 'break', 'secret', 'cödé', d, base]) assert.ok(!json.includes(n), `report leaks ${n}`);
  assert.deepEqual(Object.keys(p).sort(), ['changes', 'dirty', 'head', 'source']);
});

test('an untracked directory is one entry (Git default status), and tracked and untracked stay distinguishable', () => {
  const d = repo();
  mkdirSync(join(d, 'overlay')); file(d, 'overlay/one.txt'); file(d, 'overlay/two.txt');
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, untracked: 1 });
  file(d, 'a.txt', 'changed\n');
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 2, tracked: 1, untracked: 1, unstaged: 1 });
});

test('a rename is one entry, including odd names, staged-only and staged with a further edit', () => {
  const d = repo();
  file(d, 'odd\nname with space.txt', 'keep\n'); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'odd');
  git(d, 'mv', 'odd\nname with space.txt', 'renamed ünï.txt');
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, tracked: 1, staged: 1, renamed: 1 });
  file(d, 'renamed ünï.txt', 'keep\nmore\n'); // staged rename plus an unstaged edit: still one path
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, tracked: 1, staged: 1, unstaged: 1, renamed: 1 });
  git(d, 'mv', 'a.txt', 'a2.txt'); file(d, 'untracked after rename');
  assert.deepEqual(known(gitProvenance(d)).changes, { entries: 3, tracked: 2, untracked: 1, staged: 2, unstaged: 1, renamed: 2, conflicted: 0 });
});

test('merge conflicts are tracked entries counted as conflicted, not as staged or unstaged', () => {
  const d = repo();
  git(d, 'checkout', '-q', '-b', 'side'); file(d, 'a.txt', 'side\n'); git(d, 'commit', '-qam', 'side');
  git(d, 'checkout', '-q', 'main'); file(d, 'a.txt', 'main\n'); git(d, 'commit', '-qam', 'main');
  assert.throws(() => git(d, 'merge', 'side'));
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, tracked: 1, conflicted: 1 });
});

test('ignored files are not counted and do not make a checkout dirty; ignore rules themselves are visible changes', () => {
  const d = repo();
  file(d, '.gitignore', 'ignored/\n*.log\n'); git(d, 'add', '.gitignore'); git(d, 'commit', '-q', '-m', 'ignore');
  mkdirSync(join(d, 'ignored')); file(d, 'ignored/x.txt'); file(d, 'build.log');
  const p = known(gitProvenance(d));
  assert.equal(p.dirty, false);
  assert.deepEqual(p.changes, zero);
  file(d, '.gitignore', 'ignored/\n*.log\n*.tmp\n'); // editing the rules is a tracked change, not masked
  assert.deepEqual(known(gitProvenance(d)).changes, { ...zero, entries: 1, tracked: 1, unstaged: 1 });
});

test('a linked worktree is its own checkout: its physical root, head and state, not the main checkout’s', () => {
  const main = repo();
  const linked = join(base, `linked-${counter++}`);
  git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);
  file(linked, 'c.txt', 'topic\n'); git(linked, 'add', 'c.txt'); git(linked, 'commit', '-q', '-m', 'topic');
  const a = known(gitProvenance(linked));
  assert.equal(a.head, git(linked, 'rev-parse', 'HEAD'));
  assert.notEqual(a.head, known(gitProvenance(main)).head);
  assert.deepEqual(a.changes, zero);
  file(linked, 'only-here.txt');
  assert.equal(known(gitProvenance(linked)).dirty, true);
  assert.equal(known(gitProvenance(main)).dirty, false);
});

test('a symlinked path to a checkout resolves to the same physical root', () => {
  const d = repo();
  const link = join(base, `link-${counter++}`);
  symlinkSync(d, link);
  assert.equal(known(gitProvenance(link)).head, git(d, 'rev-parse', 'HEAD'));
});

test('an archive unpacked inside another repository, or a subdirectory of one, does not borrow its provenance', () => {
  const outer = repo();
  const archive = join(outer, 'unpacked-archive'); mkdirSync(archive); file(archive, 'package.json', '{}');
  assert.equal(unknown(gitProvenance(archive)), 'not the root of a Git checkout');
  assert.equal(known(gitProvenance(outer)).dirty, true); // the untracked archive dir is the outer repository's own state
  mkdirSync(join(outer, 'sub')); file(outer, 'sub/inner.txt'); git(outer, 'add', 'sub'); git(outer, 'commit', '-q', '-m', 'sub');
  assert.equal(unknown(gitProvenance(join(outer, 'sub'))), 'not the root of a Git checkout');
});

test('unavailable metadata is unknown with a controlled reason: no stderr, no paths, never clean', () => {
  const archive = dir('archive'); file(archive, 'package.json', '{}');
  const unborn = dir('unborn'); git(unborn, 'init', '-q', '-b', 'main');
  const missing = join(base, 'does-not-exist');
  const reasons = [
    { r: unknown(gitProvenance(archive)), want: 'not a Git checkout' },
    { r: unknown(gitProvenance(unborn)), want: 'git metadata unreadable' },
    { r: unknown(gitProvenance(missing)), want: 'git metadata unreadable' },
  ];
  for (const { r, want } of reasons) {
    assert.equal(r, want);
    assert.ok(!r.includes(base) && !r.includes('fatal'), r);
  }
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = archive; // a directory with no git in it
    assert.equal(unknown(gitProvenance(archive)), 'git not found');
  } finally { process.env.PATH = savedPath; }
});

test('a damaged repository is unknown, not clean', () => {
  const d = repo();
  rmSync(join(d, '.git', 'HEAD'));
  const reason = unknown(gitProvenance(d));
  assert.ok(!reason.includes(base), reason);
});

test('countStatusEntries: NUL-separated entries, rename origins skipped, ignored entries not counted', () => {
  const out = ['M  staged', ' M worktree', 'MM both', 'R  new name', 'old name', 'RM renamed edited', 'old2', '?? untracked\nnewline', 'UU conflict', '!! ignored', ''].join('\0');
  assert.deepEqual(countStatusEntries(out), { entries: 7, tracked: 6, untracked: 1, staged: 4, unstaged: 3, renamed: 2, conflicted: 1 });
  assert.deepEqual(countStatusEntries(''), zero);
  // a name that merely looks like a status line is a rename origin, not an entry
  assert.deepEqual(countStatusEntries(['R  to', '?? looks like untracked', ''].join('\0')), { ...zero, entries: 1, tracked: 1, staged: 1, renamed: 1 });
});


test('local status.hide-untracked preference cannot make source provenance clean', () => {
  const d = repo('hidden-untracked');
  git(d, 'config', 'status.showUntrackedFiles', 'no'); // disposable fixture config only
  file(d, 'untracked-private-name.txt');
  const p = known(gitProvenance(d));
  assert.equal(p.dirty, true);
  assert.equal(p.changes.untracked, 1);
  assert.ok(!JSON.stringify(p).includes('untracked-private-name'));
});
