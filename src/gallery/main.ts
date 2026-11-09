// The examples gallery page (examples/index.html). Static: it renders ./catalog.ts and filters it;
// it never imports the solver, Three.js or Rapier and never requests a GPU device.

import { ENGINE_LABELS, type Engine, ENTRIES, type Entry, FEATURED, GROUPS, type GroupId, HEAVY_NOTE, type Kind, KIND_LABELS, REQUIREMENT_LABELS, sourceUrl } from './catalog.ts';
import { filterEntries, type Filters, formatFilters, isFiltered, matchedItems, NO_FILTERS, parseFilters } from './filter.ts';
import './gallery.css';

const THUMBS = '/gallery/';
let filters: Filters = parseFilters(location.search);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | undefined)[]) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  return node;
}

function thumb(e: Entry, size: 'card' | 'feature') {
  return el('figure', { class: `thumb thumb-${size}` },
    // Feature tiles are links named by their text; their picture is decorative there
    el('img', { src: THUMBS + e.thumb, alt: size === 'feature' ? '' : e.thumbAlt, width: '320', height: '180', loading: 'lazy', decoding: 'async' }),
    el('figcaption', { class: 'thumb-label' }, 'Illustration'));
}

function badges(e: Entry) {
  const list = el('ul', { class: 'badges', 'aria-label': 'Details' });
  const add = (text: string, cls: string) => list.append(el('li', { class: `badge ${cls}` }, text));
  add(KIND_LABELS[e.kind], `kind-${e.kind}`);
  if (e.experimental) add('Experimental', 'experimental');
  if (e.dimension) add(e.dimension, 'plain');
  if (e.engines.includes('rapier')) add('Rapier + three-avbd', 'engine-rapier');
  add(REQUIREMENT_LABELS[e.requires], 'plain');
  return list;
}

function card(e: Entry) {
  const hits = matchedItems(e, filters.query);
  const body = el('div', { class: 'card-body' },
    el('h3', { id: `t-${e.id}` }, e.href ? el('a', { href: e.pair?.rapier ?? e.href, class: 'card-link' }, e.title) : e.title),
    badges(e),
    el('p', { class: 'desc' }, e.description));
  if (e.pair) {
    body.append(el('div', { class: 'pair', role: 'group', 'aria-label': 'Open one engine' },
      el('a', { class: 'btn primary', href: e.pair.rapier }, el('span', { class: 'step' }, '1'), 'Rapier first'),
      el('a', { class: 'btn', href: e.pair.avbd }, el('span', { class: 'step' }, '2'), 'AVBD counterpart')));
  } else if (e.command) {
    body.append(el('p', { class: 'command' }, el('code', {}, e.command)));
  }
  if (e.items?.length) {
    const wrap = el('div', { class: 'items' });
    wrap.append(el('p', { class: 'items-hint' }, e.pick ?? `${e.items.length} scenes, each opens directly:`));
    const list = el('ul', { class: 'chips' });
    for (const i of e.items) {
      const cls = `chip${hits.has(i.label) ? ' hit' : ''}`;
      const mark = i.heavy ? el('span', { class: 'heavy' }, 'heavy') : null;
      list.append(el('li', {}, i.href ? el('a', { class: cls, href: i.href }, i.label, mark) : el('span', { class: `${cls} static` }, i.label)));
    }
    wrap.append(list);
    if (e.items.some(i => i.heavy)) wrap.append(el('p', { class: 'items-hint' }, HEAVY_NOTE));
    body.append(wrap);
  }
  if (e.limits) body.append(el('details', { class: 'limits' }, el('summary', {}, 'Limits'), el('p', {}, e.limits)));
  const foot = el('p', { class: 'foot' });
  if (e.href && !e.pair) foot.append(el('a', { class: 'open', href: e.href }, 'Open', el('span', { 'aria-hidden': 'true' }, ' →')));
  for (const l of e.links ?? []) foot.append(el('a', l.note ? { href: l.href, title: l.note } : { href: l.href }, l.label));
  if (e.source) foot.append(el('a', { class: 'muted', href: sourceUrl(e.source) }, 'Source'));
  body.append(foot);
  return el('article', { class: 'card', 'aria-labelledby': `t-${e.id}`, id: e.id }, thumb(e, 'card'), body);
}

function featured() {
  const row = el('ol', { class: 'featured' });
  for (const f of FEATURED) {
    const e = ENTRIES.find(x => x.id === f.id)!;
    row.append(el('li', {}, el('a', { class: 'feature', href: e.pair?.rapier ?? e.href ?? `#${e.id}` },
      thumb(e, 'feature'), el('span', { class: 'why' }, f.why), el('span', { class: 'feature-title' }, e.title))));
  }
  return el('section', { class: 'start', 'aria-labelledby': 'start-h' }, el('h2', { id: 'start-h' }, 'Start here'), row);
}

/** A row of toggle buttons for one filter; pressing the active one turns it off. */
function chipRow<K extends 'group' | 'kind' | 'engine'>(key: K, label: string, options: [NonNullable<Filters[K]>, string][]) {
  const row = el('div', { class: 'filter-row', role: 'group', 'aria-label': label }, el('span', { class: 'filter-label', 'aria-hidden': 'true' }, label));
  for (const [value, text] of [[null, 'All'], ...options] as [Filters[K], string][]) {
    const b = el('button', { type: 'button', class: 'fchip', 'data-key': key, 'data-value': value ?? '' }, text);
    b.addEventListener('click', () => update({ [key]: value === null || filters[key] === value ? null : value } as Partial<Filters>));
    row.append(b);
  }
  return row;
}

const results = document.getElementById('results')!;
const toolbar = document.getElementById('filters')!;
const filterRows = document.getElementById('filter-rows')!;
const count = document.getElementById('count')!;
const search = document.getElementById('search') as HTMLInputElement;
const clear = document.getElementById('clear') as HTMLButtonElement;
const start = document.getElementById('start')!;

function update(next: Partial<Filters>) {
  filters = { ...filters, ...next };
  history.replaceState(null, '', location.pathname + formatFilters(filters) + location.hash);
  render();
}

function buildToolbar() {
  filterRows.replaceChildren(
    chipRow('group', 'Topic', GROUPS.map((g): [GroupId, string] => [g.id, g.title])),
    chipRow('kind', 'Type', (Object.keys(KIND_LABELS) as Kind[]).map((k): [Kind, string] => [k, KIND_LABELS[k]])),
    chipRow('engine', 'Engine', [['avbd', `${ENGINE_LABELS.avbd} only`], ['rapier', 'Includes Rapier']] as [Engine, string][]),
  );
}

function render() {
  for (const b of filterRows.querySelectorAll<HTMLButtonElement>('button.fchip')) {
    const current = filters[b.dataset.key as 'group' | 'kind' | 'engine'] ?? '';
    b.setAttribute('aria-pressed', String(current === b.dataset.value));
  }
  if (search.value !== filters.query) search.value = filters.query;
  const shown = filterEntries(ENTRIES, filters);
  const active = isFiltered(filters);
  clear.hidden = !active;
  start.hidden = active;
  count.textContent = active ? `${shown.length} of ${ENTRIES.length} entries` : `${ENTRIES.length} entries`;
  results.replaceChildren();
  if (!shown.length) {
    const reset = el('button', { type: 'button', class: 'btn primary' }, 'Clear filters');
    reset.addEventListener('click', () => { update(NO_FILTERS); search.focus(); });
    results.append(el('div', { class: 'empty' },
      el('p', {}, 'Nothing matches ', el('strong', {}, filters.query.trim() ? `“${filters.query.trim()}”` : 'these filters'), '.'),
      el('p', { class: 'muted' }, 'Try a scene name such as “bridge” or “torus”, or clear the filters.'), reset));
    return;
  }
  for (const g of GROUPS) {
    const members = shown.filter(e => e.group === g.id);
    if (!members.length) continue;
    results.append(el('section', { class: 'group', 'aria-labelledby': `g-${g.id}` },
      el('header', { class: 'group-head' }, el('h2', { id: `g-${g.id}` }, g.title), el('p', {}, g.blurb)),
      el('div', { class: 'grid' }, ...members.map(card))));
  }
}

start.replaceChildren(featured());
buildToolbar();
search.addEventListener('input', () => update({ query: search.value }));
search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.preventDefault(); update({ query: '' }); } });
clear.addEventListener('click', () => { update(NO_FILTERS); search.focus(); });
document.addEventListener('keydown', e => {
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.focus(); }
});
toolbar.hidden = false;
filterRows.hidden = false;
render();
