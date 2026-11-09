import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { allScenes2D } from '../src/avbd2d/sim.ts';
import { allScenes3D } from '../src/avbd3d/sim.ts';
import { CASES } from '../src/comparison/scenes.ts';
import { parseSettings } from '../src/comparison/side-model.ts';
import { releasedScenes } from '../src/sdf-released/scenes.ts';
import { sceneMenu } from '../src/ui/scene-menu.ts';
import { ENTRIES, type Entry, FEATURED, GROUPS, HEAVY_NOTE, REQUIREMENT_LABELS } from '../src/gallery/catalog.ts';
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

// --- Static page chrome: links that survive deployment, one gallery label, one title pattern ---------------

/** Files `vite build` emits besides the page inputs (the licences plugin in vite.config.ts) and public/. */
const EMITTED = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const FILE_ATTRS = /<(a|link|script|img|source|iframe)\b[^>]*?\s(href|src)="([^"]*)"[^>]*>/g;

/**
 * Problems with the local links of a page as the deployed build serves them: an `a`/`img`/icon must be another
 * built page, a file in public/ or an emitted licence. Only module scripts and stylesheets may name a source file
 * (Vite bundles those). The dev server also serves the whole repository, so a link to docs/ works there and 404s once deployed.
 */
function deployedLinkProblems(page: string, html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(FILE_ATTRS)) {
    const [tag, name, , target] = m;
    if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target) || target === '') continue;
    const url = new URL(target, `http://x/${page}`);
    let path = url.pathname.slice(1);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const bundled = (name === 'script' && /\stype="module"/.test(tag)) || (name === 'link' && /\srel="stylesheet"/.test(tag));
    const served = PAGES.includes(path) || EMITTED.includes(path) || existsSync(new URL(`public/${path}`, root));
    if (!served && !(bundled && existsSync(new URL(path, root)))) problems.push(`${page}: ${target} is not served by the build`);
  }
  return problems;
}

test('deployed-link check rejects repository-only targets and accepts built pages and public files', () => {
  assert.deepEqual(deployedLinkProblems('examples/x.html', '<a href="../docs/PAIRED_STUDIES.md">Study</a>'), ['examples/x.html: ../docs/PAIRED_STUDIES.md is not served by the build']);
  assert.equal(deployedLinkProblems('examples/x.html', '<a href="/src/ui/page.css">css</a>').length, 1, 'a source file is not a link target');
  assert.equal(deployedLinkProblems('examples/x.html', '<a href="../README.md">readme</a><a href="./missing.html">gone</a>').length, 2);
  assert.deepEqual(deployedLinkProblems('examples/x.html', [
    '<a href="./">gallery</a><a href="../THIRD_PARTY_NOTICES.md">n</a><a href="https://github.com/sbobyn/three-avbd/blob/main/docs/PAIRED_STUDIES.md">g</a>',
    '<img src="/favicon.svg"><a href="../results.html#top">r</a><a href="#main">skip</a>',
    '<link rel="stylesheet" href="./example.css"><script type="module" src="./basic.ts"></script>',
  ].join('')), []);
});

test('no built page links to a file the deployed site does not serve', () => {
  assert.equal(PAGES.length, 20);
  assert.deepEqual(PAGES.flatMap(page => deployedLinkProblems(page, read(page))), []);
});

test('every page except the internal frame helper links back to the "Demo gallery" by that name', () => {
  for (const page of PAGES.filter(p => p !== 'examples/index.html' && p !== 'compare-frame.html')) {
    const anchors = [...read(page).matchAll(/<a\b[^>]*?\shref="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
    const gallery = anchors.filter(a => /^(←\s*)?Demo gallery$/.test(a[2].trim()));
    assert.ok(gallery.length > 0, `${page} has no "Demo gallery" link`);
    for (const a of gallery) {
      const path = new URL(a[1], `http://x/${page}`).pathname.slice(1);
      assert.equal(path.endsWith('/') ? path + 'index.html' : path, 'examples/index.html', `${page}: "Demo gallery" goes to ${a[1]}`);
    }
    // The old labels for the same place are gone
    assert.doesNotMatch(read(page), />\s*(←\s*)?(All examples|Examples|Back to demo)\s*</, page);
  }
});

test('titles of the static pages follow "Page · three-avbd" and match what the gallery calls them', () => {
  const titled = PAGES;
  assert.deepEqual(titled.filter(p => !/<title>[^<]+ · three-avbd<\/title>/.test(read(p))), [], 'title pattern');
  const title = (page: string) => /<title>([^<]+) · three-avbd<\/title>/.exec(read(page))![1];
  assert.equal(title('examples/index.html'), 'Demo gallery');
  for (const [id, page] of [['basic-world', 'examples/basic.html'], ['body-lifecycle', 'examples/body-lifecycle.html'], ['body-pool', 'examples/body-pool.html'],
    ['results', 'results.html'], ['quality-runner', 'compare.html']] as const) assert.equal(title(page), byId(id).title, page);
  assert.equal(title('bench3d.html'), '3D benchmark');
  assert.equal(title('bench.html'), '2D benchmark');
});

test('the Write-your-own page has a title, instructions, gallery and source links and a status line; the examples report startup failures', () => {
  const html = read('examples/basic.html');
  const heading = /<h1>([\s\S]*?)<\/h1>/.exec(html)?.[1];
  assert.ok(heading, 'the starter has a heading');
  assert.equal(heading.replace(/<[^>]*>/g, '').trim(), 'Basic world');
  assert.match(heading, /<img[^>]+src="\/favicon\.svg"[^>]+alt=""/, 'the brand mark is decorative');
  assert.match(html, /<a href="\.\/index\.html">Demo gallery<\/a>/);
  assert.match(html, /<a href="https:\/\/github\.com\/sbobyn\/three-avbd\/blob\/main\/examples\/basic\.ts">Source<\/a>/);
  assert.match(html, /id="status"/);
  assert.match(html, /rel="stylesheet" href="\.\/example\.css"/);
  // The card is bounded by the window; the dark pages say so (native buttons and inputs follow) and keep usable targets
  const css = read('examples/example.css');
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /max-width:\s*min\(360px,\s*calc\(100vw - 24px\)\)/);
  assert.match(css, /max-height:\s*calc\(100vh - 24px\)/);
  assert.match(css, /button\s*\{[^}]*min-height:\s*(2[4-9]|[3-9]\d)px/);
  assert.match(read('examples/headless.css'), /color-scheme:\s*dark/);
  assert.match(read('examples/headless.css'), /button, select\s*\{[^}]*min-height:\s*(2[4-9]|[3-9]\d)px/);
  for (const f of ['basic', 'sdf-gear', 'sdf-hollow', 'sdf-from-mesh']) {
    const source = read(`examples/${f}.ts`);
    assert.match(source, /startExample\(status\)/, f);
    assert.match(source, /catch \(error\) \{\s*await startup\.fail\(error\);/, f);
    assert.match(source, /startup\.own\(await World\.create\(/, f);
  }
  // Headless output is announced
  for (const f of ['body-lifecycle', 'body-pool']) assert.match(read(`examples/${f}.html`), /<pre id="output" role="status">/, f);
});

test('comparison chips of 9k bodies and up open paused, are marked heavy, and the page really reads paused', () => {
  const items = byId('side-by-side').items!;
  const heavy = items.filter(i => i.heavy).map(i => i.covers![0]);
  assert.deepEqual(heavy, ['rest-grid-10k', 'pile-10k', 'pile-10k-settled', 'ring-9k', 'ring-110k']);
  for (const item of items) {
    const url = new URL(item.href!, 'http://x/examples/index.html');
    assert.equal(url.searchParams.get('paused'), item.heavy ? '1' : null, item.label);
    assert.ok(CASES.includes(url.searchParams.get('scene') as never), item.label);
    if (item.heavy) {
      const settings = parseSettings(url.search);
      assert.equal(settings.paused, true, item.label);
      assert.equal(settings.scene, item.covers![0], `${item.label} keeps its exact case`);
    }
  }
  assert.match(HEAVY_NOTE, /paused/);
  assert.match(HEAVY_NOTE, /not qualified/);
  assert.doesNotMatch(HEAVY_NOTE, /safe|bounded|prevents|avoids/);
  // The cards and the filter find them by name
  assert.ok(filterEntries(ENTRIES, { ...NO_FILTERS, query: 'ring-110k' }).some(e => e.id === 'side-by-side'));
  // The page marks and explains them
  const page = read('src/gallery/main.ts');
  assert.match(page, /i\.heavy \? el\('span', \{ class: 'heavy' \}, 'heavy'\)/);
  assert.match(page, /HEAVY_NOTE/);
});

test('labels do not imply features the library lacks', () => {
  // (a)/(b) soft body and cloth are rigid bodies on joints
  assert.match(byId('joints-3d').limits ?? '', /Soft Body.*rigid boxes.*not a continuum or finite-element/);
  assert.match(byId('joints-2d').limits ?? '', /Soft Body.*rigid boxes.*not a continuum/);
  assert.match(byId('paper-3d').limits ?? '', /thin rigid plates on ball joints, not a cloth simulation/);
  assert.doesNotMatch(byId('paper-3d').description, /on cloth/);
  // (d) the 2D solver is not in the published package; the package exports no 2D entry
  const exports = Object.keys(JSON.parse(read('package.json')).exports);
  assert.deepEqual(exports, ['.', './sdf', './queries', './advanced', './pool']);
  const twoD = ENTRIES.filter(e => internalLinks(e).some(l => l.page === '2d.html'));
  assert.deepEqual(twoD.map(e => e.id), ['contacts-2d', 'joints-2d', 'scale-2d', 'custom']);
  for (const e of twoD) assert.match(e.limits ?? '', /2D solver is a TypeScript port.*not part of the published three-avbd package/, e.id);
  // (e) the landing scene is one of three fixed scenes chosen from a one-time speed check
  const landing = byId('playground-3d').description;
  assert.doesNotMatch(landing, /largest scene/);
  assert.match(landing, /one-time GPU speed check/);
  for (const name of ['Brick Ring (28k)', 'Wall Smash (2k)']) assert.match(read('src/app3d/main.ts'), new RegExp(name.replace(/[()]/g, '\\$&')));
  // (f) a static report needs no GPU
  assert.equal(byId('results').requires, 'none');
  assert.equal(REQUIREMENT_LABELS.none, 'No GPU needed');
});

test('commands are real commands; a written procedure is a guide that links its document', () => {
  for (const e of ENTRIES.filter(x => x.command)) assert.match(e.command!, /^(pnpm|node|npm|npx) \S/, `${e.id}: ${e.command}`);
  const fresh = byId('fresh-project');
  assert.equal(fresh.kind, 'guide');
  assert.equal(fresh.command, undefined);
  assert.equal(fresh.href, 'https://github.com/sbobyn/three-avbd/blob/main/docs/SETUP.md#fresh-threejs-consumer');
  assert.ok(read('docs/SETUP.md').includes('## Fresh Three.js consumer') || /^#+ Fresh Three\.js consumer/mi.test(read('docs/SETUP.md')));
  assert.equal(filterEntries(ENTRIES, { ...NO_FILTERS, kind: 'guide' }).length, 1);
  // No link renders an empty title attribute
  assert.doesNotMatch(read('src/gallery/main.ts'), /title:\s*[^,}]*\?\?\s*''/);
});

test('shared tokens expose light and dark primitives without styling any page; the gallery maps them itself', () => {
  const tokens = read('src/ui/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.deepEqual([...tokens.matchAll(/([^{}]+)\{/g)].map(m => m[1].trim()), [':root']);
  assert.doesNotMatch(tokens, /@media|@import|color-scheme|background|prefers-/);
  const names = [...tokens.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]);
  assert.ok(names.every(n => n.startsWith('--avbd-')), 'every token is --avbd- namespaced');
  for (const role of ['paper', 'surface', 'sunk', 'ink', 'muted', 'accent', 'accent-ink', 'link', 'focus']) {
    for (const mode of ['light', 'dark']) assert.ok(names.includes(`--avbd-${mode}-${role}`), `--avbd-${mode}-${role}`);
  }
  assert.ok(names.includes('--avbd-badge-play') && names.includes('--avbd-badge-exp'));
  // The gallery imports only the tokens, maps light by default and dark under its own media query
  const css = read('src/gallery/gallery.css');
  assert.deepEqual([...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map(m => m[1]), ['../ui/tokens.css']);
  assert.match(css, /--paper:\s*var\(--avbd-light-paper\)/);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{\s*--paper:\s*var\(--avbd-dark-paper\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{6}\b[^;]*;[^}]*--paper/i);
  // The existing viewer and control styles are untouched by this file
  for (const f of ['src/ui/page.css', 'src/ui/controls.css']) {
    assert.match(read(f), /@import '\.\/tokens\.css'/, `${f} adopts shared primitives`);
    assert.match(read(f), /var\(--avbd-light-(?:ink|accent)\)/);
    assert.doesNotMatch(read(f), /prefers-color-scheme/, 'viewer theme stays intentionally light');
  }
  // The dark example pages take only link and focus colours from it
  for (const f of ['examples/example.css', 'examples/headless.css']) {
    const sheet = read(f);
    assert.match(sheet, /@import '\.\.\/src\/ui\/tokens\.css'/);
    assert.doesNotMatch(sheet, /var\(--avbd-light-/);
    assert.match(sheet, /background: #101216/);
  }
});
