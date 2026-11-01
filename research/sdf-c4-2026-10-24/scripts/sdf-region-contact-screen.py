# RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: c413db20847ccbbffac89873fa604791ba665e818bd378e76b61fd100a2e75d0. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
"""CPU-only bounded witness screen, sequential with a 60s subprocess limit.
Usage: python3 scripts/sdf-region-contact-screen.py CAPTURE_ROOT RAW_DIR REPORT_JSON
"""
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys

captures, raw, report = map(Path, sys.argv[1:])
if report.exists():
    raise FileExistsError(report)
raw.mkdir(exist_ok=False)
files = [
    'scripts/sdf-region-contacts.ts', 'scripts/sdf-region-contact-audit.ts',
    'scripts/sdf-region-contact-screen.py', 'scripts/sdf-coverage-discovery.ts',
    'scripts/sdf-replay-format.ts', 'src/avbd3d/gpu/sdf-layout.ts', 'src/avbd3d/gpu/sdf-supports.ts',
    *['src/avbd3d/ref/sdf/' + n + '.ts' for n in ['shapes', 'voxel', 'body', 'manifold', 'optimize', 'math']],
    'tests/sdf-region-contacts.test.ts', 'tests/sdf-region-contact-audit.test.ts',
    'package.json', 'pnpm-lock.yaml',
]
def digest(data):
    return hashlib.sha256(data).hexdigest()
def hashes():
    return {p: digest(Path(p).read_bytes()) for p in files}
sources = hashes()
provenance, runs, aggregates = [], [], []
for stem in ['sdf-c1-world-128-p5', 'sdf-c1-world-128-p20', 'sdf-c2-world-4314-p20-reference']:
    for phase in ['impact', 'dense-motion', 'late-state']:
        key = stem + '/' + phase
        directory = captures / key
        manifest_bytes = (directory / 'manifest.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        provenance.append({'capture': key, 'manifestSha256': digest(manifest_bytes), 'manifest': manifest})
        out = raw / f'{stem}-{phase}.json'
        subprocess.run(['nice', '-n', '15', 'node', '--experimental-transform-types', '--no-warnings',
                        'scripts/sdf-region-contact-audit.ts', str(directory), str(out)], check=True, timeout=60,
                       stdout=subprocess.DEVNULL)
        data = out.read_bytes()
        run = json.loads(data)
        assert run['captureSections'] == manifest['sections'] and run['captureSource'] == manifest['source']
        assert run['captureMetadata'] == manifest['metadata']
        assert all(sources[p] == h for p, h in run['sources'].items())
        assert run['legacySearchRequired'] and not run['productionEnabled']
        assert run['maxPairs'] == 32 and run['maxQueryPairs'] == 1024
        rows = run['rows']
        assert len(rows) <= 32 and run['queryPairs'] <= 1024
        assert all(r['unresolved'] > 0 for r in rows)
        assert all(c['anchorErrorA'] <= 1e-5 and c['anchorErrorB'] <= 1e-5 for r in rows for c in r['candidates'])
        assert manifest_bytes == (directory / 'manifest.json').read_bytes(), 'capture manifest changed'
        aggregate = {'capture': key, 'selected': len(rows),
                     'withProposals': sum(bool(r['candidates']) for r in rows),
                     'originalActivePairs': sum(bool(r['originalActive']) for r in rows),
                     'originalActiveWithoutProposal': sum(bool(r['originalActive']) and not r['candidates'] for r in rows),
                     'originalActivePoints': sum(r['originalActive'] for r in rows),
                     'proposals': sum(len(r['candidates']) for r in rows),
                     'unresolved': sum(r['unresolved'] for r in rows),
                     'generationMs': sum(r['generationMs'] for r in rows),
                     'buildMs': run['buildMs'], 'totalMs': run['totalMs'],
                     'work': {k: sum(r['work'][k] for r in rows) for k in rows[0]['work']} if rows else {}}
        aggregates.append(aggregate)
        runs.append({'capture': key, 'rawFile': out.name, 'rawSha256': digest(data), **run})
        print(key, 'proposals', aggregate['proposals'], 'pairs', aggregate['withProposals'], '/', len(rows),
              'active-without-proposal', aggregate['originalActiveWithoutProposal'], flush=True)
post = hashes()
assert sources == post, 'source changed during screen'
result = {'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
          'kind': 'bounded scalar-surface contact proposal feasibility; CPU only',
          'legacySearchRequired': True, 'productionEnabled': False, 'timeoutSecondsPerCapture': 60,
          'environment': {'platform': platform.platform(), 'node': subprocess.check_output(['node', '--version'], text=True).strip()},
          'sourceFiles': sources, 'postSourceFiles': post, 'captureProvenance': provenance,
          'aggregates': aggregates, 'runs': runs,
          'notes': ['First 32 retained voxel pairs within first 1024 query-bearing slots per capture. Selection does not inspect active outputs.',
                    'Every selected row and all proposal details are retained, including zero-proposal rows; unsupported pairs are counted, not listed per slot.',
                    'All original coverage frontiers remain unresolved; this generator cannot replace original search.',
                    'Original active counts use legacy projected-contact semantics; neither recall nor settling equivalence follows.',
                    'CPU generation timings include coverage repeated after selection; total excludes capture reading/validation.',
                    'No GPU timing, runtime speedup, FPS, or physical settling claim. Source captures and solver warm states remain untouched.',
                    'Grid bytes and cover arrays exclude capture storage and edge/tree JavaScript object overhead. Field count and edge counts are bounded.']}
with report.open('x') as file:
    json.dump(result, file, indent=2)
    file.write('\n')
print('Complete: all nine bounded capture samples, no source changes.', flush=True)
