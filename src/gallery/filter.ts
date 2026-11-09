// DOM-free gallery filtering and URL state (examples/index.html via ./main.ts).

import { type Engine, type Entry, ENGINE_LABELS, type GroupId, GROUPS, type Kind, KIND_LABELS, REQUIREMENT_LABELS } from './catalog.ts';

export interface Filters {
  query: string;
  group: GroupId | null;
  kind: Kind | null;
  engine: Engine | null;
}
export const NO_FILTERS: Filters = { query: '', group: null, kind: null, engine: null };

/** Lower case, accents and punctuation folded to spaces, so "Brick-Ring (28k)" matches "brick ring 28k". */
export function normalize(text: string): string {
  return text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Everything a search can match for an entry: its words, labels, and every named scene it contains. */
export function searchText(e: Entry): string {
  const group = GROUPS.find(g => g.id === e.group)!;
  return normalize([
    e.title, e.description, group.title, KIND_LABELS[e.kind], REQUIREMENT_LABELS[e.requires], e.dimension ?? '',
    ...e.engines.map(x => ENGINE_LABELS[x]), e.experimental ? 'experimental' : '', e.command ?? '', e.source ?? '',
    ...(e.items ?? []).flatMap(i => [i.label, ...(i.covers ?? [])]), ...(e.links ?? []).map(l => l.label),
  ].join(' '));
}

/** Every word of the query must appear (as a word prefix) somewhere in the entry. */
export function matchesQuery(e: Entry, query: string): boolean {
  const words = normalize(query).split(' ').filter(Boolean);
  if (!words.length) return true;
  const hay = ` ${searchText(e)}`;
  return words.every(w => hay.includes(` ${w}`));
}

/** `engine`: 'rapier' keeps entries that include Rapier; 'avbd' keeps three-avbd-only entries. */
export function matches(e: Entry, f: Filters): boolean {
  const withRapier = e.engines.includes('rapier');
  return (!f.group || e.group === f.group) && (!f.kind || e.kind === f.kind)
    && (!f.engine || (f.engine === 'rapier') === withRapier) && matchesQuery(e, f.query);
}

export const filterEntries = (entries: readonly Entry[], f: Filters) => entries.filter(e => matches(e, f));
export const isFiltered = (f: Filters) => f.query.trim() !== '' || f.group !== null || f.kind !== null || f.engine !== null;

/** Names inside an entry that the query matched, to highlight them on its card. */
export function matchedItems(e: Entry, query: string): Set<string> {
  const words = normalize(query).split(' ').filter(Boolean);
  const hit = new Set<string>();
  if (!words.length) return hit;
  for (const i of e.items ?? []) {
    const hay = ` ${normalize([i.label, ...(i.covers ?? [])].join(' '))}`;
    if (words.every(w => hay.includes(` ${w}`))) hit.add(i.label);
  }
  return hit;
}

const pick = <T extends string>(value: string | null, allowed: readonly T[]): T | null =>
  value !== null && (allowed as readonly string[]).includes(value) ? value as T : null;

/** Filters from the page's query string (?q=&group=&kind=&engine=); unknown values are ignored. */
export function parseFilters(search: string): Filters {
  const q = new URLSearchParams(search);
  return {
    query: (q.get('q') ?? '').slice(0, 200),
    group: pick(q.get('group'), GROUPS.map(g => g.id)),
    kind: pick(q.get('kind'), Object.keys(KIND_LABELS) as Kind[]),
    engine: pick(q.get('engine'), Object.keys(ENGINE_LABELS) as Engine[]),
  };
}

export function formatFilters(f: Filters): string {
  const q = new URLSearchParams();
  if (f.query.trim()) q.set('q', f.query.trim());
  if (f.group) q.set('group', f.group);
  if (f.kind) q.set('kind', f.kind);
  if (f.engine) q.set('engine', f.engine);
  const s = q.toString();
  return s ? `?${s}` : '';
}
