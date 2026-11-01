# RECOVERED TEXT, NOT ORIGINAL COMMIT. Status REPLAY-VERIFIED-FULL. Rebuilt on 2026-10-31 from agent session transcripts (read ?, last known write ?). SHA-256 of the recovered body below this header: 2965fc4a51eaa3dce43d967585137748f5370307f16114e561a580c467402140. Numbers in it are report text: no measurement data survived. Not run, not reviewed; see README.md in this directory.
"""CPU-only full capture coverage screen; run from the repository root.
Usage: python3 scripts/sdf-coverage-screen.py CAPTURE_ROOT RAW_OUTPUT_DIR REPORT_JSON
Every query-bearing slot in all nine frozen captures is audited, sequentially.
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
    'scripts/sdf-coverage-discovery.ts', 'scripts/sdf-coverage-audit.ts',
    'scripts/sdf-coverage-screen.py', 'scripts/sdf-replay-format.ts',
    'src/avbd3d/gpu/sdf-layout.ts', 'src/avbd3d/gpu/sdf-supports.ts',
    *['src/avbd3d/ref/sdf/' + n + '.ts' for n in ['shapes', 'voxel', 'body', 'manifold', 'optimize', 'math']],
    'tests/sdf-coverage-discovery.test.ts', 'tests/sdf-coverage-audit.test.ts',
    'package.json', 'pnpm-lock.yaml',
]
def digest(data):
    return hashlib.sha256(data).hexdigest()
def hashes():
    return {p: digest(Path(p).read_bytes()) for p in files}
sources = hashes()
provenance, rows, aggregates = [], [], []
sums = ['queryPairs', 'totalQueries', 'tested', 'testedQueries', 'clear', 'clearQueries',
        'clearWithoutActiveHistory', 'clearQueriesWithoutActiveHistory',
        'legacyActiveDisagreements', 'disagreementsWithoutActiveHistory',
        'visits', 'bounds', 'frontierTotal', 'budgetExhausted']
for stem in ['sdf-c1-world-128-p5', 'sdf-c1-world-128-p20', 'sdf-c2-world-4314-p20-reference']:
    for phase in ['impact', 'dense-motion', 'late-state']:
        key = stem + '/' + phase
        directory = captures / key
        manifest_bytes = (directory / 'manifest.json').read_bytes()
        manifest = json.loads(manifest_bytes)
        count = manifest['capacities']['pairCount']
        provenance.append({'capture': key, 'manifestSha256': digest(manifest_bytes), 'manifest': manifest})
        runs = []
        for start in range(0, count, 8192):
            out = raw / f'{stem}-{phase}-{start}.json'
            command = ['nice', '-n', '15', 'node', '--experimental-transform-types', '--no-warnings',
                       'scripts/sdf-coverage-audit.ts', str(directory), str(out), '127', str(start), '8192']
            subprocess.run(command, check=True, timeout=60, stdout=subprocess.DEVNULL)
            data = out.read_bytes()
            row = json.loads(data)
            assert row['slotStart'] == start and row['slotEnd'] == min(start+8192, count)
            assert row['captureSections'] == manifest['sections']
            assert row['captureSource'] == manifest['source']
            assert row['captureMetadata'] == manifest['metadata']
            assert all(sources[p] == h for p, h in row['sources'].items())
            assert row['legacySearchRequired'] and not row['productionEnabled']
            assert len(row['examples']) == row['legacyActiveDisagreements']
            row['rawFile'] = out.name
            row['rawSha256'] = digest(data)
            row['capture'] = key
            rows.append(row)
            runs.append(row)
            print(key, start, 'clear', row['clear'], '/', row['queryPairs'],
                  'disagreements', row['legacyActiveDisagreements'], 'ms', round(row['totalMs']), flush=True)
        assert manifest_bytes == (directory / 'manifest.json').read_bytes(), 'capture manifest changed'
        shared_fields = {}
        failed_headers = set()
        for run in runs:
            for field in run['fields']:
                header = field['header']
                if not field['constructed']:
                    failed_headers.add(header)
                    continue
                if header in shared_fields:
                    assert shared_fields[header] == field, 'shared field changed between windows'
                shared_fields[header] = field
        shared_bytes = sum(f['bytes'] for f in shared_fields.values())
        total = {p: sum(r[p] for r in runs) for p in sums}
        total.update({'capture': key, 'pairCount': count, 'windows': len(runs),
                      'clearQueryFraction': total['clearQueries'] / max(1, total['totalQueries']),
                      'frontierMax': max((r['frontierMax'] for r in runs), default=0),
                      'sharedFields': list(shared_fields.values()), 'sharedCoverBytes': shared_bytes,
                      'unconstructedFieldHeaders': sorted(failed_headers - shared_fields.keys()),
                      'sharedStorageScreenPassed': not (failed_headers - shared_fields.keys()) and shared_bytes <= 64*1024*1024,
                      # Fields rebuild per bounded subprocess; do not sum repeated shared bytes.
                      'maxWindowCoverBytes': max((r['coverBytes'] for r in runs), default=0),
                      'maxWindowBuildPeakArrayBytes': max((r['buildPeakAdditionalArrayBytes'] for r in runs), default=0),
                      'auditMs': sum(r['totalMs'] for r in runs),
                      'repeatedBuildMs': sum(r['buildMs'] for r in runs)})
        aggregates.append(total)
post = hashes()
assert sources == post, 'source changed during screen'
result = {
    'baseCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
    'kind': 'real-trilinear scalar-solid coverage; CPU-only discovery foundation',
    'legacySearchRequired': True, 'productionEnabled': False,
    'maxVisits': 127, 'windowSlots': 8192, 'timeoutSecondsPerWindow': 60,
    'environment': {'platform': platform.platform(), 'node': subprocess.check_output(['node', '--version'], text=True).strip()},
    'sourceFiles': sources, 'postSourceFiles': post,
    'captureProvenance': provenance, 'aggregates': aggregates, 'runs': rows,
    'notes': [
        'Every slot range in all nine frozen captures is included; only valid query-bearing pairs are measured.',
        'Query counts belong to the recorded control, not measured savings. No GPU timing or FPS claim.',
        'All active projected-contact disagreement details are retained, including active-history status.',
        'Geometrically clear does not imply absence of legacy projected contacts or a WGSL arithmetic certificate.',
        'Budget exhaustion retains every pending region. Unsupported fields remain unresolved.',
        'CPU timings include repeated hierarchy building but exclude capture read/validation before auditCoverage.',
        'Shared hierarchy storage sums unique atlas field headers over each complete capture, not just its largest window.',
        'Shared hierarchy bytes and window build peak typed-array bytes exclude source captures and JS overhead.',
        'No capture bytes, contact IDs, independent normals, warm starts or production sources are modified.',
    ],
}
with report.open('x') as file:
    json.dump(result, file, indent=2)
    file.write('\n')
print('Complete: all nine captures audited, no source changes.', flush=True)
