// Results page: every machine report in docs/data/bench3d/ (written by bench3d.html's
// "Download results" or `pnpm bench3d:gpu --json`), against the paper's reported times.
// Reports pasted into the page are kept in this browser's storage only.

import { BENCH_CASES, type BenchReport, type BenchResult, PAPER_SCENES, type PaperScene } from '../avbd3d/bench-cases.ts';
import { PHASES } from '../avbd3d/gpu/solver.ts';

const files = import.meta.glob<BenchReport>('../../docs/data/bench3d/*.json', { eager: true, import: 'default' });
const STORAGE_KEY = 'avbd3d-pasted-reports';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ms = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(2));

function pasted(): BenchReport[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as BenchReport[];
  } catch {
    return [];
  }
}

function savePasted(reports: BenchReport[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // Storage unavailable (private window): the report shows until the page reloads
  }
}

let extra: BenchReport[] = pasted();

function reports(): BenchReport[] {
  const committed = Object.keys(files)
    .sort()
    .map((path) => files[path]);
  return [...committed, ...extra.map((r) => ({ ...r, machine: `${r.machine} (pasted)` }))];
}

const result = (r: BenchReport, scene: string): BenchResult | undefined => r.results.find((x) => x.scene === scene);

function ratio(ours: number, paper: number): string {
  if (!Number.isFinite(ours)) return '';
  const k = ours / paper;
  return `<span class="${k <= 1 ? 'good' : 'bad'}">${k.toFixed(2)}×</span>`;
}

function renderMachines(all: BenchReport[]): void {
  $('#machines').innerHTML = all.length
    ? `<div class="table-wrap"><table><thead><tr><th>machine</th><th>GPU</th><th>run</th><th>date</th></tr></thead><tbody>${all
        .map(
          (r) =>
            `<tr><td>${esc(r.machine)}</td><td class="wrap">${esc(r.adapter)}</td><td class="wrap muted">${esc(r.source)}</td><td>${esc(r.date)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`
    : '<p>No reports yet.</p>';
}

/** Horizontal bars: total per frame, the solve part darker. */
function chart(paper: PaperScene, rows: { label: string; r: BenchResult }[]): string {
  const scale = Math.max(paper.totalMs, ...rows.map(({ r }) => (Number.isFinite(r.wallMs) ? r.wallMs : 0)));
  // Leave room after the longest bar for its value
  const width = (v: number) => `calc((100% - 6.5em) * ${v / scale})`;
  const bar = (solve: number | undefined, total: number, kind: 'paper' | 'ours') => {
    const s = Math.min(solve ?? 0, total);
    const [a, b] = kind === 'paper' ? ['paper-solve', 'paper-rest'] : ['solve', 'rest'];
    return `<div class="bar"><div class="fill" style="width:${width(total)}"><div class="${a}" style="width:${(100 * s) / total}%"></div><div class="${b}" style="flex:1"></div></div><span>${ms(total)} ms</span></div>`;
  };
  // Our solve share: GPU solve phase over GPU total, applied to the wall time
  const oursSolve = (r: BenchResult) => (r.gpu && r.gpu.total > 0 ? (r.wallMs * r.gpu.solve) / r.gpu.total : undefined);
  return `<div class="chart"><div class="label">paper, RTX 4090</div>${bar(paper.solveMs, paper.totalMs, 'paper')}${rows
    .map(({ label, r }) => `<div class="label" title="${esc(label)}">${esc(label)}</div>${bar(oursSolve(r), r.wallMs, 'ours')}`)
    .join('')}</div>`;
}

function renderPaper(all: BenchReport[]): void {
  const legend = `<div class="legend"><span><span class="swatch" style="background:var(--solve)"></span>solve</span><span><span class="swatch" style="background:var(--rest)"></span>collision, colouring</span><span><span class="swatch" style="background:var(--paper)"></span>paper (solve darker, from Table 1)</span></div>`;
  const cases = BENCH_CASES.filter((c) => c.paper);
  const sections = (Object.values(PAPER_SCENES) as PaperScene[]).map((paper) => {
    const c = cases.find((x) => x.paper === paper)!;
    const rows = all.flatMap((r) => {
      const x = result(r, c.name);
      return x ? [{ label: r.machine, r: x }] : [];
    });
    const head = `<tr><th>machine</th><th>scene</th><th>bodies</th><th>iters</th><th>ms/step</th><th>solve (GPU)</th><th>collision (GPU)</th><th>vs paper</th><th>GPU MB</th></tr>`;
    const paperRow = `<tr class="muted"><td>paper, RTX 4090</td><td class="wrap">${esc(paper.description)}</td><td>${paper.bodies.toLocaleString('en')}</td><td>${paper.iterations}</td><td>${ms(paper.totalMs)}</td><td>${ms(paper.solveMs)}</td><td>${paper.solveMs ? ms(paper.totalMs - paper.solveMs) : '—'}</td><td></td><td></td></tr>`;
    const ours = rows
      .map(
        ({ label, r }) =>
          `<tr><td>${esc(label)}</td><td class="wrap">${esc(r.scene)}</td><td>${r.bodies.toLocaleString('en')}</td><td>${r.iterations}</td><td><b>${ms(r.wallMs)}</b></td><td>${ms(r.gpu?.solve)}</td><td>${ms(r.gpu?.collision)}</td><td>${ratio(r.wallMs, paper.totalMs)}</td><td>${(r.gpuBytes / 2 ** 20).toFixed(0)}</td></tr>${r.error ? `<tr><td class="error" colspan="9">${esc(r.error)}</td></tr>` : ''}`,
      )
      .join('');
    const missing = rows.length ? '' : '<p>No machine has run this scene yet (the 510k scene is off by default in bench3d.html).</p>';
    return `<h3>${esc(paper.figure)}: ${esc(paper.description)}</h3><p>${esc(paper.note)}</p>${rows.length ? chart(paper, rows) : ''}${missing}<div class="table-wrap"><table><thead>${head}</thead><tbody>${paperRow}${ours}</tbody></table></div>`;
  });
  $('#paper').innerHTML = legend + sections.join('');
}

function renderScenes(all: BenchReport[]): void {
  const head = `<tr><th>scene</th><th>iters</th><th>bodies</th>${all.map((r) => `<th>${esc(r.machine)}</th>`).join('')}<th>paper, RTX 4090</th></tr>`;
  const rows = BENCH_CASES.map((c) => {
    const first = all.map((r) => result(r, c.name)).find(Boolean);
    const cells = all.map((r) => {
      const x = result(r, c.name);
      return `<td>${x ? (x.error ? '<span class="error">failed</span>' : ms(x.wallMs)) : '<span class="muted">—</span>'}</td>`;
    });
    return `<tr><td>${esc(c.name)}</td><td>${c.iterations}</td><td>${first ? first.bodies.toLocaleString('en') : ''}</td>${cells.join('')}<td class="muted">${c.paper ? `${c.paper.totalMs} ms` : ''}</td></tr>`;
  });
  $('#scenes').innerHTML = `<table><thead>${head}</thead><tbody>${rows.join('')}</tbody></table>`;
}

function renderDetails(all: BenchReport[]): void {
  $('#details').innerHTML = all
    .map((r) => {
      const head = `<tr><th>scene</th><th>iters</th><th>bodies</th><th>joints</th><th>contacts</th><th>colours</th><th>ms/step</th><th>GPU ms</th>${PHASES.map((p) => `<th>${p}</th>`).join('')}<th>GPU MB</th></tr>`;
      const rows = r.results
        .map(
          (x) =>
            `<tr><td>${esc(x.scene)}</td><td>${x.iterations}</td><td>${x.bodies.toLocaleString('en')}</td><td>${x.joints.toLocaleString('en')}</td><td>${x.contacts.toLocaleString('en')}</td><td>${x.colors}${x.clashes || x.overflow ? ` <span class="bad">(clashes ${x.clashes}, overflow ${x.overflow})</span>` : ''}</td><td><b>${ms(x.wallMs)}</b></td><td>${ms(x.gpu?.total)}</td>${PHASES.map((p) => `<td>${ms(x.gpu?.[p])}</td>`).join('')}<td>${(x.gpuBytes / 2 ** 20).toFixed(0)}</td></tr>${x.error ? `<tr><td class="error" colspan="${9 + PHASES.length}">${esc(x.error)}</td></tr>` : ''}`,
        )
        .join('');
      const note = r.timestamps ? '' : '<p>No timestamp queries on this device: GPU phase times unavailable.</p>';
      return `<h3>${esc(r.machine)}</h3><p>${esc(r.adapter)} · ${esc(r.date)}</p>${note}<div class="table-wrap"><table><thead>${head}</thead><tbody>${rows}</tbody></table></div>`;
    })
    .join('');
}

function render(): void {
  const all = reports();
  renderMachines(all);
  renderPaper(all);
  renderScenes(all);
  renderDetails(all);
}

const pasteStatus = (text: string) => ($('#paste-status').textContent = text);

$<HTMLButtonElement>('#add').onclick = () => {
  try {
    const r = JSON.parse($<HTMLTextAreaElement>('#paste').value) as Partial<BenchReport> & { results?: BenchResult[] };
    if (!Array.isArray(r.results) || !r.results.length) throw new Error('no results in it');
    // Reports copied before machine names existed carry only the adapter
    const report: BenchReport = {
      machine: r.machine ?? r.adapter ?? 'pasted machine',
      adapter: r.adapter ?? '',
      source: r.source ?? '',
      date: r.date ?? '',
      timestamps: r.timestamps ?? false,
      results: r.results,
    };
    extra = [...extra, report];
    savePasted(extra);
    $<HTMLTextAreaElement>('#paste').value = '';
    pasteStatus(`Added ${report.machine}.`);
    render();
  } catch (e) {
    pasteStatus(`Could not read that: ${e instanceof Error ? e.message : String(e)}`);
  }
};

$<HTMLButtonElement>('#clear').onclick = () => {
  extra = [];
  savePasted(extra);
  pasteStatus('Pasted reports removed.');
  render();
};

render();
