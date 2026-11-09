import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allScenes2D } from '../src/avbd2d/sim.ts';
import { allScenes3D } from '../src/avbd3d/sim.ts';
import { CASES } from '../src/comparison/scenes.ts';
import { releasedScenes } from '../src/sdf-released/scenes.ts';
import { sceneMenu } from '../src/ui/scene-menu.ts';
import { ENTRIES, type Entry, FEATURED, GROUPS } from '../src/gallery/catalog.ts';
import { filterEntries, formatFilters, matchedItems, NO_FILTERS, parseFilters } from '../src/gallery/filter.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const byId = (id: string) => ENTRIES.find(e => e.id === id)!;

/** Page inputs of the Vite build, as repository paths (e.g. 'compare-side.html', 'examples/basic.html'). */
const PAGES = [...read('vite.config.ts').matchAll(/^\s+\w+: '([^']+\.html)',$/gm)].map(m => m[1]);

/** Every link a card can show, resolved from /examples/index.html to a repository path + query. */
function internalLinks(e: Entry) {
  const hrefs = [e.href, e.pair?.rapier, e.pair?.avbd, ...(e.items ?? []).map(i => i.href), ...(e.links ?? []).map(l => l.href)];
  return hrefs.filter((h): h is string => !!h && !/^https?:/.test(h)).map(h => {
    const url = new URL(h, 'http://x/examples/index.html');
    return { href: h, page: url.pathname.slice(1), scene: url.searchParams.get('scene') };
  });
}
const allLinks = ENTRIES.flatMap(internalLinks);
const itemsLinkingTo = (page: string) => new Set(ENTRIES.flatMap(e => (e.items ?? []).filter(i => i.href)
  .map(i => new URL(i.href!, 'http://x/examples/index.html')).filter(u => u.pathname === `/${page}`).map(u => u.searchParams.get('scene'))));
/** Option labels of a <select id> in a static page. */
const options = (page: string, id: string) => {
  const select = new RegExp(`<select id="${id}">(.*?)</select>`).exec(read(page))![1];
  return [...select.matchAll(/<option[^>]*>([^<]+)<\/option>/g)].map(m => m[1].replace(/ · \d+ bodies$/, ''));
};

test('every scene the 3D and 2D viewers list in their menus has a direct gallery link', () => {
  for (const [dim, page, all] of [['3d', 'index.html', allScenes3D], ['2d', '2d.html', allScenes2D]] as const) {
    const listed = sceneMenu(dim, all.map(s => s.name)).own.flatMap(g => g.items.map(i => i.value));
    assert.ok(listed.length > 20, `${dim} menu unexpectedly small`);
    const linked = itemsLinkingTo(page);
    assert.deepEqual(listed.filter(n => !linked.has(n)), [], `${dim} scenes missing from the gallery`);
  }
});

test('every comparison case, released SDF scene and SDF playground preset is findable', () => {
  const side = byId('side-by-side').items!;
  const covered = new Set(side.flatMap(i => i.covers ?? []));
  assert.deepEqual(CASES.filter(c => !covered.has(c)), []);
  for (const c of CASES) {
    assert.ok(filterEntries(ENTRIES, { ...NO_FILTERS, query: c }).some(e => e.id === 'side-by-side'), c);
    assert.ok(side.some(i => new URL(i.href!, 'http://x').searchParams.get('scene') === c), `${c} must select its own input, not another family size`);
  }
  assert.deepEqual(byId('sdf-released').items!.map(i => i.label), releasedScenes.map(s => s.name));
  assert.deepEqual(options('sdf-released.html', 'scene'), releasedScenes.map(s => s.name));
  assert.deepEqual(byId('sdf-playground').items!.map(i => i.label), options('sdf.html', 'preset'));
});

test('every built page is reachable, and the internal frame helper sits under its comparison', () => {
  const linked = new Set(allLinks.map(l => l.page === '' ? 'index.html' : l.page));
  assert.deepEqual(PAGES.filter(p => p !== 'examples/index.html' && !linked.has(p)), []);
  const frame = ENTRIES.filter(e => internalLinks(e).some(l => l.page === 'compare-frame.html'));
  assert.deepEqual(frame.map(e => e.id), ['side-by-side']);
  assert.ok(frame.every(e => e.href !== '../compare-frame.html' && e.kind === 'diagnostic'));
});

test('internal links resolve to built pages and only select scenes those pages accept', () => {
  const valid: Record<string, Set<string>> = {
    'index.html': new Set(allScenes3D.map(s => s.name)), '2d.html': new Set(allScenes2D.map(s => s.name)), 'compare-side.html': new Set<string>(CASES),
  };
  for (const l of allLinks) {
    assert.ok(PAGES.includes(l.page), `${l.href} is not a built page`);
    if (l.scene !== null) assert.ok(valid[l.page]?.has(l.scene), `${l.href}: ${l.page} does not select scene "${l.scene}"`);
  }
  // Pages without a scene parameter list their contents as plain names with instructions instead
  for (const e of ENTRIES) if (e.items?.some(i => !i.href)) assert.ok(e.pick && e.items.every(i => !i.href), e.id);
});

test('catalog entries are unique, grouped, sourced and illustrated by an existing thumbnail', () => {
  assert.equal(new Set(ENTRIES.map(e => e.id)).size, ENTRIES.length);
  assert.equal(new Set(ENTRIES.map(e => e.title)).size, ENTRIES.length);
  for (const g of GROUPS) assert.ok(ENTRIES.some(e => e.group === g.id), `empty group ${g.id}`);
  for (const f of FEATURED) assert.ok(byId(f.id), f.id);
  const thumbs = readdirSync(new URL('public/gallery/', root));
  for (const e of ENTRIES) {
    assert.ok(e.href || e.command, `${e.id} has no action`);
    assert.ok(e.description.length > 40 && e.description.length < 220, `${e.id} description length`);
    assert.ok(thumbs.includes(e.thumb), `${e.id}: missing thumbnail ${e.thumb}`);
    if (e.source) assert.ok(existsSync(new URL(e.source, root)), `${e.id}: missing source ${e.source}`);
    if (e.pair) assert.ok(e.engines.includes('rapier') && e.limits, `${e.id}: a pair must disclose its limits`);
  }
  // No orphaned images; each is a static SVG with an accessible title and no external references
  assert.deepEqual(thumbs.filter(t => !ENTRIES.some(e => e.thumb === t)), []);
  for (const t of thumbs) {
    const svg = read(`public/gallery/${t}`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 320 180"[^>]*>\n<title>[^<]+<\/title>/, t);
    assert.doesNotMatch(svg, /<script|<image|href=|url\((?!#)/, t);
  }
});

test('filters combine, clear and report no results honestly', () => {
  const all = filterEntries(ENTRIES, NO_FILTERS);
  assert.equal(all.length, ENTRIES.length);
  const rapierDiagnostics = filterEntries(ENTRIES, { ...NO_FILTERS, group: 'rapier', kind: 'diagnostic', engine: 'rapier' });
  assert.deepEqual(rapierDiagnostics.map(e => e.id).sort(), ['quality-runner', 'side-by-side']);
  assert.deepEqual(filterEntries(ENTRIES, { ...NO_FILTERS, group: 'sdf', engine: 'rapier' }), []);
  assert.ok(filterEntries(ENTRIES, { ...NO_FILTERS, engine: 'avbd' }).every(e => !e.engines.includes('rapier')));
  // A scene name finds the collection that holds it, and the matched scene is marked
  const ring = filterEntries(ENTRIES, { ...NO_FILTERS, query: 'brick ring 110k' });
  assert.deepEqual(ring.map(e => e.id), ['paper-3d', 'side-by-side']);
  assert.deepEqual([...matchedItems(ring[0], 'brick ring 110k')], ['Brick Ring (110k)']);
  assert.deepEqual([...matchedItems(ring[1], 'brick ring 110k')], ['Brick ring · 110k']);
  assert.ok(filterEntries(ENTRIES, { ...NO_FILTERS, query: 'Torus' }).some(e => e.id === 'sdf-hollow'));
  assert.deepEqual(filterEntries(ENTRIES, { ...NO_FILTERS, query: 'ragdolls', kind: 'headless' }), []);
  assert.deepEqual(filterEntries(ENTRIES, { ...NO_FILTERS, query: 'x'.repeat(500) }), []);
  assert.deepEqual(filterEntries(ENTRIES, { ...NO_FILTERS, query: '  ¿¡ ' }).length, ENTRIES.length);
});

test('filter state round-trips through the page URL and ignores unknown values', () => {
  const f = { query: 'heavy rope', group: 'joints', kind: 'playable', engine: 'avbd' } as const;
  assert.deepEqual(parseFilters(formatFilters(f)), f);
  assert.equal(formatFilters(NO_FILTERS), '');
  assert.deepEqual(parseFilters('?group=nope&kind=fast&engine=physx&q=' + 'a'.repeat(400)),
    { query: 'a'.repeat(200), group: null, kind: null, engine: null });
});

test('the gallery page loads only gallery code: no solver, Three.js, Rapier or GPU request', () => {
  const html = read('examples/index.html');
  assert.deepEqual([...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]), ['/src/gallery/main.ts']);
  for (const file of readdirSync(new URL('src/gallery/', root)).filter(f => f.endsWith('.ts'))) {
    const source = read(`src/gallery/${file}`);
    const imports = [...source.matchAll(/^import [^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(imports.every(i => /^\.\/[\w-]+\.(ts|css)$/.test(i)), `${file} imports ${imports}`);
    assert.doesNotMatch(source, /navigator\.gpu|requestAdapter|import\(/, file);
  }
});
