# RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 5cd1225e10b9a62829552994cfb0a554badad5ab41ccbbde4c938e9e29575384. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
"""Bounded CPU screen of the conditional source certificate; no GPU dispatch.
Usage: python3 scripts/sdf-separation-screen.py CAPTURE_ROOT RAW_OUTPUT_DIR REPORT_JSON
Requires the nine preserved C1/C2 captures. Run from the repository root.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

captures, raw, report = map(Path, sys.argv[1:])
raw.mkdir(exist_ok=False)
if report.exists():
    raise FileExistsError(report)
files = [
    'scripts/sdf-cell-projection.ts', 'scripts/sdf-cell-projection-audit.ts',
    'scripts/sdf-f32-enclosure.ts', 'scripts/sdf-f32-field-bounds.ts',
    'scripts/sdf-f32-separation.ts', 'scripts/sdf-replay-format.ts',
    'scripts/sdf-separation-screen.py', 'tests/sdf-f32-separation.test.ts',
    'tests/sdf-cell-projection-audit.test.ts',
]
def hashes():
    return {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in files}
source = hashes()
rows, provenance = [], []
for stem in ['sdf-c1-world-128-p5', 'sdf-c1-world-128-p20', 'sdf-c2-world-4314-p20-reference']:
    for phase in ['impact', 'dense-motion', 'late-state']:
        directory = captures / stem / phase
        manifest = json.loads((directory / 'manifest.json').read_text())
        count = manifest['capacities']['pairCount']
        provenance.append({'capture': stem + '/' + phase, 'manifest': manifest})
        for start in range(0, count, 8192):
            end = min(start + 8192, count)
            out = raw / f'{stem}-{phase}-{start}.json'
            cmd = ['nice', '-n', '15', 'node', '--experimental-transform-types', '--no-warnings',
                   'scripts/sdf-cell-projection-audit.ts', str(directory), str(out),
                   '127' if '4314' in stem else '31', '100000', 'body', '0', 'flat',
                   str(start), str(end), '16', 'source-assume-zero', '31']
            subprocess.run(cmd, check=True, timeout=60, stdout=subprocess.DEVNULL)
            row = json.loads(out.read_text())
            row['capture'] = stem + '/' + phase
            assert row['contradictions'] == row['numerical']['contradictions'] == 0
            rows.append(row)
            print(stem, phase, start, 'model', row['candidates'], 'conditional',
                  row['numerical']['candidates'], 'ms', round(row['totalMs']), flush=True)
post = hashes()
assert source == post, 'source changed during screen'
# Match the preceding sixteen-entry screen independently of the new window size.
prior = json.loads(Path('docs/measurements/sdf-range16-budget-2026-10-24.json').read_text())
matched = ['totalQueries', 'queryPairs', 'tested', 'candidates', 'candidateQueries', 'nodes', 'rangeReads']
for p in provenance:
    key = p['capture']
    old = [r for r in prior['runs'] if r['capture'] == key and r['rangeBudget'] == 16]
    new = [r for r in rows if r['capture'] == key]
    for metric in matched:
        assert sum(r[metric] for r in old) == sum(r[metric] for r in new), (key, metric)
result = {
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'kind': 'CPU numerical source-family screen; not a portable WGSL proof',
    'sourceFiles': source, 'postSourceFiles': post,
    'captureProvenance': provenance, 'runs': rows, 'matchedPriorMetrics': matched,
    'notes': [
        'Sequential nice15, <=8192 slots and a 60-second subprocess timeout.',
        'Legacy real-model candidate is only a work prefilter. Every retained candidate must pass the enlarged-domain numerical check.',
        'Conditional on finite source-DAG evaluation and exact-zero interior length; portable rejection remains disabled.',
        'Source field ranges use <=16 nodes/query and 31 subdivision nodes/pair, with no projected-image correlation.',
        'CPU audit time includes hashing, accounting and both hierarchy builds; not simulation or GPU timings.',
        'No capture bytes, contact history, production sources or warm starts are modified.',
    ],
}
with report.open('x') as file:
    json.dump(result, file, indent=2)
    file.write('\n')
print('Complete: prior model totals matched; zero captured contact contradictions.', flush=True)
